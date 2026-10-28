// YouTube のプレイヤー操作を、設定を読む isolated world と権限を持たない MAIN に分離する。
(() => {
  "use strict";
  const CHANNEL = "__cpa_youtube_player_controls_v1";
  const featureKeys = ["liveLatency", "playbackQuality", "playbackRate", "playerVolume"];
  let state = null;
  let session = null;
  let stopped = false;
  let heartbeat = null;
  let settingsPanel = null;
  let playerSlot = null;
  let syncGeneration = null;

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
    settingsPanel = null;
    playerSlot = null;
    window.__cpaYouTubeOverlay.remove("player");
  }

  function sendSettings() {
    if (state && session) post("settings", state);
  }

  function updateSettingsPanel(slot) {
    if (!state.features.liveLatency) { settingsPanel?.remove(); settingsPanel = null; return; }
    if (!settingsPanel) {
      const panel = document.createElement("details");
      panel.className = "__cpa-ypc-settings";
      const summary = document.createElement("summary");
      summary.textContent = `${chrome.i18n.getMessage("feat_sf_liveLatency_label")} · ${chrome.i18n.getMessage("yp_details")}`;
      panel.append(summary);
      const status = document.createElement("div");
      status.setAttribute("role", "status");
      for (const [key, fallback] of Object.entries(SearchFixer.PLAYER_CONTROLS.DEFAULT_SETTINGS.latency)) {
        const label = document.createElement("label");
        const name = document.createElement("span");
        name.textContent = chrome.i18n.getMessage(`yp_${key}`);
        const input = document.createElement(typeof fallback === "boolean" ? "input" : "select");
        input.dataset.latencyKey = key;
        if (typeof fallback === "boolean") input.type = "checkbox";
        else {
          const values = key === "playbackRate" ? [1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.5, 1.75, 2, 3, 4, 5, 6, 8, 10, 12, 16] : key === "smoothThreshold" ? [0, .5, 1, 2, 3, 5, 10, 15, 20, 30, 60, 120] : [1, 3, 5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400, 999999];
          for (const value of values) input.add(new Option(`${value}${key === "playbackRate" ? "x" : ""}`, String(value)));
        }
        input.addEventListener("change", async (event) => {
          if (!event.isTrusted) return;
          const activeSession = session;
          const requestState = state;
          input.disabled = true;
          try {
            const value = input.type === "checkbox" ? input.checked : Number(input.value);
            const response = await chrome.runtime.sendMessage({ action: "APPLY_YOUTUBE_LATENCY_SETTING", key, value, syncGeneration });
            if (!response?.ok) throw new Error("save-failed");
            // onStored の再取得で state が更新済みなら、その確定値を旧応答で上書きしない。
            if (session === activeSession && state === requestState) state.settings = SearchFixer.PLAYER_CONTROLS.mergeSettings(state.settings, { latency: { [key]: value } });
            status.textContent = "";
          } catch { status.textContent = chrome.i18n.getMessage("ypcSaveError"); }
          finally { input.disabled = false; if (session === activeSession) updateSettingsPanel(slot); }
        });
        label.append(name, input);
        panel.append(label);
      }
      panel.append(status);
      for (const type of ["click", "keydown", "keyup"]) panel.addEventListener(type, (event) => event.stopPropagation());
      settingsPanel = panel;
      slot.append(panel);
    }
    for (const input of settingsPanel.querySelectorAll("[data-latency-key]")) {
      if (input.disabled) continue;
      const value = state.settings.latency[input.dataset.latencyKey];
      if (input.type === "checkbox") input.checked = value;
      else {
        if (![...input.options].some((option) => option.value === String(value))) input.add(new Option(String(value), String(value)));
        input.value = String(value);
      }
    }
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
        playerSlot = document.createElement("div");
        playerSlot.className = "__cpa-ypc-player";
        playerSlot.dataset.cpaPlayerSession = session;
        window.__cpaYouTubeOverlay.mount("player", playerSlot);
      }
      // プレイヤー生成前は slot が未接続なので、document から検索せず登録した参照を使う。
      updateSettingsPanel(playerSlot);
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
    keys: [StorageKeys.SEARCH_FIXER_ENABLED, StorageKeys.SEARCH_FIXER_FEATURES, StorageKeys.YOUTUBE_PLAYER_SETTINGS, StorageKeys.SETTINGS_SYNC_APPLIED],
    applyAction: Actions.APPLY_SEARCH_FIXER_CS,
    onStored(stored) {
      syncGeneration = stored[StorageKeys.SETTINGS_SYNC_APPLIED] ?? null;
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
