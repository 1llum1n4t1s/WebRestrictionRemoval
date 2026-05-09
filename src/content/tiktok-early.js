"use strict";

/**
 * TikTok クリーナーの document_start 注入。flash 体感ラグ消滅用。
 *
 * 役割: tiktokCleanerEnabled (master) + tiktokCleanerFeatures (オブジェクト) の保存値に応じて、
 * tiktok-cleaner.js (document_idle) が走る前に `<html>` へ pre クラスを **同期で付与**して、
 * 主要な data-e2e セレクタを `<style>` inline rule で即時非表示化する。
 *
 * 仕組み（オプトアウト方式 + 三重ガード）:
 *   1. document_start 同期で `<style>` を `<html>` 直下に prepend
 *      （manifest css の effective 化が SPA 経路で間に合わないケース対策）
 *   2. document_start 同期で `<html>` に **両 pre クラスを無条件付与**
 *      （storage.get の async 待ちで DOM 出現に間に合わないため）
 *   3. `chrome.storage.local` から非同期取得し、master OFF または該当 feature OFF なら剥がす
 *   4. `chrome.storage.onChanged` で master/features 変更時に再評価
 *
 * 設計判断:
 *   - actions.js は **ロードしない**（最速注入のため依存ゼロ、生 storage key string 使用）
 *   - top frame 限定（TikTok の埋め込みは別オリジン iframe で対象外）
 *   - 同期 inline rule は **最頻出の data-e2e セレクタのみ** をカバー（保険を増やすと早期 paint
 *     を遅延させるため最小限）
 */

(() => {
  if (window !== window.top) return;
  if (window.__cpaTtEarlyRunning) return;
  window.__cpaTtEarlyRunning = true;

  const PRE_HIDE_COMMENTS = "__cpa-tt-comments";
  const PRE_HIDE_SUGGESTED = "__cpa-tt-suggested";
  const STYLE_ID = "__cpa-tt-early-style";

  // (1) <style> 同期注入 — manifest css の effective 化保険として中核セレクタを焼き込む。
  //     photo / video ページの右側統合パネル（コメント + あなたにおすすめタブ同居）を最優先で
  //     消し、加えて動画 UI 上のコメントアイコンや件数バッジ等を補助的に消す。
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      'html.' + PRE_HIDE_COMMENTS + ' [class*="RightPanelContainer"],' +
      'html.' + PRE_HIDE_SUGGESTED + ' [class*="RightPanelContainer"]' +
      '{display:none!important;}' +
      'html.' + PRE_HIDE_COMMENTS + ' [class*="DivCommentListContainer"]' +
      '{display:none!important;}' +
      'html.' + PRE_HIDE_COMMENTS + ' [data-e2e="comment-icon"],' +
      'html.' + PRE_HIDE_COMMENTS + ' [data-e2e="browse-comment-icon"],' +
      'html.' + PRE_HIDE_COMMENTS + ' [data-e2e="feed-comment-icon"],' +
      'html.' + PRE_HIDE_COMMENTS + ' [data-e2e="comment-count"],' +
      'html.' + PRE_HIDE_COMMENTS + ' [data-e2e="browse-comment-count"]' +
      '{display:none!important;}' +
      'html.' + PRE_HIDE_SUGGESTED + ' [data-e2e="recommend-account-card"],' +
      'html.' + PRE_HIDE_SUGGESTED + ' [data-e2e="suggested-account-card"],' +
      'html.' + PRE_HIDE_SUGGESTED + ' [data-e2e="suggest-card"],' +
      'html.' + PRE_HIDE_SUGGESTED + ' [data-e2e="recommend-list"]' +
      '{display:none!important;}';
    document.documentElement.appendChild(style);
  }

  // (2) 同期で pre クラス付与（オプトアウト方式: storage 読み出し前に付けて async 待ちの flash 防止）
  document.documentElement.classList.add(PRE_HIDE_COMMENTS);
  document.documentElement.classList.add(PRE_HIDE_SUGGESTED);

  // (3) storage 確認 + onChanged 監視
  const FEATURE_TO_CLASS = {
    hideComments: PRE_HIDE_COMMENTS,
    hideSuggested: PRE_HIDE_SUGGESTED,
  };

  const evalSettings = (stored) => {
    const enabled = stored.tiktokCleanerEnabled === true;
    const features = (stored.tiktokCleanerFeatures && typeof stored.tiktokCleanerFeatures === "object")
      ? stored.tiktokCleanerFeatures
      : {};
    for (const [key, cls] of Object.entries(FEATURE_TO_CLASS)) {
      if (enabled && features[key] === true) {
        document.documentElement.classList.add(cls);
      } else {
        document.documentElement.classList.remove(cls);
      }
    }
  };

  const stripAll = () => {
    for (const cls of Object.values(FEATURE_TO_CLASS)) {
      document.documentElement.classList.remove(cls);
    }
  };

  chrome.storage.local
    .get(["tiktokCleanerEnabled", "tiktokCleanerFeatures"])
    .then(evalSettings)
    .catch(stripAll);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (
      !("tiktokCleanerEnabled" in changes) &&
      !("tiktokCleanerFeatures" in changes)
    ) {
      return;
    }
    chrome.storage.local
      .get(["tiktokCleanerEnabled", "tiktokCleanerFeatures"])
      .then(evalSettings)
      .catch(stripAll);
  });
})();
