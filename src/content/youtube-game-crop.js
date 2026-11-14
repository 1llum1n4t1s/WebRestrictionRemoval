// YouTube ゲーム画面拡大（isolated world）
//
// 配信者が動画の外側に枠・コメント欄・立ち絵を置き、ゲーム映像を一部にクロップしている配信で、
// 利用者が指定した範囲だけをプレーヤー全体へ拡大して見せる。
//
// 操作: プレーヤーのオーバーレイに「ゲーム画面」チップを出す。
//   - 「範囲を指定」: 動画全体を見せ、ドラッグで囲んだ範囲を保存して拡大をオンにする（Esc で取消）
//   - 「拡大: ON/OFF」: 保存済みの範囲を使うかどうかの切り替え（範囲は消さない）
//   - 「削除」: 保存した範囲を消す
//
// 保存: 範囲は動画フレームに対する割合（解像度・画質・プレーヤーの大きさが変わってもずれない）で、
//   チャンネルごとに youtube.com の localStorage へ置く（端末内のみ。設定同期・バックアップ・
//   開発者への送信の対象外）。同じチャンネルの別の動画でも自動で同じ範囲を使い、タブ間でも共有する。
//   チャンネルを特定できないページでは、その動画の間だけメモリに保持する。
//
// 表示: video 要素の個別プロパティ translate / scale / clip-path と transform-origin だけを書き、
//   元の inline 値は退避して OFF・撤去・広告中に復元する（transform は黒帯除去と衝突しないよう使わない。
//   併用は想定しない）。レイアウト変化（リサイズ・全画面・画質切替）は ResizeObserver と style の監視で追従する。
//
// 有効化: master `searchFixerEnabled` AND `searchFixerFeatures.gameCrop`（既定 OFF）。
//   この設定は「チップを出すか」だけを決め、OFF にするとチップも拡大も解除される（範囲は残す）。

(() => {
  if (window.__cpaGameCropRunning) return;
  window.__cpaGameCropRunning = true;
  // 埋め込みプレーヤー（iframe）には介入しない。
  if (window !== window.top) return;
  if (!chrome?.runtime?.id) return;

  const Crop = SearchFixer.GAME_CROP;
  const STORE_KEY = Crop.STORAGE_KEY;
  const SECTION_CLASS = "__cpa-gc-section";
  const LAYER_CLASS = "__cpa-gc-layer";
  const PROPS = ["translate", "scale", "clip-path", "transform-origin"];

  let active = false;
  let observer = null;
  let resizeObserver = null;
  let videoObserver = null;
  let observedPlayer = null;
  let observedVideo = null;
  /** video に付けた listener の一括解除用 */
  let videoListeners = null;
  let renderScheduled = false;
  let section = null;
  let parts = null;
  /** 選択中のレイヤー情報（null = 選択していない） */
  let selecting = null;
  /** チャンネルを特定できない動画の範囲（動画 ID → 範囲）。保存しない。 */
  const temporary = new Map();
  /** 保存データ（チャンネルキー → 範囲）。localStorage の写し。 */
  let store = loadStore();
  /** video → 退避した元の inline 値 */
  const originals = new WeakMap();
  let lastApplied = "";

  function i18n(key, fallback) {
    try {
      const message = chrome?.i18n?.getMessage?.(key);
      if (message) return message;
    } catch { /* context 失効時は既定文言 */ }
    return fallback;
  }

  // ---------- 保存 ----------

  function loadStore() {
    try { return Crop.normalizeStore(JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}")); } catch { return {}; }
  }

  function saveStore() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(Crop.normalizeStore(store))); } catch { /* 保存できなくてもこのページ内では保持する */ }
  }

  function onStorage(event) {
    if (event.key !== STORE_KEY && event.key !== null) return;
    store = loadStore();
    scheduleRender();
  }

  // ---------- ページ・プレーヤー ----------

  function isWatchPage() {
    return location.pathname === "/watch" || location.pathname.startsWith("/live/");
  }

  function findPlayer() {
    return isWatchPage() ? (document.getElementById("movie_player") || document.querySelector(".html5-video-player")) : null;
  }

  function findVideo(player) {
    return player?.querySelector("video.html5-main-video") || player?.querySelector("video") || null;
  }

  function isAd(player) {
    return player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");
  }

  function videoId() {
    return new URLSearchParams(location.search).get("v") || location.pathname.split("/")[2] || "";
  }

  /** 動画の投稿チャンネルの識別子。取得できないときは null。 */
  function currentChannelKey() {
    const links = document.querySelectorAll(
      "ytd-watch-metadata ytd-video-owner-renderer a[href], #owner a[href], ytd-watch-metadata #channel-name a[href]"
    );
    for (const link of links) {
      const key = Crop.channelKey(link.getAttribute("href"));
      if (key) return key;
    }
    return null;
  }

  /** 現在の動画の保存キーと、保存対象かどうか。 */
  function currentTarget() {
    const channel = currentChannelKey();
    return channel ? { key: channel, persistent: true } : { key: `v:${videoId()}`, persistent: false };
  }

  function getRegion(target) {
    return target.persistent ? store[target.key] ?? null : temporary.get(target.key) ?? null;
  }

  function setRegion(target, region) {
    if (target.persistent) {
      // 最近使ったものを末尾に置き、上限を超えた古いものから捨てる。
      delete store[target.key];
      if (region) store[target.key] = region;
      store = Crop.normalizeStore(store);
      saveStore();
    } else if (region) temporary.set(target.key, region);
    else temporary.delete(target.key);
  }

  // ---------- 映像への適用 ----------

  /** video 要素のプレーヤー内の位置（offset の連鎖。transform の影響を受けない）。 */
  function layoutBox(video, player) {
    let left = 0;
    let top = 0;
    let el = video;
    while (el && el !== player) {
      left += el.offsetLeft;
      top += el.offsetTop;
      el = el.offsetParent;
    }
    if (el !== player) return null;
    return { left, top, width: video.offsetWidth, height: video.offsetHeight };
  }

  /** 要素内の映像部分（object-fit: contain 相当）。映像サイズが未確定なら要素全体。 */
  function contentRect(box, video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!(vw > 0) || !(vh > 0)) return box;
    const scale = Math.min(box.width / vw, box.height / vh);
    const width = vw * scale;
    const height = vh * scale;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
  }

  function restoreVideo(video) {
    const saved = originals.get(video);
    if (!saved) return;
    for (const prop of PROPS) {
      if (saved[prop].value) video.style.setProperty(prop, saved[prop].value, saved[prop].priority);
      else video.style.removeProperty(prop);
    }
    originals.delete(video);
    lastApplied = "";
  }

  function applyToVideo(video, player, region) {
    const box = layoutBox(video, player);
    const view = box && Crop.computeView(region, contentRect(box, video), { width: player.clientWidth, height: player.clientHeight }, box);
    if (!view) {
      restoreVideo(video);
      return;
    }
    const signature = `${view.scale}|${view.translateX}|${view.translateY}|${view.clip}`;
    if (originals.has(video) && signature === lastApplied) return;
    if (!originals.has(video)) {
      const saved = {};
      for (const prop of PROPS) saved[prop] = { value: video.style.getPropertyValue(prop), priority: video.style.getPropertyPriority(prop) };
      originals.set(video, saved);
    }
    lastApplied = signature;
    video.style.setProperty("transform-origin", "0 0", "important");
    video.style.setProperty("scale", String(view.scale), "important");
    video.style.setProperty("translate", `${view.translateX}px ${view.translateY}px`, "important");
    video.style.setProperty("clip-path", view.clip, "important");
  }

  // ---------- 範囲の指定 ----------

  function endSelecting() {
    if (!selecting) return;
    selecting.layer.remove();
    document.removeEventListener("keydown", selecting.onKey, true);
    selecting = null;
  }

  function startSelecting(player, video, target) {
    endSelecting();
    // 全体を見ながら囲めるよう、拡大を一時的に外す。
    restoreVideo(video);
    const layer = document.createElement("div");
    layer.className = LAYER_CLASS;
    const hint = document.createElement("div");
    hint.className = "__cpa-gc-hint";
    hint.textContent = i18n("gcHint", "Drag to select the game screen (Esc to cancel)");
    const rect = document.createElement("div");
    rect.className = "__cpa-gc-rect";
    rect.hidden = true;
    layer.append(hint, rect);
    player.append(layer);

    const startedVideo = videoId();
    let start = null;
    let current = null;
    // 範囲は「映像部分」に対する割合で持つ（適用側の contentRect / computeView と同じ基準）。
    // video 要素と映像の縦横比が違っても、囲んだ範囲がずれないようにする。
    const contentBox = () => {
      const box = video.getBoundingClientRect();
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!(vw > 0) || !(vh > 0)) return box;
      const scale = Math.min(box.width / vw, box.height / vh);
      const width = vw * scale;
      const height = vh * scale;
      return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
    };
    const point = (event) => {
      const box = contentBox();
      return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
    };
    const draw = () => {
      if (!start || !current) return;
      const layerBox = layer.getBoundingClientRect();
      const box = contentBox();
      const x1 = box.left + Math.min(start.x, current.x) * box.width - layerBox.left;
      const y1 = box.top + Math.min(start.y, current.y) * box.height - layerBox.top;
      rect.hidden = false;
      rect.style.left = `${x1}px`;
      rect.style.top = `${y1}px`;
      rect.style.width = `${Math.abs(start.x - current.x) * box.width}px`;
      rect.style.height = `${Math.abs(start.y - current.y) * box.height}px`;
    };
    const clampPoint = (p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) });
    const stop = (event) => { event.preventDefault(); event.stopPropagation(); };

    layer.addEventListener("pointerdown", (event) => {
      stop(event);
      if (event.button !== 0) return;
      layer.setPointerCapture(event.pointerId);
      start = clampPoint(point(event));
      current = start;
      draw();
    });
    layer.addEventListener("pointermove", (event) => {
      stop(event);
      if (!start) return;
      current = clampPoint(point(event));
      draw();
    });
    layer.addEventListener("pointerup", (event) => {
      stop(event);
      if (!start) return;
      const region = Crop.regionFromPoints(start, clampPoint(point(event)));
      endSelecting();
      // 囲んでいる間に別の動画へ移った場合は、前の動画のチャンネルへ保存しない。
      if (region && videoId() === startedVideo) {
        setRegion(target, { ...region, on: true });
      }
      scheduleRender();
    });
    for (const type of ["click", "dblclick", "contextmenu", "wheel"]) layer.addEventListener(type, stop);
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endSelecting();
      scheduleRender();
    };
    document.addEventListener("keydown", onKey, true);
    selecting = { layer, onKey, videoId: startedVideo };
  }

  // ---------- チップ ----------

  function makeButton(className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `__cpa-gc-button ${className}`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function buildSection() {
    section = document.createElement("div");
    section.className = `__cpa-ypc-group ${SECTION_CLASS}`;
    const label = document.createElement("span");
    label.className = "__cpa-ypc-label";
    label.textContent = i18n("gcLabel", "Game screen");
    parts = {
      label,
      toggle: makeButton("__cpa-gc-toggle", () => {
        const target = currentTarget();
        const region = getRegion(target);
        if (region) setRegion(target, { ...region, on: !region.on });
        scheduleRender();
      }),
      select: makeButton("__cpa-gc-select", () => {
        const player = findPlayer();
        const video = findVideo(player);
        if (player && video) startSelecting(player, video, currentTarget());
      }),
      remove: makeButton("__cpa-gc-remove", () => {
        setRegion(currentTarget(), null);
        scheduleRender();
      }),
    };
    section.append(label, parts.toggle, parts.select, parts.remove);
    for (const el of [section]) {
      // チップ上の操作が動画の再生切り替えやショートカットへ届かないようにする。
      for (const type of ["dblclick", "keydown", "keyup", "pointerdown"]) el.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  function updateSection(region) {
    const hasRegion = !!region;
    const on = hasRegion && region.on;
    const set = (el, text, title) => {
      if (el.textContent !== text) el.textContent = text;
      if (el.title !== title) el.title = title;
      el.setAttribute("aria-label", title);
    };
    set(parts.toggle,
      on ? i18n("gcToggleOn", "Zoom: ON") : i18n("gcToggleOff", "Zoom: OFF"),
      on ? i18n("gcToggleOnTitle", "Zoomed to the game screen. Click to show the whole video") : i18n("gcToggleOffTitle", "Showing the whole video. Click to zoom to the saved game screen"));
    parts.toggle.setAttribute("aria-pressed", String(on));
    parts.toggle.hidden = !hasRegion;
    set(parts.select,
      hasRegion ? i18n("gcReselect", "Change area") : i18n("gcSelect", "Select area"),
      i18n("gcSelectTitle", "Drag on the video to select the game screen"));
    set(parts.remove, i18n("gcRemove", "Delete"), i18n("gcRemoveTitle", "Delete the saved game screen area for this channel"));
    parts.remove.hidden = !hasRegion;
  }

  // ---------- 描画 ----------

  function releaseVideo() {
    if (observedVideo) restoreVideo(observedVideo);
    videoObserver?.disconnect();
    videoObserver = null;
    videoListeners?.abort();
    videoListeners = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    observedVideo = null;
    observedPlayer = null;
  }

  function removeSection() {
    window.__cpaYouTubeOverlay?.remove("crop");
    section = null;
    parts = null;
  }

  function render() {
    if (!active) return;
    if (!chrome?.runtime?.id) {
      deactivate();
      return;
    }
    const player = findPlayer();
    const video = findVideo(player);
    if (!player || !video) {
      endSelecting();
      releaseVideo();
      removeSection();
      return;
    }
    if (observedPlayer !== player || observedVideo !== video) {
      // プレーヤー・動画が作り直されたときは、旧要素を戻して監視し直す。
      endSelecting();
      releaseVideo();
      observedPlayer = player;
      observedVideo = video;
      resizeObserver = new ResizeObserver(scheduleRender);
      resizeObserver.observe(player);
      resizeObserver.observe(video);
      // YouTube が video の位置・大きさを inline style で変える（画質・全画面・シアター切替）ため追従する。
      videoObserver = new MutationObserver(scheduleRender);
      videoObserver.observe(video, { attributes: true, attributeFilter: ["style"] });
      videoListeners = new AbortController();
      video.addEventListener("loadedmetadata", scheduleRender, { signal: videoListeners.signal });
      video.addEventListener("resize", scheduleRender, { signal: videoListeners.signal });
    }
    // 範囲の指定中に別の動画へ移ったら、指定を終える（前の動画のチャンネルへ保存しない）。
    if (selecting && selecting.videoId !== videoId()) endSelecting();
    const target = currentTarget();
    const region = getRegion(target);
    if (!section) buildSection();
    updateSection(region);
    window.__cpaYouTubeOverlay?.mount("crop", section);
    // 選択中・広告中・OFF・範囲なしは元の表示にする。
    if (selecting || isAd(player) || !region?.on) restoreVideo(video);
    else applyToVideo(video, player, region);
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  // ---------- activate / deactivate ----------

  function activate() {
    if (active) return;
    active = true;
    store = loadStore();
    observer = new MutationObserver((records) => {
      // 自分のチップ・選択レイヤーの更新で再描画を繰り返さない。
      if (records.some((record) => !(section?.contains(record.target) || selecting?.layer.contains(record.target)))) scheduleRender();
    });
    try { observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "href"] }); } catch { /* 文書破棄中 */ }
    document.addEventListener("yt-navigate-finish", scheduleRender, true);
    window.addEventListener("storage", onStorage);
    render();
  }

  function deactivate() {
    const wasActive = active;
    active = false;
    observer?.disconnect();
    observer = null;
    document.removeEventListener("yt-navigate-finish", scheduleRender, true);
    window.removeEventListener("storage", onStorage);
    endSelecting();
    releaseVideo();
    if (wasActive || section) removeSection();
    // 他の動画へ戻ったときに古い要素を掴まないよう、残った video の書き込みも念のため外す。
    for (const video of document.querySelectorAll("video")) restoreVideo(video);
  }

  CleanerCore.subscribeStored({
    keys: [StorageKeys.SEARCH_FIXER_ENABLED, StorageKeys.SEARCH_FIXER_FEATURES],
    applyAction: Actions.APPLY_SEARCH_FIXER_CS,
    onStored(stored) {
      const on = stored[StorageKeys.SEARCH_FIXER_ENABLED] === true
        && SearchFixer.mergeFeatures(stored[StorageKeys.SEARCH_FIXER_FEATURES]).gameCrop === true;
      if (on) activate();
      else deactivate();
    },
  });

  // bfcache 凍結は状態を残し、実際の破棄だけ解放する（youtube-broadcast-clock.js と同じ）。
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) deactivate();
  });
})();
