// YouTube 配信アーカイブの配信時刻オーバーレイ
//
// ライブ配信のアーカイブ（過去のライブを VOD 化したもの）を再生中、その瞬間が「実際に
// 配信されていた時刻」を `yyyy/MM/dd　hh:mm:ss`（全角スペース区切り・全桁ゼロ埋め・24 時間制・
// ローカルタイム）で、プレーヤー操作と共通の枠内に表示する。
// YouTube の top frame のみで動作し、配信アーカイブ
// （liveBroadcastDetails を持ち isLiveNow !== true）のときだけ出す。
//
// 有効化は YouTube 機能拡張のサブ機能として制御する: master `searchFixerEnabled` AND
// `searchFixerFeatures.broadcastClock` の両方 true で activate（独立 storage key は持たず、
// APPLY_SEARCH_FIXER_CS を search-fixer.js / youtube-shorts.js と
// 共に購読する）。純粋ロジック（videoId 抽出 / HTML パース / 時刻算出 / 整形）は actions.js の
// BroadcastClock namespace に集約し、本ファイルは DOM / fetch / lifecycle のみ担当する。
//
// データ取得: isolated world からは MAIN world の ytInitialPlayerResponse を読めないため、
// `/watch?v=<id>` を same-origin fetch（credentials:"same-origin" + redirect:"manual"）して
// HTML 内の liveBroadcastDetails を抽出する。結果は sessionStorage に videoId 単位で cache し、
// 動画ごと 1 回の fetch に抑える（負例＝通常動画も cache して再 fetch を防ぐ）。
//
//   - master OFF / サブ機能 OFF / 拡張機能 disable / 非アーカイブ / SPA 離脱時は HUD・listener を撤去
//   - top frame 限定（埋め込みプレイヤーには介入しない）
//   - context invalidation 後は MutationObserver / listener を必ず解除
//   - CleanerCore.subscribeStored が保存値の再取得を直列化（activate/deactivate の race 防止）
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
  let fetchAbort = null;
  /** same-origin fetch 失敗時の exponential backoff（search-fixer.js の確立パターンと同型:
   *  2s スタート → 倍々 → 60s 上限、成功で 0 リセット）。失敗は cache しない設計のため、
   *  高頻度 MutationObserver 経由の rescan が失敗 fetch を無制限に連打するのを構造的に防ぐ。
   *  配信中ライブ（アーカイブ化待ちで cache しない）への再 fetch もこの backoff で抑制される。 */
  let fetchBackoffMs = 0;
  let fetchLastFailedAt = 0;
  const FETCH_BACKOFF_INITIAL_MS = 2000;
  const FETCH_BACKOFF_MAX_MS = 60000;

  /** @type {MutationObserver | null} DOM 監視（video 出現 / SPA 遷移検知） */
  let mutationObserver = null;
  /** @type {boolean} 機能 ON / activate 中フラグ */
  let active = false;
  /** MutationObserver callback の rescan を rAF coalesce するフラグ */
  let rescanScheduled = false;

  /** @type {number} 最終 render 時刻（throttle 判定） */
  let lastRenderAt = 0;

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

  // ---------- 配信情報の取得（fetch + cache） ----------

  /**
   * videoId の配信情報を解決する。sessionStorage cache を優先し、無ければ same-origin fetch。
   * @returns {Promise<{ startMs:number, endMs:(number|null), isLiveNow:boolean } | { none:true } | null>}
   *   - アーカイブ: { startMs, endMs, isLiveNow:false }
   *   - 通常動画（配信由来でない）: { none:true }（負例 cache）
   *   - 配信中ライブ / 一時失敗: null（cache せず、次回再試行）
   */
  async function resolveBroadcastInfo(videoId, signal) {
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
        signal: AbortSignal.any([signal, AbortSignal.timeout(BroadcastClock.FETCH_TIMEOUT_MS)]),
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
    overlayEl.className = "__cpa-ypc-group __cpa-bc-section";
    overlayEl.setAttribute("role", "status");
    overlayEl.setAttribute("aria-live", "off");
    const heading = document.createElement("div");
    heading.className = "__cpa-ypc-heading";
    const label = document.createElement("span");
    label.className = "__cpa-ypc-label";
    label.textContent = i18n("bcOverlayLabel", "配信時刻");
    heading.appendChild(label);
    overlayEl.appendChild(heading);
    overlayTimeEl = document.createElement("div");
    overlayTimeEl.className = TIME_CLASS;
    overlayTimeEl.textContent = "—";
    overlayEl.appendChild(overlayTimeEl);
    return overlayEl;
  }

  function attachOverlay() {
    if (!overlayEl) return;
    window.__cpaYouTubeOverlay.mount("broadcast", overlayEl);
  }

  function removeOverlay() {
    window.__cpaYouTubeOverlay.remove("broadcast");
    overlayEl = null;
    overlayTimeEl = null;
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
    // 等幅フォント (Cascadia Mono / Code 等) は全角スペース U+3000 を可視グリフ (点線枠) で
    // 描画してしまうため、表示直前に半角スペース 2 つへ置換する。formatTimestamp の純粋関数
    // 仕様 (全角スペース区切り、test/actions.test.js で固定アサート) はそのまま維持する。
    const display = text.replace(/　/g, "  ");
    if (display && overlayTimeEl.textContent !== display) {
      overlayTimeEl.textContent = display;
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
    attachOverlay();
    lastRenderAt = 0;
    // 初回は同期描画して placeholder「—」→時刻の一瞬の幅変化を防ぐ（showClock は
    // broadcastInfo 確定後にのみ呼ばれるので render() は即座に時刻を描ける）。
    render();
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

    // 動画が変わったら配信情報をリセット（backoff も新規動画には持ち越さず即試行させる）
    if (videoId !== currentVideoId) {
      try { fetchAbort?.abort(); } catch {}
      fetchAbort = null;
      currentVideoId = videoId;
      broadcastInfo = null;
      fetchBackoffMs = 0;
      fetchLastFailedAt = 0;
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

    // 配信情報を取得（fetch は videoId 単位で重複防止 + 失敗時は backoff 経過まで再試行しない）
    if (fetchInFlightVideoId === videoId) return;
    if (fetchBackoffMs > 0 && Date.now() - fetchLastFailedAt < fetchBackoffMs) return;
    fetchInFlightVideoId = videoId;
    const controller = new AbortController();
    fetchAbort = controller;
    let info = null;
    try {
      info = await resolveBroadcastInfo(videoId, controller.signal);
    } finally {
      if (fetchInFlightVideoId === videoId) fetchInFlightVideoId = null;
      if (fetchAbort === controller) fetchAbort = null;
    }
    // SPA 遷移で旧動画の fetch が abort 完了した場合、新動画の backoff 状態を汚さない。
    if (currentVideoId !== videoId) return;
    if (info) {
      fetchBackoffMs = 0;
    } else {
      // 一時失敗 / 配信中ライブ（いずれも cache されない）→ 次回試行を指数的に遅らせる
      fetchLastFailedAt = Date.now();
      fetchBackoffMs = fetchBackoffMs > 0
        ? Math.min(fetchBackoffMs * 2, FETCH_BACKOFF_MAX_MS)
        : FETCH_BACKOFF_INITIAL_MS;
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
    try { fetchAbort?.abort(); } catch {}
    fetchAbort = null;
    resetVideoTracking();
    fetchInFlightVideoId = null;
    if (mutationObserver) {
      try { mutationObserver.disconnect(); } catch {}
      mutationObserver = null;
    }
    try {
      document.removeEventListener("yt-navigate-finish", onYtNavigateFinish, true);
    } catch {}
    hideClock();
  }

  // ---------- 設定購読 ----------
  // 配信時刻オーバーレイは YouTube 機能拡張のサブ機能。master `searchFixerEnabled` AND
  // `searchFixerFeatures.broadcastClock` の両方 true のときだけ activate する
  // （youtube-shorts.js と同じ統合方式）。両キーを毎回再取得する
  // ので「片方だけ変わってもう片方が undefined になる」罠を構造的に回避する。

  /** master(searchFixerEnabled) AND サブ機能(broadcastClock) で有効判定 */
  function computeActive(masterRaw, featuresRaw) {
    if (masterRaw !== true) return false;
    return SearchFixer.mergeFeatures(featuresRaw).broadcastClock === true;
  }

  CleanerCore.subscribeStored({
    keys: [
      StorageKeys.SEARCH_FIXER_ENABLED,
      StorageKeys.SEARCH_FIXER_FEATURES,
    ],
    applyAction: Actions.APPLY_SEARCH_FIXER_CS,
    onStored(stored) {
      if (computeActive(stored[StorageKeys.SEARCH_FIXER_ENABLED], stored[StorageKeys.SEARCH_FIXER_FEATURES])) {
        activate();
      } else {
        deactivate();
      }
    },
  });

  // pagehide: bfcache 凍結（persisted=true）は observer/listener を温存して復帰後そのまま継続させる
  // （video-fill.js / loupe.js PATTERN SYNC）。
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
