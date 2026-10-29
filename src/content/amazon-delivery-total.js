"use strict";

/** Amazon の配送明細を集計し、価格が未掲載の場合だけ現在の定期便価格で補完する。 */
(() => {
  if (window.__amazonDeliveryTotalRunning || window !== window.top) return;
  window.__amazonDeliveryTotalRunning = true;
  const C = AmazonDeliveryTotal;
  let enabled = false;
  let generation = 0;
  let pageUrl = location.href;
  let controller = new AbortController();
  let requests = new Map();
  let states = new WeakMap();
  let overviewSources = new WeakMap();
  let manageVersions = new Map();
  let running = 0;
  const waiting = [];
  let lifecycleTimer = 0;
  const runner = ScanRunner.create({
    render: renderAllTotals,
    cleanup,
    observeOptions: {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["aria-label", "href", "id"],
    },
  });

  CleanerCore.subscribeBoolean({
    masterKey: StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED,
    applyAction: Actions.APPLY_AMAZON_DELIVERY_TOTAL_CS,
    onUpdate(value) {
      if (!value) { enabled = false; runner.stop(); return; }
      if (enabled || runner.isOrphan()) return;
      enabled = true;
      pageUrl = location.href;
      lifecycleTimer = setInterval(() => {
        // DOM が変わらない SPA 遷移・context 失効も取得中止へ接続する。
        if (!contextAlive()) { enabled = false; runner.stop(); return; }
        if (pageUrl !== location.href) {
          resetRequests();
          removeAllTotals();
          pageUrl = location.href;
          runner.scheduleRender();
        }
      }, 500);
      runner.start();
    },
  });

  function contextAlive() {
    try { return Boolean(chrome.runtime?.id) && !runner.isOrphan(); } catch { return false; }
  }

  function current(token) {
    return enabled && token === generation && pageUrl === location.href && contextAlive();
  }

  function resetRequests() {
    generation++;
    controller.abort();
    controller = new AbortController();
    requests = new Map();
    states = new WeakMap();
    overviewSources = new WeakMap();
    manageVersions = new Map();
  }

  function cleanup() {
    enabled = false;
    clearInterval(lifecycleTimer);
    lifecycleTimer = 0;
    resetRequests();
    removeAllTotals();
  }

  function removeAllTotals() {
    document.querySelectorAll(`.${C.TOTAL_ROOT_CLASS}`).forEach((node) => node.remove());
  }

  function checkedUrl(raw, kind) {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin || url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("URL");
    if (kind === "manage") {
      if (!/^\/auto-deliveries\/?$/.test(url.pathname)
        || !["shipId", "deliveryBundleId", "deliveryDate"].every((key) => url.searchParams.get(key))) throw new Error("Manage URL");
      if ([...url.searchParams.keys()].some((key) => !C.MANAGE_QUERY_KEYS.includes(key))) throw new Error("Manage parameters");
    } else if (kind === "subscription") {
      if (url.pathname !== "/auto-deliveries/ajax/subscription" || !url.searchParams.get("subscriptionId") || !url.searchParams.get("shipId")) throw new Error("Subscription URL");
    } else if (kind === "history") {
      const keys = ["clientName", "deliveryHistoryPageNumber", "subscriptionId", "isAjax"];
      if (url.pathname !== "/auto-deliveries/deliveryHistory"
        || url.searchParams.get("clientName") !== "ddp"
        || url.searchParams.get("deliveryHistoryPageNumber") !== "1"
        || url.searchParams.get("isAjax") !== "0"
        || !url.searchParams.get("subscriptionId")
        || [...url.searchParams.keys()].some((key) => !keys.includes(key))
        || keys.some((key) => url.searchParams.getAll(key).length !== 1)) throw new Error("History URL");
    } else if (kind === "order") {
      if (url.pathname !== "/gp/css/summary/edit.html/ref=rcxsubs_mys2_delivery"
        || !/^\d{3}-\d{7}-\d{7}$/.test(url.searchParams.get("orderID") ?? "")
        || [...url.searchParams.keys()].some((key) => key !== "orderID")
        || url.searchParams.getAll("orderID").length !== 1) throw new Error("Order URL");
    } else if (!/^\/dp\/[A-Z0-9]{10}(?:\/ref=[^/]*)?\/?$/.test(url.pathname)) throw new Error("Product URL");
    return url;
  }

  // 待機中の要求も中止可能。稼働数は世代をまたいで管理して同時数の上限を守る。
  function acquire(signal) {
    return new Promise((resolve, reject) => {
      const entry = { start, cancel };
      function cancel() {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        signal.removeEventListener("abort", cancel);
        reject(new Error("Aborted"));
      }
      function start() {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) { reject(new Error("Aborted")); return; }
        running++;
        resolve();
      }
      if (signal.aborted) { reject(new Error("Aborted")); return; }
      if (running < C.FETCH_CONCURRENCY) start();
      else { waiting.push(entry); signal.addEventListener("abort", cancel, { once: true }); }
    });
  }

  function readPage(raw, kind, asin = null) {
    const url = checkedUrl(raw, kind);
    const key = kind === "order" ? `${url.href}|${asin}` : url.href;
    if (requests.has(key)) return requests.get(key);
    const signal = controller.signal;
    const token = generation;
    const promise = (async () => {
      await acquire(signal);
      try {
        if (!current(token)) throw new Error("Stale");
        const response = await fetch(url.href, {
          method: "GET", credentials: "same-origin", redirect: "error",
          referrerPolicy: "no-referrer", cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(C.FETCH_TIMEOUT_MS)]),
        });
        if (!response.ok || !current(token)) throw new Error("Response");
        const html = await response.text();
        if (!current(token)) throw new Error("Stale");
        const doc = new DOMParser().parseFromString(html, "text/html");
        // HTML 全体・住所・アカウント情報は保持せず、集計に必要な値だけを返す。
        return extractPage(doc, kind, asin);
      } finally {
        running--;
        while (waiting.length && running < C.FETCH_CONCURRENCY) waiting.shift().start();
      }
    })();
    // 失敗も保持し、MutationObserver の発火ごとの再試行を避ける。
    requests.set(key, promise);
    return promise;
  }

  function money(raw) {
    const match = String(raw ?? "").normalize("NFKC").trim().match(/^[¥￥]?\s*(\d[\d,]*)(?:\.(\d{1,2}))?\s*(?:円)?$/);
    if (!match) return null;
    const value = Number(match[1].replaceAll(",", "") + (match[2] ? `.${match[2]}` : ""));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function subscriptionId(tile) {
    const ids = new Set();
    // コメントは tile の二段上に置かれる現行 DOM に対応する。
    // 別商品の ID を誤採用しないよう、単一 tile の祖先だけを最大5段調べる。
    for (let scope = tile, depth = 0; scope && depth <= 5; scope = scope.parentElement, depth++) {
      const count = scope.querySelectorAll(C.DELIVERY_ITEM_SELECTOR).length
        + (scope.matches(C.DELIVERY_ITEM_SELECTOR) ? 1 : 0);
      if (count !== 1 || scope.matches(C.DELIVERY_SECTION_SELECTOR)) break;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_COMMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const match = node.data.match(/k-injected\s+k\+b64\s+([A-Za-z0-9+/=]+)/);
        if (!match) continue;
        try {
          const bytes = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0));
          const id = JSON.parse(new TextDecoder().decode(bytes))?.["k-data"]?.subscriptionId;
          if (typeof id === "string" && id.length && id.length <= 512) ids.add(id);
        } catch { /* 他の注入コメントは対象外。内容は記録しない。 */ }
      }
      if (ids.size > 1) return null;
    }
    return ids.size === 1 ? [...ids][0] : null;
  }

  function itemData(tile) {
    const priceNode = tile.querySelector(C.DELIVERY_PRICE_SELECTOR);
    const priceText = priceNode?.textContent?.trim()
      || priceNode?.querySelector("[aria-label]")?.getAttribute("aria-label") || "";
    const quantityText = tile.querySelector(C.DELIVERY_QUANTITY_SELECTOR)?.textContent ?? "";
    const quantityMatch = quantityText.normalize("NFKC").match(/(\d+)\s*(?:ユニット|個|units?\b)/i);
    const quantity = quantityMatch ? Number(quantityMatch[1]) : null;
    const savings = (tile.querySelector('[data-testid="product-savings"]')?.textContent ?? "").normalize("NFKC").match(/\d+(?:\.\d+)?/g);
    return {
      price: money(priceText), quantity,
      discount: savings?.length === 1 && Number(savings[0]) <= 100 ? Number(savings[0]) : null,
      id: subscriptionId(tile),
    };
  }

  function expectedCount(doc) {
    const text = doc.querySelector('[data-testid="delivery-item-count-desktop"]')?.textContent ?? "";
    const match = text.normalize("NFKC").match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  function detailItems(doc) {
    return [...doc.querySelectorAll(`${C.DELIVERY_SECTION_SELECTOR} ${C.DELIVERY_ITEM_SELECTOR}`)].map(itemData);
  }

  function extractPage(doc, kind, asin) {
    if (kind === "manage") return { items: detailItems(doc), expected: expectedCount(doc) };
    if (kind === "history") {
      // 最新行の URL が不正でも、後続の古い注文へ読み替えない。
      const link = doc.querySelector('#deliveryHistoryPopover table a[href]');
      if (!link) throw new Error("Missing history");
      return checkedUrl(link.getAttribute("href"), "order").href;
    }
    if (kind === "order") {
      const rows = [];
      for (const row of doc.querySelectorAll('[data-component="purchasedItemsRightGrid"]')) {
        const ids = new Set();
        for (const link of row.querySelectorAll('[data-component="itemTitle"] a[href]')) {
          try {
            const url = checkedUrl(link.getAttribute("href"), "product");
            ids.add(url.pathname.match(/^\/dp\/([A-Z0-9]{10})/)[1]);
          } catch { /* 商品タイトル以外の URL は単価の対応付けに使わない。 */ }
        }
        if (!ids.has(asin)) continue;
        if (ids.size !== 1) throw new Error("Ambiguous ordered product");
        const nodes = [...row.querySelectorAll('[data-component="unitPrice"] .a-price .a-offscreen')];
        const prices = nodes.map((node) => money(node.textContent));
        if (!prices.length || prices.some((price) => price === null) || new Set(prices).size !== 1) throw new Error("Missing ordered price");
        rows.push(prices[0]);
      }
      if (rows.length !== 1) throw new Error("Ordered product mismatch");
      return rows[0];
    }
    if (kind === "subscription") {
      const products = new Map();
      for (const link of doc.querySelectorAll('a[href*="/dp/"]')) {
        try {
          const candidate = checkedUrl(link.getAttribute("href"), "product");
          const asin = candidate.pathname.match(/^\/dp\/([A-Z0-9]{10})/)[1];
          products.set(asin, new URL(`/dp/${asin}`, location.origin).href);
        } catch { /* 許可範囲外のリンクは取得しない。 */ }
      }
      if (products.size !== 1) throw new Error("Ambiguous product");
      const histories = new Set();
      for (const link of doc.querySelectorAll('a[href*="/auto-deliveries/deliveryHistory"]')) {
        try { histories.add(checkedUrl(link.getAttribute("href"), "history").href); } catch { /* 不正な履歴 URL は使用しない。 */ }
      }
      const [productAsin, productUrl] = [...products][0];
      return { asin: productAsin, productUrl, historyUrl: histories.size === 1 ? [...histories][0] : null };
    }
    // 表示上の savingsPercentage は参考価格からの総割引率であり、定期便割引とは異なる。
    // Amazon の定期便専用フィールドで base / tier の割引率を対応付ける。
    const baseDiscounts = [...doc.querySelectorAll('input[name="items[0.base][additionalParameters][recurringDelivery][discount]"]')]
      .map((node) => node.getAttribute("value")?.normalize("NFKC").trim())
      .filter((value) => /^\d+(?:\.\d+)?$/.test(value ?? ""))
      .map(Number);
    const tierDiscounts = [...doc.querySelectorAll(".sns-delivery-buybox-upsell-message")]
      .flatMap((node) => [...node.textContent.normalize("NFKC").matchAll(/(\d+(?:\.\d+)?)\s*%/g)])
      .map((match) => Number(match[1]));
    const blocks = [];
    for (const block of doc.querySelectorAll("[id='sns-base-price'],[id='sns-tiered-price']")) {
      const discounts = block.id === "sns-base-price" ? baseDiscounts : tierDiscounts;
      const prices = [];
      for (const value of block.querySelectorAll(".apex-pricetopay-value")) {
        const whole = value.querySelector(".a-price-whole")?.textContent?.replace(/[.．\s]/g, "");
        const fraction = value.querySelector(".a-price-fraction")?.textContent?.trim();
        const price = money(whole ? whole + (fraction ? `.${fraction}` : "") : value.querySelector(".a-offscreen")?.textContent);
        if (price !== null) prices.push(price);
      }
      blocks.push({ discounts, prices });
    }
    const ambiguousDiscount = new Set(baseDiscounts).size > 1 || new Set(tierDiscounts).size > 1;
    return { asin: doc.querySelector("#ASIN")?.getAttribute("value"), blocks, ambiguousDiscount };
  }

  async function referencePrice(item, manageUrl) {
    if (!item.id || item.discount === null) throw new Error("Missing identity");
    const manage = checkedUrl(manageUrl, "manage");
    const detailUrl = new URL("/auto-deliveries/ajax/subscription", location.origin);
    detailUrl.search = new URLSearchParams({
      subscriptionId: item.id, shipId: manage.searchParams.get("shipId"),
      clientName: "ddp", ref_: "myd_hub_ddp", sourcePage: "ddp",
    }).toString();
    const { asin, productUrl, historyUrl } = await readPage(detailUrl.href, "subscription");
    const product = await readPage(productUrl, "product");
    if (product.asin !== asin) throw new Error("ASIN mismatch");
    // 複数の割引率・単価でプランが曖昧な場合は、価格未掲載として履歴へ進めない。
    if (product.ambiguousDiscount || product.blocks.some((block) => new Set(block.prices).size > 1)) throw new Error("Ambiguous current plan");
    const prices = new Set();
    for (const { discounts, prices: values } of product.blocks) {
      if (!discounts.length || discounts.some((value) => value !== item.discount)) continue;
      for (const value of values) prices.add(value);
    }
    if (prices.size > 1) throw new Error("Ambiguous price");
    if (prices.size === 1) return { price: [...prices][0], previous: false };
    // 商品の同定・取得が成功したうえで現在の定期便価格だけがない場合に限る。
    if (!historyUrl || new URL(historyUrl).searchParams.get("subscriptionId") !== item.id) throw new Error("Missing price history");
    const orderUrl = await readPage(historyUrl, "history");
    const price = await readPage(orderUrl, "order", asin);
    return { price, previous: true };
  }

  async function totalItems(items, expected, manageUrl) {
    if (!items.length || expected === null || expected !== items.length) throw new Error("Incomplete delivery");
    if (items.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity < 1)) throw new Error("Quantity");
    const values = await Promise.all(items.map(async (item) => {
      const result = item.price === null ? await referencePrice(item, manageUrl) : { price: item.price, previous: false };
      return { amount: result.price * item.quantity, previous: result.previous };
    }));
    const total = values.reduce((sum, value) => sum + value.amount, 0);
    if (!Number.isFinite(total) || total <= 0) throw new Error("Total");
    return { total, reference: items.some((item) => item.price === null), previous: values.some((value) => value.previous) };
  }

  function renderAsync(owner, target, signature, work) {
    let state = states.get(owner);
    if (!state || state.signature !== signature) {
      state = { signature, status: "loading" };
      states.set(owner, state);
      const token = generation;
      Promise.resolve().then(work).then((result) => {
        if (current(token) && owner.isConnected && states.get(owner) === state) Object.assign(state, result, { status: "ready" });
      }, () => {
        if (current(token) && states.get(owner) === state) state.status = "failed";
      }).finally(() => { if (current(token)) runner.scheduleRender(); });
    }
    showTotal(target, state);
  }

  function renderAllTotals() {
    if (!enabled || pageUrl !== location.href) return;
    for (const section of document.querySelectorAll(C.SECTION_SELECTOR)) {
      const target = section.querySelector(C.INSERT_TARGET_SELECTOR);
      // 従来画面の価格ノードだけでは全明細の読込完了・単価と数量を確認できない。
      // 価格が一部だけ描画されていても、部分合計を確定額として表示しない。
      if (target) showTotal(target, { status: "failed" });
    }
    const overview = [];
    const priorKnownUrls = new Set(manageVersions.keys());
    const changedUrls = new Set();
    for (const card of document.querySelectorAll(C.OVERVIEW_CARD_SELECTOR)) {
      const urls = new Map();
      for (const link of card.querySelectorAll("a[href]")) {
        try {
          const url = checkedUrl(link.getAttribute("href"), "manage");
          if (url.searchParams.get("deliveryBundleId") === card.id) urls.set(url.href, url);
        } catch { /* 管理リンク以外は無視。 */ }
      }
      if (urls.size !== 1) { showTotal(card, { status: "failed" }); continue; }
      const url = [...urls.keys()][0];
      const source = `${card.id}|${url}|${card.textContent.replace(card.querySelector(`.${C.TOTAL_ROOT_CLASS}`)?.textContent ?? "", "")}`;
      const previous = overviewSources.get(card);
      if ((previous !== undefined && previous !== source)
        || (previous === undefined && priorKnownUrls.has(url))) changedUrls.add(url);
      if (!manageVersions.has(url)) manageVersions.set(url, 0);
      overviewSources.set(card, source);
      overview.push({ card, url, source });
    }
    // ノード置換・再追加も更新として扱い、同じ URL の失効は走査ごとに一度にまとめる。
    for (const url of changedUrls) {
      requests.delete(url);
      manageVersions.set(url, manageVersions.get(url) + 1);
    }
    // 全カードの変更検出後に世代を読む。同じ URL を共有するカードにも失効を反映する。
    for (const { card, url, source } of overview) {
      const signature = `${manageVersions.get(url) ?? 0}|${source}`;
      renderAsync(card, card, signature, async () => {
        const detail = await readPage(url, "manage");
        return totalItems(detail.items, detail.expected, url);
      });
    }
    const items = detailItems(document);
    const expected = expectedCount(document);
    const pageSignature = JSON.stringify([location.href, expected, items]);
    for (const section of document.querySelectorAll(C.DELIVERY_SECTION_SELECTOR)) {
      const target = section.querySelector(C.DELIVERY_TARGET_SELECTOR);
      if (!target) continue;
      const own = [...section.querySelectorAll(C.DELIVERY_ITEM_SELECTOR)].map(itemData);
      // 画面全体の件数で読込完了を確認し、配送ごとの単価×数量を計算する。
      const complete = expected !== null && expected === items.length;
      const signature = `${pageSignature}|${JSON.stringify(own)}`;
      renderAsync(section, target, signature, () => {
        if (!complete) throw new Error("Incomplete delivery");
        return totalItems(own, own.length, location.href);
      });
    }
  }

  function showTotal(target, state) {
    const rootClass = C.TOTAL_ROOT_CLASS;
    let root = [...target.children].find((node) => node.classList.contains(rootClass));
    if (!root) {
      root = document.createElement("div");
      root.className = rootClass;
      root.setAttribute("role", "note");
      target.append(root);
    }
    const msg = (key, fallback) => ScanRunner.safeMsg(key, fallback);
    const ready = state.status === "ready";
    const label = ready ? (state.previous ? msg("amazonTotalPreviousReference", "参考合計（前回価格を含む）")
      : state.reference ? msg("amazonTotalReference", "参考合計（現在価格）") : msg("amazonTotalText", "合計金額"))
      : state.status === "loading" ? msg("amazonTotalLoading", "合計金額を取得中…") : msg("amazonTotalUnavailable", "合計金額を取得できませんでした");
    const description = state.reference ? msg("amazonTotalReferenceNote", "請求額は変わる場合があります") : "";
    const fingerprint = JSON.stringify([label, ready ? state.total : null, description]);
    if (root.dataset.value === fingerprint) return;
    root.dataset.value = fingerprint;
    root.replaceChildren();
    const inner = document.createElement("div");
    inner.className = `${rootClass}__inner`;
    const text = document.createElement("span");
    text.className = `${rootClass}__txt`;
    text.textContent = label;
    inner.append(text);
    if (ready) {
      const price = document.createElement("span");
      price.className = `${rootClass}__price`;
      price.textContent = `¥${state.total.toLocaleString()}`;
      inner.append(price);
    }
    root.append(inner);
    if (description) {
      const note = document.createElement("div");
      note.className = `${rootClass}__note`;
      note.textContent = description;
      root.append(note);
    }
  }
})();
