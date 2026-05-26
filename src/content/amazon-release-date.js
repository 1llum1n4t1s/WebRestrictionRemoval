"use strict";

/**
 * Amazon 商品ページ「取り扱い開始日」表示 content script。
 *
 * 商品詳細欄（`#detailBullets_feature_div` 等）から「取り扱い開始日」項目を抽出し、
 * 商品情報の最上部に **クリック不可の情報パネル**（`<span>` ベース）を挿入する。
 * 既存の「ランキングへ移動」ボタンが存在する場合はその右側に並べ、両機能 ON で横並びになる。
 *
 * 設計判断（AmazonRankingJump と同型）:
 *   - master トグル `amazonReleaseDateEnabled` で制御（オプトイン・デフォルト OFF）
 *   - top frame 限定（広告 iframe で副作用を出さない）
 *   - 商品詳細コンテナ (id ベース) の中だけを走査して商品ページで自己ゲート
 *   - 純粋関数 (`AmazonReleaseDate.parseReleaseDateText` / `diffRelative` / `formatReleaseDate`) で
 *     パース・相対年月計算をテスト可能化（test/actions.test.js）
 *   - クリック不可（`<span>`）。`role="img"` + `aria-label` で SR ユーザーに読み上げる
 *   - 外部送信ゼロ・純粋 DOM 操作
 *   - MutationObserver の disconnect → render → takeRecords → observe ガード + rAF coalesce
 *     で自己 DOM 書き戻しの無限ループを防ぐ
 *   - 拡張機能リロード後の orphan content script は context invalidation guard で自停止
 */

(() => {
  if (window.__cpaAmazonReleaseDateRunning) return;
  window.__cpaAmazonReleaseDateRunning = true;
  if (window !== window.top) return;

  /** @type {boolean} 機能 ON/OFF */
  let active = false;
  /** @type {MutationObserver|null} */
  let observer = null;
  /** rAF 連続抑制用フラグ */
  let scanScheduled = false;
  /** rAF id（cancel 用） */
  let rafHandle = 0;
  /** 注入したパネル要素（差分更新で再利用） */
  let panelEl = null;
  /** 拡張機能 reload 後の orphan content script 検出フラグ */
  let contextInvalidated = false;

  const OBSERVE_OPTIONS = { childList: true, subtree: true };
  const ROOT = AmazonReleaseDate.ROOT_CLASS;
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
    .get(StorageKeys.AMAZON_RELEASE_DATE_ENABLED)
    .then((stored) => {
      apply(stored[StorageKeys.AMAZON_RELEASE_DATE_ENABLED] === true);
    })
    .catch(() => {});

  chrome.runtime.onMessage.addListener((request, sender) => {
    if (!SenderCheck.isFromBackground(sender)) return;
    if (request?.action !== Actions.APPLY_AMAZON_RELEASE_DATE_CS) return;
    apply(request.data?.enabled === true);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (StorageKeys.AMAZON_RELEASE_DATE_ENABLED in changes) {
      apply(changes[StorageKeys.AMAZON_RELEASE_DATE_ENABLED].newValue === true);
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
   * 商品詳細コンテナ内から「取り扱い開始日」項目の日付テキストを抽出する。
   *   - bullet list 形式: `<span class="a-text-bold">取り扱い開始日 ...</span><span>2023/1/15</span>`
   *   - テーブル形式:     `<th>取り扱い開始日</th><td>2023/1/15</td>`
   * いずれも `LABEL_KEYWORDS` のいずれかをラベル要素のテキストに含むかで判定し、
   * 兄弟または同 row の値要素テキストを返す。
   *
   * @returns {string|null}
   */
  function findReleaseDateText() {
    const keywords = AmazonReleaseDate.LABEL_KEYWORDS;
    for (const sel of AmazonReleaseDate.DETAIL_CONTAINER_SELECTORS) {
      const container = document.querySelector(sel);
      if (!container) continue;

      // パターン A: bullet list（<span class="a-text-bold">ラベル</span><span>値</span>）
      const bulletLabels = container.querySelectorAll("span.a-text-bold, span.a-list-item span");
      for (const label of bulletLabels) {
        const txt = (label.textContent || "").trim();
        if (!keywords.some((k) => txt.includes(k))) continue;
        // a-text-bold の次の span を値として採用
        const parent = label.closest("span.a-list-item") || label.parentElement;
        if (!parent) continue;
        const valueSpan = label.nextElementSibling
          || parent.querySelector("span:not(.a-text-bold)");
        if (valueSpan && valueSpan !== label) {
          const v = (valueSpan.textContent || "").trim();
          if (v.length > 0) return v;
        }
      }

      // パターン B: テーブル形式（<th>ラベル</th><td>値</td>）
      const ths = container.querySelectorAll("th");
      for (const th of ths) {
        const txt = (th.textContent || "").trim();
        if (!keywords.some((k) => txt.includes(k))) continue;
        const td = th.parentElement?.querySelector("td");
        if (td) {
          const v = (td.textContent || "").trim();
          if (v.length > 0) return v;
        }
      }
    }
    return null;
  }

  function scanAndRender() {
    const rawText = findReleaseDateText();
    if (!rawText) {
      if (panelEl) removePanel();
      return;
    }
    const date = AmazonReleaseDate.parseReleaseDateText(rawText);
    if (!date) {
      if (panelEl) removePanel();
      return;
    }
    const formatted = AmazonReleaseDate.formatReleaseDate(date);
    const diff = AmazonReleaseDate.diffRelative(date, new Date());
    upsertPanel(formatted, buildRelativeText(diff));
  }

  /**
   * `diffRelative` の構造化結果から i18n メッセージを組み立てる。
   * context invalidation 後でも throw しないよう safeMsg + placeholder 自前展開。
   */
  function buildRelativeText(diff) {
    if (!diff) return "";
    switch (diff.kind) {
      case "future":
        return safeMsg("amazonReleaseDateRelativeFuture", "発売前");
      case "today":
        return safeMsg("amazonReleaseDateRelativeToday", "本日");
      case "days":
        return safeMsg("amazonReleaseDateRelativeDays", "$N$ 日前").replace("$N$", String(diff.days));
      case "months":
        return safeMsg("amazonReleaseDateRelativeMonths", "$N$ ヶ月前").replace("$N$", String(diff.months));
      case "years":
        return safeMsg("amazonReleaseDateRelativeYears", "約 $N$ 年前").replace("$N$", String(diff.years));
      case "yearsMonths":
        return safeMsg("amazonReleaseDateRelativeYearsMonths", "約 $Y$ 年 $M$ ヶ月前")
          .replace("$Y$", String(diff.years))
          .replace("$M$", String(diff.months));
      default:
        return "";
    }
  }

  // ---------- レンダリング ----------

  function upsertPanel(dateText, relativeText) {
    if (!panelEl) panelEl = buildPanel();
    if (!panelEl.isConnected) placePanel(panelEl);

    const dateEl = panelEl.querySelector(`.${ROOT}__date`);
    if (dateEl) {
      const next = safeMsg("amazonReleaseDateTitle", "取り扱い開始") + ": " + dateText;
      if (dateEl.textContent !== next) dateEl.textContent = next;
    }
    const relEl = panelEl.querySelector(`.${ROOT}__rel`);
    if (relEl) {
      const next = relativeText || "";
      if (relEl.textContent !== next) relEl.textContent = next;
      relEl.classList.toggle("hidden", next.length === 0);
    }

    // aria-label を「取り扱い開始: 2023/1/15 (約 2 年前)」のような完全形に更新
    const aria = relativeText
      ? `${safeMsg("amazonReleaseDateTitle", "取り扱い開始")}: ${dateText} (${relativeText})`
      : `${safeMsg("amazonReleaseDateTitle", "取り扱い開始")}: ${dateText}`;
    if (panelEl.getAttribute("aria-label") !== aria) {
      panelEl.setAttribute("aria-label", aria);
    }
  }

  function buildPanel() {
    // クリック不可の情報パネル。ranking 移動ボタンと同色だが <span> ベース + cursor:default。
    const root = document.createElement("span");
    root.className = ROOT;
    root.setAttribute("role", "img");

    const icon = document.createElement("span");
    icon.className = `${ROOT}__icon`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📅";

    const text = document.createElement("span");
    text.className = `${ROOT}__text`;

    const date = document.createElement("span");
    date.className = `${ROOT}__date`;

    const rel = document.createElement("span");
    rel.className = `${ROOT}__rel hidden`;

    text.append(date, rel);
    root.append(icon, text);
    return root;
  }

  /**
   * パネルを挿入する。第一候補: 既存のランキングボタンの直後（横並び）。
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
