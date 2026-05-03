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
  if (window.__searchFixerRunning) return;
  window.__searchFixerRunning = true;
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

    if (isWatchPage()) {
      applyWatchPageClasses();
    }
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
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    queueMicrotask(() => {
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

  // ---------- 動画ページ（タイトル中央 / 説明文フル幅） ----------
  function applyWatchPageClasses() {
    const titleEl = document.querySelector("#title h1");
    if (titleEl) titleEl.classList.toggle("__cpa-sfx-title-center", f("centerTitle"));
    const descEl = document.querySelectorAll("#description")[1];
    if (descEl) descEl.classList.toggle("__cpa-sfx-desc-full", f("fullWidthDesc"));
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
