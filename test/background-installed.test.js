"use strict";
// background.js の onInstalled が、storage 読み取りの一部失敗でも破損検知用 sentinel の書込みへ
// 必ず到達することと、読めなかった領域を推測で上書きしないことを検証する。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const G = require("./_load-actions");
const K = G.StorageKeys;
const read = (name) => fs.readFileSync(path.join(__dirname, "../src", name), "utf8");
const copy = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

/**
 * background.js を vm 上で評価し、onInstalled リスナーを取り出す。
 * failRead(keys) が true を返した get だけを reject させ、storage 障害を再現する。
 */
const loadBackground = async (initial = {}, failRead = () => false) => {
  const data = copy(initial);
  const writes = [];
  let installed;
  const event = { addListener() {} };
  const context = vm.createContext({
    ...Object.fromEntries(["SettingsSchema", "StorageKeys", "Actions", "Offscreen", "SenderCheck",
      "SearchFixer", "InstagramCleaner", "TikTokCleaner", "XCleaner", "VolumeBooster", "VideoGamma",
      "VideoFill", "Loupe", "NotebookLm", "ExtensionPaths", "WikipediaReader", "ColorPicker", "PopupTabs"]
      .map((key) => [key, G[key]])),
    console: { ...console, warn() {} }, URL, TextEncoder, setTimeout: () => 1, clearTimeout() {},
    crypto: { randomUUID: () => "test-device" },
    chrome: {
      offscreen: {}, tabCapture: {},
      runtime: { id: "test-extension", getURL: (p) => `chrome-extension://test-extension/${p}`,
        onInstalled: { addListener: (fn) => { installed = fn; } }, onMessage: event },
      tabs: { onRemoved: event, onActivated: event },
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === "string") keys = [keys];
            if (failRead(keys)) throw new Error("storage read failed");
            return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, copy(data[key])]));
          },
          async set(record) { writes.push(copy(record)); Object.assign(data, copy(record)); },
          async remove() {},
        },
        onChanged: event,
      },
    },
  });
  // 表示言語の共通モジュール（background は先頭で読み込む）。
  vm.runInContext(read("shared/ui-localizer.js"), context);
  for (const file of ["actions-core.js", "actions-video.js", "actions-loupe.js", "actions-volume.js", "actions.js"]) {
    vm.runInContext(read(`lib/${file}`), context);
  }
  vm.runInContext(read("lib/settings-backup.js"), context);
  vm.runInContext(read("background/settings-sync.js"), context);
  vm.runInContext(read("background/background.js"), context);
  await settle();
  // 起動時の他の書込みは対象外。onInstalled が書いたものだけを観測する。
  writes.length = 0;
  return { data, writes, fire: () => installed({ reason: "update" }) };
};

test("onInstalled: 既定値の読み取りが失敗しても sentinel を書き、既存設定を既定値で上書きしない", async () => {
  // 既定値表（多数のキー）を読む get だけを失敗させる。
  const h = await loadBackground({ [K.SEARCH_FIXER_ENABLED]: true }, (keys) => keys.length > 10);
  await assert.doesNotReject(h.fire());
  assert.equal(h.data[K.INSTALL_SENTINEL], 1);
  // 読めなかった状態で全キー欠落とみなして既定値を書くと、保存済みの設定を失う。
  assert.equal(h.data[K.SEARCH_FIXER_ENABLED], true);
  assert.equal(K.AMAZON_DELIVERY_TOTAL_ENABLED in h.data, false);
  assert.deepEqual(h.writes, [{ [K.INSTALL_SENTINEL]: 1 }]);
});

test("onInstalled: 旧タブ id の読み取りが失敗しても既定値の補完と sentinel まで進む", async () => {
  const h = await loadBackground({}, (keys) => keys.length === 1 && keys[0] === K.POPUP_LAST_TAB);
  await assert.doesNotReject(h.fire());
  assert.equal(h.data[K.INSTALL_SENTINEL], 1);
  assert.equal(h.data[K.SEARCH_FIXER_ENABLED], false);
});

test("onInstalled: storage が正常なら従来どおり既定値と sentinel を保存する", async () => {
  const h = await loadBackground({ [K.POPUP_LAST_TAB]: "assist", [K.LOUPE_ENABLED]: true });
  await h.fire();
  assert.equal(h.data[K.INSTALL_SENTINEL], 1);
  assert.equal(h.data[K.POPUP_LAST_TAB], G.PopupTabs.TUNE);
  assert.equal(h.data[K.LOUPE_ENABLED], true);
  assert.equal(h.data[K.VIDEO_GAMMA_ENABLED], false);
});
