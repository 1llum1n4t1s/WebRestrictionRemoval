"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const G = require("./_load-actions.js");

class FakeClassList {
  constructor(owner) { this.owner = owner; this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this.classList = new FakeClassList(this);
    this.isConnected = true;
    this.hidden = false;
    this.editable = false;
    this.dialog = false;
    this.rect = { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 };
  }
  set className(value) {
    this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get className() { return [...this.classList.values].join(" "); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      child.isConnected = true;
      this.children.push(child);
    }
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
    this.isConnected = false;
  }
  closest(selector) {
    if (selector === "article") return this.tagName === "ARTICLE" ? this : this.parentElement?.closest(selector) ?? null;
    if (selector === '[role="dialog"]') return this.dialog ? this : this.parentElement?.closest(selector) ?? null;
    if (selector === '[hidden], [aria-hidden="true"]') return null;
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      for (let node = this; node; node = node.parentElement) {
        if (node.classList.contains(className)) return node;
      }
      return null;
    }
    if (selector.includes("input") && this.editable) return this;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '[role="group"][aria-label]') return this.children.flatMap((child) => [
      ...(child.getAttribute("role") === "group" && child.getAttribute("aria-label") ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
    if (selector.startsWith(":scope > .")) {
      const className = selector.slice(10);
      return this.children.filter((child) => child.classList.contains(className));
    }
    return [];
  }
  querySelector(selector) {
    if (selector === "video") {
      for (const child of this.children) {
        if (child.tagName === "VIDEO") return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
    if (!selector.startsWith(".")) return null;
    const className = selector.slice(1);
    return this.children.find((child) => child.classList.contains(className)) ?? null;
  }
  getBoundingClientRect() { return this.rect; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  addEventListener() {}
  removeEventListener() {}
}

class FakeVideo extends FakeElement {
  constructor() {
    super("video");
    this.duration = 120;
    this.currentTime = 10;
    this.paused = false;
    this.ended = false;
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
}

const createHarness = () => {
  const windowListeners = new Map();
  const frames = [];
  let subscription = null;
  let observerDisconnected = false;
  const parent = new FakeElement();
  const video = new FakeVideo();
  parent.append(video);
  const documentElement = new FakeElement("html");
  const body = new FakeElement("body");
  documentElement.append(body);
  body.append(parent);

  const document = {
    documentElement,
    body,
    querySelectorAll: (selector) => selector === "video" ? [video] : [],
    createElement: (tagName) => {
      const element = new FakeElement(tagName);
      if (tagName === "input") {
        element.type = "";
        element.min = "";
        element.max = "";
        element.step = "";
        element.value = "";
      }
      element.textContent = "";
      return element;
    },
  };
  const window = {
    top: null,
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter((item) => item !== listener));
    },
  };
  window.top = window;

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() { observerDisconnected = true; }
  }
  const context = vm.createContext({
    window,
    document,
    Element: FakeElement,
    MutationObserver: FakeMutationObserver,
    CleanerCore: { subscribe(config) { subscription = config; } },
    InstagramCleaner: G.InstagramCleaner,
    StorageKeys: G.StorageKeys,
    Actions: G.Actions,
    chrome: { runtime: { id: "extension-id" }, i18n: { getMessage: () => "" } },
    innerWidth: 1280,
    innerHeight: 720,
    getComputedStyle: (element) => ({ display: "block", visibility: "visible", opacity: "1", position: element.position || "relative" }),
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
    setInterval: () => 1,
    clearInterval() {},
  });
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "instagram-video-controls.js"),
    "utf8"
  );
  vm.runInContext(source, context);

  const flushFrame = () => {
    const callback = frames.shift();
    if (callback) callback();
  };
  const fireKey = (type, overrides = {}) => {
    const event = {
      key: " ", code: "Space", target: new FakeElement("div"), repeat: false,
      isComposing: false, ctrlKey: false, altKey: false, metaKey: false,
      defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.propagationStopped = true; },
      ...overrides,
    };
    for (const listener of windowListeners.get(type) ?? []) listener(event);
    return event;
  };
  return {
    parent, video, windowListeners, flushFrame, fireKey,
    enable(extraFeatures = {}) {
      subscription.onUpdate({
        active: true,
        features: G.InstagramCleaner.mergeFeatures({ videoControls: true, ...extraFeatures }),
      });
      flushFrame();
    },
    disable() { subscription.onUpdate({ active: false }); },
    observerDisconnected: () => observerDisconnected,
  };
};

test("Instagram video controls: Space の down/up を抑止して再生を切り替える", () => {
  const h = createHarness();
  h.enable();
  assert.equal(h.windowListeners.get("keydown").length, 1);
  assert.ok(h.parent.children.some((child) => child.classList.contains(G.InstagramCleaner.VIDEO_CONTROL_CLASS)));

  const down = h.fireKey("keydown");
  assert.equal(h.video.paused, true);
  assert.equal(down.defaultPrevented, true);
  assert.equal(down.propagationStopped, true);
  const up = h.fireKey("keyup");
  assert.equal(up.defaultPrevented, true);
  assert.equal(up.propagationStopped, true);

  h.fireKey("keydown");
  assert.equal(h.video.paused, false);
});

test("Instagram video controls: 編集欄・修飾キーは素通しし、repeat は連続反転しない", () => {
  const h = createHarness();
  h.enable();
  const editable = new FakeElement("textarea");
  editable.editable = true;
  const editEvent = h.fireKey("keydown", { target: editable });
  assert.equal(editEvent.defaultPrevented, false);
  assert.equal(h.video.paused, false);

  const modified = h.fireKey("keydown", { ctrlKey: true });
  assert.equal(modified.defaultPrevented, false);
  assert.equal(h.video.paused, false);

  const repeat = h.fireKey("keydown", { repeat: true });
  assert.equal(repeat.defaultPrevented, true);
  assert.equal(h.video.paused, false);
});

test("Instagram video controls: OFF でキー購読・挿入 DOM・親クラス・observer を撤去する", () => {
  const h = createHarness();
  h.enable();
  h.disable();
  assert.equal(h.windowListeners.get("keydown").length, 0);
  assert.equal(h.windowListeners.get("keyup").length, 0);
  assert.equal(h.parent.querySelector("." + G.InstagramCleaner.VIDEO_CONTROL_CLASS), null);
  assert.equal(h.parent.classList.contains(G.InstagramCleaner.VIDEO_CONTROL_PARENT_CLASS), false);
  assert.equal(h.observerDisconnected(), true);
});

for (const label of ['Video player', '動画プレーヤー', 'Lecteur vidéo', 'Videoplayer']) {
  test(`Instagram video controls: ${label} の絶対配置 overlay を使う`, () => {
    const h = createHarness();
    const overlay = new FakeElement();
    overlay.setAttribute('role', 'group');
    overlay.setAttribute('aria-label', label);
    overlay.position = 'absolute';
    h.parent.append(overlay);
    h.enable();
    assert.ok(overlay.querySelector('.' + G.InstagramCleaner.VIDEO_CONTROL_CLASS));
    h.disable();
    assert.equal(overlay.children.length, 0);
  });
}

test('Instagram video controls: 寸法が異なる group は配置先にしない', () => {
  const h = createHarness();
  const unrelated = new FakeElement();
  unrelated.setAttribute('role', 'group');
  unrelated.setAttribute('aria-label', 'Other controls');
  unrelated.position = 'absolute';
  unrelated.rect = { ...unrelated.rect, width: 100 };
  h.parent.append(unrelated);
  h.enable();
  assert.equal(unrelated.children.length, 0);
  assert.ok(h.parent.querySelector('.' + G.InstagramCleaner.VIDEO_CONTROL_CLASS));
});

test('Instagram video controls: 投稿動画ブロック中はシークバーと Space 操作を無効にする', () => {
  const h = createHarness();
  h.parent.tagName = 'ARTICLE';
  h.enable();
  assert.ok(h.parent.querySelector('.' + G.InstagramCleaner.VIDEO_CONTROL_CLASS));
  h.enable({ blockVideos: true });
  assert.equal(h.parent.querySelector('.' + G.InstagramCleaner.VIDEO_CONTROL_CLASS), null);
  h.video.paused = true;
  assert.equal(h.fireKey('keydown').defaultPrevented, false);
  assert.equal(h.video.paused, true);
  h.enable({ blockVideos: false });
  assert.ok(h.parent.querySelector('.' + G.InstagramCleaner.VIDEO_CONTROL_CLASS));
});

test('Instagram video controls: 別の動画を含む group は配置先にしない', () => {
  const h = createHarness();
  const otherPlayer = new FakeElement();
  otherPlayer.setAttribute('role', 'group');
  otherPlayer.setAttribute('aria-label', 'Video player');
  otherPlayer.position = 'absolute';
  otherPlayer.append(new FakeVideo());
  h.parent.append(otherPlayer);
  h.enable();
  assert.equal(otherPlayer.querySelector('.' + G.InstagramCleaner.VIDEO_CONTROL_CLASS), null);
  assert.ok(h.parent.querySelector('.' + G.InstagramCleaner.VIDEO_CONTROL_CLASS));
});
