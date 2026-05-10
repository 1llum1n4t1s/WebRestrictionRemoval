"use strict";

/**
 * 画像ダウンロード機能（Instagram / TikTok 共通）。
 *
 * 各サイトのコンテンツ画像（動画サムネ / 投稿写真 / コミュニティ投稿等）にホバー時のダウンロード
 * ボタンを overlay 表示する。クリック時は `<a download>` + Blob URL 方式で保存する（`downloads`
 * permission は追加しない）。
 *
 * 機能の有効化条件は **各サイトクリーナーの features.imageDownload が true** であること。
 * サイトクリーナー master OFF 時は機能ごと無効になる。
 *
 * 動作の不変条件:
 *   - top frame 限定（`window === window.top`）。iframe 内 image は対象外
 *   - サイズ閾値 ImageDownloader.MIN_SIZE_PX 未満の画像（avatar / アイコン）は除外
 *   - クリーナーで非表示の画像（display:none / visibility:hidden / opacity:0）は除外
 *   - `__cpaImageDownloaderRunning` で同一フレーム二重実行防止
 *   - fetch 先は ImageDownloader.ALLOWED_HOSTS の CDN のみ（任意オリジンへの代理 fetch 防止）
 *   - fetch は `credentials: "omit"` + `redirect: "manual"` + `referrerPolicy: "no-referrer"` で
 *     クロスオリジン認証情報送信を回避（既存 keepalive のパターンに揃える）
 */
(function () {
  if (window.__cpaImageDownloaderRunning === true) return;
  window.__cpaImageDownloaderRunning = true;
  if (window !== window.top) return;

  const host = ImageDownloader.detectHost(location);
  if (!host) return;

  /** @readonly host → master / features の storage key 解決テーブル */
  const HOST_CONFIG = {
    instagram: {
      master: StorageKeys.INSTAGRAM_CLEANER_ENABLED,
      features: StorageKeys.INSTAGRAM_CLEANER_FEATURES,
      applyMsg: Actions.APPLY_INSTAGRAM_CLEANER_CS,
    },
    tiktok: {
      master: StorageKeys.TIKTOK_CLEANER_ENABLED,
      features: StorageKeys.TIKTOK_CLEANER_FEATURES,
      applyMsg: Actions.APPLY_TIKTOK_CLEANER_CS,
    },
  };
  const cfg = HOST_CONFIG[host];
  if (!cfg) return;

  /** scheduleScan の debounce 時間。SPA で大量 DOM 変更が走るので 200ms に集約。 */
  const SCAN_DEBOUNCE_MS = 200;
  /** triggerBlobDownload で `<a>` を DOM から外す前の delay。Chrome がダウンロードを内部キューに
   *  載せるまでの猶予を確保し、`URL.revokeObjectURL` が早すぎて Blob が破棄される race を防ぐ。
   *  低スペック環境や高負荷時の DL 失敗対策。 */
  const BLOB_CLEANUP_DELAY_MS = 200;
  /** 個別 fetch のタイムアウト。CDN 遅延 / ネットワーク不通時にボタンが永久 BUSY になるのを防ぐ。
   *  keepalive.js の `AbortSignal.timeout(5000)` パターンに揃え、画像取得は HEAD/GET より重いので
   *  10 秒を採用。AbortSignal.any は Chrome 116+ サポート、minimum_chrome_version 140 で問題なし。 */
  const FETCH_TIMEOUT_MS = 10_000;

  /** 同一画像への click 多重押下防止用の WeakSet（busy class とは独立） */
  const inFlightDownloads = new WeakSet();

  let active = false;
  let mutationObserver = null;
  let scanScheduled = false;
  /** active な fetch 群を一括キャンセルするための AbortController（OFF 時に abort） */
  let abortController = null;

  // === Site adapters: コンテンツ画像判定 + 最大解像度 URL 候補列挙 ===

  /**
   * 各 adapter の責務:
   *   - isContentImage(img): コンテンツ画像（動画サムネ / 投稿写真 / コミュニティ投稿）なら true
   *   - resolveMaxResUrl(img): 最大解像度 URL → フォールバック URL の配列を返す（先頭から fetch
   *     して 200 OK を返したもので決定）
   *
   * 共通の前提: src 取得 / data: URI 排除 / サイズ閾値判定は decorateImage 側で済んでいる。
   * adapter は「サイト固有の DOM 構造判定」と「最大解像度 URL 解決」のみ担当する。
   */
  const adapters = {
    instagram: {
      isContentImage(img) {
        // header / プロフィール画像 / アバター除外
        if (img.closest('header, [role="banner"]')) return false;
        // ストーリーアバターは Instagram の DOM で同じ親要素内に <canvas>（リング）+ <img>（プロフィール
        // 画像）として並ぶ。前兄弟が canvas の場合をストーリーアバター扱いで除外する。
        if (img.previousElementSibling?.tagName === "CANVAS") return false;
        // role=button 配下のストーリーボタン（aria-label 内のロケール非依存判定）
        if (img.closest('[role="button"][aria-label*="story" i], [data-testid*="story" i]')) return false;
        // ナビ・ボタン系除外
        if (img.closest("nav, button")) return false;

        // 投稿配下のみ通す:
        //   - <article> 配下: フィード / 単独投稿ページ (/p/{shortcode}/)
        //   - a[href*="/p/"] / a[href*="/reel/"] 配下: プロフィール grid のサムネリンク
        //   - [role="dialog"] 配下: プロフィール grid からサムネクリックで開く投稿モーダル
        //     (Instagram は SPA で URL を /p/{shortcode}/ に書き換えるが DOM 上は dialog で
        //      <article> や <a> でラップされていないため、明示的に dialog 配下を通す必要あり)
        const inArticle = img.closest("article");
        const inPostLink = img.closest('a[href*="/p/"], a[href*="/reel/"]');
        const inDialog = img.closest('[role="dialog"]');
        return Boolean(inArticle || inPostLink || inDialog);
      },
      resolveMaxResUrl(img) {
        return collectSrcsetCandidates(img);
      },
    },

    tiktok: {
      isContentImage(img) {
        // avatar / プロフィール画像除外
        if (img.closest('[data-e2e*="avatar" i], [class*="DivAvatar"], [class*="Avatar"]')) return false;
        // ボタン / アイコン除外
        if (img.closest("button, [class*='IconWrapper']")) return false;

        // 対象: (1) modal viewer (Browser Mode で開いた photo / video)、
        //       (2) ユーザーページ / For You フィードの post item、
        //       (3) photo / video の直接 URL アクセス時の link wrap、
        //       (4) photo / video の直接 URL アクセス時のメインコンテナ
        //           (`<section data-e2e="feed-video">` 内、swiper カルーセルの ImgPhotoSlide)。
        // ⚠️ 重要: `<a href="/photo/">` / `<a href="/video/">` は CSS Grid + aspect-ratio
        // レイアウトを担う wrapper のため、ここに `__cpa-img-dl-host` を当てると width:0 で潰れる
        // （実機検証で確定）。これを回避するため findHostEl の TikTok 経路で <a> を skip し、
        // <picture> の親 <span style="position:absolute; inset:0">（= 画像と同サイズ）を host
        // にする。<a> には一切触らないので Grid sizing は無傷。
        const inModal = img.closest('[class*="DivBrowserModeContainer"], [class*="DivVideoContainer"]');
        const inFeedItem = img.closest('[data-e2e*="feed-item" i], [data-e2e*="user-post-item" i]');
        const inPostLink = img.closest('a[href*="/photo/"], a[href*="/video/"]');
        const inFeedVideo = img.closest('[data-e2e="feed-video"]');
        return Boolean(inModal || inFeedItem || inPostLink || inFeedVideo);
      },
      resolveMaxResUrl(img) {
        return collectSrcsetCandidates(img);
      },
    },
  };

  const adapter = adapters[host];

  // === 共通ヘルパ ===

  /** 表示サイズ or 自然サイズが閾値を超えるか（width / height のいずれかで判定） */
  function passesSizeThreshold(img) {
    const w = Math.max(img.naturalWidth || 0, img.width || 0, img.clientWidth || 0);
    const h = Math.max(img.naturalHeight || 0, img.height || 0, img.clientHeight || 0);
    return w >= ImageDownloader.MIN_SIZE_PX || h >= ImageDownloader.MIN_SIZE_PX;
  }

  /**
   * `<img srcset>` を解析して最大幅の URL を先頭にした候補配列を返す。
   * srcset 解析失敗時は currentSrc / src を単独で返す。
   */
  function collectSrcsetCandidates(img) {
    const fallback = img.currentSrc || img.src || "";
    const srcset = img.srcset || "";
    if (!srcset) return fallback ? [fallback] : [];

    const parsed = [];
    for (const part of srcset.split(",")) {
      const m = part.trim().match(/^(\S+)\s+(\d+(?:\.\d+)?)(w|x)$/);
      if (!m) continue;
      parsed.push({ url: m[1], rank: parseFloat(m[2]) });
    }
    if (!parsed.length) return fallback ? [fallback] : [];
    parsed.sort((a, b) => b.rank - a.rank);

    const urls = parsed.map((p) => p.url);
    if (fallback && !urls.includes(fallback)) urls.push(fallback);
    return urls;
  }

  /**
   * 要素が画面上で実質可視か。computed style の display/visibility/opacity と offsetParent の
   * 両方で判定（display:none の祖先を持つ場合は offsetParent === null になる）。
   */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  /**
   * `<img>` の overlay host となる祖先を返す。
   *
   * 深さ上限 4 は YouTube の典型構造 `<a#thumbnail> > <yt-image> > <div> > <img>` をカバーする
   * ために設定している。Instagram / TikTok でも投稿画像は概ね 2-3 階層内に `<a>` / `<figure>`
   * / コンテナ DOM があり、この上限で十分。深く辿りすぎると親の親まで巻き込んで他 UI への副作用
   * 範囲が広がるため意図的に浅く制限している。
   *
   * fallback パス（`<a>` / `<figure>` が見つからない場合）では、`hasOverlayingSibling()` で
   * 「兄弟に画像と完全重複する absolute/fixed overlay が居るか」を検査し、いれば host を 1 階層
   * 上げる。これは Instagram のモーダル投稿ビューが
   *   `_aagu > _aagv (img を含む) + DIV (透明クリック overlay, sibling)`
   * という構造を取っており、`_aagv` を host にすると (1) overlay の `:hover` が host に届かず
   * button が opacity:0 のまま、(2) overlay が source order で後の sibling のため z-index 競合で
   * button が裏に隠れる、の二重問題が発生するため。1 階層上げて `_aagu` を host にすれば
   * overlay と button が同じ stacking context の兄弟になり、button の z-index と overlay 内の
   * 子孫 hover の両方が解決する。
   */
  function findHostEl(img) {
    // TikTok 専用: <a href="/photo/"> / <a href="/video/"> はフィードカード全体を wrap して
    // CSS Grid + aspect-ratio sizing を担うため、host class (`position: relative !important`)
    // を当てると width:0 で潰れる（実機検証で確定）。
    //
    // TikTok の image lazy loader は <picture> > <img> 構造で、その親に
    // `<span style="position:absolute; inset:0">` がある場合がある。span は inline 要素のため
    // absolute にしても containing block としての挙動が不安定で button 配置がカード外に飛び出る
    // 実機問題があった。さらに 1 階層上の <div> (TikTok だと StyledCover ee46mhe0) を host に
    // すれば確実な block-level container として button の絶対配置基準になる。
    // modal viewer / feed grid いずれでも同じ <picture>/<span>/<div> 構造で動作する想定。
    if (host === ImageDownloader.HOSTS.TIKTOK) {
      let el = img.parentElement;
      // <picture> を skip して 1 階層上げる
      if (el && el.tagName === "PICTURE") el = el.parentElement;
      // <span> も skip して block 要素 <div> まで上げる
      if (el && el.tagName === "SPAN") el = el.parentElement;
      return el || img.parentElement;
    }

    let el = img.parentElement;
    let depth = 0;
    while (el && depth < 4) {
      const tag = el.tagName;
      if (tag === "A" || tag === "FIGURE") return el;
      el = el.parentElement;
      depth++;
    }
    const direct = img.parentElement;
    // sibling overlay 検出は Instagram モーダル特化の hack のため、Instagram でのみ実行する。
    // YouTube / TikTok の DOM 変更で誤判定して host が想定外に祖先に上がるリスクを避ける（rere レビュー D-2）。
    if (host === ImageDownloader.HOSTS.INSTAGRAM && direct && hasOverlayingSibling(direct)) {
      const grandParent = direct.parentElement;
      if (grandParent) return grandParent;
    }
    return direct;
  }

  /**
   * 指定要素に「ほぼ同サイズで重なる absolute/fixed positioned な兄弟」が存在するか判定。
   * Instagram のモーダル投稿ビューが透明クリック overlay を sibling として配置する構造の検出用。
   * 80% 以上の重複面積を「重なっている」と見なす（小さなツールチップ等は誤検出しない）。
   * 呼び出しは findHostEl の `host === "instagram"` 経路に閉じ込めて他サイトへの誤動作を防ぐ。
   */
  function hasOverlayingSibling(el) {
    const parent = el.parentElement;
    if (!parent) return false;
    const elRect = el.getBoundingClientRect();
    if (elRect.width <= 0 || elRect.height <= 0) return false;
    for (const sibling of parent.children) {
      if (sibling === el) continue;
      const cs = getComputedStyle(sibling);
      if (cs.position !== "absolute" && cs.position !== "fixed") continue;
      const sRect = sibling.getBoundingClientRect();
      const overlapW = Math.min(sRect.right, elRect.right) - Math.max(sRect.left, elRect.left);
      const overlapH = Math.min(sRect.bottom, elRect.bottom) - Math.max(sRect.top, elRect.top);
      if (overlapW <= 0 || overlapH <= 0) continue;
      if (overlapW * overlapH >= elRect.width * elRect.height * 0.8) return true;
    }
    return false;
  }

  /**
   * host 要素が既に positioned (relative/absolute/fixed/sticky) かを判定。
   * static のときだけ `__cpa-img-dl-host` クラス (`position: relative`) を付け、それ以外は
   * 既存 position を尊重して `__cpa-img-dl-host-positioned` を当てる（CSS 側で position は
   * 触らず、子の overlay button の絶対配置のみ機能する）。
   *
   * これにより TikTok modal viewer (`DivBrowserModeContainer` 配下の `position: absolute`)
   * のレイアウトを壊さずに button を配置できる。
   */
  function applyHostPositionClass(hostEl) {
    if (
      hostEl.classList.contains(ImageDownloader.HOST_CLASS) ||
      hostEl.classList.contains(ImageDownloader.HOST_POSITIONED_CLASS)
    ) {
      return;
    }
    const pos = getComputedStyle(hostEl).position;
    if (pos === "static" || pos === "" /* IE 互換だが念のため */) {
      hostEl.classList.add(ImageDownloader.HOST_CLASS);
    } else {
      hostEl.classList.add(ImageDownloader.HOST_POSITIONED_CLASS);
    }
  }

  // === ボタン UI 構築 ===

  function buildDownloadIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    const path = document.createElementNS(NS, "path");
    path.setAttribute(
      "d",
      "M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 1.4-1.42L11 13.59V4a1 1 0 0 1 1-1Zm-7 16a1 1 0 1 1 0 2h14a1 1 0 1 1 0-2H5Z"
    );
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    return svg;
  }

  /**
   * button の位置を img の `getBoundingClientRect()` に揃える。host (button の親) のサイズが
   * img より大きいケース (TikTok の StyledCover が card 全体サイズで img が中央配置 等) に対応。
   * top / left を「host の左上から img の左上までの offset + INNER_PADDING_PX」で設定する。
   * CSS デフォルト (top:16px; left:16px) を上書きするので transform (hover アニメ) はそのまま機能する。
   *
   * TikTok のフィードカードは右上に photo icon、下部に like count overlay、サムネ全体が SPA の
   * クリックターゲットになっており、UI 要素が画像枠の近くに密集している。Instagram (16px) より
   * 大きめの 24px 余白にして UI 群との干渉を避ける。
   */
  function syncButtonPosition(button, img) {
    const hostEl = button.parentElement;
    if (!hostEl || !hostEl.isConnected) return;
    const hostRect = hostEl.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    if (imgRect.width <= 0 || imgRect.height <= 0) return;

    const padding = host === ImageDownloader.HOSTS.TIKTOK ? 24 : 16;
    const top = imgRect.top - hostRect.top + padding;
    const left = imgRect.left - hostRect.left + padding;
    button.style.top = top + "px";
    button.style.left = left + "px";
    button.style.right = "auto";
  }

  function buildButton(img) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = ImageDownloader.BUTTON_CLASS;
    const dlLabel = chrome.i18n.getMessage("imageDownloadButtonLabel") || "画像をダウンロード";
    btn.setAttribute("aria-label", dlLabel);
    btn.title = dlLabel;
    btn.appendChild(buildDownloadIcon());
    // capture phase で stop して、下層要素の click（YouTube サムネクリック → 動画再生等）に伝播させない
    btn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        onDownloadClick(btn, img);
      },
      true
    );
    // mousedown も capture して、サイト側のドラッグ・click 処理が先に走らないようにする
    btn.addEventListener(
      "mousedown",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
      },
      true
    );
    return btn;
  }

  // === ダウンロード処理 ===

  async function onDownloadClick(btn, img) {
    if (inFlightDownloads.has(img)) return;
    if (!active) return;
    inFlightDownloads.add(img);
    btn.classList.add(ImageDownloader.BUSY_CLASS);
    btn.disabled = true;
    const signal = abortController ? abortController.signal : null;
    try {
      const candidates = adapter.resolveMaxResUrl(img);
      if (!candidates.length) throw new Error("no source URL");
      const result = await fetchFirstAvailable(candidates, signal);
      if (!result) throw new Error("all candidates failed");
      // OFF 切替後の進行中 fetch は戻ってきても downloadトリガしない
      if (!active || (signal && signal.aborted)) return;
      const filename = ImageDownloader.buildFilename(host, result.blob.type);
      triggerBlobDownload(result.blob, filename);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.warn("[WebViewingAssist] image download failed:", err);
    } finally {
      btn.classList.remove(ImageDownloader.BUSY_CLASS);
      btn.disabled = false;
      inFlightDownloads.delete(img);
    }
  }

  /**
   * 候補 URL を順に fetch し、最初に 200 OK を返したもので決定する。
   *
   * セキュリティ要件:
   *   - `credentials: "omit"` でクロスオリジン Cookie 送信を回避（YouTube/Instagram/TikTok の
   *     公開 CDN は認証不要、ブラウザが既に `<img>` をロードできているなら同条件で fetch 可能）
   *   - `redirect: "manual"` で 302 経由の第三者ドメインへの認証情報送信経路を遮断。
   *     opaqueredirect レスポンスは ok が常に false 扱い → 次候補へスキップ
   *   - `referrerPolicy: "no-referrer"` でリファラ送信ゼロ
   *   - hostname を ImageDownloader.ALLOWED_HOSTS で検証 → 各サイトの正規 CDN 以外は弾く
   *     （攻撃者注入 `<img>` 経由の代理 fetch 防止）
   */
  async function fetchFirstAvailable(urls, signal) {
    for (const url of urls) {
      if (!url) continue;
      if (!ImageDownloader.isAllowedFetchUrl(host, url)) continue;
      // ユーザーが OFF にしたときの abort signal と、個別 fetch の timeout を AbortSignal.any で合成。
      // どちらが先に発火しても fetch がキャンセルされる。signal が null のときは timeout のみ。
      const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      try {
        const res = await fetch(url, {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "manual",
          signal: combinedSignal,
        });
        if (res.type === "opaqueredirect") continue;
        if (!res.ok) continue;
        const blob = await res.blob();
        if (blob && blob.size > 0) return { url, blob };
      } catch (err) {
        // ユーザー abort（OFF 切替）は throw で上位に伝播。timeout / TimeoutError / その他は次候補へ。
        if (err && err.name === "AbortError" && signal && signal.aborted) throw err;
        // TimeoutError は AbortError サブタイプだが signal.aborted が false なので次候補に行く。
      }
    }
    return null;
  }

  function triggerBlobDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    // Chrome がダウンロードを内部キューへ載せる猶予を持たせて Blob を解放する。
    // 0ms だと低スペック環境で revoke が click より先に効いて DL 失敗する race がある。
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(blobUrl);
    }, BLOB_CLEANUP_DELAY_MS);
  }

  // === DOM スキャン ===

  /**
   * decorateImage の冒頭で行う共通ガード。
   * 戻り値が文字列なら src（評価成功 = 続行可能 / 古いボタンの撤去判定にも使う）、
   * null なら「処理対象外」（接続切断・data: URI・サイズ未満・非可視）。
   */
  function readImageSrcOrNull(img) {
    if (!img || !img.isConnected) return null;
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith("data:")) return null;
    // 安価なサイズ判定 (naturalWidth/clientWidth は既存 layout 値の読み出しのみで
    // リフロー誘発なし) を `isVisible` (getComputedStyle) より先に置く。Instagram
    // フィードで <img> 50〜100 枚に対するスタイル計算コストを削減する (/rere C 3-F)。
    if (!passesSizeThreshold(img)) return null;
    if (!isVisible(img)) return null;
    return src;
  }

  function decorateImage(img) {
    const currentSrc = readImageSrcOrNull(img);
    if (!currentSrc) return;

    const lastSrc = img.dataset[ImageDownloader.SCANNED_SRC_DATASET_KEY];

    // src が変わっていなければ（前回の判定結果がそのまま有効）button 位置だけ再 sync する。
    // host や img のサイズが SPA navigation / lazy load / window resize で変わっているケースに対応。
    // SKIP マーカーが付いてる場合は decorate 対象外なので何もしない。
    if (lastSrc === currentSrc) {
      const hostElCached = findHostEl(img);
      if (hostElCached) {
        const existingBtn = hostElCached.querySelector(`:scope > .${ImageDownloader.BUTTON_CLASS}`);
        if (existingBtn) syncButtonPosition(existingBtn, img);
      }
      return;
    }

    // src が変わった、または skip マーカーが残っているケース → 古い装飾を撤去して再評価
    if (lastSrc) {
      detachOverlayForImage(img);
    }

    if (!adapter.isContentImage(img)) {
      img.dataset[ImageDownloader.SCANNED_SRC_DATASET_KEY] = ImageDownloader.SKIP_MARKER + ":" + currentSrc;
      return;
    }
    const hostEl = findHostEl(img);
    if (!hostEl) return;

    applyHostPositionClass(hostEl);
    if (!hostEl.querySelector(`:scope > .${ImageDownloader.BUTTON_CLASS}`)) {
      const button = buildButton(img);
      hostEl.appendChild(button);
      // host サイズが img より大きいケース対策: JS で button 位置を img の rect に同期。
      // 初回 sync + img の load (lazy load 等で後からサイズ確定する場合) で再同期。
      syncButtonPosition(button, img);
      if (!img.complete) {
        img.addEventListener("load", () => syncButtonPosition(button, img), { once: true });
      }
    }
    img.dataset[ImageDownloader.SCANNED_SRC_DATASET_KEY] = currentSrc;
  }

  /**
   * 1 つの img に紐づく overlay (host class + button) を撤去する。
   * 同じ hostEl に複数 img があるケースを考慮し、host class は他に dataset 持ち img が無い
   * ことを確認してから外す（他の img 装飾を巻き込まないため）。
   */
  function detachOverlayForImage(img) {
    const hostEl = findHostEl(img);
    if (!hostEl) return;
    const btn = hostEl.querySelector(`:scope > .${ImageDownloader.BUTTON_CLASS}`);
    if (btn) btn.remove();
    // host に紐づく他の処理済み img が無ければ host class も外す
    const stillTracked = hostEl.querySelector(ImageDownloader.SCANNED_SRC_ATTR_SELECTOR);
    if (!stillTracked) {
      hostEl.classList.remove(ImageDownloader.HOST_CLASS);
      hostEl.classList.remove(ImageDownloader.HOST_POSITIONED_CLASS);
    }
  }

  function scanAllImages() {
    if (!active) return;
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      decorateImage(img);
    }
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanAllImages();
    }, SCAN_DEBOUNCE_MS);
  }

  function removeAllOverlays() {
    const buttons = document.querySelectorAll("." + ImageDownloader.BUTTON_CLASS);
    buttons.forEach((b) => b.remove());
    document.querySelectorAll("." + ImageDownloader.HOST_CLASS).forEach((h) => {
      h.classList.remove(ImageDownloader.HOST_CLASS);
    });
    document.querySelectorAll("." + ImageDownloader.HOST_POSITIONED_CLASS).forEach((h) => {
      h.classList.remove(ImageDownloader.HOST_POSITIONED_CLASS);
    });
    document.querySelectorAll(ImageDownloader.SCANNED_SRC_ATTR_SELECTOR).forEach((i) => {
      delete i.dataset[ImageDownloader.SCANNED_SRC_DATASET_KEY];
    });
  }

  function startObserver() {
    if (mutationObserver) return;
    abortController = new AbortController();
    mutationObserver = new MutationObserver(() => scheduleScan());
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"],
    });
    scheduleScan();
  }

  function stopObserver() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    removeAllOverlays();
  }

  function computeActive(stored) {
    if (stored[cfg.master] !== true) return false;
    const features = stored[cfg.features];
    if (!features || typeof features !== "object") return false;
    return features.imageDownload === true;
  }

  function applyState(stored) {
    const next = computeActive(stored);
    if (next === active) {
      // 同 ON のときは DOM 更新だけトリガ（features の他キー変更で呼ばれた場合の保険）
      if (active) scheduleScan();
      return;
    }
    active = next;
    if (active) startObserver();
    else stopObserver();
  }

  // === 初期化 + storage / message 同期 ===

  chrome.storage.local.get([cfg.master, cfg.features], (stored) => {
    if (chrome.runtime.lastError) return;
    applyState(stored);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!(cfg.master in changes) && !(cfg.features in changes)) return;
    // changes には newValue が含まれているため、storage.local.get の追加 IPC を発行せず
    // 直接 newValue を使う。片方しか変わっていない場合は他方を get で補完する必要があるが、
    // 両方変わるケースが多いため fast path として newValue 直読みを優先する。
    const masterChange = changes[cfg.master];
    const featuresChange = changes[cfg.features];
    if (masterChange && featuresChange) {
      applyState({
        [cfg.master]: masterChange.newValue,
        [cfg.features]: featuresChange.newValue,
      });
      return;
    }
    // 片方のみ変化: 変わっていない方を get で補完（IPC 1 回だけ）
    chrome.storage.local.get([cfg.master, cfg.features], (stored) => {
      if (chrome.runtime.lastError) return;
      applyState(stored);
    });
  });

  chrome.runtime.onMessage.addListener((msg, sender, _sendResponse) => {
    if (!SenderCheck.isFromBackground(sender)) return false;
    // background.js の notifyContentScripts は `{ action, data }` 形式で送信するため、
    // 他の content script (search-fixer.js / instagram-cleaner.js / tiktok-cleaner.js) と
    // 揃えて msg.action を読む（旧コードの msg.type は dead code バグだった）。
    const action = msg && msg.action;
    if (action !== cfg.applyMsg) return false;
    chrome.storage.local.get([cfg.master, cfg.features], (stored) => {
      if (chrome.runtime.lastError) return;
      applyState(stored);
    });
    return false;
  });
})();
