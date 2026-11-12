"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { StorageKeys, VideoGamma, VideoFill, Actions, SenderCheck } = require("./_load-actions");

const fixture = (kind) => {
  const prefix = kind === "gamma" ? "VIDEO_GAMMA" : "VIDEO_FILL";
  const property = kind === "gamma" ? "filter" : "transform";
  const values = new Map([[property, ["original", "important"]], ["transform-origin", ["left top", ""]]]);
  const listeners = [];
  const video = { nodeType: 1, tagName: "VIDEO", isConnected: true, readyState: 1,
    videoWidth: 1920, videoHeight: 1080,
    style: { getPropertyValue: (k) => values.get(k)?.[0] || "",
      getPropertyPriority: (k) => values.get(k)?.[1] || "",
      setProperty: (k, v, p) => values.set(k, [v, p]), removeProperty: (k) => values.delete(k) },
    addEventListener: (name, fn, options) => listeners.push({ name, fn, signal: options.signal }) };
  let resolveInitial, change, scans = 0, controllers = 0, observer, raf, host;
  const events = {};
  const chrome = { runtime: { id: "extension", onMessage: { addListener() {} } },
    storage: { local: { get: () => new Promise((resolve) => { resolveInitial = resolve; }) },
      onChanged: { addListener: (fn) => { change = fn; } } } };
  const document = { documentElement: {}, body: { appendChild: (el) => { host = el; } },
    getElementsByTagName: () => { scans++; return video.isConnected ? [video] : []; },
    getElementById: () => host,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, replaceChildren() {}, remove() { host = null; } }),
    importNode: (node) => node };
  const context = vm.createContext({ window: { addEventListener: (name, fn) => { events[name] = fn; } },
    document, chrome, StorageKeys, VideoGamma, VideoFill, Actions, SenderCheck,
    DOMParser: class { parseFromString() { return { documentElement: {} }; } },
    AbortController: class extends AbortController { constructor() { super(); controllers++; } },
    MutationObserver: class { constructor(fn) { observer = this; this.callback = fn; } observe() { this.connected = true; } disconnect() { this.connected = false; } },
    requestAnimationFrame: (fn) => { raf = fn; return 1; }, cancelAnimationFrame: () => { raf = null; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, `../src/content/video-${kind}.js`), "utf8"), context);
  return { video, values, chrome, property, events,
    initial: async (data = {}) => { resolveInitial(data); await Promise.resolve(); await Promise.resolve(); },
    patch(data) { change(Object.fromEntries(Object.entries(data).map(([k, newValue]) => [k, { newValue }])), "local"); },
    settings(enabled) { return { [StorageKeys[`${prefix}_ENABLED`]]: enabled,
      ...(kind === "gamma" ? { [StorageKeys.VIDEO_GAMMA_VALUE]: 1.5 } : { [StorageKeys.VIDEO_FILL_TARGET]: "21:9" }) }; },
    mutate(removedNodes = []) { observer.callback([{ removedNodes }]); if (raf) { const fn = raf; raf = null; fn(); } },
    metadata() { for (const l of listeners) if (!l.signal.aborted) l.fn(); },
    get scans() { return scans; }, get controllers() { return controllers; }, get host() { return host; },
    get observed() { return observer?.connected === true; } };
};

for (const kind of ["gamma", "fill"]) {
  test(`${kind}: OFF は動画に触れず、ON/OFF・再ONで元のinlineを保つ`, async () => {
    const f = fixture(kind);
    await f.initial();
    f.patch(f.settings(false));
    assert.equal(f.scans, 0);
    assert.equal(f.controllers, 0);
    f.patch(f.settings(true));
    assert.notEqual(f.values.get(f.property)[0], "original");
    assert.ok(f.observed);
    f.patch(f.settings(false));
    assert.deepEqual(f.values.get(f.property), ["original", "important"]);
    assert.deepEqual(f.values.get("transform-origin"), ["left top", ""]);
    assert.equal(f.observed, false);
    if (kind === "gamma") assert.equal(f.host, null);
    f.patch(f.settings(true));
    assert.notEqual(f.values.get(f.property)[0], "original");
    f.video.isConnected = false;
    f.mutate([f.video]);
    assert.equal(f.values.get(f.property)[0], "original");
    f.video.isConnected = true;
    f.mutate();
    assert.notEqual(f.values.get(f.property)[0], "original");
    f.events.pagehide({ persisted: true });
    assert.ok(f.observed);
    f.events.pagehide({ persisted: false });
    assert.equal(f.values.get(f.property)[0], "original");
    assert.equal(f.observed, false);
  });

  test(`${kind}: 新しいOFF通知を初期取得で戻さず、metadata待機を解除する`, async () => {
    const f = fixture(kind);
    f.patch(f.settings(false));
    await f.initial(f.settings(true));
    assert.equal(f.scans, 0);
    f.video.readyState = 0;
    f.video.videoWidth = 0;
    f.patch(f.settings(true));
    assert.equal(f.values.get(f.property)[0], "original");
    f.patch(f.settings(false));
    f.video.readyState = 1;
    f.video.videoWidth = 1920;
    f.metadata();
    assert.equal(f.values.get(f.property)[0], "original");
    f.patch(f.settings(true));
    assert.notEqual(f.values.get(f.property)[0], "original");
    f.chrome.runtime.id = undefined;
    f.mutate();
    assert.equal(f.values.get(f.property)[0], "original");
    assert.equal(f.observed, false);
    if (kind === "gamma") assert.equal(f.host, null);
  });
}
