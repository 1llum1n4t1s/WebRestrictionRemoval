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
  // 設定購読 3 経路 (初期 get / onMessage / onChanged 部分更新) は CleanerCore に集約。
  // active / features の保持と applyBodyClasses は本 cs に残す (最小責務分離)。
  CleanerCore.subscribe({
    masterKey: StorageKeys.TIKTOK_CLEANER_ENABLED,
    featuresKey: StorageKeys.TIKTOK_CLEANER_FEATURES,
    applyAction: Actions.APPLY_TIKTOK_CLEANER_CS,
    mergeFeatures: (raw) => TikTokCleaner.mergeFeatures(raw),
    onUpdate: (patch) => {
      if ("active" in patch) active = patch.active;
      if ("features" in patch) features = patch.features;
      onSettingsChanged();
    },
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
