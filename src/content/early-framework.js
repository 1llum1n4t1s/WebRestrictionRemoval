"use strict";

/**
 * Early script 共通フレームワーク (/rere レビュー D-2 / #17 リファクタ)。
 *
 * 4 つの document_start early script (YouTube / Instagram / TikTok / X) が
 * 共通して持つボイラープレート (style 注入・storage 取得・onChanged 購読) を
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
   * @param {string[]} [config.preClasses=[]] - context 失効時に解除する所有クラス名群
   * @param {string[]} config.storageKeys - chrome.storage.local から取得するキー
   * @param {(stored: Record<string, any>) => void} config.onEvaluate - 設定変更時のコールバック
   *
   * 動作:
   *   1. styleId / cssText 指定があれば <style> 同期注入
   *   2. 設定未取得の間はクラス・inline style による非表示を行わない
   *   3. storage.local.get で初期評価 → onEvaluate(stored) 呼び出し
   *   4. storage.onChanged で監視対象キーが変化したら再評価
   *      (両キーが newValue を持つときは直読みで IPC 1 回節約)
   *   5. pre クラスが付いている間だけ visibilitychange / focus / pageshow で context 失効を確認し、
   *      失効していればクラスを撤去する（失効後は 4 の chrome イベントが届かないため）
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

    // ---- context 失効（拡張機能の無効化・更新）後の撤去 ----
    // 失効後の content script には chrome.* のイベント（storage.onChanged 等）が届かないため、
    // 下の evaluate の失効分岐は設定通知では到達しない。MutationObserver を持たない early script
    // （TikTok / X）は、pre クラスが付いたままページに残り、非表示が解除されなくなる。
    // そこで pre クラスが実際に付いている間だけ、chrome に依存しない DOM 側のイベント
    // （タブ復帰・フォーカス・bfcache 復帰）で失効を確認する。
    //   - OFF のユーザーはクラスを付けないので、監視は張らず常時コストはゼロ。
    //   - 常時 subtree の MutationObserver は張らない（Instagram の C-#3 と同じ理由）。
    //   - 撤去後はクラスが無くなるので監視を自ら外す。
    // <style> はクラス条件付きのため、クラスが無ければ効果を持たず、他サイトと同様に残す
    // （失効後に再注入された新しい script と共有しうる要素を、失効側が消さないため）。
    const RESUME_EVENTS = [
      [document, "visibilitychange"],
      [window, "focus"],
      [window, "pageshow"],
    ];
    let watchingOrphan = false;
    const isOrphaned = () => {
      try { return !chrome.runtime?.id; } catch { return true; }
    };
    const onResume = () => {
      // 有効な間は何もしない。失効していれば evaluate が撤去し、監視も外す。
      if (isOrphaned()) evaluate({});
    };
    const syncOrphanWatch = () => {
      const applied = preClasses.some((cls) => document.documentElement.classList.contains(cls));
      if (applied === watchingOrphan) return;
      watchingOrphan = applied;
      for (const [target, type] of RESUME_EVENTS) {
        if (applied) target.addEventListener(type, onResume);
        else target.removeEventListener(type, onResume);
      }
    };

    // 非表示は各 onEvaluate が明示的な ON を確認してから適用する。
    const evaluate = (stored) => {
      if (isOrphaned()) {
        for (const cls of preClasses) document.documentElement.classList.remove(cls);
        onEvaluate({});
      } else {
        onEvaluate(stored);
      }
      syncOrphanWatch();
    };

    const stored = {};
    const notifiedKeys = new Set();
    let readGeneration = 0;
    const readSettings = async () => {
      const generation = ++readGeneration;
      try {
        const result = await chrome.storage.local.get(storageKeys);
        if (generation !== readGeneration) return;
        // 通知値（削除も含む）は取得結果より優先し、未通知キーを補完する。
        for (const key of storageKeys) {
          if (!notifiedKeys.has(key)) stored[key] = result[key];
        }
        evaluate({ ...stored });
      } catch {
        if (generation !== readGeneration) return;
        evaluate({ ...stored });
      }
    };

    // (4) storage.onChanged 監視
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!chrome.runtime?.id) {
        readGeneration++;
        evaluate({});
        return;
      }
      const touched = storageKeys.some((k) => k in changes);
      if (!touched) return;
      // 進行中の成功・失敗の両方を無効化し、今回の操作を即時評価する。
      readGeneration++;
      for (const key of storageKeys) {
        if (!(key in changes)) continue;
        notifiedKeys.add(key);
        stored[key] = changes[key].newValue;
      }
      evaluate({ ...stored });
      // 全キーが newValue を持っているなら直読みで IPC 1 回節約
      const allChanged = storageKeys.every((k) => changes[k] !== undefined);
      if (allChanged) return;
      // 片方のみ変化なら再 get で補完
      readSettings();
    });

    // 購読開始後に取得し、取得中の変更通知を取りこぼさない。
    readSettings();
  }

  window.__cpaEarlyFramework = { setup };
})();
