"use strict";

/**
 * Early script 共通フレームワーク (/rere レビュー D-2 / #17 リファクタ)。
 *
 * 3 つの document_start early script (youtube-early.js / instagram-early.js / tiktok-early.js) が
 * 共通して持つボイラープレート (style 注入・pre クラス同期付与・storage 取得・onChanged 購読) を
 * 1 か所に集約する。各 early script は最小限のサイト固有ロジック (MutationObserver, force-hide,
 * URL redirect 等) だけを書き、共通部分は `window.__cpaEarlyFramework.setup(config)` を呼ぶ。
 *
 * 設計判断:
 *   - **actions.js には依存しない** (early と同じ最速注入原則を維持)
 *   - **manifest 各 document_start エントリの `js` 配列で本ファイルを **先頭** に置く** ことで
 *     framework → 各 early の順にロードされ、`window.__cpaEarlyFramework` が定義済みの状態で
 *     each early が走る
 *   - フレームワーク自体に MutationObserver や URL redirect ロジックは持たない (サイト差異が
 *     大きすぎる)。これらは各 early script に残す
 *   - `__cpaEarlyFrameworkLoaded` で同一 isolated world 二重ロードを防ぐ (manifest に
 *     framework が複数エントリで列挙されるため)
 */

(() => {
  if (window.__cpaEarlyFrameworkLoaded) return;
  window.__cpaEarlyFrameworkLoaded = true;

  /**
   * Early FOUC 防止の共通セットアップ。
   *
   * @param {Object} config
   * @param {string} [config.styleId] - <style> 要素の id (重複注入防止)
   * @param {string} [config.cssText] - <html> 直下に同期 prepend する CSS rule 群
   * @param {string[]} [config.preClasses=[]] - <html> に同期付与する pre クラス名群 (オプトアウト方式)
   * @param {string[]} config.storageKeys - chrome.storage.local から取得するキー
   * @param {(stored: Record<string, any>) => void} config.onEvaluate - 設定変更時のコールバック
   *
   * 動作:
   *   1. styleId / cssText 指定があれば <style> 同期注入
   *   2. preClasses 全部を <html> に同期付与 (storage 確認前に有効化、後で剥がせるオプトアウト方式)
   *   3. storage.local.get で初期評価 → onEvaluate(stored) 呼び出し
   *   4. storage.onChanged で監視対象キーが変化したら再評価
   *      (両キーが newValue を持つときは直読みで IPC 1 回節約)
   */
  function setup(config) {
    const {
      styleId,
      cssText,
      preClasses = [],
      storageKeys,
      onEvaluate,
    } = config;

    // (1) <style> 同期 prepend
    if (cssText && styleId && !document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = cssText;
      document.documentElement.appendChild(style);
    }

    // (2) pre クラス同期付与 (storage 確認前にオプトアウト方式で有効化)
    for (const cls of preClasses) {
      document.documentElement.classList.add(cls);
    }

    const stored = {};
    const notifiedKeys = new Set();
    let readGeneration = 0;
    const readSettings = () => {
      const generation = ++readGeneration;
      chrome.storage.local.get(storageKeys).then((result) => {
        if (generation !== readGeneration) return;
        // 通知値（削除も含む）は取得結果より優先し、未通知キーを補完する。
        for (const key of storageKeys) {
          if (!notifiedKeys.has(key)) stored[key] = result[key];
        }
        onEvaluate({ ...stored });
      }).catch(() => {
        if (generation !== readGeneration) return;
        onEvaluate({ ...stored });
      });
    };

    // (3) 初期評価
    readSettings();

    // (4) storage.onChanged 監視
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!chrome.runtime?.id) return; // zombie guard
      const touched = storageKeys.some((k) => k in changes);
      if (!touched) return;
      // 進行中の成功・失敗の両方を無効化し、今回の操作を即時評価する。
      readGeneration++;
      for (const key of storageKeys) {
        if (!(key in changes)) continue;
        notifiedKeys.add(key);
        stored[key] = changes[key].newValue;
      }
      onEvaluate({ ...stored });
      // 全キーが newValue を持っているなら直読みで IPC 1 回節約
      const allChanged = storageKeys.every((k) => changes[k] !== undefined);
      if (allChanged) return;
      // 片方のみ変化なら再 get で補完
      readSettings();
    });
  }

  window.__cpaEarlyFramework = { setup };
})();
