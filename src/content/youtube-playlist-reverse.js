// YouTube 再生リスト逆順再生（isolated world）
//
// チャンネル側の登録ミスで Part10 → Part1 のように逆向きに並んだ再生リストを、正しい順で見るための
// 機能。動画ページの再生リスト欄に「逆順: ON/OFF」切り替えボタン、再生リストページに「逆順で再生」ボタンを置く。
//
// 役割分担:
//   - 本ファイル: 設定の購読、ボタンの生成（chrome.i18n が使えるのは isolated world だけ）、
//     再生リスト欄の並びを CSS で逆に見せるクラス、逆順にした再生リスト ID の保持。
//   - youtube-playlist-reverse-main.js（MAIN world）: YouTube の移動処理を横取りして逆向きへ移す。
//     本ファイルは postMessage で「今逆順にしている再生リスト ID」を通知し、2 秒ごとに送り直して
//     生存を示す（拡張機能の無効化・更新で途絶えたら MAIN 側が横取りを止めて UI を撤去する）。
//
// 保存: 逆順にした再生リスト ID はタブ単位の sessionStorage にだけ置く（chrome.storage は使わず、
//   設定同期・バックアップの対象外）。再読み込みや SPA 遷移では保たれ、別タブには引き継がない。
//
// 有効化: master `searchFixerEnabled` AND `searchFixerFeatures.playlistReverse`（既定 OFF）。
//   この設定は「ボタンを表示するか」だけを決める。逆順にするかはボタン（再生リスト ID 単位・タブ内）で選び、
//   設定を OFF にするとボタンも逆順も解除される。2 つの ON/OFF を混同させないよう、ボタンは「逆順: ON/OFF」と表示する。
//   OFF・context 失効時はボタン・クラスを撤去し、MAIN 側へ停止を通知する。
//   ミックス（RD〜）は自動生成で終わりのない再生リストのため対象外。

(() => {
  if (window.__cpaPlaylistReverseRunning) return;
  window.__cpaPlaylistReverseRunning = true;
  // 埋め込みプレイヤーには再生リスト欄がないため top frame のみ。
  if (window !== window.top) return;
  if (!chrome?.runtime?.id) return;

  const CHANNEL = "__cpa_youtube_playlist_reverse_v1";
  const SESSION_KEY = "__cpa_yt_playlist_reverse";
  const MAX_LISTS = 50;
  const LIST_RE = /^[\w-]{2,64}$/;
  const PANEL_CLASS = "__cpa-ypr-reversed";
  const TOGGLE_CLASS = "__cpa-ypr-toggle";
  const PLAY_WRAP_CLASS = "__cpa-ypr-play-wrap";
  const PLAY_CLASS = "__cpa-ypr-play";
  const HEARTBEAT_MS = 2000;
  const SVG_NS = "http://www.w3.org/2000/svg";
  // 上下の矢印（並びの入れ替え）。YouTube のアイコンと同じ 24px 枠。
  const ICON_PATH = "M7 3 3 7h3v10h2V7h3L7 3Zm10 18 4-4h-3V7h-2v10h-3l4 4Z";

  // 並びを逆にした直後・動画が切り替わった直後だけ、再生中の動画を一覧内で見える位置へ寄せる。
  // YouTube は元の並びの位置へスクロールするため。期限を設け、利用者が一覧をスクロールしても引き戻さない。
  const SCROLL_WINDOW_MS = 2500;

  const session = crypto.randomUUID();
  let active = false;
  /** @type {{ key: string, until: number } | null} 再生中の動画を見える位置へ寄せる予定 */
  let pendingScroll = null;
  let scrolledKey = null;
  let observer = null;
  let renderScheduled = false;
  let heartbeat = null;
  let lastPosted = undefined;
  /** @type {string[]} 逆順にした再生リスト ID（新しいものが末尾） */
  let reversedLists = loadLists();

  function i18n(key, fallback) {
    try {
      const message = chrome?.i18n?.getMessage?.(key);
      if (message) return message;
    } catch { /* context 失効時は既定文言 */ }
    return fallback;
  }

  function loadLists() {
    try {
      const raw = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter((id) => typeof id === "string" && LIST_RE.test(id)).slice(-MAX_LISTS) : [];
    } catch {
      return [];
    }
  }

  function saveLists() {
    try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(reversedLists)); } catch { /* 保存できなくてもこのページ内では保持する */ }
  }

  function isReversed(listId) {
    return !!listId && reversedLists.includes(listId);
  }

  function setReversed(listId, reversed) {
    reversedLists = reversedLists.filter((id) => id !== listId);
    if (reversed) reversedLists.push(listId);
    reversedLists = reversedLists.slice(-MAX_LISTS);
    saveLists();
  }

  /** URL の再生リスト ID。ミックス（RD〜）と不正な値は対象外。 */
  function currentListId() {
    const id = new URLSearchParams(location.search).get("list");
    return id && LIST_RE.test(id) && !id.startsWith("RD") ? id : null;
  }

  function post(message) {
    try { window.postMessage(JSON.stringify({ channel: CHANNEL, session, ...message }), location.origin); } catch { /* 文書破棄中 */ }
  }

  /** 動画ページで逆順にしている再生リスト ID を MAIN 側へ通知する（heartbeat を兼ねる）。 */
  function postState(force = false) {
    const listId = location.pathname === "/watch" && isReversed(currentListId()) ? currentListId() : null;
    if (!force && listId === lastPosted) return;
    lastPosted = listId;
    post({ type: "state", listId });
  }

  // ---------- UI ----------

  function createIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICON_PATH);
    svg.append(path);
    return svg;
  }

  function stopEvent(event) {
    // 再生リスト欄の見出しはクリックで折りたたまれるため、ボタン操作を親へ伝えない。
    event.preventDefault();
    event.stopPropagation();
  }

  function createToggle() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = TOGGLE_CLASS;
    // 文言は updateToggle が「逆順: ON / OFF」の状態表示に更新する（機能設定の ON/OFF と混同させない）。
    const label = document.createElement("span");
    label.className = "__cpa-ypr-state";
    button.append(createIcon(), label);
    button.addEventListener("click", (event) => {
      stopEvent(event);
      const listId = currentListId();
      if (!listId) return;
      setReversed(listId, !isReversed(listId));
      // ON にした直後も再生中の動画を見える位置へ寄せる。
      scrolledKey = null;
      pendingScroll = null;
      render();
    });
    return button;
  }

  function updateToggle(button, reversed) {
    const pressed = String(reversed);
    if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    const title = reversed
      ? i18n("ytPlaylistReverseOnTitle", "Playing in reverse order (click to restore the original order)")
      : i18n("ytPlaylistReverseOffTitle", "Play this playlist in reverse order");
    if (button.title !== title) button.title = title;
    const text = reversed
      ? i18n("ytPlaylistReverseStateOn", "Reverse: ON")
      : i18n("ytPlaylistReverseStateOff", "Reverse: OFF");
    const label = button.querySelector(".__cpa-ypr-state");
    if (label && label.textContent !== text) label.textContent = text;
  }

  /** 動画ページの再生リスト欄（ループ・シャッフルの並び）に切り替えボタンを置く。 */
  function renderPanels(listId) {
    const reversed = isReversed(listId);
    for (const panel of document.querySelectorAll("ytd-playlist-panel-renderer")) {
      const container = panel.querySelector("#playlist-action-menu #top-level-buttons-computed")
        || panel.querySelector("#playlist-action-menu");
      let button = panel.querySelector(`.${TOGGLE_CLASS}`);
      if (!listId || !container) {
        button?.remove();
        panel.classList.remove(PANEL_CLASS);
        continue;
      }
      if (button && button.parentElement !== container) {
        button.remove();
        button = null;
      }
      if (!button) {
        button = createToggle();
        container.append(button);
      }
      updateToggle(button, reversed);
      // 並びは CSS（column-reverse）で逆に見せるだけで、YouTube の DOM 順は変えない。
      panel.classList.toggle(PANEL_CLASS, reversed);
      if (reversed) revealSelected(panel, listId);
    }
  }

  /** 再生中の動画が一覧の表示範囲外なら、一覧の中だけをスクロールして中央へ寄せる（ページはスクロールしない）。 */
  function revealSelected(panel, listId) {
    const key = `${listId}:${new URLSearchParams(location.search).get("v") || ""}`;
    if (scrolledKey !== key && pendingScroll?.key !== key) pendingScroll = { key, until: Date.now() + SCROLL_WINDOW_MS };
    if (pendingScroll?.key !== key) return;
    if (Date.now() > pendingScroll.until) {
      pendingScroll = null;
      scrolledKey = key;
      return;
    }
    const selected = panel.querySelector("ytd-playlist-panel-video-renderer[selected]");
    const items = panel.querySelector("#items");
    let scroller = items?.parentElement;
    while (scroller && scroller !== panel && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
    if (!selected || !scroller || scroller === panel) return;
    const view = scroller.getBoundingClientRect();
    const box = selected.getBoundingClientRect();
    if (box.height === 0 || view.height === 0) return;
    if (box.top < view.top || box.bottom > view.bottom) {
      scroller.scrollTop += box.top - view.top - (view.height - box.height) / 2;
    }
  }

  /** 再生リストページで、読み込み済みの最後の動画を探す（index 引数が最大のリンク）。 */
  function lastItemLink(root, listId) {
    let best = null;
    for (const anchor of root.querySelectorAll('a[href*="/watch"]')) {
      let url;
      try { url = new URL(anchor.href, location.origin); } catch { continue; }
      if (url.origin !== location.origin || url.searchParams.get("list") !== listId) continue;
      const index = Number(url.searchParams.get("index"));
      if (Number.isInteger(index) && index > 0 && (!best || index > best.index)) best = { anchor, index };
    }
    return best?.anchor ?? null;
  }

  function createPlayButton(root) {
    const wrap = document.createElement("div");
    wrap.className = PLAY_WRAP_CLASS;
    const button = document.createElement("button");
    button.type = "button";
    button.className = PLAY_CLASS;
    const label = document.createElement("span");
    label.textContent = i18n("ytPlaylistReversePlay", "Play in reverse");
    button.title = i18n("ytPlaylistReversePlayTitle", "Start from the last video and play toward the first");
    button.append(createIcon(), label);
    button.addEventListener("click", (event) => {
      stopEvent(event);
      const listId = currentListId();
      if (!listId) return;
      const anchor = lastItemLink(root, listId);
      if (!anchor) return;
      setReversed(listId, true);
      // YouTube 自身のリンクを押して SPA 遷移させる（独自の URL 組み立て・再読み込みをしない）。
      anchor.click();
    });
    wrap.append(button);
    return wrap;
  }

  /** 再生リストページの「すべて再生」の隣に「逆順で再生」を置く。 */
  function renderPlaylistPage(listId) {
    const browse = document.querySelector('ytd-browse[page-subtype="playlist"]:not([hidden])');
    const placed = new Set();
    if (listId && browse) {
      for (const actions of browse.querySelectorAll("yt-flexible-actions-view-model")) {
        // 「すべて再生」は同じ再生リストの /watch へのリンクを持つ。持たない操作列には置かない。
        const playAll = [...actions.querySelectorAll('a[href*="/watch"]')].find((anchor) => {
          try { return new URL(anchor.href, location.origin).searchParams.get("list") === listId; } catch { return false; }
        });
        if (!playAll) continue;
        const action = playAll.closest(".ytFlexibleActionsViewModelAction") || playAll.parentElement;
        let wrap = actions.querySelector(`.${PLAY_WRAP_CLASS}`);
        if (!wrap) {
          wrap = createPlayButton(browse);
          action.after(wrap);
        }
        placed.add(wrap);
      }
    }
    for (const wrap of document.querySelectorAll(`.${PLAY_WRAP_CLASS}`)) {
      if (!placed.has(wrap)) wrap.remove();
    }
  }

  function removeUI() {
    for (const el of document.querySelectorAll(`.${TOGGLE_CLASS}, .${PLAY_WRAP_CLASS}`)) el.remove();
    for (const el of document.querySelectorAll(`.${PANEL_CLASS}`)) el.classList.remove(PANEL_CLASS);
  }

  function render() {
    if (!active) return;
    if (!chrome?.runtime?.id) {
      deactivate();
      return;
    }
    const listId = currentListId();
    renderPanels(location.pathname === "/watch" ? listId : null);
    renderPlaylistPage(location.pathname === "/playlist" ? listId : null);
    postState();
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  function onMessage(event) {
    if (event.source !== window || event.origin !== location.origin || typeof event.data !== "string" || event.data.length > 256) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    // MAIN 側が後から読み込まれた場合も、すぐに現在の状態を渡す。
    if (data?.channel === CHANNEL && data.type === "available" && active) postState(true);
  }

  // ---------- activate / deactivate ----------

  function activate() {
    if (active) return;
    active = true;
    reversedLists = loadLists();
    lastPosted = undefined;
    observer = new MutationObserver(scheduleRender);
    try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch { /* 文書破棄中 */ }
    document.addEventListener("yt-navigate-finish", scheduleRender, true);
    window.addEventListener("message", onMessage);
    heartbeat = setInterval(() => {
      if (!chrome?.runtime?.id) {
        deactivate();
        return;
      }
      postState(true);
    }, HEARTBEAT_MS);
    render();
  }

  function deactivate() {
    if (!active) {
      removeUI();
      return;
    }
    active = false;
    observer?.disconnect();
    observer = null;
    clearInterval(heartbeat);
    heartbeat = null;
    document.removeEventListener("yt-navigate-finish", scheduleRender, true);
    window.removeEventListener("message", onMessage);
    removeUI();
    lastPosted = undefined;
    post({ type: "stop" });
  }

  CleanerCore.subscribeStored({
    keys: [StorageKeys.SEARCH_FIXER_ENABLED, StorageKeys.SEARCH_FIXER_FEATURES],
    applyAction: Actions.APPLY_SEARCH_FIXER_CS,
    onStored(stored) {
      const on = stored[StorageKeys.SEARCH_FIXER_ENABLED] === true
        && SearchFixer.mergeFeatures(stored[StorageKeys.SEARCH_FIXER_FEATURES]).playlistReverse === true;
      if (on) activate();
      else deactivate();
    },
  });

  // bfcache 凍結は状態を残し、実際の破棄だけ解放する（youtube-broadcast-clock.js と同じ）。
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) deactivate();
  });
})();
