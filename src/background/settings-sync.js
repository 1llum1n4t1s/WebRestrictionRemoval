// サイト適用は local のまま、変更時の更新情報で項目単位の後勝ちを行う。
(() => {
  "use strict";
  // popup の世代確認と保存を、同期受信の反映に対して不可分にする。
  let writeChain = Promise.resolve();
  globalThis.enqueueSettingsWrite = (operation) => {
    const run = writeChain.then(operation);
    writeChain = run.catch(() => {});
    return run;
  };
  const K = StorageKeys;
  const PREFIX = "vuora.settings.v2.";
  const LEGACY_PREFIX = "vuora.settings.v1.";
  const EQ = "equalizer";
  const eqKeys = [K.VOLUME_BOOSTER_EQ_ENABLED, K.VOLUME_BOOSTER_EQ_GAINS,
    K.VOLUME_BOOSTER_EQ_PREAMP, K.VOLUME_BOOSTER_EQ_PRESET];
  const features = new Map([
    [K.SEARCH_FIXER_FEATURES, SearchFixer], [K.INSTAGRAM_CLEANER_FEATURES, InstagramCleaner],
    [K.TIKTOK_CLEANER_FEATURES, TikTokCleaner], [K.X_CLEANER_FEATURES, XCleaner],
  ]);
  const scalarKeys = [...new Set([
    ...SettingsSchema.map(({ storageKey }) => storageKey).filter((key) => !features.has(key)),
    K.VOLUME_BOOSTER_ENABLED, K.VOLUME_BOOSTER_LAST_GAIN,
    K.VOLUME_BOOSTER_ANTI_CLIP_ENABLED, K.VOLUME_BOOSTER_NIGHT_MODE_ENABLED,
    K.VOLUME_BOOSTER_BASS_CUT_ENABLED, K.VOLUME_BOOSTER_MUTED_ENABLED,
    K.LOUPE_ZOOM, K.LOUPE_SIZE, K.COLOR_PICKER_DEFAULT_FORMAT, K.COLOR_PICKER_HEX_HASH,
  ])];
  const keys = [...scalarKeys, ...features.keys(), ...eqKeys, K.SEARCH_FIXER_BLOCKED_CHANNELS];
  const fixedBuckets = new Map(scalarKeys.map((key) => [key, key]));
  fixedBuckets.set(EQ, EQ);
  for (const [key, spec] of features) {
    for (const name of Object.keys(spec.DEFAULT_FEATURES)) fixedBuckets.set(`${key}/${name}`, key);
  }
  const channelPrefix = `${K.SEARCH_FIXER_BLOCKED_CHANNELS}/`;
  const channelId = (key) => channelPrefix + encodeURIComponent(key);
  // 配列の並べ替えやオブジェクトの列挙順を編集と誤認しない。
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
  };
  const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  const pack = (value) => value === undefined ? { deleted: true } : { value };
  const payload = (record) => record.deleted === true ? { deleted: true } : { value: record.value };
  const compare = (a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a.stamp[i] !== b.stamp[i]) return a.stamp[i] > b.stamp[i] ? 1 : -1;
    }
    // 同一更新IDに異なる値が入った破損データでも、全PCで同じ順序を選ぶ。
    const av = JSON.stringify(stable(payload(a)));
    const bv = JSON.stringify(stable(payload(b)));
    return av === bv ? 0 : av > bv ? 1 : -1;
  };
  const channelKey = (id) => {
    if (!id.startsWith(channelPrefix)) return null;
    try {
      const key = decodeURIComponent(id.slice(channelPrefix.length));
      return SearchFixer.normalizeBlockedChannels([{ key }])[0]?.key === key ? key : null;
    } catch { return null; }
  };
  const bucketFor = (id) => {
    if (fixedBuckets.has(id)) return fixedBuckets.get(id);
    const key = channelKey(id);
    if (!key) return null;
    // 固定32分割。追加・削除記録が増えても sync の512キー上限を食い潰さない。
    let hash = 2166136261;
    for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
    return `channels.${(hash >>> 0) % 32}`;
  };
  const validRecord = (id, record) => {
    if (!bucketFor(id) || !record || typeof record !== "object") return false;
    const s = record.stamp;
    if (!Array.isArray(s) || s.length !== 3 || !Number.isSafeInteger(s[0]) || s[0] < 0 ||
        s[0] > 8640000000000000 || !Number.isSafeInteger(s[1]) || s[1] < 0 ||
        s[1] >= Number.MAX_SAFE_INTEGER || typeof s[2] !== "string" || !/^[\w-]{1,64}$/.test(s[2])) return false;
    if (record.deleted === true) return id !== EQ && !features.has(bucketFor(id));
    if (!Object.hasOwn(record, "value")) return false;
    if (features.has(bucketFor(id))) return typeof record.value === "boolean";
    if (id === EQ) return record.value && typeof record.value === "object" &&
      eqKeys.every((key) => Object.hasOwn(record.value, key)) && equal(record.value, snapshot(record.value)[EQ].value);
    if (id.startsWith(channelPrefix)) {
      const entry = SearchFixer.normalizeBlockedChannels([record.value])[0];
      return entry?.key === channelKey(id) && equal(entry, record.value);
    }
    if (id.endsWith("Enabled") || id === K.COLOR_PICKER_HEX_HASH) return typeof record.value === "boolean";
    if ([K.VIDEO_FILL_MODE, K.VIDEO_FILL_TARGET, K.COLOR_PICKER_DEFAULT_FORMAT].includes(id)) return typeof record.value === "string";
    return typeof record.value === "number" && Number.isFinite(record.value);
  };
  const snapshot = (view) => {
    const out = Object.fromEntries(scalarKeys.map((key) => [key, pack(view[key])]));
    for (const [key, spec] of features) {
      for (const [name, value] of Object.entries(spec.mergeFeatures(view[key]))) out[`${key}/${name}`] = { value };
    }
    out[EQ] = { value: {
      [K.VOLUME_BOOSTER_EQ_ENABLED]: view[K.VOLUME_BOOSTER_EQ_ENABLED] === true,
      [K.VOLUME_BOOSTER_EQ_GAINS]: VolumeBooster.clampEqGains(view[K.VOLUME_BOOSTER_EQ_GAINS]),
      [K.VOLUME_BOOSTER_EQ_PREAMP]: VolumeBooster.clampEqPreamp(view[K.VOLUME_BOOSTER_EQ_PREAMP]),
      [K.VOLUME_BOOSTER_EQ_PRESET]: VolumeBooster.normalizeEqPreset(view[K.VOLUME_BOOSTER_EQ_PRESET]),
    } };
    for (const entry of SearchFixer.normalizeBlockedChannels(view[K.SEARCH_FIXER_BLOCKED_CHANNELS])) {
      out[channelId(entry.key)] = { value: entry };
    }
    return out;
  };

  let state;
  let active = false;
  let generation = 0;
  let revision = 0;
  let stateQueue = Promise.resolve();
  let networkQueue = Promise.resolve();
  let timer;
  let attempts = 0;
  const expected = new Map();
  const setStatus = (value) => chrome.storage.local.set({ [K.SETTINGS_SYNC_STATUS]: value });
  const save = () => chrome.storage.local.set({ [K.SETTINGS_SYNC_STATE]: state });
  const enqueue = (fn) => {
    const result = stateQueue.then(fn);
    // 1回の保存失敗で後続のユーザー操作を停止しない。
    stateQueue = result.catch(() => {});
    return result;
  };
  const observe = (stamp) => {
    if (stamp[0] > state.clock[0] || (stamp[0] === state.clock[0] && stamp[1] > state.clock[1])) {
      state.clock = stamp.slice(0, 2);
    }
  };
  const nextStamp = (at) => {
    const time = Math.max(at, state.clock[0]);
    const count = time === state.clock[0] ? state.clock[1] + 1 : 0;
    state.clock = [time, count];
    return [time, count, state.device];
  };
  const recordChanges = (before, after, at) => {
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((id) => !equal(before[id], after[id]));
    if (!changed.length) return;
    const stamp = nextStamp(at);
    for (const id of changed) state.records[id] = { ...(after[id] || { deleted: true }), stamp };
  };
  const merge = (remote) => {
    let changed = false;
    for (const [key, bucket] of Object.entries(remote)) {
      if (!key.startsWith(PREFIX) || bucket?.version !== 2 || !bucket.items || typeof bucket.items !== "object") continue;
      for (const [id, record] of Object.entries(bucket.items)) {
        if (PREFIX + bucketFor(id) !== key || !validRecord(id, record)) continue;
        const local = state.records[id];
        if (!local || compare(record, local) > 0) {
          state.records[id] = { ...payload(record), stamp: record.stamp.slice() };
          changed = true;
        }
        observe(record.stamp);
      }
    }
    return changed;
  };
  const buckets = () => {
    const out = {};
    for (const [id, record] of Object.entries(state.records)) {
      const key = PREFIX + bucketFor(id);
      (out[key] ||= { version: 2, items: {} }).items[id] = record;
    }
    return out;
  };
  const project = () => {
    const view = { ...state.view };
    for (const key of scalarKeys) {
      const record = state.records[key];
      if (!record) continue;
      if (record.deleted) delete view[key];
      else view[key] = record.value;
    }
    for (const [key, spec] of features) {
      view[key] = spec.mergeFeatures(view[key]);
      for (const name of Object.keys(spec.DEFAULT_FEATURES)) {
        const record = state.records[`${key}/${name}`];
        if (record) view[key][name] = record.value;
      }
    }
    if (state.records[EQ]) Object.assign(view, state.records[EQ].value);
    view[K.SEARCH_FIXER_BLOCKED_CHANNELS] = SearchFixer.normalizeBlockedChannels(Object.entries(state.records)
      .filter(([id, record]) => id.startsWith(channelPrefix) && !record.deleted)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, record]) => record.value));
    return view;
  };

  async function applyRecords(epoch) {
    const rev = revision;
    const latest = await chrome.storage.local.get(keys);
    // まだイベントキューにある編集を先に記録する。比較と書込の間に await を挟まない。
    if (!active || epoch !== generation || rev !== revision || !equal(snapshot(latest), snapshot(state.view))) return;
    const view = project();
    const updates = {};
    const removals = [];
    for (const key of keys) {
      if (equal(latest[key], view[key])) continue;
      if (view[key] === undefined) {
        expected.set(key, { oldValue: latest[key], newValue: undefined });
        removals.push(key);
      }
      else updates[key] = view[key];
    }
    if (!removals.length && !Object.keys(updates).length) return;
    try {
      if (removals.length) {
        state.pendingRemovals = removals;
        await save();
        if (!active || epoch !== generation || rev !== revision) {
          for (const key of removals) expected.delete(key);
          return;
        }
        await chrome.storage.local.remove(removals);
        // 別項目の編集で後続の set を延期しても、完了した削除の投影値は進める。
        for (const key of removals) delete state.view[key];
      }
      if (!active || epoch !== generation || rev !== revision) return;
      const next = { ...state, view, pendingRemovals: [] };
      // 設定と投影値を同じ書込にし、途中終了をユーザー編集と誤認しない。
      await chrome.storage.local.set({ ...updates, [K.SETTINGS_SYNC_STATE]: next,
        [K.SETTINGS_SYNC_APPLIED]: crypto.randomUUID() });
      state = next;
    } catch (error) {
      for (const key of removals) expected.delete(key);
      throw error;
    }
  }

  async function synchronize() {
    await stateQueue;
    if (!active) return;
    const epoch = generation;
    await setStatus("working");
    const remote = await chrome.storage.sync.get(null);
    const uploads = await enqueue(async () => {
      if (!active || epoch !== generation) return null;
      merge(remote);
      if (!state.joined) {
        // 未リリースの旧試作形式は初回だけ読み替え、その後の実行経路から撤去する。
        const initialView = { ...state.view };
        for (const key of keys) {
          const record = remote[LEGACY_PREFIX + key];
          if (record?.removed === true) delete initialView[key];
          else if (record && Object.hasOwn(record, "value")) initialView[key] = record.value;
        }
        const initial = snapshot(initialView);
        for (const [id, value] of Object.entries(initial)) {
          // 初参加の既存値は時刻不明（0）。既存のクラウド更新を優先する。
          state.records[id] ||= { ...value, stamp: [0, 0, state.device] };
        }
        state.joined = true;
      }
      // 勝者を local に永続化してから適用・送信し、ブラウザ側の巻き戻りから回復する。
      await save();
      await globalThis.enqueueSettingsWrite(() => applyRecords(epoch));
      return Object.fromEntries(Object.entries(buckets()).filter(([key, value]) => !equal(remote[key], value)));
    });
    if (!uploads || !active || epoch !== generation) return;
    if (Object.keys(uploads).length) await chrome.storage.sync.set(uploads);
    if (!active || epoch !== generation) return;
    const legacyKeys = keys.map((key) => LEGACY_PREFIX + key).filter((key) => key in remote);
    if (legacyKeys.length) await chrome.storage.sync.remove(legacyKeys);
    attempts = 0;
    await setStatus("ready");
  }

  function failed() {
    setStatus("error").catch(() => {});
    if (active && ++attempts <= 3) schedule(15000);
  }
  function schedule(delay = 5000) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      networkQueue = networkQueue.then(synchronize).catch(failed);
    }, delay);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      const remote = Object.fromEntries(Object.entries(changes).filter(([key]) => key.startsWith(PREFIX))
        .map(([key, change]) => [key, change.newValue]));
      if (!Object.keys(remote).length) return;
      enqueue(async () => { if (active && merge(remote)) await save(); }).catch(failed);
      schedule();
      return;
    }
    if (area !== "local") return;
    // 更新通知が set の完了より遅れても、受信反映を新しい編集として刻印しない。
    if (K.SETTINGS_SYNC_APPLIED in changes) return;
    const patch = {};
    for (const key of keys) {
      if (!(key in changes) || equal(changes[key].oldValue, changes[key].newValue)) continue;
      if (expected.has(key) && equal(expected.get(key).newValue, changes[key].newValue) &&
          equal(expected.get(key).oldValue, changes[key].oldValue)) {
        expected.delete(key);
        continue;
      }
      patch[key] = changes[key].newValue;
    }
    const toggled = K.SETTINGS_SYNC_ENABLED in changes;
    if (!toggled && !Object.keys(patch).length && !(K.SETTINGS_SYNC_RETRY in changes)) return;
    const at = Date.now();
    if (toggled) generation++;
    if (Object.keys(patch).length || toggled) revision++;
    enqueue(async () => {
      const before = snapshot(state.view);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete state.view[key];
        else state.view[key] = value;
      }
      if (toggled) {
        active = changes[K.SETTINGS_SYNC_ENABLED].newValue === true;
        state.joined = false;
        state.records = {};
        attempts = 0;
      }
      if (active) recordChanges(before, snapshot(state.view), at);
      await save();
      if (!active) await setStatus("off");
      schedule(toggled ? 0 : 5000);
    }).catch(failed);
  });

  // 購読を登録してから初期値を取得し、MV3起動中の設定変更もキューで保持する。
  enqueue(async () => {
    const stored = await chrome.storage.local.get([...keys, K.SETTINGS_SYNC_ENABLED, K.SETTINGS_SYNC_STATE]);
    active = stored[K.SETTINGS_SYNC_ENABLED] === true;
    const saved = stored[K.SETTINGS_SYNC_STATE];
    state = { device: crypto.randomUUID(), clock: [0, 0], records: {}, view: {}, joined: false };
    if (saved && typeof saved.device === "string" && /^[\w-]{1,64}$/.test(saved.device)) {
      state.device = saved.device;
      if (Array.isArray(saved.clock) && saved.clock.length === 2 &&
          Number.isSafeInteger(saved.clock[0]) && saved.clock[0] >= 0 && saved.clock[0] <= 8640000000000000 &&
          Number.isSafeInteger(saved.clock[1]) && saved.clock[1] >= 0 && saved.clock[1] < Number.MAX_SAFE_INTEGER) {
        state.clock = saved.clock.slice();
      }
      state.joined = saved.joined === true;
      state.view = Object.fromEntries(keys.filter((key) => Object.hasOwn(saved.view || {}, key))
        .map((key) => [key, saved.view[key]]));
      // 受信した削除の適用直後に終了しても、削除を新しいローカル操作にしない。
      for (const key of saved.pendingRemovals || []) {
        if (keys.includes(key) && !(key in stored)) delete state.view[key];
      }
      for (const [id, record] of Object.entries(saved.records || {})) {
        if (validRecord(id, record)) { state.records[id] = record; observe(record.stamp); }
      }
    }
    const view = Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
    // イベント記録前にプロセスが終了した差分は、再起動時刻で回復する。
    if (active && state.joined) recordChanges(snapshot(state.view), snapshot(view), Date.now());
    state.view = view;
    await save();
    await chrome.storage.local.remove("_settingsSyncBaseline");
    schedule(0);
  }).catch(failed);
})();
