"use strict";

/**
 * X（旧 Twitter）クリーナーの document_start 注入。flash 体感ラグ消滅用。
 *
 * 役割: `xCleanerEnabled` (master) + `xCleanerFeatures` (オブジェクト) の保存値に応じて、
 * x-cleaner.js (document_idle) が走る前に `<html>` へクラスを **同期で付与**し、
 * レイアウト系セレクタを `<style>` inline rule で即時非表示化する。
 *
 * 仕組み（オプトアウト方式）— tiktok-early.js と同型:
 *   1. document_start 同期で `<style>` を `<html>` 直下に prepend
 *   2. document_start 同期でクラスを **無条件付与**（storage.get の async 待ちに間に合わせるため）
 *   3. `chrome.storage.local` から非同期取得し、master OFF / feature OFF なら剥がす
 *   4. `chrome.storage.onChanged` で再評価
 *
 * 設計判断:
 *   - actions.js は **ロードしない**（最速注入のため依存ゼロ、生 storage key string 使用）
 *   - 焼き込むのは**レイアウトが動く 3 つだけ**（右ペイン / トレンド / おすすめユーザー）。
 *     広告・カウンタ・Grok はレイアウトを押し広げないので manifest css の到達で十分間に合い、
 *     早期 paint を無駄に遅らせない
 *   - top frame 限定
 */

(() => {
  if (window !== window.top) return;
  if (window.__cpaXEarlyRunning) return;
  window.__cpaXEarlyRunning = true;

  const CLS_RIGHT_PANE = "__cpa-x-right-pane";
  const CLS_TRENDS = "__cpa-x-trends";
  const CLS_WHO_TO_FOLLOW = "__cpa-x-who-to-follow";

  const FEATURE_TO_CLASS = {
    hideRightPane: CLS_RIGHT_PANE,
    hideTrends: CLS_TRENDS,
    hideWhoToFollow: CLS_WHO_TO_FOLLOW,
  };

  // x-cleaner.css と同じ構造マッチ（data-testid + :has()）。文言に依存しない。
  const CSS_TEXT =
    "html." + CLS_RIGHT_PANE + ' [data-testid="sidebarColumn"]{display:none!important;}' +
    // 右ペインを消したぶんタイムラインを広げる分も早期に当てる（幅が後から変わるとガタつくため）
    "html." + CLS_RIGHT_PANE + ' [data-testid="primaryColumn"]' +
    "{max-width:none!important;width:100%!important;}" +
    "html." + CLS_RIGHT_PANE + ' [data-testid="primaryColumn"] div:has(> section)' +
    "{max-width:none!important;}" +
    "html." + CLS_TRENDS + ' [data-testid="sidebarColumn"] section:has([data-testid="trend"]),' +
    "html." + CLS_TRENDS + ' [data-testid="sidebarColumn"] [data-testid="news_sidebar"]' +
    "{display:none!important;}" +
    "html." + CLS_WHO_TO_FOLLOW + ' [data-testid="sidebarColumn"] aside:has([data-testid="UserCell"])' +
    "{display:none!important;}";

  __cpaEarlyFramework.setup({
    styleId: "__cpa-x-early-style",
    cssText: CSS_TEXT,
    preClasses: [CLS_RIGHT_PANE, CLS_TRENDS, CLS_WHO_TO_FOLLOW],
    storageKeys: ["xCleanerEnabled", "xCleanerFeatures"],
    onEvaluate(stored) {
      const enabled = stored.xCleanerEnabled === true;
      const features =
        stored.xCleanerFeatures && typeof stored.xCleanerFeatures === "object"
          ? stored.xCleanerFeatures
          : {};
      for (const [key, cls] of Object.entries(FEATURE_TO_CLASS)) {
        if (enabled && features[key] === true) {
          document.documentElement.classList.add(cls);
        } else {
          document.documentElement.classList.remove(cls);
        }
      }
    },
  });
})();
