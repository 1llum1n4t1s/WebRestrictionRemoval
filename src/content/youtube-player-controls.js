// YouTube のプレイヤー操作を、設定を読む isolated world と権限を持たない MAIN に分離する。
(() => {
  "use strict";
  const CHANNEL = "__cpa_youtube_player_controls_v1";
  const featureKeys = ["liveLatency", "playbackQuality", "playbackRate", "playerVolume"];
  let state = null;
  let session = null;
  let stopped = false;
  let heartbeat = null;

  function targetPage() {
    return location.pathname === "/watch" || /^\/(embed|live)\//.test(location.pathname);
  }

  function post(type, extra = {}) {
    if (!session) return;
    window.postMessage(JSON.stringify({ channel: CHANNEL, session, type, ...extra }), location.origin);
  }

  function stopSession() {
    post("stop");
    session = null;
    window.__cpaYouTubeOverlay.remove("player");
  }

  function sendSettings() {
    if (state && session) post("settings", state);
  }

  function refresh() {
    if (stopped) return;
    try {
      if (!chrome.runtime.id) return teardown();
      const active = targetPage() && state && featureKeys.some((key) => state.features[key]);
      if (!active) {
        if (session) stopSession();
        return;
      }
      if (!session) {
        session = crypto.randomUUID();
        const slot = document.createElement("div");
        slot.className = "__cpa-ypc-player";
        slot.dataset.cpaPlayerSession = session;
        window.__cpaYouTubeOverlay.mount("player", slot);
      }
      // MAIN は manifest から直接読み込む。順序差・プレイヤー生成待ちは再通知で吸収する。
      post("start");
      sendSettings();
    } catch {
      teardown();
    }
  }

  function teardown() {
    if (stopped) return;
    stopSession();
    stopped = true;
    clearInterval(heartbeat);
    window.removeEventListener("message", onBridge);
    document.removeEventListener("yt-navigate-start", onNavigateStart);
    document.removeEventListener("yt-navigate-finish", refresh);
    window.removeEventListener("popstate", refresh);
  }

  function onBridge(event) {
    if (event.source !== window || event.origin !== location.origin || typeof event.data !== "string" || event.data.length > 256) return;
    try {
      const data = JSON.parse(event.data);
      if (data.channel !== CHANNEL) return;
      if (data.type === "available") { refresh(); return; }
      if (data.session !== session) return;
      if (data.type === "ready") sendSettings();
      if (data.type === "expired") { stopSession(); refresh(); }
    } catch { /* ページから来る JSON 以外の通知は無視する。 */ }
  }

  function onNavigateStart() { stopSession(); }
  window.addEventListener("message", onBridge);
  document.addEventListener("yt-navigate-start", onNavigateStart);
  document.addEventListener("yt-navigate-finish", refresh);
  window.addEventListener("popstate", refresh);
  window.addEventListener("pagehide", (event) => { if (!event.persisted) teardown(); });
  window.addEventListener("pageshow", () => refresh());
  heartbeat = setInterval(() => {
    try {
      if (!chrome.runtime.id) return teardown();
      if (session) post("heartbeat");
      refresh();
    } catch { teardown(); }
  }, 2000);

  CleanerCore.subscribeStored({
    keys: [StorageKeys.SEARCH_FIXER_ENABLED, StorageKeys.SEARCH_FIXER_FEATURES, StorageKeys.YOUTUBE_PLAYER_SETTINGS],
    applyAction: Actions.APPLY_SEARCH_FIXER_CS,
    onStored(stored) {
      const features = {};
      for (const key of featureKeys) features[key] = stored[StorageKeys.SEARCH_FIXER_ENABLED] === true && stored[StorageKeys.SEARCH_FIXER_FEATURES]?.[key] === true;
      const labels = {};
      const labelKeys = { quality: "ypcQuality", rate: "ypcRate", volume: "ypcVolume", auto: "yp_auto", showPlaybackRate: "yp_showPlaybackRate", showLatency: "yp_showLatency", showHealth: "yp_showHealth", showEstimation: "yp_showEstimation", showCurrent: "yp_showCurrent", copied: "ypcCopied" };
      for (const [key, message] of Object.entries(labelKeys)) labels[key] = chrome.i18n.getMessage(message);
      state = { features, labels, settings: SearchFixer.PLAYER_CONTROLS.normalizeSettings(stored[StorageKeys.YOUTUBE_PLAYER_SETTINGS]) };
      refresh();
    },
  });

  chrome.runtime.onMessage.addListener((request, sender) => {
    if (stopped || !SenderCheck.isFromBackground(sender) || request?.action !== "YOUTUBE_PLAYER_COMMAND") return;
    const limits = { quality: 9, rate: 16, volume: 5 };
    if (!Object.hasOwn(limits, request.kind) || !Number.isInteger(request.index) || request.index < 0 || request.index >= limits[request.kind]) return;
    if (session && targetPage()) post("command", { kind: request.kind, index: request.index });
  });
})();
