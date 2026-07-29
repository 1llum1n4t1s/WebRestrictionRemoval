// YouTube → NotebookLM 送信
//
// 視聴中の動画 / 検索結果 / プレイリスト / チャンネルの動画を、ユーザー自身の Google アカウントの
// NotebookLM にソースとして追加する。`*://*.youtube.com/*` の top frame のみで動作する。
//
// 有効化は YouTube 機能拡張のサブ機能として制御する: master `searchFixerEnabled` AND
// `searchFixerFeatures.notebookLmSend` の両方 true で activate（独立 storage key は持たず、
// APPLY_SEARCH_FIXER_CS を search-fixer.js / youtube-shorts.js / youtube-connection-monitor.js /
// youtube-broadcast-clock.js と共に購読する）。
//
// UI: **YouTube のページ内**にボタンを挿し込む（参考にした拡張機能と同じ配置に合わせてある）。
//   - /watch          … 高評価 / 共有の行（`#actions`）の先頭、右寄せ
//   - /results        … 検索フィルタボタンの隣、左寄せ
//   - /playlist・チャンネル … タイトル見出しの行、右寄せ
// アンカーは `BUTTON_ANCHORS` に集約し、上から順に試して最初に見つかったものの直前へ挿入する。
// アンカーが未描画なら挿さずに待ち、MutationObserver の次の走査で再試行する。
// ノートブック選択ポップオーバーは祖先の overflow で切れないよう body 直下の `position: fixed`
// に置き、ボタンの実座標から位置を計算する。
//
// 通信: NotebookLM の RPC は cross-origin のため background が担当する（本 cs は
// NOTEBOOK_LM_LIST / NOTEBOOK_LM_SEND を投げるだけ）。**送信はユーザーがボタンを押した
// ときだけ**で、バックグラウンド送信や視聴履歴の収集は行わない。
//
// 設計上の不変条件（youtube-broadcast-clock.js PATTERN SYNC）:
//   - master OFF / サブ機能 OFF / 非対象ページ / SPA 離脱時は UI・listener を撤去
//   - top frame 限定、`window.__cpaNotebookLmRunning` で二重実行防止
//   - context invalidation 後は MutationObserver / listener を必ず解除
//   - readSettingsAndApply は applyInFlight/applyQueued で直列化（activate/deactivate の race 防止）
//   - DOM 構築は createElement ベース（YouTube の Trusted Types 対応）

(() => {
  if (window.__cpaNotebookLmRunning) return;
  window.__cpaNotebookLmRunning = true;

  if (window !== window.top) return;
  if (!chrome?.runtime?.id) return;

  // ---------- 定数 ----------
  const ROOT_CLASS = "__cpa-nlm-root";
  const BTN_CLASS = "__cpa-nlm-btn";
  const PANEL_CLASS = "__cpa-nlm-panel";
  /** DOM 再スキャンの rAF coalesce 間隔を超えて連打しないための最小間隔（件数ラベル更新用）。 */
  const COUNT_REFRESH_MS = 800;
  /** rAF が発火しない環境（バックグラウンドタブ）で走査を保証するフォールバック間隔。 */
  const RESCAN_FALLBACK_MS = 250;

  // ---------- 状態 ----------
  /** @type {HTMLElement | null} */ let rootEl = null;
  /** @type {HTMLButtonElement | null} */ let btnEl = null;
  /** @type {HTMLElement | null} */ let panelEl = null;
  /** @type {MutationObserver | null} */ let mutationObserver = null;
  let active = false;
  let applyInFlight = false;
  let applyQueued = false;
  let rescanScheduled = false;
  let lastCountAt = 0;
  /** @type {number|null} スロットル窓の末尾で 1 回だけ件数を再計算するタイマー */
  let trailingCountTimer = null;
  /** @type {number|null} rAF が来ない（バックグラウンドタブ）ときに走査を保証するタイマー */
  let rescanFallbackTimer = null;
  let sending = false;
  /** @type {Array<{id: string, name: string, sources: number, emoji: string}> | null} 取得済みノートブック一覧 */
  let notebooks = null;
  /** 送信先の Google アカウント (`authuser`)。マルチログイン環境での誤送信対策（/rere D-5） */
  let accountIndex = 0;
  /** @type {Array<{index: number, email: string}> | null} ログイン中アカウント（取得できるまで null） */
  let accounts = null;
  /** @type {"loading"|"list"|"error"} パネルの表示状態（後から届いたデータで誤って上書きしないため） */
  let panelState = "loading";
  /** ボタンを実際に置けたときに 1 回だけ走る送信先の事前取得（初回クリックの待ちを消す） */
  let prefetchStarted = false;

  // ---------- ユーティリティ ----------


  /** chrome.i18n.getMessage の薄いラッパ（orphan 化後も throw しない） */
  function i18n(key, fallback) {
    try {
      if (chrome?.i18n?.getMessage) {
        const msg = chrome.i18n.getMessage(key);
        if (msg) return msg;
      }
    } catch {}
    return fallback ?? "";
  }

  // ---------- 対象ページ判定と URL 収集 ----------

  /**
   * 現在のページがどの送信パターンに当たるかを返す。
   * @returns {"watch"|"results"|"playlist"|"channel"|null}
   */
  function detectPageKind() {
    const path = location.pathname;
    if (path === "/watch") return "watch";
    if (path === "/results") return "results";
    if (path === "/playlist") return "playlist";
    // チャンネルの動画一覧（/@handle/videos, /channel/UC.../streams など）
    if (/^\/(?:@[^/]+|channel\/UC[\w-]+|c\/[^/]+|user\/[^/]+)\/(?:videos|streams)$/.test(path)) {
      return "channel";
    }
    return null;
  }

  /**
   * 送信対象の watch URL を集める。
   *
   * 一括系ページでは **描画済みのカードだけ**が対象になる（YouTube は遅延読み込みなので、
   * ユーザーがスクロールした分だけ増える）。この挙動はボタンの件数表示でそのまま見えるため、
   * 「全部入っていない」と誤解されない設計にしてある。
   *
   * @param {"watch"|"results"|"playlist"|"channel"} kind
   * @returns {string[]} 正規化済み watch URL（重複除去済み、MAX_COLLECT 件で打ち切り）
   */
  function collectUrls(kind) {
    if (kind === "watch") {
      const url = NotebookLm.normalizeWatchUrl(location.href);
      return url ? [url] : [];
    }
    // 検索結果 / チャンネル (ytd-browse, ytd-search) の本文カラムのみを対象にする。
    // 視聴ページの関連動画 (ytd-watch-next-secondary-results-renderer) は kind !== "watch" では
    // そもそも描画されないが、スコープを絞って将来のレイアウト変更にも巻き込まれないようにする。
    const anchors = document.querySelectorAll(
      'ytd-search #contents a[href*="/watch?v="], ' +
      'ytd-browse #contents a[href*="/watch?v="], ' +
      'ytd-playlist-video-list-renderer a[href*="/watch?v="]'
    );
    const out = [];
    const seen = new Set();
    for (const a of anchors) {
      const url = NotebookLm.normalizeWatchUrl(a.getAttribute("href"));
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
      if (out.length >= NotebookLm.MAX_COLLECT) break;
    }
    return out;
  }

  /** 新規ノートブックの既定タイトルをページ種別ごとに組み立てる。 */
  function buildDefaultTitle(kind) {
    const stripSuffix = (s) => String(s || "").replace(/\s*-\s*YouTube\s*$/, "").trim();
    if (kind === "results") {
      const q = new URLSearchParams(location.search).get("search_query");
      if (q) return `YouTube: ${q}`;
    }
    const title = stripSuffix(document.title);
    return title ? `YouTube: ${title}` : "YouTube";
  }

  /** ボタンのラベル（件数入り）を組み立てる。 */
  /**
   * ボタンのラベルを組み立てる。
   *
   * **文言はページ種別によらず「Gemini Notebook」で統一する**。ページ内の既存ボタン列
   * （チャンネル登録・すべて再生・高評価/共有）に混ざる位置に置くため、説明的な長い文言だと
   * 行が押し広げられて周囲のレイアウトを崩す（実機で確認 / 2026-07-29）。何が送られるかは
   * 押した先のパネルで分かるので、ボタン側は宛先名 + 件数だけに絞る。
   */
  function buildButtonLabel(kind, count) {
    const label = i18n("nlmSendLabel", "Gemini Notebook");
    // 一括系は「描画済みカードのうち何件が対象か」を示す（0 件でもボタン自体は出す設計）
    return kind === "watch" ? label : `${label} (${count})`;
  }

  // ---------- UI ----------

  /**
   * ページ種別ごとのボタン挿入位置。
   *
   * 参考にした拡張機能（YouTube to NotebookLM）と**同じアンカーと同じ寄せ方向**に合わせてある。
   * 視聴ページなら高評価 / 共有の並び、検索結果ならフィルタボタンの隣、プレイリストと
   * チャンネルならタイトル見出しの行に、YouTube 純正ボタン風の見た目で並ぶ。
   *
   * `selectors` は上から順に試し、最初に見つかったものの**直前**に挿入する。
   * アンカーがまだ描画されていない場合は挿入せず、MutationObserver の次の走査で再試行する
   * （SPA の遅延描画に強い。参考拡張は「1 秒待って 1 回だけ再取得」だが、こちらは observer 駆動）。
   */
  const BUTTON_ANCHORS = Object.freeze({
    watch: Object.freeze({
      selectors: Object.freeze([
        Object.freeze({ selector: '[role="main"] yt-button-view-model.ytd-menu-renderer' }),
        Object.freeze({ selector: "ytd-watch-metadata #actions #top-level-buttons-computed" }),
        Object.freeze({ selector: "ytd-watch-metadata #actions" }),
      ]),
      float: "right",
    }),
    results: Object.freeze({
      selectors: Object.freeze([
        Object.freeze({ selector: '[role="main"] ytd-button-renderer.ytd-search-header-renderer' }),
        Object.freeze({ selector: "ytd-search-header-renderer ytd-button-renderer" }),
      ]),
      float: "left",
    }),
    // プレイリストは「すべて再生」の行（yt-flexible-actions-view-model）の**直後**に、
    // 1 行分の幅で置く（実機で位置決め / 2026-07-26）。タイトル見出しの隣に入れると
    // 幅の狭いサイドパネルでタイトルが折り返されて読みづらくなるため。
    playlist: Object.freeze({
      selectors: Object.freeze([
        Object.freeze({ selector: '[role="main"] yt-flexible-actions-view-model', insert: "after", row: true }),
        Object.freeze({ selector: '[role="main"] .dynamic-text-view-model-wiz__h1' }),
        Object.freeze({ selector: '[role="main"] .dynamicTextViewModelH1' }),
        Object.freeze({ selector: "ytd-playlist-header-renderer h1" }),
      ]),
      float: "right",
    }),
    // チャンネルは「チャンネル登録」ボタンの直後に置く（実機で位置決め / 2026-07-27）。
    // タイトル見出しの隣（旧実装）は、ワイド画面だとヘッダー右端まで飛んでチャンネル名から
    // 1000px 以上離れ、描画されていても見つけられない。登録ボタンの並びなら視線の通り道に入る。
    channel: Object.freeze({
      selectors: Object.freeze([
        Object.freeze({
          selector: '[role="main"] yt-page-header-view-model yt-flexible-actions-view-model yt-subscribe-button-view-model',
          insert: "after",
        }),
        Object.freeze({
          selector: '[role="main"] yt-page-header-view-model yt-flexible-actions-view-model',
          insert: "after",
        }),
        Object.freeze({ selector: '[role="main"] .dynamic-text-view-model-wiz__h1' }),
        Object.freeze({ selector: '[role="main"] .dynamicTextViewModelH1' }),
        Object.freeze({ selector: "ytd-channel-name #text" }),
      ]),
      float: "none",
    }),
  });

  /**
   * 現在のページ種別に対応するアンカー要素を返す（見つからなければ null）。
   *
   * **必ず「実際に描画されている」要素を選ぶ**（実機で確定した不具合の修正 / 2026-07-26）。
   * YouTube はレイアウト variant 用の非表示要素を同じクラス名で先に置くことがあり、
   * 素朴な `querySelector` は文書順で先に来る `display: none` 側を掴んでしまう。
   * プレイリストページでは `.dynamicTextViewModelH1` が 2 つあり、1 つ目が
   * `div#header { display: none }` の中にあるため、そこに挿すとボタンが 0×0 で見えなくなる。
   * （search-fixer.js の `pickVisibleChannelName` が踏んだのと同じ罠。）
   *
   * 判定は `getClientRects().length`。`offsetParent` は `position: fixed` の要素で
   * 可視でも null になるため使わない。
   */
  function findAnchor(kind) {
    const spec = BUTTON_ANCHORS[kind];
    if (!spec) return null;
    for (const entry of spec.selectors) {
      for (const el of document.querySelectorAll(entry.selector)) {
        if (!el.isConnected) continue;
        if (el.getClientRects().length === 0) continue;
        return { el, insert: entry.insert === "after" ? "after" : "before", row: entry.row === true };
      }
    }
    return null;
  }

  function ensureUi() {
    if (rootEl) return;
    // ページ内へ挿し込む host。fixed ではなくアンカーの兄弟として置くので、
    // YouTube 側のレイアウト（flex 行 / 見出し行）にそのまま馴染む。
    rootEl = document.createElement("div");
    rootEl.className = ROOT_CLASS;

    btnEl = document.createElement("button");
    btnEl.type = "button";
    btnEl.className = BTN_CLASS;
    btnEl.setAttribute("aria-haspopup", "true");
    btnEl.setAttribute("aria-expanded", "false");
    btnEl.addEventListener("click", onButtonClick);

    rootEl.appendChild(btnEl);
    // document への挿入は syncButton がアンカーを見つけた時点で行う
  }

  function removeUi() {
    closePanel();
    try { rootEl?.remove(); } catch {}
    rootEl = null;
    btnEl = null;
  }

  /**
   * ボタンの挿入位置・寄せ方向・ラベルを現在のページ内容に同期する。
   * 対象外ページ / 送信対象ゼロ / アンカー未描画のときは DOM から取り外す。
   */
  function syncButton() {
    if (!active || !btnEl || !rootEl) return;
    const kind = detectPageKind();
    if (!kind) {
      detachButton();
      return;
    }
    const anchor = findAnchor(kind);
    if (!anchor) {
      // まだ描画されていないだけなので取り外して待つ（次の走査で再試行）
      detachButton();
      return;
    }
    // 件数 0 でもボタンは出す（実機で確定した不具合の修正 / 2026-07-26）。
    // 旧実装は「送信対象が 0 件なら出さない」としていたが、一括系ページでは activate 時点
    // （document_idle）にカードが未描画で必ず 0 件になり、その後の再走査が届かないと
    // ボタンが永久に出なかった。/watch だけ動いていたのは件数を常に 1 と決め打ちしていたため。
    // 参考にした拡張機能も件数に関係なくボタンを出し、押した時点で対象を集める挙動。
    const count = kind === "watch" ? 1 : collectUrls(kind).length;
    // 既に正しい位置にあるなら DOM を触らない（Polymer の再描画を誘発しない）
    const placed = anchor.insert === "after"
      ? anchor.el.nextElementSibling === rootEl
      : anchor.el.previousElementSibling === rootEl;
    if (!placed) {
      try {
        if (anchor.insert === "after") anchor.el.after(rootEl);
        else anchor.el.before(rootEl);
      } catch {
        return; // アンカーが直前に外れた場合は次回の走査に任せる
      }
    }
    // row = アンカーの下に 1 行として置くレイアウト（プレイリストの「すべて再生」直下）
    rootEl.classList.toggle("__cpa-nlm-root--row", anchor.row);
    rootEl.style.float = anchor.row ? "none" : BUTTON_ANCHORS[kind].float;
    if (!sending) btnEl.textContent = `📓 ${buildButtonLabel(kind, count)}`;
    // ボタンが実際に置けた = このページで送信しうる状態。ここで送信先候補を取りに行き、
    // 初回クリック時にアカウントセレクタが番号表示のまま待たされるのを消す。
    void prefetchDestinations();
  }

  /**
   * 送信先候補（Google アカウント一覧 / ノートブック一覧）をページ表示中に 1 回だけ先読みする。
   *
   * 取得はどちらも Gemini Notebook からの読み取りのみで、YouTube の視聴内容や動画 URL は
   * 送らない（動画 URL が出ていくのは従来どおりユーザーが送信を押した瞬間だけ）。
   */
  async function prefetchDestinations() {
    if (prefetchStarted || !active || !chrome?.runtime?.id) return;
    prefetchStarted = true;
    void loadAccounts();
    void loadNotebooks();
  }

  /** ボタンをページから取り外す（要素自体は使い回すので再挿入は安い）。 */
  function detachButton() {
    closePanel();
    try { rootEl?.remove(); } catch {}
  }

  function onButtonClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (sending) return;
    if (panelEl) {
      closePanel();
      return;
    }
    openPanel();
  }

  /**
   * ポップオーバーを開く。
   *
   * ボタンがページ内（`#actions` の flex 行や見出し行）に入ったため、パネルを子要素にすると
   * 祖先の `overflow` で切れる。`position: fixed` で body 直下に置き、ボタンの実座標から
   * 位置を計算する方式にして、どのアンカーに挿さっても同じ見え方になるようにする。
   */
  function openPanel() {
    if (!rootEl || !btnEl) return;
    panelEl = document.createElement("div");
    panelEl.className = PANEL_CLASS;
    panelEl.setAttribute("role", "menu");
    // 取得済みならそのまま出す（2 回目以降は待たされない）。裏で最新化して差分だけ反映する。
    if (notebooks) renderPanelList(); else renderPanelLoading();
    document.body.appendChild(panelEl);
    positionPanel();
    btnEl.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onOutsideClick, true);
    document.addEventListener("keydown", onPanelKeydown, true);
    // スクロール / リサイズでアンカーがずれるため、追従させずに閉じる（YouTube のメニューと同じ挙動）
    window.addEventListener("scroll", closePanel, true);
    window.addEventListener("resize", closePanel, true);
    void loadNotebooks();
    void loadAccounts();
  }

  /** ボタンの実座標からパネル位置を決める（viewport 外へはみ出さないよう clamp する）。 */
  function positionPanel() {
    if (!panelEl || !btnEl?.isConnected) return;
    const rect = btnEl.getBoundingClientRect();
    const width = panelEl.offsetWidth || 320;
    const height = panelEl.offsetHeight || 200;
    const margin = 8;
    // 既定はボタンの下・右揃え。下に入らなければ上に出す。
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - height - 6);
    }
    let left = rect.right - width;
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));
    panelEl.style.top = `${Math.round(top)}px`;
    panelEl.style.left = `${Math.round(left)}px`;
  }

  function closePanel() {
    try { panelEl?.remove(); } catch {}
    panelEl = null;
    btnEl?.setAttribute("aria-expanded", "false");
    try {
      document.removeEventListener("click", onOutsideClick, true);
      document.removeEventListener("keydown", onPanelKeydown, true);
      window.removeEventListener("scroll", closePanel, true);
      window.removeEventListener("resize", closePanel, true);
    } catch {}
  }

  function onOutsideClick(ev) {
    if (!panelEl) return;
    // パネルは body 直下（fixed）なので、ボタン側とパネル側の両方を「内側」として扱う
    if (rootEl?.contains(ev.target) || panelEl.contains(ev.target)) return;
    closePanel();
  }

  function onPanelKeydown(ev) {
    if (ev.key === "Escape") closePanel();
  }

  /**
   * 読み込み中のパネルを描画する。
   *
   * **見出し・アカウント選択・新規作成まで含めて描く**（本体は一覧の部分だけ後から入る）。
   * 旧実装は読み込み中に「読み込み中…」の 1 行しか出しておらず、取得完了の瞬間に中身が
   * 丸ごと差し替わるため、**空のドロップダウンが一瞬出てから埋まる**ように見えていた。
   */
  function renderPanelLoading() {
    panelState = "loading";
    renderPanelShell(() => {
      const msg = document.createElement("div");
      msg.className = "__cpa-nlm-msg";
      msg.textContent = i18n("nlmLoading", "ノートブックを読み込み中…");
      return [msg];
    });
  }

  /**
   * パネルの外枠（見出し / アカウント選択 / 新規作成）を描き、本体を `buildBody` で足す。
   * 読み込み中と一覧表示で共通にすることで、状態が変わっても枠が動かない（＝ちらつかない）。
   *
   * @param {() => HTMLElement[]} buildBody 外枠の下に足す要素
   */
  function renderPanelShell(buildBody) {
    if (!panelEl) return;
    panelEl.textContent = "";

    const head = document.createElement("div");
    head.className = "__cpa-nlm-head";
    head.textContent = i18n("nlmPickNotebook", "送信先のノートブック");
    panelEl.appendChild(head);
    panelEl.appendChild(renderAccountRow());

    const create = document.createElement("button");
    create.type = "button";
    create.className = "__cpa-nlm-item __cpa-nlm-item--new";
    create.textContent = i18n("nlmNewNotebook", "＋ 新しいノートブックを作成");
    create.addEventListener("click", () => void send(null));
    panelEl.appendChild(create);

    for (const el of buildBody()) panelEl.appendChild(el);
    positionPanel();
  }

  function renderPanelError(text) {
    if (!panelEl) return;
    panelState = "error";
    panelEl.textContent = "";
    const msg = document.createElement("div");
    msg.className = "__cpa-nlm-msg __cpa-nlm-msg--error";
    msg.textContent = text;
    panelEl.appendChild(msg);
    // 未ログイン等はユーザー側の操作で解決するため、NotebookLM を開く導線を添える。
    const open = document.createElement("button");
    open.type = "button";
    open.className = "__cpa-nlm-item";
    open.textContent = i18n("nlmOpenNotebookLm", "NotebookLM を開く");
    open.addEventListener("click", () => {
      window.open(`${NotebookLm.ORIGIN}/`, "_blank", "noopener");
      closePanel();
    });
    panelEl.appendChild(open);
    positionPanel();
  }

  /**
   * アカウント切替行を描画する（/rere D-5）。
   *
   * マルチログイン環境では既定アカウント（u/0）に解決されるため、普段 Workspace など
   * 別アカウントで NotebookLM を使っている人は**意図しないアカウントに動画 URL が入る**。
   * アカウント名は NotebookLM の HTML から確実に取れる保証がないので、`authuser` の
   * インデックスを選ばせる方式にした。**選ぶと一覧がそのアカウントのものに切り替わる**ので、
   * 表示されたノートブック名を見れば正しいかどうかがその場で分かる（自己検証できる UI）。
   */
  function renderAccountRow() {
    const row = document.createElement("div");
    row.className = "__cpa-nlm-account";

    const label = document.createElement("span");
    label.className = "__cpa-nlm-account-label";
    label.textContent = i18n("nlmAccount", "Google アカウント");

    const select = document.createElement("select");
    select.className = "__cpa-nlm-account-select";
    select.setAttribute("aria-label", i18n("nlmAccount", "Google アカウント"));
    // アカウント一覧が取れていればメールアドレスで、取れなければ番号だけで並べる。
    // 番号だけの旧表示は「どれを選べばいいか分からない」ため、実名表示を優先する。
    const numberedLabel = (i) => (i === 0
      ? i18n("nlmAccountDefault", "既定 (0)")
      : i18n("nlmAccountNth", "アカウント {0}").replace("{0}", String(i)));
    const entries = Array.isArray(accounts) && accounts.length > 0
      ? accounts.map((a) => ({ index: a.index, label: a.email }))
      : Array.from({ length: NotebookLm.MAX_ACCOUNT_INDEX + 1 }, (_, i) => ({ index: i, label: numberedLabel(i) }));
    // 保存済みインデックスが一覧に無い（アカウントを外した等）場合も選択状態を失わせない。
    if (!entries.some((e) => e.index === accountIndex)) {
      entries.push({ index: accountIndex, label: numberedLabel(accountIndex) });
      entries.sort((a, b) => a.index - b.index);
    }
    for (const entry of entries) {
      const opt = document.createElement("option");
      opt.value = String(entry.index);
      opt.textContent = entry.label;
      select.appendChild(opt);
    }
    select.value = String(accountIndex);
    select.addEventListener("change", () => {
      accountIndex = NotebookLm.normalizeAccountIndex(select.value);
      persistAccountIndex(accountIndex);
      notebooks = null;
      renderPanelLoading();
      void loadNotebooks();
    });

    row.append(label, select);
    return row;
  }

  /** 選択したアカウントを保存する（次回以降も同じ送信先を使う）。 */
  function persistAccountIndex(value) {
    if (!chrome?.runtime?.id) return;
    try {
      chrome.storage.local.set({ [StorageKeys.NOTEBOOK_LM_ACCOUNT_INDEX]: value }).catch(() => {});
    } catch {
      // storage 書き込み失敗は次回既定値に戻るだけなので、動作は継続する
    }
  }

  /** ノートブック一覧（＋新規作成）を描画する。 */
  function renderPanelList() {
    panelState = "list";
    renderPanelShell(() => {
      // 0 件は正常状態（まだノートブックを作っていない）。何も出さないと「取得に失敗した」と
      // 読めてしまうので、空であることを明示する（故障と正常を UI でも区別する / RC-J と同趣旨）。
      if (!notebooks || notebooks.length === 0) {
        const empty = document.createElement("div");
        empty.className = "__cpa-nlm-msg";
        empty.textContent = i18n("nlmEmpty", "既存のノートブックはありません");
        return [empty];
      }
      const list = document.createElement("div");
      list.className = "__cpa-nlm-list";
      for (const nb of notebooks) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "__cpa-nlm-item";
        const name = document.createElement("span");
        name.className = "__cpa-nlm-name";
        name.textContent = `${nb.emoji} ${nb.name}`;
        const count = document.createElement("span");
        count.className = "__cpa-nlm-count";
        count.textContent = String(nb.sources);
        item.append(name, count);
        // 既存ソース数を渡して background 側で残容量を差し引かせる（/rere RC-O）
        item.addEventListener("click", () => void send(nb.id, nb.sources));
        list.appendChild(item);
      }
      return [list];
    });
  }

  /**
   * ログイン中の Google アカウントを取得してセレクタをメールアドレス表示に差し替える。
   *
   * 一覧取得より遅れて届いても構わない（届くまでは番号表示のまま操作できる）。取得に失敗
   * したときも黙って番号表示を続け、送信自体はブロックしない。
   */
  async function loadAccounts() {
    if (accounts || !chrome?.runtime?.id) return;
    try {
      const res = await chrome.runtime.sendMessage({ action: Actions.NOTEBOOK_LM_ACCOUNTS });
      if (!res?.ok || !Array.isArray(res.accounts) || res.accounts.length === 0) return;
      accounts = res.accounts;
      // エラー表示は上書きしない。読み込み中／一覧のどちらでもセレクタだけ実名に差し替わる。
      if (!panelEl || panelState === "error") return;
      if (panelState === "list") renderPanelList();
      else renderPanelLoading();
    } catch {
      // 番号表示のまま続行
    }
  }

  async function loadNotebooks() {
    if (!chrome?.runtime?.id) return;
    try {
      const res = await chrome.runtime.sendMessage({ action: Actions.NOTEBOOK_LM_LIST, data: { accountIndex } });
      if (!res?.ok) {
        // 表示済みの一覧を一時的な失敗で消さない（キャッシュのまま操作を続けられる）
        if (panelEl && !notebooks) renderPanelError(formatError(res?.error));
        return;
      }
      // 事前取得（パネルを開く前）でも結果は保持する。描画はパネルが開いているときだけ。
      notebooks = res.notebooks ?? [];
      if (panelEl) renderPanelList();
    } catch {
      if (panelEl && !notebooks) renderPanelError(formatError("rpc-failed"));
    }
  }

  /**
   * エラーコードをロケールメッセージに翻訳する。
   * 「未ログイン」と「NotebookLM 側の仕様変更」を別文言にする（/rere RC-J）。
   * 旧実装は両方を「ログインしてください」に潰していて、ログイン済みユーザーを誤誘導していた。
   */
  function formatError(code) {
    switch (code) {
      case "not-authorized":
        return i18n("nlmErrorAuth", "NotebookLM にログインしてください");
      case "protocol-changed":
        return i18n("nlmErrorProtocol", "NotebookLM 側の仕様変更で連携できません");
      case "network-failed":
        return i18n("nlmErrorNetwork", "NotebookLM に接続できませんでした");
      case "notebook-full":
        return i18n("nlmErrorFull", "このノートブックはソース数が上限です");
      case "no-urls":
        return i18n("nlmErrorNoUrls", "送信できる動画が見つかりませんでした");
      case "create-failed":
      case "add-failed":
      case "rpc-failed":
        return i18n("nlmErrorRpc", "NotebookLM への送信に失敗しました");
      default:
        return i18n("nlmErrorUnknown", "NotebookLM への送信に失敗しました");
    }
  }

  /**
   * 送信本体。notebookId が null なら新規ノートブックを作る。
   * 完了したら作成／追加先のノートブックを新しいタブで開く。
   *
   * @param {string|null} notebookId 送信先。null で新規作成
   * @param {number} existingSources 既存ソース数（残容量の計算に使う）
   */
  async function send(notebookId, existingSources = 0) {
    if (sending || !chrome?.runtime?.id) return;
    const kind = detectPageKind();
    if (!kind) return;
    const urls = collectUrls(kind);
    if (urls.length === 0) {
      renderPanelError(formatError("no-urls"));
      return;
    }
    sending = true;
    closePanel();
    if (btnEl) btnEl.textContent = `📓 ${i18n("nlmSending", "NotebookLM に送信中…")}`;
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.NOTEBOOK_LM_SEND,
        data: { urls, notebookId, existingSources, accountIndex, title: buildDefaultTitle(kind) },
      });
      if (!chrome?.runtime?.id) return;
      if (res?.ok) {
        // 上限で溢れた分があれば件数を伝えてから開く（黙って捨てない）。
        if (res.skipped > 0 && btnEl) {
          btnEl.textContent = `📓 ${i18n("nlmSkipped", "{0} 件が上限超過で未送信").replace("{0}", String(res.skipped))}`;
        }
        // 送信先は background が開く。開けなかったときだけリンクに退避する。
        if (!res.opened) openNotebook(res.url);
        // 送信でノートブックの中身（件数・新規作成）が変わるので、キャッシュを捨てて次回取り直す
        notebooks = null;
      } else if (btnEl) {
        btnEl.textContent = `⚠ ${formatError(res?.error)}`;
        // 作成済みノートブックがあるなら、そこへ辿り着く導線を残す（/rere RC-E）
        if (res?.url) showNotebookLink(res.url);
      }
    } catch {
      if (btnEl) btnEl.textContent = `⚠ ${formatError("rpc-failed")}`;
    } finally {
      sending = false;
      // 失敗表示をしばらく残してから通常ラベルに戻す
      setTimeout(() => {
        if (!sending) syncButton();
      }, 4000);
    }
  }

  /**
   * 送信先ノートブックを新しいタブで開く。
   *
   * `window.open` は await 越しだと transient user activation（約 5 秒）が切れて popup blocker に
   * 黙って弾かれる（/rere RC-L）。戻り値を確認し、弾かれたときは代わりにリンクを出して
   * ユーザーが自分で開けるようにする（旧実装は「送信成功なのに何も起きない」に見えていた）。
   */
  function openNotebook(url) {
    if (!url) return;
    let win = null;
    try {
      win = window.open(url, "_blank", "noopener");
    } catch {
      win = null;
    }
    if (!win) showNotebookLink(url);
  }

  /** ボタンの上に「ノートブックを開く」リンクを出す（新しいタブが開けなかったときの受け皿）。 */
  function showNotebookLink(url) {
    if (!rootEl) return;
    closePanel();
    panelState = "error";
    panelEl = document.createElement("div");
    panelEl.className = PANEL_CLASS;
    const link = document.createElement("a");
    link.className = "__cpa-nlm-item __cpa-nlm-item--new";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = i18n("nlmOpenNotebook", "作成したノートブックを開く");
    panelEl.appendChild(link);
    document.body.appendChild(panelEl);
    positionPanel();
    document.addEventListener("click", onOutsideClick, true);
    document.addEventListener("keydown", onPanelKeydown, true);
    window.addEventListener("scroll", closePanel, true);
    window.addEventListener("resize", closePanel, true);
  }

  // ---------- ライフサイクル ----------

  function scheduleRescan() {
    if (rescanScheduled) return;
    rescanScheduled = true;
    // rAF は **バックグラウンドタブでは発火しない**。別タブで YouTube を開いた場合、
    // 走査が 1 度も届かずボタンが出ないままになるため、タイマー側でも必ず 1 回走らせる
    // （どちらが先に来ても rescanScheduled フラグで 1 回に収束する）。
    requestAnimationFrame(runRescan);
    rescanFallbackTimer = setTimeout(runRescan, RESCAN_FALLBACK_MS);
  }

  function runRescan() {
    if (!rescanScheduled) return;
    rescanScheduled = false;
    if (rescanFallbackTimer !== null) {
      clearTimeout(rescanFallbackTimer);
      rescanFallbackTimer = null;
    }
    if (!active) return;
    // 件数ラベルのためだけに毎 mutation で全 anchor を走査すると重いので間引く。
    // ただし**捨てずに末尾で 1 回実行する**（/rere RC-M）。単純に return すると、
    // 遅延読み込みの最後の一群が窓に収まったときラベルだけ古い件数で固定される。
    const now = Date.now();
    const wait = COUNT_REFRESH_MS - (now - lastCountAt);
    if (wait > 0) {
      if (trailingCountTimer === null) {
        trailingCountTimer = setTimeout(() => {
          trailingCountTimer = null;
          if (!active) return;
          lastCountAt = Date.now();
          syncButton();
        }, wait);
      }
      return;
    }
    lastCountAt = now;
    syncButton();
  }

  function activate() {
    if (active) return;
    active = true;
    ensureUi();
    syncButton();
    mutationObserver = new MutationObserver(() => {
      if (!chrome?.runtime?.id) { teardownOrphan(); return; }
      if (!active) return;
      scheduleRescan();
    });
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("yt-navigate-finish", onYtNavigateFinish, true);
  }

  function deactivate() {
    if (!active && !rootEl) return;
    active = false;
    try { mutationObserver?.disconnect(); } catch {}
    mutationObserver = null;
    try { document.removeEventListener("yt-navigate-finish", onYtNavigateFinish, true); } catch {}
    clearTrailingCountTimer();
    removeUi();
    notebooks = null;
  }

  /** 拡張機能リロードで orphan 化したときの後始末（chrome API に触らない）。 */
  function teardownOrphan() {
    active = false;
    try { mutationObserver?.disconnect(); } catch {}
    mutationObserver = null;
    try { document.removeEventListener("yt-navigate-finish", onYtNavigateFinish, true); } catch {}
    clearTrailingCountTimer();
    removeUi();
  }

  /** トレーリング再計算タイマーを解除する（deactivate / orphan で呼ぶ）。 */
  function clearTrailingCountTimer() {
    if (trailingCountTimer !== null) {
      clearTimeout(trailingCountTimer);
      trailingCountTimer = null;
    }
    if (rescanFallbackTimer !== null) {
      clearTimeout(rescanFallbackTimer);
      rescanFallbackTimer = null;
    }
    rescanScheduled = false;
  }

  function onYtNavigateFinish() {
    if (!active) return;
    // SPA 遷移直後はまだ旧ページの DOM が残っていることがあるので次フレームで評価する
    requestAnimationFrame(() => {
      if (!active) return;
      lastCountAt = 0;
      syncButton();
    });
  }

  function computeActive(masterRaw, featuresRaw) {
    if (masterRaw !== true) return false;
    return SearchFixer.mergeFeatures(featuresRaw).notebookLmSend === true;
  }

  async function readSettingsAndApply() {
    if (!chrome?.runtime?.id) return;
    if (applyInFlight) {
      applyQueued = true;
      return;
    }
    applyInFlight = true;
    try {
      const stored = await chrome.storage.local.get([
        StorageKeys.SEARCH_FIXER_ENABLED,
        StorageKeys.SEARCH_FIXER_FEATURES,
        StorageKeys.NOTEBOOK_LM_ACCOUNT_INDEX,
      ]);
      if (!chrome?.runtime?.id) return;
      accountIndex = NotebookLm.normalizeAccountIndex(stored[StorageKeys.NOTEBOOK_LM_ACCOUNT_INDEX]);
      const shouldBeActive = computeActive(
        stored[StorageKeys.SEARCH_FIXER_ENABLED],
        stored[StorageKeys.SEARCH_FIXER_FEATURES]
      );
      if (shouldBeActive) {
        activate();
      } else {
        deactivate();
      }
    } catch {
      // storage 読み取り失敗は次回 storage.onChanged / APPLY で再試行されるため何もしない
    } finally {
      applyInFlight = false;
      if (applyQueued) {
        applyQueued = false;
        readSettingsAndApply();
      }
    }
  }

  readSettingsAndApply();

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (!chrome?.runtime?.id) return;
      if (areaName !== "local") return;
      if (
        StorageKeys.SEARCH_FIXER_ENABLED in changes ||
        StorageKeys.SEARCH_FIXER_FEATURES in changes
      ) {
        readSettingsAndApply();
      }
    });
  } catch {}

  try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (!chrome?.runtime?.id) return;
      if (!SenderCheck.isFromBackground(sender)) return;
      if (request?.action !== Actions.APPLY_SEARCH_FIXER_CS) return;
      readSettingsAndApply();
      try { sendResponse({ ok: true }); } catch {}
    });
  } catch {}

  // bfcache 凍結（persisted=true）は温存し、実ドキュメント破棄のときだけフル解放する
  window.addEventListener("pagehide", (ev) => {
    if (ev.persisted) return;
    deactivate();
  });
})();
