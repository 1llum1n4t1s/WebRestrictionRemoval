"use strict";

/**
 * Instagram 動画シークバー + Space 再生切替。
 * InstagramCleaner の master AND videoControls でのみ起動し、OFF 時は挿入 DOM・監視・キー購読を全撤去する。
 */
(() => {
  if (window.__cpaInstagramVideoControlsRunning) return;
  window.__cpaInstagramVideoControlsRunning = true;
  if (window !== window.top) return;

  const PARENT_CLASS = InstagramCleaner.VIDEO_CONTROL_PARENT_CLASS;
  const CONTROL_CLASS = InstagramCleaner.VIDEO_CONTROL_CLASS;
  /** @type {Map<HTMLVideoElement, { videoParent: HTMLElement, container: HTMLElement, fallbackParent: boolean, root: HTMLElement, range: HTMLInputElement, time: HTMLOutputElement, dragging: boolean, listeners: Array<[string, EventListener]> }>} */
  const controls = new Map();
  const controlVideos = new WeakMap();
  let masterEnabled = false;
  let features = InstagramCleaner.mergeFeatures({});
  let running = false;
  let observer = null;
  let scanFrame = null;
  let contextTimer = null;
  let lastActiveVideo = null;
  let handledSpace = false;

  const msg = (key, fallback) => {
    try {
      return chrome.i18n.getMessage(key) || fallback;
    } catch {
      return fallback;
    }
  };

  CleanerCore.subscribe({
    masterKey: StorageKeys.INSTAGRAM_CLEANER_ENABLED,
    featuresKey: StorageKeys.INSTAGRAM_CLEANER_FEATURES,
    applyAction: Actions.APPLY_INSTAGRAM_CLEANER_CS,
    mergeFeatures: (raw) => InstagramCleaner.mergeFeatures(raw),
    onUpdate: (patch) => {
      if ("active" in patch) masterEnabled = patch.active;
      if ("features" in patch) features = patch.features;
      if (masterEnabled && features.videoControls === true) start();
      else stop();
    },
  });

  function start() {
    if (running) {
      scheduleScan();
      return;
    }
    running = true;
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    observer = new MutationObserver(scheduleScan);
    if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
    contextTimer = setInterval(checkContext, 5000);
    scheduleScan();
  }

  function stop() {
    if (!running && controls.size === 0) return;
    running = false;
    handledSpace = false;
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    observer?.disconnect();
    observer = null;
    if (scanFrame !== null) cancelAnimationFrame(scanFrame);
    scanFrame = null;
    if (contextTimer !== null) clearInterval(contextTimer);
    contextTimer = null;
    for (const video of [...controls.keys()]) detach(video);
    lastActiveVideo = null;
  }

  function checkContext() {
    if (!chrome.runtime?.id) {
      masterEnabled = false;
      features = InstagramCleaner.mergeFeatures({});
      stop();
      return;
    }
    scheduleScan();
  }

  function scheduleScan() {
    if (!running || scanFrame !== null) return;
    scanFrame = requestAnimationFrame(() => {
      scanFrame = null;
      scan();
    });
  }

  function scan() {
    if (!running) return;
    if (!chrome.runtime?.id) {
      checkContext();
      return;
    }
    for (const [video, record] of controls) {
      if (isBlockedVideo(video) || !video.isConnected || !record.container.isConnected || video.parentElement !== record.videoParent ||
          record.root.parentElement !== record.container ||
          (record.fallbackParent && findPlayerOverlay(video) !== null)) {
        detach(video);
      }
    }
    for (const video of document.querySelectorAll("video")) attach(video);
  }

  function attach(video) {
    if (controls.has(video) || isBlockedVideo(video)) return;
    const videoParent = video.parentElement;
    if (!videoParent || videoParent === document.body || videoParent === document.documentElement) return;
    const playerOverlay = findPlayerOverlay(video);
    const container = playerOverlay || findPositionedContainer(video);
    if (!container) return;
    const fallbackParent = playerOverlay === null;
    // 拡張更新直後、旧 isolated world の context cleanup より先に再注入された場合の孤児 UI を除去する。
    for (const orphan of container.querySelectorAll(":scope > ." + CONTROL_CLASS)) {
      if (!controlVideos.has(orphan)) orphan.remove();
    }

    const root = document.createElement("div");
    root.className = CONTROL_CLASS;
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", msg("instagramVideoControlsAria", "Video seek controls"));
    root.hidden = true;

    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "0";
    range.step = "0.01";
    range.value = "0";
    range.setAttribute("aria-label", msg("instagramVideoSeekAria", "Video position"));

    const time = document.createElement("output");
    time.className = CONTROL_CLASS + "-time";
    time.textContent = "0:00 / 0:00";
    time.setAttribute("aria-hidden", "true");
    root.append(range, time);
    if (fallbackParent) container.classList.add(PARENT_CLASS);
    container.append(root);

    const record = { videoParent, container, fallbackParent, root, range, time, dragging: false, listeners: [] };
    controls.set(video, record);
    controlVideos.set(root, video);
    const listen = (type, listener) => {
      video.addEventListener(type, listener);
      record.listeners.push([type, listener]);
    };
    const sync = () => {
      if (!chrome.runtime?.id) {
        checkContext();
        return;
      }
      syncControl(video, record);
    };
    for (const type of ["loadedmetadata", "durationchange", "timeupdate", "emptied"]) listen(type, sync);
    listen("play", () => {
      lastActiveVideo = video;
      sync();
    });
    listen("pause", sync);
    listen("pointerdown", () => { lastActiveVideo = video; });

    range.addEventListener("pointerdown", (event) => {
      record.dragging = true;
      try {
        range.setPointerCapture(event.pointerId);
      } catch {}
    });
    const finishDragging = () => {
      record.dragging = false;
      syncControl(video, record);
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture", "change"]) {
      range.addEventListener(type, finishDragging);
    }
    range.addEventListener("input", () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const next = Math.min(duration, Math.max(0, Number(range.value)));
      video.currentTime = next;
      lastActiveVideo = video;
      updateTime(record, next, duration);
    });
    // React の modal close / swipe / click handler へシーク操作を伝播させない。
    for (const type of ["click", "dblclick", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"]) {
      // bubble で止め、range 自身の pointer/input 処理は先に実行させる。
      root.addEventListener(type, (event) => event.stopPropagation());
    }
    syncControl(video, record);
  }

  /**
   * Instagram は video より上の stacking context に同寸の操作 overlay を置く。
   * 同寸で絶対配置された操作 group 内へ入れ、UI 言語に依存せず操作を届ける。
   */
  function findPlayerOverlay(video) {
    const videoRect = video.getBoundingClientRect();
    if (videoRect.width <= 0 || videoRect.height <= 0) return null;
    let scope = video.parentElement;
    for (let depth = 0; scope && scope !== document.body && depth < 14; depth++, scope = scope.parentElement) {
      const candidates = scope.querySelectorAll('[role="group"][aria-label]');
      for (const candidate of candidates) {
        if (candidate.contains(video) || candidate.classList.contains(CONTROL_CLASS) ||
            candidate.querySelector("video") || getComputedStyle(candidate).position !== "absolute") continue;
        const rect = candidate.getBoundingClientRect();
        const tolerance = 4;
        if (Math.abs(rect.left - videoRect.left) <= tolerance &&
            Math.abs(rect.top - videoRect.top) <= tolerance &&
            Math.abs(rect.width - videoRect.width) <= tolerance &&
            Math.abs(rect.height - videoRect.height) <= tolerance) {
          return candidate;
        }
      }
    }
    return null;
  }

  /**
   * 純正 overlay がまだ hydrate されていない初期描画用。video と同寸かつ既に positioned の
   * 祖先だけを使う。static 親を relative に変えると absolute video の高さ基準が壊れるため変更しない。
   */
  function findPositionedContainer(video) {
    const videoRect = video.getBoundingClientRect();
    let candidate = video.parentElement;
    for (let depth = 0; candidate && candidate !== document.body && depth < 10;
      depth++, candidate = candidate.parentElement) {
      const rect = candidate.getBoundingClientRect();
      const tolerance = 4;
      if (getComputedStyle(candidate).position !== "static" &&
          Math.abs(rect.left - videoRect.left) <= tolerance &&
          Math.abs(rect.top - videoRect.top) <= tolerance &&
          Math.abs(rect.width - videoRect.width) <= tolerance &&
          Math.abs(rect.height - videoRect.height) <= tolerance) {
        return candidate;
      }
    }
    return null;
  }

  function detach(video) {
    const record = controls.get(video);
    if (!record) return;
    controls.delete(video);
    for (const [type, listener] of record.listeners) video.removeEventListener(type, listener);
    record.root.remove();
    if (record.fallbackParent && !record.container.querySelector("." + CONTROL_CLASS)) {
      record.container.classList.remove(PARENT_CLASS);
    }
    if (lastActiveVideo === video) lastActiveVideo = null;
  }

  function syncControl(video, record) {
    const duration = video.duration;
    const ready = Number.isFinite(duration) && duration > 0;
    record.root.hidden = !ready;
    if (!ready) return;
    record.range.max = String(duration);
    if (!record.dragging) record.range.value = String(Math.min(duration, Math.max(0, video.currentTime || 0)));
    updateTime(record, Number(record.range.value), duration);
  }

  function updateTime(record, current, duration) {
    const currentText = InstagramCleaner.formatVideoTime(current);
    const durationText = InstagramCleaner.formatVideoTime(duration);
    record.time.textContent = `${currentText} / ${durationText}`;
    record.range.setAttribute("aria-valuetext", `${currentText} / ${durationText}`);
  }

  function isControlTarget(target) {
    return target instanceof Element && target.closest("." + CONTROL_CLASS) !== null;
  }

  function controlVideo(target) {
    if (!(target instanceof Element)) return null;
    const root = target.closest("." + CONTROL_CLASS);
    return root ? controlVideos.get(root) ?? null : null;
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    return target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]'
    ) !== null;
  }

  function visibleArea(video) {
    if (video.closest('[hidden], [aria-hidden="true"]')) return 0;
    const style = getComputedStyle(video);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return 0;
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 0;
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function pickVideo() {
    const candidates = [...controls.keys()].map((video) => ({
      video,
      visibleArea: video.isConnected ? visibleArea(video) : 0,
      playing: !video.paused && !video.ended,
      recent: video === lastActiveVideo,
      dialog: video.closest('[role="dialog"]') !== null,
    }));
    return InstagramCleaner.selectVideoCandidate(candidates)?.video ?? null;
  }

  function blockKeyEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onKeyDown(event) {
    if (!running || !InstagramCleaner.isSpaceKey(event.key, event.code)) return;
    if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    const ownControlVideo = isControlTarget(event.target) ? controlVideo(event.target) : null;
    if (!ownControlVideo && isEditableTarget(event.target)) return;
    const video = ownControlVideo || pickVideo();
    if (!video || isBlockedVideo(video)) return;
    blockKeyEvent(event);
    handledSpace = true;
    if (event.repeat) return;
    lastActiveVideo = video;
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
  }

  function onKeyUp(event) {
    if (!running || !InstagramCleaner.isSpaceKey(event.key, event.code)) return;
    if (!handledSpace) return;
    blockKeyEvent(event);
    handledSpace = false;
  }

  function isBlockedVideo(video) {
    return features.blockVideos === true && video.closest("article") !== null;
  }
})();
