"use strict";

/**
 * TikTok クリーナー content script（独自実装）。
 *
 * 設定は `chrome.storage.local` の `tiktokCleanerEnabled` (master) と
 * `tiktokCleanerFeatures` (オブジェクト) の 2 キーで管理する。
 *
 * 役割:
 *   - master + features に応じて document.documentElement にクラスを付け外しし、CSS 側の表示制御を駆動
 *
 * 設計方針:
 *   - 隠蔽セレクタは `data-e2e` / `aria-label` など TikTok が公開している意味論的属性のみで構成
 *     （難読化 class への依存を排除）
 *   - master OFF 時は body クラスを全部剥がして元の TikTok UI に戻す
 *   - Instagram のような構造的 DOM detection (vanity / comments structural triple-gate) は
 *     現状の機能セット (hideComments + hideSuggested) では不要で、CSS rule のみで完結する
 */

(() => {
  if (window.__cpaTikTokCleanerRunning) return;
  window.__cpaTikTokCleanerRunning = true;
  if (window !== window.top) return;

  /** @type {boolean} master トグル */
  let active = false;
  /** @type {Record<string, boolean>} 個別機能フラグ（定数定義からマージ済み） */
  let features = TikTokCleaner.mergeFeatures({});

  // master が false ならすべて false 扱い。
  const f = (key) => active && features[key] === true;

  // ---------- 状態購読 ----------
  chrome.storage.local
    .get([StorageKeys.TIKTOK_CLEANER_ENABLED, StorageKeys.TIKTOK_CLEANER_FEATURES])
    .then((stored) => {
      active = stored[StorageKeys.TIKTOK_CLEANER_ENABLED] === true;
      features = TikTokCleaner.mergeFeatures(stored[StorageKeys.TIKTOK_CLEANER_FEATURES]);
      onSettingsChanged();
    })
    .catch(() => {});

  chrome.runtime.onMessage.addListener((request, sender) => {
    if (!SenderCheck.isFromBackground(sender)) return;
    if (request?.action !== Actions.APPLY_TIKTOK_CLEANER_CS) return;
    const data = request.data ?? {};
    active = data.enabled === true;
    features = TikTokCleaner.mergeFeatures(data.features);
    onSettingsChanged();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    let touched = false;
    if (StorageKeys.TIKTOK_CLEANER_ENABLED in changes) {
      active = changes[StorageKeys.TIKTOK_CLEANER_ENABLED].newValue === true;
      touched = true;
    }
    if (StorageKeys.TIKTOK_CLEANER_FEATURES in changes) {
      features = TikTokCleaner.mergeFeatures(
        changes[StorageKeys.TIKTOK_CLEANER_FEATURES].newValue
      );
      touched = true;
    }
    if (touched) onSettingsChanged();
  });

  // ---------- 設定変更ディスパッチャ ----------
  function onSettingsChanged() {
    applyBodyClasses();
  }

  /** 各機能フラグに応じて document.documentElement にクラスを付け外し。 */
  function applyBodyClasses() {
    // zombie guard (/rere レビュー B1-D3 / D-4 横展開 PATTERN SYNC):
    // orphan content script では chrome listener が発火停止するが、何らかの理由で遅延発火した
    // 場合に body class を確実に剥がして UI 状態を素に戻す保険。
    if (!chrome.runtime?.id) {
      active = false;
    }
    const root = document.documentElement;
    if (!root) return;
    for (const [key, className] of Object.entries(TikTokCleaner.BODY_CLASS)) {
      root.classList.toggle(className, f(key));
    }
  }
})();
