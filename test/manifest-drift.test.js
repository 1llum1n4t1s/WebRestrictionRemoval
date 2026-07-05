"use strict";

/**
 * manifest-drift.test.js — manifest.json と manifest.firefox.json の content_scripts
 * 配列が「Firefox 専用エントリを除いて完全一致」であることを保証する drift 検知テスト。
 *
 * 背景 (/rere D-003): 両 manifest は完全独立ファイルで、content_scripts 配列は
 * Firefox 専用の volume-booster-mes エントリ 1 つを除き完全に重複記述している。
 * 新サイト対応や content script 追加時に片方だけ更新すると、Chrome では動くが Firefox では
 * 該当機能が一切注入されない (またはその逆) drift が発生し得るが、従来は
 * syntax-check / FEATURES 件数アサートのどちらもこの配列差分を見ておらず、
 * `pnpm test` が green のまま通過してしまう構造的テストギャップがあった。
 *
 * 本テストは両 content_scripts を正規化 (Firefox 専用 mes エントリを除外) して
 * deep-equal し、片側更新漏れを CI で検知する。新たに Firefox 専用エントリを
 * 増やす場合は FIREFOX_ONLY_MARKERS にマーカー (js 配列に含まれる特徴的なファイル名) を追加する。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/** Firefox 専用 content_scripts エントリを識別するマーカー (js 配列に含まれるファイル名)。 */
const FIREFOX_ONLY_MARKERS = ["src/content/volume-booster-mes.js"];

const readManifest = (name) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));

/** Firefox 専用エントリ (mes 等) を取り除いた content_scripts を返す。 */
const stripFirefoxOnly = (contentScripts) =>
  contentScripts.filter(
    (entry) =>
      !FIREFOX_ONLY_MARKERS.some((marker) => (entry.js || []).includes(marker))
  );

test("manifest.json と manifest.firefox.json の content_scripts が Firefox 専用エントリを除き一致する", () => {
  const chrome = readManifest("manifest.json");
  const firefox = readManifest("manifest.firefox.json");

  const chromeCs = stripFirefoxOnly(chrome.content_scripts || []);
  const firefoxCs = stripFirefoxOnly(firefox.content_scripts || []);

  assert.deepStrictEqual(
    firefoxCs,
    chromeCs,
    "manifest.json と manifest.firefox.json の content_scripts に (Firefox 専用エントリ以外の) drift がある。" +
      " 片方だけ content script を追加・変更していないか確認すること。"
  );
});

test("Firefox 専用 content_scripts エントリが manifest.firefox.json のみに存在する", () => {
  const chrome = readManifest("manifest.json");
  const firefox = readManifest("manifest.firefox.json");

  const chromeHasMes = (chrome.content_scripts || []).some((entry) =>
    FIREFOX_ONLY_MARKERS.some((marker) => (entry.js || []).includes(marker))
  );
  const firefoxHasMes = (firefox.content_scripts || []).some((entry) =>
    FIREFOX_ONLY_MARKERS.some((marker) => (entry.js || []).includes(marker))
  );

  assert.strictEqual(
    chromeHasMes,
    false,
    "Firefox 専用エントリ (volume-booster-mes 等) が Chrome の manifest.json に混入している"
  );
  assert.strictEqual(
    firefoxHasMes,
    true,
    "Firefox 専用エントリ (volume-booster-mes 等) が manifest.firefox.json から欠落している"
  );
});
