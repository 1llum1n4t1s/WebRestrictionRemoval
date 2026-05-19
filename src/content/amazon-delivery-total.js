"use strict";

/**
 * Amazon 定期おトク便 月別合計金額表示 content script。
 *
 * Amazon 定期おトク便ページの DOM 構造を解析し、配送月ごとの合計金額を独自に計算・表示する
 * vanilla JS 実装。React や bundler は使用せず、軽量に動作する。
 *
 * 機能:
 *   - `/auto-deliveries*` ページ内の `[data-delivery-type]` 要素（=月単位セクション）を走査
 *   - 各セクション内の `.subscription-price` の数値合計を計算
 *   - 各セクションの `.a-fixed-left-grid-col` に「合計金額: ¥XX,XXX 円」を挿入
 *
 * 設計判断:
 *   - master トグル `amazonDeliveryTotalEnabled` で制御。OFF にしたら挿入要素を撤去
 *   - MutationObserver で動的更新。ただし自分が DOM に書き戻すと再発火 → 無限ループになるため、
 *     書き込み中は disconnect → 書き込み → takeRecords (蓄積を破棄) → observe で再接続する。
 *     さらに requestAnimationFrame による rAF ベース coalesce を併用し、過剰スキャンを防ぐ。
 *   - 重複挿入防止: 各セクションに 1 つだけ `__cpa-amzn-delivery-total` クラスのルート要素を保つ
 *   - top frame 限定（広告 iframe 等で副作用を出さないため）
 */

(() => {
  if (window.__amazonDeliveryTotalRunning) return;
  window.__amazonDeliveryTotalRunning = true;
  if (window !== window.top) return;

  /** @type {boolean} 機能 ON/OFF */
  let active = false;
  /** @type {MutationObserver|null} */
  let observer = null;
  /** rAF 連続抑制用フラグ */
  let scanScheduled = false;
  /** rAF id（cancel 用） */
  let rafHandle = 0;
  /** observer の observe 引数（再接続時に使う） */
  const OBSERVE_OPTIONS = { childList: true, subtree: true };
  /** 拡張機能 reload 後の orphan content script 検出フラグ */
  let contextInvalidated = false;

  /**
   * 拡張機能リロード後、古い content script は DOM に残るが `chrome.runtime.id` が
   * undefined になる。この状態で `chrome.i18n.getMessage` (buildTotalNode 内) を呼ぶと
   * "Extension context invalidated" で throw する。
   *
   * MutationObserver → scheduleRender → renderAllTotals → buildTotalNode の経路で
   * 過去にこのエラーを実機 (TikTok image-downloader) で確認したため、ここでも同じガード
   * パターンを適用する。判定 true 時は observer disconnect + rAF cancel + DOM 撤去を
   * 1 度だけ実行し、以後の呼び出しを no-op 化する。`removeAllTotals` は chrome API
   * 非依存なので invalidation 後も安全に呼べる。
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
      try { removeAllTotals(); } catch {}
    }
    return contextInvalidated;
  }

  // ---------- 状態購読 ----------
  chrome.storage.local
    .get(StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED)
    .then((stored) => {
      apply(stored[StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED] === true);
    })
    .catch(() => {});

  chrome.runtime.onMessage.addListener((request, sender) => {
    if (!SenderCheck.isFromBackground(sender)) return;
    if (request?.action !== Actions.APPLY_AMAZON_DELIVERY_TOTAL_CS) return;
    apply(request.data?.enabled === true);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED in changes) {
      apply(changes[StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED].newValue === true);
    }
  });

  function apply(enabled) {
    if (enabled === active) return;
    active = enabled;
    if (enabled) {
      startObserver();
      // 初回スキャンも write-guard 経由で（自分の書き込み由来の再発火を防ぐ）。
      scheduleRender();
    } else {
      stopObserver();
      removeAllTotals();
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(scheduleRender);
    observer.observe(document.body || document.documentElement, OBSERVE_OPTIONS);
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
    scanScheduled = false;
  }

  /**
   * MutationObserver からのコールバックは同期的・高頻度に呼ばれうる。rAF 1 個に集約することで:
   *   1. 同一フレーム内の連続 mutation を 1 回の render に圧縮
   *   2. ブラウザが描画余裕のあるタイミングで実行（主スレッドのジャンク回避）
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
   * 連鎖発火させる無限ループを断ち切る。
   */
  function runRenderInsideObserverGuard() {
    if (!observer) {
      renderAllTotals();
      return;
    }
    observer.disconnect();
    try {
      renderAllTotals();
    } finally {
      // disconnect 中に積まれていた pending records は破棄して捨てる。
      // disconnect 後の DOM 変更は observer に届かないため、takeRecords は基本空を返すが
      // 仕様上一応呼んでおき、再 observe 時にゴーストレコードが残らないようにする。
      observer.takeRecords();
      observer.observe(document.body || document.documentElement, OBSERVE_OPTIONS);
    }
  }

  // ---------- レンダリング ----------

  function renderAllTotals() {
    const sections = document.querySelectorAll(AmazonDeliveryTotal.SECTION_SELECTOR);
    sections.forEach((section) => {
      const total = computeSectionTotal(section);
      const target = section.querySelector(AmazonDeliveryTotal.INSERT_TARGET_SELECTOR);
      if (!target) return;

      let root = section.querySelector(`.${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}`);
      if (!root) {
        root = buildTotalNode();
        target.append(root);
      }
      const priceEl = root.querySelector(`.${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__price`);
      if (priceEl) {
        const next = total.toLocaleString();
        // 値が変化したときだけ書き込む。同じ文字列で textContent を上書きしても MutationRecord は
        // 発火するため (Chrome の DOM 仕様)、disconnect 中に守られていてもコストの差が出る。
        if (priceEl.textContent !== next) priceEl.textContent = next;
      }
    });
  }

  function computeSectionTotal(section) {
    let total = 0;
    const prices = section.querySelectorAll(AmazonDeliveryTotal.PRICE_SELECTOR);
    prices.forEach((el) => {
      const raw = (el.innerText ?? el.textContent ?? "").replace(
        AmazonDeliveryTotal.PRICE_NORMALIZE_RE,
        ""
      );
      const n = Number(raw);
      if (Number.isFinite(n)) total += n;
    });
    return total;
  }

  function buildTotalNode() {
    const root = document.createElement("div");
    root.className = AmazonDeliveryTotal.TOTAL_ROOT_CLASS;
    root.setAttribute("role", "note");
    root.setAttribute("aria-label", chrome.i18n.getMessage("amazonTotalAriaLabel") || "この月の合計金額");

    const inner = document.createElement("div");
    inner.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__inner`;

    const txt = document.createElement("span");
    txt.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__txt`;
    txt.textContent = chrome.i18n.getMessage("amazonTotalText") || "合計金額";

    const sym = document.createElement("span");
    sym.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__sym`;
    sym.textContent = "¥";
    sym.setAttribute("aria-hidden", "true");

    const price = document.createElement("span");
    price.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__price`;

    const unit = document.createElement("span");
    unit.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__unit`;
    unit.textContent = chrome.i18n.getMessage("amazonTotalUnit") || "円";

    inner.append(txt, sym, price, unit);
    root.append(inner);
    return root;
  }

  /**
   * 機能 OFF 時にすべての挿入要素を撤去する。
   *
   * 通常の `apply(false)` 経路は `stopObserver()` → `removeAllTotals()` の順で呼ばれるため
   * 突入時点で `observer` は既に null。よって直接 `removeNodes()` で十分。observer が
   * 残存している経路（observer 起動中のまま master OFF など）に備えて、念のため
   * disconnect → takeRecords で再発火を防ぐ guard を持つ。
   */
  function removeAllTotals() {
    if (observer) {
      // observer 残存ケース: 自身の remove による mutation で再発火しないよう一時停止
      observer.disconnect();
      try {
        document
          .querySelectorAll(`.${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}`)
          .forEach((el) => el.remove());
      } finally {
        // OFF 経路では reconnect しない。蓄積された mutation は takeRecords で破棄。
        observer.takeRecords();
      }
      return;
    }
    document
      .querySelectorAll(`.${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}`)
      .forEach((el) => el.remove());
  }
})();
