"use strict";

// 仕様上の制限（rere レビュー B1 1-A）: 本スクリプトは初期ロード時に `/watch` 以外の
// パスでは frameObserver を起動しない（45 行目の location.pathname.startsWith("/watch") guard）。
// SPA ナビゲーションで `/watch` に遷移した場合、early スクリプトは既に return 済みのため
// frameObserver は存在しない。ただし以下 2 経路で補完されるため実害は限定的:
//   1. search-fixer.js (document_idle) が yt-navigate-start hook で `__cpa-sfx-hide-live-chat-pre`
//      クラスを SPA 遷移時に先制付与する
//   2. search-fixer.js の syncLiveChatCollapse + scheduleLiveChatCollapseRetry で iframe 出現時に
//      公式折りたたみ click を発火する
// 「completely OFF → SPA 遷移 → ON 切替」のシナリオでは早期 return が事故源になる可能性があるが、
// storage.onChanged 追従（末尾）+ search-fixer.js のフォールバック観測で実体感は許容範囲。


/**
 * YouTube watch ページ向け document_start 注入の最小スクリプト。
 *
 * 役割: hideLiveChat が ON のとき、ライブチャット枠 (`ytd-live-chat-frame`) を
 * search-fixer.js (document_idle) が close button を click するより前に
 * `display: none` で先制非表示にする。
 *
 * 仕組み（オプトアウト方式 + 三重ガード）:
 *   1. document_start 同期で `<style>` を `<html>` 直下に prepend
 *      （manifest css の effective 化が SPA 経路で間に合わないケース対策）
 *   2. document_start 同期で `<html>` に `__cpa-sfx-hide-live-chat-pre` を **無条件付与**
 *      （storage.get の async 待ちで frame 出現に間に合わないため）
 *   3. **MutationObserver で frame DOM 追加を監視 → 即時 inline `style.setProperty(
 *       'display', 'none', 'important')` を当てる**（Edge で frame DOM 追加直後の
 *       極短時間に「完全展開されたチャット枠」が見える現象が報告されたため、
 *       inline style with !important で specificity 競合を完全に勝つ最強ガード）
 *      observer は **常時維持** し、pre クラスの有無で動作を guard する。これで SPA
 *      遷移時の再 add 経路 (onNavigationStart) でも新 frame に force-hide が当たる。
 *   4. `chrome.storage.local` から `searchFixerEnabled` / `searchFixerFeatures` を非同期取得
 *   5. master OFF または hideLiveChat OFF なら pre クラス剥がし + 既存 frame の inline
 *      force-hide を剥がす (observer は維持して storage.onChanged 復帰時にも対応)
 *   6. ON なら pre クラス + observer 維持、search-fixer.js の click 成功時に pre クラス +
 *      inline force-hide を剥がす (observer は維持) → YouTube 公式 collapsed bar 表示
 *
 * 設計判断:
 *   - actions.js は **ロードしない**（最速注入のため依存ゼロ）。
 *   - **inline `setProperty('display', 'none', 'important')` の理由**: CSS rule
 *     (`!important` 付き) でも YouTube が `style="display: flex"` を inline で当てた
 *     瞬間に specificity で負ける可能性がある (CSS specificity 上、inline style
 *     without !important は class-based with !important に負けるが、inline style
 *     with !important なら勝つ)。即時 inline `setProperty` で author origin の最高
 *     specificity を確保し、どんな competing style にも勝つ。
 *   - **observer 常時維持の理由**: SPA 遷移 (onNavigationStart で pre クラス再付与) や
 *     storage.onChanged で hideLiveChat OFF→ON 変更時に、新たな frame DOM 追加に対して
 *     再度 force-hide を当てる必要がある。observer のオーバーヘッドは小さいので常時 ON。
 *   - top frame 限定（埋め込みプレーヤーには不要）。
 */

(() => {
  if (window !== window.top) return;
  if (window.__cpaYtEarlyRunning) return;
  window.__cpaYtEarlyRunning = true;
  if (!location.pathname.startsWith("/watch")) return;

  const PRE_CLASS = "__cpa-sfx-hide-live-chat-pre";
  const FORCE_HIDE_ATTR = "data-cpa-force-hide";

  // サイト固有: MutationObserver で frame DOM 追加を監視し、inline !important で強制 hide。
  // **inline `setProperty('display', 'none', 'important')` の理由**: CSS rule (`!important` 付き) でも
  // YouTube が `style="display: flex"` を inline で当てた瞬間に specificity で負ける可能性がある。
  // inline style with !important なら author origin の最高 specificity を確保し、競合 style に勝つ。
  const forceHide = (frame) => {
    if (!frame || frame.getAttribute(FORCE_HIDE_ATTR) === "1") return;
    frame.style.setProperty("display", "none", "important");
    frame.setAttribute(FORCE_HIDE_ATTR, "1");
  };

  // 既に frame があれば即適用
  document.querySelectorAll("ytd-live-chat-frame").forEach(forceHide);

  // observer は常時維持し、pre クラスの有無で動作 guard。
  const frameObserver = new MutationObserver((mutations) => {
    if (!document.documentElement.classList.contains(PRE_CLASS)) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "YTD-LIVE-CHAT-FRAME") {
          forceHide(node);
        } else if (node.querySelector) {
          const nested = node.querySelector("ytd-live-chat-frame");
          if (nested) forceHide(nested);
        }
      }
    }
  });
  frameObserver.observe(document, { childList: true, subtree: true });

  function offRevert() {
    document.documentElement.classList.remove(PRE_CLASS);
    document
      .querySelectorAll("ytd-live-chat-frame[" + FORCE_HIDE_ATTR + "='1']")
      .forEach((el) => {
        el.style.removeProperty("display");
        el.removeAttribute(FORCE_HIDE_ATTR);
      });
  }

  // 共通フレームワーク経由で style 注入 + pre クラス同期付与 + storage 取得 + onChanged 購読
  __cpaEarlyFramework.setup({
    styleId: "__cpa-sfx-early-hide-live-chat",
    cssText:
      "html." + PRE_CLASS + " ytd-live-chat-frame { display: none !important; }",
    preClasses: [PRE_CLASS],
    storageKeys: ["searchFixerEnabled", "searchFixerFeatures"],
    onEvaluate(stored) {
      const enabled = stored.searchFixerEnabled === true;
      const hideLiveChat = !!(
        stored.searchFixerFeatures &&
        stored.searchFixerFeatures.hideLiveChat === true
      );
      if (enabled && hideLiveChat) return;
      offRevert();
    },
  });
})();
