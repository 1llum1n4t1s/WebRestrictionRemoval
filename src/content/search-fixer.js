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
  /**
   * ライブチャット close button 検出が空振りしたときのリトライ用タイマー id。
   * iframe.contentDocument は same-origin で読めるが、close button (`yt-live-chat-header-renderer
   * #close-button button`) は YouTube が hydration 完了後にようやく enabled 化するため、
   * 1 度の試行では disabled / 未生成な瞬間を踏んで空振りする。指数バックオフで最大 3 回再試行する。
   */
  let liveChatCollapseRetryTimer = 0;
  /** リトライ試行回数（0 始まり）。LIVE_CHAT_COLLAPSE_RETRY_DELAYS のインデックスを進める。 */
  let liveChatCollapseRetryAttempt = 0;
  /** 指数バックオフのディレイ（ms）。close button hydration の典型タイミングをカバーする幅で設定。 */
  const LIVE_CHAT_COLLAPSE_RETRY_DELAYS = Object.freeze([200, 600, 1500]);

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
  // フィードページ判定（ホーム / 登録 / 急上昇 等）。yt-lockup-view-model 系の動画フィルタ対象。
  // v1.0.x で「適用範囲」セレクタを廃止したため常時有効として動作する。
  const isFeedPage = () => SearchFixer.isFeedPath(location.pathname);
  // 動画フィルタ全体の活性ページ判定。検索結果 OR フィードページ。
  const isVideoFilterPage = () => isResultsPage() || isFeedPage();
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
      applySubsFeatures();       // 登録チャンネル拡張: 各機能内で OFF 時 cleanup
      return;
    }

    applyHomeGridStyle();
    applySearchGridStyle();
    applyDemoteStyleInjection();

    if (isVideoFilterPage()) {
      attachResultsObserver();
      // 既存 DOM への即時適用（observer は新規追加しか拾わない）
      // removeDistractions は内部で isResultsPage() でゲートされており検索ページのみ動作。
      // purgeFeedDistractions は内部で isFeedPage() でゲートされフィードページのみ動作。
      removeDistractions();
      purgeFeedDistractions();
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
    applySubsFeatures();         // 登録チャンネル拡張: 3 機能の dispatch
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
    cancelLiveChatCollapseRetry();
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

  /** リトライタイマー停止と試行回数リセット。新しいトリガー（mutation / load / settings 変更）が
   *  来たら呼び、次の collapse サイクルで再び 0 から指数バックオフを始められるようにする。 */
  function cancelLiveChatCollapseRetry() {
    if (liveChatCollapseRetryTimer !== 0) {
      clearTimeout(liveChatCollapseRetryTimer);
      liveChatCollapseRetryTimer = 0;
    }
    liveChatCollapseRetryAttempt = 0;
  }

  /** close button 検出失敗時に呼ぶ。指数バックオフで最大 LIVE_CHAT_COLLAPSE_RETRY_DELAYS 回まで
   *  collapseLiveChatIfNeeded を再試行する。上限到達後は何もしない（observer / load event で
   *  別契機が来たら cancelLiveChatCollapseRetry → 再開）。 */
  function scheduleLiveChatCollapseRetry() {
    if (!f("hideLiveChat") || !isWatchPage()) {
      cancelLiveChatCollapseRetry();
      return;
    }
    if (liveChatCollapseRetryTimer !== 0) return;
    if (liveChatCollapseRetryAttempt >= LIVE_CHAT_COLLAPSE_RETRY_DELAYS.length) return;
    const delay = LIVE_CHAT_COLLAPSE_RETRY_DELAYS[liveChatCollapseRetryAttempt];
    liveChatCollapseRetryAttempt += 1;
    liveChatCollapseRetryTimer = setTimeout(() => {
      liveChatCollapseRetryTimer = 0;
      if (!f("hideLiveChat") || !isWatchPage()) return;
      collapseLiveChatIfNeeded();
    }, delay);
  }

  function scheduleLiveChatCollapse() {
    if (liveChatCollapseRaf !== 0) return;
    liveChatCollapseRaf = requestAnimationFrame(() => {
      liveChatCollapseRaf = 0;
      // 新しい mutation トリガーが来たので、進行中のリトライバックオフをリセットして
      // 0 番から再試行できるようにする（hydration 待ちタイミングを取り直す）。
      cancelLiveChatCollapseRetry();
      // frame 出現していれば observer を frame 直接観察に冪等に切り替える（状態遷移）。
      reAttachLiveChatObserver();
      // iframe.load 後に再評価できるよう load listener を attach（idempotent）。
      // MutationObserver は cross-document な iframe 内 DOM 変化を観察できないため、
      // close button が iframe 内に出現するタイミング（panel data load 完了）は
      // iframe の load event 経由でのみ確実に取れる。
      attachLiveChatIframeLoadListener();
      collapseLiveChatIfNeeded();
    });
  }

  /**
   * `ytd-live-chat-frame iframe.ytd-live-chat-frame` の load event に collapse 再試行を hook する。
   * iframe 出現直後は contentDocument が空 / readyState != complete のことがあり、
   * その状態で collapseLiveChatIfNeeded を呼ぶと close button 未ロードでスキップされる。
   * load 後にもう 1 度 scheduleLiveChatCollapse を呼ぶことで、close button が確実に
   * ready になったタイミングで click できる。
   *
   * 同じ iframe に複数回 listener を attach しないよう、要素自身に WeakSet 風 marker
   * (`__cpaLiveChatLoadAttached`) を立てて idempotent 化する。
   */
  function attachLiveChatIframeLoadListener() {
    const iframe = document.querySelector(
      "ytd-live-chat-frame iframe.ytd-live-chat-frame"
    );
    if (!iframe || iframe.__cpaLiveChatLoadAttached === true) return;
    iframe.__cpaLiveChatLoadAttached = true;
    iframe.addEventListener("load", () => {
      // load 直後は YouTube 側の hydration が走っている最中なので、少し待ってから再評価。
      // ChromeMCP の検証では load 後数百ms 以内に close button が ready になる挙動を確認。
      // 新しいロード契機なのでリトライカウンタをリセットして 0 番からバックオフできるようにする。
      setTimeout(() => {
        if (f("hideLiveChat") && isWatchPage()) {
          cancelLiveChatCollapseRetry();
          collapseLiveChatIfNeeded();
        }
      }, 300);
    });
    // 「listener 登録時には既に iframe が load 完了済み」のケース対策。
    // SPA 遷移の順序によっては、ytd-live-chat-frame 出現 → iframe 出現 → iframe load 発火
    // の連鎖が我々の attach 処理より先に終わっており、以降 load event は二度と発火しない。
    // contentDocument が same-origin で readyState を読めるため、complete のときだけ
    // 直ちに collapse 試行（リトライサイクル経由）に乗せる。
    try {
      const idoc = iframe.contentDocument;
      if (idoc && idoc.readyState === "complete") {
        // 50ms の微小待ちを入れるのは、readyState=complete 直後でも close button が
        // disabled な瞬間があるため。リトライサイクルが空振りを吸収する。
        setTimeout(() => {
          if (f("hideLiveChat") && isWatchPage()) {
            collapseLiveChatIfNeeded();
          }
        }, 50);
      }
    } catch {
      // contentDocument cross-origin で弾かれた場合は何もしない（フォールバック側で拾う）
    }
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
   *
   * **重要**: 真の close button は `ytd-live-chat-frame` 配下の **iframe の中**
   * (`yt-live-chat-header-renderer #close-button button[aria-label="閉じる"]`) に存在する。
   * top frame の `document.querySelector` では届かないので、`iframe.contentDocument` 経由で
   * アクセスする。`youtube.com/watch` と `youtube.com/live_chat_replay` は same-origin
   * なので、SameOriginPolicy で contentDocument にアクセスできる。
   *
   * フォールバックとして top frame の `ytd-engagement-panel-section-list-renderer` 内や
   * 動画下カルーセルの「パネルを閉じる」 button も試す（YouTube UI が将来変わったときの保険）。
   *
   * いずれも disabled でないものだけ返す。
   */
  function findLiveChatPanelCloseButton() {
    // 戦略 1（本命）: iframe 内の yt-live-chat-header-renderer #close-button
    const chatFrame = document.querySelector("ytd-live-chat-frame");
    const iframe = chatFrame?.querySelector("iframe.ytd-live-chat-frame");
    if (iframe) {
      try {
        const idoc = iframe.contentDocument;
        if (idoc) {
          const btn = idoc.querySelector(
            'yt-live-chat-header-renderer #close-button button[aria-label="閉じる"], ' +
            'yt-live-chat-header-renderer #close-button button[aria-label="Close"], ' +
            'yt-live-chat-header-renderer #close-button button'
          );
          if (btn && !btn.disabled) return btn;
        }
      } catch {
        // contentDocument が cross-origin で弾かれた場合などは無視してフォールバックへ
      }
    }

    // 戦略 2（フォールバック）: 動画下の「パネルを閉じる」 button (textContent ベース)
    const allBtns = document.querySelectorAll("button");
    for (const btn of allBtns) {
      if (btn.disabled) continue;
      const txt = (btn.textContent || "").trim();
      if (txt === "パネルを閉じる" || txt === "Close panel") return btn;
    }

    // 戦略 3（フォールバック）: engagement panel の header close button
    const panels = document.querySelectorAll(
      'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]'
    );
    for (const panel of panels) {
      const targetId = (panel.getAttribute("target-id") || "").toLowerCase();
      if (!/chat/.test(targetId)) continue;
      const btn = panel.querySelector(
        'button[aria-label*="閉じる"], button[aria-label*="Close"]'
      );
      if (btn && !btn.disabled) return btn;
    }

    return null;
  }

  /**
   * 「ユーザーがマウスで click した」のと等価な event sequence を発火する。
   *
   * `element.click()` は programmatic click で `isTrusted: false`、かつ pointer/mouse 系の
   * 中間イベントを発火しない。YouTube の一部ハンドラは `pointerdown`/`mousedown` を起点に
   * 動作するため、フル sequence (`pointerdown → mousedown → pointerup → mouseup → click`)
   * を順に dispatch することで、可能な限りユーザー操作と等価な扱いにする。
   *
   * iframe 内の要素を対象にする場合、`view` と Event コンストラクタはその iframe の window
   * から取らないと別 realm の event 扱いになって YouTube ハンドラが処理しない可能性があるため、
   * `btn.ownerDocument.defaultView` を使う。
   */
  function fireUserLikeClick(btn) {
    const win = btn.ownerDocument && btn.ownerDocument.defaultView;
    if (!win) {
      try { btn.click(); } catch {}
      return;
    }
    const init = { bubbles: true, cancelable: true, view: win, button: 0 };
    const PointerEv = win.PointerEvent || PointerEvent;
    const MouseEv = win.MouseEvent || MouseEvent;
    try { btn.dispatchEvent(new PointerEv("pointerdown", init)); } catch {}
    try { btn.dispatchEvent(new MouseEv("mousedown", init)); } catch {}
    try { btn.dispatchEvent(new PointerEv("pointerup", init)); } catch {}
    try { btn.dispatchEvent(new MouseEv("mouseup", init)); } catch {}
    try { btn.click(); } catch {}
  }

  function collapseLiveChatIfNeeded() {
    // 設計: ユーザーの代わりに「マウスでパネルを閉じる」操作を JS で代行するだけ。
    // 他には一切触らない（CSS / frame 属性 / 独自クラス / iframe 高さ全部触らない）。
    // 公式 close button の click は user gesture と等価扱いなので YouTube SPA は整合的に
    // 状態更新し、player 副作用ゼロ・layout も自動で整理される。
    if (!f("hideLiveChat") || !isWatchPage()) {
      cancelLiveChatCollapseRetry();
      return;
    }

    const closeBtn = findLiveChatPanelCloseButton();
    if (!closeBtn) {
      // close button が見つからない原因:
      //   1. iframe contentDocument がまだ load 中で内部 DOM が空
      //   2. close button は出現したが hydration 未完了で disabled / click 不可
      //   3. 既に panel が closed されている（成功状態）
      // 1/2 の救済として指数バックオフでリトライする。3 の場合もリトライ上限まで空振りで害なし。
      // 上限到達後は observer / iframe load の別契機が来るまで止まる。
      scheduleLiveChatCollapseRetry();
      return;
    }
    // 成功経路: 進行中のリトライがあれば停止する（無駄な再試行を防ぐ）
    cancelLiveChatCollapseRetry();

    // P1-#4: disconnect → click → takeRecords → reattach ガードで MutationObserver の
    // 再発火ループを遮断（panel close → DOM 更新 → observer 発火 → 再度 collapseLiveChatIfNeeded
    // が即座に呼ばれて空振りループになるのを防ぐ）。
    if (liveChatObserver) {
      liveChatObserver.disconnect();
      liveChatObserverTarget = null;
      try {
        fireUserLikeClick(closeBtn);
      } finally {
        liveChatObserver.takeRecords();
        reAttachLiveChatObserver(true);
      }
    } else {
      fireUserLikeClick(closeBtn);
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
      if (!active || !isVideoFilterPage()) return;
      // 検索ページ向け（既存ロジック）。内部で isResultsPage() ゲートあり。
      removeDistractions();
      highlightThumbnails();
      highlightMismatchedVideos();
      // フィードページ向け（新ロジック）。内部で isFeedPage() ゲートあり。
      purgeFeedDistractions();
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

  // ---------- フィードページ（ホーム / 登録 / 急上昇）の動画フィルタ ----------
  /**
   * フィードページで yt-lockup-view-model 配下の動画フィルタを実行する。
   *
   * 判定対象は ChromeMCP 実機検証済みの 5 機能のみ:
   *   - shortsBtn: a[href*="/shorts/"] を含むカード
   *   - playlist:  playlist?list= リンク or "N 本の動画" / "N videos" バッジ
   *   - mix:       &list=RD リンク or "ミックスリスト" バッジ
   *   - watched:   .ytThumbnailOverlayProgressBarHostWatchedProgressBar overlay
   *   - live:      バッジテキストが "LIVE" / "PREMIERE" / "ライブ配信中" / "プレミア公開"
   *
   * verified / artist は yt-lockup-view-model 配下のセレクタ未確定で次版持ち越し。
   * shelf / cardList / course / channel / secondary / chapter / reel は検索ページ固有 DOM の
   * ため対応 DOM がフィードに存在せず実装不要（既存 removeDistractions のみで完結）。
   *
   * 削除対象は親 `ytd-rich-item-renderer` ごと（リッチグリッド構造の整合性維持）。
   * 親が無い場合は lockup 自身を remove。
   */
  const FEED_PLAYLIST_BADGE_RE = /^\d+\s*本の動画$|^\d+\s*videos?$/i;
  const FEED_MIX_BADGE_TEXT = "ミックスリスト";
  const FEED_LIVE_BADGE_TEXTS = new Set(["LIVE", "PREMIERE", "ライブ配信中", "プレミア公開"]);

  function purgeFeedDistractions() {
    if (!isFeedPage()) return;

    // 「その他のトピック」セクションは独立した DOM (ytd-rich-section-renderer) で
    // yt-lockup-view-model 配下の判定とは別ロジック。先に処理しておく。
    if (f("removeTopicsSection")) {
      // ChromeMCP 実機検証で確認した DOM 構造:
      //   ytd-rich-section-renderer (style-scope ytd-rich-grid-renderer)
      //     └ ytd-chips-shelf-with-video-shelf-renderer
      //   タイトル: 「その他のトピック」(日本語) / 推定 "Topics for you" (英語)
      //
      // :has() で「中に ytd-chips-shelf-with-video-shelf-renderer を持つ section」に絞り、
      // さらに textContent で「その他のトピック」または "Topics for you" を含むものだけ削除する
      // 二重ガード（将来的に別の用途で ytd-rich-section-renderer が増えたとき誤削除を防ぐ）。
      try {
        const sections = document.querySelectorAll(
          "ytd-rich-section-renderer:has(ytd-chips-shelf-with-video-shelf-renderer)"
        );
        for (const section of sections) {
          if (!section.isConnected) continue;
          const text = section.textContent ?? "";
          if (text.includes("その他のトピック") || text.includes("Topics for you")) {
            section.remove();
          }
        }
      } catch {
        // :has() 未対応環境向けフォールバック（minimum_chrome_version 140 では発生しないはずだが防御的）
        const sections = document.querySelectorAll("ytd-rich-section-renderer");
        for (const section of sections) {
          if (!section.isConnected) continue;
          if (!section.querySelector("ytd-chips-shelf-with-video-shelf-renderer")) continue;
          const text = section.textContent ?? "";
          if (text.includes("その他のトピック") || text.includes("Topics for you")) {
            section.remove();
          }
        }
      }
    }

    const checkShortsBtn = f("shortsBtn");
    const checkLive = f("live");
    const checkPlaylist = f("playlist");
    const checkMix = f("mix");
    const checkWatched = f("watched");
    if (!(checkShortsBtn || checkLive || checkPlaylist || checkMix || checkWatched)) return;

    const lockups = document.querySelectorAll("yt-lockup-view-model");
    for (const lockup of lockups) {
      if (!lockup.isConnected) continue;
      let shouldRemove = false;

      // 1. Shorts 動画リンク（個別 Shorts カード）
      if (checkShortsBtn && lockup.querySelector('a[href*="/shorts/"]')) {
        shouldRemove = true;
      }
      // 2. 視聴済み progress overlay
      else if (
        checkWatched &&
        lockup.querySelector(".ytThumbnailOverlayProgressBarHostWatchedProgressBar")
      ) {
        shouldRemove = true;
      }
      // 3. バッジテキスト系（ミックス → プレイリスト → ライブの順で判定）
      else if (checkMix || checkPlaylist || checkLive) {
        const badges = Array.from(lockup.querySelectorAll(".ytBadgeShapeHost"));
        const badgeTexts = badges.map((b) => (b.textContent ?? "").trim());
        // ミックス判定（特異性が最も高いので最優先）
        if (
          checkMix &&
          (badgeTexts.includes(FEED_MIX_BADGE_TEXT) ||
            !!lockup.querySelector('a[href*="&list=RD"]'))
        ) {
          shouldRemove = true;
        }
        // プレイリスト判定（playlist?list= または「N 本の動画」バッジ）
        else if (
          checkPlaylist &&
          (badgeTexts.some((t) => FEED_PLAYLIST_BADGE_RE.test(t)) ||
            !!lockup.querySelector('a[href*="playlist?list"]'))
        ) {
          shouldRemove = true;
        }
        // ライブ / プレミア判定
        else if (checkLive && badgeTexts.some((t) => FEED_LIVE_BADGE_TEXTS.has(t))) {
          shouldRemove = true;
        }
      }

      if (shouldRemove) {
        const parent = lockup.closest("ytd-rich-item-renderer");
        if (parent && parent.isConnected) parent.remove();
        else lockup.remove();
      }
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

  // ==========================================================================
  // 登録チャンネル拡張（A1 leftnav 全件注入 / A2 ショートカット / C グリッド化）
  // YouTube の左サイドバー「登録チャンネル」は表示件数に上限があり、ソートも標準では
  // 提供されないため、本拡張は以下の 3 サブ機能で補強する:
  //   - subsLeftnavInjectAll: /feed/channels から全 channel を取得して leftnav 末尾に注入
  //   - subsAllShortcut:     leftnav 見出し横に /feed/channels への 1 クリックボタン追加
  //   - subsChannelsGrid:    /feed/channels をレスポンシブグリッド化 + 検索 + ソート + lazy
  //                          fetch で最新動画サムネ取得（チャンネルページ HTML から og:image
  //                          + externalId を抽出。sessionStorage に 24h キャッシュ）
  // ==========================================================================

  const SUBS_INJECT_MARKER = "__cpa-sfx-subs-injected";
  const SUBS_SHORTCUT_MARKER = "__cpa-sfx-subs-shortcut";
  const SUBS_TOOLBAR_ID = "__cpa-sfx-subs-toolbar";
  const SUBS_GRID_CLASS = "__cpa-sfx-subs-grid";
  const SUBS_THUMB_CLASS = "__cpa-sfx-subs-thumb";
  const SUBS_CARD_MARKER_ATTR = "data-cpa-subs-card";
  // v3: v2 は `parseSubsListFromDocument` が DOM の `<img src>` だけを見ていたため、
  // YouTube の lazy hydrate により可視範囲外チャンネルの src が空文字になっており、
  // leftnav 注入時にアイコンが欠落するバグがあった。v3 では ytInitialData JSON から
  // thumbnail URL を取り出すため空 URL は出ない。旧 v2 cache は schema bump で破棄する。
  const SUBS_CACHE_LIST_KEY = "__cpa_subs_list_v3";
  // v5 bump 理由: thumbnail URL を hqdefault.jpg (480x360, 4:3) から maxresdefault.jpg
  // (1280x720, 16:9) に切り替え。hqdefault は 4:3 のため avatar-section 16:9 枠に
  // object-fit:cover で入れると上下 cropping が発生し、ホーム画面の 16:9 サムネと
  // 見た目が揃わず「左上に寄って見える」UX 事故が出ていた (実機検証で確定)。
  //
  // v4 (1 つ前): YouTube が `/feeds/videos.xml` エンドポイントを廃止 (404)。
  // 旧コードは Stage2 で RSS から最新動画 thumbnail を取りに行っていたが、全件 thumbUrl=null
  // で cache に書き込まれサムネ表示が完全停止する退行が発生したため、Stage2 RSS fetch を
  // 撤去して `/${handle}` HTML 内の最初の "videoId":"..." を抽出する版に切替。
  const SUBS_CACHE_THUMB_PREFIX = "__cpa_subs_thumb_v5::";
  const SUBS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  // 名前順ソート用の collator。日本語 + 数値混在を自然に並べる。
  // 第 1 引数には valid な locale string か object を渡す必要があり、undefined を
  // 配列に混ぜると `Language ID should be string or object` でコンストラクタが throw する
  // (これで IIFE 全体が落ちて全機能停止するという致命バグを起こした履歴あり)。
  // "ja" 単体を渡し、未対応環境では JS エンジンが自動でフォールバックする。
  const subsCollator = new Intl.Collator("ja", {
    sensitivity: "base",
    numeric: true,
    usage: "sort",
  });

  /** @type {Promise<Array<{handle:string,name:string,href:string,avatarUrl:string}>>|null} */
  let subsListFetchInFlight = null;
  /** @type {{toolbar:HTMLElement,search:HTMLInputElement,sort:HTMLSelectElement,observer:IntersectionObserver|null}|null} */
  let subsGridState = null;
  /** @type {MutationObserver|null} ネイティブ sort dropdown 操作後の card 再 hydrate を検出する observer */
  let subsGridCardsObserver = null;
  /** @type {number} subsGridCardsObserver の debounce timer (150ms) */
  let subsGridCardsScanTimer = 0;
  /** @type {((this: Window, ev: UIEvent) => void) | null} window resize listener (responsive items-per-row) */
  let subsGridResizeListener = null;
  /** @type {number} resize debounce timer */
  let subsGridResizeTimer = 0;
  // sort dropdown 操作の cooldown / click capture / popup-closed listener はすべて 2026-05 に撤去。
  // 動機: 「初回 sort dropdown 切替で label が rollback する」YouTube 側 bug を補正しようとして
  //   click capture + cooldown gate + post-cooldown re-scan を入れていたが、実機検証 (extension OFF
  //   で検証) で **bug は YouTube 側で extension では補正不能** と判明。
  //   さらに ON 時は cooldown listener が dropdown popup の Polymer state に干渉して
  //   「2 回目以降 popup が再開しない」という別 bug を生んでしまっていた (extension OFF 時は
  //    2 回目以降が正常に切り替わることで切り分け確定)。
  //   よって最善策は「extension は何もせず、YouTube に任せる」=== これら全撤去。
  /** @type {MutationObserver|null} leftnav の subs section #items を監視して再注入する observer */
  let leftnavInjectObserver = null;
  /** @type {Element|null} 観察中の subs section（同一 section への重複 attach 防止） */
  let leftnavSectionWatched = null;
  /** @type {MutationObserver|null} body 全体監視（subs section 出現待ち用、leftnav が SPA で破壊・再構築される間使用） */
  let leftnavBodyObserver = null;
  /** @type {number} leftnav 再注入の debounce timer */
  let leftnavReinjectTimer = 0;

  /** 中央ディスパッチャ: onSettingsChanged から呼ばれる。各機能内で OFF 時 cleanup を実施。 */
  function applySubsFeatures() {
    // leftnav は SPA navigation で YouTube が破壊・再構築する。
    // MutationObserver による「section 出現待ち + 注入要素消失検知 → 再注入」を仕掛けて
    // どのタイミング・どのページからでも確実に注入されるようにする。
    ensureLeftnavObservers();
    applySubsLeftnavInjection();
    applySubsAllShortcut();
    applySubsChannelsGrid();
  }

  /**
   * leftnav の subs section に対して 2 段階の MutationObserver を仕掛ける:
   *   1) body 全体監視: subs section が hydrate されて DOM に出現するまで待つ
   *   2) section の #items 監視: YouTube が「もっと見る」展開・collapse 等で childList を
   *      書き換えて注入要素を消したときに再注入する
   */
  function ensureLeftnavObservers() {
    // 機能 OFF 時は監視も停止
    if (!f("subsLeftnavInjectAll") && !f("subsAllShortcut")) {
      detachLeftnavObservers();
      return;
    }
    const section = findSubsSection();
    if (!section) {
      // section 未出現: body 監視で待つ
      if (!leftnavBodyObserver) {
        leftnavBodyObserver = new MutationObserver(() => {
          const found = findSubsSection();
          if (found) {
            // body 監視は不要になったので停止
            leftnavBodyObserver?.disconnect();
            leftnavBodyObserver = null;
            // 注入と #items 観察 attach
            scheduleLeftnavReinject();
            attachItemsObserver(found);
          }
        });
        leftnavBodyObserver.observe(document.body || document.documentElement, {
          subtree: true,
          childList: true,
        });
      }
      return;
    }
    // section 既に出現: items 監視
    attachItemsObserver(section);
  }

  function attachItemsObserver(section) {
    if (leftnavSectionWatched === section && leftnavInjectObserver) return;
    leftnavSectionWatched = section;
    if (leftnavInjectObserver) {
      try { leftnavInjectObserver.disconnect(); } catch {}
    }
    const items = section.querySelector("#items");
    if (!items) return;
    leftnavInjectObserver = new MutationObserver(() => {
      // 機能 ON かつ注入要素が居ない場合のみ再注入
      if (!f("subsLeftnavInjectAll") && !f("subsAllShortcut")) return;
      scheduleLeftnavReinject();
    });
    leftnavInjectObserver.observe(items, { childList: true });
  }

  function detachLeftnavObservers() {
    if (leftnavBodyObserver) {
      try { leftnavBodyObserver.disconnect(); } catch {}
      leftnavBodyObserver = null;
    }
    if (leftnavInjectObserver) {
      try { leftnavInjectObserver.disconnect(); } catch {}
      leftnavInjectObserver = null;
    }
    leftnavSectionWatched = null;
    if (leftnavReinjectTimer) {
      clearTimeout(leftnavReinjectTimer);
      leftnavReinjectTimer = 0;
    }
  }

  /** 連続 mutation を 1 回の再注入に圧縮するための debounce。 */
  function scheduleLeftnavReinject() {
    if (leftnavReinjectTimer) return;
    leftnavReinjectTimer = setTimeout(() => {
      leftnavReinjectTimer = 0;
      applySubsLeftnavInjection();
      applySubsAllShortcut();
    }, 80);
  }

  // ----- 共通 helpers -----

  /** leftnav の「登録チャンネル」セクションを返す（見出しの a[title] で識別）。 */
  function findSubsSection() {
    const headers = document.querySelectorAll("ytd-guide-entry-renderer#header-entry");
    for (const e of headers) {
      const a = e.querySelector("a");
      const t = a?.getAttribute("title");
      if (t === "登録チャンネル" || t === "Subscriptions") {
        return e.closest("ytd-guide-section-renderer");
      }
    }
    return null;
  }

  /** leftnav の「登録チャンネル」見出し ytd-guide-entry-renderer を返す。 */
  function findSubsHeaderEntry() {
    const headers = document.querySelectorAll("ytd-guide-entry-renderer#header-entry");
    for (const e of headers) {
      const a = e.querySelector("a");
      const t = a?.getAttribute("title");
      if (t === "登録チャンネル" || t === "Subscriptions") return e;
    }
    return null;
  }

  /** "/@handle" 形式の href から @handle 部分を抽出。 */
  function extractHandleFromHref(href) {
    if (!href) return null;
    const m = href.match(/\/(@[\w.-]{1,60})(?:\/|$|\?)/);
    return m ? m[1] : null;
  }

  /** subs section に既にネイティブで存在するチャンネルの handle を集合で返す（重複注入防止）。 */
  function collectExistingHandles(subsSection) {
    const set = new Set();
    subsSection
      .querySelectorAll("ytd-guide-entry-renderer:not(#header-entry) a[href]")
      .forEach((a) => {
        const h = extractHandleFromHref(a.getAttribute("href") || "");
        if (h) set.add(h);
      });
    return set;
  }

  /** カードからチャンネル名を取得（main-link の textContent）。 */
  function getSubsCardName(card) {
    return (card.querySelector("#main-link")?.textContent || "").trim();
  }

  /**
   * /feed/channels の ytd-channel-renderer 内では ID 名と内容が歴史的に交差しており、
   * `#video-count` 要素のテキストに「チャンネル登録者数 N万人」が入る。
   * 日本語 (万/億/千) と英語 (K/M/B) の両形式を解析して整数を返す。
   */
  function getSubsCardSubscribersCount(card) {
    const txt = (card.querySelector("#video-count")?.textContent || "").trim();
    return parseSubscriberCountText(txt);
  }

  function parseSubscriberCountText(txt) {
    if (!txt) return 0;
    const t = txt.replace(/[\s,]/g, "");
    let m = t.match(/(\d+(?:\.\d+)?)億/);
    if (m) return Math.round(parseFloat(m[1]) * 100_000_000);
    m = t.match(/(\d+(?:\.\d+)?)万/);
    if (m) return Math.round(parseFloat(m[1]) * 10_000);
    m = t.match(/(\d+(?:\.\d+)?)千/);
    if (m) return Math.round(parseFloat(m[1]) * 1_000);
    m = t.match(/(\d+(?:\.\d+)?)B\b/i);
    if (m) return Math.round(parseFloat(m[1]) * 1_000_000_000);
    m = t.match(/(\d+(?:\.\d+)?)M\b/i);
    if (m) return Math.round(parseFloat(m[1]) * 1_000_000);
    m = t.match(/(\d+(?:\.\d+)?)K\b/i);
    if (m) return Math.round(parseFloat(m[1]) * 1_000);
    m = t.match(/(\d+)/);
    if (m) return parseInt(m[1], 10) || 0;
    return 0;
  }

  // ----- A1: leftnav 全件注入 -----

  async function applySubsLeftnavInjection() {
    if (!f("subsLeftnavInjectAll")) {
      document.querySelectorAll(`.${SUBS_INJECT_MARKER}`).forEach((el) => el.remove());
      return;
    }
    const subsSection = findSubsSection();
    if (!subsSection) return;
    const itemsDiv = subsSection.querySelector("#items");
    if (!itemsDiv) return;

    const list = await fetchSubsList();
    if (!list || list.length === 0) return;

    // 機能 OFF 後に再度 ON されたケース等の race condition で active が変わる可能性
    if (!f("subsLeftnavInjectAll")) return;

    // 旧 schema で注入された entry（説明文丸ごと span に入っている等）を撤去する。
    // 期待する正規形式: <a><img><span>{name}</span></a>。span が 80 文字超 or img 不在なら旧形式。
    itemsDiv.querySelectorAll(`.${SUBS_INJECT_MARKER}`).forEach((el) => {
      const span = el.querySelector(":scope > span");
      const img = el.querySelector(":scope > img");
      const spanText = (span?.textContent || "").trim();
      if (!img || !span || spanText.length > 80) {
        el.remove();
      }
    });

    const existing = collectExistingHandles(subsSection);
    const injected = new Set();
    itemsDiv.querySelectorAll(`.${SUBS_INJECT_MARKER}`).forEach((el) => {
      const h = el.getAttribute("data-handle");
      if (h) injected.add(h);
    });

    const fragment = document.createDocumentFragment();
    for (const ch of list) {
      if (!ch.handle) continue;
      if (existing.has(ch.handle)) continue;
      if (injected.has(ch.handle)) continue;
      fragment.appendChild(buildSubsLeftnavEntry(ch));
      injected.add(ch.handle);
    }
    if (fragment.childNodes.length > 0) {
      // 「もっと見る」expander が見つかればその前に挿入し、native の表示順序を尊重する。
      // 見つからなければ末尾 append（折り畳みなしで全件展開済みケース）。
      const expander = findLeftnavExpanderEntry(itemsDiv);
      if (expander) {
        itemsDiv.insertBefore(fragment, expander);
      } else {
        itemsDiv.appendChild(fragment);
      }
    }
  }

  /**
   * leftnav の subs section #items 配下から「もっと見る」/「もっと表示」/「Show more」相当の
   * expander entry を返す（注入済みの自分の要素はスキップ）。
   * native の expander が見つかれば、その直前に注入することで表示順序を保つ。
   */
  function findLeftnavExpanderEntry(itemsDiv) {
    if (!itemsDiv) return null;
    for (let i = itemsDiv.children.length - 1; i >= 0; i--) {
      const c = itemsDiv.children[i];
      if (c.classList?.contains(SUBS_INJECT_MARKER)) continue;
      const tag = c.tagName.toLowerCase();
      if (tag === "ytd-guide-collapsible-entry-renderer") return c;
      const txt = (c.textContent || "").trim();
      if (/^(もっと見る|もっと表示|Show more|表示を減らす|Show less)/.test(txt)) {
        return c;
      }
    }
    return null;
  }

  function buildSubsLeftnavEntry(ch) {
    const link = document.createElement("a");
    link.className = SUBS_INJECT_MARKER;
    link.href = ch.href;
    link.title = ch.name;
    link.setAttribute("data-handle", ch.handle);
    const avatarUrl = normalizeAvatarUrl(ch.avatarUrl);
    if (avatarUrl) {
      const img = document.createElement("img");
      img.src = avatarUrl;
      img.alt = "";
      img.loading = "lazy";
      // referrerPolicy はブラウザデフォルト (strict-origin-when-cross-origin) に任せる。
      // no-referrer を強制すると Google CDN が hot-link 保護で 403 を返すケースがある。
      link.appendChild(img);
    } else {
      // ytInitialData も DOM scan も avatarUrl を取得できなかった場合のフォールバック。
      // 24px 円プレースホルダにチャンネル名の頭文字 1 文字を描画。アイコン領域を空のままに
      // するとテキストだけがズレた位置に出て leftnav の縦リズムが崩れるため、少なくとも
      // 円の場所だけは確保する。
      const fallback = document.createElement("span");
      fallback.className = "__cpa-sfx-leftnav-fallback";
      fallback.setAttribute("aria-hidden", "true");
      fallback.textContent = (ch.name || "?").slice(0, 1);
      link.appendChild(fallback);
    }
    const label = document.createElement("span");
    label.textContent = ch.name;
    link.appendChild(label);
    return link;
  }

  /**
   * YouTube のアバター URL は `//yt3.googleusercontent.com/...` のプロトコル相対形式で
   * DOM に入っているケースがある。chrome-extension:// 由来の処理経路で resolved-url を
   * そのまま使うと src が空扱いになるブラウザ実装があるため、明示的に https: を付ける。
   */
  function normalizeAvatarUrl(url) {
    if (!url || typeof url !== "string") return "";
    if (url.startsWith("//")) return "https:" + url;
    return url;
  }

  /**
   * 登録チャンネル一覧を取得する。優先順位:
   *   1. sessionStorage のキャッシュ（24h 有効）
   *   2. 現在 /feed/channels に居る場合はページ DOM から取得
   *   3. それ以外は /feed/channels を同一オリジンで fetch して DOMParser でパース
   */
  async function fetchSubsList() {
    const fromCache = readSubsListCache();
    if (fromCache) return fromCache;
    if (location.pathname === "/feed/channels") {
      const list = parseSubsListFromDocument(document);
      if (list.length > 0) writeSubsListCache(list);
      return list;
    }
    if (subsListFetchInFlight) return subsListFetchInFlight;
    subsListFetchInFlight = (async () => {
      try {
        const res = await fetch("/feed/channels", { credentials: "same-origin" });
        if (!res.ok) return null;
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const list = parseSubsListFromDocument(doc);
        if (list.length > 0) writeSubsListCache(list);
        return list;
      } catch {
        return null;
      } finally {
        subsListFetchInFlight = null;
      }
    })();
    return subsListFetchInFlight;
  }

  function parseSubsListFromDocument(doc) {
    // v3: ytInitialData JSON から取るのが第一手段。YouTube は lazy hydrate により DOM の
    // `<img src>` を空のままにしておくケースが多く（実機で 157 件中 146 件が空という壊滅的状況を確認）、
    // DOM scan のみだと avatarUrl が大量に欠落して leftnav にアイコンなし注入が量産される。
    // ytInitialData は SSR 時点で全件分の thumbnail URL を含むため確実。
    const fromJson = parseSubsListFromYtInitialData(doc);
    if (fromJson.length > 0) return fromJson;
    // フォールバック: ytInitialData が抽出できなかった場合の DOM scan（旧 v2 互換経路）。
    return parseSubsListFromDom(doc);
  }

  /**
   * SSR 埋め込みの `<script>var ytInitialData = {...};</script>` から登録チャンネルを抽出。
   * 構造変更耐性のため再帰 walk で channelRenderer を探す。thumbnail.thumbnails の最大解像度
   * URL を採用（leftnav 24px / カード overlay 36px / カード中央 96px 表示の全用途を
   * 1 URL でカバー）。
   */
  function parseSubsListFromYtInitialData(doc) {
    let json = null;
    for (const s of doc.querySelectorAll("script")) {
      const t = s.textContent || "";
      if (t.indexOf("ytInitialData") === -1) continue;
      const raw = extractVarAssignmentJson(t, "ytInitialData");
      if (!raw) continue;
      try {
        json = JSON.parse(raw);
        break;
      } catch {
        // 次の <script> を試す
      }
    }
    if (!json) return [];

    const channels = [];
    const seen = new Set();

    /** @param {Record<string, any>|null|undefined} cr */
    function pushChannel(cr) {
      if (!cr || typeof cr !== "object") return;
      const url =
        cr.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ||
        cr.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ||
        "";
      const handle = extractHandleFromHref(url);
      if (!handle || seen.has(handle)) return;
      const name =
        cr.title?.simpleText ||
        (Array.isArray(cr.title?.runs)
          ? cr.title.runs.map((r) => (r && r.text) || "").join("")
          : "") ||
        "";
      if (!name) return;
      const thumbs = Array.isArray(cr.thumbnail?.thumbnails)
        ? cr.thumbnail.thumbnails
        : [];
      const best = thumbs.reduce(
        (acc, t) =>
          t && typeof t === "object" && t.url && (t.width || 0) > (acc?.width || 0)
            ? t
            : acc,
        null
      );
      const avatarUrl = best?.url || thumbs[0]?.url || "";
      seen.add(handle);
      channels.push({ handle, name, href: url, avatarUrl });
    }

    // 直接パス: contents.twoColumnBrowseResultsRenderer.tabs[].tabRenderer.content
    //          .sectionListRenderer.contents[].itemSectionRenderer.contents[]
    //          .shelfRenderer.content.expandedShelfContentsRenderer.items[].channelRenderer
    // 全件 walk は ytInitialData の全プロパティ再帰走査でコスト O(JSON ノード数) になり、
    // 数 MB スケールの SSR データだと数百 ms 食う。直接パスなら N=チャンネル数で完結する。
    const tabs = json?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    for (const tab of tabs) {
      const sections = tab?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      for (const section of sections) {
        const items = section?.itemSectionRenderer?.contents || [];
        for (const item of items) {
          const shelfItems =
            item?.shelfRenderer?.content?.expandedShelfContentsRenderer?.items ||
            item?.shelfRenderer?.content?.horizontalListRenderer?.items ||
            item?.gridRenderer?.items ||
            [];
          for (const it of shelfItems) {
            pushChannel(it?.channelRenderer);
          }
        }
      }
    }

    // 直接パスで 1 件も取れなかった場合のみ depth-limited フォールバック walk。
    // YouTube が将来 ytInitialData の構造を変えても、深さ 12 までなら追従できる。
    if (channels.length === 0) {
      /**
       * @param {unknown} node
       * @param {number} depth
       */
      function walk(node, depth) {
        if (depth > 12) return;
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item, depth + 1);
          return;
        }
        const obj = /** @type {Record<string, any>} */ (node);
        if (obj.channelRenderer) pushChannel(obj.channelRenderer);
        for (const k of Object.keys(obj)) walk(obj[k], depth + 1);
      }
      walk(json, 0);
    }

    return channels;
  }

  /**
   * `<script>` 中の `var XXXX = {...};` から JSON 部分を balanced `{}` で取り出す。
   * 文字列リテラル内の `}` をエスケープ込みで無視するため、正規表現より堅牢
   * （`var XXX = {...};` の `};` パターンは JSON 内部にも頻出するため正規表現は破綻しやすい）。
   */
  function extractVarAssignmentJson(text, varName) {
    const startKey = `var ${varName}`;
    const idxKey = text.indexOf(startKey);
    if (idxKey === -1) return null;
    const idxEq = text.indexOf("=", idxKey);
    if (idxEq === -1) return null;
    let i = idxEq + 1;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "{") return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (c === "\\") escape = true;
        else if (c === "\"") inString = false;
        continue;
      }
      if (c === "\"") inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return text.slice(i, j + 1);
      }
    }
    return null;
  }

  /**
   * フォールバック: DOM scan で取る旧経路。ytInitialData が見つからないときのみ使う。
   * lazy hydrate 前は `<img src>` が空のことが多いため、avatarUrl 取得率は低い。
   */
  function parseSubsListFromDom(doc) {
    const channels = [];
    const seen = new Set();
    doc.querySelectorAll("ytd-channel-renderer").forEach((ch) => {
      const mainLink = ch.querySelector("#main-link");
      const href = mainLink?.getAttribute("href") || "";
      const handle = extractHandleFromHref(href);
      if (!handle || seen.has(handle)) return;
      const name = extractCleanText(mainLink);
      if (!name) return;
      seen.add(handle);
      channels.push({
        handle,
        name,
        href,
        avatarUrl: ch.querySelector("#avatar img")?.getAttribute("src") || "",
      });
    });
    return channels;
  }

  /**
   * Polymer の `<yt-formatted-string>` 等は内部に同じテキストを 2 つ以上保持していることがあり、
   * `el.textContent` で取得すると "名前\n  \n  \n  名前" のように改行区切りで二重出力される。
   * 改行で分割して trim 後、最初の non-empty トークンを返すことで安定して 1 つの文字列を取り出す。
   */
  function extractCleanText(el) {
    if (!el) return "";
    const raw = el.textContent || "";
    // 改行で分割 → 各行 trim → 空行を除去
    const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return "";
    return lines[0];
  }

  function readSubsListCache() {
    try {
      const raw = sessionStorage.getItem(SUBS_CACHE_LIST_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.list)) return null;
      if (Date.now() - (data.ts || 0) > SUBS_CACHE_TTL_MS) return null;
      // アカウント識別子が cache と現在ページで食い違うなら別アカウント切替後とみなして invalidate。
      // sessionStorage はタブ単位で persist するため、サインアウト → 別アカウントログインの reload を
      // 跨いでも残る。識別子無しで信用すると 24h 古いアカウントの subscriptions を leftnav に
      // 注入する事故が起きる（Codex P2 指摘）。
      // どちらかの ID 取得に失敗した場合は安全側に倒して cache を信用する（旧挙動互換）。
      if (data.accountId) {
        const currentId = getCurrentYouTubeAccountId();
        if (currentId && currentId !== data.accountId) return null;
      }
      return data.list;
    } catch {
      return null;
    }
  }

  function writeSubsListCache(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    try {
      const accountId = getCurrentYouTubeAccountId();
      sessionStorage.setItem(
        SUBS_CACHE_LIST_KEY,
        JSON.stringify({ list, ts: Date.now(), accountId })
      );
    } catch {
      // QuotaExceeded 等は無視
    }
  }

  /**
   * 現在ログイン中の YouTube アカウントを識別する文字列を返す。`<script>` タグ内の
   * `ytcfg.set({...})` 経由で埋め込まれている DELEGATED_SESSION_ID（unique hash）を最優先で、
   * 見つからなければ SESSION_INDEX（"0" = デフォルトアカウント、"1" "2" ... = 追加アカウント）に
   * フォールバックする。content script は page world の `window.ytcfg` に直接アクセスできない
   * ため、SSR で埋め込まれた script tag を正規表現で読み取る方式を採る。
   *
   * 取得不能なら null を返す。読み取り側はこのときキャッシュ検証をスキップする (graceful fallback)。
   */
  function getCurrentYouTubeAccountId() {
    try {
      for (const s of document.querySelectorAll("script")) {
        const t = s.textContent || "";
        if (t.indexOf("DELEGATED_SESSION_ID") === -1 && t.indexOf("SESSION_INDEX") === -1) continue;
        let m = t.match(/"DELEGATED_SESSION_ID":\s*"([^"]+)"/);
        if (m) return "ds:" + m[1];
        m = t.match(/"SESSION_INDEX":\s*"([^"]*)"/);
        if (m) return "si:" + m[1];
      }
    } catch {
      // 失敗時は null で安全側に倒す
    }
    return null;
  }

  // ----- A2: ショートカットボタン -----

  function applySubsAllShortcut() {
    const existing = document.querySelector(`.${SUBS_SHORTCUT_MARKER}`);
    if (!f("subsAllShortcut")) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return; // idempotent
    // 「登録チャンネル」section の **最初のチャンネル entry の直前** = `<h3>` 見出しの直下、
    // チャンネルリストの最上に entry として挿入する。
    //
    // ゆろさんの希望「YouTube 公式メニューの一部なんじゃないかみたいな感じで」を満たすため、
    // 旧実装 (見出し横の SVG 小ボタン) は廃止して通常の leftnav entry 風に作り変えた。
    //
    // **section の sibling として insertBefore してはいけない**:
    //   試しに `section.parentElement.insertBefore(entry, section)` で sibling 挿入したところ、
    //   Polymer dom-repeat が「section list の構造が変わった」と検知して内部 reordering を発動し、
    //   subs section が leftnav の **末尾に移動** してしまう退行が起きた (実機検証で確定 2026-05-08
    //   ゆろさん環境)。`<a>` を Polymer 管理下の section 兄弟として inject するのは fragile すぎる。
    //
    // **subs section の DOM 構造 (実機計測で確定):**
    //   <ytd-guide-section-renderer>
    //     <h3>登録チャンネル</h3>                                        ← 見出し
    //     <div #items>
    //       <ytd-guide-collapsible-section-entry-renderer>             ← idx 0 (「もっと見る」expander)
    //       <ytd-guide-entry-renderer>小柳ロウ</...>                   ← idx 1 (最初のチャンネル)
    //       <ytd-guide-entry-renderer>リバース☆さっきー</...>          ← idx 2
    //       ...
    //     </div>
    //   </ytd-guide-section-renderer>
    //
    //   `#items.firstElementChild` は collapsible (expander) なので、その前に入れると
    //   「もっと見る」より上 = 見た目「登録チャンネル」の上に entry が置かれてしまう。
    //   **最初の `<ytd-guide-entry-renderer>` 直前**に挿入すれば「見出し → expander → 我々 → 小柳ロウ → ...」
    //   ではなく「見出し → 我々 → 小柳ロウ → ... → 末尾の expander」の自然な並びになる。
    //   ※ collapsible entry が末尾にあるか先頭にあるかは YouTube のレイアウト次第だが、
    //     `:not(#header-entry)` で expander や headerEntry を除外する保険つき。
    //
    // この手法は subsLeftnavInjectAll が採用している「Polymer dom-repeat 配下に `<a>` を直接
    // inject」と同じ安全パターン。Polymer は section 構造を破壊しない。
    const section = findSubsSection();
    if (!section) return;
    const itemsDiv = section.querySelector("#items");
    if (!itemsDiv) return;
    const entry = document.createElement("a");
    entry.className = SUBS_SHORTCUT_MARKER;
    entry.href = "/feed/channels";
    entry.title = "すべての登録チャンネル";
    entry.setAttribute("aria-label", "すべての登録チャンネル");
    // SVG アイコン (リスト風) + ラベルの横並び。CSS 側で公式 entry サイズ (高さ 40px / icon 12+12 / text 72) に揃える。
    // YouTube は Trusted Types policy を有効化しているため innerHTML 代入は弾かれる。
    // content script の isolated world では制約が緩いが、安全側に倒して createElement で構築する。
    const iconSpan = document.createElement("span");
    iconSpan.className = `${SUBS_SHORTCUT_MARKER}-icon`;
    iconSpan.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute(
      "d",
      "M3 5h14v2H3V5zm0 6h14v2H3v-2zm0 6h14v2H3v-2zm17-12h2v2h-2V5zm0 6h2v2h-2v-2zm0 6h2v2h-2v-2z"
    );
    svg.appendChild(path);
    iconSpan.appendChild(svg);
    const labelSpan = document.createElement("span");
    labelSpan.className = `${SUBS_SHORTCUT_MARKER}-label`;
    labelSpan.textContent = "すべての登録チャンネル";
    entry.appendChild(iconSpan);
    entry.appendChild(labelSpan);
    // 最初のチャンネル entry の直前に挿入。collapsible (expander) や header-entry は除外する。
    const firstChannel = itemsDiv.querySelector(
      "ytd-guide-entry-renderer:not(#header-entry)"
    );
    if (firstChannel) {
      itemsDiv.insertBefore(entry, firstChannel);
    } else {
      itemsDiv.appendChild(entry);
    }
  }

  // ----- C: /feed/channels グリッド化 + 検索 + ソート + lazy fetch -----

  function applySubsChannelsGrid() {
    const enabled = f("subsChannelsGrid") && location.pathname === "/feed/channels";
    if (!enabled) {
      detachSubsChannelsGrid();
      return;
    }
    document.documentElement.classList.add(SUBS_GRID_CLASS);
    ensureSubsGridToolbar();
    syncSubsGridItemsPerRow();
    startSubsGridResizeListener();
    scheduleSubsGridScan();
    startSubsGridCardsObserver();
    applySubsGridFilter();
  }

  /**
   * YouTube ネイティブ sort dropdown (左上「名前順」combobox) を操作すると
   * `ytd-channel-renderer` 群が再 hydrate されて新規ノードが追加される。
   * 新カードに対して inject (#avatar move + IntersectionObserver 登録) を再実行しないと
   * サムネ枠が空のまま「巨大アバター + サムネ無し」のレイアウト破壊に見えるため、
   * MutationObserver で childList 変化を観察し 150ms debounce で scheduleSubsGridScan を再呼び出しする。
   *
   * scheduleSubsGridScan / applyGridCardInlineStyle は冪等 (SUBS_CARD_MARKER_ATTR / data-cpa-subs-styled
   * で重複防止) なので何度呼んでも処理済みカードはスキップされる。
   */
  function startSubsGridCardsObserver() {
    if (subsGridCardsObserver) return;
    subsGridCardsObserver = new MutationObserver(() => {
      if (subsGridCardsScanTimer) return;
      subsGridCardsScanTimer = setTimeout(() => {
        subsGridCardsScanTimer = 0;
        if (!subsGridState) return;
        // ネイティブ sort dropdown (左上「関連度順 / 新しいアクティビティ / 名前順」) を操作すると
        // YouTube は `yt-reload-continuation-finish` でサーバー再取得 → `ytd-section-list-renderer`
        // **要素ごと** 置換されたり、`#primary` 配下が大きく組み替えられるケースがある。
        // この間に拡張の toolbar が DOM ツリーから外れる → 「検索ボックス消えた」と見える。
        // よって毎スキャンで `document.getElementById(SUBS_TOOLBAR_ID)` で在/不在を確認する。
        const toolbarMissing = !document.getElementById(SUBS_TOOLBAR_ID);
        if (toolbarMissing) {
          // 既存 state の toolbar 参照は detach 済みなので破棄して fresh recreation
          if (subsGridState) {
            subsGridState.toolbar = null;
            subsGridState.search = null;
          }
          ensureSubsGridToolbar();
          // toolbar 消滅 = ネイティブ sort 等で #contents が再構築された signal。
          // ネイティブが既存カードの DOM ノードを **物理移動だけ** で並び替えるケースもあり、
          // その場合カードに付与済みの SUBS_CARD_MARKER_ATTR が残る → 新しい IntersectionObserver
          // (subsGridState 再生成で作られる) に再 attach されず、サムネが永遠に inject されない罠。
          // → MARKER をクリアして全カードを fresh に observe させる。fetchAndInjectThumbnail は
          //   既に injected 済み (`.__cpa-sfx-subs-thumb` 子要素の存在チェック) なら早期 return する
          //   ので重複処理は発生しない。
          document
            .querySelectorAll(`ytd-channel-renderer[${SUBS_CARD_MARKER_ATTR}]`)
            .forEach((c) => {
              c.removeAttribute(SUBS_CARD_MARKER_ATTR);
            });
        } else {
          // toolbar exists but might be misplaced (例: 親が differs / next sibling が section-list でない)
          placeSubsGridToolbar();
        }
        scheduleSubsGridScan();
        applySubsGridFilter();
      }, 150);
    });
    // observer target は **document.body** に固定する。理由:
    //   - ytd-section-list-renderer / ytd-browse #primary は YouTube SPA で要素ごと置換される
    //     ことがあり、その場合 detach された旧要素を見続けて新 DOM の変化を検知できない。
    //   - body subtree:true は mutation 量が多いが 150ms debounce で 1 回/cluster に圧縮される。
    //   - 検知漏れによる「toolbar 消失 + cards observer が永遠に発火しない」状態の方が UX 影響が大きい。
    subsGridCardsObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopSubsGridCardsObserver() {
    if (subsGridCardsScanTimer) {
      clearTimeout(subsGridCardsScanTimer);
      subsGridCardsScanTimer = 0;
    }
    if (!subsGridCardsObserver) return;
    try { subsGridCardsObserver.disconnect(); } catch {}
    subsGridCardsObserver = null;
  }

  function detachSubsChannelsGrid() {
    // light cleanup は idempotent (toolbar / observer は存在チェック付き、class remove も冪等) なので
    // subsGridState の有無に関わらず実行して構わない。
    document.documentElement.classList.remove(SUBS_GRID_CLASS);
    const tb = document.getElementById(SUBS_TOOLBAR_ID);
    if (tb) tb.remove();
    stopSubsGridCardsObserver();
    stopSubsGridResizeListener();
    if (subsGridState?.observer) {
      try {
        subsGridState.observer.disconnect();
      } catch {
        // disconnect は throw しないが念のため
      }
    }
    // card 単位の cleanup は grid が一度でも active になっていたときだけ実行する。
    // ・別ページ (/feed/subscriptions 等) で popup の grid トグルを操作したり、別機能を toggle した
    //   ときも applySubsChannelsGrid 経由で detach が呼ばれるが、その場ではカード DOM に何も
    //   触れていないので cleanup する対象も無い。
    // ・ここで全 ytd-channel-renderer を query すると YouTube native state で hidden な card を
    //   誤って unhide する事故が起きる（Codex P2 指摘）。
    if (!subsGridState) return;
    // union クエリは「我々が付与した marker のいずれかを持つカード」のみに限定。
    // [hidden] は我々が必ず set/remove するときに上記 marker のいずれかも持っているため
    // hidden 単体で query する必要は無く、native hidden を巻き込むリスクを排除できる。
    document
      .querySelectorAll(
        `ytd-channel-renderer[${SUBS_CARD_MARKER_ATTR}],` +
          ` ytd-channel-renderer[data-cpa-subs-styled]`
      )
      .forEach((card) => {
        card.removeAttribute(SUBS_CARD_MARKER_ATTR);
        card.removeAttribute("hidden");
        card.style.order = "";
        clearGridCardInlineStyle(card);
      });
    document
      .querySelectorAll("ytd-shelf-renderer[hidden][data-cpa-shelf-empty]")
      .forEach((s) => {
        s.removeAttribute("hidden");
        s.removeAttribute("data-cpa-shelf-empty");
      });
    subsGridState = null;
  }

  function ensureSubsGridToolbar() {
    const existingTb = document.getElementById(SUBS_TOOLBAR_ID);
    if (existingTb) {
      // 状態のみ復元
      if (!subsGridState) {
        subsGridState = {
          toolbar: existingTb,
          search: existingTb.querySelector("input"),
          sort: null,
          observer: null,
        };
      }
      return;
    }
    // 古い IntersectionObserver を disconnect してから state を上書きする (重要)。
    // section-list 物理置換で toolbar が detach された経路では `subsGridState.toolbar = null` 後に
    // 本関数が呼ばれて `subsGridState = { ..., observer: null }` で state を完全上書きするが、
    // 古い observer の参照を破棄するだけでは observer 自体は生きていて observe 中のカードを
    // 監視し続ける。callback が mutable な subsGridState を読むため重複 inject や、grid 機能
    // disable 後の `subsGridState === null` dereference を起こす (Codex P2 指摘 2026-05-08)。
    if (subsGridState?.observer) {
      try {
        subsGridState.observer.disconnect();
      } catch {
        // disconnect は通常 throw しないが念のため
      }
    }
    const toolbar = document.createElement("div");
    toolbar.id = SUBS_TOOLBAR_ID;

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "チャンネル名で絞り込み";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.addEventListener("input", () => applySubsGridFilter());

    // sort UI は YouTube ネイティブの「名前順 / 登録順 / 最新アクティビティ順」combobox
    // (`<button role="combobox">`) と完全に役割が被るため拡張側からは出さない。
    // ネイティブ sort 操作後の card 再 hydrate には observeSubsGridCardAdditions が追従する。
    toolbar.append(search);
    subsGridState = { toolbar, search, sort: null, observer: null };
    // 挿入位置: 「最初の shelf の直前」が最も確実。最新 YouTube DOM では
    // `ytd-section-list-renderer #contents` 構造が必ずしも存在しないため shelf 直前を最優先。
    // shelf がまだ hydrate されてない場合は MutationObserver で待って再配置する。
    placeSubsGridToolbar();
  }

  /**
   * Toolbar を理想位置（shelf 直前）に配置。shelf がまだ DOM に居ない場合は MutationObserver
   * で出現を待ち、出現したら shelf 直前に移動する。これで body fallback のまま画面外に
   * 取り残される事故を防ぐ。
   */
  function placeSubsGridToolbar() {
    if (!subsGridState?.toolbar) return;
    const toolbar = subsGridState.toolbar;
    // toolbar 配置: ytd-section-list-renderer 配下、`#contents` の直前 (= `#header-container` の直後)。
    //
    // /feed/channels の実 DOM 構造 (実機計測 vw=2048):
    //   ytd-browse (flex column)
    //     #primary (flex ROW, h: 15452)  ← row layout なので primary 直下に置くと
    //                                       toolbar が 234×15452 の縦長細帯になる罠
    //       ytd-section-list-renderer (flex COLUMN, w: 1558, padding 0 48px)
    //         #header-container (1462 × 32)         ← ネイティブ sort dropdown はここ
    //         #contents (1462 × 15420)              ← cards はここ。sort で wipe される
    //         #action-button (hidden)
    //         #continuations (lazy-load trigger)
    //
    // section-list は flex column なので、その直下に toolbar を入れれば flex item として
    // **width 100% に伸び**、`#header-container` (sort UI) と `#contents` (cards) の間に
    // 自然に挟まる。`#contents` は sort で wipe されるが toolbar は **兄弟要素** なので
    // 巻き添えにならない (sort wipe は #contents の **内部** だけが対象)。
    //
    // 過去経緯: 旧設計は #primary 直下に置こうとしたが、querySelector の comma セレクタが
    // document order で `ytd-browse` 自体を返す罠 + #primary 自体が flex row で toolbar が
    // 縦帯化する罠で失敗していた。この section-list 直下配置がその両方を解決する。
    const sectionList = document.querySelector("ytd-section-list-renderer");
    if (!sectionList) {
      // section-list 未出現: body subtree 監視中の startSubsGridCardsObserver が
      // section-list 出現時に再呼び出しするので、ここでは何もしない。
      return;
    }
    const contents = sectionList.querySelector(":scope > #contents");
    // 理想配置: section-list 直下、#contents の直前
    const desiredParent = sectionList;
    const desiredNextSibling = contents || null;
    if (
      toolbar.parentElement !== desiredParent ||
      toolbar.nextElementSibling !== desiredNextSibling
    ) {
      // insertBefore(node, null) は append と同義 (#contents が未出現でも安全)
      desiredParent.insertBefore(toolbar, desiredNextSibling);
    }
  }

  /**
   * /feed/channels の grid items-per-row を viewport 連動で動的に決める。
   *
   * 重要発見 (実機計測):
   *   `--ytd-rich-grid-items-per-row` は YouTube が `ytd-rich-grid-renderer` の **inline style**
   *   としてのみ正しく更新する。`html` (document root) にも同名の変数が設定されているが、
   *   こちらは **STALE な値 (常に 4)** で viewport 変更に追従しない。
   *   /feed/channels には `ytd-rich-grid-renderer` が存在しないため、html の stale 値だけが
   *   見え、CSS の `var(--ytd-rich-grid-items-per-row)` が viewport に追従しない罠があった。
   *
   * 解決策: 自前で viewport 幅から items-per-row を計算し、
   *   `--cpa-sfx-subs-items-per-row` カスタム変数を html に設定する。
   *   CSS 側は `repeat(var(--cpa-sfx-subs-items-per-row, 3), ...)` でこれを参照する。
   *
   * breakpoint 値は feed/home の `ytd-rich-grid-renderer` inline style を複数 viewport で
   * 実測した結果に基づく:
   *   vw 2048 → 4 / vw 1900 → 3 / vw 1100 → 3 / vw 800 → 2
   *   ⇒ 4: vw >= 1980 / 3: vw >= 1085 / 2: vw >= 670 / 1: それ以下
   * (境界値は経験的近似。YouTube 内部の正確な閾値は不明だが、ユーザの体感と一致する範囲を採用)
   */
  function computeSubsGridItemsPerRow(vw) {
    if (vw >= 1980) return 4;
    if (vw >= 1085) return 3;
    if (vw >= 670) return 2;
    return 1;
  }

  function syncSubsGridItemsPerRow() {
    const items = computeSubsGridItemsPerRow(window.innerWidth);
    document.documentElement.style.setProperty("--cpa-sfx-subs-items-per-row", String(items));
  }

  function startSubsGridResizeListener() {
    if (subsGridResizeListener) return;
    // 100ms debounce: resize ドラッグ中の連続発火を coalesce してリフロー回数を抑制。
    subsGridResizeListener = () => {
      if (subsGridResizeTimer) return;
      subsGridResizeTimer = setTimeout(() => {
        subsGridResizeTimer = 0;
        if (!document.documentElement.classList.contains(SUBS_GRID_CLASS)) return;
        syncSubsGridItemsPerRow();
      }, 100);
    };
    window.addEventListener("resize", subsGridResizeListener, { passive: true });
  }

  function stopSubsGridResizeListener() {
    if (!subsGridResizeListener) return;
    window.removeEventListener("resize", subsGridResizeListener);
    subsGridResizeListener = null;
    if (subsGridResizeTimer) {
      clearTimeout(subsGridResizeTimer);
      subsGridResizeTimer = 0;
    }
    document.documentElement.style.removeProperty("--cpa-sfx-subs-items-per-row");
  }

  function scheduleSubsGridScan() {
    if (!subsGridState) return;
    if (!subsGridState.observer) {
      subsGridState.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              subsGridState.observer.unobserve(entry.target);
              fetchAndInjectThumbnail(entry.target);
            }
          }
        },
        { rootMargin: "300px 0px" }
      );
    }
    document.querySelectorAll("ytd-channel-renderer").forEach((card) => {
      // YouTube ネイティブ CSS が `#main-link` 等に `!important` で
      // `display: flow-root` / `flex: 1 1 1e-09px` を当てており、外部 CSS では
      // specificity 同等で勝てない。inline style + setProperty('important') が
      // 最終的に勝つので、各カードに inline style で確実に上書きする。
      applyGridCardInlineStyle(card);
      if (card.hasAttribute(SUBS_CARD_MARKER_ATTR)) return;
      card.setAttribute(SUBS_CARD_MARKER_ATTR, "");
      subsGridState.observer.observe(card);
    });
  }

  /**
   * グリッドカード内部要素に inline style を当てて YouTube ネイティブ CSS の
   * `!important` を確実に上書きする。CSS でも同じ宣言を入れているが、specificity
   * 戦争を避けるため inline で最終決定する。
   *
   * カードレイアウト (feed 動画カード準拠 / 2026-05-07 ゆろさん要件):
   *   ┌──────────────────────────┐
   *   │  サムネ 16:9 (角丸 12px)  │  ← #avatar-section
   *   └──────────────────────────┘
   *   [●36px] チャンネル名 (2 行)    ← #info-section (2 列 grid)
   *           チャンネル登録者数
   *
   * 重要操作: `#avatar` 要素を `#info-section` の先頭に move する。CSS だけでは
   *   要素の親変更ができないため。OFF 切替時 (clearGridCardInlineStyle) で復元。
   */
  function applyGridCardInlineStyle(card) {
    // ===== データ更新フェーズ (毎スキャンで実行) =====
    // YouTube ネイティブ sort dropdown は `yt-reload-continuation-finish` で
    // サーバー再取得 → Polymer dom-repeat が **既存カード DOM を再利用** して
    // 新しいチャンネルデータを再 binding する (key 一致で instance 再使用)。
    // この際 `#main-link` の textContent / href は更新されるが、`data-cpa-subs-styled`
    // marker は残ったままで、もし下記の「構造スタイリング」ガード内で
    // `data-cpa-clean-name` を更新すると、再 bind 後も古い名前が ::before で表示され
    // 続けて「ソートしても見た目が変わらない」というバグになる。
    // よってデータ更新（clean-name + href 整合性チェック）は必ず毎回走らせる。
    const main = card.querySelector("#main-link");
    if (main) {
      const cleanName = extractCleanText(main);
      if (main.getAttribute("data-cpa-clean-name") !== cleanName) {
        main.setAttribute("data-cpa-clean-name", cleanName);
      }
    }
    // href 変化検知: チャンネルが切り替わった = サムネ画像も古いものなので剥がして
    //   IntersectionObserver に再 attach させて再取得する。
    const currentHref = (main?.getAttribute("href") || "").trim();
    const cachedHref = card.getAttribute("data-cpa-card-href") || "";
    if (currentHref && currentHref !== cachedHref) {
      card.setAttribute("data-cpa-card-href", currentHref);
      if (cachedHref) {
        // 初回登録 (cachedHref が空) は剥がし不要。再 bind 時のみクリーンアップ。
        const oldThumb = card.querySelector(`.${SUBS_THUMB_CLASS}`);
        if (oldThumb) oldThumb.remove();
        // SUBS_CARD_MARKER_ATTR を剥がして scheduleSubsGridScan で再 observe させる
        card.removeAttribute(SUBS_CARD_MARKER_ATTR);
      }
    }

    // ===== 構造スタイリングフェーズ (要素初回のみ実行 - idempotent) =====
    if (card.hasAttribute("data-cpa-subs-styled")) return;
    card.setAttribute("data-cpa-subs-styled", "");
    const setIm = (el, prop, val) => {
      if (el && el.style) el.style.setProperty(prop, val, "important");
    };
    // ⓪ カード全体クリックで #main-link に転送 (feed の動画カード準拠)。
    //   現状 `#avatar-section <a>` は height 0、`#info-section #main-link` は文字部分 320×19 のみクリック可能で、
    //   info-section の空白部分・サムネ枠・登録者数テキストは死領域だった。
    //   → カード自身に click を bind して、ターゲットがどの anchor 内でもなければ #main-link.click() で転送する。
    //   重複登録防止に data-cpa-card-click marker を使用。
    //   listener の冒頭で `subsGridState` を見て、機能 OFF 切替後は no-op に倒す（Codex P2 指摘）。
    //   listener 自体を removeEventListener で剥がす方針も検討したが、card 単位で handler 参照を
    //   保持する必要があるのとカード再生成で自然消滅するため、closure 越しの state gate を採用。
    if (!card.hasAttribute("data-cpa-card-click")) {
      card.setAttribute("data-cpa-card-click", "");
      card.addEventListener("click", (e) => {
        if (subsGridState === null) return; // 機能 OFF 時は stale listener として no-op
        if (e.target.closest("a")) return; // 元々の anchor クリックは尊重
        const ml = card.querySelector("#main-link");
        if (ml) ml.click();
      });
    }
    // ① #avatar を #info-section の先頭に move (feed カードの「サムネ下にアイコン左」配置)。
    //   元は #avatar-section の中にあるが、それだと 16:9 サムネ枠の中央にアバターが大きく
    //   描画されてしまう。info-section に移して 36px 円アイコンとして使う。
    const info = card.querySelector("#info-section");
    const avatar = card.querySelector("#avatar");
    if (info && avatar && avatar.parentElement !== info) {
      info.insertBefore(avatar, info.firstElementChild);
    }
    // ①-b #video-count (登録者数テキスト) は YouTube ネイティブ DOM では `#metadata` という
    //   別 wrapper の中にある。`#metadata` 自体が幅 0 / 高さ 0 で潰れているため CSS だけでは
    //   表示できない。`#info-section` に直接 move して、main-link の下に並ぶようにする。
    const vc = card.querySelector("#video-count");
    if (vc && info && vc.parentElement !== info) {
      info.appendChild(vc);
    }
    // ② #info-section を position 駆動レイアウトに強制（CSS でも宣言してるが inline で念押し）。
    //   過去に grid-row: span 99 で暗黙 grid 99 行を確保してカード高さが破綻する罠があったため、
    //   position: absolute で avatar を左に固定配置 + テキストを通常 flow で縦並びに変更。
    if (info) {
      setIm(info, "position", "relative");
      setIm(info, "display", "flex");
      setIm(info, "flex-direction", "column");
      setIm(info, "align-items", "stretch");
      setIm(info, "gap", "4px");
      setIm(info, "padding", "12px 0 4px 48px");
      setIm(info, "margin", "0");
    }
    // ③ チャンネル名: Polymer の二重テキスト対策で、元テキストを font-size:0 で隠して
    //   ::before で `data-cpa-clean-name` 属性の値（正規化済み 1 個分の名前）を表示する。
    if (main) {
      // 元のテキスト/子要素を完全に隠す
      setIm(main, "font-size", "0");
      setIm(main, "color", "transparent");
      setIm(main, "line-height", "0");
      setIm(main, "display", "block");
      setIm(main, "flex", "0 0 auto");
      setIm(main, "min-height", "auto");
      setIm(main, "max-height", "none");
      setIm(main, "width", "100%");
      setIm(main, "margin", "0");
      setIm(main, "padding", "0");
      setIm(main, "overflow", "visible");
    }
    // ④ ハンドル (#subscribers の中身は @xxx) は非表示。feed 動画カードは「タイトル + 再生数」
    //   の 2 行構造なので、こちらも「名前 + 登録者数」の 2 行に揃える。
    const subs = card.querySelector("#subscribers");
    if (subs) {
      setIm(subs, "display", "none");
    }
    // ⑤ 登録者数 (#video-count の中身は「チャンネル登録者数 N万人」) — feed カードの再生数相当。
    //   ①-b で既に取得 + #info-section に move 済み。ここでは inline style だけ追加。
    if (vc) {
      setIm(vc, "display", "block");
      setIm(vc, "font-size", "12px");
      setIm(vc, "line-height", "1.4");
      setIm(vc, "font-weight", "400");
      setIm(vc, "white-space", "nowrap");
      setIm(vc, "overflow", "hidden");
      setIm(vc, "text-overflow", "ellipsis");
      setIm(vc, "max-width", "100%");
      setIm(vc, "color", "var(--cpa-subs-fg-secondary)");
      setIm(vc, "font-feature-settings", '"tnum" 1');
      setIm(vc, "margin", "0");
      setIm(vc, "padding", "0");
      setIm(vc, "border", "0");
    }
    // ⑥ 説明文は表示しない
    const desc = card.querySelector("#description");
    if (desc) setIm(desc, "display", "none");

    // ⑦ メンバーシップ・通知・登録ボタン等の追加要素も非表示（カードを最小情報に絞る）
    const memBtn = card.querySelector("#channel-memberships-button");
    if (memBtn) setIm(memBtn, "display", "none");
    // 登録ボタン (#buttons) も feed カードに無いので非表示
    const buttons = card.querySelector("#info-section > #buttons");
    if (buttons) setIm(buttons, "display", "none");

    // ⑧ main-link 内の child element (yt-formatted-string / yt-icon 等) を全て非表示にして
    //   ::before で表示する正規化テキストだけがレンダリングされるようにする。
    //   (Polymer の hidden node が display:block でスペースを取り mainOffsetH=240 になっていた根因)
    if (main) {
      Array.from(main.children).forEach((c) => {
        if (c && c.style) c.style.setProperty("display", "none", "important");
      });
    }
  }

  /**
   * グリッド機能 OFF 時にカードへ当てた inline style と DOM 改変を撤去する。
   * `applyGridCardInlineStyle` で `#avatar` を `#info-section` に move したのと
   * `#main-link` に `data-cpa-clean-name` 属性を付けたのを元に戻す。
   */
  function clearGridCardInlineStyle(card) {
    card.removeAttribute("data-cpa-subs-styled");
    // applyGridCardInlineStyle が `!important` で setProperty した全 prop を網羅する。
    // `display: flex` が剥がれれば flex 系 prop は無効化されるが、`gap` は grid container でも
    // 有効で、`position: relative` も positioning context として残るため、徹底的に剥がす（Codex P2 指摘）。
    const props = [
      "display", "flex", "flex-direction", "gap", "position", "min-height", "max-height",
      "line-height", "font-size", "font-weight", "overflow", "white-space", "word-break",
      "width", "margin", "padding", "-webkit-line-clamp", "-webkit-box-orient", "text-overflow",
      "max-width", "color", "letter-spacing", "border", "padding-top", "border-top",
      "font-feature-settings", "grid-template-columns", "column-gap", "row-gap",
      "align-items", "grid-column", "grid-row",
    ];
    // applyGridCardInlineStyle で inline style を当てた要素はすべてここで剥がす。
    // `#info-section > #buttons` は登録/通知ボタンを feed カード見た目に合わせて display:none したもの。
    // ここに含め忘れると subsChannelsGrid を OFF にしてもボタンが消えたままになる（Codex P2 指摘で追加）。
    ["#info-section", "#info-section > #buttons", "#main-link", "#description",
     "#subscribers", "#video-count", "#channel-memberships-button"].forEach((sel) => {
      const el = card.querySelector(sel);
      if (el && el.style) {
        props.forEach((p) => el.style.removeProperty(p));
      }
    });
    // #avatar を元の #avatar-section に戻す（move の reverse）
    const avatar = card.querySelector("#avatar");
    const avatarSection = card.querySelector("#avatar-section");
    if (avatar && avatarSection && avatar.parentElement !== avatarSection) {
      avatarSection.appendChild(avatar);
    }
    // #video-count を元の #metadata wrapper に戻す（move の reverse）
    const vc = card.querySelector("#video-count");
    const metadata = card.querySelector("#metadata");
    if (vc && metadata && vc.parentElement !== metadata) {
      metadata.appendChild(vc);
    }
    // #main-link の data-cpa-clean-name 属性除去 + 子要素の display リセット
    const main = card.querySelector("#main-link");
    if (main) {
      main.removeAttribute("data-cpa-clean-name");
      Array.from(main.children).forEach((c) => {
        if (c && c.style) c.style.removeProperty("display");
      });
    }
    // fetchAndInjectThumbnail が #avatar-section 配下に追加した <img.__cpa-sfx-subs-thumb> を撤去。
    // __cpa-sfx-subs-grid クラスが剥がれると CSS の支配下から外れて、ネイティブ avatar 画像と
    // 重なった状態でカードに残ってしまうため明示削除が必要（Codex P2 指摘で追加）。
    card.querySelectorAll(`.${SUBS_THUMB_CLASS}`).forEach((img) => img.remove());
  }

  /**
   * カードがビューポートに入ったタイミングで、対応するチャンネルの最新動画サムネを取得。
   * 2 段階 fetch:
   *   Stage 1: `/{handle}` (チャンネルページ HTML) から externalId (UCxxx) を抽出
   *   Stage 2: `/feeds/videos.xml?channel_id={externalId}` (RSS feed) から
   *            最新動画の `<media:thumbnail url="...">` を抽出
   * og:image はチャンネルアバターでしかなく動画サムネにならないため、RSS feed が必須。
   * 失敗時は thumbUrl=null でも cache に保存して同じハンドルへの再 fetch を抑止。
   */
  async function fetchAndInjectThumbnail(card) {
    if (!f("subsChannelsGrid")) return;
    const mainLink = card.querySelector("#main-link");
    const handle = extractHandleFromHref(mainLink?.getAttribute("href") || "");
    if (!handle) return;
    const cached = readSubsThumbCache(handle);
    let thumbUrl, channelId;
    if (cached) {
      thumbUrl = cached.thumbUrl;
      channelId = cached.channelId;
    } else {
      try {
        // Stage 1 のみで完結: channel page HTML → externalId + 最新動画 videoId。
        // 旧 Stage 2 (`/feeds/videos.xml?channel_id=...`) は YouTube が 2026-05 までに 404 化したため撤去。
        // チャンネルページ HTML には ytInitialData が embed されており、最初に出る `"videoId":"..."`
        // は "Featured" / 「ホーム」タブで最上段に置かれる動画 (= ほぼ最新動画 or pinned)。完全な
        // "最新公開動画" を取りたければ `/channel/${cid}/videos` を別途 fetch すればよいが、
        // HTML 1.1MB を全カード分追加で取得するコストが高く、見た目用途には Featured で十分とした。
        const res = await fetch(`/${handle}`, { credentials: "same-origin" });
        if (!res.ok) return;
        const html = await res.text();
        const channelIdMatch = html.match(/"externalId":"(UC[\w-]{20,30})"/);
        channelId = channelIdMatch?.[1] || null;
        // 最初の videoId 出現 = ホームタブ Featured 動画。11 文字の YouTube videoId 形式に厳密マッチ。
        const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        const videoId = videoIdMatch?.[1] || null;
        // 解像度選択: maxresdefault.jpg は 1280x720 で **16:9 ネイティブ**。hqdefault.jpg は 480x360 で
        // **4:3** のため 16:9 の avatar-section 枠に object-fit:cover で入れると上下 cropping が発生し、
        // ホーム画面の動画カード (16:9 サムネ) と見た目が揃わない (実機検証で「左上に寄って見える」と確定)。
        // maxresdefault は HD upload された動画のみ存在し古い動画では 404 だが、img.onerror で
        // mqdefault.jpg (320x180, 16:9 で必ず存在) にフォールバックするので破綻はしない。
        thumbUrl = videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : null;
        writeSubsThumbCache(handle, { thumbUrl, channelId, ts: Date.now() });
      } catch {
        return;
      }
    }
    if (!thumbUrl) return;
    // post-await guard（Codex P2 指摘）: fetch を await している間に
    //   - ユーザーが subsChannelsGrid を OFF にした (`detachSubsChannelsGrid` で subsGridState=null)
    //   - /feed/channels から離脱して card が DOM から外れた (`card.isConnected` false)
    // が起きている可能性があるため、append 直前で再チェックする。
    if (subsGridState === null) return;
    if (!card.isConnected) return;
    if (card.querySelector(`.${SUBS_THUMB_CLASS}`)) return;
    const img = document.createElement("img");
    img.className = SUBS_THUMB_CLASS;
    img.src = normalizeAvatarUrl(thumbUrl);
    img.loading = "lazy";
    img.alt = "";
    // 404 fallback: maxresdefault.jpg は HD アップロード動画のみ存在し古い動画では 404 を返す。
    // 失敗時は mqdefault.jpg (320x180, 16:9 で全動画必須) に切り替える。低解像度になるが
    // object-fit:cover で 16:9 比率は維持されるので「左上寄り」レイアウト崩れは出ない。
    // onerror を null clear するのは fallback 自体が再度 404 になった場合の無限ループ回避。
    img.onerror = () => {
      img.onerror = null;
      const fallback = img.src.replace(/\/maxresdefault\.jpg([?#].*)?$/, "/mqdefault.jpg$1");
      if (fallback !== img.src) img.src = fallback;
    };
    // 挿入位置: #avatar-section の中（サムネ枠 16:9 全埋め用）。
    // feed カード準拠レイアウトではアバターは別途 #info-section の左に move 済みなので、
    // ここで #avatar 内に挿入すると 16:9 枠ではなくアバター 36px 円の上に乗ってしまう。
    // 必ず #avatar-section 直下に置くこと。
    const slot = card.querySelector("#avatar-section") || card;
    slot.appendChild(img);
  }

  function readSubsThumbCache(handle) {
    try {
      const raw = sessionStorage.getItem(SUBS_CACHE_THUMB_PREFIX + handle);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || Date.now() - (data.ts || 0) > SUBS_CACHE_TTL_MS) return null;
      return data;
    } catch {
      return null;
    }
  }

  function writeSubsThumbCache(handle, data) {
    try {
      sessionStorage.setItem(
        SUBS_CACHE_THUMB_PREFIX + handle,
        JSON.stringify(data)
      );
    } catch {
      // QuotaExceeded は無視（次回スクロール時に再 fetch される）
    }
  }

  function applySubsGridFilter() {
    if (!subsGridState) return;
    const q = (subsGridState.search?.value || "").trim().toLowerCase();
    // 過去の lastFilterQuery cache は撤去:
    //   - キャッシュは filter 文字列だけを見ていて「カード集合の変化」を見ていなかった
    //   - フィルタ active 中に sort/再 hydrate で新カードが入っても再評価されず、
    //     新カードが filter 条件を無視して表示される罠があった
    //   - 171 cards × textContent 取得は数 ms 程度の実コストで毎回回しても許容範囲
    //
    // hidden 属性の set/remove は **状態が変わるときのみ** 行う。no-op の setAttribute /
    // removeAttribute でも MutationRecord は積まれて Polymer の data-binding listener に
    // 通知が飛ぶため、初回 hydrate 中の race condition を悪化させる原因になる（ゆろさん実機の
    // 「初回 sort 切替失敗」バグ調査で追加したガード）。
    document.querySelectorAll("ytd-channel-renderer").forEach((card) => {
      const isHidden = card.hasAttribute("hidden");
      if (!q) {
        if (isHidden) card.removeAttribute("hidden");
        return;
      }
      const name = getSubsCardName(card).toLowerCase();
      const handleSlot = (card.querySelector("#subscribers")?.textContent || "").toLowerCase();
      const shouldShow = name.includes(q) || handleSlot.includes(q);
      if (shouldShow && isHidden) {
        card.removeAttribute("hidden");
      } else if (!shouldShow && !isHidden) {
        card.setAttribute("hidden", "");
      }
    });
    // 全カードが hidden な shelf も hidden にする（空 shelf の見出しが残る UX 問題を回避）。
    document.querySelectorAll("ytd-shelf-renderer").forEach((shelf) => {
      const cards = shelf.querySelectorAll("ytd-channel-renderer");
      if (cards.length === 0) return;
      const visible = Array.from(cards).some((c) => !c.hasAttribute("hidden"));
      const shelfHidden = shelf.hasAttribute("hidden");
      if (visible && shelfHidden) {
        shelf.removeAttribute("hidden");
        shelf.removeAttribute("data-cpa-shelf-empty");
      } else if (!visible && !shelfHidden) {
        shelf.setAttribute("hidden", "");
        shelf.setAttribute("data-cpa-shelf-empty", "");
      }
    });
  }

  /**
   * shelf 単位でソート。「すべて」「購入済み」など複数 shelf 間は分離したまま、
   * 各 shelf 内の ytd-channel-renderer に CSS `order` プロパティを設定して
   * 仮想並び替えする（DOM 改変なしで safe）。
   */
  function applySubsGridSort() {
    if (!subsGridState) return;
    const key = subsGridState.sort?.value || "order";
    const shelfContents = document.querySelectorAll(
      "ytd-expanded-shelf-contents-renderer"
    );
    if (shelfContents.length === 0) {
      // shelf がない場合は section-list 直下にカードがあるケース
      sortCardsWithin(document.querySelectorAll("ytd-channel-renderer"), key);
      return;
    }
    shelfContents.forEach((shelf) => {
      sortCardsWithin(shelf.querySelectorAll(":scope > ytd-channel-renderer"), key);
    });
  }

  function sortCardsWithin(cards, key) {
    const list = Array.from(cards);
    if (list.length === 0) return;
    if (key === "order") {
      list.forEach((c) => {
        c.style.order = "";
      });
      return;
    }
    const items = list.map((c) => ({
      el: c,
      name: getSubsCardName(c),
      subs: getSubsCardSubscribersCount(c),
    }));
    if (key === "name") {
      items.sort((a, b) => subsCollator.compare(a.name, b.name));
    } else if (key === "subs") {
      items.sort((a, b) => b.subs - a.subs);
    }
    items.forEach((item, i) => {
      item.el.style.order = String(i);
    });
  }
})();
