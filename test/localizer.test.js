"use strict";
// 表示言語の切り替え（Localizer。共通モジュール src/shared/ui-localizer.js）。chrome.i18n を差し替え、選んだ言語を優先し、無ければ標準へ戻すことを検証する。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/shared/ui-localizer.js"), "utf8");

function load({ stored = {}, native = {} } = {}) {
  const listeners = [];
  const data = { ...stored };
  const chrome = {
    i18n: {
      getMessage: (key, subs) => (key in native ? `native:${key}:${[].concat(subs ?? []).join(",")}` : ""),
      getUILanguage: () => "ja",
    },
    storage: {
      local: { get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])) },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  const context = vm.createContext({ chrome });
  vm.runInContext(source, context);
  return {
    chrome, context, Localizer: context.Localizer, StorageKeys: context.StorageKeys,
    async change(patch) { Object.assign(data, patch); for (const fn of listeners) fn(Object.fromEntries(Object.keys(patch).map((k) => [k, {}])), "local"); await new Promise(setImmediate); },
  };
}

const messages = (Localizer) => Localizer.compact({
  hello: { message: "Hallo", description: "x" },
  withArg: { message: "Datei $1 von $2" },
  named: { message: "Hallo $USER$, $1", placeholders: { user: { content: "$1" } } },
  money: { message: "Preis: $$5" },
});

test("9 言語（Toolport と同じ構成）を定義し、不正なコードは拒否する", () => {
  const { Localizer } = load();
  assert.deepEqual(JSON.parse(JSON.stringify(Localizer.LANGUAGES.map((l) => l.code))), ["en", "ja", "zh_CN", "zh_TW", "ko", "es", "fr", "de", "pt_BR"]);
  assert.equal(Localizer.normalizeCode("ko"), "ko");
  for (const bad of ["xx", "zh-CN", "", null, undefined, 3]) assert.equal(Localizer.normalizeCode(bad), null);
  assert.equal(Localizer.toTag("zh_CN"), "zh-CN");
});

test("選んだ言語の文言を優先し、差し込みと placeholders を Chrome と同じ規則で展開する", async () => {
  const h = load();
  const dictionary = messages(h.Localizer);
  const h2 = load({ stored: { uiLanguage: "de", uiMessages: dictionary } });
  await h2.Localizer.ready;
  const get = h2.chrome.i18n.getMessage;
  assert.equal(get("hello"), "Hallo");
  assert.equal(get("withArg", ["a.txt", "3"]), "Datei a.txt von 3");
  assert.equal(get("withArg", "a.txt"), "Datei a.txt von ", "足りない引数は空");
  assert.equal(get("named", "Yuro"), "Hallo Yuro, Yuro", "placeholders の $1 を引数で展開");
  assert.equal(get("money"), "Preis: $5", "$$ はドル記号");
  assert.equal(h2.chrome.i18n.getUILanguage(), "de");
});

test("未選択・不正な保存値・キーが無いときはブラウザ標準の動作に戻す", async () => {
  const native = { hello: 1, other: 1 };
  for (const stored of [{}, { uiLanguage: "xx", uiMessages: {} }, { uiLanguage: "de" }, { uiMessages: { hello: { m: "Hallo" } } }]) {
    const h = load({ stored, native });
    await h.Localizer.ready;
    assert.equal(h.chrome.i18n.getMessage("hello"), "native:hello:", JSON.stringify(stored));
    assert.equal(h.chrome.i18n.getUILanguage(), "ja");
  }
  const h = load({ stored: { uiLanguage: "de", uiMessages: { hello: { m: "Hallo" } } }, native });
  await h.Localizer.ready;
  assert.equal(h.chrome.i18n.getMessage("other", ["x"]), "native:other:x", "選んだ言語に無いキーは標準へ");
});

test("storage の変更（言語の選択・自動へ戻す）が後からも反映される", async () => {
  const h = load({ native: { hello: 1 } });
  await h.Localizer.ready;
  assert.equal(h.chrome.i18n.getMessage("hello"), "native:hello:");
  await h.change({ uiLanguage: "fr", uiMessages: { hello: { m: "Bonjour" } } });
  assert.equal(h.chrome.i18n.getMessage("hello"), "Bonjour");
  assert.equal(h.Localizer.code, "fr");
  await h.change({ uiLanguage: undefined, uiMessages: undefined });
  assert.equal(h.chrome.i18n.getMessage("hello"), "native:hello:");
  assert.equal(h.Localizer.code, null);
});

test("更新後は版の違う辞書を同梱の messages.json から作り直し、選んだ言語の新しいキーも出る", async () => {
  const written = {};
  const data = { uiLanguage: "de", uiMessages: { old: { m: "Alt" } }, uiMessagesVersion: "1.0.0" };
  const listeners = [];
  const chrome = {
    i18n: { getMessage: () => "", getUILanguage: () => "ja" },
    runtime: { getManifest: () => ({ version: "2.0.0" }), getURL: (p) => `chrome-extension://x/${p}` },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
        set: async (patch) => { Object.assign(data, patch); Object.assign(written, patch); },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  const context = vm.createContext({ chrome, location: { href: "chrome-extension://x/src/background/background.js" }, fetch: async (url) => ({ ok: url.endsWith("/_locales/de/messages.json"), json: async () => ({ fresh: { message: "Neu" } }) }) });
  vm.runInContext(source, context);
  await context.Localizer.ready;
  assert.equal(chrome.i18n.getMessage("fresh"), "", "更新前は新しいキーがない（標準へ戻る）");
  await context.Localizer.ensureFresh();
  assert.equal(chrome.i18n.getMessage("fresh"), "Neu");
  assert.equal(written.uiMessagesVersion, "2.0.0");
  // 版が同じなら作り直さない
  for (const key of Object.keys(written)) delete written[key];
  await context.Localizer.ensureFresh();
  assert.deepEqual(Object.keys(written), []);
});

test("差し替えが効かない環境では、選んだ言語を名乗らずブラウザ標準のまま動かす", async () => {
  const frozen = Object.freeze({ getMessage: () => "native", getUILanguage: () => "ja" });
  const chrome = {
    i18n: frozen,
    storage: {
      local: { get: async () => ({ uiLanguage: "de", uiMessages: { hello: { m: "Hallo" } } }) },
      onChanged: { addListener() {} },
    },
  };
  const context = vm.createContext({ chrome });
  vm.runInContext(source, context);
  await context.Localizer.ready;
  assert.equal(context.Localizer.installed, false);
  assert.equal(context.Localizer.code, null, "選択欄と表示がずれないよう、言語を名乗らない");
  assert.equal(chrome.i18n.getMessage("hello"), "native");
});

test("chrome が無い環境（テスト・サービスワーカー外）でも読み込みで throw しない", async () => {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  await context.Localizer.ready;
  assert.equal(context.Localizer.code, null);
});
