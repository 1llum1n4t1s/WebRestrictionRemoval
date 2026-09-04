"use strict";
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

const host = async (initial = {}, firefox = false) => {
  const data = copy(initial);
  const listeners = [];
  const writes = [];
  const event = { addListener() {} };
  let beforeRead = async () => {};
  const context = vm.createContext({
    ...Object.fromEntries(["SettingsSchema", "StorageKeys", "Actions", "Offscreen", "SenderCheck",
      "SearchFixer", "InstagramCleaner", "TikTokCleaner", "XCleaner", "VolumeBooster", "VideoGamma",
      "VideoFill", "Loupe", "NotebookLm", "ExtensionPaths"].map((key) => [key, G[key]])),
    console, URL, setTimeout: () => 1, clearTimeout() {}, crypto: { randomUUID: () => "test-device" },
    chrome: {
      ...(!firefox ? { offscreen: {}, tabCapture: {} } : {}),
      runtime: { onInstalled: event, onMessage: event },
      tabs: { onRemoved: event, onActivated: event },
      storage: {
        local: {
          async get(keys) {
            const snapshot = Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, copy(data[key])]));
            await beforeRead(keys);
            return snapshot;
          },
          async set(record) { writes.push(copy(record)); Object.assign(data, copy(record)); },
          async remove() {},
        },
        onChanged: { addListener: (fn) => listeners.push(fn) },
      },
    },
  });
  vm.runInContext(read("background/settings-sync.js"), context);
  vm.runInContext(read("background/background.js"), context);
  vm.runInContext("notifyContentScripts = async () => {};", context);
  await settle();
  writes.length = 0;
  return { context, data, writes,
    run: (code) => vm.runInContext(code, context),
    readHook: (fn) => { beforeRead = fn; },
    emit: (changes, area = "local") => listeners.forEach((fn) => fn(changes, area)),
  };
};

test("遅延した popup 保存は同期世代が異なれば書き込まない・失敗後もキューを使える", async () => {
  const h = await host({ [K.SETTINGS_SYNC_APPLIED]: "remote", searchFixerEnabled: true });
  await assert.rejects(h.run('handleApplySettings({searchFixerEnabled:false}, null)'), /stale-settings/);
  assert.equal(h.data.searchFixerEnabled, true);
  assert.equal(h.writes.length, 0);
  await h.run('handleApplySettings({amazonDeliveryTotalEnabled:true}, "remote")');
  assert.deepEqual(h.writes, [{ amazonDeliveryTotalEnabled: true }]);
  assert.equal(h.data.searchFixerEnabled, true);
});

test("4クリーナーの単一サブ機能をマージし、他のサブ機能と別キーを保存し直さない", async () => {
  for (const spec of [G.SearchFixer, G.InstagramCleaner, G.TikTokCleaner, G.XCleaner]) {
    const [a, b] = Object.keys(spec.DEFAULT_FEATURES);
    const key = spec === G.SearchFixer ? K.SEARCH_FIXER_FEATURES : spec === G.InstagramCleaner
      ? K.INSTAGRAM_CLEANER_FEATURES : spec === G.TikTokCleaner ? K.TIKTOK_CLEANER_FEATURES : K.X_CLEANER_FEATURES;
    const h = await host({ [key]: { [a]: false, [b]: true }, videoGammaValue: 1.7 });
    await h.run(`handleApplySettings(${JSON.stringify({ [key]: { [a]: true } })}, null)`);
    assert.equal(h.data[key][a], true);
    assert.equal(h.data[key][b], true);
    assert.equal(h.data.videoGammaValue, 1.7);
    assert.deepEqual(Object.keys(h.writes[0]), [key]);
  }
});

test("世代を確認する get の途中に同期反映が予約されても、保存と反映は交差しない", async () => {
  const h = await host({ searchFixerEnabled: false });
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  h.readHook(async () => { entered(); await new Promise((resolve) => { release = resolve; }); });
  const apply = h.run('handleApplySettings({searchFixerEnabled:true}, null)');
  await started;
  const remote = h.run(`globalThis.enqueueSettingsWrite(() => chrome.storage.local.set({
    searchFixerEnabled:false, [StorageKeys.SETTINGS_SYNC_APPLIED]:"new"}))`);
  assert.equal(h.writes.length, 0);
  release();
  await Promise.all([apply, remote]);
  assert.equal(h.data.searchFixerEnabled, false);
  assert.equal(h.data[K.SETTINGS_SYNC_APPLIED], "new");
  h.readHook(async () => {});
  await assert.rejects(h.run('handleApplySettings({searchFixerEnabled:true}, null)'), /stale-settings/);
});

test("Chrome の音量・ミュート・EQ 変更はブースト中の全タブに反映し、sync領域は無視", async () => {
  const h = await host({ [K.VOLUME_BOOSTER_ENABLED]: true, [K.VOLUME_BOOSTER_LAST_GAIN]: 160,
    [K.VOLUME_BOOSTER_MUTED_ENABLED]: true, [K.VOLUME_BOOSTER_EQ_ENABLED]: true,
    [K.VOLUME_BOOSTER_EQ_GAINS]: Array(10).fill(3), [K.VOLUME_BOOSTER_EQ_PREAMP]: -2 });
  h.run("globalThis.calls = []; setVolumeBoosterGain = async (...args) => calls.push(args); boostedTabIds.add(10); boostedTabIds.add(20);");
  const changes = { [K.VOLUME_BOOSTER_MUTED_ENABLED]: { newValue: true } };
  h.emit(changes, "sync"); await settle();
  assert.equal(h.context.calls.length, 0);
  for (const key of [K.VOLUME_BOOSTER_LAST_GAIN, K.VOLUME_BOOSTER_MUTED_ENABLED, K.VOLUME_BOOSTER_EQ_GAINS]) {
    h.context.calls.length = 0;
    h.emit({ [key]: { newValue: h.data[key] }, [K.SETTINGS_SYNC_APPLIED]: { newValue: "remote" } });
    await settle();
    assert.deepEqual(copy(h.context.calls), [10, 20].map((id) => [id, 160, false, false, false, true, true, Array(10).fill(3), -2, true]));
  }
});

test("マスター OFF は全解放し、Firefox では background の音量処理を呼ばない", async () => {
  for (const firefox of [false, true]) {
    const h = await host({}, firefox);
    h.run("globalThis.calls = []; setVolumeBoosterGain = async () => calls.push('set'); releaseAllVolumeBoosterTabs = () => calls.push('release'); boostedTabIds.add(10);");
    h.emit({ [K.VOLUME_BOOSTER_ENABLED]: { newValue: false } });
    await settle();
    assert.deepEqual(copy(h.context.calls), firefox ? [] : ["release"]);
  }
});

test("自動反映中に stream が消失してもキャプチャを新規要求しない", async () => {
  const h = await host();
  h.run("ensureOffscreenDocument = async () => true; getVolumeBoosterGainDirect = async () => null;");
  h.context.chrome.tabCapture.getMediaStreamId = () => assert.fail("新規キャプチャは禁止");
  const res = await h.run("setVolumeBoosterGainImpl(10, 160, false, false, false, false, false, [], 0, 0, true)");
  assert.equal(res.error, "volume-stream-ended");
});

test("popup の各操作は該当項目だけを読み込み時の世代とともに送信する", async () => {
  const source = read("popup/popup.js");
  const controls = new Map();
  const control = (name) => {
    if (!controls.has(name)) controls.set(name, { checked: true, value: "1.2", handlers: {},
      addEventListener(event, fn) { this.handlers[event] = fn; } });
    return controls.get(name);
  };
  const sent = [];
  const context = vm.createContext({
    StorageKeys: K, Actions: G.Actions, SearchFixer: G.SearchFixer,
    VideoGamma: G.VideoGamma, VideoFill: G.VideoFill,
    stored: { [K.SETTINGS_SYNC_APPLIED]: "opened-at" }, applySeq: 0,
    chrome: { runtime: { async sendMessage(message) { sent.push(copy(message)); return { ok: true }; } } },
    currentVideoGammaValue: () => 1.2, videoFillMode: "stretch",
    setTimeout() {}, buildOkMessage() {}, showStatus() {},
  });
  const bindingStart = source.indexOf('  $searchFixerToggle.addEventListener("change"');
  const bindings = source.slice(bindingStart, source.indexOf("  // ルーペ: 倍率セグメント", bindingStart));
  const featureStart = source.indexOf("  for (const [key, input] of featureInputs)", bindingStart);
  const featureBindings = source.slice(featureStart, source.indexOf("  // ----- DOM 構築", featureStart));
  for (const name of new Set((bindings + featureBindings).match(/\$\w+/g))) context[name] = control(name);
  for (const name of new Set((bindings + featureBindings).match(/update\w+/g))) context[name] = () => {};
  for (const name of ["featureInputs", "igFeatureInputs", "ttFeatureInputs", "xFeatureInputs"]) {
    context[name] = new Map([["one", control(name + "1")], ["two", control(name + "2")]]);
  }
  const applyStart = source.indexOf("  async function apply(patch)");
  vm.runInContext(source.slice(applyStart, source.indexOf("  function buildOkMessage", applyStart)), context);
  vm.runInContext(bindings + featureBindings, context);
  for (const [name, field] of [
    ["$searchFixerToggle", "searchFixerEnabled"], ["$amazonDeliveryToggle", "amazonDeliveryTotalEnabled"],
    ["$amazonRankingJumpToggle", "amazonRankingJumpEnabled"], ["$amazonMerchantInfoToggle", "amazonMerchantInfoEnabled"],
    ["$instagramCleanerToggle", "instagramCleanerEnabled"], ["$tiktokCleanerToggle", "tiktokCleanerEnabled"],
    ["$xCleanerToggle", "xCleanerEnabled"], ["$videoGammaToggle", "videoGammaEnabled"],
    ["$videoFillToggle", "videoFillEnabled"], ["$loupeToggle", "loupeEnabled"],
    ["$videoGammaSlider", "videoGammaValue"], ["$videoFillTargetSelect", "videoFillTarget"],
    ["$gridItemsSelect", "searchFixerGridItems"],
    ["featureInputs1", "searchFixerFeatures"], ["igFeatureInputs1", "instagramCleanerFeatures"],
    ["ttFeatureInputs1", "tiktokCleanerFeatures"], ["xFeatureInputs1", "xCleanerFeatures"],
  ]) {
    await control(name).handlers.change();
    const message = sent.at(-1);
    assert.deepEqual(Object.keys(message.data), [field], name);
    if (field.endsWith("Features")) assert.deepEqual(message.data[field], { one: true });
    assert.equal(message.syncGeneration, "opened-at");
  }
});
