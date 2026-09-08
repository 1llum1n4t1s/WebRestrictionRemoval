"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("./_load-actions");
require("../src/lib/settings-backup");
const B = globalThis.SettingsBackup;
const file = (settings) => JSON.stringify({ format: "vuora-settings", version: 1, settings });

test("全設定を既定値込みで往復し、端末の同期情報や認証情報を持ち出さない", () => {
  const stored = { searchFixerEnabled: true, searchFixerFeatures: { hideComments: true },
    volumeBoosterEqGains: [1, 2, 3, 4, 5, -1, -2, -3, -4, -5],
    searchFixerBlockedChannels: [{ key: "@example", name: "Example" }],
    colorPickerHistory: [{ hex: "#123456", ts: 1234 }], popupLastTab: "settings",
    settingsSyncEnabled: true, _settingsSyncState: { secret: true }, notebookLmAccountIndex: 2,
    notebookLmAccountsCache: { token: "private" } };
  const result = B.parse(B.stringify(stored, "test"));
  for (const key of ["searchFixerEnabled", "volumeBoosterEqGains", "searchFixerBlockedChannels", "colorPickerHistory", "popupLastTab"])
    assert.deepEqual(result[key], stored[key]);
  assert.equal(result.searchFixerFeatures.hideComments, true);
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
