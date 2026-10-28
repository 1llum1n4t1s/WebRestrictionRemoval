"use strict";

/**
 * YouTube watch / live ページ向け document_start 注入の最小スクリプト（ライブチャット欄 先制非表示）。
 *
 * 役割: hideLiveChat が ON のとき、ライブチャット枠 (`ytd-live-chat-frame`) を
 * search-fixer.js (document_idle) が close button を click するより前に
 * `display: none` + `visibility: hidden` で先制非表示にする。
 *
 * 対象ページ: `/watch` 直アクセス + `/@channel/live` 等の `/live` URL 直アクセス
 *   （search-fixer.js の isWatchPage と揃える。/live URL は YouTube が pathname を /watch に
 *    書き換えないことがあり、旧実装の `/watch` のみ判定だと /live 直アクセスで先制非表示が
 *    丸ごとスキップされ frame が丸見えになっていた。/rere B2-2）。
 *   SPA 遷移は search-fixer.js の onNavigationStart / syncLiveChatCollapse が担当する。
 *
 * 仕組み（オプトイン方式 + observer ON/OFF 制御 + orphan guard）:
 *   1. document_start 同期で `<style>` を `<html>` 直下に prepend
 *      （manifest css の effective 化が SPA 経路で間に合わないケース対策）
 *   2. storage から master と hideLiveChat が明示的に ON と判明してから pre クラスを付与。
 *      設定読取前の FOUC は許容し、未選択ユーザーのサイト表示を変えない。
 *   3. ON 時のみ MutationObserver で frame DOM 追加を監視 → 即時 inline で `display:none !important`
 *       + `visibility:hidden !important` を当てる**（最強ガード）。
 *   4. **observer は ON/OFF で observe/disconnect を切り替える**（instagram-early.js と同型、
 *       /rere B1-A2）。旧実装は常時稼働 + 早期 return だったが、YouTube watch も SPA で高頻度
 *       mutation を発火するため OFF ユーザーでも callback が高頻度起動し CPU を浪費していた。
 *       OFF 確定で `disconnectObserver()` し callback を完全停止する。
 *   5. **callback 冒頭に orphan guard (`chrome.runtime?.id`)**（/rere F-1 / PATTERN SYNC）。
 *       拡張 reload で orphan 化した observer の永久発火を `disconnect()` で止める。
 *   6. master OFF / hideLiveChat OFF または設定取得失敗なら
 *       pre クラス + inline force-hide を剥がし observer も止める。
 *
 * 設計判断:
 *   - actions.js は **ロードしない**（最速注入のため依存ゼロ、生 storage key string 使用）。
 *   - **inline で display:none + visibility:hidden を併用する理由**: YouTube が SPA 遷移で
 *     frame を再利用し `style="display:flex"` を inline で当てた 1 フレーム、CSS class の
 *     display:none は inline に負ける。YouTube は expand 時に visibility は触らないため、
 *     visibility:hidden は子孫 (iframe = コメント本体) に継承されて勝ち、コメントの一瞬チラ見えを
 *     防ぐ（CSS class 側 visibility との二重防御。/rere B1-A1 の非対称解消）。
 *   - pre クラス / inline force-hide の **剥がし** は search-fixer.js の click 成功経路
 *     (`clearLiveChatPreHide`) も担う。early 側は OFF / orphan 時に剥がす。
 *   - top frame 限定（埋め込みプレーヤーには不要）。
 */

(() => {
  if (window !== window.top) return;
  if (window.__cpaYtEarlyRunning) return;
  window.__cpaYtEarlyRunning = true;
  // /watch 直アクセス + /live URL 直アクセスのみ対象（search-fixer.js isWatchPage と揃える）。
  const path = location.pathname;
  if (!path.startsWith("/watch") && !path.endsWith("/live")) return;

  const PRE_CLASS = "__cpa-sfx-hide-live-chat-pre";
  const FORCE_HIDE_ATTR = "data-cpa-force-hide";
  const originalStyles = new Map();

  // frame に inline で display:none + visibility:hidden を当てる最強ガード。
  // visibility も併せることで、YouTube が inline display を上書きした 1 フレームでも
  // 子孫 (iframe = コメント本体) を visibility 継承で隠せる。
  const forceHide = (frame) => {
    if (!frame || frame.getAttribute(FORCE_HIDE_ATTR) === "1") return;
    originalStyles.set(frame, ["display", "visibility"].map((name) => ({
      name, value: frame.style.getPropertyValue(name), priority: frame.style.getPropertyPriority(name),
    })));
    frame.style.setProperty("display", "none", "important");
    frame.style.setProperty("visibility", "hidden", "important");
    frame.setAttribute(FORCE_HIDE_ATTR, "1");
  };

  window.__cpaRestoreLiveChatFrame = (frame) => {
    const original = originalStyles.get(frame);
    for (const { name, value, priority } of original || []) {
      const applied = name === "display" ? "none" : "hidden";
      if (frame.style.getPropertyValue(name) !== applied || frame.style.getPropertyPriority(name) !== "important") continue;
      if (value) frame.style.setProperty(name, value, priority);
      else frame.style.removeProperty(name);
    }
    originalStyles.delete(frame);
    frame.removeAttribute(FORCE_HIDE_ATTR);
  };
  window.__cpaRestoreAllLiveChatFrames = () => {
    for (const frame of originalStyles.keys()) window.__cpaRestoreLiveChatFrame(frame);
  };

  const forceHideAll = () => {
    document.querySelectorAll("ytd-live-chat-frame").forEach(forceHide);
  };

  // observer 制御: instagram-early.js と同型（/rere B1-A2）。ON/OFF で observe/disconnect を
  // 切り替え、OFF 中は callback を完全停止して OFF ユーザーの CPU 浪費を避ける。
  let observerActive = false;
  const ensureObserverActive = () => {
    if (observerActive) return;
    frameObserver.observe(document, { childList: true, subtree: true });
    observerActive = true;
  };
  const disconnectObserver = () => {
    if (!observerActive) return;
    try { frameObserver.disconnect(); } catch {}
    observerActive = false;
  };

  const frameObserver = new MutationObserver((mutations) => {
    // orphan guard (PATTERN SYNC / rere F-1): 拡張 reload で orphan 化した observer の
    // 永久発火を停止する。
    if (!chrome.runtime?.id) {
      offRevert();
      return;
    }
    const hiding = document.documentElement.classList.contains(PRE_CLASS);
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "YTD-LIVE-CHAT-FRAME") {
          if (hiding) forceHide(node);
          else if (node.getAttribute(FORCE_HIDE_ATTR) === "1") window.__cpaRestoreLiveChatFrame(node);
        } else if (node.querySelector) {
          node.querySelectorAll("ytd-live-chat-frame").forEach((frame) => {
            if (hiding) forceHide(frame);
            else if (frame.getAttribute(FORCE_HIDE_ATTR) === "1") window.__cpaRestoreLiveChatFrame(frame);
          });
        }
      }
    }
  });

  const offRevert = () => {
    window.__cpaLiveChatCollapseHandled = false;
    document.documentElement.classList.remove(PRE_CLASS);
    window.__cpaRestoreAllLiveChatFrames();
    document
      .querySelectorAll("ytd-live-chat-frame[" + FORCE_HIDE_ATTR + "='1']")
      .forEach(window.__cpaRestoreLiveChatFrame);
    disconnectObserver();
  };

  const onApply = () => {
    ensureObserverActive();
    if (window.__cpaLiveChatCollapseHandled) return;
    document.documentElement.classList.add(PRE_CLASS);
    forceHideAll();
  };

  // ON 確定までは非表示にしない。同じ ON の再評価で手動再表示を妨げない。
  let lastEnabled = false;
  __cpaEarlyFramework.setup({
    styleId: "__cpa-sfx-early-hide-live-chat",
    cssText:
      "html." + PRE_CLASS +
      " ytd-live-chat-frame { display: none !important; visibility: hidden !important; }",
    preClasses: [PRE_CLASS],
    storageKeys: ["searchFixerEnabled", "searchFixerFeatures"],
    onEvaluate(stored) {
      const enabled = stored.searchFixerEnabled === true;
      const hideLiveChat = !!(
        stored.searchFixerFeatures &&
        stored.searchFixerFeatures.hideLiveChat === true
      );
      const shouldHide = enabled && hideLiveChat;
      if (shouldHide === lastEnabled) return;
      lastEnabled = shouldHide;
      if (shouldHide) onApply();
      else offRevert();
    },
  });
})();
