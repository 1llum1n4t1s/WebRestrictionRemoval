"use strict";

/**
 * Amazon 商品ページ「この商品が所属するランキングへ移動」ボタン content script。
 *
 * Amazon の商品詳細欄にある「Amazon 売れ筋ランキング」リンクは商品ページごとに出現位置が
 * バラバラで探しにくい。これを商品ページ上部の目立つボタンに集約し、ワンクリックで
 * 「この商品が所属する一番細かいサブカテゴリ」のランキングへ（同じタブで）移動できるようにする。
 *
 * 設計判断:
 *   - master トグル `amazonRankingJumpEnabled` で制御（オプトイン・デフォルト OFF）。OFF でボタン撤去
 *   - top frame 限定（広告 iframe 等で副作用を出さないため）
 *   - 商品詳細コンテナ (id ベース) の中の `a[href*="bestsellers/"]` だけを走査するので、
 *     カテゴリページ等の無関係なベストセラーリンクを拾わず商品ページでのみボタンを出す（自己ゲート）
 *   - 移動先選定は AmazonRankingJump.selectTargetHref と同じロジック（細かいサブカテゴリ優先）
 *   - `<a href>` を生成して挿入するので、同じタブ移動はブラウザ標準ナビゲーションに任せる（独自 JS なし）
 *   - 外部送信ゼロ・純粋 DOM 操作。価格・履歴等の取得は一切行わない
 *   - MutationObserver で遅延読み込みされる商品詳細欄に追従。自分の DOM 書き込みによる再発火は
 *     disconnect → render → takeRecords → observe のガード + rAF coalesce で抑える（定期おトク便と同型）
 *   - 拡張機能リロード後の orphan content script は context invalidation guard で自停止する
 */

(() => {
  if (window.__cpaAmazonRankingJumpRunning) return;
  window.__cpaAmazonRankingJumpRunning = true;
  if (window !== window.top) return;

  /** 注入したボタン要素（差分更新で再利用） */
  let buttonEl = null;

  const ROOT = AmazonRankingJump.ROOT_CLASS;

  // /rere B1-007/B2-I002/D-002 修正: rAF coalesce + observer guard + context invalidation guard を
  // ScanRunner (src/lib/scan-runner.js) に集約。本ファイルは render / cleanup のみ残す。
  const runner = ScanRunner.create({
    render: scanAndRender,
    cleanup: removeButton,
  });

  // ---------- 状態購読 ----------
  chrome.storage.local
    .get(StorageKeys.AMAZON_RANKING_JUMP_ENABLED)
    .then((stored) => {
      apply(stored[StorageKeys.AMAZON_RANKING_JUMP_ENABLED] === true);
    })
    .catch(() => {});

  chrome.runtime.onMessage.addListener((request, sender) => {
    if (!SenderCheck.isFromBackground(sender)) return;
    if (request?.action !== Actions.APPLY_AMAZON_RANKING_JUMP_CS) return;
    apply(request.data?.enabled === true);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (StorageKeys.AMAZON_RANKING_JUMP_ENABLED in changes) {
      apply(changes[StorageKeys.AMAZON_RANKING_JUMP_ENABLED].newValue === true);
    }
  });

  function apply(enabled) {
    if (enabled) runner.start();
    else runner.stop();
  }

  // ---------- 検出 ----------

  /**
   * 商品詳細コンテナ内の売れ筋ランキングリンクを集め、移動先アンカーを 1 つ選ぶ。
   * 「一番細かいサブカテゴリ」= ノード id を持つサブカテゴリリンクのうち DOM 上で最後のもの。
   * @returns {HTMLAnchorElement|null}
   */
  function findTargetAnchor() {
    const anchors = [];
    for (const sel of AmazonRankingJump.DETAIL_CONTAINER_SELECTORS) {
      const container = document.querySelector(sel);
      if (!container) continue;
      container
        .querySelectorAll(AmazonRankingJump.BESTSELLER_LINK_SELECTOR)
        .forEach((a) => {
          if (a.href) anchors.push(a);
        });
    }
    if (anchors.length === 0) return null;
    const subs = anchors.filter((a) => AmazonRankingJump.isSubcategoryHref(a.href));
    const pool = subs.length > 0 ? subs : anchors;
    return pool[pool.length - 1] ?? null;
  }

  function scanAndRender() {
    const target = findTargetAnchor();
    if (!target) {
      // 商品ページでない / ランキング欄が未出現 → ボタンは出さない（既存があれば撤去）。
      // buttonEl が無い通常の非商品ページでは sweep を走らせず、busy ページの per-frame コストを抑える。
      if (buttonEl) removeButton();
      return;
    }
    upsertButton(target.href, (target.textContent || "").trim());
  }

  // ---------- レンダリング ----------

  function upsertButton(href, categoryName) {
    if (!buttonEl) buttonEl = buildButton();
    if (!buttonEl.isConnected) placeButton(buttonEl);
    if (buttonEl.getAttribute("href") !== href) buttonEl.setAttribute("href", href);

    const catEl = buttonEl.querySelector(`.${ROOT}__cat`);
    if (catEl) {
      const next = categoryName || "";
      if (catEl.textContent !== next) catEl.textContent = next;
      catEl.classList.toggle("hidden", next.length === 0);
    }
  }

  function buildButton() {
    const a = document.createElement("a");
    a.className = ROOT;
    // 同一オリジンの Amazon ランキングページへ同じタブで移動（ブラウザ標準ナビゲーション）。
    a.setAttribute("role", "button");
    a.setAttribute(
      "aria-label",
      safeMsg("amazonRankingJumpAriaLabel", "この商品が所属するランキングへ移動")
    );

    const icon = document.createElement("span");
    icon.className = `${ROOT}__icon`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "🏆";

    const text = document.createElement("span");
    text.className = `${ROOT}__text`;

    const title = document.createElement("span");
    title.className = `${ROOT}__title`;
    title.textContent = safeMsg("amazonRankingJumpButton", "この商品が所属するランキングへ移動");

    const cat = document.createElement("span");
    cat.className = `${ROOT}__cat hidden`;

    text.append(title, cat);
    a.append(icon, text);
    return a;
  }

  /**
   * ボタンを商品情報の最上部に挿入する。商品タイトルの直前を第一候補にし、
   * 見つからない場合は中央カラム → 商品コンテナ → body の順でフォールバックする。
   */
  function placeButton(btn) {
    const title = document.querySelector("#title_feature_div");
    if (title && title.parentElement) {
      title.parentElement.insertBefore(btn, title);
      return;
    }
    for (const sel of ["#centerCol", "#dp-container", "#ppd", "#dp"]) {
      const container = document.querySelector(sel);
      if (container) {
        container.insertBefore(btn, container.firstChild);
        return;
      }
    }
    document.body.insertBefore(btn, document.body.firstChild);
  }

  function removeButton() {
    if (buttonEl) {
      try { buttonEl.remove(); } catch {}
      buttonEl = null;
    }
    // 念のため DOM 上の残骸も掃除（多重ロード時の保険）
    document.querySelectorAll(`.${ROOT}`).forEach((el) => el.remove());
  }

  /** context invalidation 後でも throw しない i18n 取得。 */
  function safeMsg(key, fallback) {
    try {
      return chrome.i18n.getMessage(key) || fallback;
    } catch {
      return fallback;
    }
  }
})();
