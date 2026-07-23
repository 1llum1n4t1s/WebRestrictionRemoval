// YouTube ライブ配信の接続モニター
//
// ライブ視聴中に「クルクル（バッファリング）の原因」を切り分けるための HUD を
// プレーヤー内右上に重ねて表示する独自実装。`*://*.youtube.com/*` の top frame のみで
// 動作し、`<video>.duration === Infinity` のライブ配信のときだけ計測ループとオーバーレイを
// 起動する（通常動画では一切介入しない）。
//
// 有効化は YouTube クリーナーのサブ機能として制御する: master `searchFixerEnabled` AND
// `searchFixerFeatures.connectionMonitor` の両方 true で activate（独立 storage key は持たず、
// APPLY_SEARCH_FIXER_CS を search-fixer.js / youtube-shorts.js と共に購読する）。
//
// 設計上の不変条件:
//   - master OFF / サブ機能 OFF / 拡張機能 disable / 非ライブ / SPA 離脱時は HUD・タイマー・listener をすべて撤去
//   - top frame 限定（埋め込みプレイヤーには介入しない）
//   - 計測 1 秒間隔・経路診断 5 秒間隔・rAF 描画は RENDER_THROTTLE_MS でスロットル
//   - 経路診断 fetch は `mode:"no-cors" + credentials:"omit" + referrerPolicy:"no-referrer"` 固定で
//     クロスオリジン Cookie 送信ゼロ・リファラ送信ゼロ
//   - context invalidation 後は全 timer / listener を必ず解除（CPU リーク防止、rtx-enhancer と同パターン）
//   - 既存の rtx-enhancer.js / loupe.js と同じ readSettingsAndApply 直列化パターンを踏襲

(() => {
  // 同一フレームでの二重実行防止（manifest content_scripts が二重ロードされた場合の保険）
  if (window.__cpaConnectionMonitorRunning) return;
  window.__cpaConnectionMonitorRunning = true;

  // top frame 限定: 埋め込みプレイヤー (iframe 内) には介入しない
  if (window !== window.top) return;

  // 拡張機能が orphan 状態（拡張機能リロード後の content script）なら一切処理せず即終了
  if (!chrome?.runtime?.id) return;

  // ---------- 定数 / クラス名 ----------
  const ROOT_CLASS = "__cpa-cm-overlay";
  const ROOT_DRAG_CLASS = "__cpa-cm-dragging";
  const ROOT_COLLAPSED_CLASS = "__cpa-cm-collapsed";
  const HANDLE_CLASS = "__cpa-cm-handle";
  const BODY_CLASS = "__cpa-cm-body";
  const VERDICT_ATTR = "data-verdict";

  const VERDICT_EMOJI = Object.freeze({
    [ConnectionMonitor.VERDICT.STABLE]: "✅",
    [ConnectionMonitor.VERDICT.NETWORK]: "📡",
    [ConnectionMonitor.VERDICT.DEVICE]: "💻",
    [ConnectionMonitor.VERDICT.YOUTUBE_CDN]: "🎬",
    [ConnectionMonitor.VERDICT.ROUTING]: "🛰️",
    [ConnectionMonitor.VERDICT.INTERNATIONAL]: "🌏",
    [ConnectionMonitor.VERDICT.UNKNOWN]: "❔",
  });

  const VERDICT_MSG_KEY = Object.freeze({
    [ConnectionMonitor.VERDICT.STABLE]: "cmVerdictStable",
    [ConnectionMonitor.VERDICT.NETWORK]: "cmVerdictNetwork",
    [ConnectionMonitor.VERDICT.DEVICE]: "cmVerdictDevice",
    [ConnectionMonitor.VERDICT.YOUTUBE_CDN]: "cmVerdictYoutubeCdn",
    [ConnectionMonitor.VERDICT.ROUTING]: "cmVerdictRouting",
    [ConnectionMonitor.VERDICT.INTERNATIONAL]: "cmVerdictInternational",
    [ConnectionMonitor.VERDICT.UNKNOWN]: "cmVerdictUnknown",
  });

  // ---------- 状態 ----------
  /** @type {HTMLElement | null} 現在のオーバーレイ root */
  let overlayEl = null;
  /** @type {HTMLElement | null} オーバーレイ body（数値表示部、折りたたみ時に hidden） */
  let overlayBodyEl = null;
  /** @type {HTMLElement | null} verdict ラベル（絵文字 + テキスト） */
  let overlayVerdictEl = null;
  /** @type {HTMLElement | null} 数値メトリクス行 */
  let overlayMetricEl = null;
  /** @type {HTMLElement | null} 詳細セクション root（▼ 展開時のみ表示） */
  let overlayDetailEl = null;
  /** @type {HTMLElement | null} 経路 RTT 詳細（Google + Cloudflare 個別） */
  let overlayPathRttEl = null;
  /** @type {HTMLElement | null} 直近 buffering 履歴 UL */
  let overlayBufferLogEl = null;
  /** @type {HTMLElement | null} 過去 60 秒の帯域統計 */
  let overlayBwEl = null;

  /** @type {HTMLVideoElement | null} 現在計測中の video */
  let trackedVideo = null;
  /**
   * trackedVideo 単位で「一度ライブ判定したら維持」する sticky フラグ。
   *
   * 背景: `isLiveVideo()` の DOM シグナル判定（`.ytp-time-display.ytp-live` / `.ytp-live-badge` 可視）は
   * YouTube プレイヤー UI の細かい再構築（scrubber hover / シアターモード切替 / 広告挿入直後 / SPA 内 panel reflow 等）で
   * 一瞬 false を返すケースがある。`activate()` の MutationObserver は `document.documentElement` の subtree:true を
   * 監視するため極めて高頻度に発火し、その 1 フレームに rescanForLiveVideo が走ると `stopMeasuring → removeOverlay` で
   * 「ライブ中に overlay だけ勝手に消える」現象が起きる（実機実測で発生）。
   *
   * 対策: trackedVideo の **identity が同じ** 間は一度確定したライブ判定を維持する。video element が SPA 遷移 / 広告挿入 /
   * mini-player ↔ full-player 切替で別 instance に差し替わったときだけ false にリセットして再評価する。
   */
  let isLiveTrackedVideo = false;
  /** @type {number} メイン計測 setInterval id（0 = 未起動） */
  let sampleTimer = 0;
  /** @type {number} 経路診断 setInterval id（0 = 未起動） */
  let diagnosisTimer = 0;
  /** @type {MutationObserver | null} DOM 監視 (video 出現 / SPA 遷移検知) */
  let mutationObserver = null;
  /** @type {boolean} 機能 ON / activate 中フラグ */
  let active = false;
  /** @type {boolean} 計測ループ起動中フラグ（ライブ視聴中だけ true） */
  let measuring = false;
  /** master 読み込み中の並列化フラグ */
  let applyInFlight = false;
  let applyQueued = false;
  /** MutationObserver callback の rescanForLiveVideo を rAF coalesce するフラグ */
  let rescanScheduled = false;

  /** @type {AbortController | null} 経路診断 fetch の abort 用 */
  let diagnosisAbort = null;

  /** @type {number} 最終 render 時刻（throttle 判定） */
  let lastRenderAt = 0;

  /** バッファ計測の ring buffer（直近 RING_BUFFER_SIZE サンプル）。各要素 = {ts, downlink, rtt, droppedFrames, totalFrames} */
  const samples = [];
  /** バッファリングイベント履歴（waiting/playing 検知）。各要素 = {ts, downlink, rtt, droppedDelta} */
  const bufferingEvents = [];
  /** waiting 検知時のスナップショット。playing で確定する */
  let pendingBuffering = null;

  /** 経路診断結果（直近 DIAGNOSIS_BUFFER_SIZE サンプル）。null = 計測中エラー */
  const googleRttSamples = [];
  const cloudflareRttSamples = [];

  /**
   * 動画 chunk の実 throughput サンプル（PerformanceObserver で `googlevideo.com` リソースを拾う）。
   *
   * 各要素 = `{ ts, mbps }`。`navigator.connection.downlink` はプライバシー保護で bucket 化された
   * 粗い見積もり値（10 Mbps 以上で頭打ち等）を返すため、実測値として動画ストリームの transferSize /
   * download duration から計算した throughput を使う（実機実測で navigator.connection.downlink が 10.0
   * 固定だった環境でも実 throughput は min 0.08 / median 32.15 / max 34.9 Mbps と細かく動く）。
   *
   * TAO（Timing-Allow-Origin）ヘッダが無い cross-origin リクエストは `transferSize === 0` になるため除外。
   * 小さい chunk（`VIDEO_CHUNK_MIN_BYTES` 未満）も warmup overhead 支配で除外する。
   */
  const videoThroughputSamples = [];
  /** @type {PerformanceObserver | null} 動画 chunk throughput 監視 */
  let throughputObserver = null;

  /** 直近 dropped frames 値（buffering イベント時の起点記録に使う） */
  let lastDroppedFrames = 0;

  /** waiting → playing でドラッグ操作中だった場合の保険 */
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

  /** Mbps を「N.N Mbps」形式に */
  function formatMbps(v) {
    if (!Number.isFinite(v) || v <= 0) return "— Mbps";
    if (v >= 100) return `${Math.round(v)} Mbps`;
    return `${v.toFixed(1)} Mbps`;
  }

  /** ms を「NNN ms」形式に。0 / 負値 / 非有限値はすべて invalid 扱いで「— ms」を返す。
   * 0 を invalid にする理由: Chromium の `navigator.connection.rtt` は環境によって常に 0 を返すケースがあり
   * (プライバシー粒度ポリシーで HTTP ペイロード経由でしか更新されない仕様)、それをそのまま「0 ms 素晴らしい」
   * と表示すると誤読される。実機実測 (Edge 140) で起動直後常に rtt=0 を確認したため 0 を弾く。 */
  function formatMs(v) {
    if (!Number.isFinite(v) || v <= 0) return "— ms";
    return `${Math.round(v)} ms`;
  }

  /** 配列末尾に push して上限を超えたら先頭を削る ring buffer ヘルパ */
  function pushRing(arr, item, limit) {
    arr.push(item);
    while (arr.length > limit) arr.shift();
  }

  /** 直近 windowMs 以内のイベントだけ残して古いものを掃除 */
  function pruneEvents(arr, windowMs, now) {
    while (arr.length > 0 && now - arr[0].ts > windowMs) arr.shift();
  }

  // ---------- ライブ判定 ----------

  /**
   * 要素が実際に表示されているか（display:none / 祖先非表示なら false）。
   * LIVE バッジは VOD でも DOM に存在するが display:none なので、「存在」ではなく「可視」で判定する。
   */
  function isElementVisible(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    // position:fixed 等で offsetParent が null でも、矩形があれば可視扱い
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /**
   * `<video>` がライブ配信かを判定する。
   *
   * 注意: YouTube の DVR 対応ライブは `video.duration` が「有限値で伸び続ける」ため
   * `duration === Infinity` では判定できない（実機実測: 配信中に 17620 → 17665 と増加）。
   * 確実な `getVideoData().isLive` は MAIN world 限定で、content script の isolated world
   * からは読めないため、プレイヤー UI の「ライブ専用 DOM シグナル」で判定する。
   * VOD では下記いずれも出ない / hidden になることを実機で較正済み:
   *   - `.ytp-time-display.ytp-live` : ライブ時のみ time display に付くクラス（VOD では付かない）
   *   - `.ytp-live-badge` が可視      : ライブ時のみ表示される LIVE バッジ（VOD では DOM に存在するが display:none）
   */
  function isLiveVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return false;
    // 1) DVR 無効のクラシックなライブは duration === Infinity（最速パス）
    if (video.duration === Infinity) return true;
    // 2) DVR ライブ / metadata 確定後はプレイヤー UI の DOM シグナルで判定（独立 2 シグナルの OR で冗長化）
    const player = video.closest(".html5-video-player") || findPlayerContainer();
    if (!player) return false;
    if (player.querySelector(".ytp-time-display.ytp-live")) return true;
    return isElementVisible(player.querySelector(".ytp-live-badge"));
  }

  /** ページ内で最初のメイン `<video>` (ytd-player 内) を返す。なければ null。 */
  function findPlayerVideo() {
    // ytd-player 内の video を優先（ミニプレイヤー / 広告プレイヤー切替時の競合回避）
    const v = document.querySelector("ytd-player video, #movie_player video, video.html5-main-video, video");
    return v instanceof HTMLVideoElement ? v : null;
  }

  /** プレーヤーコンテナ要素を返す（オーバーレイの位置決め基準） */
  function findPlayerContainer() {
    return document.querySelector("#movie_player") || document.querySelector("ytd-player");
  }

  // ---------- 計測 ----------

  /** メイン計測 1 サンプル分を収集して ring buffer に push */
  function sampleOnce() {
    if (!chrome?.runtime?.id) {
      deactivate();
      return;
    }
    if (!trackedVideo || !trackedVideo.isConnected) {
      stopMeasuring();
      return;
    }
    // sticky 判定（trackedVideo が同じ間はライブ確定を維持。詳細は isLiveTrackedVideo 宣言部参照）
    if (!isLiveTrackedVideo) {
      stopMeasuring();
      return;
    }

    const now = Date.now();
    const conn = navigator.connection || {};
    const downlink = Number.isFinite(conn.downlink) ? conn.downlink : null;
    const rtt = Number.isFinite(conn.rtt) ? conn.rtt : null;

    let droppedFrames = 0;
    let totalFrames = 0;
    try {
      const q = typeof trackedVideo.getVideoPlaybackQuality === "function"
        ? trackedVideo.getVideoPlaybackQuality()
        : null;
      if (q) {
        droppedFrames = Number.isFinite(q.droppedVideoFrames) ? q.droppedVideoFrames : 0;
        totalFrames = Number.isFinite(q.totalVideoFrames) ? q.totalVideoFrames : 0;
      }
    } catch {
      // getVideoPlaybackQuality 未対応ブラウザは 0 のまま（経路診断は他で行う）
    }

    pushRing(samples, { ts: now, downlink, rtt, droppedFrames, totalFrames }, ConnectionMonitor.RING_BUFFER_SIZE);
    pruneEvents(bufferingEvents, ConnectionMonitor.EVENT_RETENTION_MS, now);

    lastDroppedFrames = droppedFrames;

    scheduleRender();
  }

  /** 経路診断 1 サイクル分（Google / Cloudflare 両方を並列計測） */
  async function diagnoseOnce() {
    if (!chrome?.runtime?.id) {
      deactivate();
      return;
    }
    if (!measuring) return;

    // 前回の in-flight があれば abort（次サイクル開始時に古い fetch が残らないように）
    if (diagnosisAbort) {
      try { diagnosisAbort.abort(); } catch {}
    }
    diagnosisAbort = new AbortController();
    // タイムアウトは AbortSignal.timeout で付与（規約: 永久 pending 防止、5s 周期より短い 4.5s）。
    // diagnosisAbort.signal と AbortSignal.any で束ね、「次サイクル開始時のキャンセル」と
    // 「ENDPOINT_TIMEOUT_MS タイムアウト」を 1 つの signal で両立する（手動 setTimeout/clearTimeout を廃止）。
    const signal = AbortSignal.any([
      diagnosisAbort.signal,
      AbortSignal.timeout(ConnectionMonitor.ENDPOINT_TIMEOUT_MS),
    ]);

    const measure = async (url) => {
      const start = performance.now();
      try {
        await fetch(url, {
          method: "GET",
          mode: "no-cors",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          signal,
        });
        return performance.now() - start;
      } catch {
        return null;
      }
    };

    const [googleRtt, cfRtt] = await Promise.all([
      measure(ConnectionMonitor.ENDPOINT_GOOGLE),
      measure(ConnectionMonitor.ENDPOINT_CLOUDFLARE),
    ]);

    if (!chrome?.runtime?.id || !measuring) return;

    if (Number.isFinite(googleRtt)) pushRing(googleRttSamples, googleRtt, ConnectionMonitor.DIAGNOSIS_BUFFER_SIZE);
    if (Number.isFinite(cfRtt)) pushRing(cloudflareRttSamples, cfRtt, ConnectionMonitor.DIAGNOSIS_BUFFER_SIZE);

    scheduleRender();
  }

  // ---------- 動画 chunk throughput 計測 (PerformanceObserver) ----------

  /**
   * PerformanceObserver を起動して `googlevideo.com` の resource entries から
   * 実 throughput を計算してリングに蓄積する。`buffered: true` で過去 entry も拾う。
   */
  function startThroughputMeasure() {
    if (throughputObserver) return;
    if (typeof PerformanceObserver !== "function") return;
    try {
      throughputObserver = new PerformanceObserver((list) => {
        if (!chrome?.runtime?.id) return;
        const entries = list.getEntries();
        for (const e of entries) {
          recordThroughputEntry(e);
        }
      });
      throughputObserver.observe({ type: "resource", buffered: true });
    } catch {
      throughputObserver = null;
    }
  }

  function stopThroughputMeasure() {
    if (!throughputObserver) return;
    try { throughputObserver.disconnect(); } catch {}
    throughputObserver = null;
  }

  /**
   * 1 resource entry を評価して、video chunk として有意なら throughput リングに push。
   * 評価ロジックは pure 関数寄り（PerformanceResourceTiming entry を受け取る）。
   */
  function recordThroughputEntry(entry) {
    if (!entry || typeof entry.name !== "string") return;
    if (!entry.name.includes("googlevideo.com")) return;
    // TAO ヘッダが無い cross-origin は transferSize が 0 になる
    if (!(entry.transferSize > 0)) return;
    if (!(entry.duration > 0)) return;
    // 小さい chunk は warmup overhead 支配で throughput 指標として無意味
    const size = entry.encodedBodySize > 0 ? entry.encodedBodySize : entry.transferSize;
    if (size < ConnectionMonitor.VIDEO_CHUNK_MIN_BYTES) return;
    // pure download 時間で計算（responseEnd - responseStart）。0 なら duration にフォールバック
    const downloadMs =
      entry.responseEnd > 0 && entry.responseStart > 0
        ? entry.responseEnd - entry.responseStart
        : entry.duration;
    if (!(downloadMs > 0)) return;
    const mbps = (entry.transferSize * 8) / (downloadMs / 1000) / 1_000_000;
    if (!Number.isFinite(mbps) || mbps <= 0) return;
    pushRing(videoThroughputSamples, { ts: Date.now(), mbps }, ConnectionMonitor.RING_BUFFER_SIZE);
  }

  /**
   * 直近 `VIDEO_THROUGHPUT_WINDOW_MS` のサンプルから min/avg/max/median を計算。
   * サンプル無しなら null を返す。
   */
  function computeThroughputStats() {
    if (videoThroughputSamples.length === 0) return null;
    const now = Date.now();
    const cutoff = now - ConnectionMonitor.VIDEO_THROUGHPUT_WINDOW_MS;
    const valid = videoThroughputSamples.filter((s) => s.ts >= cutoff).map((s) => s.mbps);
    if (valid.length === 0) return null;
    let sum = 0;
    let min = valid[0];
    let max = valid[0];
    for (const v of valid) {
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return {
      n: valid.length,
      min,
      avg: sum / valid.length,
      max,
      median: ConnectionMonitor.median(valid),
    };
  }

  // ---------- video イベント listener ----------

  function onVideoWaiting() {
    if (!measuring || !trackedVideo) return;
    const conn = navigator.connection || {};
    pendingBuffering = {
      ts: Date.now(),
      downlink: Number.isFinite(conn.downlink) ? conn.downlink : null,
      rtt: Number.isFinite(conn.rtt) ? conn.rtt : null,
      droppedAtStart: lastDroppedFrames,
    };
  }

  function onVideoPlaying() {
    if (!pendingBuffering) return;
    const ev = pendingBuffering;
    pendingBuffering = null;
    if (!measuring) return;
    const now = Date.now();
    const droppedDelta = Math.max(0, lastDroppedFrames - ev.droppedAtStart);
    pushRing(
      bufferingEvents,
      { ts: now, downlink: ev.downlink, rtt: ev.rtt, droppedDelta },
      // EVENT_RETENTION_MS / SAMPLE_INTERVAL_MS の上限を保険として
      Math.ceil(ConnectionMonitor.EVENT_RETENTION_MS / ConnectionMonitor.SAMPLE_INTERVAL_MS) * 2
    );
    scheduleRender();
  }

  function onVideoLoadedMetadata() {
    // 通常動画 → ライブ動画 / その逆の SPA 遷移で再評価
    rescanForLiveVideo();
  }

  function attachVideoListeners(video) {
    if (!video) return;
    video.addEventListener("waiting", onVideoWaiting, true);
    video.addEventListener("playing", onVideoPlaying, true);
    video.addEventListener("loadedmetadata", onVideoLoadedMetadata, true);
  }

  function detachVideoListeners(video) {
    if (!video) return;
    try {
      video.removeEventListener("waiting", onVideoWaiting, true);
      video.removeEventListener("playing", onVideoPlaying, true);
      video.removeEventListener("loadedmetadata", onVideoLoadedMetadata, true);
    } catch {}
  }

  // ---------- 判定 ----------

  function computeVerdict() {
    const now = Date.now();
    pruneEvents(bufferingEvents, ConnectionMonitor.BUFFERING_WINDOW_MS, now);

    const downlinkValues = samples
      .map((s) => s.downlink)
      .filter((v) => Number.isFinite(v) && v > 0);
    const downlinkBaseline = ConnectionMonitor.median(downlinkValues);

    const bufferingDownlinkValues = bufferingEvents
      .map((e) => e.downlink)
      .filter((v) => Number.isFinite(v) && v > 0);
    const downlinkDuringBuffering = ConnectionMonitor.median(bufferingDownlinkValues);

    // dropped frames 比率: 直近 2 サンプルの差分 / 総フレーム差分
    let droppedFramesRatio = null;
    if (samples.length >= 2) {
      const last = samples[samples.length - 1];
      const prev = samples[samples.length - 2];
      const droppedDelta = Math.max(0, last.droppedFrames - prev.droppedFrames);
      const totalDelta = Math.max(0, last.totalFrames - prev.totalFrames);
      if (totalDelta > 0) droppedFramesRatio = droppedDelta / totalDelta;
    }

    const googleRttMedian = ConnectionMonitor.median(googleRttSamples);
    const cloudflareRttMedian = ConnectionMonitor.median(cloudflareRttSamples);

    return {
      verdict: ConnectionMonitor.classify({
        bufferingCountRecent: bufferingEvents.length,
        downlinkBaseline,
        downlinkDuringBuffering,
        droppedFramesRatio,
        googleRttMedian,
        cloudflareRttMedian,
      }),
      bufferingCount: bufferingEvents.length,
      downlinkBaseline,
      googleRttMedian,
      cloudflareRttMedian,
    };
  }

  // ---------- オーバーレイ DOM ----------

  /**
   * 詳細セクションの DOM 雛形を作成（title + value の縦並び）。
   * 返却: `{ section, title, value }` — value は呼出元で `replaceWith` で差し替え可能。
   */
  function buildDetailSection(titleText) {
    const section = document.createElement("div");
    section.className = "__cpa-cm-detail-section";
    const title = document.createElement("div");
    title.className = "__cpa-cm-detail-title";
    title.textContent = titleText;
    section.appendChild(title);
    const value = document.createElement("div");
    value.className = "__cpa-cm-detail-value";
    section.appendChild(value);
    return { section, title, value };
  }

  /** 子要素を全削除（replaceChildren は innerHTML 非経由で Trusted Types 安全） */
  function clearChildren(el) {
    if (!el) return;
    el.replaceChildren();
  }

  /** 経過時間 ms → 「N 秒前 / N 分前」表記（cmBufferLogEntrySec / cmBufferLogEntryMin で i18n） */
  function formatRelativeTime(elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
    if (elapsedMs < 60_000) {
      const sec = Math.max(1, Math.round(elapsedMs / 1000));
      return i18n("cmBufferLogEntrySec", "{0} 秒前").replace("{0}", String(sec));
    }
    const min = Math.round(elapsedMs / 60_000);
    return i18n("cmBufferLogEntryMin", "{0} 分前").replace("{0}", String(min));
  }

  function buildOverlay() {
    if (overlayEl) return overlayEl;

    overlayEl = document.createElement("div");
    overlayEl.className = ROOT_CLASS;
    overlayEl.setAttribute(VERDICT_ATTR, ConnectionMonitor.VERDICT.UNKNOWN);
    overlayEl.setAttribute("role", "status");
    overlayEl.setAttribute("aria-live", "polite");
    // Trusted Types 環境（YouTube は対応サイト）でも安全に動くよう、innerHTML は使わず createElement で構築

    // ヘッダ（ハンドル）: 絵文字 + verdict ラベル + 折りたたみボタン
    const handle = document.createElement("div");
    handle.className = HANDLE_CLASS;
    handle.setAttribute("aria-label", i18n("cmDragHandle", "ドラッグで移動 / クリックで折りたたみ"));

    overlayVerdictEl = document.createElement("span");
    overlayVerdictEl.className = "__cpa-cm-verdict";
    handle.appendChild(overlayVerdictEl);

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "__cpa-cm-collapse-btn";
    collapseBtn.setAttribute("aria-label", i18n("cmToggleCollapse", "折りたたみ / 展開"));
    collapseBtn.textContent = "▾";
    collapseBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleCollapsed();
    });
    handle.appendChild(collapseBtn);

    overlayEl.appendChild(handle);

    // body: 数値メトリクス（常時）+ 詳細セクション（▼ 展開時のみ）
    overlayBodyEl = document.createElement("div");
    overlayBodyEl.className = BODY_CLASS;

    overlayMetricEl = document.createElement("div");
    overlayMetricEl.className = "__cpa-cm-metric";
    overlayBodyEl.appendChild(overlayMetricEl);

    // 詳細セクション root（CSS で .__cpa-cm-collapsed のとき display:none）
    overlayDetailEl = document.createElement("div");
    overlayDetailEl.className = "__cpa-cm-detail";

    // セクション 1: 経路 RTT 個別 (Google + Cloudflare)
    overlayPathRttEl = buildDetailSection(i18n("cmPathRttTitle", "経路 RTT"));
    overlayDetailEl.appendChild(overlayPathRttEl.section);

    // セクション 2: 直近 buffering 履歴
    const bufferLogSec = buildDetailSection(i18n("cmBufferLogTitle", "直近バッファ"));
    overlayBufferLogEl = document.createElement("ul");
    overlayBufferLogEl.className = "__cpa-cm-buffer-log";
    bufferLogSec.value.replaceWith(overlayBufferLogEl); // value <div> を <ul> に差し替え
    overlayDetailEl.appendChild(bufferLogSec.section);

    // セクション 3: 帯域 60 秒統計
    overlayBwEl = buildDetailSection(i18n("cmBwTitle", "帯域 60 秒"));
    overlayDetailEl.appendChild(overlayBwEl.section);

    overlayBodyEl.appendChild(overlayDetailEl);

    overlayEl.appendChild(overlayBodyEl);

    // ドラッグ
    handle.addEventListener("mousedown", onDragStart, true);

    // 折りたたみ状態と位置の復元
    const collapsed = readLocal(ConnectionMonitor.LS_KEY_OVERLAY_COLLAPSED) === true;
    if (collapsed) overlayEl.classList.add(ROOT_COLLAPSED_CLASS);

    // 位置: 初期は右上、ユーザーがドラッグした位置があれば復元
    const pos = readLocal(ConnectionMonitor.LS_KEY_OVERLAY_POS);
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
    // 親コンテナに position:relative がなければ overlay は親 stacking context に出る。
    // YouTube の #movie_player は元々 position:relative なので安心して absolute 配置できる。
    if (overlayEl.parentElement !== container) {
      container.appendChild(overlayEl);
    }
  }

  function removeOverlay() {
    if (!overlayEl) return;
    try { overlayEl.remove(); } catch {}
    overlayEl = null;
    overlayBodyEl = null;
    overlayVerdictEl = null;
    overlayMetricEl = null;
    overlayDetailEl = null;
    overlayPathRttEl = null;
    overlayBufferLogEl = null;
    overlayBwEl = null;
  }

  function toggleCollapsed() {
    if (!overlayEl) return;
    const collapsed = overlayEl.classList.toggle(ROOT_COLLAPSED_CLASS);
    writeLocal(ConnectionMonitor.LS_KEY_OVERLAY_COLLAPSED, collapsed);
    // 展開直後は renderDetail() の折りたたみ早期 return で止まっていた詳細セクションを
    // 即座に最新化する（次の sample tick まで最大 1 秒待たせない）
    if (!collapsed) render();
  }

  function onDragStart(ev) {
    if (!overlayEl) return;
    if (ev.button !== 0) return;
    // ボタンクリックはドラッグしない
    if (ev.target instanceof HTMLElement && ev.target.tagName === "BUTTON") return;
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
        writeLocal(ConnectionMonitor.LS_KEY_OVERLAY_POS, { left, top });
      }
    }
    document.removeEventListener("mousemove", onDragMove, true);
    document.removeEventListener("mouseup", onDragEnd, true);
  }

  // ---------- 描画 ----------

  function scheduleRender() {
    const now = performance.now();
    if (now - lastRenderAt < ConnectionMonitor.RENDER_THROTTLE_MS) return;
    lastRenderAt = now;
    requestAnimationFrame(render);
  }

  function render() {
    if (!overlayEl || !overlayVerdictEl || !overlayMetricEl) return;
    const result = computeVerdict();
    const verdict = result.verdict;

    // 値が変化したときだけ DOM を書き換える（#movie_player 直下での無駄な
    // MutationRecord 発生を避ける。YouTube 本体は自身の DOM 変化を「操作があった」
    // 判定の一部に使っている可能性があり、無条件 setAttribute/textContent の
    // 毎秒発火がプレイヤーコントロールの意図しない再表示に繋がるリスクがあるため）
    if (overlayEl.getAttribute(VERDICT_ATTR) !== verdict) {
      overlayEl.setAttribute(VERDICT_ATTR, verdict);
    }

    const emoji = VERDICT_EMOJI[verdict] || "❔";
    const label = i18n(VERDICT_MSG_KEY[verdict] || "cmVerdictUnknown", "—");
    const verdictText = `${emoji} ${label}`;
    if (overlayVerdictEl.textContent !== verdictText) {
      overlayVerdictEl.textContent = verdictText;
    }

    const lastSample = samples[samples.length - 1] || {};
    // 帯域は動画 chunk の実測 throughput median を優先 (navigator.connection.downlink は bucket 化された
    // 粗い見積もりで 10 Mbps 頭打ち等の制約あり)。throughput サンプル無いなら navigator.connection.downlink にフォールバック
    const throughputStats = computeThroughputStats();
    const compactMbps =
      throughputStats && Number.isFinite(throughputStats.median)
        ? throughputStats.median
        : lastSample.downlink;
    const downlinkText = formatMbps(compactMbps);
    // RTT は navigator.connection.rtt が環境によって常に 0 を返すケースがあるため、
    // 0 / invalid の場合は経路診断の Google RTT median にフォールバック (実測値の方が信頼できる)。
    // 両方無ければ formatMs が「— ms」を返す。
    const compactRtt =
      Number.isFinite(lastSample.rtt) && lastSample.rtt > 0
        ? lastSample.rtt
        : result.googleRttMedian;
    const rttText = formatMs(compactRtt);
    const bufLabel = i18n("cmBufferingPerMinute", "バッファ {0} 回 / 1 分").replace("{0}", String(result.bufferingCount));
    const metricText = `${bufLabel} · ${downlinkText} · ${rttText}`;
    if (overlayMetricEl.textContent !== metricText) {
      overlayMetricEl.textContent = metricText;
    }

    renderDetail(result);
  }

  /** 詳細セクション 3 種を更新（経路 RTT 個別 / 直近 buffering 履歴 / 帯域 60 秒統計） */
  function renderDetail(result) {
    if (!overlayPathRttEl || !overlayBufferLogEl || !overlayBwEl) return;
    // 折りたたみ時は CSS で hidden なので、DOM 書き換え自体をスキップする（描画コスト削減に加え、
    // #movie_player 直下での不要な MutationRecord 発生も抑える）。展開時は次の render() 呼び出し
    // (最大 RENDER_THROTTLE_MS 後) で最新状態に追いつく。
    if (overlayEl.classList.contains(ROOT_COLLAPSED_CLASS)) return;

    // (1) 経路 RTT 個別: Google / Cloudflare それぞれの median と sample 数
    const gN = googleRttSamples.length;
    const cN = cloudflareRttSamples.length;
    const gText = gN === 0
      ? i18n("cmDetailNotMeasured", "未計測")
      : i18n("cmPathRttEntry", "{0} ({1} 回)").replace("{0}", formatMs(result.googleRttMedian)).replace("{1}", String(gN));
    const cText = cN === 0
      ? i18n("cmDetailNotMeasured", "未計測")
      : i18n("cmPathRttEntry", "{0} ({1} 回)").replace("{0}", formatMs(result.cloudflareRttMedian)).replace("{1}", String(cN));
    const pathRttText = `Google: ${gText}\nCloudflare: ${cText}`;
    if (overlayPathRttEl.value.textContent !== pathRttText) {
      overlayPathRttEl.value.textContent = pathRttText;
      overlayPathRttEl.value.style.whiteSpace = "pre-line";
    }

    // (2) 直近 buffering 履歴: 新しい順に最大 5 件、相対時刻
    // 相対時刻表示 (formatRelativeTime) は経過時間そのものが毎秒変わるため差分チェックの効果は薄いが、
    // 「バッファ無し」の空状態が続くケースだけは再構築を省略できる。
    if (bufferingEvents.length === 0) {
      if (overlayBufferLogEl.childElementCount !== 1 || !overlayBufferLogEl.firstElementChild?.classList.contains("__cpa-cm-detail-empty")) {
        clearChildren(overlayBufferLogEl);
        const li = document.createElement("li");
        li.className = "__cpa-cm-detail-empty";
        li.textContent = i18n("cmBufferLogEmpty", "直近 1 分はバッファ無し");
        overlayBufferLogEl.appendChild(li);
      }
    } else {
      clearChildren(overlayBufferLogEl);
      const now = Date.now();
      const recent = bufferingEvents.slice(-5).reverse();
      for (const ev of recent) {
        const li = document.createElement("li");
        const rel = formatRelativeTime(now - ev.ts);
        const bw = Number.isFinite(ev.downlink) && ev.downlink > 0 ? formatMbps(ev.downlink) : null;
        li.textContent = bw ? `${rel} · ${bw}` : rel;
        overlayBufferLogEl.appendChild(li);
      }
    }

    // (3) 過去 60 秒の動画 chunk 実 throughput 統計: min / avg / max
    // navigator.connection.downlink (粗い概算) ではなく PerformanceObserver 経由の実測値を使う。
    // throughput サンプル無いとき (動画読み込み開始直後・広告中等) は「未計測」を出す
    const ts = computeThroughputStats();
    const bwText = !ts
      ? i18n("cmDetailNotMeasured", "未計測")
      : i18n("cmBwStat", "最小 {0} / 平均 {1} / 最大 {2}")
          .replace("{0}", formatMbps(ts.min))
          .replace("{1}", formatMbps(ts.avg))
          .replace("{2}", formatMbps(ts.max));
    if (overlayBwEl.value.textContent !== bwText) {
      overlayBwEl.value.textContent = bwText;
    }
  }

  // ---------- ライブ視聴中 measure 切替 ----------

  function rescanForLiveVideo() {
    if (!active) return;
    const v = findPlayerVideo();
    if (!v) {
      stopMeasuring();
      return;
    }
    if (trackedVideo !== v) {
      detachVideoListeners(trackedVideo);
      trackedVideo = v;
      attachVideoListeners(v);
      lastDroppedFrames = 0;
      samples.length = 0;
      bufferingEvents.length = 0;
      pendingBuffering = null;
      googleRttSamples.length = 0;
      cloudflareRttSamples.length = 0;
      videoThroughputSamples.length = 0;
      // 新しい video instance なので sticky ライブ判定をリセット
      isLiveTrackedVideo = false;
    }
    // sticky: 一度ライブ確定したら維持。trackedVideo identity が変わらない間は再評価で false に降格しない
    if (!isLiveTrackedVideo && isLiveVideo(v)) {
      isLiveTrackedVideo = true;
    }
    if (isLiveTrackedVideo) {
      startMeasuring();
    } else {
      stopMeasuring();
    }
  }

  function startMeasuring() {
    if (measuring) {
      attachOverlayToPlayer();
      return;
    }
    if (!chrome?.runtime?.id) return;
    measuring = true;

    buildOverlay();
    attachOverlayToPlayer();

    sampleTimer = setInterval(sampleOnce, ConnectionMonitor.SAMPLE_INTERVAL_MS);
    diagnosisTimer = setInterval(() => { diagnoseOnce().catch(() => {}); }, ConnectionMonitor.DIAGNOSIS_INTERVAL_MS);
    startThroughputMeasure();

    // 初回サンプルは即時 + 1 秒以内に diagnose も走らせて HUD を空のままにしない
    sampleOnce();
    diagnoseOnce().catch(() => {});
  }

  function stopMeasuring() {
    if (!measuring) {
      // 念のためオーバーレイが残っていたら撤去
      removeOverlay();
      return;
    }
    measuring = false;
    if (sampleTimer) {
      clearInterval(sampleTimer);
      sampleTimer = 0;
    }
    if (diagnosisTimer) {
      clearInterval(diagnosisTimer);
      diagnosisTimer = 0;
    }
    if (diagnosisAbort) {
      try { diagnosisAbort.abort(); } catch {}
      diagnosisAbort = null;
    }
    stopThroughputMeasure();
    removeOverlay();
  }

  // ---------- activate / deactivate ----------

  function activate() {
    if (active) return;
    if (!chrome?.runtime?.id) return;
    active = true;

    // 初期スキャン
    rescanForLiveVideo();

    // SPA navigation / player 再構築追跡: ytd-page-manager 直下の page 切替で video が差し替わる。
    // body 直下 subtree:true でも十分（高頻度 mutation は rescanForLiveVideo 自体が cheap で OK）。
    mutationObserver = new MutationObserver(() => {
      if (!chrome?.runtime?.id) {
        deactivate();
        return;
      }
      // rescanForLiveVideo を rAF coalesce で間引く
      if (rescanScheduled) return;
      rescanScheduled = true;
      requestAnimationFrame(() => {
        rescanScheduled = false;
        rescanForLiveVideo();
      });
    });
    try {
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}

    // SPA URL 変化 (yt-navigate-finish) で再評価
    document.addEventListener("yt-navigate-finish", onYtNavigateFinish, true);
  }

  function onYtNavigateFinish() {
    if (!active) return;
    // 新ページの video DOM 出現を rAF 経由で待つ
    requestAnimationFrame(() => {
      if (active) rescanForLiveVideo();
    });
  }

  function deactivate() {
    if (!active) {
      // 念のため残骸を片付け
      stopMeasuring();
      removeOverlay();
      return;
    }
    active = false;
    stopMeasuring();
    detachVideoListeners(trackedVideo);
    trackedVideo = null;
    isLiveTrackedVideo = false;
    if (mutationObserver) {
      try { mutationObserver.disconnect(); } catch {}
      mutationObserver = null;
    }
    try {
      document.removeEventListener("yt-navigate-finish", onYtNavigateFinish, true);
    } catch {}
    // ドラッグ中に master OFF / orphan 化した場合の document リスナー残留を防ぐ（mousemove は高頻度で CPU リーク源）
    if (dragging) {
      dragging = false;
      try {
        document.removeEventListener("mousemove", onDragMove, true);
        document.removeEventListener("mouseup", onDragEnd, true);
      } catch {}
    }
    samples.length = 0;
    bufferingEvents.length = 0;
    googleRttSamples.length = 0;
    cloudflareRttSamples.length = 0;
    videoThroughputSamples.length = 0;
    pendingBuffering = null;
  }

  // ---------- 設定購読 ----------
  // 接続モニターは YouTube クリーナーのサブ機能。master `searchFixerEnabled` AND
  // `searchFixerFeatures.connectionMonitor` の両方 true のときだけ activate する
  // (youtube-shorts.js と同じ統合方式)。両キーを毎回再取得するので「片方だけ変わって
  // もう片方が undefined になる」罠を構造的に回避する。

  /** master(searchFixerEnabled) AND サブ機能(connectionMonitor) で有効判定 */
  function computeActive(masterRaw, featuresRaw) {
    if (masterRaw !== true) return false;
    return SearchFixer.mergeFeatures(featuresRaw).connectionMonitor === true;
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
  // search-fixer.js / youtube-shorts.js と同じメッセージを購読し、接続モニターは
  // connectionMonitor サブ機能フラグだけを見て activate/deactivate する。
  try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (!chrome?.runtime?.id) return;
      if (!SenderCheck.isFromBackground(sender)) return;
      if (request?.action !== Actions.APPLY_SEARCH_FIXER_CS) return;
      readSettingsAndApply();
      try { sendResponse({ ok: true }); } catch {}
    });
  } catch {}

  // pagehide: bfcache 凍結 (persisted=true) は observer/timer を温存して復帰後そのまま継続させる
  // （disconnect すると pageshow 再初期化経路が無く復帰後に効かなくなるため。video-fill.js / loupe.js PATTERN SYNC）。
  // 実ドキュメント破棄 (persisted=false) のときだけ deactivate() でフル解放する
  // （yt-navigate-finish / video / drag リスナー + MutationObserver + active=false を一括撤去）。
  window.addEventListener(
    "pagehide",
    (ev) => {
      if (ev.persisted) return;
      deactivate();
    },
    { once: false }
  );
})();
