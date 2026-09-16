"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = path.join(__dirname, "..", "src", "content", "image-downloader.js");
const source = fs.readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
const exposeMarker = "  /**\n   * img → host 要素の cache 付き解決。";
const runtimeExposeMarker = "  // === 初期化 + storage / message 同期 ===";
assert.ok(source.includes(exposeMarker), "findHostEl の直後にテスト用 seam を挿入できること");
assert.ok(source.includes(runtimeExposeMarker), "初期化直前にテスト用 seam を挿入できること");

const instrumentedSource = source
  .replace(exposeMarker, "  globalThis.__testFindImageDownloadHost = findHostEl;\n\n" + exposeMarker)
  .replace(
    runtimeExposeMarker,
    "  globalThis.__testImageDownloader = { " +
      "decorateImage, detachOverlayForImage, scanAllImages, removeAllOverlays, applyState, " +
      "tiktokIsContentImage: adapters.tiktok.isContentImage };\n\n" +
      runtimeExposeMarker
  );

const createFindHostEl = () => {
  const window = {
    addEventListener() {},
  };
  window.top = window;

  const context = {
    window,
    location: { hostname: "www.tiktok.com" },
    ImageDownloader: {
      HOSTS: { TIKTOK: "tiktok", INSTAGRAM: "instagram" },
      detectHost: () => "tiktok",
    },
    StorageKeys: {
      INSTAGRAM_CLEANER_ENABLED: "instagramCleanerEnabled",
      INSTAGRAM_CLEANER_FEATURES: "instagramCleanerFeatures",
      TIKTOK_CLEANER_ENABLED: "tiktokCleanerEnabled",
      TIKTOK_CLEANER_FEATURES: "tiktokCleanerFeatures",
    },
    Actions: {
      APPLY_INSTAGRAM_CLEANER_CS: "APPLY_INSTAGRAM_CLEANER_CS",
      APPLY_TIKTOK_CLEANER_CS: "APPLY_TIKTOK_CLEANER_CS",
    },
    chrome: {
      storage: {
        local: { get() {} },
        onChanged: { addListener() {} },
      },
      runtime: { onMessage: { addListener() {} } },
    },
    SenderCheck: { isFromBackground: () => false },
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    URL,
    WeakMap,
    WeakSet,
  };
  vm.createContext(context);
  vm.runInContext(instrumentedSource, context, { filename: sourcePath });
  return context.__testFindImageDownloadHost;
};

const element = (tagName, parentElement = null) => {
  return { tagName, parentElement };
};

test("TikTok host: a > picture > img は a を避けて外側の安全な要素を使う", () => {
  const findHostEl = createFindHostEl();
  const card = element("DIV");
  const link = element("A", card);
  const picture = element("PICTURE", link);
  const img = element("IMG", picture);

  assert.equal(findHostEl(img), card);
});

test("TikTok host: a > span > picture > img は wrapper を連続して避ける", () => {
  const findHostEl = createFindHostEl();
  const card = element("SECTION");
  const link = element("A", card);
  const span = element("SPAN", link);
  const picture = element("PICTURE", span);
  const img = element("IMG", picture);

  assert.equal(findHostEl(img), card);
});

test("TikTok host: wrapper の外側が body/html だけなら広域 host を作らない", () => {
  const findHostEl = createFindHostEl();
  const html = element("HTML");
  const body = element("BODY", html);
  const link = element("A", body);
  const picture = element("PICTURE", link);
  const img = element("IMG", picture);

  assert.equal(findHostEl(img), null);
});

test("TikTok host: 直接の安全なコンテナは維持する", () => {
  const findHostEl = createFindHostEl();
  const container = element("DIV");
  const img = element("IMG", container);

  assert.equal(findHostEl(img), container);
});

const FakeClassList = class {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    names.forEach((name) => this.values.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }

  contains(name) {
    return this.values.has(name);
  }
};

const FakeElement = class {
  constructor(tagName, document, rect = { left: 0, top: 0, width: 300, height: 300 }) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
    this.parentElement = null;
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.attributes = new Map();
    this.isConnected = true;
    this.offsetParent = null;
    this.complete = true;
    this._rect = rect;
    document.elements.push(this);
  }

  set className(value) {
    this.classList = new FakeClassList();
    String(value).split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name));
  }

  get className() {
    return [...this.classList.values].join(" ");
  }

  appendChild(child) {
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
    }
    child.parentElement = this;
    child.offsetParent = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
    }
    this.parentElement = null;
    this.offsetParent = null;
    this.isConnected = false;
  }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  querySelector(selector) {
    if (selector.includes(".__cpa-img-dl-button")) {
      return this.children.find((child) => child.classList.contains("__cpa-img-dl-button")) || null;
    }
    if (selector === "img[data-cpa-img-dl-src]") {
      return this.ownerDocument.elements.find(
        (item) => this.contains(item) && item.dataset.cpaImgDlSrc !== undefined
      ) || null;
    }
    return null;
  }

  closest(selector) {
    if (selector.includes("feed-item") || selector.includes("user-post-item")) {
      return this._isContentImage ? this : null;
    }
    return null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type) {
    const event = {
      preventDefault() {},
      stopPropagation() {},
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getBoundingClientRect() {
    const { left, top, width, height } = this._rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  click() {
    this.emit("click");
  }
};

const createBehaviorHarness = () => {
  const document = {
    elements: [],
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    createElementNS(_namespace, tagName) {
      return new FakeElement(tagName, document);
    },
    querySelectorAll(selector) {
      if (selector === "img") {
        return document.elements.filter((el) => el.isConnected && el.tagName === "IMG");
      }
      if (selector.startsWith(":is(")) {
        return document.elements.filter(
          (el) =>
            el.isConnected &&
            (el.classList.contains("__cpa-img-dl-button") ||
              el.classList.contains("__cpa-img-dl-host") ||
              el.classList.contains("__cpa-img-dl-host-positioned") ||
              el.dataset.cpaImgDlSrc !== undefined)
        );
      }
      return [];
    },
  };
  document.documentElement = new FakeElement("html", document);
  document.body = new FakeElement("body", document);
  document.documentElement.appendChild(document.body);

  const window = { addEventListener() {} };
  window.top = window;
  const fetchCalls = [];
  const FakeMutationObserver = class {
    observe() {}
    disconnect() {}
  };
  const ImageDownloader = {
    HOSTS: { TIKTOK: "tiktok", INSTAGRAM: "instagram" },
    MIN_SIZE_PX: 200,
    BUTTON_CLASS: "__cpa-img-dl-button",
    HOST_CLASS: "__cpa-img-dl-host",
    BUSY_CLASS: "__cpa-img-dl-busy",
    HOST_POSITIONED_CLASS: "__cpa-img-dl-host-positioned",
    SCANNED_SRC_DATASET_KEY: "cpaImgDlSrc",
    SCANNED_SRC_ATTR_SELECTOR: "img[data-cpa-img-dl-src]",
    SKIP_MARKER: "__cpa-skip__",
    detectHost: () => "tiktok",
    isAllowedFetchUrl: () => true,
    buildFilename: () => "tiktok.jpg",
  };
  const context = {
    window,
    document,
    location: { hostname: "www.tiktok.com" },
    ImageDownloader,
    StorageKeys: {
      INSTAGRAM_CLEANER_ENABLED: "instagramCleanerEnabled",
      INSTAGRAM_CLEANER_FEATURES: "instagramCleanerFeatures",
      TIKTOK_CLEANER_ENABLED: "tiktokCleanerEnabled",
      TIKTOK_CLEANER_FEATURES: "tiktokCleanerFeatures",
    },
    Actions: {
      APPLY_INSTAGRAM_CLEANER_CS: "APPLY_INSTAGRAM_CLEANER_CS",
      APPLY_TIKTOK_CLEANER_CS: "APPLY_TIKTOK_CLEANER_CS",
    },
    chrome: {
      i18n: { getMessage: () => "画像をダウンロード" },
      storage: {
        local: { get() {} },
        onChanged: { addListener() {} },
      },
      runtime: { id: "test-extension", onMessage: { addListener() {} } },
    },
    SenderCheck: { isFromBackground: () => false },
    MutationObserver: FakeMutationObserver,
    getComputedStyle: (el) => ({
      position: el._position || "static",
      display: el._display || "block",
      visibility: "visible",
      opacity: "1",
    }),
    fetch: async (url) => {
      fetchCalls.push(url);
      return {
        type: "basic",
        ok: true,
        status: 200,
        blob: async () => new Blob([url], { type: "image/jpeg" }),
      };
    },
    URL: {
      createObjectURL: () => "blob:test",
      revokeObjectURL() {},
    },
    console,
    setTimeout: () => 1,
    clearTimeout() {},
    AbortController,
    AbortSignal,
    Blob,
    WeakMap,
    WeakSet,
  };
  vm.createContext(context);
  vm.runInContext(instrumentedSource, context, { filename: sourcePath });
  context.__testImageDownloader.applyState({
    tiktokCleanerEnabled: true,
    tiktokCleanerFeatures: { imageDownload: true },
  });
  return { context, document, fetchCalls, ImageDownloader };
};

test("TikTok content判定: 現行photo modalを通し、avatar/buttonは除外する", () => {
  const { context } = createBehaviorHarness();
  const classify = context.__testImageDownloader.tiktokIsContentImage;
  const image = (flags = {}) => ({
    closest(selector) {
      if (selector.includes("avatar") || selector.includes("Avatar")) return flags.avatar ? {} : null;
      if (selector.includes("button")) return flags.button ? {} : null;
      if (selector.includes("DivPhotoVideoContainer")) return flags.photoModal ? {} : null;
      return null;
    },
  });

  assert.equal(classify(image({ photoModal: true })), true);
  assert.equal(classify(image({ photoModal: true, avatar: true })), false);
  assert.equal(classify(image({ photoModal: true, button: true })), false);
});

test("共有hostの各画像が固有button・URL・位置を保持し、detach/OFFも所有単位で掃除する", async () => {
  const { context, document, fetchCalls, ImageDownloader } = createBehaviorHarness();
  const host = new FakeElement("div", document, { left: 0, top: 0, width: 500, height: 300 });
  const first = new FakeElement("img", document, { left: 10, top: 20, width: 200, height: 240 });
  const second = new FakeElement("img", document, { left: 260, top: 20, width: 200, height: 240 });
  first._isContentImage = true;
  second._isContentImage = true;
  first.currentSrc = "https://p16-sign.tiktokcdn.com/first.jpg";
  second.currentSrc = "https://p16-sign.tiktokcdn.com/second.jpg";
  first.naturalWidth = second.naturalWidth = 400;
  first.naturalHeight = second.naturalHeight = 480;
  first.width = second.width = 200;
  first.height = second.height = 240;
  first.clientWidth = second.clientWidth = 200;
  first.clientHeight = second.clientHeight = 240;
  host.appendChild(first);
  host.appendChild(second);

  const api = context.__testImageDownloader;
  api.decorateImage(first);
  api.decorateImage(second);
  api.decorateImage(first);
  api.decorateImage(second);

  const buttons = host.children.filter((el) => el.classList.contains(ImageDownloader.BUTTON_CLASS));
  assert.equal(buttons.length, 2, "再走査しても画像ごとにbuttonが1つずつ存在する");
  assert.equal(buttons[0].style.left, "34px");
  assert.equal(buttons[1].style.left, "284px");
  assert.equal(host.classList.contains(ImageDownloader.HOST_CLASS), true);

  buttons[0].emit("click");
  await new Promise((resolve) => setImmediate(resolve));
  buttons[1].emit("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetchCalls, [first.currentSrc, second.currentSrc]);

  second._display = "none";
  api.decorateImage(second);
  assert.equal(buttons[1].isConnected, false, "非表示slideの古いbuttonを撤去する");
  assert.equal(buttons[0].parentElement, host, "片方の非表示化で別画像のbuttonを消さない");
  assert.equal(host.classList.contains(ImageDownloader.HOST_CLASS), true);

  second._display = "block";
  api.decorateImage(second);
  let currentButtons = host.children.filter((el) => el.classList.contains(ImageDownloader.BUTTON_CLASS));
  assert.equal(currentButtons.length, 2, "同じsrcのslideが再表示されたらbuttonを再構築する");

  first.remove();
  api.scanAllImages();
  assert.equal(buttons[0].isConnected, false, "DOMから消えた画像のbuttonを次回scanで撤去する");
  currentButtons = host.children.filter((el) => el.classList.contains(ImageDownloader.BUTTON_CLASS));
  assert.equal(currentButtons.length, 1);
  assert.equal(host.classList.contains(ImageDownloader.HOST_CLASS), true);

  api.applyState({
    tiktokCleanerEnabled: false,
    tiktokCleanerFeatures: { imageDownload: true },
  });
  assert.equal(
    host.children.some((el) => el.classList.contains(ImageDownloader.BUTTON_CLASS)),
    false
  );
  assert.equal(host.classList.contains(ImageDownloader.HOST_CLASS), false);
  assert.equal(first.dataset.cpaImgDlSrc, undefined);
  assert.equal(second.dataset.cpaImgDlSrc, undefined);
});
