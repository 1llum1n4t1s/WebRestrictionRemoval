"use strict";

/**
 * YouTube クリーナー content script（独自実装）。
 *
 * YouTube の検索結果・動画ページ・ホームグリッドの冗長 UI を非表示にするための DOM 操作と
 * CSS 注入を行う。外部送信ゼロ。設定は `chrome.storage.local` の `searchFixerEnabled` (master) /
 * `searchFixerFeatures` (個別) / `searchFixerGridItems` (数値) の 3 キーで管理する。
 *
 * 役割:
 *   - 検索結果ページ（/results）で `MutationObserver` を起動し、ノイズ要素を `removeDistractions()` で除去
 *   - 動画ページ（/watch）でタイトル中央配置・説明文フル幅クラスを切り替え
 *   - ホームのリッチグリッドに列数 CSS を注入（4/5/6 のみ、0 は YouTube 既定）
 *   - 検索結果ページのキーワード非マッチ動画を `yt-ext-demoted` クラスでデモート（CSS 側でグレー化）
 *
 * 設計方針:
 *   - 除去カウンタのような動的フィードバック UI は持たない（ポップアップもシンプルなトグル UI に絞る）
 *   - top frame 限定で動かす（埋め込みプレーヤー iframe では検索ページが出ないため）
 *   - master OFF / すべての個別機能 OFF のときは observer / interval / 注入 CSS をすべて停止
 */

(() => {
  // 他 content script の `__cpa*` プレフィックス命名規則と統一（ランタイム内で完結するため互換は不要）。
  if (window.__cpaSearchFixerRunning) return;
  window.__cpaSearchFixerRunning = true;
  // 埋め込みプレーヤー iframe では検索結果が出ないため top のみ
  if (window !== window.top) return;

  /** @type {boolean} master トグル */
  let active = false;
  /** @type {Record<string, boolean>} 個別機能フラグ（定数定義からマージ済み） */
  let features = SearchFixer.mergeFeatures({});
  /** @type {0|4|5|6} ホームグリッド列数（0 = YouTube デフォルト） */
  let gridItems = 0;

  /** @type {MutationObserver|null} 検索ページ用 observer（active=true & 検索ページのとき走らせる） */
  let resultsObserver = null;
  /** @type {boolean} resultsObserver が現在 attach されているか（多重 disconnect 防止） */
  let observerAttached = false;
  /** @type {MutationObserver|null} ライブチャット公式折りたたみ用 observer */
  let liveChatObserver = null;
  /** @type {boolean} liveChatObserver が現在 attach されているか */
  let liveChatObserverAttached = false;
  /** @type {Node|null} liveChatObserver が現在観察しているターゲット（document or frame）。
   *  `reAttachLiveChatObserver` の冪等チェック用。 */
  let liveChatObserverTarget = null;
  /** @type {number} ライブチャット折りたたみ処理の rAF id */
  let liveChatCollapseRaf = 0;

  // 注入する <style> 要素の id（CSS 文字列を更新するときの参照キー）
  const STYLE_ID_HOME_GRID = "__cpa-sfx-home-grid-style";
  const STYLE_ID_SEARCH_GRID = "__cpa-sfx-search-grid-style";
  const STYLE_ID_DEMOTE = "__cpa-sfx-demote-style";

  // demote マーキング用 CSS クラス（match 済みは class 付かず、未 match のみ付く）
  const CLASS_PROCESSED = "cpa-sfx-processed";
  const CLASS_DEMOTED = "cpa-sfx-demoted";

  // ---------- Helpers ----------
  const isShortsPage = () => location.pathname.startsWith("/shorts");
  const isResultsPage = () => location.pathname.startsWith("/results");
  const isWatchPage = () => location.pathname.startsWith("/watch");
  // 機能アクセサ。`active` が false ならすべて false 扱い（マスター OFF）。
  const f = (key) => active && features[key] === true;

  // ---------- 状態購読 ----------
  chrome.storage.local
    .get([
      StorageKeys.SEARCH_FIXER_ENABLED,
      StorageKeys.SEARCH_FIXER_FEATURES,
      StorageKeys.SEARCH_FIXER_GRID_ITEMS,
    ])
    .then((stored) => {
      active = stored[StorageKeys.SEARCH_FIXER_ENABLED] === true;
      features = SearchFixer.mergeFeatures(stored[StorageKeys.SEARCH_FIXER_FEATURES]);
      gridItems = SearchFixer.clampGridItems(stored[StorageKeys.SEARCH_FIXER_GRID_ITEMS]);
      onSettingsChanged();
    })
    .catch(() => {});

  chrome.runtime.onMessage.addListener((request, sender) => {
    // background SW 由来のみ受け付ける（他経路からの偽装を遮断）。
    if (!SenderCheck.isFromBackground(sender)) return;
    if (request?.action !== Actions.APPLY_SEARCH_FIXER_CS) return;
    const data = request.data ?? {};
    active = data.enabled === true;
    features = SearchFixer.mergeFeatures(data.features);
    gridItems = SearchFixer.clampGridItems(data.gridItems);
    onSettingsChanged();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    let touched = false;
    if (StorageKeys.SEARCH_FIXER_ENABLED in changes) {
      active = changes[StorageKeys.SEARCH_FIXER_ENABLED].newValue === true;
      touched = true;
    }
    if (StorageKeys.SEARCH_FIXER_FEATURES in changes) {
      features = SearchFixer.mergeFeatures(changes[StorageKeys.SEARCH_FIXER_FEATURES].newValue);
      touched = true;
    }
    if (StorageKeys.SEARCH_FIXER_GRID_ITEMS in changes) {
      gridItems = SearchFixer.clampGridItems(changes[StorageKeys.SEARCH_FIXER_GRID_ITEMS].newValue);
      touched = true;
    }
    if (touched) onSettingsChanged();
  });

  // ---------- ナビゲーション・初期化 ----------
  // YouTube SPA は yt-navigate-finish を発火させるのでこれをフック。
  // initial load では DOMContentLoaded を補助に使う。
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onSettingsChanged, { once: true });
  }
  document.addEventListener("yt-navigate-finish", onSettingsChanged);
  // start ハンドラは「ナビゲーション開始時の cleanup」に専念。SPA で再利用される
  // ytd-video-renderer の processed マーカーを剥がし、新クエリでの demote 判定を有効化する (#5)。
  document.addEventListener("yt-navigate-start", onNavigationStart);

  /** SPA ナビゲーション開始時の cleanup。CLASS_PROCESSED を剥がし新クエリでの再判定を許可する。 */
  function onNavigationStart() {
    if (!active) return;
    document
      .querySelectorAll(`.${CLASS_PROCESSED}`)
      .forEach((el) => el.classList.remove(CLASS_PROCESSED));
  }

  /**
   * 設定 / URL 変更のたびに呼ばれる中央ディスパッチャ。
   * 各機能の必要性に応じて attach / detach / 適用 / 撤去を冪等に行う。
   */
  function onSettingsChanged() {
    // /shorts/<id> リダイレクトは youtube-shorts.js が担当するためここでは扱わない（責務分離）

    // master OFF 時は注入 CSS / observer / 装飾クラスをすべて停止して早期 return (#13)。
    // 旧実装は active=false でも毎ナビゲーションで applyHomeGridStyle 等が DOM を走査していた。
    if (!active) {
      detachResultsObserver();
      clearThumbnailHighlight();
      applyHomeGridStyle();      // active=false なら style 要素を撤去するだけ
      applySearchGridStyle();    // 同上
      applyDemoteStyleInjection(); // 同上 + demoted クラス剥がし
      applyWatchPageClasses();   // 動画ページ装飾クラスも撤去する
      syncLiveChatCollapse();
      return;
    }

    applyHomeGridStyle();
    applySearchGridStyle();
    applyDemoteStyleInjection();

    if (isResultsPage()) {
      attachResultsObserver();
      // 既存 DOM への即時適用（observer は新規追加しか拾わない）
      removeDistractions();
      highlightThumbnails();
      highlightMismatchedVideos();
    } else {
      detachResultsObserver();
      // 検索ページから離れた場合、過去に付与した装飾クラスを掃除
      clearThumbnailHighlight();
    }

    // `applyWatchPageClasses()` は <html> クラス (__cpa-sfx-hide-comments) も操作するため、
    // /watch 以外のページに遷移したときも呼んで class を確実に剥がす必要がある。
    // 個別要素 toggle (#title h1 / #description) は要素ガード済みなので空振りで害なし。
    applyWatchPageClasses();
    syncLiveChatCollapse();
  }

  // ---------- MutationObserver ライフサイクル ----------
  function attachResultsObserver() {
    if (observerAttached) return;
    resultsObserver = new MutationObserver((mutations) => {
      if (!active) return;
      // 大量 mutation の coalesce: 個別ノードを舐めるのではなく、まとめて再スキャンする。
      // 元の実装は addedNode 種別ごとに分岐していたが、selector ヒット率が低いケースでも
      // フルスキャンの実コストは数 ms 程度（YouTube 検索ページの DOM 規模で実測許容範囲）。
      let needsScan = false;
      for (const m of mutations) {
        if (m.type === "childList" && m.addedNodes.length > 0) {
          needsScan = true;
          break;
        }
      }
      if (needsScan) scheduleScan();
    });
    resultsObserver.observe(document, {
      childList: true,
      subtree: true,
    });
    observerAttached = true;
  }

  function detachResultsObserver() {
    if (!observerAttached) return;
    resultsObserver?.disconnect();
    resultsObserver = null;
    observerAttached = false;
    if (scanRaf !== 0) {
      cancelAnimationFrame(scanRaf);
      scanRaf = 0;
    }
    scanScheduled = false;
  }

  function syncLiveChatCollapse() {
    if (!f("hideLiveChat") || !isWatchPage()) {
      detachLiveChatObserver();
      return;
    }
    attachLiveChatObserver();
    scheduleLiveChatCollapse();
  }

  function attachLiveChatObserver() {
    if (liveChatObserverAttached) return;
    // P1-#4: 旧実装は document 全体を childList:true + subtree:true で監視していたため、
    // YouTube watch ページの数十/秒の childList mutation すべてがコールバックを起動していた。
    // 新実装は 2 段階観察:
    //   状態 1 (chat frame 未出現): document を childList:true + subtree:true で frame 出現を待つ
    //   状態 2 (chat frame 存在):   frame **配下のみ** を childList + subtree + attributes:["collapsed"] で監視
    //                                （frame 出現直後は #close-button などの内部 UI がまだ DOM に無いため
    //                                subtree childList で内部 UI 出現を待つ必要がある）
    // 旧実装と比べ、状態 2 では監視範囲が frame 配下に限定されるため YouTube watch ページの大半の
    // DOM 変更ではコールバックが起動しなくなる。
    liveChatObserver = new MutationObserver(handleLiveChatMutations);
    reAttachLiveChatObserver();
    liveChatObserverAttached = true;
  }

  /**
   * `liveChatObserver` の観察対象を「frame があるなら frame」「無ければ document」に切り替える。
   * 同じターゲットへの再 observe は冪等にスキップ。`force=true` で前回の disconnect 直後の再 attach を強制。
   */
  function reAttachLiveChatObserver(force) {
    if (!liveChatObserver) return;
    const frame = document.querySelector("ytd-live-chat-frame");
    const newTarget = frame ?? document;
    if (!force && newTarget === liveChatObserverTarget) return;
    liveChatObserver.disconnect();
    liveChatObserverTarget = newTarget;
    if (frame) {
      // 状態 2: frame 配下の childList + subtree + attribute["collapsed"] を監視。
      // frame 出現直後は #close-button などの内部 UI がまだ DOM に無いため、subtree childList で
      // 内部 UI の出現を待ち、出現次第 scheduleLiveChatCollapse → collapseLiveChatIfNeeded を駆動する。
      liveChatObserver.observe(frame, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["collapsed"],
      });
    } else {
      // 状態 1: frame 出現を待つため document を childList watch
      liveChatObserver.observe(document, {
        childList: true,
        subtree: true,
      });
    }
  }

  function handleLiveChatMutations(mutations) {
    if (!f("hideLiveChat") || !isWatchPage()) return;
    // 関連する mutation があれば次フレームで collapse 試行 + observer 再アタッチ判定。
    // frame 出現 / 内部 UI 出現 / collapsed 属性変化のいずれもトリガーとして扱う。
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "collapsed") {
        scheduleLiveChatCollapse();
        return;
      }
      if (m.type === "childList" && m.addedNodes.length > 0) {
        scheduleLiveChatCollapse();
        return;
      }
    }
  }

  function detachLiveChatObserver() {
    if (liveChatCollapseRaf !== 0) {
      cancelAnimationFrame(liveChatCollapseRaf);
      liveChatCollapseRaf = 0;
    }
    // hideLiveChat OFF / 別ページ遷移時は force-hide クラスを剥がして元の表示状態に戻す。
    // クラスを残したままだと、機能 OFF 後もライブチャット枠が表示されないバグになる。
    document
      .querySelectorAll("ytd-live-chat-frame." + LIVE_CHAT_FORCE_HIDE_CLASS)
      .forEach((el) => el.classList.remove(LIVE_CHAT_FORCE_HIDE_CLASS));
    if (!liveChatObserverAttached) return;
    liveChatObserver?.disconnect();
    liveChatObserver = null;
    liveChatObserverAttached = false;
    liveChatObserverTarget = null;
  }

  function scheduleLiveChatCollapse() {
    if (liveChatCollapseRaf !== 0) return;
    liveChatCollapseRaf = requestAnimationFrame(() => {
      liveChatCollapseRaf = 0;
      // frame 出現していれば observer を frame 直接観察に冪等に切り替える（状態遷移）。
      reAttachLiveChatObserver();
      collapseLiveChatIfNeeded();
    });
  }

  // hideLiveChat: 「toggle 見つからない & frame 存在」のときに付与する強制非表示クラス。
  // ライブ配信アーカイブで「チャットのリプレイを表示」ボタンしか出ない動画など、
  // 公式トグルで閉じられない状態を CSS で frame ごと display:none する。
  const LIVE_CHAT_FORCE_HIDE_CLASS = "__cpa-sfx-live-chat-force-hide";

  // 「表示する」系のボタンラベル（=既に折りたたみ済みで、押すと開いてしまうので絶対 click 禁止）。
  // 「を表示」「のリプレイを表示」「Show chat」「Show chat replay」などの末尾パターンを広めに拾う。
  const SHOW_BUTTON_RE = /(を表示|リプレイを表示|show chat|show replay)/i;
  // 「非表示にする」系のボタンラベル（=現在チャットが開いていて、押すと折りたたまれる）。
  // 「を非表示」「Hide chat」「Close chat」など。SHOW にもマッチする可能性があるので SHOW を先に判定する。
  const HIDE_BUTTON_RE = /(非表示|閉じる|たたむ|hide chat|close chat|collapse chat)/i;

  function findLiveChatToggle(chatFrame) {
    // 検索スコープ: chatFrame 自身に加えて、隣接親 (`#chat-container`, `ytd-watch-grid`, `ytd-watch-flexy`)
    // も探す。YouTube は折りたたみボタンを frame の外（隣接ヘッダー）に置くケースがあり、
    // chatFrame.querySelector のみだと見逃す。
    const scopes = new Set();
    scopes.add(chatFrame);
    let p = chatFrame.parentElement;
    let depth = 0;
    while (p && depth < 4) {
      // 親方向に最大 4 階層遡って toggle を探す
      scopes.add(p);
      if (
        p.id === "chat-container" ||
        p.tagName === "YTD-WATCH-GRID" ||
        p.tagName === "YTD-WATCH-FLEXY"
      ) break;
      p = p.parentElement;
      depth += 1;
    }

    // legacy ID セレクタ。ただし `#show-hide-button` は「表示」「非表示」両方の状態で同じ ID を持つため、
    // ヒットしてもそのまま click せず、aria-label / textContent で「非表示にする」状態のみ採用する。
    const idSelectors = [
      "#close-button button",
      "#close-button [role='button']",
      "#show-hide-button button",
      "#show-hide-button [role='button']",
      "#close-button",
      "#show-hide-button",
    ];

    /** 候補 button が「閉じる」アクション (=hide) かどうかを aria/text で判定 */
    const isHideAction = (el) => {
      const aria = (el.getAttribute("aria-label") ?? "").trim();
      const text = (el.textContent ?? "").trim().slice(0, 50);
      // 「表示する」系を最優先で除外（誤クリックすると逆に開いてしまう）
      if (SHOW_BUTTON_RE.test(aria) || SHOW_BUTTON_RE.test(text)) return false;
      // 「非表示」系を採用
      if (HIDE_BUTTON_RE.test(aria) || HIDE_BUTTON_RE.test(text)) return true;
      // ラベルが空 / 不明な場合は安全側で false（無闇に click しない）
      return false;
    };

    for (const scope of scopes) {
      // 1. legacy ID 経路（ヒット時もアクション判定で hide のみ採用）
      for (const sel of idSelectors) {
        const el = scope.querySelector(sel);
        if (el && typeof el.click === "function" && isHideAction(el)) return el;
      }
      // 2. aria-label / textContent による全 button スキャン
      const candidates = scope.querySelectorAll("button, [role='button']");
      for (const c of candidates) {
        if (typeof c.click !== "function") continue;
        if (isHideAction(c)) return c;
      }
    }
    return null;
  }

  /**
   * ライブチャット panel の close button を探す。
   * 動画下の「パネルを開く」ボタンと連動する公式 close button を探索する。
   *
   * 候補:
   *   1. engagement panel (`ytd-engagement-panel-section-list-renderer`) の close button
   *   2. `ytd-live-chat-frame` 内の `#close-button` 直下の button
   * いずれも `disabled` でないものだけ返す（disabled = 既に panel が closed の状態）。
   */
  function findLiveChatPanelCloseButton() {
    const panels = document.querySelectorAll(
      'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]'
    );
    for (const panel of panels) {
      const targetId = (panel.getAttribute("target-id") || "").toLowerCase();
      if (!/chat/.test(targetId)) continue;
      const btn = panel.querySelector(
        'button[aria-label*="閉じる"], button[aria-label*="Close"]'
      );
      if (btn && !btn.disabled && typeof btn.click === "function") return btn;
    }
    const chatFrame = document.querySelector("ytd-live-chat-frame");
    if (chatFrame) {
      const btn = chatFrame.querySelector("#close-button button");
      if (btn && !btn.disabled && typeof btn.click === "function") return btn;
    }
    return null;
  }

  function collapseLiveChatIfNeeded() {
    // 設計: ユーザーの代わりに「マウスでパネルを閉じる」操作を JS で代行するだけ。
    // 他には一切触らない（CSS / frame 属性 / 独自クラス / iframe 高さ全部触らない）。
    // 公式 close button の click は user gesture と等価扱いなので YouTube SPA は整合的に
    // 状態更新し、player 副作用ゼロ・layout も自動で整理される。
    if (!f("hideLiveChat") || !isWatchPage()) return;

    const closeBtn = findLiveChatPanelCloseButton();
    if (!closeBtn) {
      // close button がまだ存在しない（panel data 未ロード等）/ 既に panel が closed
      // の場合は何もしない。観察経由で panel 出現後に再評価される。
      return;
    }

    // P1-#4: disconnect → click → takeRecords → reattach ガードで MutationObserver の
    // 再発火ループを遮断（panel close → DOM 更新 → observer 発火 → 再度 collapseLiveChatIfNeeded
    // が即座に呼ばれて空振りループになるのを防ぐ）。
    if (liveChatObserver) {
      liveChatObserver.disconnect();
      liveChatObserverTarget = null;
      try {
        closeBtn.click();
      } finally {
        liveChatObserver.takeRecords();
        reAttachLiveChatObserver(true);
      }
    } else {
      closeBtn.click();
    }

    // 旧バージョン残骸の force-hide クラス cleanup（過去拡張機能で frame に付与された
    // クラスが残っている場合のみ作用、新方式では二度と付与しない）。
    document
      .querySelectorAll("ytd-live-chat-frame." + LIVE_CHAT_FORCE_HIDE_CLASS)
      .forEach((el) => el.classList.remove(LIVE_CHAT_FORCE_HIDE_CLASS));
  }

  let scanScheduled = false;
  let scanRaf = 0;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    scanRaf = requestAnimationFrame(() => {
      scanRaf = 0;
      scanScheduled = false;
      if (!active || !isResultsPage()) return;
      removeDistractions();
      highlightThumbnails();
      highlightMismatchedVideos();
    });
  }

  // ---------- 検索結果のノイズ除去 ----------
  /**
   * 有効化された機能群を 3 つのスキャンパスに集約して実行する。
   *
   * 旧実装は 13 機能 ON 時に最大 13 回の document-wide querySelectorAll を直列実行していたが、
   * 機能ドメインごとに以下のように統合することで最大 3 回に削減（O(K×M) → O(M)）:
   *   1. 個別 renderer タグ系（shelf / cardList / channel / reel / course / secondary）
   *      → 1 つの `:is(...)` セレクタに結合した 1 回の querySelectorAll で削除
   *   2. ytd-video-renderer 属性判定系（shortsBtn / live / verified / artist / watched / chapter）
   *      → 全 ytd-video-renderer を 1 回取得し、1 ループで属性チェック
   *   3. playlist / mix（独立した `.yt-lockup-view-model--horizontal` の badge/href 判定）
   *      → 1 回の querySelectorAll
   *
   * いずれの機能も OFF なら対応するパスをスキップ。
   */
  function removeDistractions() {
    if (!isResultsPage()) return;

    // ===== Pass 1: 独立 renderer タグ系を :is() で結合した 1 回スキャン =====
    const tagSelectors = [];
    if (f("shelf")) {
      tagSelectors.push("#primary .ytd-two-column-search-results-renderer ytd-shelf-renderer");
    }
    if (f("cardList")) {
      tagSelectors.push("ytd-horizontal-card-list-renderer.ytd-item-section-renderer:not(:first-child)");
    }
    if (f("channel")) {
      tagSelectors.push("#primary .ytd-two-column-search-results-renderer ytd-channel-renderer");
    }
    if (f("reel")) {
      tagSelectors.push("#primary .ytd-two-column-search-results-renderer ytd-reel-shelf-renderer");
      tagSelectors.push("grid-shelf-view-model");
    }
    if (f("course")) {
      tagSelectors.push(".yt-lockup-view-model--wrapper");
    }
    if (f("secondary")) {
      tagSelectors.push("ytd-secondary-search-container-renderer");
    }
    if (tagSelectors.length > 0) {
      try {
        // `:is(a, b, c)` は modern Chrome (140+) で広くサポート。複合カンマセレクタとほぼ等価。
        document.querySelectorAll(`:is(${tagSelectors.join(",")})`).forEach((el) => {
          if (el.isConnected) el.remove();
        });
      } catch {
        // :is() 失敗時は個別セレクタにフォールバック
        for (const sel of tagSelectors) {
          try {
            document.querySelectorAll(sel).forEach((el) => {
              if (el.isConnected) el.remove();
            });
          } catch {}
        }
      }
    }

    // ===== Pass 2: ytd-video-renderer 属性判定系を 1 ループで処理 =====
    const checkShortsBtn = f("shortsBtn");
    const checkLive = f("live");
    const checkVerified = f("verified");
    const checkArtist = f("artist");
    const checkWatched = f("watched");
    const checkChapter = f("chapter");
    if (checkShortsBtn || checkLive || checkVerified || checkArtist || checkWatched || checkChapter) {
      try {
        document
          .querySelectorAll("#primary ytd-item-section-renderer ytd-video-renderer")
          .forEach((renderer) => {
            if (!renderer.isConnected) return;
            // 順番に判定し、最初に該当した条件で remove → 早期 return（重複処理を避ける）
            if (checkShortsBtn && renderer.querySelector("ytd-thumbnail a#thumbnail[href*='/shorts/']")) {
              renderer.remove();
              return;
            }
            if (checkLive) {
              const badges = renderer.querySelectorAll("#badges .yt-badge-shape__text, #badges > div > p");
              for (const badge of badges) {
                const text = badge.textContent.trim();
                if (text === "LIVE" || text === "PREMIERE") {
                  renderer.remove();
                  return;
                }
              }
            }
            if (checkVerified && renderer.querySelector('badge-shape[aria-label="Verified"]')) {
              renderer.remove();
              return;
            }
            if (checkArtist && renderer.querySelector('badge-shape[aria-label="Official Artist Channel"]')) {
              renderer.remove();
              return;
            }
            if (checkWatched && renderer.querySelector("ytd-thumbnail-overlay-resume-playback-renderer")) {
              renderer.remove();
              return;
            }
            if (checkChapter && renderer.querySelector("ytd-expandable-metadata-renderer")) {
              renderer.remove();
              return;
            }
          });
      } catch {}
    }

    // ===== Pass 3: playlist / mix の独立判定（badge or href ベース） =====
    if (f("playlist") || f("mix")) {
      const checkPlaylist = f("playlist");
      const checkMix = f("mix");
      try {
        document.querySelectorAll(".yt-lockup-view-model--horizontal").forEach((item) => {
          if (!item.isConnected) return;
          let isPlaylist = false;
          let isMix = false;
          const badge = item.querySelector(".yt-badge-shape__text");
          if (badge) {
            const t = badge.textContent.trim().toLowerCase();
            if (/\d+\s*videos?/i.test(t) || /\d+\s*episodes?/i.test(t)) isPlaylist = true;
            else if (t === "mix") isMix = true;
          }
          if (!isPlaylist && !isMix) {
            const link = item.querySelector("a.yt-lockup-view-model-wiz__content-image");
            const href = link?.getAttribute("href") ?? "";
            if (
              href.includes("/playlist?list=") ||
              (href.includes("&list=") && !href.includes("list=RD") && !href.includes("&start_radio=1"))
            ) {
              isPlaylist = true;
            } else if (href.includes("&list=RD") && href.includes("&start_radio=1")) {
              isMix = true;
            }
          }
          if (checkPlaylist && isPlaylist) item.remove();
          else if (checkMix && isMix) item.remove();
        });
      } catch {}
    }
  }

  // ---------- サムネ枠装飾 ----------
  function highlightThumbnails() {
    if (!isResultsPage()) return;
    const enabled = f("highlightThumb");
    const isDark = document.documentElement.hasAttribute("dark");
    const items = document.querySelectorAll(
      "ytd-video-renderer.style-scope.ytd-item-section-renderer"
    );
    items.forEach((el) => {
      el.classList.remove("__cpa-sfx-thumb-dark", "__cpa-sfx-thumb-light");
      if (enabled) {
        el.classList.add(isDark ? "__cpa-sfx-thumb-dark" : "__cpa-sfx-thumb-light");
      }
    });
  }

  function clearThumbnailHighlight() {
    document
      .querySelectorAll(".__cpa-sfx-thumb-dark, .__cpa-sfx-thumb-light")
      .forEach((el) => el.classList.remove("__cpa-sfx-thumb-dark", "__cpa-sfx-thumb-light"));
  }

  // ---------- キーワード非マッチ動画のグレー化 ----------
  function applyDemoteStyleInjection() {
    const enabled = f("demoteUnmatched");
    const existing = document.getElementById(STYLE_ID_DEMOTE);
    if (!enabled) {
      // 機能 OFF: 注入 CSS と既存クラスを片付ける
      if (existing) existing.remove();
      document
        .querySelectorAll(`.${CLASS_DEMOTED}`)
        .forEach((el) => el.classList.remove(CLASS_DEMOTED));
      return;
    }
    if (existing) return;
    const style = document.createElement("style");
    style.id = STYLE_ID_DEMOTE;
    style.textContent = `
      .${CLASS_DEMOTED} {
        opacity: 0.45;
        filter: grayscale(100%);
        transition: opacity 200ms ease, filter 200ms ease;
      }
      .${CLASS_DEMOTED} .metadata-snippet-container,
      .${CLASS_DEMOTED} #description-text { display: none !important; }
      .${CLASS_DEMOTED}:hover {
        opacity: 1;
        filter: grayscale(0%);
        background-color: rgba(192, 96, 90, 0.04);
      }
      .${CLASS_DEMOTED}:hover .metadata-snippet-container,
      .${CLASS_DEMOTED}:hover #description-text { display: block !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function highlightMismatchedVideos() {
    if (!isResultsPage()) return;
    if (!f("demoteUnmatched")) return;

    const params = new URLSearchParams(location.search);
    const query = (params.get("search_query") ?? "").trim();
    if (!query) return;

    // ストップワードは英語の汎用語のみ。日本語の助詞は分かち書きされていないため除外不可（実害最小）
    const stopWords = new Set([
      "a", "an", "the", "is", "are", "of", "in", "on", "at", "for", "with", "by", "and", "or",
    ]);
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopWords.has(w));
    if (keywords.length === 0) return;

    const videos = document.querySelectorAll(
      `ytd-video-renderer:not(.${CLASS_PROCESSED})`
    );
    videos.forEach((video) => {
      video.classList.add(CLASS_PROCESSED);
      const container = video.querySelector("#dismissible");
      const titleEl = video.querySelector("#video-title");
      if (!container || !titleEl) return;
      const titleText = (titleEl.textContent ?? "").toLowerCase();
      const desc = video.querySelector(".metadata-snippet-text");
      const descText = desc ? (desc.textContent ?? "").toLowerCase() : "";
      const hasMatch = keywords.some((kw) => titleText.includes(kw) || descText.includes(kw));
      container.classList.toggle(CLASS_DEMOTED, !hasMatch);
    });
  }

  // ---------- 動画ページ（タイトル中央 / 説明文フル幅 / コメント欄・ライブチャット欄非表示） ----------
  function applyWatchPageClasses() {
    const titleEl = document.querySelector("#title h1");
    if (titleEl) titleEl.classList.toggle("__cpa-sfx-title-center", f("centerTitle"));
    const descEl = document.querySelectorAll("#description")[1];
    if (descEl) descEl.classList.toggle("__cpa-sfx-desc-full", f("fullWidthDesc"));
    // コメント欄は遅延レンダリング（スクロールで初めて DOM 出現）するため、個別要素 toggle だと
    // 初期ロード時に空振りする。`<html>` クラスで CSS 駆動にすれば後から DOM が現れても即時適用される。
    document.documentElement.classList.toggle("__cpa-sfx-hide-comments", f("hideComments"));
    // ライブチャットは JS 側で公式トグルを押し、CSS は collapsed 状態の高さ補助だけを担う。
    document.documentElement.classList.toggle("__cpa-sfx-hide-live-chat", f("hideLiveChat"));
  }

  // ---------- ホームのリッチグリッド列数 ----------
  function applyHomeGridStyle() {
    const existing = document.getElementById(STYLE_ID_HOME_GRID);
    const valid = active && (gridItems === 4 || gridItems === 5 || gridItems === 6);
    if (!valid) {
      if (existing) existing.remove();
      return;
    }
    const cssRule = `ytd-rich-item-renderer[rendered-from-rich-grid] {
      --ytd-rich-item-row-usable-width: calc(100% - var(--ytd-rich-grid-gutter-margin)*2);
      width: calc(var(--ytd-rich-item-row-usable-width) / ${gridItems} - var(--ytd-rich-grid-item-margin) - .01px) !important;
    }`;
    if (existing) {
      if (existing.textContent !== cssRule) existing.textContent = cssRule;
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID_HOME_GRID;
    style.textContent = cssRule;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------- 検索結果グリッド表示 ----------
  function applySearchGridStyle() {
    const existing = document.getElementById(STYLE_ID_SEARCH_GRID);
    const enabled = f("searchGrid") && isResultsPage();
    if (!enabled) {
      if (existing) existing.remove();
      // grid-active クラスを掃除
      document
        .querySelectorAll("#contents.yt-grid-active")
        .forEach((c) => c.classList.remove("yt-grid-active"));
      return;
    }
    // grid-active クラスを付与（observer 経由で動的に追加されるノードにも対応するため、
    // ここでは既存ノードに付け、新規ノード分は scheduleScan の経路で別途付ける）
    document
      .querySelectorAll("ytd-search ytd-video-renderer")
      .forEach((v) => v.closest("#contents")?.classList.add("yt-grid-active"));

    // 列数: gridItems が 0（自動）でも検索ページでは 3 列をデフォルトに
    const columns = gridItems >= 4 ? gridItems : 3;
    const cssRule = buildSearchGridCss(columns);
    if (existing) {
      if (existing.textContent !== cssRule) existing.textContent = cssRule;
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID_SEARCH_GRID;
    style.textContent = cssRule;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildSearchGridCss(columns) {
    const validColumns = columns >= 1 ? columns : 3;
    return `
      ytd-search ytd-two-column-search-results-renderer {
        width: 100% !important;
        max-width: 98% !important;
        margin: 0 auto !important;
      }
      ytd-search ytd-two-column-search-results-renderer #primary {
        max-width: 100% !important;
        padding-right: 0 !important;
      }
      ytd-search ytd-item-section-renderer { max-width: 100% !important; }
      ytd-search #contents.yt-grid-active {
        display: grid !important;
        grid-template-columns: repeat(${validColumns}, 1fr) !important;
        column-gap: 16px !important;
        row-gap: 32px !important;
        margin-top: 24px !important;
      }
      ytd-search #contents.yt-grid-active > *:not(ytd-video-renderer) {
        grid-column: 1 / -1 !important;
        width: 100% !important;
      }
      ytd-search #contents.yt-grid-active ytd-video-renderer {
        width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        max-width: none !important;
      }
      ytd-search #contents.yt-grid-active ytd-video-renderer #dismissible {
        display: flex !important;
        flex-direction: column !important;
        height: 100% !important;
      }
      ytd-search #contents.yt-grid-active ytd-video-renderer ytd-thumbnail {
        width: 100% !important;
        max-width: 100% !important;
        min-width: 100% !important;
        aspect-ratio: 16 / 9;
        margin-right: 0 !important;
        margin-bottom: 12px !important;
      }
      ytd-search #contents.yt-grid-active ytd-video-renderer ytd-thumbnail a,
      ytd-search #contents.yt-grid-active ytd-video-renderer ytd-thumbnail img {
        border-radius: 12px !important;
      }
      ytd-search #contents.yt-grid-active ytd-video-renderer #video-title {
        font-size: 1.4rem !important;
        line-height: 2.0rem !important;
        font-weight: 500 !important;
        max-height: 4.0rem !important;
        display: -webkit-box !important;
        -webkit-line-clamp: 2 !important;
        -webkit-box-orient: vertical !important;
        overflow: hidden !important;
      }
      ytd-search #contents.yt-grid-active ytd-video-renderer .${CLASS_DEMOTED} {
        opacity: 0.15;
      }
    `;
  }
})();
