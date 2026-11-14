"use strict";
// document_start の early script が付けた pre クラスは、拡張機能の無効化・更新で context が失効した後も
// ページに残る。失効後は chrome.* のイベントが届かないため、early-framework は chrome に依存しない
// DOM 側の契機（visibilitychange / focus / pageshow）で失効を検知して撤去する必要がある。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (name) => fs.readFileSync(path.join(__dirname, "../src/content", name), "utf8");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

const CASES = [
  {
    name: "tiktok-early.js",
    stored: { tiktokCleanerEnabled: true, tiktokCleanerFeatures: { hideComments: true, hideSuggested: true } },
    classes: ["__cpa-tt-comments", "__cpa-tt-suggested"],
  },
  {
    name: "x-early.js",
    stored: { xCleanerEnabled: true, xCleanerFeatures: { hideRightPane: true, hideTrends: true } },
    classes: ["__cpa-x-right-pane", "__cpa-x-trends"],
  },
];

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  contains(name) { return this.values.has(name); }
}

const load = async (file, stored) => {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const listen = (map) => (type, fn) => { map.set(type, fn); };
  const unlisten = (map) => (type) => { map.delete(type); };
  const root = { classList: new FakeClassList(), children: [], appendChild(el) { this.children.push(el); } };
  const document = {
    documentElement: root,
    getElementById: (id) => root.children.find((el) => el.id === id) ?? null,
    createElement: () => ({ id: "", textContent: "" }),
    addEventListener: listen(documentListeners),
    removeEventListener: unlisten(documentListeners),
  };
  // ブラウザと同様に window をグローバルそのものにする（__cpaEarlyFramework を裸の識別子で参照するため）。
  const window = {
    document, console,
    addEventListener: listen(windowListeners),
    removeEventListener: unlisten(windowListeners),
  };
  window.window = window;
  window.top = window;
  const chrome = {
    runtime: { id: "test-extension" },
    storage: {
      local: { get: async () => ({ ...stored }) },
      onChanged: { addListener() {} },
    },
  };
  window.chrome = chrome;
  const context = vm.createContext(window);
  vm.runInContext(read("early-framework.js"), context);
  vm.runInContext(read(file), context);
  await settle();
  return {
    root, chrome, documentListeners, windowListeners,
    // chrome.* のイベントは一切発火させず、DOM のイベントだけを起こす。
    fire(kind, type) { (kind === "document" ? documentListeners : windowListeners).get(type)?.({}); },
    orphan() { chrome.runtime.id = undefined; },
    applied: () => [...root.classList.values].sort(),
  };
};

for (const { name, stored, classes } of CASES) {
  for (const [kind, type] of [["document", "visibilitychange"], ["window", "focus"], ["window", "pageshow"]]) {
    test(`${name}: context 失効後に ${type} で pre クラスを撤去する（chrome イベントなし）`, async () => {
      const h = await load(name, stored);
      assert.deepEqual(h.applied(), [...classes].sort());
      h.orphan();
      h.fire(kind, type);
      assert.deepEqual(h.applied(), []);
      // 撤去後は監視を残さない。
      assert.equal(h.documentListeners.size + h.windowListeners.size, 0);
    });
  }

  test(`${name}: context が有効な間は DOM イベントで pre クラスを外さない`, async () => {
    const h = await load(name, stored);
    h.fire("document", "visibilitychange");
    h.fire("window", "focus");
    h.fire("window", "pageshow");
    assert.deepEqual(h.applied(), [...classes].sort());
  });

  test(`${name}: pre クラスを付けていない（OFF）間は DOM 側の監視を張らない`, async () => {
    const h = await load(name, {});
    assert.deepEqual(h.applied(), []);
    assert.equal(h.documentListeners.size + h.windowListeners.size, 0);
  });
}
