"use strict";

/**
 * Instagram クリーナー content script（独自実装）。
 *
 * 設定は `chrome.storage.local` の `instagramCleanerEnabled` (master) と
 * `instagramCleanerFeatures` (オブジェクト) の 2 キーで管理する。
 *
 * 役割:
 *   - master + features に応じて document.documentElement にクラスを付け外しし、CSS 側の表示制御を駆動
 *   - Reels / Explore / Stories の URL を有効時にホームへリダイレクト
 *   - 投稿内 <video> をブロックする際、親 <article> にマーカークラスを付ける
 *   - 投稿内の数値表示ボタン（いいね数等）に hide マーカークラスを付ける
 *
 * 設計方針:
 *   - 隠蔽セレクタは aria-label / href / role / data-pagelet / SVG path data など
 *     Instagram の DOM が公開している意味論的属性のみで構成（難読化 class への依存を排除）
 *   - master OFF 時は observer / interval / 装飾クラスをすべて停止
 *   - 寄付ボタン注入・多言語ローカライズ・フォント変更・グレースケール / 正方形化等は実装しない
 *     （クリーンアップ目的に絞る）
 */

(() => {
  if (window.__cpaInstagramCleanerRunning) return;
  window.__cpaInstagramCleanerRunning = true;
  // Instagram の埋め込み iframe では機能しないので top frame のみ
  if (window !== window.top) return;

  /** @type {boolean} master トグル */
  let active = false;
  /** @type {Record<string, boolean>} 個別機能フラグ（定数定義からマージ済み） */
  let features = InstagramCleaner.mergeFeatures({});

  /** @type {number|null} block_videos / vanity の DOM 監視タイマー */
  let domSweepTimer = null;
  /** @type {number|null} URL リダイレクト用ポーリングタイマー */
  let urlGuardTimer = null;

  // i18n / セレクタ崩壊の watch dog (#10): href + aria-label の全バリアントが同時に DOM に
  // 見当たらないとき、Instagram の DOM 構造が根本変化した可能性を開発者コンソールに 1 度だけ警告。
  // CSS と同じ union 配列で照合し、1 つでもマッチしたら黙る（false positive 抑制）。
  // 即時チェックは React 遅延 hydrate 前に吠えるため、settings 適用から 1.5s 待ってから 1 度だけ実行。
  // ユーザーへの直接通知は出さず、本番ユーザーが DevTools を開いたときの診断補助に留める。
  /** @type {Set<string>} 警告済み機能キー */
  const i18nWarned = new Set();
  const I18N_WATCHDOG_SELECTORS = Object.freeze({
    reels: 'a[href="/reels/"], a[href^="/reels/"], [aria-label="Reels"], [aria-label="リール"]',
    explore: 'a[href="/explore/"], a[href^="/explore/"], [aria-label="Explore"], [aria-label="発見"]',
  });
  /** @type {number|null} React 遅延 hydrate を待つ 1.5s 遅延チェック用タイマー */
  let i18nWatchdogTimer = null;

  // ---------- 機能アクセサ ----------
  // master が false ならすべて false 扱い。
  const f = (key) => active && features[key] === true;

  // ---------- 状態購読 ----------
  chrome.storage.local
    .get([StorageKeys.INSTAGRAM_CLEANER_ENABLED, StorageKeys.INSTAGRAM_CLEANER_FEATURES])
    .then((stored) => {
      active = stored[StorageKeys.INSTAGRAM_CLEANER_ENABLED] === true;
      features = InstagramCleaner.mergeFeatures(stored[StorageKeys.INSTAGRAM_CLEANER_FEATURES]);
      onSettingsChanged();
    })
    .catch(() => {});

  chrome.runtime.onMessage.addListener((request, sender) => {
    if (!SenderCheck.isFromBackground(sender)) return;
    if (request?.action !== Actions.APPLY_INSTAGRAM_CLEANER_CS) return;
    const data = request.data ?? {};
    active = data.enabled === true;
    features = InstagramCleaner.mergeFeatures(data.features);
    onSettingsChanged();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    let touched = false;
    if (StorageKeys.INSTAGRAM_CLEANER_ENABLED in changes) {
      active = changes[StorageKeys.INSTAGRAM_CLEANER_ENABLED].newValue === true;
      touched = true;
    }
    if (StorageKeys.INSTAGRAM_CLEANER_FEATURES in changes) {
      features = InstagramCleaner.mergeFeatures(changes[StorageKeys.INSTAGRAM_CLEANER_FEATURES].newValue);
      touched = true;
    }
    if (touched) onSettingsChanged();
  });

  // ---------- 設定変更ディスパッチャ ----------
  function onSettingsChanged() {
    applyBodyClasses();
    if (active) {
      startDomSweep();
      startUrlGuard();
    } else {
      stopDomSweep();
      stopUrlGuard();
      cleanupMarkers();
    }
  }

  /** 各機能フラグに応じて document(.documentElement) にクラスを付け外し。 */
  function applyBodyClasses() {
    const root = document.documentElement;
    if (!root) return;
    for (const [key, className] of Object.entries(InstagramCleaner.BODY_CLASS)) {
      root.classList.toggle(className, f(key));
    }
    // 既存の保留タイマーをキャンセル（連続トグル時の重複起動防止 + active=false 切替時の停止）。
    if (i18nWatchdogTimer !== null) {
      clearTimeout(i18nWatchdogTimer);
      i18nWatchdogTimer = null;
    }
    if (!active) return;
    // SPA 遷移 / 初回ロード直後は React で sidebar が遅延 hydrate される。
    // 即時チェックすると hydration 前で false positive を吠えるため 1.5s 待ってから 1 度だけ実行。
    i18nWatchdogTimer = setTimeout(() => {
      i18nWatchdogTimer = null;
      if (active && chrome.runtime?.id) checkI18nWatchdog();
    }, 1500);
  }

  /**
   * 機能 ON なのに対応セレクタが DOM に見当たらない場合、Instagram 側の UI 変更で機能が
   * silent failure している可能性を開発者コンソールに 1 度だけ警告する (#10)。
   * 警告は機能キーごとに 1 回限りで、本番ユーザーへの直接通知は出さない。
   */
  function checkI18nWatchdog() {
    if (!active) return;
    if (!document.body || document.body.children.length === 0) return;
    for (const [key, selector] of Object.entries(I18N_WATCHDOG_SELECTORS)) {
      if (i18nWarned.has(key)) continue;
      if (!features[key]) continue;
      if (document.querySelector(selector)) continue;
      i18nWarned.add(key);
      console.warn(
        `[Instagram cleaner] 機能 "${key}" のセレクタ "${selector}" が DOM にマッチしません。Instagram の UI 変更でセレクタが古くなっている可能性があります。`
      );
    }
  }

  // ---------- DOM 監視（block_videos / vanity） ----------
  // 300ms ポーリングを採用。MutationObserver は Instagram の頻繁な React 再 render で
  // コールバック発火が爆発的に増えて CPU を食いやすいため、低頻度ポーリングのほうが安定する。
  function startDomSweep() {
    if (domSweepTimer !== null) return;
    sweepOnce();
    domSweepTimer = setInterval(sweepOnce, 300);
  }

  function stopDomSweep() {
    if (domSweepTimer === null) return;
    clearInterval(domSweepTimer);
    domSweepTimer = null;
  }

  function sweepOnce() {
    // 拡張機能 reload 後のゾンビ状態検知 (#10): chrome.runtime.id にアクセスできなくなったら
    // extension context が失効 (= 拡張機能が更新／無効化された)。沈黙したリスナーが残ると
    // body クラスが付いたまま剥がせなくなるため、検知時点で全マーカーを掃除して
    // タイマーも止める（次回ページリロードで新しい content script が再注入されるまで休眠）。
    if (!chrome.runtime?.id) {
      active = false;
      features = InstagramCleaner.mergeFeatures({});
      applyBodyClasses();
      cleanupMarkers();
      stopDomSweep();
      stopUrlGuard();
      return;
    }
    // 3-C5 最適化: タブが非表示のときは DOM スイープをスキップして CPU を節約。
    // visibility 復帰時は visibilitychange イベントで強制発火しないが、次の 300ms 間隔で
    // 自動的にスイープが走るため、最大 300ms 遅延の許容範囲内で大幅に低 CPU 化できる。
    if (document.hidden) return;
    // P2-#14: 全 sweep 機能 OFF なら 10 個の document-wide querySelectorAll をすべてスキップする。
    // Instagram フィードは記事 50 件 × 各 ~2000 ノード = 10万ノードを 300ms ごとに走査するので
    // OFF 時のスキップによる省 CPU 効果は大きい。
    if (!f("blockVideos") && !f("vanity") && !f("comments")) return;
    if (f("blockVideos")) markArticlesContainingVideo();
    if (f("vanity")) markCounterButtons();
    if (f("comments")) markCommentElements();
  }

  /**
   * `<article>` 内に `<video>` を含む投稿に対して、親 `<article>` にマーカークラスを付与する。
   * 動画自体の隠蔽は CSS 側の `video { display: none }` に任せる。マーカーが付いた article は
   * CSS で再生ボタン・音声トグル等の関連 UI を非表示にし、サムネ部分にプレースホルダーを描画する。
   *
   * 既処理 article は `:not()` で除外して再走査コストを削減。
   */
  function markArticlesContainingVideo() {
    try {
      document
        .querySelectorAll("article:not(." + InstagramCleaner.ARTICLE_VIDEO_CLASS + ")")
        .forEach((article) => {
          if (article.querySelector("video")) {
            article.classList.add(InstagramCleaner.ARTICLE_VIDEO_CLASS);
          }
        });
    } catch {
      // 一部 SubFrame で querySelector が例外を投げるケースをサイレントスキップ
    }
  }

  /**
   * コメント関連要素を JS で識別し、安全な範囲で隠蔽用マーカークラスを付ける。
   *
   * 対象 (4 種):
   *   1. **コメント入力フォーム** — `<textarea>` の aria-label/placeholder に "comment"/"コメント" を含む
   *      要素の親 `<form>`。他要素を巻き込むリスクが低いため form スコープで安全。
   *   2. **「View all N comments」/「N 件のコメントを見る」リンク** — `article` 内の `<a>` で
   *      テキストが英語/日本語の view-all パターンにマッチ。子要素 4+ のコンテナはスキップ。
   *   3. **コメントリスト `<ul>`（ホームフィード用）** — `article` 内の `<ul>` で以下を全て満たす:
   *      - `<li>` の数が 1〜15（それ以上は別種の UL の可能性が高い）
   *      - 80% 以上の `<li>` がユーザープロフィールリンク (`/<username>/`) を含む
   *   4. **コメントリストコンテナ（投稿詳細ページ + モーダル — UL/DIV 両対応）** —
   *      `<article>` 不在の `/p/`, `/reel/`, `/tv/` 直接アクセス、およびフィード/プロフィールから
   *      クリックで開く `[role="dialog"]` モーダル表示の両方をカバー。コメントは
   *      `<ul class="_a9z6">`（直系 `<div>`）または `<div>` 直下に並ぶ。コメント入力 textarea
   *      が存在 + `main[role="main"]` または `[role="dialog"]` 配下 + `<article>` の外、で
   *      子 2〜50 個 / 70%+ が `/<username>/` を持つ / 70%+ が `<time>` を含む / 異なる
   *      username が 2 種類以上 — を全部満たす container をマーク。
   *
   * 安全策（前回の「投稿本体を巻き込む」事故を防ぐ）:
   *   - 4 はコメント入力 textarea 不在ページ（プロフィール / DM / 検索結果）に到達しないようガード
   *   - 4 は **異なる username 2 種類以上 + `<time>` 70%+** を要件に追加し、タグ付けユーザー
   *     パネル / liked_by 行 / プロフィールヘッダ / 単一ユーザー繰り返し UI を除外する
   *   - 4 は article ガードを敢えて持たない（モーダル投稿は `<dialog>` 内の `<article>` で wrap
   *     されるため）。3. と重複マーク発生時は同 class の冪等 add で CSS 効果は同一。
   *   - 既処理は `:not()` で除外して 300ms ごとの再走査コストを削減
   */
  function markCommentElements() {
    try {
      // 1. コメント入力フォーム
      document.querySelectorAll("textarea[aria-label], textarea[placeholder]").forEach((textarea) => {
        const label =
          ((textarea.getAttribute("aria-label") ?? "") + " " +
           (textarea.getAttribute("placeholder") ?? "")).toLowerCase();
        if (!/comment|コメント/.test(label)) return;
        const form = textarea.closest("form");
        if (form && !form.classList.contains(InstagramCleaner.COMMENT_INPUT_CLASS)) {
          form.classList.add(InstagramCleaner.COMMENT_INPUT_CLASS);
        }
      });

      // 2. 「View all N comments」 系リンク（article スコープ）
      document
        .querySelectorAll("article a:not(." + InstagramCleaner.COMMENT_VIEW_CLASS + ")")
        .forEach((a) => {
          // 画像/動画ラッパなど子要素が多い <a> は除外（leaf-text な link のみ）
          if (a.children.length > 3) return;
          const text = (a.textContent ?? "").trim();
          if (text.length === 0 || text.length > 60) return;
          if (
            /view\s+(all\s+)?\d+\s+(comment|repl)/i.test(text) ||
            /^\d+\s+comments?$/i.test(text) ||
            /^see\s+(all|more)\s+comments?/i.test(text) ||
            /^view\s+previous\s+comments?/i.test(text) ||
            /コメント.{0,8}件.{0,8}(見る|表示)/.test(text) ||
            /^返信(を表示|を見る|\d+件)/.test(text) ||
            /^(\d+)件のコメント/.test(text)
          ) {
            a.classList.add(InstagramCleaner.COMMENT_VIEW_CLASS);
          }
        });

      // 3. コメントリスト UL（article スコープ・厳格条件 / ホームフィード用）
      document
        .querySelectorAll("article ul:not(." + InstagramCleaner.COMMENT_LIST_CLASS + ")")
        .forEach((ul) => {
          // 1-C1 最適化: `:scope > li` で直接 LI を取得し、Array.from + filter の中間配列を省略する。
          // 300ms ポーリングで毎回走るホットパスのため、配列アロケーション削減が GC プレッシャに効く。
          const items = ul.querySelectorAll(":scope > li");
          // li 数 1〜15 の範囲のみ受け付け（範囲外は別種の UL）
          if (items.length === 0 || items.length > 15) return;
          // 各 li 内にユーザープロフィールリンク（`/<username>/` 形式）があるかカウント
          let userLinkCount = 0;
          for (const li of items) {
            const link = li.querySelector("a[href^='/']");
            const href = link?.getAttribute("href") ?? "";
            // `/<username>/` または `/<username>` の短い英数記号パスのみマッチ
            if (/^\/[\w.]{1,30}\/?($|\?)/.test(href)) {
              userLinkCount++;
            }
          }
          // 80% 以上が user link を持つ UL のみコメントリスト扱い
          if (userLinkCount / items.length >= 0.8) {
            ul.classList.add(InstagramCleaner.COMMENT_LIST_CLASS);
          }
        });

      // 4. コメントリストコンテナ（投稿詳細ページ /p/, /reel/, /tv/ + モーダル表示 — UL/DIV 両対応）
      //    `<article>` が無い投稿詳細ページに加え、フィード/プロフィールから投稿クリックで
      //    開く `[role="dialog"]` モーダル表示も対象。コメントは `<ul class="_a9z6">` (子は <div>) や
      //    `<div>` 直下に並ぶ（投稿によって異なるレイアウト）。安全策として下記ガードで誤マッチを防ぐ:
      //      - 同一ページにコメント入力 textarea が存在する（= コメント可能ページのみ）
      //      - スコープを `main[role="main"]` または `[role="dialog"]` 配下に限定
      //    （`closest("article")` ガードは入れない — モーダル投稿は `<dialog>` 内の `<article>` で
      //     wrap されており、article ガードを入れると modal も skip されてしまうため。3. の UL
      //     ロジックと重複マーク発生時は同じ class を 2 回 add するだけで CSS 効果は同じ。）
      //    判定条件（structural triple-gate）:
      //      - 直系子が 2〜50 個
      //      - 70% 以上の子が `/<username>/` 形式のリンクを含む
      //      - **異なる username が 2 種類以上**
      //      - **70% 以上の子に `<time>` が含まれる**（タグ付けユーザーパネル等を除外）
      const hasCommentInput = document.querySelector(
        'textarea[aria-label*="comment" i], textarea[aria-label*="コメント"], textarea[placeholder*="comment" i], textarea[placeholder*="コメント"]'
      );
      if (hasCommentInput) {
        const detectionRoots = [];
        const main = document.querySelector('main[role="main"]');
        const dialog = document.querySelector('[role="dialog"]');
        if (main) detectionRoots.push(main);
        // dialog が main の外側に居るときだけ別 root として追加（main 配下なら重複走査を避ける）
        if (dialog && !main?.contains(dialog)) detectionRoots.push(dialog);
        // 早期 return ガード (/rere レビュー C-#12):
        // 既にマーク済みコンテナが detection root 内に存在する場合、SPA top-level 遷移までは
        // 同じコメントリストが対象 = 再走査不要。10,000+ DOM ノードに対する 300ms 周期の
        // querySelectorAll を完全スキップして累積 CPU 負荷を圧縮する。SPA 遷移時に
        // <main> / <dialog> の子要素が差し替わるとマーク済み要素も消えるので、その瞬間から
        // 自動的に再走査が再開される (= マーク済み要素が無いので早期 return を抜ける)。
        const alreadyMarked = detectionRoots.some((root) =>
          root.querySelector("." + InstagramCleaner.COMMENT_LIST_CLASS)
        );
        if (alreadyMarked) return;
        const candidateSelector =
          "ul:not(." + InstagramCleaner.COMMENT_LIST_CLASS + "), div:not(." + InstagramCleaner.COMMENT_LIST_CLASS + ")";
        for (const root of detectionRoots) {
          root.querySelectorAll(candidateSelector).forEach((container) => {
            const children = container.children;
            const len = children.length;
            if (len < 2 || len > 50) return;
            let userLinkCount = 0;
            let timeCount = 0;
            const handles = new Set();
            for (const child of children) {
              const link = child.querySelector("a[href^='/']");
              const href = link?.getAttribute("href") ?? "";
              const m = href.match(/^\/([\w.]{1,30})\/?($|\?)/);
              if (m) {
                userLinkCount++;
                handles.add(m[1]);
              }
              // コメントアイテムには必ず投稿時刻 `<time>` が含まれる。タグ付けユーザーパネル等は
              // 含まないため、time 要素率でコメントリストを誤マッチから守る最終ゲート。
              if (child.querySelector("time")) timeCount++;
            }
            // 70% 以上 user link + handle 2 種類以上 + 70% 以上 time 要素
            // （誤マッチ防止: タグ付けユーザーパネル / liked_by 行 / 単一ユーザー繰り返し UI を除外）
            if (
              userLinkCount / len >= 0.7 &&
              handles.size >= 2 &&
              timeCount / len >= 0.7
            ) {
              container.classList.add(InstagramCleaner.COMMENT_LIST_CLASS);
            }
          });
        }
      }
    } catch {
      // 一部 SubFrame で querySelector が例外を投げるケースをサイレントスキップ
    }
  }

  /**
   * 「数値表示」要素にマーカークラス `__cpa-ig-hide-counter` を付ける（CSS 側で `display:none`）。
   *
   * 対象 (2 系統):
   *   1. **フィード `<article>` 内の `<button>`** — いいね数 / 再生回数等。
   *      `^\d` 先頭の純粋な数値テキスト（カンマ・小数点・空白 + 末尾単位 k/M/万/億/千）のみ対象。
   *      「$5」「いいね 1234」等の記号 / ラベル混在ボタンは対象外。
   *   2. **プロフィールヘッダの `<a>` / `<span>`** — 「投稿XXX件」「フォロワーXXX人」「フォロー中XXX人」
   *      および英語版 "N posts" / "N followers" / "N following"。
   *      Instagram が `<a>` の href を空にしたため CSS attribute セレクタが効かず、
   *      テキストパターン + `<header>` スコープで識別する。
   *
   * 安全策:
   *   - スコープを `<article>` または `<header>` 配下に限定して誤マッチを抑制
   *   - `<span>` は直系子 ≤1 に限定して wrapper span を除外
   *   - テキスト長 ≤30 文字に限定
   *   - 既処理は `:not()` で除外して 300ms 再走査コストも削減
   */
  function markCounterButtons() {
    try {
      // (1) フィード `<article>` 内の数値ボタン（いいね数 / 再生回数等）
      document
        .querySelectorAll(
          "article button:not(." +
            InstagramCleaner.VANITY_HIDE_CLASS +
            "):not(." +
            InstagramCleaner.VANITY_CHECKED_CLASS +
            ")"
        )
        .forEach((btn) => {
          const text = (btn.textContent ?? "").trim();
          btn.classList.add(InstagramCleaner.VANITY_CHECKED_CLASS);
          if (!text || text.length > 30) return;
          // 純粋な数値表現（カンマ・小数点・空白 + 末尾の単位）にマッチするか
          // 例: "1,234" / "567" / "1.2k" / "10万" / "5 億"
          if (/^\d[\d,.\s]*(?:k|m|b|億|万|千|t)?$/i.test(text)) {
            btn.classList.add(InstagramCleaner.VANITY_HIDE_CLASS);
          }
        });

      // (2) プロフィールヘッダの「投稿XXX件」「フォロワーXXX人」「フォロー中XXX人」
      // Instagram は最近 `<a>` の href 属性を空にしたため CSS の attribute セレクタが効かず、
      // テキストパターンで識別する必要がある。`<header>` スコープ限定で誤マッチを避ける。
      // 例: "フォロワー7億人" / "フォロー中175人" / "1.2M followers" / "175 following" / "投稿8425件" / "8,425 posts"
      const headerEl = document.querySelector("header");
      if (headerEl) {
        const prefixRe = /^(?:フォロワー|フォロー中|フォロー|投稿|followers?|following|posts?)[\s・]*[\d,.]/i;
        const suffixRe = /^[\d,.\s]+(?:k|m|b|億|万|千)?\s*(?:件|人|followers?|following|posts?)$/i;
        const isCounterText = (t) => prefixRe.test(t) || suffixRe.test(t);

        // <a>: フォロワー / フォロー中ナビゲーションリンク（href 空）
        headerEl
          .querySelectorAll("a:not(." + InstagramCleaner.VANITY_HIDE_CLASS + ")")
          .forEach((a) => {
            const text = (a.textContent ?? "").trim();
            if (!text || text.length > 30) return;
            if (isCounterText(text)) {
              a.classList.add(InstagramCleaner.VANITY_HIDE_CLASS);
            }
          });

        // <span>: 投稿件数のような静的テキスト。
        // 直系子要素 ≤1 に限定して wrapper span を除外（textContent はネストしても拾えるため）。
        headerEl
          .querySelectorAll("span:not(." + InstagramCleaner.VANITY_HIDE_CLASS + ")")
          .forEach((s) => {
            if (s.children.length > 1) return;
            const text = (s.textContent ?? "").trim();
            if (!text || text.length > 30) return;
            if (isCounterText(text)) {
              s.classList.add(InstagramCleaner.VANITY_HIDE_CLASS);
            }
          });
      }
    } catch {}
  }


  // ---------- URL リダイレクト ----------
  // SPA の history pushState を毎度フックすると壊れやすいため、シンプルに 300ms ポーリング。
  function startUrlGuard() {
    if (urlGuardTimer !== null) return;
    checkUrlRedirect();
    urlGuardTimer = setInterval(checkUrlRedirect, 300);
  }

  function stopUrlGuard() {
    if (urlGuardTimer === null) return;
    clearInterval(urlGuardTimer);
    urlGuardTimer = null;
  }

  function checkUrlRedirect() {
    // zombie guard (/rere レビュー B1-D3 / D-4 横展開 PATTERN SYNC):
    // 通常は sweepOnce (300ms) が先に zombie 検知して stopUrlGuard を呼ぶが、
    // urlGuardTimer 単独経路で発火する race を塞ぐ保険として独立ガードを置く。
    if (!chrome.runtime?.id) {
      active = false;
      stopUrlGuard();
      stopDomSweep();
      return;
    }
    if (!active) return;
    // P2-#18: タブが非表示のときはリダイレクトをスキップ。Battery Saver / Background Throttling で
    // setInterval 間隔が伸びる環境でもバックグラウンドの不要な location.assign を抑える。
    // visibility 復帰時は visibilitychange リスナーで即時再評価する。
    if (document.hidden) return;
    const path = location.pathname;
    let shouldRedirect = false;
    // ⚠️ MUST SYNC with `src/content/instagram-early.js` の REELS_RE / EXPLORE_RE / STORIES_RE:
    // document_start と document_idle の両経路で同じ URL 判定をする必要がある。
    if (f("reels") && /^\/reels?(\/|$)/i.test(path)) shouldRedirect = true;
    else if (f("explore") && /^\/explore(\/|$)/i.test(path)) shouldRedirect = true;
    else if (f("storiesAll") && /^\/stories(\/|$)/i.test(path)) shouldRedirect = true;
    if (!shouldRedirect) return;
    // instagram-early.js (document_start redirect) と同じく `replace` を使う。
    // `assign` だと history に残り、ユーザーが「戻る」ボタンで Reels に戻った瞬間に
    // Instagram の重い React bundle が再 freeze する経路がある (/rere レビュー B1-D2 指摘)。
    try {
      window.location.replace("/");
    } catch {
      window.location.href = "/";
    }
  }

  // 非表示タブから復帰したら即時 1 回チェック（次の 300ms 周期を待たずにリダイレクト判定）。
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && active) checkUrlRedirect();
  });

  // ---------- 機能 OFF 時の cleanup ----------
  function cleanupMarkers() {
    try {
      const markerClasses = [
        InstagramCleaner.ARTICLE_VIDEO_CLASS,
        InstagramCleaner.VANITY_HIDE_CLASS,
        InstagramCleaner.VANITY_CHECKED_CLASS,
        InstagramCleaner.COMMENT_INPUT_CLASS,
        InstagramCleaner.COMMENT_VIEW_CLASS,
        InstagramCleaner.COMMENT_LIST_CLASS,
      ];
      // P3-#25: 5 回の document.querySelectorAll を `:is(...)` で 1 回に統合。
      // 1 要素が複数マーカーを持つ可能性は低いが、念のため for ループで全クラスを試行する。
      const selector = ":is(" + markerClasses.map((c) => "." + c).join(",") + ")";
      document.querySelectorAll(selector).forEach((el) => {
        for (const cls of markerClasses) {
          el.classList.remove(cls);
        }
      });
    } catch {}
    // body class は applyBodyClasses で外し済み（active=false で全 false 扱い）
  }
})();
