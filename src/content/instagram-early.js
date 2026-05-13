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

  // -----------------------------------------------------------------
  // (0) URL リダイレクトの document_start 先制実行
  //
  // 通常 reels/explore/stories の URL リダイレクトは instagram-cleaner.js が document_idle で
  // 行うが、Reels ページは Instagram 自身の React bundle が CPU を独占して document_idle が
  // 到達しないケースがある (実機 Edge で確認、Trace で Instagram 本体が 41 秒占有 / 我々の
  // content script は 0.14ms のみ)。その結果、ユーザーが reels リダイレクトを ON にしていても
  // ホームに飛ばされず、タブがフリーズする。
  //
  // document_start で先制 redirect することで、Instagram の重い JS bundle が実行を始める前に
  // location.replace でページを離脱できる。`chrome.storage.local.get` の async 応答 (数 ms) を
  // 待つ必要があるが、document_idle までの待ち (数百 ms 〜 freeze) より遥かに早い。
  //
  // 設計判断:
  //   - `location.replace` を使用 (history に残さない: ユーザーが「戻る」で再度 freeze 経路に
  //     入らないようにする)
  //   - storage 未設定 / catch は何もしない (= 後段の instagram-cleaner.js に任せる)
  //   - actions.js はロードしないので生の storage key string と path 正規表現を直書きする
  //     (instagram-cleaner.js の checkUrlRedirect と同じ regex に揃える)
  // -----------------------------------------------------------------
  const path = location.pathname;
  // ⚠️ MUST SYNC with `src/content/instagram-cleaner.js` checkUrlRedirect (line ~441-443):
  // 同じ regex を使って document_start と document_idle の両経路で同じ URL を判定する。
  // 片方だけ書き換えると「early では redirect されたが cleaner では戻る」など整合性が崩れる。
  const REELS_RE = /^\/reels?(\/|$)/i;
  const EXPLORE_RE = /^\/explore(\/|$)/i;
  const STORIES_RE = /^\/stories(\/|$)/i;
  if (REELS_RE.test(path) || EXPLORE_RE.test(path) || STORIES_RE.test(path)) {
    chrome.storage.local
      .get(["instagramCleanerEnabled", "instagramCleanerFeatures"])
      .then((stored) => {
        if (stored.instagramCleanerEnabled !== true) return;
        const feats = stored.instagramCleanerFeatures;
        if (!feats || typeof feats !== "object") return;
        const shouldRedirect =
          (REELS_RE.test(path) && feats.reels === true) ||
          (EXPLORE_RE.test(path) && feats.explore === true) ||
          (STORIES_RE.test(path) && feats.storiesAll === true);
        if (shouldRedirect) {
          try { location.replace("/"); }
          catch { location.href = "/"; }
        }
      })
      .catch(() => {});
  }

  // サイト固有: MutationObserver で `_a9ym` UL 出現を監視 → その **親 div** に inline 強制 hide。
  // `_a9z6` (外側 UL) には post caption が含まれるため触らない（caption 巻き込み防止）。
  const forceHideParent = (ymUl) => {
    const wrapper = ymUl?.parentElement;
    if (!wrapper || wrapper.getAttribute(FORCE_HIDE_ATTR) === "1") return;
    wrapper.style.setProperty("display", "none", "important");
    wrapper.setAttribute(FORCE_HIDE_ATTR, "1");
  };

  // 既に _a9ym があれば即適用（document_start 時点では普通は無いが念のため）
  document.querySelectorAll("ul._a9ym").forEach(forceHideParent);

  // observer 制御: 旧実装は常時稼働で OFF 時もコールバック先頭で早期 return する設計だったが、
  // Instagram は React で document subtree に対して秒間数十〜数百件の mutation を発火するため、
  // OFF ユーザーでも MO callback が高頻度起動し CPU を浪費する問題があった (/rere レビュー C-#3)。
  // ON/OFF で observe/disconnect を切り替えて、OFF 中はコールバックを完全停止する。
  let observerActive = false;
  const ensureObserverActive = () => {
    if (observerActive) return;
    observer.observe(document, { childList: true, subtree: true });
    observerActive = true;
  };
  const disconnectObserver = () => {
    if (!observerActive) return;
    try { observer.disconnect(); } catch {}
    observerActive = false;
  };

  const observer = new MutationObserver((mutations) => {
    // zombie guard (PATTERN SYNC): orphan content script で observer が永久発火するのを停止
    if (!chrome.runtime?.id) {
      disconnectObserver();
      return;
    }
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
  // framework が pre クラスを同期付与した後の初期状態 (storage 確認前) は observer 稼働。
  // OFF 確定で offRevert が disconnect する。
  ensureObserverActive();

  const offRevert = () => {
    document.documentElement.classList.remove(PRE_CLASS);
    document
      .querySelectorAll("[" + FORCE_HIDE_ATTR + "='1']")
      .forEach((el) => {
        el.style.removeProperty("display");
        el.removeAttribute(FORCE_HIDE_ATTR);
      });
    disconnectObserver();
  };

  const onApply = () => {
    document.documentElement.classList.add(PRE_CLASS);
    ensureObserverActive();
    // 再 ON 時に既存 _a9ym があれば即 force-hide
    document.querySelectorAll("ul._a9ym").forEach(forceHideParent);
  };

  // 共通フレームワーク経由で style 注入 + pre クラス同期付与 + storage 取得 + onChanged 購読
  __cpaEarlyFramework.setup({
    styleId: STYLE_ID,
    cssText:
      "html." + PRE_CLASS + " div:has(> ul._a9ym) { display: none !important; }",
    preClasses: [PRE_CLASS],
    storageKeys: ["instagramCleanerEnabled", "instagramCleanerFeatures"],
    onEvaluate(stored) {
      const enabled = stored.instagramCleanerEnabled === true;
      const commentsOn = !!(
        stored.instagramCleanerFeatures &&
        stored.instagramCleanerFeatures.comments === true
      );
      if (enabled && commentsOn) onApply();
      else offRevert();
    },
  });
})();
