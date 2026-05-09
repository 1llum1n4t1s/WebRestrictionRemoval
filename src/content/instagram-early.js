"use strict";

// ⚠️ 既知のリスク（rere レビュー D-1）: 本ファイルは `ul._a9ym` という Instagram 固有の
// 難読化クラスに依存している。CLAUDE.md 原則「難読化 class 依存を避ける」と矛盾するが、
// document_start で同期実行可能な代替セレクタが現状見つかっていないため許容している。
// `_a9ym` が Instagram のリブランドでリネームされた場合、FOUC 防止の効果が消失して
// 数百 ms コメント欄が見える状態になる（instagram-cleaner.js の triple-gate fallback で
// 最終的には隠れるため機能停止にはならない）。リネームを検知したら以下のいずれかで対応:
//   - 新しいクラス名に追従する（短期）
//   - early の inline force-hide を削除して triple-gate fallback に一本化（中期、FOUC は許容）
//   - aria-label / role / data-pagelet ベースの意味論セレクタを再調査して移行（長期）


/**
 * Instagram コメント欄非表示の document_start 注入。flash 体感ラグ消滅用。
 *
 * 役割: hideComments (= instagramCleanerFeatures.comments) が ON のとき、各コメント UL
 * (`ul._a9ym`) の親 `<div>` を instagram-cleaner.js (document_idle + 300ms ポーリング) が
 * JS マーカーを付けるより前に `display: none` で先制非表示にする。Modal 投稿
 * (フィード/プロフィールから投稿クリックで開く `[role="dialog"]`) + 直接 `/p/` URL アクセス
 * 両方の UL 構造ケースを即時カバー。
 *
 * 重要: `_a9z6`（外側 UL）は **post caption も同居** しているため、これを丸ごと隠すと
 * caption まで巻き込む。代わりに `_a9ym`（per-comment UL）の親 div を `:has(> ul._a9ym)`
 * で識別して隠すことで、caption を残しコメントだけを正確に消す。
 *
 * 仕組み（オプトアウト方式 + 三重ガード）:
 *   1. document_start 同期で `<style>` を `<html>` 直下に prepend
 *      （manifest css の effective 化が SPA 経路で間に合わないケース対策）
 *   2. document_start 同期で `<html>` に `__cpa-ig-comments-pre` を **無条件付与**
 *      （storage.get の async 待ちで comment DOM 出現に間に合わないため）
 *   3. **MutationObserver で `_a9ym` 出現を監視 → その親 `<div>` に即時 inline `style
 *       .setProperty('display', 'none', 'important')` を当てる**（CSS rule との specificity
 *       競合を勝つ最強ガード。Instagram が後から inline style を当てる可能性に備える）
 *      observer は **常時維持** し、pre クラスの有無で動作を guard する。これで storage.onChanged
 *      で hideComments OFF→ON 変更時にも新たな `_a9ym` 出現に追従する。
 *   4. `chrome.storage.local` から `instagramCleanerEnabled` / `instagramCleanerFeatures` を
 *      非同期取得し、master OFF または comments OFF なら pre クラス + 既存 inline force-hide を
 *      剥がす（observer は維持して storage.onChanged 復帰時にも対応）
 *   5. `chrome.storage.onChanged` で master/comments トグル変更時に再評価
 *
 * 設計判断:
 *   - actions.js は **ロードしない**（最速注入のため依存ゼロ、生 storage key string 使用）
 *   - top frame 限定（Instagram 埋め込みは別オリジン iframe で対象外）
 *   - **DIV 構造のコメントレイアウト（一部 post）は安定 class が無いためここではカバー不能**
 *     → instagram-cleaner.js の structural triple-gate detection が fallback として動作
 *   - 同名 class `__cpa-ig-comments` ではなく **専用 pre クラス** を使う理由:
 *     instagram-cleaner.js が `__cpa-ig-comments` を applyBodyClasses 内で
 *     features.comments の真偽値で toggle するため、初期化中の race window で
 *     一瞬剥がされる可能性を回避する
 */

(() => {
  if (window !== window.top) return;
  if (window.__cpaIgEarlyRunning) return;
  window.__cpaIgEarlyRunning = true;

  const PRE_CLASS = "__cpa-ig-comments-pre";
  const STYLE_ID = "__cpa-ig-early-hide-comments";
  const FORCE_HIDE_ATTR = "data-cpa-ig-force-hide";

  // (1) <html> 直下に <style> を同期 prepend する。manifest css 経由の rule に依存せず、
  //     instagram-early.js 実行時点で CSS rule を確実に effective 化する。
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "html." + PRE_CLASS + " div:has(> ul._a9ym) { display: none !important; }";
    document.documentElement.appendChild(style);
  }

  // (2) <html> 同期で先制付与
  document.documentElement.classList.add(PRE_CLASS);

  // (3) MutationObserver で `_a9ym` UL 出現を監視 → その **親 div** に inline 強制 hide。
  //     `_a9z6` (外側 UL) には post caption が含まれるため触らない（caption 巻き込み防止）。
  const forceHideParent = (ymUl) => {
    const wrapper = ymUl?.parentElement;
    if (!wrapper || wrapper.getAttribute(FORCE_HIDE_ATTR) === "1") return;
    wrapper.style.setProperty("display", "none", "important");
    wrapper.setAttribute(FORCE_HIDE_ATTR, "1");
  };

  // 既に _a9ym があれば即適用（document_start 時点では普通は無いが念のため）
  document.querySelectorAll("ul._a9ym").forEach(forceHideParent);

  const observer = new MutationObserver((mutations) => {
    // zombie guard: 拡張機能が更新・無効化された後も古い content script の observer は
    // 残り続けて mutation を受信する。chrome.runtime?.id が undefined になったら
    // 即 disconnect して以降のコールバック呼び出しコストをゼロにする（rere レビュー D-6）。
    if (!chrome.runtime?.id) {
      try { observer.disconnect(); } catch {}
      return;
    }
    // pre クラスがない (= 機能 OFF) なら何もしない。
    // observer 自体は disconnect せず常時動かして、storage.onChanged で hideComments
    // が再 ON になったタイミングからすぐ機能できるようにする。
    if (!document.documentElement.classList.contains(PRE_CLASS)) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "UL" && node.classList.contains("_a9ym")) {
          forceHideParent(node);
        } else if (node.querySelector) {
          node.querySelectorAll("ul._a9ym").forEach(forceHideParent);
        }
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  // (4)(5) storage 確認 + onChanged で再評価
  const offRevert = () => {
    document.documentElement.classList.remove(PRE_CLASS);
    document
      .querySelectorAll("[" + FORCE_HIDE_ATTR + "='1']")
      .forEach((el) => {
        el.style.removeProperty("display");
        el.removeAttribute(FORCE_HIDE_ATTR);
      });
  };

  const onApply = () => {
    document.documentElement.classList.add(PRE_CLASS);
    // 再 ON 時に既存 _a9ym があれば即 force-hide
    document.querySelectorAll("ul._a9ym").forEach(forceHideParent);
  };

  const evalSettings = (stored) => {
    const enabled = stored.instagramCleanerEnabled === true;
    const commentsOn = !!(
      stored.instagramCleanerFeatures &&
      stored.instagramCleanerFeatures.comments === true
    );
    if (enabled && commentsOn) onApply();
    else offRevert();
  };

  chrome.storage.local
    .get(["instagramCleanerEnabled", "instagramCleanerFeatures"])
    .then(evalSettings)
    .catch(offRevert);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (
      !("instagramCleanerEnabled" in changes) &&
      !("instagramCleanerFeatures" in changes)
    ) {
      return;
    }
    chrome.storage.local
      .get(["instagramCleanerEnabled", "instagramCleanerFeatures"])
      .then(evalSettings)
      .catch(offRevert);
  });
})();
