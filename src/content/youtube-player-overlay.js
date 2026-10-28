// プレイヤー操作・接続モニター・配信時刻が共有する表示先。データと設定は各機能が所有する。
(() => {
  "use strict";
  if (window.__cpaYouTubeOverlay) return;

  const order = ["player", "broadcast", "connection"];
  const sections = new Map();
  let root = null;
  let observer = null;
  let frame = null;
  let heartbeat = null;
  let stopped = false;

  function releaseHost() {
    observer?.disconnect();
    observer = null;
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
