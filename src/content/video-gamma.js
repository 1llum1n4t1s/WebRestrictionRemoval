"use strict";

/**
 * 動画ガンマ補正 content script。
 *
 * 全 http(s) ページの全フレームに注入され、`<video>` 要素に対して SVG
 * `<feComponentTransfer type="gamma">` フィルタを適用する。マスタートグル
 * (`videoGammaEnabled`) ON かつガンマ値 (`videoGammaValue`) が 1.0 以外のときだけ
 * SVG / style を `<body>` に注入し、それ以外の状態では DOM ごと撤去する完全 no-op。
 *
 * iframe 内 `<video>` も対象にするため manifest の content_scripts.all_frames は true。
 * SVG filter の URL fragment 参照は同一ドキュメント内に閉じるため、各 frame の
 * content script もそれぞれ自分のドキュメントに対して inject する。
 *
 * 設計メモ:
 *   - SVG は DOMParser("image/svg+xml") で XML として組み立て、document.importNode で
 *     取り込む。createElementNS では `color-interpolation-filters` 等の hyphen 付き属性や
 *     namespace 解釈で Chromium が filter を解決できないケースが報告されているが、XML
 *     パーサに名前空間ごと解釈させれば安定する（HTML5 パーサ + innerHTML 経路は AMO の
 *     UNSAFE_VAR_ASSIGNMENT 警告対象になるため不採用）。
 *   - CSS セレクタは `html body video` で specificity を 0,0,0,3 まで底上げし、
 *     サイト側の `.foo { filter: ... !important }` (0,0,1,0) との競合に勝てるようにする。
 *   - `<style>` は `<head>` 末尾、`<svg>` は `<body>` 末尾に置き、SPA 等で body 配下が
 *     書き換わっても `<head>` 側は残る配置にしている（再注入は applyState で冪等）。
 *
 * 二重実行防止: `window.__cpaVideoGammaRunning` フラグで同一フレーム内の重複起動を弾く。
 */

(() => {
  if (window.__cpaVideoGammaRunning === true) return;
  window.__cpaVideoGammaRunning = true;

  let currentEnabled = false;
  let currentValue = VideoGamma.DEFAULT;

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

  /**
   * `<style>` を `<head>` に注入。CSS セレクタ `html body video` で specificity を
   * 0,0,0,3 + !important まで底上げし、サイト側のクラスセレクタ + !important に対しても
   * 確実に勝てるようにする。
   */
  function ensureStyle() {
    if (document.getElementById(VideoGamma.STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = VideoGamma.STYLE_ID;
    style.textContent =
      `html body video { filter: url(#${VideoGamma.FILTER_ID}) !important; }`;
    (document.head || document.documentElement).appendChild(style);
  }

  function cleanup() {
    const host = document.getElementById(VideoGamma.SVG_ID);
    if (host) host.remove();
    const style = document.getElementById(VideoGamma.STYLE_ID);
    if (style) style.remove();
  }

  function applyState() {
    if (isActive()) {
      ensureSvgFilter(currentValue);
      ensureStyle();
    } else {
      cleanup();
    }
  }

  function readSettingsAndApply() {
    // zombie guard (/rere レビュー B1-D3 / D-4 横展開 PATTERN SYNC):
    // 拡張機能リロード後の orphan content script では `chrome.runtime.id` が undefined。
    // listener 自体は orphan 化で発火停止するため重大な暴走経路はないが、SVG filter 要素が
    // 残置されると「拡張 OFF したのに動画が暗いまま」のユーザー体感に繋がるので、
    // 万一 listener が遅延発火した経路に備えて cleanup を実行する保険。
    if (!chrome.runtime?.id) {
      cleanup();
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
  // 他 content script との設計一貫性のため SenderCheck.isFromBackground で gate する
  // （rere レビュー A1 C1）。同一拡張内の sender 偽装は SenderCheck の三層検証で遮断される。
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

  readSettingsAndApply();
})();
