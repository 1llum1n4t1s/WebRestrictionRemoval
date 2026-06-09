"use strict";

/**
 * 動画ガンマ補正 content script (v2: video-fill と対称な lifecycle 設計、2026-06-09 改修)。
 *
 * 全 http(s) ページの全フレームに注入され、`<video>` 要素に対して SVG
 * `<feComponentTransfer type="gamma">` フィルタを適用する。マスタートグル
 * (`videoGammaEnabled`) ON かつガンマ値 (`videoGammaValue`) が 1.0 以外のときだけ
 * SVG host を `<body>` に注入し、各 video element に **inline filter style** を当てる。
 * それ以外の状態では DOM ごと撤去する完全 no-op。
 *
 * iframe 内 `<video>` も対象にするため manifest の content_scripts.all_frames は true。
 * SVG filter の URL fragment 参照は同一ドキュメント内に閉じるため、各 frame の
 * content script もそれぞれ自分のドキュメントに対して inject する。
 *
 * # ライフサイクル設計 (v1.0.40 → v1.0.41 で変更、video-fill と統一)
 *
 * **旧設計 (〜v1.0.40)**: `<head>` に `<style>html body video { filter: url(#...) !important }</style>`
 * を注入し、CSS rule で全 `<video>` に一斉適用する方式。実装はシンプルだが video element の
 * ライフサイクルと無関係に filter が当たるため、DRM 動画 player の session 取得中に
 * filter が hit して player attestation を干渉する理論的リスクがあった。
 *
 * **新設計 (v1.0.41〜)**: video-fill.js と完全に対称な per-video lifecycle 設計:
 *   - `loadedmetadata` 待ちで apply (DRM player の session 取得完了後)
 *   - per-video inline `style.setProperty("filter", "url(#...)", "important")` で site stylesheet
 *     の `!important` にも勝つ (inline !important は author origin で最も強い)
 *   - 元 inline filter は WeakMap (`original`) に退避し、撤去時に復元
 *   - `metaListenerCtrl` (AbortController) で listener 一括 abort (revertAll で詰め直し)
 *   - `metaAttached` (WeakSet) で二重登録防止 + revertAll で `new WeakSet()` 差し替えにより
 *     detach 済み video も含めた追跡を O(1) 一括リセット (= Codex 4 巡目 P2 と同型対策)
 *   - MutationObserver(subtree) で SPA / 遅延追加 video を追従、detach 検知時は即 revertVideo
 *   - rAF coalesce で高頻度 mutation を 1 フレーム 1 回に間引き
 *   - `pagehide` (persisted=false) で teardown、bfcache 凍結 (persisted=true) は温存
 *   - 拡張リロード後の orphan 化を `chrome.runtime?.id` で検知し observer 切断 + revertAll + svg 撤去
 *
 * **改修の動機 (2026-06-09)**: ゆろ君 U-NEXT 黒画面事例の調査で「Vuora は無実」確定後、ゆろ君の
 * 「誤動作するようなロジックがあったら改善したい」発言を受けて video-gamma の lifecycle 設計を
 * video-fill と統一。CSS rule 一斉注入が「video element の readyState 関係なく filter 当たる」
 * = DRM player init 中の干渉リスクを構造的に持つことを設計差として認識し、video-fill 同型の
 * 「video ごと + loadedmetadata 待ち + WeakMap original + AbortController」に統一して、
 * DRM session 取得が完了してから filter が当たる挙動に変更。
 *
 * 設計メモ:
 *   - SVG は DOMParser("image/svg+xml") で XML として組み立て、document.importNode で
 *     取り込む。createElementNS では `color-interpolation-filters` 等の hyphen 付き属性や
 *     namespace 解釈で Chromium が filter を解決できないケースが報告されているが、XML
 *     パーサに名前空間ごと解釈させれば安定する（HTML5 パーサ + innerHTML 経路は AMO の
 *     UNSAFE_VAR_ASSIGNMENT 警告対象になるため不採用）。
 *   - `<svg>` は `<body>` 末尾に置き、SPA 等で body 配下が書き換わったら applyState の冪等性で
 *     再注入する。`<style>` 注入は廃止（per-video inline style に統一）。
 *
 * 二重実行防止: `window.__cpaVideoGammaRunning` フラグで同一フレーム内の重複起動を弾く。
 */

(() => {
  if (window.__cpaVideoGammaRunning === true) return;
  window.__cpaVideoGammaRunning = true;

  let currentEnabled = false;
  let currentValue = VideoGamma.DEFAULT;

  /** el → 退避した元の inline filter（撤去時に復元）。video-fill と同型: WeakMap 1 本で追跡、
   *  detach は MutationObserver の removedNodes で即 revertVideo するので strong ref を持たず、
   *  revertAll は DOM 上の video だけ走査すれば取りこぼしゼロ。 */
  const original = new WeakMap();
  let observer = null;
  /** observer コールバックの全 video 再走査を rAF で coalesce するためのハンドル (0 = 未予約)。
   *  all_frames:true + YouTube 等の高頻度 DOM 変更で mutation バッチごとに scan を同期実行すると
   *  冗長なフル走査が積み重なる。detach の即時 revert は同期のまま、ensureMetaListener 経由の
   *  再 attach だけを 1 フレーム 1 回に間引く。 */
  let scanRaf = 0;
  let orphaned = false;
  /** loadedmetadata listener の一括 abort 用 AbortController。revertAll() で abort して
   *  新 AbortController に差し替え、metaAttached WeakSet も新品にして detach 済み含め O(1) リセット。 */
  let metaListenerCtrl = new AbortController();
  /** loadedmetadata listener を attach 済みの video 集合 (二重登録防止)。
   *  WeakSet にして revertAll で `new WeakSet()` 差し替えで detach 済みも一括リセット。
   *  DOM プロパティマーカーだと detach 済みを取り残し reinsert+再 ON 時に listener 再 attach
   *  できないため WeakSet を採用 (video-fill の Codex 4 巡目 P2 と同型対策)。 */
  let metaAttached = new WeakSet();

  function isActive() {
    return currentEnabled === true && !VideoGamma.isUnity(currentValue);
  }

  /**
   * SVG filter ノードを DOMParser("image/svg+xml") で構築し、現ドキュメントに
   * importNode で取り込んで返す。XML パーサが SVG namespace を正しく解釈するため、
   * createElementNS の hyphen 付き属性問題も innerHTML の AMO 警告も両方回避できる。
   *
   * 値は VideoGamma.clampValue で数値化済みの exponent のみで、ユーザー入力や外部
   * 文字列を埋め込む経路はないため XSS 経路はゼロ。
   */
  function buildSvgFilter(exponent) {
    const e = String(VideoGamma.clampValue(exponent));
    const markup =
      `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" focusable="false" aria-hidden="true">` +
        `<defs>` +
          `<filter id="${VideoGamma.FILTER_ID}" color-interpolation-filters="sRGB" x="0%" y="0%" width="100%" height="100%">` +
            `<feComponentTransfer>` +
              `<feFuncR type="gamma" amplitude="1" exponent="${e}" offset="0"/>` +
              `<feFuncG type="gamma" amplitude="1" exponent="${e}" offset="0"/>` +
              `<feFuncB type="gamma" amplitude="1" exponent="${e}" offset="0"/>` +
            `</feComponentTransfer>` +
          `</filter>` +
        `</defs>` +
      `</svg>`;
    const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
    return document.importNode(doc.documentElement, true);
  }

  /**
   * SVG filter ホスト要素を確保 / 更新。`<div>` でラップし、子ノードを差し替える形で
   * 再構築する。innerHTML を使わないことで AMO の UNSAFE_VAR_ASSIGNMENT 警告を回避。
   */
  function ensureSvgFilter(exponent) {
    let host = document.getElementById(VideoGamma.SVG_ID);
    const svg = buildSvgFilter(exponent);
    if (host) {
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(svg);
      return;
    }
    host = document.createElement("div");
    host.id = VideoGamma.SVG_ID;
    host.setAttribute("aria-hidden", "true");
    // 視覚的には完全非表示（左上 1×1 + overflow:hidden）。display:none だと一部の
    // Chromium バージョンで filter リソースが解決されない事象が報告されているため、
    // off-screen に押し込む方式を採用。
    host.style.cssText =
      "position:absolute!important;" +
      "left:-9999px!important;" +
      "top:-9999px!important;" +
      "width:1px!important;" +
      "height:1px!important;" +
      "overflow:hidden!important;" +
      "pointer-events:none!important;";
    host.appendChild(svg);
    (document.body || document.documentElement).appendChild(host);
  }

  function removeSvgFilter() {
    const host = document.getElementById(VideoGamma.SVG_ID);
    if (host) host.remove();
  }

  function applyToVideo(v) {
    if (!original.has(v)) {
      original.set(v, {
        filter: v.style.getPropertyValue("filter"),
        filterPriority: v.style.getPropertyPriority("filter"),
      });
    }
    v.style.setProperty("filter", `url(#${VideoGamma.FILTER_ID})`, "important");
  }

  function revertVideo(v) {
    if (!original.has(v)) return;
    const o = original.get(v);
    if (o.filter) v.style.setProperty("filter", o.filter, o.filterPriority);
    else v.style.removeProperty("filter");
    original.delete(v);
  }

  function revertAll() {
    // DOM 上の video を走査して revert。detach 済み video は observer の removedNodes 検知時に
    // 既に revertVideo 済みなので、ここで取りこぼしても OFF 後に inline filter が残ることはない。
    const vids = document.getElementsByTagName("video");
    for (let i = 0; i < vids.length; i++) revertVideo(vids[i]);
    // loadedmetadata listener を一括 abort し、attach 追跡 WeakSet も新品に差し替えて
    // 全 video 分 (detach 済み含む) を O(1) でリセットする (video-fill と同型)。
    metaListenerCtrl.abort();
    metaListenerCtrl = new AbortController();
    metaAttached = new WeakSet();
  }

  /**
   * loadedmetadata で apply (DRM player の session 取得完了後に filter を当てる)。
   * 既に readyState >= HAVE_METADATA の video には listener 待ちせず即 apply。
   * 旧 CSS rule 方式 (video 出現次第即時 apply) で player init 中に filter 干渉する
   * 理論的リスクを回避するため、ライフサイクルを video-fill と統一。
   */
  function ensureMetaListener(v) {
    if (metaAttached.has(v)) return;
    metaAttached.add(v);
    // 既に metadata 取得済みなら即 apply (listener 待ちで永遠に当たらない罠を回避)。
    if (v.readyState >= 1 /* HAVE_METADATA */) {
      if (isActive()) applyToVideo(v);
      return;
    }
    v.addEventListener(
      "loadedmetadata",
      () => {
        if (isActive()) applyToVideo(v);
      },
      { signal: metaListenerCtrl.signal }
    );
  }

  function scanAndApply() {
    const vids = document.getElementsByTagName("video");
    for (let i = 0; i < vids.length; i++) {
      ensureMetaListener(vids[i]);
    }
  }

  // observer からの再走査を rAF で 1 フレーム 1 回に間引く (detach の即時 revert は呼び出し側で
  // 同期実行されるので、ここでは ensureMetaListener 経由の再 attach だけを遅延)。
  function scheduleScan() {
    if (scanRaf !== 0) return;
    scanRaf = requestAnimationFrame(() => {
      scanRaf = 0;
      if (!chrome.runtime?.id) { teardownOrphan(); return; }
      if (isActive()) scanAndApply();
    });
  }

  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      if (!chrome.runtime?.id) {
        teardownOrphan();
        return;
      }
      if (!isActive()) return;
      // detach された inline filter 済み video を即 revert (video-fill と同型 leak 対策)。
      // SPA が video を detach → ユーザーが機能 OFF → 同 video を再挿入、の順だと revertAll() は
      // DOM 上の video しか戻せず、detach 済み video に ON 時代の inline filter が残る。
      // 検出時点で revertVideo すれば再挿入時も素の状態に戻り、original WeakMap からも外れて
      // element の GC を妨げない。reparent (同一バッチで再挿入された video) は isConnected===true
      // で除外し、後続の scanAndApply で再 attach する。
      for (const rec of records) {
        for (const node of rec.removedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "VIDEO") {
            if (!node.isConnected) revertVideo(node);
          } else if (typeof node.querySelectorAll === "function") {
            const inner = node.querySelectorAll("video");
            for (let i = 0; i < inner.length; i++) {
              if (!inner[i].isConnected) revertVideo(inner[i]);
            }
          }
        }
      }
      scheduleScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function disconnectObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    // 予約済みの再走査 rAF も取り消す (disconnect 後に scanAndApply が走らないように)。
    if (scanRaf !== 0) {
      cancelAnimationFrame(scanRaf);
      scanRaf = 0;
    }
  }

  // 拡張リロード後の orphan content script: observer 停止 + inline filter を全 revert + svg 撤去。
  function teardownOrphan() {
    if (orphaned) return;
    orphaned = true;
    disconnectObserver();
    revertAll();
    removeSvgFilter();
  }

  function applyState() {
    if (isActive()) {
      ensureSvgFilter(currentValue);
      scanAndApply();
      ensureObserver();
    } else {
      disconnectObserver();
      revertAll();
      removeSvgFilter();
    }
  }

  function readSettingsAndApply() {
    // zombie guard (PATTERN SYNC): orphan 化した content script は chrome.runtime.id が undefined。
    if (!chrome.runtime?.id) {
      teardownOrphan();
      return;
    }
    chrome.storage.local
      .get([StorageKeys.VIDEO_GAMMA_ENABLED, StorageKeys.VIDEO_GAMMA_VALUE])
      .then((s) => {
        currentEnabled = s[StorageKeys.VIDEO_GAMMA_ENABLED] === true;
        currentValue = VideoGamma.clampValue(s[StorageKeys.VIDEO_GAMMA_VALUE]);
        applyState();
      })
      .catch(() => {});
  }

  // background → content script の即時通知（active tab の全フレームに broadcast される）。
  chrome.runtime.onMessage.addListener((req, sender) => {
    if (!SenderCheck.isFromBackground(sender)) return;
    if (req?.action !== Actions.APPLY_VIDEO_GAMMA_CS) return;
    const d = req.data ?? {};
    if (typeof d.enabled === "boolean") currentEnabled = d.enabled;
    if (Number.isFinite(d.value)) currentValue = VideoGamma.clampValue(d.value);
    applyState();
  });

  // 非 active タブも storage.onChanged で同期する。両キーのどちらか変化したときだけ
  // 設定を再取得して反映（変更されていないキーが undefined になる罠を回避）。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const changed =
      changes[StorageKeys.VIDEO_GAMMA_ENABLED] !== undefined ||
      changes[StorageKeys.VIDEO_GAMMA_VALUE] !== undefined;
    if (!changed) return;
    readSettingsAndApply();
  });

  // ページ遷移時のリソース解放 (video-fill と同型)。bfcache 凍結 (persisted=true) は observer も
  // 一緒に凍結されて CPU を消費しないので温存し、実際にドキュメントが破棄される遷移 (persisted=false)
  // でだけ disconnectObserver + revertAll + removeSvgFilter で teardownOrphan と同じ後始末。
  window.addEventListener("pagehide", (e) => {
    if (e.persisted) return;
    disconnectObserver();
    revertAll();
    removeSvgFilter();
  });

  readSettingsAndApply();
})();
