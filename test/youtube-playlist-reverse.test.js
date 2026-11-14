"use strict";
// 再生リスト逆順再生のページ側（MAIN world）アダプターの判定を、YouTube の移動イベントを模して検証する。
// 実機で確認した YouTube の挙動を前提にしている:
//   - 自動の次へ・次へ / 前へボタン・Shift+N/P は yt-playlist-manager が yt-navigate（watchEndpoint.index）を発火する
//   - 最後の動画の終了時は移動が起きず、最後の動画で次へを押すと ytd-watch-flexy がリスト外の動画へ移る
//   - playVideoAt で自分が起こした移動も yt-playlist-manager から届く
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "../src/content/youtube-playlist-reverse-main.js"), "utf8");
const CHANNEL = "__cpa_youtube_playlist_reverse_v1";
const ORIGIN = "https://www.youtube.com";
const LIST = "PLtest_list-01";
const SESSION = "11111111-2222-3333-4444-555555555555";

const load = ({ index = 5, length = 10, loop = "PLAYLIST_LOOP_STATE_NONE", shuffle = false, ad = false } = {}) => {
  const listeners = new Map();
  const timers = [];
  const clock = { now: 1_000_000 };
  const removed = [];
  const unclassed = [];
  class HTMLVideoElement {}
  const video = new HTMLVideoElement();
  const playlist = Array.from({ length }, (_, i) => `video${String(i).padStart(6, "0")}`);
  const player = {
    index,
    played: [],
    classList: { contains: (name) => ad && name === "ad-showing" },
    contains: (node) => node === video,
    getPlaylistId: () => LIST,
    getPlaylistIndex() { return this.index; },
    getPlaylist: () => playlist,
    getVideoData() { return { video_id: playlist[this.index] }; },
    getPlayerState: () => 1,
    playVideoAt(target) { this.played.push(target); },
  };
  const manager = { playlistLoopStateEntity_: { state: loop } };
  const uiElement = { remove() { removed.push(this); } };
  const panel = { classList: { remove(name) { unclassed.push(name); } } };
  const document = {
    getElementById: (id) => (id === "movie_player" ? player : null),
    querySelector: (selector) => {
      if (selector === "yt-playlist-manager") return manager;
      if (selector.includes('aria-pressed="true"')) return shuffle ? {} : null;
      return null;
    },
    querySelectorAll: (selector) => (selector.includes("__cpa-ypr-reversed") ? [panel] : [uiElement]),
  };
  const window = {
    document,
    location: { origin: ORIGIN },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    postMessage() {},
    HTMLVideoElement,
    JSON,
    Array,
    Number,
    setTimeout: (fn, delay = 0) => { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    Date: { now: () => clock.now },
  };
  window.window = window;
  window.top = window;
  window.location.origin = ORIGIN;
  const context = vm.createContext(window);
  vm.runInContext(SOURCE, context);
  // vm 内の `window` はグローバルプロキシなので、postMessage の送信元にはそれを渡す。
  const self = vm.runInContext("window", context);

  const emit = (type, event) => { for (const fn of listeners.get(type) ?? []) fn(event); };
  return {
    player, video, clock, removed, unclassed,
    /** isolated world からの状態通知（heartbeat を兼ねる） */
    state(listId = LIST, extra = {}) {
      emit("message", { source: self, origin: ORIGIN, data: JSON.stringify({ channel: CHANNEL, session: SESSION, type: "state", listId, ...extra }) });
    },
    message(event) { emit("message", { source: self, origin: ORIGIN, ...event }); },
    /** yt-navigate を発火し、止められたかを返す */
    navigate(tagName, watchEndpoint) {
      const event = {
        target: { tagName },
        detail: { endpoint: { watchEndpoint } },
        stopped: false,
        stopImmediatePropagation() { this.stopped = true; },
        preventDefault() {},
      };
      emit("yt-navigate", event);
      return event.stopped;
    },
    ended() { emit("ended", { target: video }); },
    click(target) { emit("click", { target }); },
    /** setTimeout(0) で予約した移動を実行する（待機タイマーは実行しない） */
    flush() {
      const due = timers.filter((timer) => timer.delay === 0);
      timers.splice(0, timers.length, ...timers.filter((timer) => timer.delay !== 0));
      for (const timer of due) timer.fn();
    },
  };
};

const manager = (index) => ({ playlistId: LIST, index });

test("途中の動画の終了で 1 つ前へ移り、YouTube の自動の次へは止める", () => {
  const h = load({ index: 5 });
  h.state();
  h.ended();
  // YouTube が続けて起こす順方向の移動（index 6）は止める。
  assert.equal(h.navigate("YT-PLAYLIST-MANAGER", manager(6)), true);
  h.flush();
  assert.deepEqual(h.player.played, [4]);
  // 自分で起こした移動（index 4）は 1 回だけ通す。
  assert.equal(h.navigate("YT-PLAYLIST-MANAGER", manager(4)), false);
});

test("1 本の終了で移動は 1 回だけ（ended が重なっても再度移さない）", () => {
  const h = load({ index: 5 });
  h.state();
  h.ended();
  h.ended();
  h.flush();
  h.flush();
  assert.deepEqual(h.player.played, [4]);
});

test("次へ（index +1）と前へ（index -1）を逆向きへ入れ替える", () => {
  const next = load({ index: 5 });
  next.state();
  assert.equal(next.navigate("YT-PLAYLIST-MANAGER", manager(6)), true);
  next.flush();
  assert.deepEqual(next.player.played, [4]);

  const prev = load({ index: 5 });
  prev.state();
  assert.equal(prev.navigate("YT-PLAYLIST-MANAGER", manager(4)), true);
  prev.flush();
  assert.deepEqual(prev.player.played, [6]);
});

test("最後の動画（逆順の開始位置）の終了で 1 つ前へ移る", () => {
  const h = load({ index: 9, length: 10 });
  h.state();
  h.ended();
  h.flush();
  assert.deepEqual(h.player.played, [8]);
});

test("最後の動画で次へを押したときのリスト外への移動を、1 つ前への移動に置き換える", () => {
  const h = load({ index: 9, length: 10 });
  h.state();
  h.click({ closest: (selector) => (selector === ".ytp-next-button" ? {} : null) });
  assert.equal(h.navigate("YTD-WATCH-FLEXY", { videoId: "outside0000" }), true);
  h.flush();
  assert.deepEqual(h.player.played, [8]);
});

test("次へを押していないリスト外への移動と、最後以外の位置からの移動はそのまま通す", () => {
  const last = load({ index: 9, length: 10 });
  last.state();
  assert.equal(last.navigate("YTD-WATCH-FLEXY", { videoId: "outside0000" }), false);
  const middle = load({ index: 5 });
  middle.state();
  middle.click({ closest: () => ({}) });
  assert.equal(middle.navigate("YTD-WATCH-FLEXY", { videoId: "outside0000" }), false);
  assert.deepEqual([...last.player.played, ...middle.player.played], []);
});

test("逆順の終わり（先頭の動画）では止まり、ループ時だけ最後へ折り返す", () => {
  const stop = load({ index: 0 });
  stop.state();
  stop.ended();
  assert.equal(stop.navigate("YT-PLAYLIST-MANAGER", manager(1)), true, "YouTube の順方向の移動は止める");
  stop.flush();
  assert.deepEqual(stop.player.played, []);

  const loop = load({ index: 0, length: 10, loop: "PLAYLIST_LOOP_STATE_ALL" });
  loop.state();
  loop.ended();
  loop.flush();
  assert.deepEqual(loop.player.played, [9]);
});

test("ループ時の YouTube の折り返し（最後 → 先頭）も順方向として逆へ入れ替える", () => {
  const h = load({ index: 9, length: 10, loop: "PLAYLIST_LOOP_STATE_ALL" });
  h.state();
  assert.equal(h.navigate("YT-PLAYLIST-MANAGER", manager(0)), true);
  h.flush();
  assert.deepEqual(h.player.played, [8]);
});

test("一覧のクリック・別の再生リスト・シャッフル・1 曲ループ・広告はそのまま通す", () => {
  const panel = load();
  panel.state();
  assert.equal(panel.navigate("YTD-PLAYLIST-PANEL-VIDEO-RENDERER", manager(6)), false);

  const other = load();
  other.state("PLother");
  assert.equal(other.navigate("YT-PLAYLIST-MANAGER", manager(6)), false);

  const shuffle = load({ shuffle: true });
  shuffle.state();
  assert.equal(shuffle.navigate("YT-PLAYLIST-MANAGER", manager(6)), false);
  shuffle.ended();

  const one = load({ loop: "PLAYLIST_LOOP_STATE_ONE" });
  one.state();
  assert.equal(one.navigate("YT-PLAYLIST-MANAGER", manager(6)), false);
  one.ended();

  const ad = load({ ad: true });
  ad.state();
  ad.ended();
  for (const h of [panel, other, shuffle, one, ad]) h.flush();
  assert.deepEqual([...shuffle.player.played, ...one.player.played, ...ad.player.played], []);
});

test("一覧で隣の動画を選んだとき、続く再生リスト管理の同じ移動を逆向きに入れ替えない", () => {
  for (const picked of [4, 6]) {
    const h = load({ index: 5 });
    h.state();
    // YouTube は一覧の要素、続けて再生リスト管理から同じ index の移動を発火する。
    assert.equal(h.navigate("YTD-PLAYLIST-PANEL-VIDEO-RENDERER", manager(picked)), false);
    assert.equal(h.navigate("YT-PLAYLIST-MANAGER", manager(picked)), false, `index ${picked} をそのまま通す`);
    h.flush();
    assert.deepEqual(h.player.played, []);
    // 通過は 1 回だけ。以後の同じ向きの移動は通常どおり入れ替える。
    assert.equal(h.navigate("YT-PLAYLIST-MANAGER", manager(picked)), true);
  }
});

test("移動に成功したあと元の動画へ戻っても、古いラッチで終了・次へが止まらない", () => {
  const h = load({ index: 5 });
  h.state();
  h.ended();
  h.flush(); // 動画 5 → 4 へ移す（ラッチは動画 5）
  h.player.index = 4;
  assert.equal(h.navigate("YT-PLAYLIST-MANAGER", manager(4)), false, "自分で起こした移動は通す");
  // 戻る等で動画 5 へ戻り、もう一度終了。ラッチは解けていて、また 1 つ前へ移す。
  h.player.index = 5;
  h.ended();
  h.flush();
  assert.deepEqual(h.player.played, [4, 4]);
  // 次へも止まらず入れ替える。
  assert.equal(h.navigate("YT-PLAYLIST-MANAGER", manager(6)), true);
});

test("逆順の通知がない・解除（listId null）・停止通知の後は横取りしない", () => {
  const none = load();
  assert.equal(none.navigate("YT-PLAYLIST-MANAGER", manager(6)), false);

  const off = load();
  off.state();
  off.state(null);
  assert.equal(off.navigate("YT-PLAYLIST-MANAGER", manager(6)), false);

  const stopped = load();
  stopped.state();
  stopped.message({ data: JSON.stringify({ channel: CHANNEL, session: SESSION, type: "stop" }) });
  assert.equal(stopped.navigate("YT-PLAYLIST-MANAGER", manager(6)), false);
  assert.ok(stopped.removed.length > 0, "停止時は残ったボタンを撤去する");
});

test("heartbeat が 7 秒途絶えたら（拡張機能の無効化・更新）横取りを止め、ボタンとクラスを撤去する", () => {
  const h = load();
  h.state();
  h.clock.now += 6000;
  assert.equal(h.navigate("YT-PLAYLIST-MANAGER", manager(6)), true, "途絶前は横取りする");
  const fresh = load();
  fresh.state();
  fresh.clock.now += 7001;
  assert.equal(fresh.navigate("YT-PLAYLIST-MANAGER", manager(6)), false);
  assert.ok(fresh.removed.length > 0);
  assert.deepEqual(fresh.unclassed, ["__cpa-ypr-reversed"]);
});

test("別オリジン・別チャンネル・不正なセッションや再生リスト ID の通知は無視する", () => {
  const h = load();
  h.message({ origin: "https://evil.example", data: JSON.stringify({ channel: CHANNEL, session: SESSION, type: "state", listId: LIST }) });
  h.message({ data: JSON.stringify({ channel: "other", session: SESSION, type: "state", listId: LIST }) });
  h.message({ data: JSON.stringify({ channel: CHANNEL, session: "bad", type: "state", listId: LIST }) });
  assert.equal(h.navigate("YT-PLAYLIST-MANAGER", manager(6)), false);
  h.state("bad id with spaces");
  assert.equal(h.navigate("YT-PLAYLIST-MANAGER", manager(6)), false);
});
