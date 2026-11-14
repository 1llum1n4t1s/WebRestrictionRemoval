"use strict";
// loupe.js が <body> を持たない文書（単体表示の SVG / XML）で、レンズ構築の例外により
// isActive が true のまま固着しないことを検証する。body が後から得られた場合は通常どおり動く。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const G = require("./_load-actions");
const K = G.StorageKeys;

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

class FakeElement {
  constructor() {
    this.style = {};
    this.children = [];
    this.id = "";
    this.removed = false;
  }
  attachShadow() { return new FakeElement(); }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute() {}
  remove() { this.removed = true; }
}

const loadLoupe = async ({ enabled = true, body = null } = {}) => {
  const storage = { [K.LOUPE_ENABLED]: enabled };
  const messages = [];
  const documentListeners = new Map();
  let onChanged;
  const document = {
    hidden: false,
    body,
    documentElement: new FakeElement(),
    createElement: () => new FakeElement(),
    addEventListener(type, fn) { documentListeners.set(type, fn); },
    removeEventListener(type) { documentListeners.delete(type); },
  };
  const window = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener() {}, removeEventListener() {},
  };
  window.top = window;
  const context = vm.createContext({
    window, document, console: { ...console, warn() {} },
    Loupe: G.Loupe, StorageKeys: K, Actions: G.Actions, SenderCheck: G.SenderCheck,
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: () => 1, clearTimeout() {},
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    chrome: {
      runtime: {
        id: "test-extension",
        onMessage: { addListener() {} },
        sendMessage: async (message) => { messages.push(message); return { ok: false }; },
      },
      storage: {
        local: { get: async (keys) => Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]])) },
        onChanged: { addListener: (fn) => { onChanged = fn; } },
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/content/loupe.js"), "utf8"), context);
  await settle();
  return {
    document, messages, documentListeners,
    // body が後から用意された（またはサイト側が差し替えた）状態で設定通知を受ける。
    notifyEnabled: async () => { onChanged({ [K.LOUPE_ENABLED]: { newValue: true } }, "local"); await settle(); },
  };
};

test("loupe: body のない文書ではレンズを作らず、キャプチャ要求・入力購読も始めない", async () => {
  const h = await loadLoupe();
  assert.equal(h.document.documentElement.children.length, 0);
  assert.equal(h.messages.length, 0);
  assert.equal(h.documentListeners.has("mousemove"), false);
  assert.equal(h.documentListeners.has("click"), false);
});

test("loupe: body のない文書で ON を受けても activate が固着せず、body 取得後の通知で起動する", async () => {
  const h = await loadLoupe();
  h.document.body = new FakeElement();
  await h.notifyEnabled();
  assert.equal(h.document.body.children.length, 1);
  assert.equal(h.document.body.children[0].id, G.Loupe.LENS_ID);
  assert.equal(h.messages.length, 1);
  assert.equal(h.documentListeners.has("mousemove"), true);
});

test("loupe: body がある通常の文書は従来どおり起動する", async () => {
  const body = new FakeElement();
  const h = await loadLoupe({ body });
  assert.equal(body.children.length, 1);
  assert.equal(h.messages.length, 1);
});
