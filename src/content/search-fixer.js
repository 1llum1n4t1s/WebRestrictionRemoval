"use strict";

/**
 * YouTube 機能拡張 content script（独自実装）。
 *
 * YouTube の検索結果・動画ページ・ホームグリッドの冗長 UI を非表示にするための DOM 操作と
 * CSS 注入を行う。外部送信ゼロ。設定は `chrome.storage.local` の `searchFixerEnabled` (master) /
 * `searchFixerFeatures` (個別) / `searchFixerGridItems` (数値) の 3 キーで管理する。
 *
 * 役割:
 *   - 検索結果ページ（/results）で `MutationObserver` を起動し、ノイズ要素を `removeDistractions()` で除去
 *   - 動画ページ（/watch）でコメント欄・ライブチャット欄非表示クラスを切り替え
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
  /** @type {Array<{key: string, name: string}>} 検索結果から除外するチャンネル（channelBlocklist 機能）。
   *  popup → storage 直書きで管理されるため APPLY_SEARCH_FIXER_CS メッセージには乗らず、
   *  初期 storage.get + storage.onChanged の 2 経路のみで同期する。 */
  let blockedChannels = [];

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
  /** 指数バックオフのディレイ（ms）。close button hydration の典型タイミングをカバーする幅で設定。
   *  pre クラス (display:none + visibility:hidden 併用) で見た目は即時に隠れているため、初回試行は短く取って
   *  hydration 完了次第すぐ click → pre クラス剥がし → 公式 collapsed bar 表示、を最速化する。 */
  const LIVE_CHAT_COLLAPSE_RETRY_DELAYS = Object.freeze([50, 200, 800]);

  /** hideLiveChat の先制非表示クラス。`<html>` に付ける。
   *  - 付与: youtube-early.js (document_start) / onNavigationStart (SPA start) /
   *         syncLiveChatCollapse (SPA finish)
   *  - 削除: clearLiveChatPreHide() 経由で 3 か所 (click 成功 / retry 上限 / detach)
   *  CSS 側 (`html.__cpa-sfx-hide-live-chat-pre ytd-live-chat-frame { display: none; visibility: hidden }`)
   *  + youtube-early.js の MutationObserver による inline force-hide で frame を完全に
   *  見えなくして体感ラグを消す。 */
  const LIVE_CHAT_PRE_HIDE_CLASS = "__cpa-sfx-hide-live-chat-pre";
  /** youtube-early.js が frame に当てる inline `display:none !important` のマーカー属性。
   *  pre クラス削除時にこれが付いた frame の inline display も剥がす必要がある。 */
  const LIVE_CHAT_FORCE_HIDE_ATTR = "data-cpa-force-hide";

  /** hideLiveChat の先制非表示を全部剥がす共通 helper。
   *  - `<html>` から pre クラスを剥がす
   *  - youtube-early.js が frame に当てた inline `display:none !important` を剥がす
   *  - youtube-early.js の MutationObserver は **disconnect しない** (storage.onChanged
   *    や SPA 遷移で pre クラスが再付与されたとき、新 frame に再度 force-hide できるよう
   *    常時維持)。observer 側で pre クラス無し guard により実質 no-op になる。 */
  function clearLiveChatPreHide() {
    cancelPreHideRelease();
    document.documentElement.classList.remove(LIVE_CHAT_PRE_HIDE_CLASS);
    document
      .querySelectorAll(
        'ytd-live-chat-frame[' + LIVE_CHAT_FORCE_HIDE_ATTR + '="1"]'
      )
      .forEach((el) => {
        el.style.removeProperty("display");
        el.removeAttribute(LIVE_CHAT_FORCE_HIDE_ATTR);
      });
  }

  /** click 成功後に frame の collapsed 化を待つ rAF id (二重起動防止)。 */
  let preHideReleaseRaf = 0;
  /** click 成功後の collapsed 待ち最大フレーム数 (60fps なら ≈500ms)。 */
  const PRE_HIDE_RELEASE_MAX_FRAMES = 30;

  function cancelPreHideRelease() {
    if (preHideReleaseRaf !== 0) {
      cancelAnimationFrame(preHideReleaseRaf);
      preHideReleaseRaf = 0;
    }
  }

  /**
   * click 成功直後に pre クラスを即剥がすと、YouTube が frame の collapsed transition を
   * DOM 反映する前に display:none が解除されて frame default expand state が paint
   * されてしまう（Edge 動画キャプチャで約 270ms expand 表示が見える現象を確認）。
   *
   * このため click 成功後は **frame に `collapsed` 属性が付くまで rAF で polling**
   * して、確認できたら pre クラス + inline force-hide を剥がす。タイムアウト
   * (PRE_HIDE_RELEASE_MAX_FRAMES) で fallback 剥がし。
   */
  function schedulePreHideRelease() {
    cancelPreHideRelease();
    let attempts = 0;
    const tick = () => {
      preHideReleaseRaf = 0;
      // 機能 OFF / 別ページ遷移なら detach 経路で剥がされるためここでは何もしない
      if (!f("hideLiveChat") || !isWatchPage()) return;
      const frame = document.querySelector("ytd-live-chat-frame");
      if (!frame) {
        // frame が消えた → pre クラス意味なしなので剥がし
        clearLiveChatPreHide();
        return;
      }
      // YouTube が collapsed state に切り替えた indicator
      // (frame の `collapsed` 属性が立てば transition 完了。通常 click 後 1〜数フレーム)
      if (frame.hasAttribute("collapsed")) {
        clearLiveChatPreHide();
        return;
      }
      if (++attempts >= PRE_HIDE_RELEASE_MAX_FRAMES) {
        // タイムアウト fallback (collapsed attribute が出ない場合も諦めて剥がす)
        clearLiveChatPreHide();
        return;
      }
      preHideReleaseRaf = requestAnimationFrame(tick);
    };
    preHideReleaseRaf = requestAnimationFrame(tick);
  }

  // 注入する <style> 要素の id（CSS 文字列を更新するときの参照キー）
  const STYLE_ID_HOME_GRID = "__cpa-sfx-home-grid-style";
  const STYLE_ID_SEARCH_GRID = "__cpa-sfx-search-grid-style";
  const STYLE_ID_DEMOTE = "__cpa-sfx-demote-style";

  // demote マーキング用 CSS クラス（match 済みは class 付かず、未 match のみ付く）
  const CLASS_PROCESSED = "cpa-sfx-processed";
  const CLASS_DEMOTED = "cpa-sfx-demoted";

  // ---------- Helpers ----------
  const isResultsPage = () => location.pathname.startsWith("/results");
  // `/watch` に加え、`/@channel/live` や `/channel/ID/live` など `/live` で終わる
  // ライブ配信 URL もライブチャット欄非表示の対象にする。YouTube は `/live` URL の
  // pathname を `/watch` に書き換えないことがあり、旧実装（`/watch` のみ判定）では
  // `/live` から開いた配信で hideLiveChat の折りたたみ処理が丸ごとスキップされ、
  // frame が丸見えになっていた（実機 `/@ANNnewsCH/live` で確認）。
  const isWatchPage = () =>
    location.pathname.startsWith("/watch") ||
    location.pathname.endsWith("/live");
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
      StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS,
    ])
    .then((stored) => {
      active = stored[StorageKeys.SEARCH_FIXER_ENABLED] === true;
      features = SearchFixer.mergeFeatures(stored[StorageKeys.SEARCH_FIXER_FEATURES]);
      gridItems = SearchFixer.clampGridItems(stored[StorageKeys.SEARCH_FIXER_GRID_ITEMS]);
      blockedChannels = SearchFixer.normalizeBlockedChannels(stored[StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS]);
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
    if (StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS in changes) {
      blockedChannels = SearchFixer.normalizeBlockedChannels(
        changes[StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS].newValue
      );
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
    // SPA navigate (yt-navigate-start) の段階で hideLiveChat 用の pre クラスを先制付与する。
    // 理由: yt-navigate-finish 後の syncLiveChatCollapse まで待つと、その間に YouTube が
    //      新ページの ytd-live-chat-frame を expand 状態に戻す瞬間が paint されて
    //      「一瞬チャット枠が見える」現象が起きる (Edge の Performance Trace で確認)。
    //      YouTube は SPA で frame 要素を再利用するため、新ページ遷移時に DOM 追加ではなく
    //      既存 frame の display/state が即座に切り替わる。pre クラス (CSS で
    //      `display: none !important`) を付けておけば切替瞬間も含めて見えない。
    // 副作用: hideLiveChat OFF / watch 以外のページでも一瞬付くが、frame が無いページは
    //        CSS rule マッチせず副作用ゼロ。frame があり hideLiveChat OFF のページは
    //        yt-navigate-finish 後の syncLiveChatCollapse で OFF 判定で剥がされる。
    if (f("hideLiveChat")) {
      document.documentElement.classList.add(LIVE_CHAT_PRE_HIDE_CLASS);
    }
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
      removeAllBlockButtons();
      abortForeignCountryFetch(); // 海外チャンネル除外: 待ち行列と in-flight 取得を止める
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
      // 検索ページから離れた場合、過去に付与した装飾クラス / 注入ボタンを掃除
      clearThumbnailHighlight();
      removeAllBlockButtons();
      // 対象外ページへ遷移したら、そのページ由来の about 取得も止める（判定結果は cache に残る）
      abortForeignCountryFetch();
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
      // /rere B2-012: extension reload で orphan 化したら全 observer / timer を停止
      if (!chrome.runtime?.id) { cleanupAllSearchFixerStateForOrphan(); return; }
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
    // SPA 遷移経路でも先制非表示を即時 ON にする（初回直アクセスは youtube-early.js が
    // document_start で同クラスを付与済みなので idempotent）。click 成功時に剥がす。
    document.documentElement.classList.add(LIVE_CHAT_PRE_HIDE_CLASS);
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
    // /rere B2-012: extension reload で orphan 化したら全 observer / timer を停止
    if (!chrome.runtime?.id) { cleanupAllSearchFixerStateForOrphan(); return; }
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
    // hideLiveChat OFF / 別ページ遷移時は先制非表示クラスも inline force-hide も
    // 旧 force-hide クラスも剥がして元の表示状態に戻す。クラスを残したままだと、
    // 機能 OFF 後もライブチャット枠が表示されない / 先制非表示で見えないままになる。
    clearLiveChatPreHide();
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
    if (liveChatCollapseRetryAttempt >= LIVE_CHAT_COLLAPSE_RETRY_DELAYS.length) {
      // リトライ上限到達: close button が見つからない状態が続いている（live chat なし
      // 動画 / hydration 異常など）。pre クラスで frame を永久に隠したままにすると
      // ユーザーが「ライブチャット枠が完全に消えた」状態に陥るため、fail-safe で
      // pre クラス + inline force-hide 両方を剥がす。別契機（iframe load / observer）で
      // 再 trigger されたら syncLiveChatCollapse 経由で再度 pre クラスが立ち、
      // また 0 番からバックオフ再開する。
      clearLiveChatPreHide();
      return;
    }
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
      // load 直後は YouTube 側の hydration が走っている最中だが、pre クラス
      // (display:none + visibility:hidden 併用) で見た目はすでに隠れているため、待ち時間を最小に絞って
      // 早期 click → pre クラス剥がし → 公式 collapsed bar 表示、を最速化する。
      // close button が未 hydration なら scheduleLiveChatCollapseRetry が指数バックオフ
      // で吸収する（[50, 200, 800] ms）。
      // 新しいロード契機なのでリトライカウンタをリセットして 0 番からバックオフできるようにする。
      setTimeout(() => {
        if (f("hideLiveChat") && isWatchPage()) {
          cancelLiveChatCollapseRetry();
          collapseLiveChatIfNeeded();
        }
      }, 50);
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

    // click 成功 *直後* に pre クラスを剥がすと、YouTube が frame の collapsed
    // transition を DOM 反映する前に display:none が解除されて、frame default expand
    // state が paint されてしまう（Edge 動画キャプチャで約 270ms expand 表示を確認）。
    // 解決: frame に `collapsed` 属性が付くまで rAF polling、付いたら剥がす。
    // タイムアウト 30 フレーム (≈500ms) で fallback 剥がし。
    schedulePreHideRelease();

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
      // 検索グリッド: フルリロード直後は ytd-video-renderer がまだ DOM に無く、
      // onSettingsChanged 時点の applySearchGridStyle が空振りして #contents に
      // .yt-grid-active が付かない（SPA 遷移では yt-navigate-finish 後に renderer が
      // 揃ってから再実行されるので効くが、ハードリロードだと再実行経路が無く
      // OFF 時のデフォルト表示のままになる）。observer 経由の scan で renderer 出現後に
      // 再適用することでリロード初回でもグリッド化される。内部で f("searchGrid") &&
      // isResultsPage() ゲート済みなので空振りは無害。
      applySearchGridStyle();
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
    // YouTube は検索結果のプレイリスト/ミックスを複数バリアントでレンダする:
    //   - 横型:      yt-lockup-view-model--horizontal
    //   - 縦型ラッパ: yt-lockup-view-model.lockup.ytLockupViewModelWrapper（--horizontal を持たない）
    // 旧実装は `--horizontal` + 旧バッジクラス `.yt-badge-shape__text` + content-image link
    // 限定だったため、縦型ラッパ + 新バッジクラス `.ytBadgeShapeText`(host は `.ytBadgeShapeHost`)
    // + content-image link を持たないバリアントを全て取りこぼしていた（実機 ChromeMCP で確認:
    // 「N 本の動画」バッジ付き縦型プレイリストが消えない）。feed 側 purgeFeedDistractions と同じ
    // 「全 yt-lockup-view-model を走査し `.ytBadgeShapeHost` と href で判定」方式に統一する。
    // removeDistractions は冒頭 isResultsPage() ゲート済みなので document 全体走査でも検索結果限定。
    if (f("playlist") || f("mix")) {
      const checkPlaylist = f("playlist");
      const checkMix = f("mix");
      try {
        document.querySelectorAll("yt-lockup-view-model").forEach((item) => {
          if (!item.isConnected) return;
          let isPlaylist = false;
          let isMix = false;
          // 新旧両バッジクラスを併記（新: .ytBadgeShapeHost / 旧: .yt-badge-shape__text）。
          const badgeTexts = Array.from(
            item.querySelectorAll(".ytBadgeShapeHost, .yt-badge-shape__text")
          ).map((b) => (b.textContent ?? "").trim());
          if (badgeTexts.some((t) => FEED_MIX_BADGE_TEXTS.has(t))) {
            isMix = true;
          } else if (badgeTexts.some((t) => FEED_PLAYLIST_BADGE_RE.test(t))) {
            isPlaylist = true;
          } else {
            // href フォールバック: content-image link を持たないバリアントもあるので
            // list= を含む任意の a を見る。RD / start_radio はミックス、それ以外は playlist。
            const link = item.querySelector('a[href*="list="]');
            const href = link?.getAttribute("href") ?? "";
            if (href.includes("&list=RD") || href.includes("&start_radio=1")) {
              isMix = true;
            } else if (href.includes("/playlist?list=") || href.includes("&list=")) {
              isPlaylist = true;
            }
          }
          if (checkPlaylist && isPlaylist) item.remove();
          else if (checkMix && isMix) item.remove();
        });
      } catch {}
    }

    // ===== Pass 4: チャンネルブロックリスト（除去 + 登録ボタン注入） =====
    applyChannelBlocklist();

    // ===== Pass 5: 海外チャンネル除外 =====
    applyForeignChannelFilter();
  }

  // ---------- チャンネルブロックリスト ----------
  /**
   * YouTube ホームの公式「このチャンネルは表示しない」に相当する機能を検索結果に提供する。
   *
   *   1. 登録済みチャンネル（blockedChannels）の動画カード (ytd-video-renderer) /
   *      チャンネルカード (ytd-channel-renderer) を検索結果から除去
   *   2. 未登録チャンネルのカードには hover 表示の 🚫 登録ボタンを注入
   *      （クリックで storage に追記 → storage.onChanged → 本関数の再実行で即時除去）
   *
   * 照合キーは `SearchFixer.extractChannelKeyFromHref`（"@handle" 小文字 or "UC..."）。
   * removeDistractions から呼ばれるため isResultsPage() ゲート済み。機能 OFF 時は
   * 注入済みボタンを全撤去する（onSettingsChanged の master OFF / ページ離脱経路からも呼ばれる）。
   */
  const BLOCK_BTN_CLASS = "__cpa-sfx-block-btn";

  function removeAllBlockButtons() {
    document.querySelectorAll(`.${BLOCK_BTN_CLASS}`).forEach((el) => el.remove());
  }

  /**
   * ytd-video-renderer はレスポンシブ切替用に `ytd-channel-name` を複数 (非表示バリアント込み) 保持
   * している実機確認済みの罠がある。素朴な querySelector は文書順で先に現れる非表示側を掴んでしまい、
   * ensureBlockButton の挿入先がその非表示コンテナ内になってボタンが永久に見えなくなる。
   * `offsetParent !== null`（自身 or 祖先が display:none だと null になる）で実際に描画されている
   * 要素を選び、全滅時のみ先頭にフォールバックする。
   */
  function pickVisibleChannelName(renderer) {
    const candidates = renderer.querySelectorAll("ytd-channel-name");
    for (const el of candidates) {
      if (el.offsetParent !== null) return el;
    }
    return candidates[0] ?? null;
  }

  /** カード内のチャンネルリンク（`ytd-channel-name` 配下の a[href]）から key / name / 注入先を解決する。 */
  function resolveChannelInfo(renderer) {
    const channelName = pickVisibleChannelName(renderer);
    const link = channelName?.querySelector("a[href]") ?? renderer.querySelector("#main-link[href]");
    const href = link?.getAttribute("href") ?? "";
    const key = SearchFixer.extractChannelKeyFromHref(href);
    if (!key) return null;
    const name = (link?.textContent ?? "").trim() || renderer.querySelector("#text.ytd-channel-name")?.textContent?.trim() || key;
    // ytd-channel-name を持たないカード (ytd-channel-renderer の一部バリアント等) は
    // #main-link をボタン挿入のアンカーとして代用する (CodeRabbit 指摘: fallback が無いと
    // ensureBlockButton の host 解決で早期 return してボタンが注入されない)。
    return { key, name, channelName: channelName || link };
  }

  /** 登録ボタンをチャンネル名の隣に注入（既存があれば dataset のみ更新 — SPA の renderer 再利用対応）。 */
  function ensureBlockButton(renderer, info) {
    // orphan guard: 新規作成分岐の chrome.i18n.getMessage が context invalidation で throw すると
    // 呼び出し元 applyChannelBlocklist の forEach が途中停止するため、入口で安全にスキップする。
    if (!chrome.runtime?.id) return;
    // ボタンは <a> の外（ytd-channel-name の直後の sibling）に置く。<a> 内に置くと
    // クリックがナビゲーションと競合する（stopPropagation でも :visited 等の副作用が残る）。
    const host = info.channelName?.parentElement;
    if (!host) return;
    let btn = host.querySelector(`:scope > .${BLOCK_BTN_CLASS}`);
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = BLOCK_BTN_CLASS;
      btn.textContent = "🚫";
      btn.title = chrome.i18n.getMessage("sfBlockChannelBtnTitle") || "このチャンネルを検索結果に表示しない";
      btn.setAttribute("aria-label", btn.title);
      btn.addEventListener("click", onBlockButtonClick);
      info.channelName.insertAdjacentElement("afterend", btn);
    }
    btn.dataset.cpaChannelKey = info.key;
    btn.dataset.cpaChannelName = info.name;
  }

  /** 登録ボタン click: storage の現在値を再取得してから追記する（popup 側と同じ stale 化 race 防御）。 */
  async function onBlockButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!chrome.runtime?.id) return; // orphan 化後は何もしない
    const btn = e.currentTarget;
    const key = btn?.dataset?.cpaChannelKey;
    const name = btn?.dataset?.cpaChannelName || key;
    if (!key) return;
    try {
      const stored = await chrome.storage.local.get(StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS);
      const list = SearchFixer.normalizeBlockedChannels(stored[StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS]);
      if (list.some((c) => c.key === key)) return; // 既登録（別カードの同チャンネル等）
      if (list.length >= SearchFixer.BLOCKED_CHANNELS_MAX) return; // 上限到達時は静かに no-op
      list.push({ key, name });
      await chrome.storage.local.set({ [StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS]: list });
      // 除去自体は storage.onChanged → onSettingsChanged → 本 pass 再実行で行われる
    } catch (err) {
      // popup 側 (removeBlockedChannel の logStorageError) と同様、書き込み失敗の手がかりを console に残す
      console.warn("[WebViewingAssist] チャンネルブロックリストの保存に失敗:", err);
    }
  }

  function applyChannelBlocklist() {
    if (!f("channelBlocklist")) {
      removeAllBlockButtons();
      return;
    }
    const blockedSet = new Set(blockedChannels.map((c) => c.key));
    try {
      const renderers = document.querySelectorAll(
          "#primary ytd-item-section-renderer ytd-video-renderer, " +
          "#primary .ytd-two-column-search-results-renderer ytd-channel-renderer"
        );
      // Phase 1 (read): offsetParent を含む可視判定とチャンネル情報解決を全カード分先に完了する。
      // Phase 2 (write): remove / insert をまとめ、カード単位の layout read/write 交互実行を避ける。
      const decisions = [];
      for (const renderer of renderers) {
        if (!renderer.isConnected) continue;
        const info = resolveChannelInfo(renderer);
        if (info) decisions.push({ renderer, info, remove: blockedSet.has(info.key) });
      }
      for (const decision of decisions) {
        if (!decision.renderer.isConnected) continue;
        if (decision.remove) decision.renderer.remove();
        else ensureBlockButton(decision.renderer, decision.info);
      }
    } catch {}
  }

  // ---------- 海外チャンネル除外 (hideForeignChannels) ----------
  /**
   * 「自分の国以外のチャンネル」の動画を検索結果 / フィードから除去する。
   *
   * YouTube 標準の検索フィルタには国の条件が存在せず（「場所」は動画のジオタグ絞り込みで別物）、
   * ホーム等のフィードにはフィルタ UI 自体が無いため独自実装する。判定は 2 段ハイブリッド:
   *
   *   1. 言語ヒューリスティック `SearchFixer.detectTextOrigin`（fetch ゼロ・即時）
   *   2. 1 が unknown のカードだけ、チャンネルの `/@handle/about` を **同一オリジン** fetch して
   *      `"country"` を読む（外部送信ゼロを維持。結果はチャンネル単位で sessionStorage キャッシュ）
   *
   * fail-open 原則: 判定が付かない間 / 国非公開チャンネル / fetch 失敗はすべて「残す」。
   * 自国チャンネルを誤って消すほうが、海外チャンネルが残るより体験を壊すため。
   */
  /** @type {{region: string|null, lang: string, aliases: Set<string>, knownCountries: Set<string>}|null} 自国情報（初回利用時に解決） */
  let foreignHomeInfo = null;
  /**
   * 既知の国名集合を作るための候補コード（AA〜ZZ の 676 通り）。
   * `Intl` は region コードの列挙 API を持たないため総当たりで引き、`Intl.DisplayNames` が
   * 変換できたものだけを既知の国名として採用する（未割り当てコードは入力がそのまま返る）。
   * ハードコードした国コード表を持たずに済み、ICU の更新にも自動追従する。
   * 生成は getForeignHomeInfo の初回呼び出し 1 回だけ。
   */
  const FOREIGN_REGION_CODES = (() => {
    const out = [];
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) out.push(String.fromCharCode(a, b));
    }
    return out;
  })();
  /** @type {Map<string, "home"|"foreign"|"unknown">} チャンネルキー → 判定結果（メモリキャッシュ） */
  const foreignOriginCache = new Map();
  /** @type {Map<string, string>} 未取得チャンネルキー → about ページのパス（fetch 待ち行列） */
  const foreignFetchQueue = new Map();
  /** @type {Set<string>} fetch 実行中のチャンネルキー（重複発射防止） */
  const foreignFetchInFlight = new Set();
  /** @type {AbortController|null} 進行中の about 取得をまとめて中断するためのコントローラ */
  let foreignFetchAbort = null;
  /** このページセッションで消費した about 取得の本数（FOREIGN_FETCH_SESSION_MAX の予算管理） */
  let foreignFetchBudgetUsed = 0;
  /** 予算枯渇の警告を 1 回だけ出すためのフラグ（毎スキャンでログを埋めない） */
  let foreignBudgetExhaustedLogged = false;
  /** 適用パスの例外を 1 回だけ警告するためのフラグ（同上） */
  let foreignFilterErrorLogged = false;
  let foreignRescanScheduled = false;

  /**
   * 自国の国コードと、照合用の 2 つの集合を解決する。
   *
   *   - `aliases`: 自国を指す表記の集合（国コード + 各ロケールでの国名）
   *   - `knownCountries`: **各ロケールで表現しうる全 region 名**の集合
   *
   * `knownCountries` があることで「既知の国名だが自国ではない」= `foreign` と
   * 「そもそも国名として解決できない」= `unknown`（残す）を分離できる（/rere RC-H）。
   * about の国名は YouTube の UI 言語でローカライズされ、ブラウザの `navigator.languages` とは
   * 独立に決まるため、照合ロケールには **`document.documentElement.lang`（YouTube の UI 言語）**
   * も含める。旧実装は navigator 由来 2 ロケールのみで照合し、外れた場合に `foreign` へ倒して
   * 自国チャンネルを一括除去する破綻があった。
   */
  function getForeignHomeInfo() {
    if (foreignHomeInfo) return foreignHomeInfo;
    const languages = Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? Array.from(navigator.languages)
      : [navigator.language].filter(Boolean);
    const region = SearchFixer.resolveHomeRegion(languages);
    const lang = (languages[0] || "").toLowerCase().split("-")[0];
    const aliases = new Set();
    const knownCountries = new Set();
    if (region) {
      aliases.add(region.toLowerCase());
      // YouTube の UI 言語 → ブラウザの言語 → 英語 の順で照合ロケールを集める。
      const pageLang = document.documentElement.getAttribute("lang");
      const locales = [pageLang, ...languages, "en"].filter(Boolean);
      const seenLocale = new Set();
      for (const locale of locales) {
        if (seenLocale.has(locale)) continue;
        seenLocale.add(locale);
        try {
          const display = new Intl.DisplayNames([locale], { type: "region" });
          const homeName = display.of(region);
          if (homeName) aliases.add(String(homeName).trim().toLowerCase());
          for (const code of FOREIGN_REGION_CODES) {
            const name = display.of(code);
            // Intl.DisplayNames は未知コードで入力をそのまま返すため、変換できた分だけ採用する。
            if (name && name !== code) knownCountries.add(String(name).trim().toLowerCase());
          }
        } catch {
          // 該当ロケールを持たない環境では他のロケール分のエイリアスで照合する
        }
      }
    }
    foreignHomeInfo = { region, lang, aliases, knownCountries };
    return foreignHomeInfo;
  }

  function readForeignCache(key) {
    const mem = foreignOriginCache.get(key);
    if (mem) return mem;
    try {
      const raw = sessionStorage.getItem(SearchFixer.FOREIGN_CACHE_PREFIX + key);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || Date.now() - (data.ts || 0) > SearchFixer.FOREIGN_CACHE_TTL_MS) return null;
      if (data.origin !== "home" && data.origin !== "foreign" && data.origin !== "unknown") return null;
      foreignOriginCache.set(key, data.origin);
      return data.origin;
    } catch {
      return null;
    }
  }

  function writeForeignCache(key, origin) {
    foreignOriginCache.set(key, origin);
    try {
      sessionStorage.setItem(
        SearchFixer.FOREIGN_CACHE_PREFIX + key,
        JSON.stringify({ origin, ts: Date.now() })
      );
    } catch {
      // QuotaExceeded はメモリキャッシュだけで動作継続（次セッションで再取得）
    }
  }

  /**
   * カードの判定を返す。未確定のチャンネルは about fetch を予約して "unknown"（= 残す）を返す。
   *
   * @param {string|null} key チャンネルキー（"@handle" 小文字 or "UC..."）
   * @param {string} text タイトル + チャンネル名
   * @param {string|null} href チャンネルへのリンク href（about ページ URL の組み立てに使う）
   */
  function classifyCardOrigin(key, text, href) {
    const home = getForeignHomeInfo();
    if (!home.region) return "unknown"; // 自国が特定できない環境では機能を no-op にする
    const byText = SearchFixer.detectTextOrigin(text, home.lang);
    if (byText !== "unknown") return byText;
    if (!key) return "unknown";
    const cached = readForeignCache(key);
    if (cached) return cached;
    enqueueForeignCountryFetch(key, href);
    return "unknown";
  }

  /**
   * about ページ取得を待ち行列に積む（同一チャンネルは 1 回だけ）。
   * セッション内の総取得数は `FOREIGN_FETCH_SESSION_MAX` で打ち切る（/rere RC-I）。
   * 固有スクリプトを持たない言語圏（en / de / fr 等）では全カードが判定不能になり、
   * 1 件 1〜3 MB の about ページを無制限に取りにいく経路があったため上限を設ける。
   */
  function enqueueForeignCountryFetch(key, href) {
    if (foreignFetchInFlight.has(key) || foreignFetchQueue.has(key)) return;
    if (foreignFetchBudgetUsed >= SearchFixer.FOREIGN_FETCH_SESSION_MAX) {
      if (!foreignBudgetExhaustedLogged) {
        foreignBudgetExhaustedLogged = true;
        console.warn(
          `[WebViewingAssist] 海外チャンネル除外: about 取得の上限 ${SearchFixer.FOREIGN_FETCH_SESSION_MAX} 件に達したため、以降は判定を保留します（未判定のチャンネルは除外されません）`
        );
      }
      return;
    }
    // href から `/@handle` / `/channel/UC...` のパス部分だけを取り出す（クエリや動画パスを混ぜない）。
    const path = typeof href === "string" ? href.match(/^\/(?:@[^/?#]+|channel\/UC[\w-]+)/)?.[0] : null;
    if (!path) return;
    foreignFetchBudgetUsed++;
    foreignFetchQueue.set(key, path);
    pumpForeignCountryFetch();
  }

  /**
   * 待ち行列を同時実行数の上限まで消化する。
   * 機能 OFF / orphan 化のときは発射せずキューを捨てる（/rere RC-A: 旧実装は OFF 後も
   * キューが最後まで排水され、切ったはずの機能が MB 単位の取得を続けていた）。
   */
  function pumpForeignCountryFetch() {
    if (!chrome.runtime?.id || !active || !f("hideForeignChannels")) {
      abortForeignCountryFetch();
      return;
    }
    while (
      foreignFetchInFlight.size < SearchFixer.FOREIGN_FETCH_CONCURRENCY &&
      foreignFetchQueue.size > 0
    ) {
      const [key, path] = foreignFetchQueue.entries().next().value;
      foreignFetchQueue.delete(key);
      foreignFetchInFlight.add(key);
      void fetchChannelOrigin(key, path);
    }
  }

  /**
   * 待ち行列を破棄し、進行中の about 取得を中断する（chrome API 非依存なので orphan 後も安全）。
   * master OFF / サブ機能 OFF / ページ離脱 / orphan 化のすべてから呼ぶ。
   */
  function abortForeignCountryFetch() {
    // 未発射のキュー分は予算を消費していないので返却する。減算しないと master OFF や
    // フィード外への SPA 遷移で abort するたびに予約分がセッション上限を食い潰し、
    // 機能を再開しても about 取得が早期に打ち切られて判定が実質止まる
    // （fail-open なので誤除去にはならないが、機能が効かなくなる）。
    // in-flight 分は fetchChannelOrigin の finally が未確定として減算するので触らない。
    foreignFetchBudgetUsed = Math.max(0, foreignFetchBudgetUsed - foreignFetchQueue.size);
    foreignFetchQueue.clear();
    try { foreignFetchAbort?.abort(); } catch {}
    foreignFetchAbort = null;
  }

  /**
   * チャンネルの about ページを same-origin fetch して国を判定し、キャッシュに書いて再スキャンする。
   * search-fixer.js の `/feed/channels` 取得と同じ same-origin 認証 fetch パターン
   * （`credentials: "same-origin"` + `redirect: "manual"`）。外部 CDN 向けの 4 原則とは別物。
   *
   * 判定は 3 値で、**確定できたときだけキャッシュする**（/rere RC-B）。旧実装は fetch 失敗も
   * 「国非公開の確定 unknown」と同じ値で永続化し、一時的な通信断がそのチャンネルの再判定を
   * 恒久的に潰していた。
   */
  async function fetchChannelOrigin(key, path) {
    let origin = null;      // null = 未確定（キャッシュしない）
    try {
      if (!chrome.runtime?.id) return; // orphan 化後は静かに諦める
      // タイムアウト必須（/rere RC-C）: signal が無いと応答が返らない fetch が
      // FOREIGN_FETCH_CONCURRENCY のスロットを永久占有し、待ち行列全体が停止する。
      if (!foreignFetchAbort) foreignFetchAbort = new AbortController();
      const res = await fetch(`${path}/about`, {
        credentials: "same-origin",
        redirect: "manual",
        signal: AbortSignal.any([
          foreignFetchAbort.signal,
          AbortSignal.timeout(SearchFixer.FOREIGN_FETCH_TIMEOUT_MS),
        ]),
      });
      if (res.ok) {
        const country = SearchFixer.parseChannelCountry(await res.text());
        const home = getForeignHomeInfo();
        // country が null（国非公開）なら "unknown" を確定値としてキャッシュし、再取得を防ぐ。
        origin = country
          ? SearchFixer.classifyCountryName(country, home.aliases, home.knownCountries)
          : "unknown";
      }
    } catch {
      // ネットワークエラー / timeout / opaqueredirect は **未確定**のまま（次の機会に再取得）
    } finally {
      foreignFetchInFlight.delete(key);
      if (origin) writeForeignCache(key, origin);
      else foreignFetchBudgetUsed--; // 未確定は予算を消費しなかった扱いにして再挑戦を許す
      pumpForeignCountryFetch();
      // 判定が確定したカードを取り除くため、次フレームでまとめて再スキャンする
      if (origin === "foreign") scheduleForeignRescan();
    }
  }

  /** fetch 結果を反映する再スキャン。1 フレーム 1 回に coalesce する。 */
  function scheduleForeignRescan() {
    if (foreignRescanScheduled) return;
    foreignRescanScheduled = true;
    requestAnimationFrame(() => {
      foreignRescanScheduled = false;
      if (!chrome.runtime?.id || !active || !f("hideForeignChannels")) return;
      removeDistractions();
      purgeFeedDistractions();
    });
  }

  /** 検索結果ページ (ytd-video-renderer / ytd-channel-renderer) への適用。 */
  function applyForeignChannelFilter() {
    if (!f("hideForeignChannels")) return;
    try {
      const renderers = document.querySelectorAll(
        "#primary ytd-item-section-renderer ytd-video-renderer, " +
        "#primary .ytd-two-column-search-results-renderer ytd-channel-renderer"
      );
      for (const renderer of renderers) {
        if (!renderer.isConnected) continue;
        const link = renderer.querySelector('a[href^="/@"], a[href^="/channel/"]');
        const href = link?.getAttribute("href") ?? null;
        const key = SearchFixer.extractChannelKeyFromHref(href);
        const title = renderer.querySelector("#video-title")?.textContent ?? "";
        const channelName = link?.textContent ?? "";
        if (classifyCardOrigin(key, `${title} ${channelName}`, href) === "foreign") {
          renderer.remove();
        }
      }
    } catch (err) {
      // 破壊的操作（カード除去）を含むパスなので、握り潰すと「効かない」と fail-open が
      // 区別できなくなる（/rere RC-J）。DOM 変更で壊れた場合の手掛かりを 1 回だけ残す。
      if (!foreignFilterErrorLogged) {
        foreignFilterErrorLogged = true;
        console.warn("[WebViewingAssist] 海外チャンネル除外の適用に失敗:", err);
      }
    }
  }

  /** フィードの yt-lockup-view-model 1 件分の判定（purgeFeedDistractions のループから呼ぶ）。 */
  function isForeignLockup(lockup) {
    const link = lockup.querySelector(
      '.ytLockupMetadataViewModelMetadata a.ytAttributedStringLink[href^="/channel/"], ' +
      '.ytLockupMetadataViewModelMetadata a.ytAttributedStringLink[href^="/@"]'
    );
    const href = link?.getAttribute("href") ?? null;
    const key = SearchFixer.extractChannelKeyFromHref(href);
    // タイトルは title 属性 → h3 の順で解決する（カード全体の textContent は使わない。
    // 「8 か月前」等の相対日付に仮名が混ざり、全カードが自国判定になってしまう罠がある）。
    const titleEl = lockup.querySelector('a[href*="/watch"][title]');
    const title = titleEl?.getAttribute("title") ?? lockup.querySelector("h3")?.textContent ?? "";
    const channelName = link?.textContent ?? "";
    return classifyCardOrigin(key, `${title} ${channelName}`, href) === "foreign";
  }

  // ---------- フィードページ（ホーム / 登録 / 急上昇）の動画フィルタ ----------
  /**
   * フィードページで yt-lockup-view-model 配下の動画フィルタを実行する。
   *
   * 判定対象は ChromeMCP 実機検証済みの 5 機能 + チャンネルブロックリスト:
   *   - shortsBtn: a[href*="/shorts/"] を含むカード
   *   - playlist:  playlist?list= リンク or "N 本の動画" / "N videos" バッジ
   *   - mix:       &list=RD リンク or "ミックスリスト" バッジ
   *   - watched:   .ytThumbnailOverlayProgressBarHostWatchedProgressBar overlay
   *   - live:      バッジテキストが "LIVE" / "PREMIERE" / "ライブ配信中" / "プレミア公開"
   *   - channelBlocklist: メタデータ内のチャンネル名リンク (`resolveLockupChannelKey`) が
   *     登録済みチャンネルキーと一致するカード（2026-07-14 追加、検索結果限定から拡張）
   *   - hideForeignChannels: 自国以外のチャンネルのカード（`isForeignLockup`。文字種で即決できない
   *     ものは about ページ取得の完了後に `scheduleForeignRescan` 経由で後追い除去される）
   *
   * verified / artist は yt-lockup-view-model 配下のセレクタ未確定で次版持ち越し。
   * shelf / cardList / course / channel / secondary / chapter / reel は検索ページ固有 DOM の
   * ため対応 DOM がフィードに存在せず実装不要（既存 removeDistractions のみで完結）。
   *
   * 削除対象は親 `ytd-rich-item-renderer` ごと（リッチグリッド構造の整合性維持）。
   * 親が無い場合は lockup 自身を remove。
   */
  const FEED_PLAYLIST_BADGE_RE = /^\d+\s*本の動画$|^\d+\s*videos?$/i;
  // ミックスバッジは日本語環境では「ミックスリスト」、英語環境では「Mix」(YouTube 公式表記)。
  // ロケール切替ではなく両表記を同じ Set に入れて判定するハイブリッド方式（cf. FEED_LIVE_BADGE_TEXTS）。
  const FEED_MIX_BADGE_TEXTS = new Set([
    "ミックスリスト",
    "Mix",
  ]);
  // YouTube は時期によりバッジ表記を短縮する（例: "ライブ配信中" → "ライブ" / "プレミア公開" → "プレミア"）。
  // 現行 (2026-05) は短縮表記。legacy 表記も残しておけば古い動画 retain 表示にも対応できる。
  // "ステーション" / "STATION" = YouTube が機械生成する BGM 無限放送（ジャンル別ライブ風コンテンツ）。
  // DOM 上も `ytBadgeShapeThumbnailLive` クラスが付くので Live バッジの variant 扱い。
  const FEED_LIVE_BADGE_TEXTS = new Set([
    "LIVE", "PREMIERE",
    "ライブ", "ライブ配信中",
    "プレミア", "プレミア公開",
    "ステーション", "STATION",
  ]);
  // メンバーシップ限定動画のサムネバッジ。日英ロケール両対応。
  // 推測実装: 動かなかったら DOM ログから実表記に追従する。
  const FEED_MEMBERS_ONLY_BADGE_TEXTS = new Set([
    "メンバー限定",
    "Members only",
  ]);

  /**
   * yt-lockup-view-model 内のチャンネル名リンクからブロックリスト照合用キーを取り出す（実機確認済み）。
   * ホーム / フィード系の縦型カードはチャンネル名がメタデータ内で
   * `a.ytAttributedStringLink[href="/channel/UC..."|"/@handle"]` としてリンク化されているが、
   * 視聴ページの関連動画欄（コンパクトカード variant）ではプレーンテキストでリンクが無く
   * 取得不能（null を返し、呼び出し側で安全に skip される）。
   */
  function resolveLockupChannelKey(lockup) {
    const link = lockup.querySelector(
      '.ytLockupMetadataViewModelMetadata a.ytAttributedStringLink[href^="/channel/"], ' +
      '.ytLockupMetadataViewModelMetadata a.ytAttributedStringLink[href^="/@"]'
    );
    return SearchFixer.extractChannelKeyFromHref(link?.getAttribute("href"));
  }

  function purgeFeedDistractions() {
    if (!isFeedPage()) return;

    // ホームのおすすめセクション群（「その他のトピック」「ニュース速報」「ゲームルーム」）は
    // 独立した DOM (ytd-rich-section-renderer) で yt-lockup-view-model 配下の判定とは
    // 別ロジック。先に処理しておく。旧 removeTopicsSection / removeBreakingNewsSection を
    // 統合した単一トグル removeFeedSections で一括制御する。
    if (f("removeFeedSections")) {
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

      // 「ニュース速報」「ゲームルーム」セクションも独立 DOM (ytd-rich-section-renderer)。
      // 内側 renderer 種別はトピックスとは異なる可能性があるため has() で限定せず、
      // section title に出現する固有文字列のみで識別する（英語の "Game Room" は推定表記、
      // 動かなかったら実 DOM の表記に追従する）。
      const sections = document.querySelectorAll("ytd-rich-section-renderer");
      for (const section of sections) {
        if (!section.isConnected) continue;
        // 旧実装は section.textContent (サブツリー全体の連結文字列、数百〜数千文字) を毎回計算して
        // includes 検索していたが、見出し要素 (`#title` / `yt-formatted-string`) の限定走査で
        // 十分かつ大幅に軽量 (/rere レビュー C-#13)。YouTube の rich section の見出しは
        // `#title` (id 属性) または `yt-formatted-string` 要素に入る。
        const title = section.querySelector(
          "#title, yt-formatted-string"
        );
        const titleText = title?.textContent ?? "";
        if (
          titleText.includes("ニュース速報") || titleText.includes("Breaking news") ||
          titleText.includes("ゲームルーム") || titleText.includes("Game Room")
        ) {
          section.remove();
        }
      }
    }

    const checkShortsBtn = f("shortsBtn");
    const checkLive = f("live");
    const checkPlaylist = f("playlist");
    const checkMix = f("mix");
    const checkWatched = f("watched");
    const checkMembersOnly = f("membersOnly");
    // ブロックリストが空なら Set 構築 / per-lockup 照合を丸ごとスキップ（機能 ON 直後・未登録時の無駄走査防止）。
    const checkChannelBlocklist = f("channelBlocklist") && blockedChannels.length > 0;
    const checkForeign = f("hideForeignChannels");
    if (
      !(checkShortsBtn || checkLive || checkPlaylist || checkMix || checkWatched ||
        checkMembersOnly || checkChannelBlocklist || checkForeign)
    ) return;
    const blockedSet = checkChannelBlocklist ? new Set(blockedChannels.map((c) => c.key)) : null;

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
      // 3. チャンネルブロックリスト（Set 照合は軽量なのでバッジテキスト解析より先に判定）
      else if (checkChannelBlocklist && blockedSet.has(resolveLockupChannelKey(lockup))) {
        shouldRemove = true;
      }
      // 4. 海外チャンネル除外（テキスト判定は軽量、about fetch が要る分は非同期で後追い除去）
      else if (checkForeign && isForeignLockup(lockup)) {
        shouldRemove = true;
      }
      // 5. バッジテキスト系（ミックス → プレイリスト → ライブ → メンバー限定の順で判定）
      else if (checkMix || checkPlaylist || checkLive || checkMembersOnly) {
        const badges = Array.from(lockup.querySelectorAll(".ytBadgeShapeHost"));
        const badgeTexts = badges.map((b) => (b.textContent ?? "").trim());
        // ミックス判定（特異性が最も高いので最優先）
        if (
          checkMix &&
          (badgeTexts.some((t) => FEED_MIX_BADGE_TEXTS.has(t)) ||
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
        // サムネ右下バッジが "ライブ" / "ステーション" 等にマッチ → 動画自体がライブ配信
        // (`.ytSpecAvatarShapeLiveBadge` のチャンネルアバター赤枠は判定しない。
        //  チャンネル状態とは無関係に「動画自体がライブかどうか」だけで判定する方針)
        else if (checkLive && badgeTexts.some((t) => FEED_LIVE_BADGE_TEXTS.has(t))) {
          shouldRemove = true;
        }
        // メンバー限定判定: チャンネルメンバーシップ加入者のみ視聴可能な動画
        else if (checkMembersOnly && badgeTexts.some((t) => FEED_MEMBERS_ONLY_BADGE_TEXTS.has(t))) {
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
    // /opop PF-2: OFF かつ未装飾なら querySelectorAll を走らせず即 return。
    // highlightThumb はデフォルト OFF なので、99% のユーザーで毎 scan 空走査になる経路を回避。
    const root = document.documentElement;
    if (!enabled && !root.classList.contains("__cpa-sfx-thumb-applied")) return;
    const isDark = root.hasAttribute("dark");
    const items = document.querySelectorAll(
      "ytd-video-renderer.style-scope.ytd-item-section-renderer"
    );
    items.forEach((el) => {
      el.classList.remove("__cpa-sfx-thumb-dark", "__cpa-sfx-thumb-light");
      if (enabled) {
        el.classList.add(isDark ? "__cpa-sfx-thumb-dark" : "__cpa-sfx-thumb-light");
      }
    });
    // 装飾済みマーカー: SPA で検索結果ページから離れた後の clearThumbnailHighlight が
    // querySelectorAll を走らせるかどうかをこのフラグで判定 (空走査回避)
    if (enabled && items.length > 0) {
      root.classList.add("__cpa-sfx-thumb-applied");
    } else {
      root.classList.remove("__cpa-sfx-thumb-applied");
    }
  }

  function clearThumbnailHighlight() {
    // 装飾済みマーカーが無いなら querySelectorAll は不要 (subs/channels 等の非結果ページで空走査になるのを回避)。
    // /rere v1.0.30+ 計測で SIGNIF シナリオの hot path に出てきたので追加 (cxcx Self 0ms / Total 1.1ms の元凶)。
    if (!document.documentElement.classList.contains("__cpa-sfx-thumb-applied")) return;
    document.documentElement.classList.remove("__cpa-sfx-thumb-applied");
    document
      .querySelectorAll(".__cpa-sfx-thumb-dark, .__cpa-sfx-thumb-light")
      .forEach((el) => el.classList.remove("__cpa-sfx-thumb-dark", "__cpa-sfx-thumb-light"));
  }

  // ---------- キーワード非マッチ動画のグレー化 ----------
  function applyDemoteStyleInjection() {
    const enabled = f("demoteUnmatched");
    const existing = document.getElementById(STYLE_ID_DEMOTE);
    if (!enabled) {
      // 機能 OFF 経路: existing が無い = 過去に style を一度も注入してない = 装飾要素も無い (前提条件)。
      // この場合 querySelectorAll(.demoted) は確実に 0 件なので走査を skip する (cxcx 計測で空走査が SIGNIF 経路に出た)。
      if (!existing) return;
      existing.remove();
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

  // ストップワードは英語の汎用語のみ。日本語の助詞は分かち書きされていないため除外不可（実害最小）。
  // /opop PF-3: rAF ごとの Set 再生成を避けて module-scope に移動 (GC プレッシャ削減)。
  const STOP_WORDS = new Set([
    "a", "an", "the", "is", "are", "of", "in", "on", "at", "for", "with", "by", "and", "or",
  ]);

  function highlightMismatchedVideos() {
    if (!isResultsPage()) return;
    if (!f("demoteUnmatched")) return;

    const params = new URLSearchParams(location.search);
    const query = (params.get("search_query") ?? "").trim();
    if (!query) return;

    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
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

  // ---------- 動画ページ（コメント欄・ライブチャット欄非表示） ----------
  function applyWatchPageClasses() {
    // コメント欄は遅延レンダリング（スクロールで初めて DOM 出現）するため、個別要素 toggle だと
    // 初期ロード時に空振りする。`<html>` クラスで CSS 駆動にすれば後から DOM が現れても即時適用される。
    document.documentElement.classList.toggle("__cpa-sfx-hide-comments", f("hideComments"));
    // ライブチャットは JS 側で公式トグルを押し、CSS は collapsed 状態の高さ補助だけを担う。
    document.documentElement.classList.toggle("__cpa-sfx-hide-live-chat", f("hideLiveChat"));
  }

  // ---------- ホームのリッチグリッド列数 ----------
  function applyHomeGridStyle() {
    const existing = document.getElementById(STYLE_ID_HOME_GRID);
    // 列数を 4/5/6 に明示指定したときは従来どおりグリッド化（非破壊）。さらに `homeGrid` トグル
    // ON のときは列数『自動』(gridItems=0) でもグリッド化する（列数は YouTube 標準列数 = var）。
    const fixedCols = gridItems === 4 || gridItems === 5 || gridItems === 6;
    // ページゲート (isFeedPage): この機能は「ホーム/フィードのグリッド整列」が目的なので
    // ホーム (`/`) + `/feed/*` に限定する。ゲート無しだと注入 <style> が全ページに残り、
    // チャンネルページ (`/@handle` 等) の「動画」タブの `ytd-rich-grid-renderer` にも当たる。
    // すると初回ロード中にグリッド強制でレイアウト高さが変化 → YouTube のスクロール連動バナー
    // ヘッダー (tp-yt-app-header) が collapse/expand を一度誤判定 →「チャンネルバナーが点滅」する
    // 不具合が出ていた (実機確認・ゆろさん報告)。隣の applySearchGridStyle() が isResultsPage() で
    // ゲートしているのと同じ流儀に揃える。/feed/channels は isFeedPath 対象外 (subsChannelsGrid が
    // 別途担当) なので、ここで grid CSS が二重適用されることもない。
    const valid = active && isFeedPage() && (fixedCols || f("homeGrid"));
    if (!valid) {
      if (existing) existing.remove();
      return;
    }
    // 列数: 4/5/6 はその固定値、それ以外（自動 + homeGrid ON）は YouTube 標準列数を保持する
    // CSS 変数 `--ytd-rich-grid-items-per-row`（メディアクエリ追従、未定義時 3 フォールバック）。
    const columnsDecl = fixedCols
      ? `repeat(${gridItems}, minmax(0, 1fr))`
      : "repeat(var(--ytd-rich-grid-items-per-row, 3), minmax(0, 1fr))";
    // ホームのリッチグリッドは `ytd-rich-grid-renderer > #contents` が
    // `display:flex; flex-wrap:wrap` で、`ytd-rich-item-renderer` と全幅の
    // `ytd-rich-section-renderer`(Shorts 等の棚) がフラットに並ぶ。旧実装はアイテム幅だけを
    // 上書きしていたが、全幅の棚が flex-wrap 中に挟まると手前の行が埋まりきらず棚が次行に回り、
    // 「追加読み込みで N 件目以降が空きセルを飛ばして左端から並ぶ」隙間が出る（実機確認済み）。
    // → コンテナ自体を CSS Grid 化し、`grid-auto-flow: row dense` で棚の手前の空きセルを
    //    後続アイテムで埋めて連続配置する。棚 / continuation は 1 行全幅 span。
    const cssRule = `
      ytd-rich-grid-renderer > #contents {
        display: grid !important;
        grid-template-columns: ${columnsDecl} !important;
        grid-auto-flow: row dense !important;
        column-gap: 16px !important;
        row-gap: 24px !important;
        align-items: start !important;
      }
      ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer {
        width: auto !important;
        max-width: none !important;
        min-width: 0 !important;
        margin: 0 !important;
      }
      /* 全幅の棚 (Shorts 等) と infinite scroll トリガ (continuation) は 1 行全幅。
       * continuation は display:none にすると IntersectionObserver が発火せず追加読み込みが
       * 止まるため、隠さず grid-column span のみでレイアウト維持する。 */
      ytd-rich-grid-renderer > #contents > ytd-rich-section-renderer,
      ytd-rich-grid-renderer > #contents > ytd-continuation-item-renderer {
        grid-column: 1 / -1 !important;
      }
    `;
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
    // grid クラスは「全 section を束ねる外側コンテナ」(ytd-section-list-renderer > #contents)
    // に付ける。検索は追加読み込みごとに別の ytd-item-section-renderer (= 別の内側 #contents)
    // を作るため、内側 #contents ごとに grid 化すると各 section が左端から再配置されて境界に
    // 隙間ができる (5 列で 7 件 → 8 件目が次行左端から、の現象)。外側に grid を当て、内側の
    // section / #contents を CSS で display:contents に畳むことで、全 ytd-video-renderer を
    // section をまたいだ単一グリッドに連続配置する (buildSearchGridCss 側で実装)。
    // 外側コンテナは continuation でも安定して存在し続けるので、scheduleScan 経由の再適用でも
    // 同じ要素にクラスが付くだけ (冪等)。
    document
      .querySelectorAll("ytd-search ytd-section-list-renderer > #contents")
      .forEach((c) => c.classList.add("yt-grid-active"));

    const cssRule = buildSearchGridCss(gridItems);
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
    // columns: 4/5/6 = ユーザー指定の固定列、それ以外 (0 = 自動) = ホームのリッチグリッドと
    // 同じ列数に揃える。
    //
    // 自動時に YouTube が `<html>` に設定する CSS 変数 `--ytd-rich-grid-items-per-row`
    // （ホームの動画グリッドの現在の列数 = メディアクエリ追従）をそのまま使うことで、
    // 「ホームは 4 列なのに検索は 2 列」のような列数不一致を防ぐ。検索ページには
    // `ytd-rich-grid-renderer` 自体は無いが、この変数は html から継承されるので参照可能
    // （subsChannelsGrid も同じ変数活用の発想）。未定義時は 3 をフォールバック。
    //
    // 重要: トラックは必ず `minmax(0, 1fr)` を使う。`1fr` (= `minmax(auto, 1fr)`) だと
    // 検索結果カード内のサムネ / タイトルの min-content がトラックを押し広げて列幅が
    // バラバラになり「490px 689px 490px」のような破綻を起こす（subsChannelsGrid も
    // 同じ理由で `minmax(0, 1fr)` を採用済み）。
    const columnsDecl =
      columns >= 4
        ? `repeat(${columns}, minmax(0, 1fr))`
        : "repeat(var(--ytd-rich-grid-items-per-row, 3), minmax(0, 1fr))";
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
      /* grid クラスは全 section を束ねる外側コンテナ
       * (ytd-section-list-renderer > #contents) に付く。これを単一グリッドにする。 */
      ytd-search #contents.yt-grid-active {
        display: grid !important;
        grid-template-columns: ${columnsDecl} !important;
        /* align-items:start + grid-auto-rows:max-content でカードが行内の最長カードに
         * 引き伸ばされず、各カードが自身のコンテンツ高さに収まる（subsChannelsGrid と同様）。 */
        align-items: start !important;
        grid-auto-rows: max-content !important;
        column-gap: 16px !important;
        row-gap: 28px !important;
        margin-top: 24px !important;
      }
      /* 中間ラッパ (各 section と内側 #contents) を display:contents で畳み、全 section の
       * ytd-video-renderer を外側グリッドの直接アイテムとして連続配置する。これをやらないと
       * section ごとに独立グリッドになり、追加読み込みの新 section が左端から再配置されて
       * 境界に隙間ができる。 */
      ytd-search #contents.yt-grid-active > ytd-item-section-renderer,
      ytd-search #contents.yt-grid-active ytd-item-section-renderer > #contents {
        display: contents !important;
      }
      /* 空の構造ラッパは hide（mid-stream で 1 セル占有して隙間を作るのを防ぐ）。
       * section 内の #continuations は旧トリガで通常空。広告も消す。 */
      ytd-search #contents.yt-grid-active ytd-item-section-renderer > #header,
      ytd-search #contents.yt-grid-active ytd-item-section-renderer > #spinner-container,
      ytd-search #contents.yt-grid-active ytd-item-section-renderer > #continuations,
      ytd-search #contents.yt-grid-active ytd-search-pyv-renderer,
      ytd-search #contents.yt-grid-active ytd-ad-slot-renderer {
        display: none !important;
      }
      /* infinite scroll の本体トリガ (外側 ytd-continuation-item-renderer) は display:none に
       * すると IntersectionObserver が発火せず追加読み込みが止まるため、隠さず全幅 span で
       * レイアウト維持する（末尾に来るので隙間は最下部のみで実害なし）。 */
      ytd-search #contents.yt-grid-active > ytd-continuation-item-renderer {
        grid-column: 1 / -1 !important;
      }
      /* 動画以外の横長要素（棚 / チャンネル / 横スクロールリスト / プレイリスト lockup 等）は
       * display:contents で外側グリッドのアイテムに昇格するので 1 行全幅にする。
       * （shelf/channel/reel 等は対応機能 ON 時は removeDistractions が DOM 削除する。） */
      ytd-search #contents.yt-grid-active ytd-shelf-renderer,
      ytd-search #contents.yt-grid-active ytd-reel-shelf-renderer,
      ytd-search #contents.yt-grid-active grid-shelf-view-model,
      ytd-search #contents.yt-grid-active ytd-channel-renderer,
      ytd-search #contents.yt-grid-active ytd-horizontal-card-list-renderer,
      ytd-search #contents.yt-grid-active yt-lockup-view-model {
        grid-column: 1 / -1 !important;
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
      /* 検索結果の text-wrapper は本来サムネ右の flex カラム（高さ 0 で overflow 前提）。
       * grid カードでは縦積みにするため display:block にして自然な高さを持たせる。
       * これをやらないと中の title / channel が height:0 の親に切られて見えなくなる。 */
      ytd-search #contents.yt-grid-active ytd-video-renderer .text-wrapper {
        display: block !important;
        width: 100% !important;
        padding-top: 4px !important;
      }
      /* ホームフィードのグリッドカードに見た目を揃えるため、検索固有のはみ出しノイズを除去。
       * metadata-snippet-container は通常版と -one-line 版の 2 バリアントあるので部分一致で両対応。 */
      ytd-search #contents.yt-grid-active ytd-video-renderer #description-text,
      ytd-search #contents.yt-grid-active ytd-video-renderer [class*="metadata-snippet-container"],
      ytd-search #contents.yt-grid-active ytd-video-renderer #buttons,
      ytd-search #contents.yt-grid-active ytd-video-renderer #expandable-metadata,
      ytd-search #contents.yt-grid-active ytd-video-renderer ytd-badge-supported-renderer {
        display: none !important;
      }
      ytd-search #contents.yt-grid-active ytd-video-renderer #channel-info {
        padding: 0 !important;
        margin-top: 6px !important;
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
  // v6 (2026-05-13): HTML 内の最初の `"videoId":"..."` を採用する旧ロジックは「削除済み / 非公開動画」
  // を引いて灰色 + 三点リーダーのプレースホルダーが表示される問題があった。v6 では複数 videoId 候補を
  // 並列 HEAD で篩い分け、`maxresdefault.jpg` が **200** を返すものだけ採用する。全部 404 なら null
  // を cache 保存（プレースホルダー画像は表示しない）。旧 v5 cache は強制 invalidate。
  const SUBS_CACHE_THUMB_PREFIX = "__cpa_subs_thumb_v6::";
  const SUBS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  /** @type {Promise<Array<{handle:string,name:string,href:string,avatarUrl:string}>>|null} */
  let subsListFetchInFlight = null;
  let subsListFetchAbort = null;
  /** sort-wipe 経路でカードの SUBS_CARD_MARKER_ATTR を一括 clear して再 observe するときに、
   * 直前の fetch がまだ in-flight なハンドルが再 trigger されて重複 fetch + 重複 cache write
   * を起こすバグを防ぐ。fetch 開始時に add、finally で delete。*/
  const subsThumbFetchingHandles = new Set();
  const subsThumbFetchQueue = [];
  let subsThumbFetchActive = 0;
  let subsThumbFetchAbort = null;
  /** @type {{toolbar:HTMLElement,search:HTMLInputElement,observer:IntersectionObserver|null}|null} */
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
  /** @type {number} body 全体監視の callback debounce timer (/rere C 3-C: 数十件/秒の mutation を 100ms 間隔に圧縮) */
  let leftnavBodyScanTimer = 0;
  /**
   * @type {string|null|undefined} YouTube アカウント ID メモ化キャッシュ。
   * undefined = 未取得 / null or string = キャッシュ済み (page reload まで再評価しない、/rere C 2-E)。
   */
  let _cachedYtAccountId = undefined;
  /** @type {number} fetchSubsList の exponential backoff 上限 (ms、上限 60s) (/rere B1-S2-4) */
  let subsListFetchBackoffMs = 0;
  /** @type {number} fetchSubsList が直近で失敗した時刻 (Date.now() 値) */
  let subsListFetchLastFailedAt = 0;

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
          // /rere B2-012/B2-018: extension reload で orphan 化したら全 observer / timer を停止
          if (!chrome.runtime?.id) { cleanupAllSearchFixerStateForOrphan(); return; }
          // YouTube ホームでは数十件/秒の childList mutation が発火するため、
          // findSubsSection() の DOM クエリを 100ms debounce で集約して CPU 負荷を抑制
          // する (/rere C 3-C)。
          if (leftnavBodyScanTimer) return;
          leftnavBodyScanTimer = setTimeout(() => {
            leftnavBodyScanTimer = 0;
            const found = findSubsSection();
            if (found) {
              // body 監視は不要になったので停止
              leftnavBodyObserver?.disconnect();
              leftnavBodyObserver = null;
              // 注入と #items 観察 attach
              scheduleLeftnavReinject();
              attachItemsObserver(found);
            }
          }, 100);
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
      // /rere B2-012/B2-018: extension reload で orphan 化したら全 observer / timer を停止
      if (!chrome.runtime?.id) { cleanupAllSearchFixerStateForOrphan(); return; }
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
    if (leftnavBodyScanTimer) {
      clearTimeout(leftnavBodyScanTimer);
      leftnavBodyScanTimer = 0;
    }
  }

  /** 連続 mutation を 1 回の再注入に圧縮するための debounce。 */
  function scheduleLeftnavReinject() {
    if (leftnavReinjectTimer) return;
    leftnavReinjectTimer = setTimeout(() => {
      leftnavReinjectTimer = 0;
      // observer guard: 自身の DOM 書き込み (appendChild / insertBefore) が
      // leftnavInjectObserver の childList:true で再発火するのを防ぐ。
      // disconnect → render → takeRecords (蓄積分破棄) → observe で再接続する
      // Amazon 月別合計と同じガードパターン（rere レビュー B1 2-D）。
      if (leftnavInjectObserver) {
        try { leftnavInjectObserver.disconnect(); } catch {}
      }
      try {
        applySubsLeftnavInjection();
        applySubsAllShortcut();
      } finally {
        // applySubsLeftnavInjection / applySubsAllShortcut の中で
        // detachLeftnavObservers → ensureLeftnavObservers が走って leftnavInjectObserver や
        // leftnavSectionWatched が更新される可能性がある。finally で **状態を再取得**して
        // stale items に observe したり、新規 observer に観察対象を与え忘れる経路を塞ぐ
        // (/rere B1-S2-3)。
        const finalObserver = leftnavInjectObserver;
        const finalSection = leftnavSectionWatched;
        if (finalObserver && finalSection) {
          const freshItems = finalSection.querySelector("#items");
          if (freshItems) {
            try { finalObserver.takeRecords(); } catch {}
            try { finalObserver.observe(freshItems, { childList: true }); } catch {}
          }
        }
      }
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

  /**
   * `/@handle` 形式の href から @handle 部分を抽出する。
   *
   * actions.js の `SearchFixer.extractHandleFromHref` と同等の実装をローカルにも持つ。
   * テスト容易性のため pure function は actions.js 側に move したが、IntersectionObserver の
   * 高頻度コールバックパスでは `SearchFixer` namespace の解決失敗 (load 順 / cache) に起因する
   * silent TypeError でサムネ inject 全体が止まる障害が観測されたため、防御的にローカルにも
   * 同じロジックを残す（2026-05-13 subsChannelsGrid サムネ取得失敗バグ修正）。
   *
   * Unicode 対応:
   *   - YouTube のハンドルは ASCII (`@nagumorui`) だけでなく日本語 / 韓国語 / 中国語 /
   *     アクセント記号を含むケースが多数ある (`@むめいの有名になりたい` 等)。
   *   - DOM の `href` は URL エンコード形式 (`/@%E3%82%80...`) で保持されるため、
   *     `decodeURIComponent` でデコードしてから Unicode property escapes でマッチする。
   */
  function extractHandleFromHref(href) {
    if (!href) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      decoded = href;
    }
    const m = decoded.match(/(@[\p{L}\p{N}._-]{1,60})(?:\/|$|\?|#)/u);
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


  // ----- A1: leftnav 全件注入 -----

  async function applySubsLeftnavInjection() {
    if (!f("subsLeftnavInjectAll")) {
      abortSubsListFetch();
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
    // 正規形式: <a><img><span class="(name)">{name}</span></a>
    //   または <a><span class="__cpa-sfx-leftnav-fallback">{頭文字}</span><span>{name}</span></a>
    //     (avatarUrl 取得失敗時の fallback。img なしでも正規エントリなので削除してはいけない —
    //      Codex P2 指摘 2026-05-08: 以前は `!img` で legacy 判定していたため fallback も
    //      毎 cycle 削除・再生成されて flicker していた。)
    itemsDiv.querySelectorAll(`.${SUBS_INJECT_MARKER}`).forEach((el) => {
      const img = el.querySelector(":scope > img");
      const fallback = el.querySelector(":scope > .__cpa-sfx-leftnav-fallback");
      const nameSpan = el.querySelector(":scope > span:not(.__cpa-sfx-leftnav-fallback)");
      const nameText = (nameSpan?.textContent || "").trim();
      // 旧 schema = アイコン領域 (img も fallback も) 無い、または name span 不在、
      // または name span に説明文丸ごと入って 80 字超
      if ((!img && !fallback) || !nameSpan || nameText.length > 80) {
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
    // ch.href は ytInitialData の navigationEndpoint.commandMetadata.webCommandMetadata.url から
    // 来るパス相対 (`/@handle`) のはず。`javascript:` / `data:` 等が紛れ込んだ場合に <a> クリックで
    // page world でスクリプト実行される経路を遮断する (/rere レビュー A2-I-2)。
    // 通常の YouTube ハンドル URL は `/` または `https://` 始まりなのでこの 2 形式のみ allowlist。
    link.href = SearchFixer.normalizeChannelHref(ch.href);
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
    // ytInitialData の thumbnail.url は通常 https:// または // のプロトコル相対形式だが、
    // CDN 設定ミス / 中間者 / 将来の改ざんで `javascript:` / `data:` 等が紛れ込んだ場合に
    // `<img src>` 経由で onerror ハンドラが isolated world で発火する経路を遮断する
    // (/rere レビュー A2-I-1)。http(s) 以外のスキームは空文字で拒否。
    if (!url.startsWith("https://") && !url.startsWith("http://")) return "";
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
    // 直近の失敗から exponential backoff 期間内ならスキップする。社内プロキシ環境で
    // /feed/channels が 401/302 を返し続ける状況で 80ms 毎の永続リトライを防ぐ
    // (/rere B1-S2-4)。Cookie/プロキシ改善後の自然回復を妨げないよう上限 60s。
    if (subsListFetchBackoffMs > 0 && Date.now() - subsListFetchLastFailedAt < subsListFetchBackoffMs) {
      return null;
    }
    subsListFetchInFlight = (async () => {
      try {
        // same-origin 認証 fetch: 登録チャンネル一覧はログインセッション必須なので credentials は
        // "same-origin" 固定 (omit にすると未ログイン扱いで取得不能)。referrerPolicy / ALLOWED_HOSTS は
        // same-origin では無意味なので付けない。redirect:"manual" でプロキシ環境の cross-origin 302 を
        // opaqueredirect (res.ok===false) 扱いにし YouTube Cookie 漏洩を塞ぐ (keepalive.js と同型、
        // external CDN 向けの fetch 4 原則とは別パターン — references/patterns.md「外部 fetch allowlist 設計」参照)。
        subsListFetchAbort ??= new AbortController();
        const res = await fetch("/feed/channels", {
          credentials: "same-origin",
          redirect: "manual",
          signal: AbortSignal.any([
            subsListFetchAbort.signal,
            AbortSignal.timeout(SearchFixer.SUBS_FETCH_TIMEOUT_MS),
          ]),
        });
        if (!res.ok) {
          subsListFetchLastFailedAt = Date.now();
          subsListFetchBackoffMs = Math.min(60000, Math.max(2000, subsListFetchBackoffMs * 2));
          return null;
        }
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const list = parseSubsListFromDocument(doc);
        if (list.length > 0) {
          writeSubsListCache(list);
          subsListFetchBackoffMs = 0; // 成功で backoff リセット
        }
        return list;
      } catch {
        subsListFetchLastFailedAt = Date.now();
        subsListFetchBackoffMs = Math.min(60000, Math.max(2000, subsListFetchBackoffMs * 2));
        return null;
      } finally {
        subsListFetchInFlight = null;
        subsListFetchAbort = null;
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
    // YouTube のログインセッションは page reload まで変わらない (アカウント切替も
    // navigate で content script が再起動する) ため module スコープにメモ化する。
    // <script> タグ 20-50 個 × textContent 文字列検索のコスト削減 (/rere C 2-E)。
    if (_cachedYtAccountId !== undefined) return _cachedYtAccountId;
    try {
      for (const s of document.querySelectorAll("script")) {
        const t = s.textContent || "";
        if (t.indexOf("DELEGATED_SESSION_ID") === -1 && t.indexOf("SESSION_INDEX") === -1) continue;
        let m = t.match(/"DELEGATED_SESSION_ID":\s*"([^"]+)"/);
        if (m) {
          _cachedYtAccountId = "ds:" + m[1];
          return _cachedYtAccountId;
        }
        m = t.match(/"SESSION_INDEX":\s*"([^"]*)"/);
        if (m) {
          _cachedYtAccountId = "si:" + m[1];
          return _cachedYtAccountId;
        }
      }
    } catch {
      // 失敗時は null で安全側に倒す
    }
    _cachedYtAccountId = null;
    return null;
  }

  // ----- A2: ショートカットボタン -----

  function applySubsAllShortcut() {
    // 拡張機能 reload 後の orphan content script では `chrome.runtime.id` が undefined になり、
    // この関数内の `chrome.i18n.getMessage` で "Extension context invalidated" が throw する。
    // MutationObserver / SPA navigation 起点でこの関数が呼ばれ続けるため、入口でガードする。
    // observer 群の disconnect は不要 (invalidation 後は callback が呼ばれても空処理で済むため)。
    if (!chrome.runtime || !chrome.runtime.id) return;
    const existing = document.querySelector(`.${SUBS_SHORTCUT_MARKER}`);
    if (!f("subsAllShortcut")) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return; // idempotent
    // subs section の sibling として insertBefore すると Polymer dom-repeat が reorder を発動して
    // section が leftnav 末尾に飛ばされるため、`#items` 配下に inject する (subsLeftnavInjectAll
    // と同じパターン)。`#items.firstElementChild` は collapsible expander で見出しっぽく振る舞う
    // ので、それより後ろの最初のチャンネル entry の直前に挿入することで「見出し直下、リスト最上」
    // 位置になる。`#header-entry` は別の `#header` div 内で `#items` の外。
    const section = findSubsSection();
    if (!section) return;
    const itemsDiv = section.querySelector("#items");
    if (!itemsDiv) return;
    const entry = document.createElement("a");
    entry.className = SUBS_SHORTCUT_MARKER;
    entry.href = "/feed/channels";
    const allSubsLabel = chrome.i18n.getMessage("subsAllShortcutLabel") || "すべての登録チャンネル";
    entry.title = allSubsLabel;
    entry.setAttribute("aria-label", allSubsLabel);
    // YouTube の Trusted Types policy で innerHTML 文字列代入は弾かれうるので createElement で構築。
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
    labelSpan.textContent = allSubsLabel;
    entry.appendChild(iconSpan);
    entry.appendChild(labelSpan);
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
    // 同上: orphan content script で `chrome.i18n.getMessage` (ensureSubsGridToolbar 内 placeholder)
    // が throw するのを防ぐ。MutationObserver / SPA navigation 起点で頻繁に呼ばれる経路なので
    // 入口でガードする。
    if (!chrome.runtime || !chrome.runtime.id) return;
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
      // /rere B2-012/B2-018: extension reload で orphan 化したら全 observer / timer を停止
      if (!chrome.runtime?.id) { cleanupAllSearchFixerStateForOrphan(); return; }
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
    abortSubsThumbnailFetches();
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
    search.placeholder = chrome.i18n.getMessage("subsSearchPlaceholder") || "チャンネル名で絞り込み";
    search.autocomplete = "off";
    search.spellcheck = false;
    // /rere C1-001 修正: 旧実装は debounce ゼロで毎打鍵に全 N×querySelector を走査していたため、
    // 大規模 subs feed (数百〜数千 channel) で入力遅延が起きた。80ms debounce で IME 確定や
    // 連打を 1 回に集約しつつ、体感は即時 (人間の入力 latency 知覚閾値 ~100ms より下)。
    let subsGridFilterTimer = 0;
    search.addEventListener("input", () => {
      if (subsGridFilterTimer) clearTimeout(subsGridFilterTimer);
      subsGridFilterTimer = setTimeout(() => {
        subsGridFilterTimer = 0;
        applySubsGridFilter();
      }, 80);
    });

    // sort UI は YouTube ネイティブの「名前順 / 登録順 / 最新アクティビティ順」combobox
    // (`<button role="combobox">`) と完全に役割が被るため拡張側からは出さない。
    // ネイティブ sort 操作後の card 再 hydrate には observeSubsGridCardAdditions が追従する。
    toolbar.append(search);
    subsGridState = { toolbar, search, observer: null };
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
    // ホーム列数 (searchFixerGridItems) が 4/5/6 の固定指定なら、ホーム / 検索結果グリッドと
    // 同じ列数に揃える（3 グリッドの列数統一）。自動 (0) のときだけ viewport 連動で決める。
    //   注: ホーム / 検索の自動時は html の `--ytd-rich-grid-items-per-row` を参照するが、
    //   /feed/channels ではこの変数が stale (常に 4) で追従しないため、自動時は自前計算を使う
    //   (computeSubsGridItemsPerRow の breakpoint は YouTube 標準列数の実測近似なので概ね一致する)。
    const fixed = gridItems === 4 || gridItems === 5 || gridItems === 6;
    const items = fixed ? gridItems : computeSubsGridItemsPerRow(window.innerWidth);
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
      // observer インスタンスを **closure に capture** してから state に格納する。
      // `subsGridState.observer` を直接 deref すると、機能 OFF or /feed/channels 離脱で
      // `detachSubsChannelsGrid()` が `subsGridState = null` にセットした後も IO の
      // queued callback が走った場合に TypeError を起こす (Codex P2 指摘 2026-05-08)。
      // disconnect() しても **既に queue 入りした notification は cancel されない**ので、
      // closure capture + 冒頭の subsGridState null guard で安全側に倒す。
      const observer = new IntersectionObserver(
        (entries) => {
          if (subsGridState === null) return; // detach 後の stale callback ガード
          for (const entry of entries) {
            if (entry.isIntersecting) {
              observer.unobserve(entry.target); // closure capture 経由で stale な subsGridState 不要
              queueSubsThumbnailFetch(entry.target);
            }
          }
        },
        { rootMargin: "300px 0px" }
      );
      subsGridState.observer = observer;
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
        // YouTube が card を完全再構築 (#avatar が #avatar-section に戻る等) した場合に
        // 構造スタイリングフェーズ (avatar 移動・info-section レイアウト等) を再適用するため、
        // styled マーカーも剥がす (/rere B1-S2-7)。
        card.removeAttribute("data-cpa-subs-styled");
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
    // ON/OFF 繰り返しでの listener 蓄積防止: data-cpa-card-click を剥がして
    // 次回 ON 時に新規 listener を 1 つだけ追加させる（古い listener は subsGridState===null guard で no-op 化）。
    // data-cpa-card-href を剥がしておかないと Polymer dom-repeat で card が別チャンネルに再バインドされた際に
    // 古い href のまま残って oldThumb 除去の flicker 経路を踏む（rere レビュー C3-3 指摘）。
    card.removeAttribute("data-cpa-card-click");
    card.removeAttribute("data-cpa-card-href");
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
   * カードがビューポートに入ったタイミングで、対応するチャンネルの Featured 動画サムネを取得。
   * `/${handle}` HTML 内の `"videoId":"..."` 出現順上位 10 件を候補に、**2 段階で並列 HEAD 篩い分け** (v6 仕様):
   *
   *   1. maxresdefault.jpg HEAD 200 を探す → 採用 (`https://i.ytimg.com/vi/{vid}/maxresdefault.jpg`, 1280x720)
   *   2. 全 404 なら hqdefault.jpg のサイズ > 30KB を探す → 採用 (480x360, Shorts / HD なし動画救済)
   *   3. それも見つからなければ thumbUrl=null (空白カード、灰色プレースホルダー画像は絶対表示しない)
   *
   * 旧 v5 ロジックは「HTML 内最初の `videoId`」を盲信して削除済み動画の灰色プレースホルダー画像
   * (maxres 404 / 1097B、hq < 16KB) を表示してしまう問題があった (2026-05-13 ユロさん指摘で発覚)。
   * 旧 Stage2 (`/feeds/videos.xml?channel_id=...`) は YouTube が 2026-05 までに 404 化したため撤去。
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
      // 同じ handle に対する重複 fetch を抑止（sort-wipe 経路で marker 一括 clear → 再 observe
      // で同じカードが in-flight 中に再 trigger されると、`readSubsThumbCache` は cache miss
      // を返すため fetch が複数走ってしまう）。
      try {
        const signal = AbortSignal.any([
          subsThumbFetchAbort.signal,
          AbortSignal.timeout(SearchFixer.SUBS_FETCH_TIMEOUT_MS),
        ]);
        // v7 (2026-05-28): `/${handle}` (チャンネルトップ) 1 fetch → `/${handle}/videos` +
        // `/${handle}/streams` 2 fetch 並列に切替。ライブ配信中の動画 (LIVE) を最優先 + 配信
        // 予定 (UPCOMING、雑談チャット用が混じることが多い) を除外できるようになった。
        //
        // 取得元の使い分け:
        //   - /videos tab: 通常動画 + アーカイブ済みライブ配信
        //   - /streams tab: 配信中 (LIVE) + 配信予定 (UPCOMING) + 配信済み (アーカイブ)
        //
        // バッジ判定 (HTML 内の thumbnailBadgeViewModel から正規表現抽出):
        //   - LIVE 配信中: `"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"` (言語非依存) +
        //     周辺の `animationActivationTargetId` が当該 videoId。**最優先採用**
        //   - UPCOMING 配信予定: `badgeStyle` は `..._DEFAULT` で LIVE と区別できないため
        //     `"text":"配信予定"` (ja) / `"Upcoming"` / `"Scheduled"` / `"Premieres"` (en
        //     系) / `"首播"` (zh) 等の多言語パターンで判定。**候補から除外**
        //   - 通常動画 / アーカイブ済みライブ: 上記いずれにも該当しない → 採用候補
        //
        // 候補順: LIVE (最優先) → /videos と /streams の HTML 出現順 (UPCOMING 除外、重複削除) 上位 10
        //
        // 採用ロジック (Stage 1 / 2) は v6 から維持: maxresdefault HEAD 200 → hqdefault 30KB 超 → null
        //
        // 実測データ (2026-05-13 検証、v6 から継承):
        //   - 削除済み動画 maxres: 404 / 1097B (灰色 + ... プレースホルダー)
        //   - 削除済み動画 hqdefault: 200 / 8000-16000B (同プレースホルダー)
        //   - 通常 HD 動画 maxres: 200 / 50000-200000B+
        //   - 通常 Shorts 動画 hqdefault: 200 / 30000-50000B (縦長サムネ)
        //   - 30000B 閾値で削除済みプレースホルダーと valid Shorts を確実に分離できる
        // /rere C2-Imp2 修正: /streams は LIVE 検出が `/videos` で fail したときのみ fetch する
        // (lazy fallback)。LIVE 配信中チャンネル (LofiGirl 等) は /videos の最新動画に LIVE バッジが
        // 既に現れることが大多数で、平時の登録チャンネルは LIVE 配信なし = /streams は使われない。
        // 100ch ユーザーで平時 100% を 50% (LIVE 配信中チャンネルが少数) 程度に削減できる。
        // /streams にしか出ない archived stream のみのチャンネル (LIVE 終了後アーカイブ) には
        // /videos の通常動画候補が代わりに表示される (UX 影響ほぼなし)。
        // same-origin 認証 fetch (credentials:"same-origin" 固定、omit 不可)。/feed/channels と同型で、
        // external CDN 向け fetch 4 原則とは別パターン (references/patterns.md「外部 fetch allowlist 設計」参照)。
        const videosHtml = await fetch(`/${handle}/videos`, { credentials: "same-origin", redirect: "manual", signal })
          .then((r) => (r.ok ? r.text() : null))
          .catch(() => null);
        // 軽量 LIVE 検出: 1 マッチで早期判定 (matchAll の前段、lastIndex 進行を避けるため new RegExp)
        const liveDetectedInVideos =
          videosHtml != null &&
          new RegExp('"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"').test(videosHtml);
        let streamsHtml = null;
        if (!liveDetectedInVideos) {
          streamsHtml = await fetch(`/${handle}/streams`, { credentials: "same-origin", redirect: "manual", signal })
            .then((r) => (r.ok ? r.text() : null))
            .catch(() => null);
        }
        if (!videosHtml && !streamsHtml) return;

        // channelId は /videos 優先、無ければ /streams から
        const channelIdSource = videosHtml || streamsHtml;
        channelId = channelIdSource.match(/"externalId":"(UC[\w-]{20,30})"/)?.[1] || null;

        // バッジ抽出正規表現 (v7)
        //   - LIVE: badgeStyle が SOMETHING_LIVE の 400 文字以内に animationActivationTargetId
        //   - UPCOMING (除外): text が UPCOMING 多言語パターンの 400 文字以内に animationActivationTargetId
        //     (multilang: 日本語「配信予定」+ 英語「Upcoming」「Scheduled」「Premieres」+ 中国語「首播」をカバー)
        const LIVE_BADGE_RE = /"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"[\s\S]{0,400}?"animationActivationTargetId":"([a-zA-Z0-9_-]{11})"/g;
        const UPCOMING_TEXT_RE = /"text":"(?:配信予定|Upcoming|Scheduled|Premieres|首播)[^"]*"[\s\S]{0,400}?"animationActivationTargetId":"([a-zA-Z0-9_-]{11})"/g;
        const VIDEO_ID_RE = /"videoId":"([a-zA-Z0-9_-]{11})"/g;

        const liveSet = new Set();
        const upcomingSet = new Set();
        const orderedVideos = [];
        const seen = new Set();

        for (const html of [videosHtml, streamsHtml]) {
          if (!html) continue;
          for (const m of html.matchAll(LIVE_BADGE_RE)) liveSet.add(m[1]);
          for (const m of html.matchAll(UPCOMING_TEXT_RE)) upcomingSet.add(m[1]);
          for (const m of html.matchAll(VIDEO_ID_RE)) {
            if (seen.has(m[1])) continue;
            seen.add(m[1]);
            orderedVideos.push(m[1]);
          }
        }

        // 候補リスト構築: LIVE → 通常 (UPCOMING を除外した HTML 出現順) → 上位 10
        const candidateIds = [
          ...liveSet,
          ...orderedVideos.filter((v) => !liveSet.has(v) && !upcomingSet.has(v)),
        ].slice(0, 10);
        // Stage 1: maxresdefault HEAD で 200 を探す (HD 動画優先)
        const maxresChecks = await Promise.allSettled(
          candidateIds.map((vid) =>
            // `redirect: "manual"` で 3xx を opaqueredirect として捕捉する。CDN 設定変更や中間者による
            // 認証ドメインへの 302 を `r.ok === false` 扱いにして候補スキップする防御
            // (/rere レビュー A2-I-4)。`credentials: "omit"` + redirect:manual の組み合わせは
            // image-downloader.js と同じパターン (外部 CDN fetch の 4 原則、CLAUDE.md「外部 fetch allowlist 設計」参照)。
            fetch(`https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`, {
              method: "HEAD",
              credentials: "omit",
              redirect: "manual",
              signal,
            }).then((r) => ({ vid, ok: r.ok }))
          )
        );
        let validVideoId = null;
        let thumbVariant = "maxresdefault";
        for (let i = 0; i < candidateIds.length; i++) {
          const c = maxresChecks[i];
          if (c.status === "fulfilled" && c.value?.ok) {
            validVideoId = candidateIds[i];
            break;
          }
        }
        // Stage 2: maxres 全 404 のとき hqdefault のサイズで Shorts / HD なし動画を救済
        if (!validVideoId) {
          const hqChecks = await Promise.allSettled(
            candidateIds.map((vid) =>
              // 同上 (A2-I-4): redirect:manual で 3xx を opaqueredirect 化、credentials:omit と併用
              fetch(`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, {
                method: "HEAD",
                credentials: "omit",
                redirect: "manual",
                signal,
              }).then((r) => ({
                vid,
                len: parseInt(r.headers.get("content-length") || "0", 10),
              }))
            )
          );
          for (let i = 0; i < candidateIds.length; i++) {
            const c = hqChecks[i];
            if (c.status === "fulfilled" && c.value.len > 30000) {
              validVideoId = candidateIds[i];
              thumbVariant = "hqdefault";
              break;
            }
          }
        }
        thumbUrl = validVideoId
          ? `https://i.ytimg.com/vi/${validVideoId}/${thumbVariant}.jpg`
          : null;
        writeSubsThumbCache(handle, { thumbUrl, channelId, ts: Date.now() });
      } catch {
        return;
      }
    }
    if (!thumbUrl) return;
    // post-await guard: detach / 離脱 / 重複 inject / **カード DOM 再利用** を fence する。
    // YouTube の native sort/re-hydration で `ytd-channel-renderer` が物理移動だけで並び替わる
    // ケースがあり、`#main-link` の href が別チャンネルに書き換わった card に古いチャンネルの
    // サムネを append してしまう race condition を防ぐ (Codex P2 指摘 2026-05-08)。
    if (subsGridState === null) return;
    if (!card.isConnected) return;
    const currentHandle = extractHandleFromHref(
      card.querySelector("#main-link")?.getAttribute("href") || ""
    );
    if (currentHandle !== handle) return;
    if (card.querySelector(`.${SUBS_THUMB_CLASS}`)) return;
    const img = document.createElement("img");
    img.className = SUBS_THUMB_CLASS;
    img.src = normalizeAvatarUrl(thumbUrl);
    img.loading = "lazy";
    img.alt = "";
    // v6: 採用時点で HEAD 200 確認済みのため通常は onerror に来ない。
    // 念のため maxres → mqdefault、hq → mqdefault の保守的 fallback を残す
    // (HEAD 後に短時間でサムネが消えた等の極端なレースに備える)。
    img.onerror = () => {
      img.onerror = null;
      const fallback = img.src
        .replace(/\/maxresdefault\.jpg([?#].*)?$/, "/mqdefault.jpg$1")
        .replace(/\/hqdefault\.jpg([?#].*)?$/, "/mqdefault.jpg$1");
      if (fallback !== img.src) img.src = fallback;
    };
    // #avatar-section 直下に置く。`#avatar` 内に置くとアバター 36px 円の上に乗ってしまう。
    const slot = card.querySelector("#avatar-section") || card;
    slot.appendChild(img);
  }

  function queueSubsThumbnailFetch(card) {
    const handle = extractHandleFromHref(card.querySelector("#main-link")?.getAttribute("href") || "");
    if (!handle || subsThumbFetchingHandles.has(handle)) return;
    subsThumbFetchingHandles.add(handle);
    subsThumbFetchQueue.push({ card, handle });
    drainSubsThumbnailFetchQueue();
  }

  function drainSubsThumbnailFetchQueue() {
    if (!subsThumbFetchAbort) subsThumbFetchAbort = new AbortController();
    while (
      subsGridState &&
      subsThumbFetchActive < SearchFixer.SUBS_THUMB_FETCH_CONCURRENCY &&
      subsThumbFetchQueue.length > 0
    ) {
      const task = subsThumbFetchQueue.shift();
      subsThumbFetchActive++;
      fetchAndInjectThumbnail(task.card).finally(() => {
        subsThumbFetchingHandles.delete(task.handle);
        subsThumbFetchActive--;
        drainSubsThumbnailFetchQueue();
      });
    }
  }

  function abortSubsThumbnailFetches() {
    for (const task of subsThumbFetchQueue.splice(0)) subsThumbFetchingHandles.delete(task.handle);
    try { subsThumbFetchAbort?.abort(); } catch {}
    subsThumbFetchAbort = null;
  }

  function abortSubsListFetch() {
    try { subsListFetchAbort?.abort(); } catch {}
    subsListFetchAbort = null;
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

  // ---------- /rere B2-012 + B2-018 修正: orphan 化への対応 ----------
  /**
   * extension reload で content script が orphan 化したとき、MutationObserver / setInterval /
   * setTimeout / window resize listener が止まらず CPU を消費し続けるリスクがあった。
   * 他 9 ファイルの PATTERN SYNC (CLAUDE.md「Extension context invalidation guard PATTERN SYNC」)
   * に倣って、各 MO callback 入口で chrome.runtime?.id を確認し、orphan 検知時に全 observer /
   * timer / listener を停止する共通 cleanup を呼ぶ。
   *
   * pagehide でも同関数を呼んで browser cleanup を補助する。
   *
   * 多経路から呼ばれても `orphanCleanupRan` フラグで 1 回だけ実行される (再 attach 防止)。
   */
  let orphanCleanupRan = false;
  function cleanupAllSearchFixerStateForOrphan() {
    if (orphanCleanupRan) return;
    orphanCleanupRan = true;
    try { detachResultsObserver(); } catch {}
    try { detachLiveChatObserver(); } catch {}
    try { detachLeftnavObservers(); } catch {}
    try { stopSubsGridCardsObserver(); } catch {}
    try { stopSubsGridResizeListener(); } catch {}
    try { removeAllBlockButtons(); } catch {} // chrome API 非依存、orphan 後も安全
    try { abortForeignCountryFetch(); } catch {} // 同上（待ち行列破棄 + in-flight 中断）
    try { abortSubsListFetch(); } catch {}
    try { abortSubsThumbnailFetches(); } catch {}
  }

  window.addEventListener(
    "pagehide",
    () => cleanupAllSearchFixerStateForOrphan(),
    { once: true }
  );

})();
