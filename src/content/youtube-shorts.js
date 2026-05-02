"use strict";

/**
 * YouTube Shorts 削除 content script。
 *
 * メインの「制限解除」トグルと独立にオプトインで動作（デフォルト OFF）。
 * 元拡張機能 "Remove YouTube Shorts" の DOM 削除ロジックを再実装したもので、
 * 外部送信・テレメトリ・localStorage は一切持たない。設定は chrome.storage.local のみ。
 *
 * 役割:
 *   - chrome.storage.local の YT_SHORTS_REMOVAL_ENABLED を購読し、
 *     有効化時は MutationObserver で Shorts 関連 DOM を物理削除
 *   - /shorts/<videoId> URL を /watch?v=<videoId> へ書き換え（SPA 遷移対策で polling）
 *   - 無効化時は observer / interval を確実に停止し DOM 副作用を残さない
 *
 * 設計判断:
 *   - メイン content.js とは別ファイル: youtube.com 専用ロジックを汎用 content から分離。
 *     manifest.json の content_scripts も別エントリで matches を youtube.com に限定する。
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
  let cssClassApplied = false;

  // 適用フラグの単一情報源。purge() が二重に走るのを防ぐ。
  let active = false;

  // ---------- 初期化: 現在状態を読んで適用 ----------
  chrome.storage.local.get(StorageKeys.YT_SHORTS_REMOVAL_ENABLED).then((stored) => {
    apply(stored[StorageKeys.YT_SHORTS_REMOVAL_ENABLED] === true);
  }).catch(() => {});

  // ---------- 状態追従 ----------
  // popup → background → content の APPLY_YT_SHORTS_CS 経路と、
  // storage.onChanged の 2 経路で同期する（メイン content.js と同じ二重購読方針）。
  chrome.runtime.onMessage.addListener((request, sender) => {
    // background SW 由来のみ受け付ける。他 content script の XSS 経由や popup から
    // 直接呼ばれるとユーザー設定をバイパスして state を書き換えられるため必須。
    if (!SenderCheck.isFromBackground(sender)) return;
    if (request?.action === Actions.APPLY_YT_SHORTS_CS) {
      apply(request.data?.enabled === true);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (StorageKeys.YT_SHORTS_REMOVAL_ENABLED in changes) {
      apply(changes[StorageKeys.YT_SHORTS_REMOVAL_ENABLED].newValue === true);
    }
  });

  /**
   * 有効/無効を反映する。
   * - true: CSS クラス付与 + MutationObserver 起動 + URL polling 開始 + 即時 1 回 purge
   * - false: 全リソース停止（CSS クラスは外す）。DOM から削除済みの要素は復元できないが
   *   YouTube SPA はナビゲーション時に DOM を再構築するため次の遷移で復活する
   */
  function apply(enabled) {
    if (enabled === active) return;
    active = enabled;

    if (enabled) {
      // CSS は html 要素にクラス付与で有効化（content.css 側でセレクタ展開）。
      // body 単位だと SPA の root 切り替えで外れるリスクがあるため html を選ぶ。
      document.documentElement.classList.add("__cpa-yt-shorts-hidden");
      cssClassApplied = true;

      startObserver();
      startUrlRedirectPoll();
      // 初回は observer 登録前に既存 DOM をスキャン（mutation 通知は新規追加のみ拾うため）
      purgeShortsDom();
      maybeRedirectShortsUrl();
    } else {
      stopObserver();
      stopUrlRedirectPoll();
      if (cssClassApplied) {
        document.documentElement.classList.remove("__cpa-yt-shorts-hidden");
        cssClassApplied = false;
      }
    }
  }

  // ---------- DOM 削除 ----------
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      // mutations の中身は問わず全 DOM をスキャン: YouTube は子孫構造を頻繁に差し替えるため
      // mutation 単位で局所スキャンするより全 querySelectorAll の方がシンプルかつ取りこぼしが少ない。
      // 大量変更が連続したときの負荷を避けるため microtask で 1 フレーム coalesce する。
      scheduleScan();
    });
    // body が無い段階（document_start 注入を将来選ぶケース）に備えるが、
    // manifest の run_at は document_idle なので基本 body は揃っている。
    const root = document.body || document.documentElement;
    if (!root) return;
    observer.observe(root, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    queueMicrotask(() => {
      scanScheduled = false;
      if (!active) return;
      purgeShortsDom();
    });
  }

  function purgeShortsDom() {
    for (const selector of YouTubeShorts.SELECTORS_REMOVE) {
      // `:has()` 非対応バージョンでは querySelectorAll が SyntaxError になりうるため try で囲う。
      // 1 セレクタの失敗で他のセレクタも失敗扱いにしないよう、ループ内で個別に握り潰す。
      try {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
          // チップは text が "Shorts" のものだけ消す（他のチップを巻き込まない）
          if (selector.startsWith('yt-chip-cloud-chip-renderer')) {
            const text = node.querySelector('#text')?.textContent?.trim();
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
  // 元拡張と同じく setInterval(1s) で監視する。タブが非アクティブでも YouTube SPA は
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
