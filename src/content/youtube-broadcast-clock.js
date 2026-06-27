// YouTube 配信アーカイブの配信時刻オーバーレイ
//
// ライブ配信のアーカイブ（過去のライブを VOD 化したもの）を再生中、その瞬間が「実際に
// 配信されていた時刻」を `yyyy/MM/dd　hh:mm:ss`（全角スペース区切り・全桁ゼロ埋め・24 時間制・
// ローカルタイム）でプレーヤー内 HUD に重ねて表示する。`*://*.youtube.com/*` の top frame のみで
// 動作し、配信アーカイブ（liveBroadcastDetails を持ち isLiveNow !== true）のときだけ overlay を出す。
//
// 有効化は YouTube クリーナーのサブ機能として制御する: master `searchFixerEnabled` AND
// `searchFixerFeatures.broadcastClock` の両方 true で activate（独立 storage key は持たず、
// APPLY_SEARCH_FIXER_CS を search-fixer.js / youtube-shorts.js / youtube-connection-monitor.js と
// 共に購読する）。純粋ロジック（videoId 抽出 / HTML パース / 時刻算出 / 整形）は actions.js の
// BroadcastClock namespace に集約し、本ファイルは DOM / fetch / lifecycle のみ担当する。
//
// データ取得: isolated world からは MAIN world の ytInitialPlayerResponse を読めないため、
// `/watch?v=<id>` を same-origin fetch（credentials:"same-origin" + redirect:"manual"）して
// HTML 内の liveBroadcastDetails を抽出する。結果は sessionStorage に videoId 単位で cache し、
// 動画ごと 1 回の fetch に抑える（負例＝通常動画も cache して再 fetch を防ぐ）。
//
// 設計上の不変条件（youtube-connection-monitor.js PATTERN SYNC）:
//   - master OFF / サブ機能 OFF / 拡張機能 disable / 非アーカイブ / SPA 離脱時は HUD・listener を撤去
//   - top frame 限定（埋め込みプレイヤーには介入しない）
//   - context invalidation 後は MutationObserver / listener を必ず解除
//   - readSettingsAndApply は applyInFlight/applyQueued で直列化（activate/deactivate の race 防止）
//   - 精度の限界: 配信途中の回線断・編集カットがあるアーカイブは線形マッピングが崩れて実時刻がずれる

(() => {
  // 同一フレームでの二重実行防止（manifest content_scripts が二重ロードされた場合の保険）
  if (window.__cpaBroadcastClockRunning) return;
  window.__cpaBroadcastClockRunning = true;

  // top frame 限定: 埋め込みプレイヤー（iframe 内）には介入しない
  if (window !== window.top) return;

  // 拡張機能が orphan 状態（拡張機能リロード後の content script）なら一切処理せず即終了
  if (!chrome?.runtime?.id) return;

  // ---------- 定数 / クラス名 ----------
  const ROOT_CLASS = "__cpa-bc-overlay";
  const ROOT_DRAG_CLASS = "__cpa-bc-dragging";
  const HANDLE_CLASS = "__cpa-bc-handle";
  const TIME_CLASS = "__cpa-bc-time";

  // ---------- 状態 ----------
  /** @type {HTMLElement | null} オーバーレイ root */
  let overlayEl = null;
  /** @type {HTMLElement | null} 時刻表示部 */
  let overlayTimeEl = null;

  /** @type {HTMLVideoElement | null} 現在追従中の video */
  let trackedVideo = null;
  /** @type {string | null} 現在の videoId */
  let currentVideoId = null;
  /** @type {{ startMs:number, endMs:(number|null), isLiveNow:boolean } | null} 現在動画の配信情報（アーカイブ確定時のみ非 null） */
  let broadcastInfo = null;
  /** @type {string | null} fetch 進行中の videoId（重複 fetch 防止） */
  let fetchInFlightVideoId = null;

  /** @type {MutationObserver | null} DOM 監視（video 出現 / SPA 遷移検知） */
  let mutationObserver = null;
  /** @type {boolean} 機能 ON / activate 中フラグ */
  let active = false;
  /** master 読み込み中の並列化フラグ */
  let applyInFlight = false;
  let applyQueued = false;
  /** MutationObserver callback の rescan を rAF coalesce するフラグ */
  let rescanScheduled = false;

  /** @type {number} 最終 render 時刻（throttle 判定） */
  let lastRenderAt = 0;

  /** ドラッグ状態 */
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragging = false;

  // ---------- ユーティリティ ----------

  /** chrome.i18n.getMessage の薄いラッパ（chrome 未注入時も throw しない） */
  function i18n(key, fallback) {
    try {
      if (chrome?.i18n?.getMessage) {
        const msg = chrome.i18n.getMessage(key);
        if (msg) return msg;
      }
    } catch {}
    return fallback ?? "";
  }

  /** localStorage 読み込み（解析失敗・利用不可は null） */
  function readLocal(key) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** localStorage 書き込み（失敗は無視） */
  function writeLocal(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  /** sessionStorage 読み込み（解析失敗・利用不可は null） */
  function readSession(key) {
    try {
      const raw = window.sessionStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** sessionStorage 書き込み（失敗は無視。QuotaExceeded も握りつぶす） */
  function writeSession(key, value) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  // ---------- ページ / video 判定 ----------

  /** watch ページ（/watch または /live/<id>）かどうか */
  function isWatchPage() {
    const p = location.pathname;
    return p === "/watch" || p.startsWith("/live/");
  }

  /** 現在の videoId を URL から取得（/watch?v= 優先、/live/ フォールバック） */
  function resolveVideoId() {
    return (
      BroadcastClock.extractVideoId(location.search) ||
      BroadcastClock.extractVideoId(location.pathname)
    );
  }

  /** ページ内で最初のメイン `<video>`（ytd-player 内）を返す。なければ null。 */
  function findPlayerVideo() {
    const v = document.querySelector("ytd-player video, #movie_player video, video.html5-main-video, video");
    return v instanceof HTMLVideoElement ? v : null;
  }

  /** プレーヤーコンテナ要素を返す（オーバーレイの位置決め基準） */
  function findPlayerContainer() {
    return document.querySelector("#movie_player") || document.querySelector("ytd-player");
  }

  // ---------- 配信情報の取得（fetch + cache） ----------

  /**
   * videoId の配信情報を解決する。sessionStorage cache を優先し、無ければ same-origin fetch。
   * @returns {Promise<{ startMs:number, endMs:(number|null), isLiveNow:boolean } | { none:true } | null>}
   *   - アーカイブ: { startMs, endMs, isLiveNow:false }
   *   - 通常動画（配信由来でない）: { none:true }（負例 cache）
   *   - 配信中ライブ / 一時失敗: null（cache せず、次回再試行）
   */
  async function resolveBroadcastInfo(videoId) {
    const cacheKey = BroadcastClock.CACHE_PREFIX + videoId;
    const cached = readSession(cacheKey);
    if (cached) return cached;

    let html = null;
    try {
      // same-origin 認証 fetch（search-fixer.js の /feed/channels と同型）。
      // credentials:"same-origin" でログインセッションを維持、redirect:"manual" で
      // 認証プロキシ環境の cross-origin 302 を opaqueredirect（res.ok===false）扱いにして
      // Cookie 漏洩を塞ぐ。外部 CDN 向け fetch 4 原則とは別パターン（自オリジンへの取得）。
      const res = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, {
        credentials: "same-origin",
        redirect: "manual",
      });
      if (!res.ok) return null; // 一時失敗は cache しない
      html = await res.text();
    } catch {
      return null; // network error も cache しない
    }
    if (!chrome?.runtime?.id) return null;

    const info = BroadcastClock.parseLiveBroadcastDetails(html);
    if (!info) {
      // 配信由来でない通常動画 → 負例 cache（以後 fetch しない）
      const none = { none: true };
      writeSession(cacheKey, none);
      return none;
    }
    if (info.isLiveNow) {
      // 配信中ライブは対象外。後でアーカイブ化したら再判定したいので cache しない
      return null;
    }
    // アーカイブ確定 → positive cache
    writeSession(cacheKey, info);
    return info;
  }

  // ---------- オーバーレイ DOM ----------

  function buildOverlay() {
    if (overlayEl) return overlayEl;

    overlayEl = document.createElement("div");
    overlayEl.className = ROOT_CLASS;
    overlayEl.setAttribute("role", "status");
    overlayEl.setAttribute("aria-live", "off");
    // Trusted Types 環境（YouTube は対応サイト）でも安全に動くよう innerHTML は使わず createElement で構築

    // ハンドル: アイコン + ラベル（ドラッグで移動）
    const handle = document.createElement("div");
    handle.className = HANDLE_CLASS;
    handle.setAttribute("aria-label", i18n("bcDragHandle", "ドラッグで移動"));

    const icon = document.createElement("span");
    icon.className = "__cpa-bc-icon";
    icon.textContent = "🔴";
    handle.appendChild(icon);

    const label = document.createElement("span");
    label.className = "__cpa-bc-label";
    label.textContent = i18n("bcOverlayLabel", "配信時刻");
    handle.appendChild(label);

    overlayEl.appendChild(handle);

    // 時刻表示
    overlayTimeEl = document.createElement("div");
    overlayTimeEl.className = TIME_CLASS;
    overlayTimeEl.textContent = "—";
    overlayEl.appendChild(overlayTimeEl);

    // ドラッグ
    handle.addEventListener("mousedown", onDragStart, true);

    // 位置: 初期は左上、ユーザーがドラッグした位置があれば復元
    const pos = readLocal(BroadcastClock.LS_KEY_OVERLAY_POS);
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      overlayEl.style.left = `${pos.left}px`;
      overlayEl.style.top = `${pos.top}px`;
      overlayEl.style.right = "auto";
    }

    return overlayEl;
  }

  function attachOverlayToPlayer() {
    if (!overlayEl) return;
    const container = findPlayerContainer();
    if (!container) return;
    // #movie_player は position:relative なので absolute 配置で安定する
    if (overlayEl.parentElement !== container) {
      container.appendChild(overlayEl);
    }
  }

  function removeOverlay() {
    if (!overlayEl) return;
    try { overlayEl.remove(); } catch {}
    overlayEl = null;
    overlayTimeEl = null;
  }

  function onDragStart(ev) {
    if (!overlayEl) return;
    if (ev.button !== 0) return;
    const rect = overlayEl.getBoundingClientRect();
    const parent = overlayEl.parentElement?.getBoundingClientRect();
    if (!parent) return;
    dragOffsetX = ev.clientX - rect.left;
    dragOffsetY = ev.clientY - rect.top;
    dragging = true;
    overlayEl.classList.add(ROOT_DRAG_CLASS);
    document.addEventListener("mousemove", onDragMove, true);
    document.addEventListener("mouseup", onDragEnd, true);
    ev.preventDefault();
  }

  function onDragMove(ev) {
    if (!dragging || !overlayEl) return;
    const parent = overlayEl.parentElement?.getBoundingClientRect();
    if (!parent) return;
    const left = Math.max(0, Math.min(parent.width - overlayEl.offsetWidth, ev.clientX - parent.left - dragOffsetX));
    const top = Math.max(0, Math.min(parent.height - overlayEl.offsetHeight, ev.clientY - parent.top - dragOffsetY));
    overlayEl.style.left = `${left}px`;
    overlayEl.style.top = `${top}px`;
    overlayEl.style.right = "auto";
  }

  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    if (overlayEl) {
      overlayEl.classList.remove(ROOT_DRAG_CLASS);
      const left = parseFloat(overlayEl.style.left);
      const top = parseFloat(overlayEl.style.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        writeLocal(BroadcastClock.LS_KEY_OVERLAY_POS, { left, top });
      }
    }
    document.removeEventListener("mousemove", onDragMove, true);
    document.removeEventListener("mouseup", onDragEnd, true);
  }

  // ---------- 描画 ----------

  function scheduleRender() {
    const now = performance.now();
    if (now - lastRenderAt < BroadcastClock.RENDER_THROTTLE_MS) return;
    lastRenderAt = now;
    requestAnimationFrame(render);
  }

  function render() {
    if (!overlayEl || !overlayTimeEl || !trackedVideo || !broadcastInfo) return;
    const epoch = BroadcastClock.computeBroadcastEpochMs(broadcastInfo.startMs, trackedVideo.currentTime);
    const text = BroadcastClock.formatTimestamp(epoch);
    if (text && overlayTimeEl.textContent !== text) {
      overlayTimeEl.textContent = text;
    }
  }

  // ---------- video イベント listener ----------

  function onTimeUpdate() {
    scheduleRender();
  }
  function onSeeked() {
    // seek は throttle を無視して即時反映（大きく時刻が飛ぶため）
    lastRenderAt = 0;
    scheduleRender();
  }
  function onLoadedMetadata() {
    rescan();
  }

  function attachVideoListeners(video) {
    if (!video) return;
    video.addEventListener("timeupdate", onTimeUpdate, true);
    video.addEventListener("seeked", onSeeked, true);
    video.addEventListener("loadedmetadata", onLoadedMetadata, true);
  }

  function detachVideoListeners(video) {
    if (!video) return;
    try {
      video.removeEventListener("timeupdate", onTimeUpdate, true);
      video.removeEventListener("seeked", onSeeked, true);
      video.removeEventListener("loadedmetadata", onLoadedMetadata, true);
    } catch {}
  }

  // ---------- HUD 起動 / 撤去 ----------

  function showClock() {
    if (!chrome?.runtime?.id) return;
    buildOverlay();
    attachOverlayToPlayer();
    lastRenderAt = 0;
    scheduleRender();
  }

  function hideClock() {
    removeOverlay();
  }

  // ---------- rescan（現在 URL / video / 配信情報の再評価） ----------

  async function rescan() {
    if (!active || !chrome?.runtime?.id) return;

    if (!isWatchPage()) {
      resetVideoTracking();
      hideClock();
      return;
    }

    const videoId = resolveVideoId();
    if (!videoId) {
      resetVideoTracking();
      hideClock();
      return;
    }

    const video = findPlayerVideo();
    if (!video) {
      hideClock();
      return;
    }

    // 動画が変わったら配信情報をリセット
    if (videoId !== currentVideoId) {
      currentVideoId = videoId;
      broadcastInfo = null;
      hideClock();
    }

    // video instance の差し替えに追従
    if (trackedVideo !== video) {
      detachVideoListeners(trackedVideo);
      trackedVideo = video;
      attachVideoListeners(video);
    }

    // 配信情報が既知なら HUD を出して終わり
    if (broadcastInfo) {
      showClock();
      return;
    }

    // 配信情報を取得（fetch は videoId 単位で重複防止）
    if (fetchInFlightVideoId === videoId) return;
    fetchInFlightVideoId = videoId;
    let info = null;
    try {
      info = await resolveBroadcastInfo(videoId);
    } finally {
      if (fetchInFlightVideoId === videoId) fetchInFlightVideoId = null;
    }

    // post-await guard: orphan / 非 active / 動画が変わっていたら破棄
    if (!chrome?.runtime?.id || !active) return;
    if (currentVideoId !== videoId) return;

    if (info && !info.none && !info.isLiveNow) {
      broadcastInfo = info;
      showClock();
    } else {
      // 通常動画 / 配信中 / 取得失敗 → HUD は出さない
      hideClock();
    }
  }

  function resetVideoTracking() {
    if (trackedVideo) {
      detachVideoListeners(trackedVideo);
      trackedVideo = null;
    }
    currentVideoId = null;
    broadcastInfo = null;
  }

  // ---------- activate / deactivate ----------

  function activate() {
    if (active) return;
    if (!chrome?.runtime?.id) return;
    active = true;

    rescan();

    // SPA navigation / player 再構築追跡: video 差し替えを rescan で拾う。
    // 高頻度 mutation は rAF coalesce で間引く（rescan 自体は cheap、fetch は cache + in-flight ガード）。
    mutationObserver = new MutationObserver(() => {
      if (!chrome?.runtime?.id) {
        deactivate();
        return;
      }
      if (rescanScheduled) return;
      rescanScheduled = true;
      requestAnimationFrame(() => {
        rescanScheduled = false;
        rescan();
      });
    });
    try {
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}

    document.addEventListener("yt-navigate-finish", onYtNavigateFinish, true);
  }

  function onYtNavigateFinish() {
    if (!active) return;
    requestAnimationFrame(() => {
      if (active) rescan();
    });
  }

  function deactivate() {
    if (!active) {
      hideClock();
      return;
    }
    active = false;
    resetVideoTracking();
    fetchInFlightVideoId = null;
    if (mutationObserver) {
      try { mutationObserver.disconnect(); } catch {}
      mutationObserver = null;
    }
    try {
      document.removeEventListener("yt-navigate-finish", onYtNavigateFinish, true);
    } catch {}
    // ドラッグ中に master OFF / orphan 化した場合の document リスナー残留を防ぐ
    if (dragging) {
      dragging = false;
      try {
        document.removeEventListener("mousemove", onDragMove, true);
        document.removeEventListener("mouseup", onDragEnd, true);
      } catch {}
    }
    hideClock();
  }

  // ---------- 設定購読 ----------
  // 配信時刻オーバーレイは YouTube クリーナーのサブ機能。master `searchFixerEnabled` AND
  // `searchFixerFeatures.broadcastClock` の両方 true のときだけ activate する
  // （youtube-connection-monitor.js / youtube-shorts.js と同じ統合方式）。両キーを毎回再取得する
  // ので「片方だけ変わってもう片方が undefined になる」罠を構造的に回避する。

  /** master(searchFixerEnabled) AND サブ機能(broadcastClock) で有効判定 */
  function computeActive(masterRaw, featuresRaw) {
    if (masterRaw !== true) return false;
    return SearchFixer.mergeFeatures(featuresRaw).broadcastClock === true;
  }

  async function readSettingsAndApply() {
    if (!chrome?.runtime?.id) return;
    if (applyInFlight) {
      applyQueued = true;
      return;
    }
    applyInFlight = true;
    try {
      const stored = await chrome.storage.local.get([
        StorageKeys.SEARCH_FIXER_ENABLED,
        StorageKeys.SEARCH_FIXER_FEATURES,
      ]);
      if (!chrome?.runtime?.id) return;
      if (computeActive(stored[StorageKeys.SEARCH_FIXER_ENABLED], stored[StorageKeys.SEARCH_FIXER_FEATURES])) {
        activate();
      } else {
        deactivate();
      }
    } catch {
      // storage 読み取り失敗は次回 storage.onChanged / APPLY で再試行されるため何もしない
    } finally {
      applyInFlight = false;
      if (applyQueued) {
        applyQueued = false;
        readSettingsAndApply();
      }
    }
  }

  // 初回適用
  readSettingsAndApply();

  // storage 変更で同期（popup 操作 / 他タブからの変更）。master / features どちらの変化も拾う。
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (!chrome?.runtime?.id) return;
      if (areaName !== "local") return;
      if (
        StorageKeys.SEARCH_FIXER_ENABLED in changes ||
        StorageKeys.SEARCH_FIXER_FEATURES in changes
      ) {
        readSettingsAndApply();
      }
    });
  } catch {}

  // popup → background → content script: APPLY_SEARCH_FIXER_CS で再適用。
  // search-fixer.js / youtube-shorts.js / youtube-connection-monitor.js と同じメッセージを購読し、
  // broadcastClock サブ機能フラグだけを見て activate/deactivate する。
  try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (!chrome?.runtime?.id) return;
      if (!SenderCheck.isFromBackground(sender)) return;
      if (request?.action !== Actions.APPLY_SEARCH_FIXER_CS) return;
      readSettingsAndApply();
      try { sendResponse({ ok: true }); } catch {}
    });
  } catch {}

  // pagehide: bfcache 凍結（persisted=true）は observer/listener を温存して復帰後そのまま継続させる
  // （youtube-connection-monitor.js / video-fill.js / loupe.js PATTERN SYNC）。
  // 実ドキュメント破棄（persisted=false）のときだけ deactivate() でフル解放する。
  window.addEventListener(
    "pagehide",
    (ev) => {
      if (ev.persisted) return;
      deactivate();
    },
    { once: false }
  );
})();
