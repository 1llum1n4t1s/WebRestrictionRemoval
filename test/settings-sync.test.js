"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const G = require("./_load-actions");
const K = G.StorageKeys;
const PREFIX = "vuora.settings.v2.";
const source = fs.readFileSync(path.join(__dirname, "../src/background/settings-sync.js"), "utf8");
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

const host = (local = {}, remote = {}, options = {}) => {
  const state = { local: copy(local), sync: copy(remote) };
  const listeners = [];
  const timers = new Map();
  let id = 0;
  let uuid = 0;
  let now = options.now || 1000;
  let reads = 0;
  let writes = 0;
  let fail = false;
  let beforeUpload;
  let afterRemove;
  const emit = (changes, area) => {
    // Chrome/Firefox とも、set の完了後に onChanged が届くケースを扱う。
    setImmediate(() => listeners.forEach((fn) => fn(copy(changes), area)));
  };
  const set = (name, values) => {
    const changes = {};
    for (const [key, value] of Object.entries(values)) {
      if (JSON.stringify(state[name][key]) === JSON.stringify(value)) continue;
      changes[key] = { oldValue: copy(state[name][key]), newValue: copy(value) };
      state[name][key] = copy(value);
    }
    if (Object.keys(changes).length) emit(changes, name);
  };
  const area = (name) => ({
    async get(keys) {
      if (name === "sync") reads++;
      return Object.fromEntries((keys == null ? Object.keys(state[name]) : Array.isArray(keys) ? keys : [keys])
        .filter((key) => key in state[name]).map((key) => [key, copy(state[name][key])]));
    },
    async set(values) {
      const data = copy(values);
      if (name === "sync") {
        writes++;
        if (beforeUpload) await beforeUpload();
        if (fail) throw new Error("quota");
        const all = { ...state.sync, ...data };
        const sizes = Object.entries(all).map(([key, value]) => Buffer.byteLength(key + JSON.stringify(value)));
        if (sizes.length > 512 || sizes.some((n) => n > 8192) || sizes.reduce((a, b) => a + b, 0) > 102400) {
          throw new Error("quota");
        }
      }
      set(name, data);
    },
    async remove(keys) {
      const changes = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (!(key in state[name])) continue;
        changes[key] = { oldValue: state[name][key] };
        delete state[name][key];
      }
      if (Object.keys(changes).length) emit(changes, name);
      if (name === "local" && afterRemove) await afterRemove(keys);
    },
  });
  const storage = { local: area("local"), sync: area("sync"), onChanged: { addListener: (fn) => listeners.push(fn) } };
  vm.runInNewContext(source, {
    chrome: { storage }, StorageKeys: K, SettingsSchema: G.SettingsSchema,
    SearchFixer: G.SearchFixer, InstagramCleaner: G.InstagramCleaner,
    TikTokCleaner: G.TikTokCleaner, XCleaner: G.XCleaner, VolumeBooster: G.VolumeBooster,
    Date: { now: () => now }, crypto: { randomUUID: () => `${options.device || "A"}-${++uuid}` },
    setTimeout: (fn) => { timers.set(++id, fn); return id; },
    clearTimeout: (key) => timers.delete(key),
  });
  const tick = async () => {
    await settle();
    const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn());
    await settle();
  };
  return { state, storage, tick, reads: () => reads, writes: () => writes,
    now: (value) => { now = value; }, receive: async (values) => { set("sync", values); await settle(); },
    edit: async (values) => { await storage.local.set(values); await settle(); },
    fail: (value) => { fail = value; }, beforeUpload: (fn) => { beforeUpload = fn; },
    afterRemove: (fn) => { afterRemove = fn; } };
};
const records = (h) => h.state.local[K.SETTINGS_SYNC_STATE].records;
const entry = (id, value, stamp) => ({ [PREFIX + id]: { version: 2, items: { [id]: { value, stamp } } } });
const peers = async (values = {}) => {
  const a = host({ settingsSyncEnabled: true, ...values }, {}, { device: "A" });
  await a.tick();
  const b = host({ settingsSyncEnabled: true, ...values }, a.state.sync, { device: "B" });
  await b.tick();
  return [a, b];
};
const exchange = async (a, b) => {
  for (let i = 0; i < 3; i++) {
    const av = copy(a.state.sync), bv = copy(b.state.sync);
    await a.receive(bv); await b.receive(av);
    await a.tick(); await b.tick();
  }
};

test("既定 OFF は同期を読み書きせず、リモート変更も適用しない", async () => {
  const h = host({ searchFixerEnabled: false }); await h.tick();
  await h.receive(entry("searchFixerEnabled", true, [2000, 0, "B"])); await h.tick();
  assert.equal(h.reads(), 0); assert.equal(h.writes(), 0);
  assert.equal(h.state.local.searchFixerEnabled, false);
});

test("初参加はクラウド優先。認証・履歴・未知項目は送信しない", async () => {
  const h = host({ settingsSyncEnabled: true, searchFixerEnabled: false,
    notebookLmAccountIndex: 2, notebookLmAccountsCache: { secret: true }, colorPickerHistory: [1] },
  { ...entry("searchFixerEnabled", true, [2000, 0, "B"]), ...entry("notebookLmAccountIndex", 9, [3000, 0, "B"]) });
  await h.tick();
  assert.equal(h.state.local.searchFixerEnabled, true);
  assert.equal(h.state.local.notebookLmAccountIndex, 2);
  const text = JSON.stringify(records(h));
  for (const key of [K.NOTEBOOK_LM_ACCOUNTS_CACHE, K.NOTEBOOK_LM_ACCOUNT_INDEX, K.COLOR_PICKER_HISTORY, K.SETTINGS_SYNC_ENABLED]) {
    assert.ok(!text.includes(key));
  }
  const saved = copy(records(h)); const writes = h.writes();
  await h.tick(); await h.tick();
  assert.deepEqual(records(h), saved, "受信通知が遅れても更新情報を付け直さない");
  assert.equal(h.writes(), writes);
});

test("変更時刻で後勝ちになり、遅れて届く古い値を修復する", async () => {
  const [a, b] = await peers({ loupeSize: 220 });
  a.now(2000); await a.edit({ loupeSize: 400 });
  b.now(3000); await b.edit({ loupeSize: 600 });
  await b.tick(); await a.tick(); // 古い編集が後から送信される。
  const original = copy(records(b).loupeSize);
  await exchange(a, b);
  assert.equal(a.state.local.loupeSize, 600); assert.equal(b.state.local.loupeSize, 600);
  assert.deepEqual(records(a).loupeSize, original);
  assert.deepEqual(records(b).loupeSize, original);
});

test("同時刻・同カウンターなら端末IDで勝者が一致する", async () => {
  const [a, b] = await peers({ loupeSize: 220 });
  await a.edit({ loupeSize: 400 }); await b.edit({ loupeSize: 600 });
  await a.tick(); await b.tick(); await exchange(a, b);
  assert.equal(a.state.local.loupeSize, 600); assert.equal(b.state.local.loupeSize, 600);
});

test("時計が戻っても連続編集は単調増加し、受信時刻を引き継ぐ", async () => {
  const h = host({ settingsSyncEnabled: true, loupeSize: 220 }); await h.tick();
  await h.receive(entry("loupeSize", 300, [5000, 7, "B"])); await h.tick();
  h.now(100); await h.edit({ loupeSize: 400 });
  assert.deepEqual(records(h).loupeSize.stamp.slice(0, 2), [5000, 8]);
  h.now(50); await h.edit({ loupeSize: 500 });
  assert.deepEqual(records(h).loupeSize.stamp.slice(0, 2), [5000, 9]);
});

for (const [key, spec] of [[K.SEARCH_FIXER_FEATURES, G.SearchFixer], [K.INSTAGRAM_CLEANER_FEATURES, G.InstagramCleaner],
  [K.TIKTOK_CLEANER_FEATURES, G.TikTokCleaner], [K.X_CLEANER_FEATURES, G.XCleaner]]) {
  test(`${key}: 別 PC の別サブ機能変更を消さない`, async () => {
    const [one, two] = Object.keys(spec.DEFAULT_FEATURES);
    const initial = { ...spec.DEFAULT_FEATURES, [one]: false, [two]: false };
    const [a, b] = await peers({ [key]: initial });
    await a.edit({ [key]: { ...initial, [one]: true } });
    await b.edit({ [key]: { ...initial, [two]: true } });
    await a.tick(); await b.tick(); await exchange(a, b);
    for (const h of [a, b]) {
      assert.equal(h.state.local[key][one], true); assert.equal(h.state.local[key][two], true);
    }
  });
}

test("除外リストの別々の追加・削除を保持し、古い追加で削除が復活しない", async () => {
  const old = { key: "@old", name: "Old" };
  const [a, b] = await peers({ searchFixerBlockedChannels: [old] });
  const stale = copy(a.state.sync);
  a.now(2000); await a.edit({ searchFixerBlockedChannels: [] });
  b.now(1500); await b.edit({ searchFixerBlockedChannels: [old, { key: "@new", name: "New" }] });
  await a.tick(); await b.tick(); await exchange(a, b);
  for (const h of [a, b]) assert.deepEqual(h.state.local.searchFixerBlockedChannels.map((e) => e.key), ["@new"]);
  await a.receive(stale); await a.tick();
  assert.deepEqual(a.state.local.searchFixerBlockedChannels.map((e) => e.key), ["@new"]);
  a.now(3000); await a.edit({ searchFixerBlockedChannels: [{ key: "@new", name: "New" }, old] });
  await a.tick(); await exchange(a, b);
  assert.ok(b.state.local.searchFixerBlockedChannels.some((e) => e.key === "@old"));
});

test("EQのプリセット・全バンド・プリアンプ・有効状態は一組で後勝ち", async () => {
  const [a, b] = await peers();
  const preset = { volumeBoosterEqEnabled: true, volumeBoosterEqGains: Array(10).fill(3),
    volumeBoosterEqPreamp: -3, volumeBoosterEqPreset: "custom" };
  const later = { volumeBoosterEqEnabled: false, volumeBoosterEqGains: Array(10).fill(0),
    volumeBoosterEqPreamp: 0, volumeBoosterEqPreset: "flat" };
  a.now(2000); await a.edit(preset);
  b.now(3000); await b.edit({ ...later, volumeBoosterEqPreamp: 2 });
  await a.tick(); await b.tick(); await exchange(a, b);
  for (const h of [a, b]) assert.deepEqual(records(h).equalizer.value, { ...later, volumeBoosterEqPreamp: 2 });
});

test("送信前に更新情報を保存し、再起動・再送でも時刻を付け直さない", async () => {
  const h = host({ settingsSyncEnabled: true, loupeSize: 220 }); await h.tick();
  h.now(2500); await h.edit({ loupeSize: 500 });
  const recorded = copy(records(h).loupeSize);
  assert.equal(recorded.stamp[0], 2500, "5秒の送信待ち前に記録される");
  h.fail(true); await h.tick();
  assert.equal(h.state.local[K.SETTINGS_SYNC_STATUS], "error");
  const restarted = host(h.state.local, h.state.sync, { now: 99000, device: "restarted" }); await restarted.tick();
  assert.deepEqual(records(restarted).loupeSize, recorded);
  assert.deepEqual(restarted.state.sync[PREFIX + "loupeSize"].items.loupeSize, recorded);
});

test("通信待ち中の編集を保存し、古いアップロード完了で巻き戻さない", async () => {
  const h = host({ settingsSyncEnabled: true, loupeSize: 220 }); await h.tick();
  await h.edit({ loupeSize: 400 });
  h.beforeUpload(async () => {
    h.beforeUpload(undefined); h.now(3000); await h.edit({ loupeSize: 600 });
  });
  await h.tick(); assert.equal(h.state.local.loupeSize, 600);
  await h.tick(); assert.equal(h.state.sync[PREFIX + "loupeSize"].items.loupeSize.value, 600);
});

test("OFF はデータを消さず、OFF中の受信・送信を止め、再ONはクラウド優先", async () => {
  const h = host({ settingsSyncEnabled: true, loupeSize: 220 }); await h.tick();
  await h.edit({ settingsSyncEnabled: false }); await h.tick();
  const reads = h.reads(), writes = h.writes();
  await h.edit({ loupeSize: 450 });
  await h.receive(entry("loupeSize", 600, [9000, 0, "B"])); await h.tick();
  assert.equal(h.state.local.loupeSize, 450);
  assert.equal(h.reads(), reads); assert.equal(h.writes(), writes);
  await h.edit({ settingsSyncEnabled: true }); await h.tick();
  assert.equal(h.state.local.loupeSize, 600);
});

test("スカラー設定の削除を伝播し、遅れた自己通知で刻印し直さない", async () => {
  const [a, b] = await peers({ loupeSize: 220 });
  await a.storage.local.remove("loupeSize"); await settle();
  const removed = copy(records(a).loupeSize);
  await a.tick(); await exchange(a, b);
  assert.ok(!("loupeSize" in b.state.local)); assert.equal(removed.deleted, true);
  assert.deepEqual(records(b).loupeSize, removed);
});

test("旧試作同期の値を一度だけ移行し、旧キーを撤去する", async () => {
  const h = host({ settingsSyncEnabled: true, loupeSize: 220 },
    { "vuora.settings.v1.loupeSize": { value: 400 } });
  await h.tick();
  assert.equal(h.state.local.loupeSize, 400);
  assert.ok(!("vuora.settings.v1.loupeSize" in h.state.sync));
  assert.equal(h.state.sync[PREFIX + "loupeSize"].items.loupeSize.value, 400);
});

test("不正な更新情報と未知キーは適用しない", async () => {
  const h = host({ settingsSyncEnabled: true, loupeSize: 220 }); await h.tick();
  await h.receive({ ...entry("loupeSize", 900, [-1, 0, "B"]),
    ...entry("notebookLmAccountIndex", 5, [9000, 0, "B"]) }); await h.tick();
  assert.equal(h.state.local.loupeSize, 220);
  assert.ok(!("notebookLmAccountIndex" in h.state.local));
});

test("同じ値への書込とリストの並べ替えでは更新情報を増やさない", async () => {
  const a = { key: "@a", name: "A" }, b = { key: "@b", name: "B" };
  const h = host({ settingsSyncEnabled: true, loupeSize: 220, searchFixerBlockedChannels: [a, b] });
  await h.tick(); const before = copy(records(h));
  await h.edit({ loupeSize: 220, searchFixerBlockedChannels: [b, a] });
  await h.tick(); assert.deepEqual(records(h), before);
});

test("時計の上限をOFF・再起動をまたいで維持する", async () => {
  const h = host({ settingsSyncEnabled: true, loupeSize: 220 }); await h.tick();
  await h.receive(entry("loupeSize", 400, [5000, 2, "B"])); await h.tick();
  await h.edit({ settingsSyncEnabled: false });
  const restarted = host(h.state.local, {}, { now: 10 }); await restarted.tick();
  await restarted.edit({ settingsSyncEnabled: true }); await restarted.tick();
  await restarted.edit({ loupeSize: 600 });
  assert.deepEqual(records(restarted).loupeSize.stamp.slice(0, 2), [5000, 3]);
});

test("3台の同時編集と重複・逆順配送が同じ結果に収束する", async () => {
  const [a, b] = await peers({ loupeSize: 220, videoGammaValue: 1 });
  const c = host({ settingsSyncEnabled: true }, a.state.sync, { device: "C" }); await c.tick();
  const hs = [a, b, c];
  for (let i = 0; i < 12; i++) {
    const h = hs[i % 3]; h.now(2000 + i);
    await h.edit(i % 2 ? { loupeSize: 300 + i * 10 } : { videoGammaValue: 1 + i / 10 });
    await h.tick();
  }
  const snapshots = hs.map((h) => copy(h.state.sync));
  for (const h of hs) {
    for (const data of [...snapshots].reverse()) await h.receive(data);
    await h.receive(snapshots[0]); await h.tick();
  }
  await exchange(a, b); await exchange(b, c); await exchange(a, c);
  for (const h of hs) {
    assert.equal(h.state.local.loupeSize, 410); assert.equal(h.state.local.videoGammaValue, 2);
    assert.deepEqual(records(h), records(a));
  }
});

test("同期容量を超えても削除記録と未送信変更を捨てない", async () => {
  const h = host({ settingsSyncEnabled: true }); await h.tick();
  const list = Array.from({ length: 500 }, (_, i) => ({ key: "@channel" + i, name: "長".repeat(100) }));
  await h.edit({ searchFixerBlockedChannels: list });
  const before = copy(records(h)); await h.tick();
  assert.equal(h.state.local[K.SETTINGS_SYNC_STATUS], "error");
  assert.equal(h.state.local.searchFixerBlockedChannels.length, 500);
  assert.deepEqual(records(h), before);
});

test("受信した削除の適用中に別項目を編集しても同期が継続する", async () => {
  const [a, b] = await peers({ loupeSize: 220, videoGammaValue: 1 });
  await a.storage.local.remove("loupeSize"); await a.tick();
  b.afterRemove(async () => {
    b.afterRemove(undefined); await b.edit({ videoGammaValue: 2 });
  });
  await b.receive(a.state.sync); await b.tick(); await b.tick();
  assert.ok(!("loupeSize" in b.state.local));
  assert.equal(b.state.local.videoGammaValue, 2);
  await b.receive(entry("loupeZoom", 4, [9000, 0, "C"])); await b.tick();
  assert.equal(b.state.local.loupeZoom, 4, "投影値の不一致で後続受信が停止しない");
});
