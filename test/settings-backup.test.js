"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("./_load-actions");
require("../src/lib/settings-backup");
const B = globalThis.SettingsBackup;
const file = (settings) => JSON.stringify({ format: "vuora-settings", version: 1, settings });

test("履歴の日時は旧形式の有限非負値を保ちDate範囲外でも往復できる", () => {
  for (const ts of [0, 1234, Date.now(), 8640000000000000, 8640000000000001, Number.MAX_VALUE]) {
    const history = [{ hex: "#123456", ts }];
    assert.deepEqual(B.parse(file({ colorPickerHistory: history })).colorPickerHistory, history);
    assert.deepEqual(B.parse(B.stringify({ colorPickerHistory: history }, "test")).colorPickerHistory, history);
  }
  for (const ts of [-1, null, "1234"]) {
    assert.throws(() => B.parse(file({ colorPickerHistory: [{ hex: "#123456", ts }] })));
  }
});

test("全設定を既定値込みで往復し、端末の同期情報や認証情報を持ち出さない", () => {
  const stored = { searchFixerEnabled: true, searchFixerFeatures: { hideComments: true }, xCleanerFeatures: { imageDownload: true },
    volumeBoosterEqGains: [1, 2, 3, 4, 5, -1, -2, -3, -4, -5],
    searchFixerBlockedChannels: [{ key: "@example", name: "Example" }],
    colorPickerHistory: [{ hex: "#123456", ts: 1234 }], popupLastTab: "settings",
    settingsSyncEnabled: true, _settingsSyncState: { secret: true }, notebookLmAccountIndex: 2,
    notebookLmAccountsCache: { token: "private" } };
  const result = B.parse(B.stringify(stored, "test"));
  for (const key of ["searchFixerEnabled", "volumeBoosterEqGains", "searchFixerBlockedChannels", "colorPickerHistory", "popupLastTab"])
    assert.deepEqual(result[key], stored[key]);
  assert.equal(result.searchFixerFeatures.hideComments, true);
  assert.equal(result.xCleanerFeatures.imageDownload, true);
  assert.equal(result.xCleanerEnabled, false);
  assert.equal(result.volumeBoosterEnabled, false);
  for (const { storageKey } of G.SettingsSchema) assert.ok(Object.hasOwn(result, storageKey));
  for (const key of ["settingsSyncEnabled", "_settingsSyncState", "notebookLmAccountIndex", "notebookLmAccountsCache"])
    assert.equal(Object.hasOwn(result, key), false);
  assert.deepEqual(B.parse(B.stringify(result, "test")), result);
});

test("破損・他製品・未知版・容量超過・不正値を保存前に拒否する", () => {
  for (const text of ["{", "null", "[]", file({}), file({ settingsSyncEnabled: true }),
    file({ searchFixerEnabled: "true" }), file({ videoGammaValue: 999 }),
    file({ searchFixerFeatures: { hideComments: "false" } }),
    file({ volumeBoosterEqGains: [1] }), file({ colorPickerHistory: [{ hex: "oops", ts: 1 }] }),
    file({ popupLastSubTab: { __bad: "video" } }),
    file({ searchFixerEnabled: true }).replace('"version":1', '"version":2'),
    file({ searchFixerEnabled: true }).replace('vuora-settings', 'other'),
    '{"format":"vuora-settings","version":1,"settings":{"__proto__":{"polluted":true}}}',
    " ".repeat(B.MAX_BYTES + 1)]) assert.throws(() => B.parse(text));
  assert.equal({}.polluted, undefined);
});

test("部分ファイルは指定項目だけ返し、欠落項目を初期化しない", () => {
  assert.deepEqual(B.parse(file({ searchFixerEnabled: false })), { searchFixerEnabled: false });
});

test("廃止された接続モニターだけを旧バックアップから除き、残る設定を復元する", () => {
  const stored = { searchFixerFeatures: { connectionMonitor: true, hideComments: true, broadcastClock: true } };
  for (const result of [B.parse(file(stored)), B.parse(B.stringify(stored, "test"))]) {
    assert.equal(Object.hasOwn(result.searchFixerFeatures, "connectionMonitor"), false);
    assert.equal(result.searchFixerFeatures.hideComments, true);
    assert.equal(result.searchFixerFeatures.broadcastClock, true);
  }
  assert.throws(() => B.parse(file({ searchFixerFeatures: { connectionMonitor: "true" } })));
  assert.throws(() => B.parse(file({ searchFixerFeatures: { unknown: true } })));
});


test("Wikipedia のオプトイン設定と外観は往復し、不明な配色や寸法を拒否する", () => {
  const settings = { wikipediaEnabled: true, wikipediaFeatures: { imageViewer: false },
    wikipediaAppearance: { theme: "sepia", font: "line-seed-jp", fontSize: 22, contentWidth: 800 } };
  const result = B.parse(B.stringify(settings, "test"));
  assert.equal(result.wikipediaEnabled, true);
  assert.equal(result.wikipediaFeatures.imageViewer, false);
  assert.equal(result.wikipediaFeatures.readableLayout, true);
  assert.equal(result.wikipediaFeatures.hideAppearance, false);
  assert.deepEqual(result.wikipediaAppearance, { ...G.WikipediaReader.DEFAULT_APPEARANCE, ...settings.wikipediaAppearance });
  for (const patch of [{ theme: "unknown" }, { font: "unknown" }, { fontSize: 13 }, { contentWidth: 1201 }, { tracking: true }])
    assert.throws(() => B.parse(file({ wikipediaAppearance: { ...settings.wikipediaAppearance, ...patch } })));
});

test("Wikipedia の本文幅・行間とエディターテーマをバックアップできる", () => {
  const settings = { wikipediaFeatures: { hideAppearance: true, narrowContent: true },
    wikipediaAppearance: { ...G.WikipediaReader.DEFAULT_APPEARANCE, theme: "one-dark", lineHeight: 1.55 } };
  const restored = B.parse(B.stringify(settings, "test"));
  assert.equal(restored.wikipediaFeatures.hideAppearance, true);
  assert.equal(restored.wikipediaFeatures.narrowContent, true);
  assert.equal(restored.wikipediaAppearance.lineHeight, 1.55);
  assert.equal(restored.wikipediaAppearance.theme, "one-dark");
});


test("Wikipedia の外観9項目はバックアップで保持し、未知の追加値を拒否する", () => {
  const appearance = { theme: "light", font: "line-seed-jp", fontSize: 19, contentWidth: 973,
    headingFont: "noto-sans-jp", linkStyle: "underline", coverImage: "show", borderRadius: "square", articleStyle: "pictures" };
  assert.deepEqual(B.parse(B.stringify({ wikipediaAppearance: appearance }, "test")).wikipediaAppearance, { ...appearance, lineHeight: 1.85 });
  for (const key of ["headingFont", "linkStyle", "coverImage", "borderRadius", "articleStyle"])
    assert.throws(() => B.parse(file({ wikipediaAppearance: { ...appearance, [key]: "unknown" } })));
});
