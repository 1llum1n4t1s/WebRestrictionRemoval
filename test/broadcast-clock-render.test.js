"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { BroadcastClock } = require("./_load-actions");

const source = fs.readFileSync(path.join(__dirname, "../src/content/youtube-broadcast-clock.js"), "utf8");
const START_MS = Date.UTC(2025, 2, 14, 12, 0, 0);

// 状態と描画まわり（間引き・追従描画・撤去）だけを本番ソースから実行し、時刻と rAF / タイマーを手で進める。
const createClock = () => {
  const frames = new Map();
  const timers = new Map();
  let nextId = 0;
  let now = 0;
  const context = vm.createContext({
    BroadcastClock,
    window: { __cpaYouTubeOverlay: { remove() {} } },
    performance: { now: () => now },
    requestAnimationFrame(callback) { frames.set(++nextId, callback); return nextId; },
    setTimeout(callback, delay) { timers.set(++nextId, { callback, delay }); return nextId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const section = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `本番ソースに区間がある: ${start}`);
    return source.slice(from, to);
  };
  vm.runInContext(section("  // ---------- 状態 ----------", "  // ---------- ユーティリティ ----------"), context);
  vm.runInContext(section("  function removeOverlay()", "  // ---------- video イベント listener ----------"), context);
  const run = (code) => vm.runInContext(code, context);
  run(`overlayEl = {}; overlayTimeEl = { textContent: "" }; trackedVideo = { currentTime: 0 };
    broadcastInfo = { startMs: ${START_MS} };`);
  const flushFrames = () => {
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
  };
  return {
    run, frames, timers, flushFrames,
    advance(ms) { now += ms; },
    // 予約済みタイマーを予約時の遅延だけ時間を進めて発火する（自己再予約も有限回で止まる）。
    flushTimers() {
      for (let steps = 0; timers.size; steps++) {
        assert.ok(steps < 10, "追従描画の予約が有限回で止まる");
        const [id, { callback, delay }] = timers.entries().next().value;
        timers.delete(id);
        now += delay;
        callback();
      }
    },
    get text() { return run("overlayTimeEl ? overlayTimeEl.textContent : null"); },
    setCurrentTime(seconds) { run(`trackedVideo.currentTime = ${seconds}`); },
  };
};

const expected = (seconds) => BroadcastClock.formatTimestamp(START_MS + seconds * 1000).replace(/　/g, "  ");

test("配信時刻: 間引き中の最後の更新を追従描画し、一時停止直前の再生位置を表示する", () => {
  const clock = createClock();
  clock.advance(1000);
  clock.setCurrentTime(10);
  clock.run("scheduleRender()");
  clock.flushFrames();
  assert.equal(clock.text, expected(10));

  // 250ms 以内に届いた最後の timeupdate（直後に一時停止して後続イベントが来ない）を捨てない。
  clock.advance(100);
  clock.setCurrentTime(11.5);
  clock.run("scheduleRender(); scheduleRender();");
  assert.equal(clock.frames.size, 0, "間引き中は即時描画しない");
  assert.equal(clock.timers.size, 1, "追従描画は1件だけ予約する");
  clock.flushTimers();
  clock.flushFrames();
  assert.equal(clock.text, expected(11.5));
});

test("配信時刻: 撤去時に追従描画の予約を取り消し、撤去後に描画しない", () => {
  const clock = createClock();
  clock.advance(1000);
  clock.run("scheduleRender()");
  clock.flushFrames();
  clock.advance(50);
  clock.run("scheduleRender()");
  assert.equal(clock.timers.size, 1);
  clock.run("removeOverlay()");
  assert.equal(clock.timers.size, 0, "撤去で予約を取り消す");
  assert.equal(clock.text, null, "撤去後は表示先を持たない");
});
