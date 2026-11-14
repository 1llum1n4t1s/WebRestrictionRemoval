// YouTube 再生リスト逆順再生のページ側アダプター（MAIN world）。権限 API・通信・保存を持たない。
//
// なぜ MAIN world か:
//   YouTube は「動画終了後の自動の次へ」「次へ / 前へボタン」「Shift+N / Shift+P」をすべて
//   `yt-playlist-manager` が発火する `yt-navigate`（detail.endpoint.watchEndpoint に index を持つ）で
//   処理する。isolated world からは別 world で作られた CustomEvent の detail を読めないため、
//   移動先の index を見て向きを判定する処理はページ側で行う。`<video>` の ended を止めても
//   YouTube の自動移動は止まらないことを実機で確認済み（内部の終了検知で進む）。
//
// 動作:
//   - 有効な再生リスト ID は isolated world（youtube-playlist-reverse.js）が postMessage で通知し、
//     2 秒ごとの heartbeat で生存を示す。7 秒途絶えたら拡張機能の無効化・更新とみなし、
//     横取りを止め、isolated world が付けたボタンとクラスも撤去する（ページ側だけが残って
//     逆順を続ける状態を作らない）。
//   - 再生リスト管理からの移動（index が現在 +1 / -1、ループ時の折り返しを含む）を止め、
//     反対向きの動画へ `playVideoAt` で移す。自分で起こした移動は期待した index の 1 回だけ通す。
//   - 最後の動画の終了時は YouTube が移動を起こさないため、ended を見て自分で 1 つ前へ移す。
//     1 本の動画の終了につき移動は 1 回だけ（動画 ID 単位のラッチ）。
//   - 一覧のクリック・シャッフル ON・1 曲ループは YouTube の動作のまま通す。
(() => {
  "use strict";
  const CHANNEL = "__cpa_youtube_playlist_reverse_v1";
  if (window.__cpaPlaylistReverseMainLoaded) return;
  window.__cpaPlaylistReverseMainLoaded = true;
  if (window !== window.top) return;

  const EXPIRE_MS = 7000;
  const LIST_RE = /^[\w-]{2,64}$/;
  const SESSION_RE = /^[a-f0-9-]{36}$/;
  const PANEL_CLASS = "__cpa-ypr-reversed";
  const UI_SELECTOR = ".__cpa-ypr-toggle, .__cpa-ypr-play-wrap";
  const LOOP_ALL = "PLAYLIST_LOOP_STATE_ALL";
  const LOOP_ONE = "PLAYLIST_LOOP_STATE_ONE";
  // 次へボタン / Shift+N の直後とみなす猶予。最後の動画からリスト外へ出る移動の判定だけに使う。
  const NEXT_INTENT_MS = 1500;
  // playVideoAt が移動を起こさなかったときに、ラッチと通過許可を解く待ち時間。
  const STALE_MOVE_MS = 3000;

  /** @type {{ session: string, listId: string | null, lastSeen: number } | null} */
  let state = null;
  /** 自分で起こした移動。期待した index の移動を 1 回だけ通す。 */
  let bypass = null;
  /** 逆向きの移動を起こした元の動画 ID。同じ動画からの 2 回目の移動を止める。 */
  let latch = null;
  let nextIntentAt = 0;
  let expiryTimer = null;

  // ---------- 純粋な判定 ----------

  /** 要求された index が現在位置から見て順方向か逆方向かを返す（判定不能は null）。 */
  function direction(current, requested, length) {
    if (requested === current + 1) return "forward";
    if (requested === current - 1) return "backward";
    // ループ時の折り返し（最後 → 先頭 / 先頭 → 最後）
    if (current === length - 1 && requested === 0) return "forward";
    if (current === 0 && requested === length - 1) return "backward";
    return null;
  }

  /** 逆順での移動先。範囲外はループ時だけ折り返し、それ以外は -1（移動しない）。 */
  function reversedTarget(current, length, dir, loopAll) {
    const target = dir === "forward" ? current - 1 : current + 1;
    if (target >= 0 && target < length) return target;
    if (!loopAll) return -1;
    return target < 0 ? length - 1 : 0;
  }

  // ---------- ページ状態 ----------

  function call(target, name, ...args) {
    try { return typeof target?.[name] === "function" ? target[name](...args) : undefined; } catch { return undefined; }
  }

  function cleanupDom() {
    try {
      for (const el of document.querySelectorAll(UI_SELECTOR)) el.remove();
      for (const el of document.querySelectorAll(`.${PANEL_CLASS}`)) el.classList.remove(PANEL_CLASS);
    } catch { /* 文書破棄中は何もしない */ }
  }

  function expire() {
    state = null;
    bypass = null;
    latch = null;
    clearInterval(expiryTimer);
    expiryTimer = null;
    cleanupDom();
  }

  /** 生存中の通知に含まれる再生リスト ID（逆順 OFF・途絶時は null）。 */
  function reversedListId() {
    if (!state) return null;
    if (Date.now() - state.lastSeen > EXPIRE_MS) {
      expire();
      return null;
    }
    return state.listId;
  }

  /** プレーヤーが指定の再生リストを再生中なら現在位置を返す。 */
  function snapshot(listId) {
    const player = document.getElementById("movie_player");
    if (!player || call(player, "getPlaylistId") !== listId) return null;
    const current = call(player, "getPlaylistIndex");
    const list = call(player, "getPlaylist");
    const length = Array.isArray(list) ? list.length : 0;
    if (!Number.isInteger(current) || current < 0 || current >= length) return null;
    const videoId = call(player, "getVideoData")?.video_id || null;
    // ラッチは「元の動画にまだいる間」だけ有効。別の動画へ移ったら解く（戻る等で元の動画へ戻ったとき、
    // 古いラッチで終了・次へが止まり続けないように）。
    if (latch !== null && videoId !== latch) latch = null;
    return { player, current, length, videoId };
  }

  function loopState() {
    try { return document.querySelector("yt-playlist-manager")?.playlistLoopStateEntity_?.state ?? null; } catch { return null; }
  }

  /** シャッフル中は順序の概念がないため横取りしない（aria-pressed はロケールに依存しない）。 */
  function shuffled() {
    return !!document.querySelector('ytd-playlist-panel-renderer #playlist-action-menu ytd-toggle-button-renderer button[aria-pressed="true"]');
  }

  function isAd(player) {
    return player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");
  }

  function cancel(event) {
    event.stopImmediatePropagation();
    event.preventDefault();
  }

  function go(target, snap) {
    latch = snap.videoId;
    bypass = { index: target };
    // yt-navigate の処理中に再入させないよう、現在のイベント処理を終えてから移す。
    setTimeout(() => {
      if (bypass?.index !== target) return;
      call(snap.player, "playVideoAt", target);
      setTimeout(() => {
        // 移動が起きなかった（API 失敗など）場合に、以後の操作を止め続けない。
        if (latch === snap.videoId && call(snap.player, "getVideoData")?.video_id === snap.videoId) {
          latch = null;
          bypass = null;
        }
      }, STALE_MOVE_MS);
    }, 0);
  }

  // ---------- イベント ----------

  function onEnded(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    const listId = reversedListId();
    if (!listId) return;
    const snap = snapshot(listId);
    if (!snap || !snap.player.contains(video) || isAd(snap.player) || shuffled()) return;
    const loop = loopState();
    if (loop === LOOP_ONE || !snap.videoId || latch === snap.videoId) return;
    const target = reversedTarget(snap.current, snap.length, "forward", loop === LOOP_ALL);
    if (target < 0) {
      // 逆順の終わり。YouTube が続けて起こす順方向の移動だけを止める。
      latch = snap.videoId;
      bypass = null;
      // 順方向の移動を止めるのは終了直後だけ。同じ動画のままループを ON にして再生し直しても止まらないよう、時間で解く。
      const stuck = snap.videoId;
      setTimeout(() => { if (latch === stuck) latch = null; }, STALE_MOVE_MS);
      return;
    }
    go(target, snap);
  }

  function onNavigate(event) {
    const listId = reversedListId();
    if (!listId) return;
    const endpoint = event.detail?.endpoint?.watchEndpoint;
    if (!endpoint || typeof endpoint !== "object") return;
    const tag = event.target?.tagName;
    let requested;
    if (tag === "YT-PLAYLIST-MANAGER") {
      if (endpoint.playlistId !== listId || !Number.isInteger(endpoint.index)) return;
      requested = endpoint.index;
    } else if (tag === "YTD-WATCH-FLEXY" && !endpoint.playlistId) {
      // 最後の動画で次へを押すと、YouTube は再生リスト外のおすすめ動画へ移る。
      requested = null;
    } else {
      // 一覧のクリックは利用者の選択なのでそのまま通す。YouTube は続けて再生リスト管理から同じ index の
      // 移動も起こすため、それが「次へ / 前へ」と誤判定されて逆向きに入れ替わらないよう、1 回だけ通す。
      if (tag === "YTD-PLAYLIST-PANEL-VIDEO-RENDERER" && endpoint.playlistId === listId && Number.isInteger(endpoint.index)) {
        bypass = { index: endpoint.index };
        latch = null;
      }
      return; // 関連動画などのクリックも利用者の選択なのでそのまま通す。
    }
    const snap = snapshot(listId);
    if (!snap) return;
    if (requested !== null && bypass?.index === requested) {
      bypass = null;
      return;
    }
    const loop = loopState();
    if (shuffled() || loop === LOOP_ONE) return;
    if (snap.videoId && latch === snap.videoId) {
      cancel(event);
      return;
    }
    let dir;
    if (requested === null) {
      const intended = Date.now() - nextIntentAt < NEXT_INTENT_MS || call(snap.player, "getPlayerState") === 0;
      if (snap.current !== snap.length - 1 || !intended) return;
      dir = "forward";
    } else {
      dir = direction(snap.current, requested, snap.length);
      if (!dir) return;
    }
    cancel(event);
    const target = reversedTarget(snap.current, snap.length, dir, loop === LOOP_ALL);
    if (target >= 0) go(target, snap);
  }

  function onClick(event) {
    if (event.target?.closest?.(".ytp-next-button")) nextIntentAt = Date.now();
  }

  function onKeyDown(event) {
    if (event.shiftKey && (event.code === "KeyN" || event.key === "N" || event.key === "n")) nextIntentAt = Date.now();
  }

  function onMessage(event) {
    if (event.source !== window || event.origin !== location.origin || typeof event.data !== "string" || event.data.length > 512) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.channel !== CHANNEL || typeof data.session !== "string" || !SESSION_RE.test(data.session)) return;
    if (data.type === "stop") {
      if (state?.session === data.session) expire();
      return;
    }
    if (data.type !== "state") return;
    const listId = typeof data.listId === "string" && LIST_RE.test(data.listId) ? data.listId : null;
    // 拡張機能の再読み込み後は新しいセッションが届くので、最新の通知を正とする。
    if (state?.session !== data.session || state.listId !== listId) {
      bypass = null;
      latch = null;
    }
    state = { session: data.session, listId, lastSeen: Date.now() };
    if (!expiryTimer) expiryTimer = setInterval(() => { reversedListId(); }, 2000);
  }

  window.addEventListener("message", onMessage);
  window.addEventListener("yt-navigate", onNavigate, true);
  window.addEventListener("ended", onEnded, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.postMessage(JSON.stringify({ channel: CHANNEL, type: "available" }), location.origin);
})();
