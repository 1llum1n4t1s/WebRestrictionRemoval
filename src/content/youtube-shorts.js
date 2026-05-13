"use strict";

/**
 * YouTube Shorts 関連 content script。
 *
 * v1.0.x で「Shorts 関連」単独カテゴリを廃止し、Shorts に関する各機能を他のフィルタと同列に
 * 並べる方針に変更。本ファイルでは以下 4 機能を独立フラグで制御する:
 *   - `removeShortsShelf`:   Shorts 棚（ホーム / 検索）削除 → 動画フィルタカテゴリ
 *   - `removeShortsChip`:    検索ページ上部の「Shorts」フィルタチップ削除 → 検索結果カテゴリ
 *   - `removeShortsSidebar`: 左サイドバーの「ショート」メニュー削除 → メニュー/UI カテゴリ
 *   - `redirectShortsUrl`:   `/shorts/<id>` URL を `/watch?v=<id>` にリダイレクト → 動画ページカテゴリ
 *
 * 個別 Shorts 動画（縦動画レンダラー）の削除は search-fixer.js の `shortsBtn` 機能が担当。
 *
 * オプトインで動作（デフォルト OFF）。`searchFixerEnabled` (master) AND いずれかの機能が
 * true のときに content script が起動する。外部送信・テレメトリ・localStorage は一切持たない。
 *
 * 設計判断:
 *   - search-fixer.js とは別ファイル: URL リダイレクトはサイト全体スコープで動かすため、
 *     検索ページ専用ロジックを持つ search-fixer.js とは責務分離する。同一 isolated world で
 *     動作するため共通定数 (Actions / StorageKeys / SearchFixer / YouTubeShorts) は共有。
 *   - 全フレーム inject ではなく top frame のみ: YouTube は埋め込みプレーヤーで動画 ID 単独の
 *     iframe を多数生成するため、すべてに observer をぶら下げると CPU を浪費する。
 *     Shorts UI は基本的にトップフレームの SPA に存在するため top のみで十分。
 */

(() => {
  // 二重実行ガード（content.js と同様の方針）。manifest 上は一度しか注入されないが、
  // 開発時の手動再ロード等で IIFE が複数回走るケースに備える。
  if (window.__ytShortsRemoverRunning) return;
  window.__ytShortsRemoverRunning = true;

  // top frame のみで動かす。埋め込みプレーヤー iframe では Shorts UI が出ないため。
  if (window !== window.top) return;

  /** @type {MutationObserver|null} */
  let observer = null;
  /** @type {number|null} */
  let urlPollTimerId = null;

  // 各機能の活性状態を独立に持つ（v1.0.x で 1 機能 → 4 機能に分離）。
  //   shelfActive    = removeShortsShelf    (Shorts 棚 + チャンネルタブ: SELECTORS_SHELF + tab CSS)
  //   chipActive     = removeShortsChip     (検索チップ: SELECTORS_CHIP)
  //   sidebarActive  = removeShortsSidebar  (左サイドバーメニュー + モバイル pivot: SELECTORS_SIDEBAR + CSS)
  //   urlRedirectActive = redirectShortsUrl (/shorts/<id> URL リダイレクト + フラッシュ抑制 CSS)
  let shelfActive = false;
  let chipActive = false;
  let sidebarActive = false;
  let urlRedirectActive = false;

  /**
   * master enabled と features から各機能の活性フラグを返す。
   * いずれの DOM 削除機能（shelf / chip / sidebar）も独立で on/off できる。URL リダイレクトも独立。
   */
  function computeFlags(masterEnabled, features) {
    if (masterEnabled !== true) {
      return { shelf: false, chip: false, sidebar: false, urlRedirect: false };
    }
    const merged = SearchFixer.mergeFeatures(features);
    return {
      shelf: merged.removeShortsShelf === true,
      chip: merged.removeShortsChip === true,
      sidebar: merged.removeShortsSidebar === true,
      urlRedirect: merged.redirectShortsUrl === true,
    };
  }

  // ---------- 初期化: 現在状態を読んで適用 ----------
  chrome.storage.local
    .get([StorageKeys.SEARCH_FIXER_ENABLED, StorageKeys.SEARCH_FIXER_FEATURES])
    .then((stored) => {
      apply(
        computeFlags(
          stored[StorageKeys.SEARCH_FIXER_ENABLED],
          stored[StorageKeys.SEARCH_FIXER_FEATURES]
        )
      );
    })
    .catch(() => {});

  // ---------- 状態追従 ----------
  // popup → background → content の APPLY_SEARCH_FIXER_CS 経路と、
  // storage.onChanged の 2 経路で同期する（メイン content.js と同じ二重購読方針）。
  chrome.runtime.onMessage.addListener((request, sender) => {
    // background SW 由来のみ受け付ける。他 content script の XSS 経由や popup から
    // 直接呼ばれるとユーザー設定をバイパスして state を書き換えられるため必須。
    if (!SenderCheck.isFromBackground(sender)) return;
    if (request?.action === Actions.APPLY_SEARCH_FIXER_CS) {
      const data = request.data ?? {};
      apply(computeFlags(data.enabled, data.features));
    }
  });

  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== "local") return;
    const enabledChange = changes[StorageKeys.SEARCH_FIXER_ENABLED];
    const featuresChange = changes[StorageKeys.SEARCH_FIXER_FEATURES];
    if (!enabledChange && !featuresChange) return;
    // 2-C2 fast path: handleApplySettings は両キーを 1 回の storage.local.set で書くため、
    // 通常の popup 操作経路では両キーが同時に changes に含まれる。この場合は newValue だけで
    // computeFlags を呼べるため storage.local.get の往復を完全に省略できる。
    if (enabledChange && featuresChange) {
      apply(computeFlags(enabledChange.newValue, featuresChange.newValue));
      return;
    }
    // 片方だけ変わった場合のエッジケース（onInstalled の単独キー書き込み等）に備えて両方再取得。
    // 変更されてないキーは undefined になるため computeFlags() が誤判定する罠を回避する。
    try {
      const stored = await chrome.storage.local.get([
        StorageKeys.SEARCH_FIXER_ENABLED,
        StorageKeys.SEARCH_FIXER_FEATURES,
      ]);
      apply(
        computeFlags(
          stored[StorageKeys.SEARCH_FIXER_ENABLED],
          stored[StorageKeys.SEARCH_FIXER_FEATURES]
        )
      );
    } catch {
      // storage 一時的にアクセス不可 → 次の通知に任せる
    }
  });

  /**
   * 各機能フラグを反映する。4 機能（shelf / chip / sidebar / urlRedirect）を独立に on/off できる。
   * shelf/chip/sidebar のいずれかが true なら observer を起動、すべて false なら停止する。
   */
  function apply(flags) {
    const newAnyDom = flags.shelf || flags.chip || flags.sidebar;
    const oldAnyDom = shelfActive || chipActive || sidebarActive;

    // 個別フラグを更新（次の purgeShortsDom が参照する）
    shelfActive = flags.shelf;
    chipActive = flags.chip;
    sidebarActive = flags.sidebar;

    // CSS 用クラスは機能ごとに付け外しして、JS の DOM 削除と同じ粒度に揃える。
    // 単一クラスに集約すると 1 サブ機能 ON でも他カテゴリの CSS まで発火する罠（旧実装の問題）。
    // classList.toggle(name, force) は idempotent なので毎回呼んで OK。
    const html = document.documentElement;
    html.classList.toggle("__cpa-yt-shorts-hide-shelf", flags.shelf);
    html.classList.toggle("__cpa-yt-shorts-hide-chip", flags.chip);
    html.classList.toggle("__cpa-yt-shorts-hide-sidebar", flags.sidebar);

    if (newAnyDom !== oldAnyDom) {
      if (newAnyDom) {
        startObserver();
        purgeShortsDom();
      } else {
        stopObserver();
      }
    } else if (newAnyDom) {
      // 観察は継続中だがフラグ構成が変わった（例: shelf を OFF にして chip を ON）→ 即時 purge し直す
      purgeShortsDom();
    }

    // ---- URL リダイレクト（DOM 削除とは独立に動く）----
    if (flags.urlRedirect !== urlRedirectActive) {
      urlRedirectActive = flags.urlRedirect;
      if (flags.urlRedirect) {
        startUrlRedirectPoll();
        maybeRedirectShortsUrl();
      } else {
        stopUrlRedirectPoll();
      }
    }
    // /shorts/ ページの overflow:hidden は redirect 機能の付随 CSS。
    // 旧設計では shelf/chip/sidebar いずれか ON 時にしか発火しておらず redirect 単独 ON では機能していなかった。
    html.classList.toggle("__cpa-yt-shorts-redirect-active", flags.urlRedirect);
  }

  // ---------- DOM 削除 ----------
  // パフォーマンス特性:
  //   YouTube SPA は lazy hydrate と部分再描画で大量の mutation を発生させる。
  //   特に /feed/channels（160 件超のチャンネルカード）では本拡張自身のサムネ inject も
  //   加わって mutation observer が短時間に数百〜千回コールバックされる。
  //   旧実装は queueMicrotask で coalesce していたが、microtask は同 task 内で都度 flush
  //   されるため累計 3 秒級の CPU 食い詰まりが発生していた（trace: 3019ms / load 1 回）。
  //   v3: setTimeout(150ms) ベースの粗い debounce + SPA navigation 時のみ即時 scan に分離。
  //   これで観察コストは O(navigation 数) ＋少量の trailing scan に圧縮される。
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      // mutations の中身は問わず全 DOM をスキャン: YouTube は子孫構造を頻繁に差し替えるため
      // mutation 単位で局所スキャンするより全 querySelectorAll の方がシンプルかつ取りこぼしが少ない。
      // ただし microtask coalesce では追いつかないため 150ms debounce で粗く集約する。
      scheduleScan(false);
    });
    // body が無い段階（document_start 注入を将来選ぶケース）に備えるが、
    // manifest の run_at は document_idle なので基本 body は揃っている。
    const root = document.body || document.documentElement;
    if (!root) return;
    observer.observe(root, { childList: true, subtree: true });
    // SPA navigation 完了時は即時 scan（Shorts 棚が一瞬も画面に出ない UX を維持）
    document.addEventListener("yt-navigate-finish", onYtNavigateFinish);
  }

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    document.removeEventListener("yt-navigate-finish", onYtNavigateFinish);
    if (scanTimerId) {
      clearTimeout(scanTimerId);
      scanTimerId = 0;
    }
    scanScheduled = false;
  }

  function onYtNavigateFinish() {
    // navigation 直後は即時 scan に切り替えて hydrate と同フレームで Shorts 棚を消す
    scheduleScan(true);
  }

  let scanScheduled = false;
  let scanTimerId = 0;
  /**
   * Shorts 棚スキャンを予約する。
   * @param {boolean} immediate - true なら debounce を取り消して即時 scan する。
   *   SPA navigation 直後は immediate=true で hydrate と同フレームに走らせ、
   *   通常の mutation は immediate=false で 150ms debounce する。
   */
  function scheduleScan(immediate) {
    // zombie guard (/rere レビュー B1-D3 / D-4 横展開 PATTERN SYNC):
    // orphan content script で MutationObserver は disconnect されないと永久発火し続ける。
    // chrome API は呼ばないため例外は出ないが、purgeShortsDom が走り続けて CPU を浪費する。
    if (!chrome.runtime?.id) {
      stopObserver();
      stopUrlRedirectPoll();
      return;
    }
    if (immediate) {
      if (scanTimerId) {
        clearTimeout(scanTimerId);
        scanTimerId = 0;
      }
      scanScheduled = false;
      if (!shelfActive && !chipActive && !sidebarActive) return;
      purgeShortsDom();
      return;
    }
    if (scanScheduled) return;
    scanScheduled = true;
    scanTimerId = setTimeout(() => {
      scanScheduled = false;
      scanTimerId = 0;
      // どの DOM 削除機能も OFF ならスキャン不要
      if (!shelfActive && !chipActive && !sidebarActive) return;
      purgeShortsDom();
    }, 150);
  }

  /**
   * 活性化されたフラグに応じて Shorts 棚 / チップ / サイドバーメニューの DOM を物理削除する。
   * フラグごとに対応するセレクタを集約 → `:is(...)` で 1 回の querySelectorAll に統合する
   * （旧実装と同じく `:has()` ネストが効かない環境向けの個別ループフォールバックを保持）。
   */
  function purgeShortsDom() {
    const sels = [];
    if (shelfActive) sels.push(...YouTubeShorts.SELECTORS_SHELF);
    if (chipActive) sels.push(...YouTubeShorts.SELECTORS_CHIP);
    if (sidebarActive) sels.push(...YouTubeShorts.SELECTORS_SIDEBAR);
    if (sels.length === 0) return;

    try {
      const combined = ":is(" + sels.join(",") + ")";
      const nodes = document.querySelectorAll(combined);
      for (const node of nodes) {
        // チップは text が "Shorts" のものだけ消す（他のチップを巻き込まない）
        if (node.matches("yt-chip-cloud-chip-renderer")) {
          const text = node.querySelector("#text")?.textContent?.trim();
          if (text !== YouTubeShorts.CHIP_LABEL) continue;
        }
        node.remove();
      }
      return;
    } catch {
      // `:is(...)` 内の `:has()` ネストが万一サポートされていない環境向けフォールバック
    }
    for (const selector of sels) {
      try {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
          if (selector.startsWith("yt-chip-cloud-chip-renderer")) {
            const text = node.querySelector("#text")?.textContent?.trim();
            if (text !== YouTubeShorts.CHIP_LABEL) continue;
          }
          node.remove();
        }
      } catch {
        // セレクタ未対応 / 一時的な DOM 解析失敗は無視
      }
    }
  }

  // ---------- /shorts/ URL リダイレクト ----------
  // YouTube は SPA で history.pushState を多用するため popstate / load では捕捉できない。
  // setInterval(1s) で監視する。タブが非アクティブでも YouTube SPA は
  // 動画再生のため動き続けるので throttling の影響は限定的。
  function startUrlRedirectPoll() {
    if (urlPollTimerId !== null) return;
    urlPollTimerId = setInterval(maybeRedirectShortsUrl, YouTubeShorts.URL_POLL_MS);
  }

  function stopUrlRedirectPoll() {
    if (urlPollTimerId === null) return;
    clearInterval(urlPollTimerId);
    urlPollTimerId = null;
  }

  function maybeRedirectShortsUrl() {
    // zombie guard (PATTERN SYNC): setInterval は orphan でも止まらないので 1 回検知で停止
    if (!chrome.runtime?.id) {
      stopUrlRedirectPoll();
      return;
    }
    try {
      const match = location.pathname.match(YouTubeShorts.SHORTS_PATH_RE);
      if (!match) return;
      const videoId = match[1];
      if (!videoId) return;
      // モバイル (m.youtube.com) でもデスクトップ (www.youtube.com) でも /watch?v= は有効。
      // クエリ・ハッシュは Shorts 固有のものは捨てて videoId のみを保持する（再生位置等は失う割切）。
      const newUrl = `${location.origin}/watch?v=${encodeURIComponent(videoId)}`;
      // replace で履歴に Shorts URL を残さない（戻るボタンで Shorts に戻ると無限ループになるため）
      location.replace(newUrl);
    } catch {
      // location アクセスに失敗するケース（about:blank への遷移途中等）は次の tick に任せる
    }
  }
})();
