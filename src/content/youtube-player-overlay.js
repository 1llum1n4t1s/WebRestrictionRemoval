// プレイヤー操作・配信時刻が共有する表示先。データと設定は各機能が所有する。
(() => {
  "use strict";
  if (window.__cpaYouTubeOverlay) return;

  const order = ["player", "broadcast"];
  const sections = new Map();
  let root = null;
  let observer = null;
  let resizeObserver = null;
  let observedPlayer = null;
  let observedArea = null;
  let frame = null;
  let heartbeat = null;
  let stopped = false;

  function releaseHost() {
    observer?.disconnect();
    observer = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    observedPlayer = null;
    observedArea = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    clearInterval(heartbeat);
    heartbeat = null;
    root?.remove();
    root = null;
  }

  function shutdown() {
    stopped = true;
    releaseHost();
    sections.clear();
  }

  function sync() {
    try {
      if (!chrome.runtime.id) return shutdown();
    } catch {
      return shutdown();
    }
    if (!root || !sections.size) return;
    const targetPage = location.pathname === "/watch" || /^\/(embed|live)\//.test(location.pathname);
    const player = targetPage && (document.getElementById("movie_player") || document.querySelector(".html5-video-player"));
    const area = player && (player.querySelector(".ytp-chrome-bottom") || player.querySelector("player-fullscreen-action-menu .quick-actions-wrapper") || player.querySelector(".ytp-left-controls") || player.querySelector(".ytwPlayerControlsLeftControls") ||
      // 埋め込みの新 UI では操作欄が #movie_player の兄弟として生成される。
      (/^\/embed\//.test(location.pathname) && document.querySelector("#player-controls player-fullscreen-action-menu .quick-actions-wrapper")));
    if (!area) {
      root.remove();
      return;
    }
    if (root.parentElement !== area) area.append(root);
    // 操作欄の直上から動画の上端まで使い、全画面・シアター・埋め込みの寸法に追従する。
    const areaRect = area.getBoundingClientRect();
    const playerRect = player.getBoundingClientRect();
    const availableHeight = Math.max(0, areaRect.top - playerRect.top - 8);
    root.style.setProperty("--ypc-available-height", `${availableHeight}px`);
    // 表示先が左側操作群など狭い要素でも、ツールバーは自身の左端から動画の右端までを使う。
    // 配置基準が表示先と異なる場合もあるため、表示先ではなくオーバーレイ自身の左端から測る。
    const availableWidth = Math.max(0, playerRect.right - root.getBoundingClientRect().left - 12);
    root.style.setProperty("--ypc-available-width", `${availableWidth}px`);
    // 設定ポップオーバーはツールバーの上に開くため、ツールバー（折り返しを含む）の高さを差し引く。
    const popoverMax = Math.max(120, availableHeight - root.getBoundingClientRect().height - 8);
    root.style.setProperty("--ypc-popover-max-height", `${popoverMax}px`);
    if (observedPlayer !== player || observedArea !== area) {
      resizeObserver ??= new ResizeObserver(scheduleSync);
      resizeObserver.disconnect();
      resizeObserver.observe(player);
      resizeObserver.observe(area);
      // ツールバーの折り返し・ライブ指標の増減で高さが変わったときもポップオーバーの上限を更新する。
      resizeObserver.observe(root);
      observedPlayer = player;
      observedArea = area;
    }
  }

  function scheduleSync() {
    if (frame === null) frame = requestAnimationFrame(() => { frame = null; sync(); });
  }

  function mount(name, node) {
    if (stopped || !order.includes(name)) return;
    const previous = sections.get(name);
    if (previous && previous !== node) previous.remove();
    sections.set(name, node);
    node.classList.add("__cpa-ypc-section");
    if (!root) {
      root = document.createElement("div");
      root.className = "__cpa-ypc-overlay";
      observer = new MutationObserver((records) => {
        // 各行の数値更新で自分自身の再配置を繰り返さない。
        if (records.some((record) => !root?.contains(record.target))) scheduleSync();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      heartbeat = setInterval(sync, 2000);
    }
    let index = 0;
    for (const key of order) {
      const section = sections.get(key);
      if (!section) continue;
      if (root.children[index] !== section) root.insertBefore(section, root.children[index] || null);
      index++;
    }
    sync();
  }

  function remove(name) {
    sections.get(name)?.remove();
    sections.delete(name);
    // 空の MAIN 用 slot や、プレイヤー再生成中の未接続 section は登録として保持する。
    if (!sections.size) releaseHost();
  }

  window.__cpaYouTubeOverlay = Object.freeze({ mount, remove });
  window.addEventListener("pagehide", (event) => { if (!event.persisted) shutdown(); });
  window.addEventListener("pageshow", () => { if (sections.size) sync(); });
})();
