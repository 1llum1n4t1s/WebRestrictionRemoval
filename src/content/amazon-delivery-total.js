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

  // /rere B1-007/B2-I002/D-002 修正: rAF coalesce + observer guard + context invalidation guard を
  // ScanRunner (src/lib/scan-runner.js) に抽出。本ファイルは render / cleanup ロジックのみ残す。
  // ScanRunner は Amazon 3-cs + image-downloader + youtube-shorts が同型コピーしていた boilerplate
  // を集約し、`disconnect → render → takeRecords → observe` 4 段ガード + rAF coalesce + orphan 化検知
  // (chrome.runtime?.id チェック) を担う。新サイト対応時にも `ScanRunner.create({render, cleanup})`
  // を呼ぶだけで同パターンが踏襲される。
  const runner = ScanRunner.create({
    render: renderAllTotals,
    cleanup: removeAllTotals,
  });

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
    if (enabled) runner.start();
    else runner.stop();
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
   * 機能 OFF / orphan 時にすべての挿入要素を撤去する。
   * /rere B1-007/B2-I002/D-002 修正: ScanRunner.stop() / context invalidation 時に呼ばれる。
   * chrome API 非依存 (DOM 操作のみ) なので orphan 化後も安全。observer 管理は ScanRunner に
   * 委譲済みなので、ここでは純粋に DOM 撤去のみを行う。
   */
  function removeAllTotals() {
    document
      .querySelectorAll(`.${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}`)
      .forEach((el) => el.remove());
  }
})();
