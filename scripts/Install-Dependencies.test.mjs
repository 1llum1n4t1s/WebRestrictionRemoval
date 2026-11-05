import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('初回・CIの固定復元入口は版不一致・lock欠落・不正を拒否し、正常lockを復元する', { timeout: 30000 }, (t) => {
  const repository = new URL('../', import.meta.url);
  const source = new URL('scripts/Install-Dependencies.mjs', repository);
  const manifest = JSON.parse(readFileSync(new URL('package.json', repository), 'utf8'));
  assert.equal(manifest.scripts['ci:install'], manifest.scripts.deps);
  const root = mkdtempSync(join(tmpdir(), 'vuora-deps-entry-'));
  t.after(() => { if (process.env.VUORA_TEST_KEEP_FIXTURES !== '1') rmSync(root, { recursive: true }); });
  for (const kind of ['wrong-version', 'missing-lock', 'invalid-lock', 'valid']) {
    const directory = join(root, kind);
    mkdirSync(join(directory, 'scripts'), { recursive: true });
    copyFileSync(source, join(directory, 'scripts/Install-Dependencies.mjs'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'deps-entry-fixture',
      packageManager: kind === 'wrong-version' ? 'bun@0.0.0' : `bun@${Bun.version}`,
      scripts: { deps: manifest.scripts.deps, 'ci:install': manifest.scripts['ci:install'] },
      ...(kind === 'valid' ? { dependencies: { 'fixture-local': 'file:./fixture-local' } } : {}),
    }));
    if (kind === 'invalid-lock') writeFileSync(join(directory, 'bun.lock'), '{"lockfileVersion":1,"workspaces":{},"packages":[]}');
    const diagnostic = (result) => JSON.stringify({ status: result.status, signal: result.signal,
      error: result.error?.message, stdout: result.stdout, stderr: result.stderr });
    if (kind === 'valid') {
      mkdirSync(join(directory, 'fixture-local'));
      writeFileSync(join(directory, 'fixture-local/package.json'), JSON.stringify({ name: 'fixture-local', version: '1.0.0' }));
      const seed = spawnSync(process.execPath, ['install', '--offline', '--lockfile-only', '--ignore-scripts'],
        { cwd: directory, encoding: 'utf8' });
      assert.equal(seed.status, 0, diagnostic(seed));
    }
    const lockBefore = kind === 'valid' ? readFileSync(join(directory, 'bun.lock')) : null;
    const result = spawnSync(process.execPath, ['run', 'ci:install', '--offline'], { cwd: directory, encoding: 'utf8' });
    if (kind === 'valid') {
      assert.equal(result.status, 0, diagnostic(result));
      assert.deepEqual(readFileSync(join(directory, 'bun.lock')), lockBefore, '固定復元はlockを変更しない');
      assert.ok(existsSync(join(directory, 'node_modules/fixture-local/package.json')));
    } else {
      assert.notEqual(result.status, 0, kind);
      const expected = kind === 'wrong-version' ? /packageManagerに固定したBun/
        : kind === 'missing-lock' ? /bun.lock がありません/ : /bun.lock が不正/;
      assert.match(result.stderr, expected);
    }
  }
});
