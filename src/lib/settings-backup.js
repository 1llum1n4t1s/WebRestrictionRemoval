// 手動バックアップの許可リスト。認証、キャッシュ、同期制御情報は含めない。
(() => {
  "use strict";
  const K = StorageKeys;
  const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const fail = () => { throw new Error("invalid-settings-file"); };
  const rules = new Map();
  const add = (key, fallback, validate, normalize = (v) => v) => rules.set(key, { fallback, validate, normalize });
  const booleanKeys = SettingsSchema.map((s) => s.storageKey).filter((k) => k.endsWith("Enabled"));
  booleanKeys.push(K.VOLUME_BOOSTER_ENABLED, K.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
    K.VOLUME_BOOSTER_NIGHT_MODE_ENABLED, K.VOLUME_BOOSTER_BASS_CUT_ENABLED,
    K.VOLUME_BOOSTER_MUTED_ENABLED, K.VOLUME_BOOSTER_EQ_ENABLED);
  for (const key of booleanKeys) add(key, false, (v) => typeof v === "boolean");
  for (const [key, spec] of [[K.SEARCH_FIXER_FEATURES, SearchFixer],
    [K.INSTAGRAM_CLEANER_FEATURES, InstagramCleaner], [K.TIKTOK_CLEANER_FEATURES, TikTokCleaner],
    [K.X_CLEANER_FEATURES, XCleaner]]) {
    add(key, spec.DEFAULT_FEATURES, (v) => object(v) && Object.entries(v).every(([k, x]) =>
      Object.hasOwn(spec.DEFAULT_FEATURES, k) && typeof x === "boolean"), (v) => spec.mergeFeatures(v));
  }
  const number = (key, fallback, normalize) => add(key, fallback,
    (v) => typeof v === "number" && Number.isFinite(v) && normalize(v) === v);
  number(K.SEARCH_FIXER_GRID_ITEMS, 0, SearchFixer.clampGridItems);
  number(K.VOLUME_BOOSTER_LAST_GAIN, VolumeBooster.DEFAULT, VolumeBooster.clampValue);
  number(K.VOLUME_BOOSTER_EQ_PREAMP, 0, VolumeBooster.clampEqPreamp);
  number(K.VIDEO_GAMMA_VALUE, VideoGamma.DEFAULT, VideoGamma.clampValue);
  number(K.LOUPE_ZOOM, Loupe.DEFAULT_ZOOM, Loupe.validateZoom);
  number(K.LOUPE_SIZE, Loupe.SIZE_DEFAULT, Loupe.clampSize);
  const choice = (key, fallback, normalize) => add(key, fallback,
    (v) => typeof v === "string" && normalize(v) === v);
  choice(K.VIDEO_FILL_MODE, VideoFill.DEFAULT_MODE, VideoFill.normalizeMode);
  choice(K.VIDEO_FILL_TARGET, VideoFill.DEFAULT_TARGET, VideoFill.normalizeTarget);
  choice(K.VOLUME_BOOSTER_EQ_PRESET, "flat", VolumeBooster.normalizeEqPreset);
  choice(K.COLOR_PICKER_DEFAULT_FORMAT, ColorPicker.DEFAULT_FORMAT, ColorPicker.normalizeFormat);
  choice(K.POPUP_LAST_TAB, PopupTabs.TUNE, PopupTabs.normalize);
  add(K.COLOR_PICKER_HEX_HASH, true, (v) => typeof v === "boolean");
  add(K.VOLUME_BOOSTER_EQ_GAINS, VolumeBooster.clampEqGains([]), (v) =>
    Array.isArray(v) && v.length === VolumeBooster.EQ_BANDS.length && v.every((x) =>
      typeof x === "number" && Number.isFinite(x) && VolumeBooster.clampEqGain(x) === x));
  add(K.SEARCH_FIXER_BLOCKED_CHANNELS, [], (v) => Array.isArray(v) && v.every((x) =>
    object(x) && typeof x.key === "string" && typeof x.name === "string" &&
    SearchFixer.normalizeBlockedChannels([x]).length === 1), SearchFixer.normalizeBlockedChannels);
  add(K.COLOR_PICKER_HISTORY, [], (v) => Array.isArray(v) && v.length <= ColorPicker.HISTORY_LIMIT &&
    v.every((x) => object(x) && typeof x.hex === "string" && ColorPicker.normalizeHex(x.hex) !== null &&
      Number.isFinite(x.ts) && x.ts >= 0), (v) => v.map(({ hex, ts }) => ({ hex: ColorPicker.normalizeHex(hex), ts })));
  add(K.POPUP_LAST_SUBTAB, {}, (v) => object(v) && Object.entries(v).every(([k, x]) =>
    PopupTabs.isValid(k) && typeof x === "string" && x.length > 0 && x.length <= 100), PopupTabs.normalizeSubTabs);

  const MAX_BYTES = 5 * 1024 * 1024;
  function parse(text) {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_BYTES) return fail();
    const data = JSON.parse(text);
    if (!object(data) || data.format !== "vuora-settings" || data.version !== 1 ||
        !object(data.settings) || Object.keys(data.settings).length === 0) return fail();
    const record = {};
    for (const [key, value] of Object.entries(data.settings)) {
      const rule = rules.get(key);
      if (!rule || !rule.validate(value)) return fail();
      record[key] = rule.normalize(value);
    }
    return record;
  }
  function stringify(stored, extensionVersion) {
    const settings = {};
    for (const [key, rule] of rules) {
      const value = Object.hasOwn(stored, key) ? stored[key] : rule.fallback;
      if (!rule.validate(value)) return fail();
      settings[key] = rule.normalize(value);
    }
    const text = JSON.stringify({ format: "vuora-settings", version: 1,
      extensionVersion, exportedAt: new Date().toISOString(), settings }, null, 2);
    parse(text);
    return text;
  }
  globalThis.SettingsBackup = Object.freeze({ keys: Object.freeze([...rules.keys()]), MAX_BYTES, parse, stringify });
})();
