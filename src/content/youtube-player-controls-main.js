// 権限 API・通信・保存を持たない、YouTube プレイヤー API 専用のページ側アダプター。
(() => {
  "use strict";
  const CHANNEL = "__cpa_youtube_player_controls_v1";
  if (window.__cpaYouTubePlayerControlsMainLoaded) return;
  window.__cpaYouTubePlayerControlsMainLoaded = true;

  function startEngine(session) {
    const qualityValues = ["tiny", "small", "medium", "large", "hd720", "hd1080", "hd1440", "hd2160", "hd2880", "highres", "auto"];
    const qualityLabels = { tiny: "144p", small: "240p", medium: "360p", large: "480p", hd720: "720p", hd1080: "1080p", hd1440: "1440p", hd2160: "2160p", hd2880: "2880p", highres: "4320p", auto: "auto" };
    let config = null;
    let lastSeen = Date.now();
    let player = null;
    let video = null;
    let videoId = null;
    let timer = null;
    let dead = false;
    let automatic = null;
    let manualRate = false;
    let controls = null;
    let ends = [];
    let lastSkip = 0;
    let copiedUntil = 0;
    const buttons = new Map();
    const currentValues = new Map();

    function call(name, ...args) {
      try { return typeof player?.[name] === "function" ? player[name](...args) : undefined; } catch { return undefined; }
    }

    function detectManualRate() {
      if (!automatic) return;
      const playerRate = call("getPlaybackRate");
      const changedPlayerRate = Number.isFinite(automatic.playerRate) && Number.isFinite(playerRate) && playerRate !== automatic.playerRate;
      // 同じ 1.25x を標準 UI で選び直した場合は video 側の値が変わらないため API 側も照合する。
      if (automatic.video === video && (video.playbackRate !== automatic.last || changedPlayerRate)) {
        automatic = null;
        manualRate = true;
      }
    }

    function releaseRate() {
      detectManualRate();
      if (automatic && automatic.video === video && video && video.playbackRate === automatic.last) {
        video.playbackRate = automatic.original;
      }
      automatic = null;
    }

    function clearUI() {
      controls?.remove();
      controls = null;
      buttons.clear();
      currentValues.clear();
      player?.classList.remove("__cpa-ypc-hide-slider", "__cpa-ypc-hide-volume");
    }

    function resetPlayer() {
      releaseRate();
      clearUI();
      player = null;
      video = null;
      videoId = null;
      manualRate = false;
      ends = [];
      lastSkip = 0;
    }

    function shutdown() {
      if (dead) return;
      resetPlayer();
      dead = true;
      clearInterval(timer);
      clearTimeout(bootstrapTimeout);
      window.removeEventListener("message", onMessage);
      document.removeEventListener("yt-navigate-start", resetPlayer);
      window.removeEventListener("pagehide", onPageHide);
    }

    function onPageHide(event) { if (!event.persisted) shutdown(); }
    function validPage() { return location.pathname === "/watch" || /^\/(embed|live)\//.test(location.pathname); }
    function finite(value, low, high) { return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high; }

    // MAIN world 側でも型・範囲と操作種類を固定する。ページから任意 API を呼び出すブリッジにはしない。
    function normalize(data) {
      const input = data.settings;
      if (!input || !data.features || typeof input !== "object") return null;
      const result = { features: {}, labels: {}, settings: { latency: {} } };
      for (const key of ["quality", "rate", "volume", "auto", "showPlaybackRate", "showLatency", "showHealth", "showEstimation", "showCurrent", "copied"]) {
        if (typeof data.labels?.[key] !== "string" || data.labels[key].length > 160) return null;
        result.labels[key] = data.labels[key];
      }
      for (const key of ["liveLatency", "playbackQuality", "playbackRate", "playerVolume"]) result.features[key] = data.features[key] === true;
      for (const [key, length, low, high] of [["quality", 9, 0, 0], ["rate", 16, 0.1, 16], ["volume", 5, 0, 100]]) {
        const group = input[key];
        if (!group || !Array.isArray(group.values) || group.values.length !== length || !Array.isArray(group.enabled) || group.enabled.length !== length) return null;
        if (group.values.some((value) => key === "quality" ? !qualityValues.includes(value) : !finite(value, low, high))) return null;
        result.settings[key] = { values: [...group.values], enabled: group.enabled.map((value) => value === true) };
      }
      result.settings.volume.hideSlider = input.volume.hideSlider === true;
      result.settings.volume.hideVolumeIcon = input.volume.hideVolumeIcon === true;
      const latency = input.latency;
      if (!latency || !finite(latency.playbackRate, 1.05, 16) || !finite(latency.smoothThreshold, 0, 120) || !finite(latency.skipThreshold, 1, 999999)) return null;
      for (const key of ["enabled", "smooth", "smoothAuto", "skip", "showPlaybackRate", "showLatency", "showHealth", "showEstimation", "showCurrent"]) result.settings.latency[key] = latency[key] === true;
      for (const key of ["playbackRate", "smoothThreshold", "skipThreshold"]) result.settings.latency[key] = latency[key];
      return result;
    }

    function onMessage(event) {
      if (dead || event.source !== window || event.origin !== location.origin || typeof event.data !== "string" || event.data.length > 12000) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data?.channel !== CHANNEL || data.session !== session) return;
      if (data.type === "stop") return shutdown();
      if (data.type === "settings") {
        const next = normalize(data);
        if (!next) return;
        const changed = JSON.stringify(config) !== JSON.stringify(next);
        config = next;
        lastSeen = Date.now();
        if (!timer) timer = setInterval(tick, 250);
        if (changed) { clearUI(); tick(); }
      } else if (data.type === "heartbeat" && config) lastSeen = Date.now();
      else if (data.type === "command" && config) command(data.kind, data.index);
    }

    function command(kind, index) {
      const group = config?.settings[kind];
      const feature = { quality: "playbackQuality", rate: "playbackRate", volume: "playerVolume" }[kind];
      if (!validPage() || !player?.isConnected || !video?.isConnected || !feature || !config.features[feature] || !Number.isInteger(index) || !group || index < 0 || index >= group.values.length || isAd()) return;
      const value = group.values[index];
      if (kind === "quality") {
        const available = call("getAvailableQualityLevels");
        // API が候補を返さないときは別画質を推測して選択しない。
        if (value !== "auto" && (!Array.isArray(available) || !available.includes(value))) return;
        call("setPlaybackQualityRange", value);
      } else if (kind === "rate") {
        releaseRate();
        manualRate = true;
        call("setPlaybackRate", value);
        try { video.playbackRate = value; } catch { /* ブラウザ非対応の速度は変更しない。 */ }
      } else if (value === 0) call("mute");
      else { call("setVolume", value); call("unMute"); }
      updateSelection();
    }

    function isAd() { return player?.classList.contains("ad-showing") || player?.classList.contains("ad-interrupting"); }
    function createButton(text, title, click) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ytp-button __cpa-ypc-button";
      button.textContent = text;
      button.title = title;
      button.setAttribute("aria-label", title);
      if (click) button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); click(); });
      return button;
    }

    function mountUI() {
      const selector = `.__cpa-ypc-player[data-cpa-player-session="${session}"]`;
      const area = player.querySelector(selector) || (/^\/embed\//.test(location.pathname) &&
        document.querySelector(`#player-controls player-fullscreen-action-menu .quick-actions-wrapper > .__cpa-ypc-overlay > ${selector}`));
      if (!area) return;
      if (controls?.parentElement === area) return;
      clearUI();
      controls = document.createElement("div");
      controls.className = "__cpa-ypc-controls";
      for (const [kind, feature] of [["quality", "playbackQuality"], ["rate", "playbackRate"], ["volume", "playerVolume"]]) {
        if (!config.features[feature]) continue;
        const group = config.settings[kind];
        const container = document.createElement("span");
        container.className = "__cpa-ypc-group";
        container.setAttribute("role", "group");
        container.setAttribute("aria-label", config.labels[kind]);
        const heading = document.createElement("span");
        heading.className = "__cpa-ypc-heading";
        const name = document.createElement("span");
        name.className = "__cpa-ypc-label";
        name.textContent = config.labels[kind];
        const current = document.createElement("span");
        current.className = "__cpa-ypc-current";
        currentValues.set(kind, current);
        heading.append(name, current);
        const choices = document.createElement("span");
        choices.className = "__cpa-ypc-choices";
        container.append(heading, choices);
        const order = kind === "quality" ? [0, 1, 2, 3, 4, 5, 6, 8, 7] : kind === "rate" ? [0, 1, 2, 3, 4, 5, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15] : group.values.map((_value, index) => index);
        for (const index of order) {
          const value = group.values[index];
          const label = kind === "quality" ? (value === "auto" ? config.labels.auto : qualityLabels[value]) : kind === "rate" ? `${value}x` : `${value}%`;
          const button = createButton(label, `${config.labels[kind]}: ${label}`, () => command(kind, index));
          buttons.set(`${kind}:${index}`, button);
          choices.append(button);
        }
        controls.append(container);
      }
      if (config.features.liveLatency) {
        const group = document.createElement("span");
        group.className = "__cpa-ypc-group __cpa-ypc-live";
        for (const key of ["showPlaybackRate", "showLatency", "showHealth", "showEstimation", "showCurrent"]) {
          if (!config.settings.latency[key]) continue;
          const button = createButton("", config.labels[key], key === "showCurrent" ? copyTimestamp : null);
          button.hidden = true;
          buttons.set(key, button);
          group.append(button);
        }
        controls.append(group);
      }
      area.prepend(controls);
    }

    function updateSelection() {
      const quality = call("getPlaybackQuality");
      const preferredQuality = call("getPreferredQuality") || quality;
      const volume = call("isMuted") === true ? 0 : call("getVolume");
      const values = {
        quality: quality === "auto" ? config.labels.auto : (qualityLabels[quality] || "—"),
        rate: Number.isFinite(video.playbackRate) ? `${video.playbackRate}x` : "—",
        volume: Number.isFinite(volume) ? `${Math.round(volume)}%` : "—",
      };
      for (const [kind, current] of currentValues) {
        if (current.textContent !== values[kind]) current.textContent = values[kind];
      }
      for (const [key, button] of buttons) {
        const [kind, index] = key.split(":");
        if (index === undefined) continue;
        const value = config.settings[kind].values[Number(index)];
        const active = value === (kind === "quality" ? preferredQuality : kind === "rate" ? video.playbackRate : volume);
        button.classList.toggle("__cpa-ypc-active", active);
        button.setAttribute("aria-pressed", String(active));
      }
    }

    function formatTime(seconds) {
      const total = Math.max(0, Math.floor(seconds));
      const hours = Math.floor(total / 3600);
      return `${hours ? `${hours}:` : ""}${String(Math.floor(total / 60) % 60).padStart(hours ? 2 : 1, "0")}:${String(total % 60).padStart(2, "0")}`;
    }

    function copyTimestamp() {
      if (!/^[\w-]{11}$/.test(videoId || "")) return;
      const progress = call("getProgressState");
      if (!Number.isFinite(progress?.current) || progress.current < 0) return;
      const url = `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(progress.current)}s`;
      // ユーザーが押したときだけブラウザの clipboard API を使う。権限要求や外部送信はしない。
      try { navigator.clipboard?.writeText(url)?.then(() => { copiedUntil = Date.now() + 4000; }).catch(() => {}); } catch { /* 拒否時も再生操作は維持する。 */ }
    }

    function indicator(key, text, highlighted = false) {
      const button = buttons.get(key);
      if (!button) return;
      button.hidden = !text;
      const shown = key === "showCurrent" && text && copiedUntil > Date.now() ? config.labels.copied : text;
      if (button.textContent !== shown) button.textContent = shown;
      button.classList.toggle("__cpa-ypc-active", highlighted);
      button.setAttribute("aria-label", `${config.labels[key]}: ${shown}`);
    }

    function liveTick() {
      const settings = config.settings.latency;
      const stats = call("getStatsForNerds");
      const progress = call("getProgressState");
      const live = stats?.live_latency_style === "" && progress && Number.isFinite(progress.current) && Number.isFinite(progress.seekableEnd);
      const playing = video && !video.paused && !video.ended && !isAd() && call("getPlayerState") !== 2;
      if (!config.features.liveLatency || !live || !playing) {
        releaseRate();
        for (const key of ["showPlaybackRate", "showLatency", "showHealth", "showEstimation", "showCurrent"]) indicator(key, "");
        return;
      }
      const health = Number.parseFloat(stats.buffer_health_seconds);
      const latency = Number.parseFloat(stats.live_latency_secs);
      const segment = Number.parseFloat(call("getVideoStats")?.segduration);
      const latencyClass = call("getPlayerResponse")?.videoDetails?.latencyClass;
      const fallback = latencyClass?.endsWith("ULTRA_LOW") ? 1 : latencyClass?.endsWith("_LOW") ? 2 : 5;
      const threshold = settings.smoothAuto ? (Number.isFinite(segment) && segment > 0 ? segment : fallback) * 2 : settings.smoothThreshold;
      // 手動変更した速度を以後の追従処理で上書きしない。
      detectManualRate();
      const playerRate = call("getPlaybackRate");
      if (!automatic && (video.playbackRate !== 1 || (Number.isFinite(playerRate) && playerRate !== 1))) manualRate = true;
      if (!automatic && video.playbackRate === 1 && playerRate === 1) manualRate = false;
      const accelerate = settings.enabled && !manualRate && Number.isFinite(health) && (settings.smooth ? health >= threshold : progress.isAtLiveHead === false);
      if (accelerate) {
        if (!automatic) automatic = { video, original: video.playbackRate, last: video.playbackRate, playerRate: Number.isFinite(playerRate) ? playerRate : null };
        automatic.last = settings.playbackRate;
        try { video.playbackRate = automatic.last; } catch { automatic = null; }
      } else releaseRate();
      const delay = progress.seekableEnd - progress.current;
      if (settings.skip && delay >= settings.skipThreshold && Date.now() - lastSkip > 5000) {
        lastSkip = Date.now();
        call("seekToLiveHead");
        call("playVideo");
      }
      indicator("showPlaybackRate", `${video.playbackRate.toFixed(2)}x`, !!automatic);
      indicator("showLatency", progress.isAtLiveHead ? (Number.isFinite(latency) ? `${latency.toFixed(2)}s` : "") : "(DVR)");
      indicator("showHealth", Number.isFinite(health) ? `${health.toFixed(2)}s` : "", settings.enabled && health >= threshold);
      indicator("showCurrent", progress.isAtLiveHead ? formatTime(progress.current) : `${formatTime(progress.current)} / ${formatTime(progress.seekableEnd)}`);
      ends.push(progress.seekableEnd);
      if (ends.length > 20) ends.shift();
      const ended = ends.length === 20 && ends.every((value) => value === ends[0]);
      const seconds = delay / (ended ? video.playbackRate : video.playbackRate - 1);
      indicator("showEstimation", !progress.isAtLiveHead && Number.isFinite(seconds) && seconds >= 0 ? `(${new Date(Date.now() + seconds * 1000).toLocaleTimeString()})` : "");
    }

    function tick() {
      if (dead) return;
      if (Date.now() - lastSeen > 7000) {
        shutdown();
        window.postMessage(JSON.stringify({ channel: CHANNEL, session, type: "expired" }), location.origin);
        return;
      }
      if (!validPage()) return resetPlayer();
      const nextPlayer = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
      const nextVideo = nextPlayer?.querySelector("video.html5-main-video, video");
      const nextId = (() => { try { return nextPlayer?.getVideoData?.()?.video_id || null; } catch { return null; } })();
      if (player !== nextPlayer || video !== nextVideo || videoId !== nextId) {
        resetPlayer();
        player = nextPlayer;
        video = nextVideo;
        videoId = nextId;
      }
      if (!player || !video || !config) return;
      mountUI();
      const visible = !isAd();
      if (controls) controls.hidden = !visible;
      player.classList.toggle("__cpa-ypc-hide-slider", visible && config.features.playerVolume && config.settings.volume.hideSlider);
      player.classList.toggle("__cpa-ypc-hide-volume", visible && config.features.playerVolume && config.settings.volume.hideVolumeIcon);
      liveTick();
      updateSelection();
    }

    window.addEventListener("message", onMessage);
    document.addEventListener("yt-navigate-start", resetPlayer);
    window.addEventListener("pagehide", onPageHide);
    // 開始だけ届いて設定が続かないセッションは自動撤去する。
    const bootstrapTimeout = setTimeout(() => {
      if (config) return;
      shutdown();
      window.postMessage(JSON.stringify({ channel: CHANNEL, session, type: "expired" }), location.origin);
    }, 7000);
    window.postMessage(JSON.stringify({ channel: CHANNEL, session, type: "ready" }), location.origin);
    return shutdown;
  }

  let currentSession = null;
  let dispose = null;
  // 文書単位の開始受付は残し、機能 OFF 後も新しいセッションを開始できるようにする。
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || typeof event.data !== "string" || event.data.length > 256) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.channel !== CHANNEL || data.type !== "start" || typeof data.session !== "string" || !/^[a-f0-9-]{36}$/.test(data.session)) return;
    if (data.session === currentSession) return;
    // 撤去済み slot の古い開始通知で、現在のセッションを置き換えない。
    if (!document.querySelector(`.__cpa-ypc-player[data-cpa-player-session="${data.session}"]`)) return;
    dispose?.();
    currentSession = data.session;
    dispose = startEngine(currentSession);
  });
  window.postMessage(JSON.stringify({ channel: CHANNEL, type: "available" }), location.origin);
})();
