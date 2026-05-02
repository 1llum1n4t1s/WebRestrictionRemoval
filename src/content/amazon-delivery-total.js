"use strict";

/**
 * Amazon 定期おトク便 月別合計金額表示 content script。
 *
 * 元拡張 "Amazon定期おトク便の合計金額表示" (`npipdojmddhaehjoglciocbpengfoipp` v1.0.3) の機能を
 * 軽量な vanilla JS で再実装。React + Webpack bundle (131KB) を必要としない実装にする。
 *
 * 機能:
 *   - `/auto-deliveries*` ページ内の `[data-delivery-type]` 要素（=月単位セクション）を走査
 *   - 各セクション内の `.subscription-price` の数値合計を計算
 *   - 各セクションの `.a-fixed-left-grid-col` に「合計金額: ¥XX,XXX 円」を挿入
 *
 * 設計判断:
 *   - master トグル `amazonDeliveryTotalEnabled` で制御。OFF にしたら挿入要素を撤去
 *   - MutationObserver で動的更新（Amazon は SPA ではないが React 更新やフィルタ操作に対応）
 *   - 重複挿入防止: 各セクションに 1 つだけ `__cpa-amzn-delivery-total` クラスのルート要素を保つ
 *   - top frame 限定（広告 iframe 等で副作用を出さないため）
 *   - manifest.json で `*://www.amazon.co.jp/auto-deliveries*` に matches を絞っているため、
 *     content script 自体が他ページに注入されない設計（ホスト判定は content 内ではしない）
 */

(() => {
  if (window.__amazonDeliveryTotalRunning) return;
  window.__amazonDeliveryTotalRunning = true;
  // top frame 限定。広告系 iframe で同セレクタが別の意味でヒットする可能性を排除する。
  if (window !== window.top) return;

  /** @type {boolean} 機能 ON/OFF */
  let active = false;
  /** @type {MutationObserver|null} */
  let observer = null;
  /** 連続 mutation の coalesce 用フラグ（queueMicrotask で 1 フレーム単位に圧縮） */
  let scanScheduled = false;

  // ---------- 状態購読 ----------
  chrome.storage.local
    .get(StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED)
    .then((stored) => {
      apply(stored[StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED] === true);
    })
    .catch(() => {});

  chrome.runtime.onMessage.addListener((request, sender) => {
    // background SW 由来のみ受け付ける（他経路からの偽装を遮断）。
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

  /**
   * 有効/無効を反映する。
   * - true: MutationObserver 起動 + 即時 1 回スキャン
   * - false: observer 切断 + 既存挿入要素を撤去
   */
  function apply(enabled) {
    if (enabled === active) return;
    active = enabled;
    if (enabled) {
      startObserver();
      renderAllTotals();
    } else {
      stopObserver();
      removeAllTotals();
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    queueMicrotask(() => {
      scanScheduled = false;
      if (!active) return;
      renderAllTotals();
    });
  }

  // ---------- レンダリング ----------

  /**
   * すべての月セクションを走査して合計表示を更新する。
   * - 既存の `.__cpa-amzn-delivery-total` があれば数値だけ更新（DOM 構築コスト削減）
   * - 無ければ新規作成して挿入
   * - 挿入対象 `.a-fixed-left-grid-col` が見つからないセクションはスキップ
   */
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
      // 数値表示部だけ書き換える（毎回 createElement する無駄を避ける）
      const priceEl = root.querySelector(`.${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__price`);
      if (priceEl) priceEl.textContent = total.toLocaleString();
    });
  }

  /**
   * 1 セクション内の `.subscription-price` テキストを数値化して合計する。
   * 価格テキストが空 / 非数字のみのケースは 0 として扱う（NaN 伝播防止）。
   */
  function computeSectionTotal(section) {
    let total = 0;
    const prices = section.querySelectorAll(AmazonDeliveryTotal.PRICE_SELECTOR);
    prices.forEach((el) => {
      const raw = (el.innerText ?? el.textContent ?? "").replace(
        AmazonDeliveryTotal.PRICE_NORMALIZE_RE,
        ""
      );
      // 空文字を Number にすると 0 になるので NaN 心配は無い。
      // ただし parseInt は前方一致で動くため、Number() で全文字一致を要求して安全側に倒す。
      const n = Number(raw);
      if (Number.isFinite(n)) total += n;
    });
    return total;
  }

  /** 「合計金額 ¥nn,nnn 円」のラッパ要素を組み立てる。 */
  function buildTotalNode() {
    const root = document.createElement("div");
    root.className = AmazonDeliveryTotal.TOTAL_ROOT_CLASS;
    root.setAttribute("role", "note");
    root.setAttribute("aria-label", "この月の合計金額");

    const inner = document.createElement("div");
    inner.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__inner`;

    const txt = document.createElement("span");
    txt.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__txt`;
    txt.textContent = "合計金額";

    const sym = document.createElement("span");
    sym.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__sym`;
    sym.textContent = "¥";
    sym.setAttribute("aria-hidden", "true");

    const price = document.createElement("span");
    price.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__price`;
    // textContent は renderAllTotals() 側で都度書き込み

    const unit = document.createElement("span");
    unit.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__unit`;
    unit.textContent = "円";

    inner.append(txt, sym, price, unit);
    root.append(inner);
    return root;
  }

  /** 機能 OFF 時にすべての挿入要素を撤去する。 */
  function removeAllTotals() {
    document
      .querySelectorAll(`.${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}`)
      .forEach((el) => el.remove());
  }
})();
