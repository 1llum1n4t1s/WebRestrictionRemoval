"use strict";

/**
 * X（旧 Twitter）クリーナー content script（独自実装）。
 *
 * 設定は `chrome.storage.local` の `xCleanerEnabled` (master) と `xCleanerFeatures`
 * (オブジェクト) の 2 キーで管理する。TikTok クリーナーと同じ body クラス駆動 CSS が基本で、
 * 唯一 `followingTabDefault` だけ DOM 操作（タブのクリック）が要る。
 *
 * 役割:
 *   - master + features に応じて `<html>` にクラスを付け外しし、CSS 側の表示制御を駆動
 *   - followingTabDefault ON のとき、ホームで「おすすめ」が選ばれていたら「フォロー中」へ切り替える
 *
 * 設計方針:
 *   - セレクタは `data-testid` + `:has()` の**構造マッチのみ**。X の `aria-label` は UI 言語で
 *     ローカライズされる（実機で「トレンド」「プレミアムプラスにアップグレード」を確認）ため、
 *     文言に依存すると日本語環境でしか動かない
 *   - master OFF 時は body クラスを全部剥がして元の X UI に戻す
 *   - タブ切替は**ユーザー操作と競合させない**: ホームで、かつ「おすすめ」が選択中のときだけ、
 *     1 回のページ表示につき 1 回だけクリックする。ユーザーが自分で「おすすめ」に戻したら
 *     （＝こちらのクリック後の選択変更）二度と介入しない
 */

(() => {
  if (window.__cpaXCleanerRunning) return;
  window.__cpaXCleanerRunning = true;
  if (window !== window.top) return;

  /** @type {boolean} master トグル */
  let active = false;
  /** @type {Record<string, boolean>} 個別機能フラグ（定数定義からマージ済み） */
  let features = XCleaner.mergeFeatures({});

  /** SPA 遷移ごとに 1 回だけタブ切替を試すためのキー（現在の pathname + 試行済みフラグ） */
  let tabSwitchPath = null;
  let tabSwitchDone = false;
  /** @type {MutationObserver | null} タブ描画待ちの observer（followingTabDefault ON のときだけ張る） */
  let observer = null;
  /** @type {number | null} rAF coalesce 用 */
  let scanRaf = null;
  /** @type {number | null} rAF が発火しない環境（バックグラウンドタブ）用のフォールバックタイマー */
  let scanTimer = null;
  /** バックグラウンドタブでも走査を保証する間隔（youtube-notebooklm.js と同じ理由・同じ値）。 */
  const RESCAN_FALLBACK_MS = 250;

  // master が false ならすべて false 扱い。
  const f = (key) => active && features[key] === true;

  // ---------- 状態購読 ----------
  // 設定購読 3 経路 (初期 get / onMessage / onChanged 部分更新) は CleanerCore に集約。
  CleanerCore.subscribe({
    masterKey: StorageKeys.X_CLEANER_ENABLED,
    featuresKey: StorageKeys.X_CLEANER_FEATURES,
    applyAction: Actions.APPLY_X_CLEANER_CS,
    mergeFeatures: (raw) => XCleaner.mergeFeatures(raw),
    onUpdate: (patch) => {
      if ("active" in patch) active = patch.active;
      if ("features" in patch) features = patch.features;
      onSettingsChanged();
    },
  });

  // ---------- 設定変更ディスパッチャ ----------
  function onSettingsChanged() {
    applyBodyClasses();
    syncTabWatcher();
  }

  /** 各機能フラグに応じて `<html>` にクラスを付け外し。 */
  function applyBodyClasses() {
    // zombie guard (PATTERN SYNC): orphan 化した content script が遅延発火した場合でも
    // body class を確実に剥がして UI を素に戻す保険。
    if (!chrome.runtime?.id) {
      active = false;
    }
    const root = document.documentElement;
    if (!root) return;
    for (const [key, className] of Object.entries(XCleaner.BODY_CLASS)) {
      root.classList.toggle(className, f(key));
    }
  }

  // ---------- followingTabDefault（ホームを「フォロー中」で開く） ----------

  /** 機能 ON のときだけ observer を張り、OFF / orphan で確実に外す。 */
  function syncTabWatcher() {
    if (!f("followingTabDefault") || !chrome.runtime?.id) {
      detachTabWatcher();
      return;
    }
    if (!observer) {
      observer = new MutationObserver(scheduleTabScan);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    scheduleTabScan();
  }

  function detachTabWatcher() {
    if (scanRaf !== null) {
      cancelAnimationFrame(scanRaf);
      scanRaf = null;
    }
    if (scanTimer !== null) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    try { observer?.disconnect(); } catch { /* 切断済みなら無視 */ }
    observer = null;
  }

  /**
   * MutationObserver の高頻度発火を 1 フレーム 1 回に圧縮する。
   *
   * **rAF だけに頼らない**（実機で確認 / 2026-07-28）: バックグラウンドタブでは
   * `requestAnimationFrame` が発火しないため、別タブで開いた X ではタブ切替が永久に走らなかった。
   * youtube-notebooklm.js と同じく、タイマーを併用して走査を保証する。
   */
  function scheduleTabScan() {
    if (scanRaf === null) {
      scanRaf = requestAnimationFrame(() => {
        scanRaf = null;
        switchToFollowingTab();
      });
    }
    if (scanTimer === null) {
      scanTimer = setTimeout(() => {
        scanTimer = null;
        switchToFollowingTab();
      }, RESCAN_FALLBACK_MS);
    }
  }

  /**
   * ホームで「おすすめ」が選択中なら「フォロー中」タブをクリックする。
   *
   * タブは**位置で特定する**（index 0 = おすすめ / 1 = フォロー中）。ピン留めしたリストは
   * 3 番目以降に並ぶので先頭 2 つの順序は変わらず、ロケールにも依存しない。
   * SPA 遷移で pathname が変わったら試行フラグをリセットし、同じページでは 1 回しか押さない
   * （ユーザーが自分で「おすすめ」へ戻した操作を上書きしないため）。
   */
  function switchToFollowingTab() {
    if (!chrome.runtime?.id) {
      detachTabWatcher();
      return;
    }
    if (!f("followingTabDefault")) return;

    const path = location.pathname;
    if (path !== tabSwitchPath) {
      tabSwitchPath = path;
      tabSwitchDone = false;
    }
    if (tabSwitchDone) return;
    if (!XCleaner.isHomePath(path)) return;

    const tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
    const forYou = tabs[XCleaner.TAB_INDEX.FOR_YOU];
    const following = tabs[XCleaner.TAB_INDEX.FOLLOWING];
    if (!forYou || !following) return;  // まだ描画されていない → 次の走査に任せる

    // すでに「フォロー中」なら何もしない（X は最後に見たタブを覚えているのでこの分岐が普通）
    if (following.getAttribute("aria-selected") === "true") {
      tabSwitchDone = true;
      return;
    }
    if (forYou.getAttribute("aria-selected") !== "true") return;

    tabSwitchDone = true;  // click 前に立てて、再入で連打しないようにする
    following.click();
  }

  // SPA 遷移（pushState / popstate）でも走査する。X は history API で画面遷移するため、
  // MutationObserver だけだと「DOM が変わらない遷移」を取りこぼす。
  window.addEventListener("popstate", scheduleTabScan);

  window.addEventListener("pagehide", (ev) => {
    // bfcache 凍結（persisted=true）は observer も凍結されるので温存する。
    if (!ev.persisted) detachTabWatcher();
  });
})();
