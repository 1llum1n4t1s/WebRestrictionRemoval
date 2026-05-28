"use strict";

/**
 * scan-runner.js — content script 共通実行ランタイム
 *
 * /rere B1-007 / B2-I002 / D-002 修正で抽出した共通モジュール。
 * Amazon 3-cs (delivery-total / ranking-jump / merchant-info) が同型コピーで実装していた
 * 「rAF coalesce + MutationObserver disconnect→render→takeRecords→observe ガード」+
 * 「Extension context invalidation guard (PATTERN SYNC)」を集約する。
 *
 * 設計判断:
 *   - 各 cs は `ScanRunner.create({ render, cleanup, ... })` を呼ぶだけで上記パターンを取得
 *   - render コールバックは idempotent (差分更新) であることを呼び出し側が保証する
 *   - cleanup コールバックは master OFF / orphan 化時に呼ばれ、chrome API 非依存であるべき
 *   - early-framework.js と同じ思想 (boilerplate 集約 + サイト固有ロジックのみ各 cs に残す)
 *
 * 4 経路の事故対策が組み込まれている (旧 amazon-delivery-total.js / amazon-ranking-jump.js /
 * amazon-merchant-info.js のコメント参照):
 *   - disconnect → render → takeRecords → observe ガードで MO 自己発火による無限ループ防止
 *   - rAF coalesce で同一フレーム内の連続 mutation を 1 回の render に圧縮
 *   - chrome.runtime?.id 検知で orphan 化した content script の MO/timer を即停止
 *   - cleanup は chrome API 非依存にして orphan 後も安全に呼べる
 *
 * 二重ロード許容: 各 content_scripts エントリで個別ロードされても `__cpaScanRunnerLoaded`
 * ガードで 2 回目以降は即 return する (actions.js と同じパターン)。
 */

(() => {
  if (window.__cpaScanRunnerLoaded === true) return;
  window.__cpaScanRunnerLoaded = true;

  /**
   * @typedef {Object} ScanRunnerConfig
   * @property {() => void} render
   *   実際の DOM 書き込み・更新ロジック。idempotent (差分更新) 必須。
   *   `observer.disconnect()` 後に呼ばれるので、内部で MO 自己発火を心配する必要はない。
   * @property {() => void} [cleanup]
   *   master OFF / orphan 化時に呼ばれる DOM 撤去ロジック。**idempotent (複数回呼んでも安全)
   *   であること** が必須 — `stop()` と `checkContextInvalidated()` の両経路から呼ばれ得るため
   *   (構造上は二重呼び出しを防いでいるが、契約として冪等性に依存する)。また chrome API 非依存を
   *   推奨 (orphan 化後も安全に呼べるよう)。実装例: `querySelectorAll(...).forEach(el => el.remove())`
   *   は何度呼んでも安全。
   * @property {MutationObserverInit} [observeOptions]
   *   MutationObserver の observe オプション。デフォルト `{ childList: true, subtree: true }`。
   * @property {() => (Element | null)} [observeTarget]
   *   observe する root element を返す関数。デフォルト `document.body || document.documentElement`。
   *   関数経由で評価することで、document_idle 後に body が確実に取れるタイミングで解決する。
   */

  /**
   * @typedef {Object} ScanRunnerInstance
   * @property {() => void} start
   *   active 状態に遷移し、observer を起動 + 初回 scheduleRender を呼ぶ。
   * @property {() => void} stop
   *   active 状態を解除し、observer を disconnect + cleanup を呼ぶ。
   * @property {() => void} scheduleRender
   *   外部からも render を rAF coalesce 経由で trigger できる (storage.onChanged 等から)。
   * @property {() => boolean} isOrphan
   *   orphan 化を検知したかどうかを返す。
   */

  /**
   * scan runner instance を作成する。
   * @param {ScanRunnerConfig} config
   * @returns {ScanRunnerInstance}
   */
  function create(config) {
    if (!config || typeof config.render !== "function") {
      throw new Error("ScanRunner.create: render function is required");
    }
    const render = config.render;
    const cleanup = typeof config.cleanup === "function" ? config.cleanup : null;
    const observeOptions = config.observeOptions || { childList: true, subtree: true };
    const getTarget =
      typeof config.observeTarget === "function"
        ? config.observeTarget
        : () => document.body || document.documentElement;

    /** @type {boolean} master ON/OFF 状態 */
    let active = false;
    /** @type {MutationObserver | null} */
    let observer = null;
    /** rAF 連続抑制用フラグ */
    let scanScheduled = false;
    /** rAF id (cancel 用) */
    let rafHandle = 0;
    /** 拡張機能 reload 後の orphan content script 検出フラグ (一度立てたら不可逆) */
    let contextInvalidated = false;

    /**
     * 拡張機能リロード後、古い content script は DOM に残るが `chrome.runtime.id` が
     * undefined になり、chrome.* API が "Extension context invalidated" で throw する。
     * 主要発火経路の入口で呼び、orphan 検知時に observer disconnect + rAF cancel + cleanup を
     * 1 度だけ実行する。chrome API 非依存の cleanup なら invalidation 後も安全に呼べる。
     */
    function checkContextInvalidated() {
      if (contextInvalidated) return true;
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          contextInvalidated = true;
        }
      } catch {
        contextInvalidated = true;
      }
      if (contextInvalidated) {
        if (observer) {
          try { observer.disconnect(); } catch {}
          observer = null;
        }
        if (rafHandle) {
          try { cancelAnimationFrame(rafHandle); } catch {}
          rafHandle = 0;
        }
        scanScheduled = false;
        active = false;
        if (cleanup) {
          try { cleanup(); } catch {}
        }
      }
      return contextInvalidated;
    }

    function startObserver() {
      if (observer) return;
      observer = new MutationObserver(scheduleRender);
      const target = getTarget();
      if (target) observer.observe(target, observeOptions);
    }

    function stopObserver() {
      if (observer) {
        try { observer.disconnect(); } catch {}
        observer = null;
      }
      if (rafHandle) {
        try { cancelAnimationFrame(rafHandle); } catch {}
        rafHandle = 0;
      }
      scanScheduled = false;
    }

    /**
     * MutationObserver からのコールバックは同期的・高頻度に呼ばれうる。rAF 1 個に集約することで:
     *   1. 同一フレーム内の連続 mutation を 1 回の render に圧縮
     *   2. ブラウザが描画余裕のあるタイミングで実行 (主スレッドのジャンク回避)
     *   3. 自分の append/textContent 書き込みを次フレームへ遅延 → 同期再発火を遮断
     */
    function scheduleRender() {
      if (scanScheduled) return;
      if (checkContextInvalidated()) return;
      scanScheduled = true;
      rafHandle = requestAnimationFrame(() => {
        scanScheduled = false;
        rafHandle = 0;
        if (!active) return;
        if (checkContextInvalidated()) return;
        runRenderInsideObserverGuard();
      });
    }

    /**
     * Observer を一時 disconnect → render → takeRecords で蓄積分を破棄 → observe 再開。
     * これにより自分の append / textContent が次の MutationRecord に積まれて scheduleRender を
     * 連鎖発火させる無限ループを断ち切る (Amazon 月別合計のフリーズ事故から確立された原則)。
     */
    function runRenderInsideObserverGuard() {
      if (!observer) {
        try { render(); } catch {}
        return;
      }
      observer.disconnect();
      try {
        render();
      } finally {
        // disconnect 中に積まれていた pending records は破棄して捨てる。
        // disconnect 後の DOM 変更は observer に届かないため、takeRecords は基本空を返すが
        // 仕様上一応呼んでおき、再 observe 時にゴーストレコードが残らないようにする。
        observer.takeRecords();
        const target = getTarget();
        if (target) observer.observe(target, observeOptions);
      }
    }

    return Object.freeze({
      start() {
        if (active) return;
        if (checkContextInvalidated()) return;
        active = true;
        startObserver();
        scheduleRender();
      },
      stop() {
        if (!active) return;
        active = false;
        stopObserver();
        if (cleanup) {
          try { cleanup(); } catch {}
        }
      },
      scheduleRender,
      isOrphan: () => contextInvalidated,
    });
  }

  globalThis.ScanRunner = Object.freeze({ create });
})();
