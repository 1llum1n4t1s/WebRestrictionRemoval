"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { SearchFixer, StorageKeys, Actions, SenderCheck } = require("./_load-actions");

const fixture = (pathname) => {
  const cards = [];
  const events = {};
  let initialResolve, changed;
  const classes = { add() {}, remove() {}, toggle() {}, contains: () => false };
  function card(key) {
    let button;
    const link = { getAttribute: () => `/${key}`, textContent: key };
    const channel = { offsetParent: {}, querySelector: () => link,
      parentElement: { querySelector: () => button },
      insertAdjacentElement: (where, el) => { button = el; } };
    const result = { isConnected: true, classList: classes,
      closest: () => null,
      querySelectorAll: (selector) => selector === "ytd-channel-name" ? [channel] : [],
      querySelector: (selector) => selector.includes("ytLockupMetadataViewModelMetadata") ? link : null,
      remove() { this.isConnected = false; }, get button() { return button; } };
    cards.push(result);
    return result;
  }
  const document = { readyState: "complete", documentElement: { classList: classes },
    addEventListener: (name, fn) => { events[name] = fn; },
    getElementById: () => null, querySelector: () => null,
    querySelectorAll: (selector) => selector.includes("#primary ytd-item-section-renderer ytd-video-renderer") || selector === "yt-lockup-view-model" ? cards.filter((c) => c.isConnected) : [],
    createElement: () => ({ dataset: {}, setAttribute() {}, addEventListener() {} }) };
  const window = { addEventListener() {} }; window.top = window;
  const context = vm.createContext({ window, document, SearchFixer, StorageKeys, Actions, SenderCheck,
    location: { pathname, search: "?search_query=sample", href: `https://www.youtube.com${pathname}` },
    URL, URLSearchParams, AbortController, console,
    chrome: { runtime: { id: "extension", onMessage: { addListener() {} } },
      i18n: { getMessage: () => "Block channel" },
      storage: { local: { get: () => new Promise((resolve) => { initialResolve = resolve; }) },
        onChanged: { addListener: (fn) => { changed = fn; } } } },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, clearTimeout() {}, clearInterval() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/content/search-fixer.js"), "utf8"), context);
  const settings = { [StorageKeys.SEARCH_FIXER_ENABLED]: true,
    [StorageKeys.SEARCH_FIXER_FEATURES]: { channelBlocklist: true } };
  return { card,
    async initial(blocked = []) { initialResolve({ ...settings, [StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS]: blocked }); await Promise.resolve(); await Promise.resolve(); },
    change(blocked) { changed({ [StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS]: { newValue: blocked } }, "local"); },
    navigate() { events["yt-navigate-finish"](); } };
};

for (const pathname of ["/results", "/feed/subscriptions"]) {
  test(`チャンネル除外 ${pathname}: 未登録・登録・解除をstorage通知から反映`, async () => {
    const f = fixture(pathname);
    const unknown = f.card("@unknown");
    const blocked = f.card("@blocked");
    await f.initial([{ key: "@BLOCKED", name: "blocked" }]);
    assert.equal(unknown.isConnected, true);
    assert.equal(blocked.isConnected, false);
    if (pathname === "/results") assert.ok(unknown.button, "未登録カードに登録ボタン");
    f.change([{ key: "@unknown" }]);
    assert.equal(unknown.isConnected, false, "追加通知で既存カードを除外");
    f.change([]);
    const restored = f.card("@unknown");
    f.navigate();
    assert.equal(restored.isConnected, true, "解除後に新たに描画したカードは保持");
    if (pathname === "/results") assert.ok(restored.button, "空一覧でも登録ボタン");
  });

  test(`チャンネル除外 ${pathname}: 500件上限と初期取得より新しい通知を優先`, async () => {
    const f = fixture(pathname);
    const first = f.card("@channel0");
    const last = f.card("@channel499");
    const overflow = f.card("@channel500");
    const stale = f.card("@stale");
    f.change(Array.from({ length: 501 }, (_, i) => ({ key: `@channel${i}` })));
    await f.initial([{ key: "@stale" }]);
    assert.equal(first.isConnected, false);
    assert.equal(last.isConnected, false);
    assert.equal(overflow.isConnected, true);
    assert.equal(stale.isConnected, true, "古い初期値で巻き戻さない");
  });
}
