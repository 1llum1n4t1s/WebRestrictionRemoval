"use strict";

/**
 * YouTube Search Fixer content script。
 *
 * 元拡張機能 "Search Fixer for YouTube" (`bojdknokkpgboeonegndfcgkaommhleo`) の DOM 操作ロジックを
 * 単一ファイルに移植したもの。元コードは外部送信ゼロだったため移植時もテレメトリ無し。
 * 設定は `chrome.storage.local` の `searchFixerEnabled` (master) / `searchFixerFeatures` (個別) /
 * `searchFixerGridItems` (数値) の 3 キーで管理する。
 *
 * 役割:
 *   - 検索結果ページ（/results）で `MutationObserver` を起動し、ノイズ要素を `removeDistractions()` で除去
 *   - 動画ページ（/watch）でタイトル中央配置・説明文フル幅クラスを切り替え
 *   - ホームのリッチグリッドに列数 CSS を注入（4/5/6 のみ、0 は YouTube 既定）
 *   - 検索結果ページのキーワード非マッチ動画を `yt-ext-demoted` クラスでデモート（CSS 側でグレー化）
 *
 * 設計上の差分（元拡張比）:
 *   - `counterString`（除去カウンタ）は機能的価値が薄いため移植しない（プライバシー UI もポップアップに含めない）
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
  function removeDistractions() {
    if (!isResultsPage()) return;

    // ヘルパ: 該当要素を try で囲んで一括除去
    const removeAll = (selector, scope = document, transform = (el) => el) => {
      try {
        scope.querySelectorAll(selector).forEach((el) => {
          const target = transform(el);
          if (target && target.isConnected) target.remove();
        });
      } catch {
        // セレクタ未対応 / 対象不在は無視
      }
    };

    if (f("shelf")) {
      removeAll(
        "#primary .ytd-two-column-search-results-renderer ytd-shelf-renderer"
      );
    }

    if (f("cardList")) {
      // 元実装はカードリストとシェルフを同セレクタで重複削除していたため、こちらは
      // 横並びカード（ytd-horizontal-card-list-renderer）を対象に絞る方が実害が少ない
      removeAll(
        "ytd-horizontal-card-list-renderer.ytd-item-section-renderer:not(:first-child)"
      );
    }

    if (f("channel")) {
      removeAll(
        "#primary .ytd-two-column-search-results-renderer ytd-channel-renderer"
      );
    }

    if (f("reel")) {
      removeAll(
        "#primary .ytd-two-column-search-results-renderer ytd-reel-shelf-renderer"
      );
      removeAll("grid-shelf-view-model");
    }

    if (f("shortsBtn")) {
      // ytd-video-renderer 内のサムネイルが /shorts/ を指すケース（検索結果に紛れ込む単発 Shorts）
      try {
        document
          .querySelectorAll(
            "ytd-video-renderer ytd-thumbnail a#thumbnail[href*='/shorts/']"
          )
          .forEach((a) => {
            const renderer = a.closest("ytd-video-renderer");
            if (renderer && renderer.isConnected) renderer.remove();
          });
      } catch {}
    }

    if (f("live")) {
      try {
        document.querySelectorAll("#badges .yt-badge-shape__text, #badges > div > p").forEach((badge) => {
          const text = badge.textContent.trim();
          if (text === "LIVE" || text === "PREMIERE") {
            badge.closest("ytd-video-renderer")?.remove();
          }
        });
      } catch {}
    }

    if (f("playlist") || f("mix")) {
      try {
        document.querySelectorAll(".yt-lockup-view-model--horizontal").forEach((item) => {
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
          if (f("playlist") && isPlaylist) item.remove();
          else if (f("mix") && isMix) item.remove();
        });
      } catch {}
    }

    if (f("course")) {
      removeAll(".yt-lockup-view-model--wrapper");
    }

    if (f("verified") || f("artist")) {
      try {
        document.querySelectorAll("#primary ytd-item-section-renderer ytd-video-renderer").forEach((renderer) => {
          if (f("verified") && renderer.querySelector('badge-shape[aria-label="Verified"]')) {
            renderer.remove();
            return;
          }
          if (f("artist") && renderer.querySelector('badge-shape[aria-label="Official Artist Channel"]')) {
            renderer.remove();
          }
        });
      } catch {}
    }

    if (f("watched")) {
      try {
        document.querySelectorAll("ytd-thumbnail-overlay-resume-playback-renderer").forEach((overlay) => {
          overlay.closest("ytd-video-renderer")?.remove();
        });
      } catch {}
    }

    if (f("chapter")) {
      try {
        document.querySelectorAll("ytd-expandable-metadata-renderer").forEach((meta) => {
          meta.closest("ytd-video-renderer")?.remove();
        });
      } catch {}
    }

    if (f("secondary")) {
      removeAll("ytd-secondary-search-container-renderer");
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
