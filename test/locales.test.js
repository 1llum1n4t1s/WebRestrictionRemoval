"use strict";
// 全ロケールが英語（正）と同じキー・差し込み・長さ制限を満たすことを検証する。
// 言語を追加・削除するときは EXPECTED を同時に更新する（Chrome のロケールコードは zh_CN / pt_BR の形）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const EXPECTED = ["de", "en", "es", "fr", "ja", "ko", "pt_BR", "zh_CN", "zh_TW"];
const read = (locale) => JSON.parse(fs.readFileSync(path.join(root, "_locales", locale, "messages.json"), "utf8"));
const placeholders = (text) => (String(text).match(/\$[A-Za-z_0-9]+\$|\$\d/g) || []).sort().join();

test("対応ロケールは 9 言語（Toolport と同じ構成）で、manifest の既定言語は en", () => {
  assert.deepEqual(fs.readdirSync(path.join(root, "_locales")).sort(), EXPECTED);
  for (const manifest of ["manifest.json", "manifest.firefox.json"]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, manifest), "utf8")).default_locale, "en");
  }
});

const en = read("en");
for (const locale of EXPECTED.filter((l) => l !== "en")) {
  test(`${locale}: 英語と同じキー・順序・差し込み・placeholders で、空の文言がない`, () => {
    const data = read(locale);
    assert.deepEqual(Object.keys(data), Object.keys(en));
    for (const [key, entry] of Object.entries(data)) {
      assert.equal(typeof entry.message, "string", key);
      assert.ok(entry.message.trim().length > 0, `${key} が空`);
      assert.equal(placeholders(entry.message), placeholders(en[key].message), `${key} の差し込み記号`);
      assert.deepEqual(entry.placeholders ?? null, en[key].placeholders ?? null, `${key} の placeholders`);
    }
  });
}

// 前後を別の要素（<code> など）と連結して表示する文言は、英語で端に空白があるキーと同じ側に空白が必要。
// 言語の文法上、空白なしで連結するキーだけ EXCEPTIONS に理由付きで許可する。
const JOINED = ["videoGammaMasterDescPre", "videoGammaMasterDescPost", "amazonDeliveryMasterDescPre", "amazonDeliveryMasterDescPost"];
const EXCEPTIONS = {
  de: { videoGammaMasterDescPost: "複合語 `<video>`-Elemente として続ける" },
  es: { amazonDeliveryMasterDescPost: "文を句点で閉じるため" },
  fr: { amazonDeliveryMasterDescPost: "文を句点で閉じるため" },
  pt_BR: { amazonDeliveryMasterDescPost: "文を句点で閉じるため" },
};
test("前後を連結して表示する文言の端の空白は、英語と同じ側にある（文法上の例外は理由付き）", () => {
  const edge = (text) => `${/^\s/.test(text) ? "L" : "-"}${/\s$/.test(text) ? "R" : "-"}`;
  for (const locale of EXPECTED.filter((l) => l !== "en")) {
    const data = read(locale);
    for (const key of JOINED) {
      if (EXCEPTIONS[locale]?.[key]) continue;
      assert.equal(edge(data[key].message), edge(en[key].message), `${locale} ${key} の端の空白`);
    }
  }
});

test("data-i18n-attr のキーと、popup.js の動的キーが英語に存在する", () => {
  const html = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8");
  const keys = [...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(";").map((pair) => pair.split(":")[1]?.trim()).filter(Boolean));
  assert.ok(keys.length > 0);
  assert.deepEqual(keys.filter((key) => !(key in en)), []);
});

test("全ロケールで拡張機能名は 45 文字以内、説明は 132 文字以内（ストアの上限）", () => {
  for (const locale of EXPECTED) {
    const data = read(locale);
    assert.ok([...data.appName.message].length <= 45, `${locale} appName`);
    assert.ok([...data.appDescription.message].length <= 132, `${locale} appDescription`);
  }
});

test("popup.html の data-i18n が参照するキーはすべて英語に存在する", () => {
  const html = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8");
  const keys = [...html.matchAll(/data-i18n(?:-[\w-]+)?="([\w]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 20);
  assert.deepEqual(keys.filter((key) => !(key in en)), []);
});
