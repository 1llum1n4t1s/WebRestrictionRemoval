"use strict";

/**
 * お問い合わせ / 評価ボタンの組み込み確認。
 *
 * 部品の正本は Kagayoi.Support（public/assets/contact-form.js と
 * clients/chrome-extension/support-footer.js）で、この拡張には逐語コピーを同梱している。
 * ここでは「同梱漏れ」「読み込み順の崩れ」「product-id の書き間違い」を止める。
 * 部品そのものの挙動は Kagayoi.Support 側のテストが見る。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SETTINGS_HTML = "src/popup/popup.html";
const PRODUCT_ID = "web-restriction-removal";

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("support正本checkは正常・不一致・欠落を判定し、対象を書き換えない", (t) => {
  const temporary = fs.mkdtempSync(path.join(tmpdir(), "vuora-support-check-"));
  t.after(() => { if (process.env.VUORA_TEST_KEEP_FIXTURES !== "1") fs.rmSync(temporary, { recursive: true }); });
  const assets = ["kagayoi-support-popup.js", "kagayoi-support-form.css", "kagayoi-support-popup.css",
    "kagayoi-support-footer.js", "kagayoi-support-footer.css"];
  const packageRoot = path.join(ROOT, "node_modules/@kagayoi/support-extension");
  for (const kind of ["matching", "different", "missing"]) {
    const target = path.join(temporary, kind);
    const destination = path.join(target, "src/shared");
    fs.mkdirSync(destination, { recursive: true });
    for (const asset of assets) {
      if (kind === "missing" && asset === assets[0]) continue;
      fs.copyFileSync(path.join(packageRoot, "dist", asset), path.join(destination, asset));
    }
    if (kind === "different") fs.writeFileSync(path.join(destination, assets[0]), "fixture mismatch\n");
    const before = Object.fromEntries(fs.readdirSync(destination).map(name => [name, fs.readFileSync(path.join(destination, name))]));
    const result = spawnSync(process.execPath, ["--preserve-symlinks-main", path.join(packageRoot, "bin/kagayoi-support-sync.mjs"),
      "--check", "--target", target], { encoding: "utf8", cwd: ROOT });
    assert.equal(result.status, kind === "matching" ? 0 : 1, result.stderr);
    if (kind !== "matching") assert.match(result.stderr, /kagayoi-support-popup\.js/);
    const after = Object.fromEntries(fs.readdirSync(destination).map(name => [name, fs.readFileSync(path.join(destination, name))]));
    assert.deepEqual(after, before, `${kind}: --checkは修復・追加しない`);
  }
});

test("依存検証・公開の各checkoutは書込同期や製品検証・梱包より前にsupport正本をcheckする", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  const checkOnly = (run, chain = []) => {
    for (const command of run.split(/&&|\r?\n/)) {
      if (/(?:sync:support|kagayoi-support-sync)\b/.test(command)) {
        assert.match(command, /--check(?:\s|$)/, `CIから書込同期を呼ばない: ${chain.join(" -> ")}`);
      }
      const call = command.match(/\bbun(?:\s+--bun)?\s+run\s+([\w:-]+)(.*)$/);
      if (call && scripts[call[1]]) {
        assert.ok(!chain.includes(call[1]), "script呼出しが循環しない");
        checkOnly(scripts[call[1]] + call[2], [...chain, call[1]]);
      }
    }
  };
  const dependency = globalThis.Bun.YAML.parse(read(".github/workflows/dependency-validation.yml"));
  const publish = globalThis.Bun.YAML.parse(read(".github/workflows/publish.yml"));
  const validateJob = (name, job) => {
    assert.ok(job, name);
    const runs = job.steps.map(step => step.run ?? "");
    const checks = runs.map((run, index) => /bun --bun run sync:support --check\s*$/.test(run) ? index : -1).filter(index => index >= 0);
    assert.equal(checks.length, 1, `${name}: checkoutごとに正本checkを1回行う`);
    const checkIndex = checks[0];
    for (const [index, run] of runs.entries()) {
      checkOnly(run);
      if (index < checkIndex) assert.doesNotMatch(run, /(?:sync:support|kagayoi-support-sync)\b/);
      if (/bun --bun run (?:test|lint|build(?::[\w-]+)?|generate-icons|generate-screenshots)(?:\s|$)|copy-package-files|verify-release-artifact/.test(run)) {
        assert.ok(index > checkIndex, `${name}: 製品検証・梱包の前に正本check`);
      }
    }
  };
  for (const [name, job] of [["dependency", dependency.jobs.validate], ["package", publish.jobs.package],
    ["firefox", publish.jobs["publish-firefox"]]]) validateJob(name, job);
  const reordered = structuredClone(dependency.jobs.validate);
  reordered.steps.unshift({ run: "bun --bun run build:assets" });
  assert.throws(() => validateJob("reordered", reordered), /製品検証・梱包の前に正本check/);
});

test("設定画面へ共通のサポートフッターを組み込んでいる", () => {
  const html = read(SETTINGS_HTML);

  assert.match(html, new RegExp(`<kagayoi-support-footer[^>]+product-id="${PRODUCT_ID}"`));
  assert.match(html, /<kagayoi-support-footer\b[^>]*\bfirefox-data-consent\b[^>]*>/);
  assert.match(html, /<script type="module" src="[^"]*shared\/kagayoi-support-popup\.js"><\/script>/);
  assert.match(html, /<script type="module" src="[^"]*shared\/kagayoi-support-footer\.js"><\/script>/);
  assert.ok(
    html.indexOf("kagayoi-support-popup.js") < html.indexOf("kagayoi-support-footer.js"),
    "フッターが参照する <kagayoi-contact-popup> を先に定義する",
  );
});

test("同梱した共通部品が正本の契約を満たす", () => {
  const popupJs = read("src/shared/kagayoi-support-popup.js");
  const footerJs = read("src/shared/kagayoi-support-footer.js");

  assert.match(popupJs, /const DEFAULT_API_BASE = "https:\/\/support\.kagayoi\.com"/);
  assert.match(popupJs, /const API_TIMEOUT_MS = 15_000/);
  assert.match(popupJs, /signal: AbortSignal\.timeout\(API_TIMEOUT_MS\)/);
  assert.match(
    popupJs,
    /const FIREFOX_OPTIONAL_CONTACT_DATA_PERMISSIONS = \["personalCommunications"\]/,
  );
  assert.match(popupJs, /this\.form\.setAttribute\("channel", "extension"\)/);
  assert.match(popupJs, /this\.form\.setAttribute\("storage", "local"\)/);
  assert.match(popupJs, /customElements\.define\("kagayoi-contact-popup", KagayoiContactPopup\)/);
  assert.match(footerJs, /customElements\.define\("kagayoi-support-footer", KagayoiSupportFooter\)/);
  assert.match(footerJs, /chromewebstore\.google\.com\/detail\//);

  for (const [name, source] of [["popup", popupJs], ["footer", footerJs]]) {
    assert.doesNotMatch(source, /\.innerHTML\b/, `${name} も innerHTML を使わない`);
  }
});

const manifestAt = (manifestPath) => {
  const full = path.join(ROOT, manifestPath);
  return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, "utf8")) : null;
};

const allowsSupportHost = (hosts = []) =>
  hosts.some((host) => host.includes("support.kagayoi.com") || host === "<all_urls>" || host === "https://*/*");

test("manifest が問い合わせ先ホストへの権限を持つ", () => {
  for (const manifestPath of ["manifest.json", "manifest.firefox.json"]) {
    const manifest = manifestAt(manifestPath);
    if (!manifest) continue;
    assert.ok(
      allowsSupportHost(manifest.host_permissions),
      `${manifestPath} に support.kagayoi.com のホスト権限が要る`,
    );
  }
});

test("Firefox 版が問い合わせで送るデータを AMO へ申告している", () => {
  // 問い合わせフォームはメールアドレス（personallyIdentifyingInfo）と
  // 確認コード（authenticationInfo）を送る。利用者が自分で入力した値も申告対象で、
  // "none" は他の値と併記できない。
  for (const manifestPath of ["manifest.json", "manifest.firefox.json"]) {
    const gecko = manifestAt(manifestPath)?.browser_specific_settings?.gecko;
    if (manifestPath === "manifest.firefox.json") {
      assert.ok(gecko, "Firefox manifest に browser_specific_settings.gecko が要る");
    }
    if (!gecko) continue;
    const declared = gecko.data_collection_permissions?.required ?? [];
    const optional = gecko.data_collection_permissions?.optional ?? [];
    for (const category of ["personallyIdentifyingInfo", "authenticationInfo"]) {
      assert.ok(declared.includes(category), `${manifestPath} の申告に ${category} が要る`);
    }
    assert.ok(optional.includes("personalCommunications"), `${manifestPath} の optional 申告に personalCommunications が要る`);
    assert.equal(declared.includes("none"), false, `${manifestPath}: "none" は併記できない`);
  }
});
