"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const G = require("./_load-actions.js");

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) { force ? this.add(value) : this.remove(value); }
}

class FakeElement {
  constructor(localName = "div") {
    this.localName = localName;
    this.classList = new FakeClassList();
    this.children = [];
    this.parentElement = null;
    this.candidates = [];
    this.commentInput = false;
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector === "article" && node.localName === "article") return node;
    }
    return null;
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  querySelector(selector) {
    if (selector.startsWith("textarea[")) return this.commentInput ? {} : null;
    if (selector === "article") {
      for (const child of this.children) {
        if (child.localName === "article") return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    if (selector.startsWith(".")) {
      const name = selector.slice(1);
      if (this.classList.contains(name)) return this;
      for (const child of this.children) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }
  querySelectorAll(selector) {
    if (selector === ":scope > li") return this.children.filter((child) => child.localName === "li");
    if (selector.startsWith("ul:not(")) {
      return [
        ...this.candidates,
        ...this.children.flatMap((child) => child.querySelectorAll(selector)),
      ];
    }
    if (selector.startsWith("article")) return this.candidates;
    return [];
  }
}

class FakeCommentItem extends FakeElement {
  constructor(handle, { commentPermalink = true, extraCaptionTime = false } = {}) {
    super("div");
    this.handle = handle;
    this.commentPermalink = commentPermalink;
    this.extraCaptionTime = extraCaptionTime;
  }
  querySelector(selector) {
    if (selector === "a[href^='/']") {
      return { getAttribute: () => `/${this.handle}/` };
    }
    if (selector === "time") return {};
    if (selector === 'a[href*="/c/"]' && this.commentPermalink) {
      return { getAttribute: () => `/p/shortcode/c/${this.handle}-comment/` };
    }
    return super.querySelector(selector);
  }
  querySelectorAll(selector) {
    if (selector === "time") return Array(this.extraCaptionTime ? 2 : 1).fill({});
    if (selector === 'a[href*="/c/"] time') return this.commentPermalink ? [{}] : [];
    return super.querySelectorAll(selector);
  }
}

const createHarness = ({ pathname = "/", withComments = false, withDialog = true } = {}) => {
  let subscription;
  const timers = [];
  const intervals = new Map();
  let nextInterval = 1;
  const documentListeners = new Map();
  const documentElement = new FakeElement("html");
  const body = new FakeElement("body");
  documentElement.append(body);
  const article = new FakeElement("article");
  const video = new FakeElement("video");
  video.paused = false;
  video.pauseCalls = 0;
  video.pause = () => { video.paused = true; video.pauseCalls++; };
  article.append(video);
  body.append(article);

  const main = new FakeElement("main");
  const dialog = new FakeElement("div");
  const existing = new FakeElement("ul");
  existing.classList.add(G.InstagramCleaner.COMMENT_LIST_CLASS);
  main.append(existing);
  const newComments = new FakeElement("div");
  newComments.children = [new FakeCommentItem("alice"), new FakeCommentItem("bob")];
  const mixedCaption = new FakeElement("div");
  mixedCaption.children = [
    new FakeCommentItem("alice"), new FakeCommentItem("bob"),
    new FakeCommentItem("carol"), new FakeCommentItem("author", { commentPermalink: false }),
  ];
  const bundledCaption = new FakeElement("div");
  bundledCaption.children = [
    new FakeCommentItem("alice", { extraCaptionTime: true }), new FakeCommentItem("bob"),
  ];
  const knownMixedList = new FakeElement("ul");
  knownMixedList.classList.add("_a9z6");
  knownMixedList.children = [new FakeCommentItem("alice"), new FakeCommentItem("bob")];
  dialog.candidates = [newComments, mixedCaption, bundledCaption, knownMixedList];
  const feedComments = new FakeElement("ul");
  feedComments.children = [new FakeCommentItem("alice"), new FakeCommentItem("bob")];
  for (const item of feedComments.children) item.localName = "li";
  const feedMixedCaption = new FakeElement("ul");
  feedMixedCaption.classList.add("_a9z6");
  feedMixedCaption.children = [
    new FakeCommentItem("alice"), new FakeCommentItem("bob"),
    new FakeCommentItem("carol"), new FakeCommentItem("author", { commentPermalink: false }),
  ];
  for (const item of feedMixedCaption.children) item.localName = "li";
  dialog.commentInput = true;
  main.commentInput = true;
  if (!withDialog) main.candidates = [newComments];
  main.append(dialog);

  const document = {
    hidden: false,
    documentElement,
    body,
    querySelector(selector) {
      if (withComments && selector.startsWith("textarea[")) return {};
      if (selector === 'main[role="main"]') return withComments ? main : null;
      if (selector === '[role="dialog"]') return withComments && withDialog ? dialog : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "article video") return [video];
      if (selector.startsWith("article ul:not(")) return withComments ? [feedComments, feedMixedCaption] : [];
      if (selector.startsWith(":is(")) return [article, existing];
      return [];
    },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      documentListeners.set(type, (documentListeners.get(type) ?? []).filter((item) => item !== listener));
    },
  };
  const redirects = [];
  const location = {
    pathname,
    replace(value) { redirects.push(value); },
    set href(value) { redirects.push(value); },
  };
  const window = { top: null, location };
  window.top = window;

  const context = vm.createContext({
    window,
    document,
    location,
    InstagramCleaner: G.InstagramCleaner,
    CleanerCore: { subscribe(config) { subscription = config; } },
    StorageKeys: G.StorageKeys,
    Actions: G.Actions,
    chrome: { runtime: { id: "extension-id" } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
    setInterval(callback) { const id = nextInterval++; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    console,
  });
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "instagram-cleaner.js"),
    "utf8"
  );
  vm.runInContext(source, context);

  return {
    video,
    newComments,
    mixedCaption,
    bundledCaption,
    knownMixedList,
    feedComments,
    feedMixedCaption,
    redirects,
    documentElement, article,
    invalidate() { context.chrome.runtime.id = undefined; },
    runIntervals() { for (const callback of [...intervals.values()]) callback(); },
    intervalCount() { return intervals.size; },
    update(active, features) { subscription.onUpdate({ active, features: G.InstagramCleaner.mergeFeatures(features) }); },
    runTimer(delay) {
      const timer = timers.find((item) => item.delay === delay);
      if (timer) timer.callback();
    },
    fireDocument(type, target) {
      for (const listener of documentListeners.get(type) ?? []) listener({ target });
    },
    listenerCount(type) { return (documentListeners.get(type) ?? []).length; },
  };
};

test("Instagram cleaner: blockVideos は既存動画と後続 play を停止し、OFF で listener を外す", () => {
  const h = createHarness();
  h.update(true, { blockVideos: true });
  assert.equal(h.video.paused, true);
  assert.equal(h.listenerCount("play"), 1);

  h.video.paused = false;
  h.fireDocument("play", h.video);
  assert.equal(h.video.paused, true);

  h.update(true, {});
  assert.equal(h.listenerCount("play"), 0);
  h.video.paused = false;
  h.fireDocument("play", h.video);
  assert.equal(h.video.paused, false);
});

test("Instagram cleaner: 既存マーカーが main にあっても新規 dialog のコメントを検出する", () => {
  const h = createHarness({ withComments: true });
  h.update(true, { comments: true });
  h.runTimer(300);
  assert.equal(h.newComments.classList.contains(G.InstagramCleaner.COMMENT_LIST_CLASS), true);
  assert.equal(h.feedComments.classList.contains(G.InstagramCleaner.COMMENT_LIST_CLASS), true);
});

test("Instagram cleaner: caption 混在コンテナと本文時刻を含む候補は隠さない", () => {
  const h = createHarness({ withComments: true });
  h.update(true, { comments: true });
  h.runTimer(300);
  for (const candidate of [h.mixedCaption, h.bundledCaption, h.knownMixedList, h.feedMixedCaption]) {
    assert.equal(candidate.classList.contains(G.InstagramCleaner.COMMENT_LIST_CLASS), false);
  }
});

test("Instagram cleaner: dialog 外では投稿詳細 URL の main だけを走査する", () => {
  const feed = createHarness({ pathname: "/", withComments: true, withDialog: false });
  feed.update(true, { comments: true });
  feed.runTimer(300);
  assert.equal(feed.newComments.classList.contains(G.InstagramCleaner.COMMENT_LIST_CLASS), false);

  const detail = createHarness({ pathname: "/reels/shortcode/", withComments: true, withDialog: false });
  detail.update(true, { comments: true });
  detail.runTimer(300);
  assert.equal(detail.newComments.classList.contains(G.InstagramCleaner.COMMENT_LIST_CLASS), true);
});

test("Instagram cleaner: Reels 削除は現行・旧個別 URL の双方をホームへ戻す", () => {
  for (const pathname of ["/reels/shortcode/", "/reel/shortcode/"]) {
    const h = createHarness({ pathname });
    h.update(true, { reels: true });
    assert.deepEqual(h.redirects, ["/"]);
  }
});

test("Instagram cleaner CSS: 動画投稿内の全 button を一括非表示にしない", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "instagram-cleaner.css"),
    "utf8"
  );
  assert.doesNotMatch(css, /article\.__cpa-ig-article-video\s+button\[type=["']button["']\]/);
  assert.match(css, /article\.__cpa-ig-article-video \[aria-label="Play"\]/);
});

for (const features of [{ reels: true }, { blockVideos: true, comments: true }]) {
  test(`Instagram cleaner: context失効でクラス・マーカー・購読・タイマーを撤去 ${JSON.stringify(features)}`, () => {
    const h = createHarness();
    h.update(true, features);
    assert.ok(h.documentElement.classList.values.size > 0);
    h.invalidate();
    h.runIntervals();
    assert.equal(h.documentElement.classList.values.size, 0);
    assert.equal(h.article.classList.values.size, 0);
    assert.equal(h.listenerCount('play'), 0);
    assert.equal(h.intervalCount(), 0);
  });
}

test('Instagram cleaner: 初回設定時にcontext失効済みならURLタイマーを再作成しない', () => {
  const h = createHarness();
  h.invalidate();
  h.update(true, { reels: true });
  assert.equal(h.intervalCount(), 0);
  assert.equal(h.documentElement.classList.values.size, 0);
});

test('Instagram cleaner: 投稿外videoのplayはブロックしない', () => {
  const h = createHarness();
  h.update(true, { blockVideos: true });
  h.video.parentElement = new FakeElement('div');
  h.video.paused = false;
  h.fireDocument('play', h.video);
  assert.equal(h.video.paused, false);
});

test('Instagram cleaner CSS: 動画と未読バッジの隠蔽を契約範囲に限定する', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src/content/instagram-cleaner.css'), 'utf8');
  assert.match(css, /html\.__cpa-ig-block-videos article video\s*\{/);
  assert.doesNotMatch(css, /html\.__cpa-ig-block-videos video\s*\{/);
  const counters = css.split('\n').filter(line => line.startsWith('html.__cpa-ig-msg-counters'));
  assert.equal(counters.length, 3);
  for (const selector of counters) assert.ok(selector.includes('a[href="/direct/inbox/"] [aria-label'));
});

test('Instagram early: context失効時はobserver停止だけでなく先制非表示も復元する', () => {
  let callback;
  let disconnected = false;
  const classes = new FakeClassList();
  const styles = new Map();
  const attributes = new Map();
  const wrapper = {
    getAttribute: name => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
    style: {
      setProperty: (name, value) => styles.set(name, value),
      removeProperty: name => styles.delete(name),
    },
  };
  const document = {
    documentElement: { classList: classes },
    querySelectorAll: selector => selector === 'ul._a9ym' ? [{ parentElement: wrapper }] : [wrapper],
  };
  const window = {}; window.top = window;
  const chrome = { runtime: { id: 'test-extension' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src/content/instagram-early.js'), 'utf8'), {
    window, document, chrome, location: { pathname: '/' },
    MutationObserver: class {
      constructor(cb) { callback = cb; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    __cpaEarlyFramework: { setup(config) {
      config.onEvaluate({ instagramCleanerEnabled: true, instagramCleanerFeatures: { comments: true } });
    } },
  });
  assert.equal(styles.get('display'), 'none');
  assert.equal(classes.contains('__cpa-ig-comments-pre'), true);
  chrome.runtime.id = undefined;
  callback([]);
  assert.equal(disconnected, true);
  assert.equal(styles.has('display'), false);
  assert.equal(attributes.size, 0);
  assert.equal(classes.contains('__cpa-ig-comments-pre'), false);
});
