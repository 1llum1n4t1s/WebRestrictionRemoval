import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync, realpathSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hashes = {
  'index.js': 'c9f22215cecf96187b021f93c4a11f6ca6ceaefab8a76b42fe90a5d3c4303571',
  'lib/main.js': '381c93033d8ef9b12d15ab0b42677c54909f973b98c6ebf0cee930a97f8c27d8',
  'lib/program.js': 'ad78334f0c2952cfe3c5d7122cd779f423288687b71ebd410df502585be1b129',
  'lib/cmd/index.js': 'fb5e78393ff261052006004ae1c2b6bb1fc560301f53ef59a5c026f8ac33369e',
  'lib/cmd/sign.js': '19ea0162fd17e8907dbb1635fa2b0a25368fbaddf2f711cbeb48b5ca0c36f65e',
  'lib/util/submit-addon.js': '37ac56146a52b5918d757819b2ac3bb756598fb4b50165741ceeb17bec40377d',
};
const sha = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');

async function assertNoUploadUuid(sourceDir) {
  try {
    await fs.lstat(path.join(sourceDir, '.amo-upload-uuid'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Existing .amo-upload-uuid: previous upload state is unknown; stop and investigate');
}

export function createGuardedSign(webExt, submitAddon, {SubmitClient, onVerified = () => {}} = {}) {
  if (typeof SubmitClient !== 'function') throw new Error('web-ext SubmitClient is required');
  return async args => {
    if (!/^[a-f0-9]{64}$/.test(process.env.EXPECTED_SHA256 || '') || !process.env.EXPECTED_VERSION) {
      throw new Error('Expected source inventory SHA-256 and version are required');
    }
    await assertNoUploadUuid(args.sourceDir);
    let verified;
    let submits = 0;
    const build = async (...params) => {
      if (verified) throw new Error('Unexpected repeated build');
      const result = await webExt.cmd.build(...params);
      const realPath = await fs.realpath(result.extensionPath);
      const before = await sha(realPath);
      const metadataBytes = await fs.readFile(path.join(root, '.amo-metadata.json'));
      const metadataHash = createHash('sha256').update(metadataBytes).digest('hex');
      const env = {...process.env};
      delete env.GITHUB_OUTPUT;
      env.EXPECTED_AMO_METADATA_SHA256 = metadataHash;
      const check = spawnSync(process.env.PYTHON_BIN || 'python3', [path.join(root, 'scripts/verify-release-artifact.py'), 'firefox', realPath], {env, stdio: 'inherit'});
      if (check.error || check.status !== 0) throw new Error(`XPI verification failed: ${check.error || check.status}`);
      if (before !== await sha(realPath)) throw new Error('XPI changed during verification');
      verified = {realPath, sha256: before, metadata: JSON.parse(metadataBytes.toString('utf8'))};
      onVerified(verified);
      return result;
    };
    const guardedSubmit = async submission => {
      if (!verified || submits++) throw new Error('Submit called without one verified build');
      await assertNoUploadUuid(args.sourceDir);
      if (!isDeepStrictEqual(submission.metaDataJson, verified.metadata)) throw new Error('Submitted AMO metadata differs from verified metadata');
      if (await fs.realpath(submission.xpiPath) !== verified.realPath || await sha(verified.realPath) !== verified.sha256) {
        throw new Error('Submit XPI differs from verified XPI');
      }
      console.log(`Verified XPI for AMO: ${verified.realPath} sha256=${verified.sha256}`);
      class VerifiedClient extends SubmitClient {
        async getPreviousUuidOrUploadXpi(xpiPath, channel, savedPath) {
          return super.getPreviousUuidOrUploadXpi(xpiPath, channel, savedPath, undefined, async () => {
            await assertNoUploadUuid(args.sourceDir);
            return {};
          });
        }
        async doUploadSubmit(xpiPath, channel) {
          await assertNoUploadUuid(args.sourceDir);
          if (realpathSync(xpiPath) !== verified.realPath) throw new Error('Upload path differs from verified XPI');
          // 同じ read の bytes を照合して File 化する。別の添付は web-ext の処理を使う。
          const bytes = readFileSync(xpiPath);
          if (createHash('sha256').update(bytes).digest('hex') !== verified.sha256) {
            throw new Error('Upload bytes differ from verified XPI');
          }
          const formData = new FormData();
          formData.set('channel', channel);
          formData.set('upload', new File([bytes], path.basename(xpiPath)));
          const {uuid} = await this.fetchJson(new URL('upload/', this.apiUrl), 'POST', formData, 'Upload failed');
          if (typeof uuid !== 'string' || uuid.length === 0) throw new Error('AMO upload response has no valid UUID; acceptance is unknown');
          console.log(`AMO upload accepted: ${JSON.stringify({uuid, version: process.env.EXPECTED_VERSION, xpi_sha256: verified.sha256})}`);
          return this.waitForValidation(uuid);
        }
      }
      return submitAddon({...submission, SubmitClient: VerifiedClient});
    };
    const result = await webExt.cmd.sign(args, {build, submitAddon: guardedSubmit});
    if (!verified || submits !== 1) throw new Error('web-ext did not use the required build/submit injection');
    return result;
  };
}

async function main() {
  if (process.argv[2] !== 'sign') throw new Error('Only sign is supported');
  const require = createRequire(import.meta.url);
  const packageDir = path.dirname(await fs.realpath(require.resolve('web-ext')));
  const pkg = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
  if (pkg.version !== '10.8.0') throw new Error(`Unsupported web-ext version: ${pkg.version}`);
  for (const [name, expected] of Object.entries(hashes)) {
    if (await sha(path.join(packageDir, name)) !== expected) throw new Error(`Unsupported web-ext injection contract: ${name}`);
  }
  const webExt = (await import(pathToFileURL(path.join(packageDir, 'index.js')))).default;
  const {default: SubmitClient, signAddon} = await import('web-ext/util/submit-addon');
  await webExt.main(packageDir, {commands: {...webExt.cmd, sign: createGuardedSign(webExt, signAddon, {SubmitClient})}});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
