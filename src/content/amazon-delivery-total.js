"use strict";

/**
 * Amazon 定期おトク便 月別合計金額表示 content script。
 *
 * Amazon 定期おトク便ページの DOM 構造を解析し、配送月ごとの合計金額を独自に計算・表示する
 * vanilla JS 実装。React や bundler は使用せず、軽量に動作する。
 *
 * 機能:
 *   - 従来の月別セクションと、現行の配送詳細カードを走査
 *   - 従来は .subscription-price、現行は product-price の単価 × 数量で集計
 *   - 金額を持たない現行一覧では「管理」画面への案内を表示（追加通信なし）
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
    observeOptions: {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["aria-label"],
    },
  });

  // ---------- 状態購読 ----------
  CleanerCore.subscribeBoolean({
    masterKey: StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED,
    applyAction: Actions.APPLY_AMAZON_DELIVERY_TOTAL_CS,
    onUpdate: apply,
  });

  function apply(enabled) {
    if (enabled) runner.start();
    else runner.stop();
  }

  // ---------- レンダリング ----------

  function renderAllTotals() {
    const countText = document.querySelector('[data-testid="delivery-item-count-desktop"]')?.textContent ?? "";
    const countMatch = countText.normalize("NFKC").match(/\d+/);
    const expectedCount = countMatch ? Number(countMatch[0]) : null;
    const deliveryItems = document.querySelectorAll(
      `${AmazonDeliveryTotal.DELIVERY_SECTION_SELECTOR} ${AmazonDeliveryTotal.DELIVERY_ITEM_SELECTOR}`
    );
    const completeDelivery = expectedCount !== null && deliveryItems.length === expectedCount;
    const sections = document.querySelectorAll(
      `${AmazonDeliveryTotal.SECTION_SELECTOR},${AmazonDeliveryTotal.DELIVERY_SECTION_SELECTOR}`
    );
    sections.forEach((section) => {
      const delivery = section.matches(AmazonDeliveryTotal.DELIVERY_SECTION_SELECTOR);
      const total = delivery
        ? (completeDelivery ? computeDeliveryTotal(section) : null)
        : computeSectionTotal(section);
      const target = section.querySelector(delivery
        ? AmazonDeliveryTotal.DELIVERY_TARGET_SELECTOR
        : AmazonDeliveryTotal.INSERT_TARGET_SELECTOR);
      if (total === null || !target) {
        section.querySelector(`.${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}`)?.remove();
        return;
      }

      let root = section.querySelector(`.${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}`);
      if (!root) {
        root = buildTotalNode(delivery);
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
    renderOverviewHint();
  }

  function computeDeliveryTotal(section) {
    const items = section.querySelectorAll(AmazonDeliveryTotal.DELIVERY_ITEM_SELECTOR);
    if (!items.length) return null;
    let total = 0;
    for (const item of items) {
      const priceEl = item.querySelector(AmazonDeliveryTotal.DELIVERY_PRICE_SELECTOR);
      const priceText = priceEl?.textContent?.trim()
        || priceEl?.querySelector("[aria-label]")?.getAttribute("aria-label") || "";
      const priceMatch = priceText.normalize("NFKC").match(/^[¥￥]\s*(\d[\d,]*)(?:\.(\d{1,2}))?\s*$/);
      const quantityText = item.querySelector(AmazonDeliveryTotal.DELIVERY_QUANTITY_SELECTOR)?.textContent ?? "";
      const quantityMatch = quantityText.normalize("NFKC").match(/(\d+)\s*(?:ユニット|個|units?\b)/i);
      if (!priceMatch || !quantityMatch) return null;
      const price = Number(priceMatch[1].replaceAll(",", "") + (priceMatch[2] ? `.${priceMatch[2]}` : ""));
      const quantity = Number(quantityMatch[1]);
      if (!Number.isFinite(price) || !Number.isSafeInteger(quantity) || quantity < 1) return null;
      total += price * quantity;
    }
    return Number.isFinite(total) ? total : null;
  }

  function renderOverviewHint() {
    const overview = document.getElementById("deliveriesDesktopScroller");
    const selector = `.${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}[data-overview-hint]`;
    const existing = document.querySelector(selector);
    if (!overview) {
      existing?.remove();
      return;
    }
    if (existing && existing.previousElementSibling === overview) return;
    existing?.remove();
    const hint = document.createElement("div");
    hint.className = AmazonDeliveryTotal.TOTAL_ROOT_CLASS;
    hint.dataset.overviewHint = "true";
    hint.setAttribute("role", "note");
    hint.textContent = ScanRunner.safeMsg("amazonTotalDetailsHint", "合計金額は各お届け日の「管理」を開くと表示されます。");
    overview.after(hint);
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

  function buildTotalNode(delivery = false) {
    const root = document.createElement("div");
    root.className = AmazonDeliveryTotal.TOTAL_ROOT_CLASS;
    root.setAttribute("role", "note");
    root.setAttribute("aria-label", delivery
      ? ScanRunner.safeMsg("amazonDeliveryTotalAriaLabel", "この配送の合計金額")
      : ScanRunner.safeMsg("amazonTotalAriaLabel", "この月の合計金額"));

    const inner = document.createElement("div");
    inner.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__inner`;

    const txt = document.createElement("span");
    txt.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__txt`;
    txt.textContent = ScanRunner.safeMsg("amazonTotalText", "合計金額");

    const sym = document.createElement("span");
    sym.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__sym`;
    sym.textContent = "¥";
    sym.setAttribute("aria-hidden", "true");

    const price = document.createElement("span");
    price.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__price`;

    const unit = document.createElement("span");
    unit.className = `${AmazonDeliveryTotal.TOTAL_ROOT_CLASS}__unit`;
    unit.textContent = ScanRunner.safeMsg("amazonTotalUnit", "円");

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
