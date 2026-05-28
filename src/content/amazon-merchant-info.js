"use strict";

/**
 * Amazon 商品ページ「販売元・出荷元バッジ」content script。
 *
 * `#merchantInfoFeature_feature_div` / `#fulfillerInfoFeature_feature_div` の 2 つの隠し div から
 * 販売元・出荷元の値を抽出し、商品情報の最上部に **クリック不可の情報バッジ**（`<span>` ベース）を
 * 挿入する。既存の「ランキングへ移動」ボタンが存在する場合はその右側に並べ、両機能 ON で横並びになる。
 *
 * 設計判断（AmazonRankingJump と同型）:
 *   - master トグル `amazonMerchantInfoEnabled` で制御（オプトイン・デフォルト OFF）
 *   - top frame 限定（広告 iframe で副作用を出さない）
 *   - `#merchantInfoFeature_feature_div` の存在で商品ページを自己ゲート
 *   - 純粋関数 `AmazonMerchantInfo.parseIsInternal` / `isAmazonOwnedName` は actions.js で
 *     test/actions.test.js から境界値テスト可能化
 *   - 表示は「販売: XXX / 出荷: YYY」の 2 段。Amazon 直販=緑バッジ / マーケット=オレンジ警告バッジ
 *   - 直販判定は (1) merchant-stats script の JSON `isInternal` を最優先、(2) 取れなければ販売元名で推定
 *   - クリック不可（`<span role="img">`）。`aria-label` で完全形をスクリーンリーダーに読み上げる
 *   - 外部送信ゼロ・純粋 DOM 操作
 *   - MutationObserver の disconnect → render → takeRecords → observe ガード + rAF coalesce
 *     で自己 DOM 書き戻しの無限ループを防ぐ
 *   - 拡張機能リロード後の orphan content script は context invalidation guard で自停止
 */

(() => {
  if (window.__cpaAmazonMerchantInfoRunning) return;
  window.__cpaAmazonMerchantInfoRunning = true;
  if (window !== window.top) return;

  /** @type {boolean} 機能 ON/OFF */
  let active = false;
  /** @type {MutationObserver|null} */
  let observer = null;
  /** rAF 連続抑制用フラグ */
  let scanScheduled = false;
  /** rAF id（cancel 用） */
  let rafHandle = 0;
  /** 注入したバッジ要素（差分更新で再利用） */
  let panelEl = null;
  /** 拡張機能 reload 後の orphan content script 検出フラグ */
  let contextInvalidated = false;

  const OBSERVE_OPTIONS = { childList: true, subtree: true };
  const ROOT = AmazonMerchantInfo.ROOT_CLASS;
  /** 隣に並べる相棒（既存のランキング移動ボタン）の root クラス。 */
  const RANKING_ROOT = AmazonRankingJump.ROOT_CLASS;

  function checkContextInvalidated() {
    if (contextInvalidated) return true;
    try {
      if (!chrome.runtime || !chrome.runtime.id) contextInvalidated = true;
    } catch {
      contextInvalidated = true;
    }
    if (contextInvalidated) {
      stopObserver();
      active = false;
      try { removePanel(); } catch {}
    }
    return contextInvalidated;
  }

  // ---------- 状態購読 ----------
  chrome.storage.local
    .get(StorageKeys.AMAZON_MERCHANT_INFO_ENABLED)
    .then((stored) => {
      apply(stored[StorageKeys.AMAZON_MERCHANT_INFO_ENABLED] === true);
    })
    .catch(() => {});

  chrome.runtime.onMessage.addListener((request, sender) => {
    if (!SenderCheck.isFromBackground(sender)) return;
    if (request?.action !== Actions.APPLY_AMAZON_MERCHANT_INFO_CS) return;
    apply(request.data?.enabled === true);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (StorageKeys.AMAZON_MERCHANT_INFO_ENABLED in changes) {
      apply(changes[StorageKeys.AMAZON_MERCHANT_INFO_ENABLED].newValue === true);
    }
  });

  function apply(enabled) {
    if (enabled === active) return;
    active = enabled;
    if (enabled) {
      startObserver();
      scheduleScan();
    } else {
      stopObserver();
      removePanel();
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body || document.documentElement, OBSERVE_OPTIONS);
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

  function scheduleScan() {
    if (scanScheduled) return;
    if (checkContextInvalidated()) return;
    scanScheduled = true;
    rafHandle = requestAnimationFrame(() => {
      scanScheduled = false;
      rafHandle = 0;
      if (!active) return;
      if (checkContextInvalidated()) return;
      runScanInsideObserverGuard();
    });
  }

  function runScanInsideObserverGuard() {
    if (!observer) {
      scanAndRender();
      return;
    }
    observer.disconnect();
    try {
      scanAndRender();
    } finally {
      observer.takeRecords();
      observer.observe(document.body || document.documentElement, OBSERVE_OPTIONS);
    }
  }

  // ---------- 検出 ----------

  /**
   * 隠し div から「先頭の値テキスト」を取り出す。
   *   - Amazon は同じ値を 2 つの span に書く設計（compact 表示用と popover 用）が多い
   *   - 最初の `span.offer-display-feature-text-message` の textContent を採用
   *   - 取れない場合は textContent 全体から後段で抽出（fallback 経路は使わず null）
   */
  function readValue(divId) {
    const div = document.getElementById(divId);
    if (!div) return null;
    const span = div.querySelector(AmazonMerchantInfo.VALUE_SELECTOR);
    if (!span) return null;
    const v = (span.textContent || "").trim();
    return v.length > 0 ? v : null;
  }

  /**
   * `#merchantInfoFeature_feature_div` 内の script 要素を全部走査し、
   * `parseIsInternal` で boolean が取れた最初の値を返す。複数 script がある場合は最初のヒット優先。
   * @returns {boolean|null}
   */
  function readIsInternal() {
    const div = document.getElementById(AmazonMerchantInfo.MERCHANT_DIV_ID);
    if (!div) return null;
    const scripts = div.querySelectorAll("script");
    for (const s of scripts) {
      const v = AmazonMerchantInfo.parseIsInternal(s.textContent || "");
      if (typeof v === "boolean") return v;
    }
    return null;
  }

  function scanAndRender() {
    const seller = readValue(AmazonMerchantInfo.MERCHANT_DIV_ID);
    if (!seller) {
      if (panelEl) removePanel();
      return;
    }
    // 出荷元は fulfillerInfoFeature にあるが、Amazon 直販で出荷元が省略されているケースが多い。
    // その場合は「販売元 = 出荷元」と推定（Amazon が同じ値で 1 値集約表示しているのと整合）。
    const shipper = readValue(AmazonMerchantInfo.FULFILLER_DIV_ID) || seller;

    // 直販判定: isInternal フラグを最優先（Amazon 自身が出す信頼できるフラグ）
    let isAmazon = readIsInternal();
    // script 欠落時の保険判定: 販売元名に Amazon が含まれていれば直販と推定
    if (isAmazon === null) {
      isAmazon = AmazonMerchantInfo.isAmazonOwnedName(seller);
    }

    upsertPanel(seller, shipper, isAmazon);
  }

  // ---------- レンダリング ----------

  function upsertPanel(seller, shipper, isAmazon) {
    if (!panelEl) panelEl = buildPanel();
    if (!panelEl.isConnected) placePanel(panelEl);

    // variant 切替（CSS の data-variant attribute selector で色変更）
    const variant = isAmazon ? "amazon" : "marketplace";
    if (panelEl.getAttribute("data-variant") !== variant) {
      panelEl.setAttribute("data-variant", variant);
    }

    // アイコン: Amazon 直販=📦 / マーケット=🛒
    const iconEl = panelEl.querySelector(`.${ROOT}__icon`);
    if (iconEl) {
      const nextIcon = isAmazon ? "📦" : "🛒";
      if (iconEl.textContent !== nextIcon) iconEl.textContent = nextIcon;
    }

    // 販売: XXX
    const sellerEl = panelEl.querySelector(`.${ROOT}__seller`);
    if (sellerEl) {
      const next = safeMsg("amazonMerchantInfoSoldBy", "販売") + ": " + seller;
      if (sellerEl.textContent !== next) sellerEl.textContent = next;
    }

    // 出荷: YYY
    const shipperEl = panelEl.querySelector(`.${ROOT}__shipper`);
    if (shipperEl) {
      const next = safeMsg("amazonMerchantInfoShipsFrom", "出荷") + ": " + shipper;
      if (shipperEl.textContent !== next) shipperEl.textContent = next;
    }

    // aria-label を「Amazon 直販: 販売 XXX / 出荷 YYY」のような完全形に更新
    const variantLabel = isAmazon
      ? safeMsg("amazonMerchantInfoAriaAmazon", "Amazon 直販")
      : safeMsg("amazonMerchantInfoAriaMarketplace", "マーケット出品");
    const aria = `${variantLabel}: ${safeMsg("amazonMerchantInfoSoldBy", "販売")} ${seller} / ${safeMsg("amazonMerchantInfoShipsFrom", "出荷")} ${shipper}`;
    if (panelEl.getAttribute("aria-label") !== aria) {
      panelEl.setAttribute("aria-label", aria);
    }
  }

  function buildPanel() {
    // クリック不可の情報バッジ。<span> ベース + cursor:default。
    const root = document.createElement("span");
    root.className = ROOT;
    root.setAttribute("role", "img");
    root.setAttribute("data-variant", "amazon"); // 初期は仮設定（upsertPanel で上書き）

    const icon = document.createElement("span");
    icon.className = `${ROOT}__icon`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📦";

    const text = document.createElement("span");
    text.className = `${ROOT}__text`;

    const seller = document.createElement("span");
    seller.className = `${ROOT}__seller`;

    const shipper = document.createElement("span");
    shipper.className = `${ROOT}__shipper`;

    text.append(seller, shipper);
    root.append(icon, text);
    return root;
  }

  /**
   * バッジを挿入する。第一候補: 既存のランキングボタンの直後（横並び）。
   * 第二候補: ranking と同型の挿入位置（タイトル直前 → centerCol 先頭 → body 先頭）。
   */
  function placePanel(panel) {
    const ranking = document.querySelector(`.${RANKING_ROOT}`);
    if (ranking && ranking.parentElement) {
      ranking.insertAdjacentElement("afterend", panel);
      return;
    }
    const title = document.querySelector("#title_feature_div");
    if (title && title.parentElement) {
      title.parentElement.insertBefore(panel, title);
      return;
    }
    for (const sel of ["#centerCol", "#dp-container", "#ppd", "#dp"]) {
      const container = document.querySelector(sel);
      if (container) {
        container.insertBefore(panel, container.firstChild);
        return;
      }
    }
    document.body.insertBefore(panel, document.body.firstChild);
  }

  function removePanel() {
    if (panelEl) {
      try { panelEl.remove(); } catch {}
      panelEl = null;
    }
    document.querySelectorAll(`.${ROOT}`).forEach((el) => el.remove());
  }

  function safeMsg(key, fallback) {
    try {
      return chrome.i18n.getMessage(key) || fallback;
    } catch {
      return fallback;
    }
  }
})();
