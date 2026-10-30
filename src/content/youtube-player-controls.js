// YouTube のプレイヤー操作を、設定を読む isolated world と権限を持たない MAIN に分離する。
(() => {
  "use strict";
  const CHANNEL = "__cpa_youtube_player_controls_v1";
  const featureKeys = ["liveLatency", "playbackQuality", "playbackRate", "playerVolume"];
  const watchFeatures = SearchFixer.FEATURES.filter((feature) => feature.category === "watch_page");
  let state = null;
  let session = null;
  let stopped = false;
  let heartbeat = null;
  let settingsPanel = null;
  let bindings = [];
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
    bindings = [];
    playerSlot = null;
    window.__cpaYouTubeOverlay.remove("player");
  }

  function sendSettings() {
    if (state && session) post("settings", { features: state.features, labels: state.labels, settings: state.settings });
  }

  function updateSettingsPanel(slot) {
    if (!settingsPanel) {
      const panel = document.createElement("details");
      panel.className = "__cpa-ypc-settings";
      const summary = document.createElement("summary");
      summary.textContent = chrome.i18n.getMessage("ypcWatchSettings");
      panel.append(summary);
      const status = document.createElement("div");
      status.className = "__cpa-ypc-save-status";
      status.setAttribute("role", "status");
      const failedInputs = new Set();
      const spec = SearchFixer.PLAYER_CONTROLS;
      const groups = { liveLatency: "latency", playerVolume: "volume" };
      const message = (key) => chrome.i18n.getMessage(key);

      function addInput(parent, text, description, fallback, readValue, makeRequest, choices = []) {
        const label = document.createElement("label");
        label.className = "__cpa-ypc-setting-row";
        const name = document.createElement("span");
        name.textContent = text;
        let descriptionId = null;
        if (description) {
          const desc = document.createElement("small");
          desc.id = `__cpa-ypc-desc-${session}-${bindings.length}`;
          descriptionId = desc.id;
          desc.textContent = description;
          name.append(desc);
        }
        const input = document.createElement(typeof fallback === "boolean" ? "input" : "select");
        input.setAttribute("aria-label", text);
        if (descriptionId) input.setAttribute("aria-describedby", descriptionId);
        if (typeof fallback === "boolean") { input.type = "checkbox"; input.setAttribute("role", "switch"); }
        else {
          for (const [value, title] of choices) input.add(new Option(title, String(value)));
        }
        input.addEventListener("change", async (event) => {
          if (!event.isTrusted) return;
          const activeSession = session;
          const requestState = state;
          input.disabled = true;
          try {
            const value = input.type === "checkbox" ? input.checked : Number(input.value);
            const request = makeRequest(value);
            const response = await chrome.runtime.sendMessage({ ...request, syncGeneration });
            if (!response?.ok) throw new Error("save-failed");
            // onStored の再取得で state が更新済みなら、その確定値を旧応答で上書きしない。
            if (session === activeSession && state === requestState) {
              if (request.data) state.settings = spec.getPlaybackSettings(spec.mergeSettings(state.settings, request.data));
              else state.watchFeatures[request.key] = value;
            }
            failedInputs.delete(input);
          } catch { failedInputs.add(input); }
          finally { input.disabled = false; if (session === activeSession) updateSettingsPanel(slot); }
          status.textContent = failedInputs.size ? message("ypcSaveError") : "";
        });
        label.append(name, input);
        parent.append(label);
        bindings.push({ input, readValue });
      }

      const list = document.createElement("div");
      list.className = "__cpa-ypc-setting-list";
      let latencyItem = null;
      for (const feature of watchFeatures) {
        const item = document.createElement("div");
        item.className = "__cpa-ypc-setting-item";
        addInput(item, message(`feat_sf_${feature.key}_label`), message(`feat_sf_${feature.key}_desc`), false,
          () => state.watchFeatures[feature.key], (value) => ({ action: "APPLY_YOUTUBE_WATCH_FEATURE", key: feature.key, value }));
        const group = groups[feature.key];
        if (group) {
          if (group === "latency") {
            item.classList.add("__cpa-ypc-setting-item--wide");
            latencyItem = item;
          }
          const details = document.createElement("div");
          details.className = "__cpa-ypc-advanced";
          const defaults = spec.DEFAULT_SETTINGS[group];
          for (const [key, fallback] of Object.entries(defaults)) {
            if (Array.isArray(fallback)) continue;
            const choices = typeof fallback === "number" ? spec.NUMERIC_CHOICES[key] : [];
            addInput(details, message(`yp_${key}`), "", fallback, () => state.settings[group][key],
              (value) => ({ action: "APPLY_YOUTUBE_PLAYER_SETTINGS", data: { [group]: { [key]: value } } }),
              choices.map((value) => [value, `${value}${key === "playbackRate" ? "×" : ""}`]));
          }
          item.append(details);
        }
        list.append(item);
      }
      // 詳細の多い遅延設定を末尾へまとめ、操作順も表示順に揃える。
      if (latencyItem) list.append(latencyItem);
      panel.append(status, list);
      for (const type of ["click", "dblclick", "keydown", "keyup", "pointerdown"]) panel.addEventListener(type, (event) => event.stopPropagation());
      settingsPanel = panel;
      slot.append(panel);
    }
    for (const { input, readValue } of bindings) {
      if (input.disabled) continue;
      const value = readValue();
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
      const active = targetPage() && state?.enabled;
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
      state = { enabled: stored[StorageKeys.SEARCH_FIXER_ENABLED] === true, watchFeatures: SearchFixer.mergeFeatures(stored[StorageKeys.SEARCH_FIXER_FEATURES]), features, labels, settings: SearchFixer.PLAYER_CONTROLS.getPlaybackSettings(stored[StorageKeys.YOUTUBE_PLAYER_SETTINGS]) };
      refresh();
    },
  });

  chrome.runtime.onMessage.addListener((request, sender) => {
    if (stopped || !SenderCheck.isFromBackground(sender) || request?.action !== "YOUTUBE_PLAYER_COMMAND") return;
    const limits = { quality: 9, rate: 8, volume: 5 };
    if (!Object.hasOwn(limits, request.kind) || !Number.isInteger(request.index) || request.index < 0 || request.index >= limits[request.kind]) return;
    if (session && targetPage()) post("command", { kind: request.kind, index: request.index });
  });
})();
