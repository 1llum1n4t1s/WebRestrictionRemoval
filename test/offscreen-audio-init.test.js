"use strict";
// offscreen.js の createAudioState が、AudioContext 生成後の失敗で資源を残さないことを検証する。
// release の順序契約は「track stop → ctx.close」。state 登録前の失敗では 30 秒のアイドル close まで
// AudioContext が生き続けるため、失敗経路でも同じ順序で解放する。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const G = require("./_load-actions");

const read = (name) => fs.readFileSync(path.join(__dirname, "../src", name), "utf8");
const STREAM_ID = "stream-id-for-test";

/** 任意のプロパティ参照・呼び出しを受け流す AudioNode / AudioParam の代用品。 */
const anyNode = () => {
  const props = { value: 0, connect: (next) => next, disconnect() {} };
  return new Proxy(function node() {}, {
    // 未定義のプロパティは入れ子の代用品を返す（gain.setValueAtTime など）。
    // then は thenable と誤認されないよう undefined にする。
    get: (t, key) => {
      if (key === "then" || typeof key === "symbol") return undefined;
      if (!(key in props)) props[key] = anyNode();
      return props[key];
    },
    set: (t, key, value) => { props[key] = value; return true; },
    apply: () => undefined,
  });
};

/**
 * offscreen.js を vm 上で評価する。
 * log には "track.stop" / "ctx.close" を発生順に記録する。
 * failOn は ctx の指定メソッドを失敗させる（AudioContext 生成後の構築失敗を再現）。
 */
const loadOffscreen = ({ failOn = null, deferStream = false } = {}) => {
  const log = [];
  const windowListeners = new Map();
  let releaseStream;
  const makeStream = () => {
    const track = { readyState: "live", stop() { log.push("track.stop"); }, addEventListener() {} };
    return { active: true, getTracks: () => [track], getAudioTracks: () => [track], addEventListener() {} };
  };
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.destination = anyNode();
      return new Proxy(this, {
        get: (t, key) => {
          if (key in t) return t[key];
          if (typeof key === "string" && key.startsWith("create")) {
            return () => {
              if (key === failOn) throw new Error(`${key} failed`);
              return anyNode();
            };
          }
          return undefined;
        },
        set: (t, key, value) => { t[key] = value; return true; },
      });
    }
    async close() {
      log.push("ctx.close");
      this.state = "closed";
    }
  }
  const context = vm.createContext({
    ...Object.fromEntries(["StorageKeys", "Actions", "Offscreen", "SenderCheck", "VolumeBooster", "ExtensionPaths"]
      .map((key) => [key, G[key]])),
    console: { ...console, warn() {} },
    window: { addEventListener: (type, fn) => windowListeners.set(type, fn) },
    navigator: {
      mediaDevices: {
        getUserMedia: () => (deferStream
          ? new Promise((resolve) => { releaseStream = () => resolve(makeStream()); })
          : Promise.resolve(makeStream())),
      },
    },
    AudioContext: FakeAudioContext,
    chrome: {
      runtime: {
        id: "test-extension",
        getURL: (p) => `chrome-extension://test-extension/${p}`,
        onMessage: { addListener() {} },
        sendMessage: () => Promise.resolve(),
      },
    },
  });
  vm.runInContext(read("lib/audio-pipeline.js"), context);
  vm.runInContext(read("offscreen/offscreen.js"), context);
  return {
    log,
    setGain: () => vm.runInContext(
      `volumeSetGain(5, ${JSON.stringify(STREAM_ID)}, 100, false, false, false, false, false, [], 0)`, context),
    pagehide: () => windowListeners.get("pagehide")({}),
    resolveStream: () => releaseStream(),
    activeCount: () => vm.runInContext("volumeQueryActive().activeCount", context),
  };
};

for (const failOn of ["createMediaStreamSource", "createDynamicsCompressor"]) {
  test(`offscreen: AudioContext 生成後に ${failOn} が失敗したら track stop → ctx.close の順で解放する`, async () => {
    const h = loadOffscreen({ failOn });
    const result = await h.setGain();
    assert.equal(result.ok, false);
    assert.deepEqual(h.log, ["track.stop", "ctx.close"]);
    assert.equal(h.activeCount(), 0);
  });
}

test("offscreen: 初期化中に pagehide が走った場合の既存解放は ctx.close を二重に呼ばない", async () => {
  const h = loadOffscreen({ deferStream: true });
  const pending = h.setGain();
  h.pagehide();
  h.resolveStream();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(h.log.filter((entry) => entry === "ctx.close").length, 1);
  assert.ok(h.log.indexOf("track.stop") < h.log.indexOf("ctx.close"));
});

test("offscreen: 正常な初期化では ctx を閉じず state を登録する", async () => {
  const h = loadOffscreen();
  const result = await h.setGain();
  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.deepEqual(h.log, []);
  assert.equal(h.activeCount(), 1);
});
