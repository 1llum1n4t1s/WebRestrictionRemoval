"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/content/search-fixer.js"), "utf8");

const createChatPage = () => {
  const classes = new Set();
  const frames = new Map();
  const timers = new Map();
  let nextId = 0;
  let clicks = 0;
  const frame = {
    collapsed: false,
    hasAttribute: () => frame.collapsed,
    querySelector: () => iframe,
  };
  const closeButton = { disabled: false, ownerDocument: { defaultView: null },
    click() { clicks++; frame.collapsed = true; } };
  const iframe = Object.assign(new EventTarget(), {
    contentDocument: { readyState: "complete", querySelector: () => closeButton },
  });
  const document = Object.assign(new EventTarget(), {
    readyState: "complete",
    documentElement: { classList: {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name),
    } },
    querySelector: (selector) => selector.includes(" iframe") ? iframe : frame,
    querySelectorAll: () => [],
  });
  const context = vm.createContext({
    document, window: {}, chrome: { runtime: { id: "test" } },
    active: true, enabled: true, orphanCleanupRan: false, commentsRevealed: false,
    CLASS_PROCESSED: "cpa-sfx-processed",
    f: () => context.active && context.enabled && !context.orphanCleanupRan,
    isWatchPage: () => true,
    stopSubsSortLabelRepair() {}, removeCommentsToggle() {},
    MutationObserver: class {
      observe() {} disconnect() {} takeRecords() { return []; }
    },
    requestAnimationFrame(callback) { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback) { timers.set(++nextId, callback); return nextId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  // 状態・イベント購読・折りたたみ本体を本番ソースから実行し、YouTube の通知順だけを再現する。
  vm.runInContext(section("  let liveChatObserver = null;", "  // 注入する <style>"), context);
  vm.runInContext(section("  function syncLiveChatCollapse()", "  let scanScheduled = false;"), context);
  vm.runInContext("function onSettingsChanged() { syncLiveChatCollapse(); }", context);
  vm.runInContext(section("  // ---------- ナビゲーション・初期化", "  function onSettingsChanged()"), context);

  const run = (code) => vm.runInContext(code, context);
  const flush = (queue) => {
    for (let steps = 0; queue.size; steps++) {
      assert.ok(steps < 100, "処理が有限回で止まる");
      const [id, callback] = queue.entries().next().value;
      queue.delete(id);
      callback();
    }
  };
  return { frame, iframe, context, run,
    emit: (type) => document.dispatchEvent(new Event(type)),
    flushFrames: () => flush(frames), flushTimers: () => flush(timers),
    get clicks() { return clicks; },
    get hidden() { return classes.has("__cpa-sfx-hide-live-chat-pre"); },
  };
};

test("再生リストの遷移前の折りたたみ状態を完了扱いせず、次の動画を閉じて手動再表示を保つ", () => {
  const page = createChatPage();
  page.run("syncLiveChatCollapse()");
  page.flushFrames();
  assert.equal(page.clicks, 1, "初回のチャットを公式操作で閉じる");
  assert.equal(page.hidden, false);

  for (let next = 0; next < 2; next++) {
    page.emit("yt-navigate-start");
    page.emit("yt-navigate-finish");
    // finish 後も旧動画の collapsed が残り、旧 iframe の load 通知も遅れて到着する。
    page.iframe.dispatchEvent(new Event("load"));
    page.flushTimers();
    page.flushFrames();
    assert.equal(page.context.window.__cpaLiveChatCollapseHandled, false);
    assert.equal(page.hidden, true, "次の動画の反映まで先制非表示を維持する");

    page.frame.collapsed = false;
    page.emit("yt-page-data-updated");
    page.flushFrames();
    assert.equal(page.clicks, next + 2, "新動画のチャットを閉じる");
    assert.equal(page.frame.collapsed, true);
    assert.equal(page.hidden, false);

    page.frame.collapsed = false;
    page.emit("yt-page-data-updated");
    page.emit("yt-navigate-finish");
    page.iframe.dispatchEvent(new Event("load"));
    page.flushTimers();
    page.flushFrames();
    assert.equal(page.frame.collapsed, false, "同じ動画の手動再表示を維持する");
    assert.equal(page.clicks, next + 2);
    page.frame.collapsed = true;
  }
});

test("遷移中の個別OFF・マスターOFF・失効で非表示を解除し、遅延通知から閉じ直さない", () => {
  for (const disabled of ["enabled", "active", "orphanCleanupRan"]) {
    const page = createChatPage();
    page.emit("yt-navigate-start");
    page.context[disabled] = disabled === "orphanCleanupRan";
    page.run("syncLiveChatCollapse()");
    page.emit("yt-page-data-updated");
    page.emit("yt-navigate-finish");
    page.flushFrames();
    page.flushTimers();
    assert.equal(page.hidden, false, disabled);
    assert.equal(page.clicks, 0, disabled);
  }
});
