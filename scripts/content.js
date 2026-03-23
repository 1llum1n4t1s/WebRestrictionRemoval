(function () {
  "use strict";

  // 二重実行防止フラグ
  if (window.__copyPasteAssistRunning) return;
  window.__copyPasteAssistRunning = true;

  // ---------- 定数 ----------
  /** 画像オーバーレイ検出: 親要素の走査深度 */
  const IMG_OVERLAY_DEPTH = 2;
  /** 画像オーバーレイ検出: 透明判定の opacity 閾値 */
  const TRANSPARENT_OPACITY = 0.1;
  /** オーバーレイ除去: 画面カバレッジ閾値（80%以上で全画面とみなす） */
  const SCREEN_COVER_RATIO = 0.8;
  /** オーバーレイ除去: z-index 閾値 */
  const HIGH_Z_INDEX = 999;
  /** オーバーレイ除去: 半透明判定の opacity 閾値 */
  const BACKDROP_OPACITY = 0.95;
  /** SPA ナビゲーション検出のポーリング間隔 (ms) */
  const SPA_NAV_INTERVAL_MS = 1000;
  /** SPA ナビゲーション検出後の描画待ち遅延 (ms) */
  const SPA_NAV_PAINT_DELAY_MS = 1000;

  /**
   * イベントブロック/解除のデータ駆動テーブル。
   * 単純な「キャプチャフェーズでイベントを横取り + インラインハンドラ除去」パターンの
   * 機能をテーブルで一括定義し、applySettings の重複コードを排除する。
   */
  const EVENT_BLOCK_MAP = [
    { key: Features.RIGHT_CLICK, events: ["contextmenu"], attrs: ["oncontextmenu"] },
    { key: Features.PASTE, events: ["paste", "beforepaste"], attrs: ["onpaste", "onbeforepaste"] },
    { key: Features.COPY, events: ["copy", "beforecopy"], attrs: ["oncopy", "onbeforecopy"] },
    { key: Features.PRINT, events: ["beforeprint", "afterprint"], attrs: ["onbeforeprint", "onafterprint"] },
  ];

  /** 現在の設定状態 */
  let currentSettings = getDefaultSettings();

  /**
   * キャプチャフェーズでイベントを横取りし、サイトの制限を無効化する。
   * stopImmediatePropagation() でサイト側のリスナーが発火しないようにする。
   * handlerFn を渡すとカスタムハンドラを使用する（キーボード用）。
   */
  const handlers = {};

  function blockSiteHandler(eventName, handlerFn) {
    if (handlers[eventName]) return; // 既に登録済み
    const handler = handlerFn ?? ((e) => { e.stopImmediatePropagation(); });
    handlers[eventName] = handler;
    document.addEventListener(eventName, handler, true); // キャプチャフェーズ
  }

  function unblockSiteHandler(eventName) {
    if (!handlers[eventName]) return;
    document.removeEventListener(eventName, handlers[eventName], true);
    delete handlers[eventName];
  }

  /**
   * インライン属性ハンドラ（oncontextmenu, oncopy, onpaste, onselectstart）を除去する。
   * 属性セレクタで対象要素のみ取得し、全DOM走査を回避する。
   * さらに、JSで動的に設定されたハンドラにも対応するため、
   * 主要ノードのDOMプロパティを直接 null 化する。
   * メインワールドでの除去は requestMainWorldRemoval 経由で background.js が実行。
   */
  function removeInlineHandlers(attrNames) {
    // 1. HTML属性セレクタで対象要素のみ取得（querySelectorAll("*") の全走査を回避）
    const selector = attrNames.map((attr) => `[${attr}]`).join(",");
    const targets = document.querySelectorAll(selector);
    for (const el of targets) {
      for (const attr of attrNames) {
        el.removeAttribute(attr);
        el[attr] = null;
      }
    }
    // 2. 主要ノードのインラインハンドラを直接除去
    //    JSで動的に設定された場合、HTML属性がないため querySelectorAll では検出できない
    const roots = [document, document.documentElement, document.body];
    for (const root of roots) {
      if (!root) continue;
      for (const attr of attrNames) {
        root[attr] = null;
      }
    }
  }

  /** CSS クラスで制限解除スタイルを切り替える */
  function toggleCssClass(className, enable) {
    document.documentElement.classList.toggle(className, enable);
  }

  /**
   * キーボードショートカット制限解除用ハンドラ。
   * サイトがブロックしているキーのみ介入し、通常のキー入力は邪魔しない。
   */
  const PROTECTED_KEYS = new Set(["a", "c", "v", "x", "s", "p", "f", "g", "h", "j", "l", "u"]);
  const PROTECTED_F_KEYS = new Set(["F5", "F11", "F12"]);

  function keyboardUnblockHandler(e) {
    // Ctrl/Cmd + キー のショートカットを保護
    if ((e.ctrlKey || e.metaKey) && PROTECTED_KEYS.has(e.key.toLowerCase())) {
      e.stopImmediatePropagation();
      return;
    }
    // F5, F11, F12 を保護
    if (PROTECTED_F_KEYS.has(e.key)) {
      e.stopImmediatePropagation();
    }
  }

  /** keyup 用ハンドラ（applySettings のたびにクロージャ生成を回避） */
  function keyboardKeyupHandler(e) {
    if ((e.ctrlKey || e.metaKey) || PROTECTED_F_KEYS.has(e.key)) {
      e.stopImmediatePropagation();
    }
  }

  /**
   * 画像の上に配置された透明オーバーレイを検出・除去する。
   * pointer-events: none にすることで画像を直接操作可能にする。
   *
   * パフォーマンス対策:
   *   ページ全体の div/span を走査すると Instagram リール等で数万要素 ×
   *   getComputedStyle() の同期レイアウト計算が発生しフリーズする。
   *   代わりに img 要素の近傍（親2階層の子要素）のみを対象にする。
   *   画像オーバーレイは必ず画像の近くに配置されるため、これで十分。
   */
  function removeImageOverlays() {
    const images = document.querySelectorAll("img");
    const checked = new WeakSet();
    for (const img of images) {
      // 画像の親を IMG_OVERLAY_DEPTH 階層まで遡り、その直接の子要素のみをチェック
      let parent = img.parentElement;
      for (let depth = 0; depth < IMG_OVERLAY_DEPTH && parent; depth++) {
        if (checked.has(parent)) break;
        checked.add(parent);
        for (const child of parent.children) {
          if (child.tagName === "IMG") continue;
          applyImageOverlayFix(child);
        }
        parent = parent.parentElement;
      }
    }
  }

  /** 単一要素がオーバーレイ条件に合致すれば pointer-events: none にする */
  function applyImageOverlayFix(el) {
    const style = getComputedStyle(el);
    const isPositioned = style.position === "absolute" || style.position === "fixed";
    if (!isPositioned) return; // 早期スキップで getComputedStyle の後続プロパティ読み取りを回避
    const isTransparent = parseFloat(style.opacity) < TRANSPARENT_OPACITY ||
      style.backgroundColor === "transparent" ||
      style.backgroundColor === "rgba(0, 0, 0, 0)";
    const hasNoContent = el.children.length === 0 && el.textContent.trim() === "";

    if (isTransparent && hasNoContent) {
      el.style.setProperty("pointer-events", "none", "important");
    }
  }

  /**
   * SPA ナビゲーション（URL 変更）を検出し、画像オーバーレイ除去を再実行する。
   * MutationObserver は Instagram リール等で DOM 変更が毎フレーム発生し、
   * getComputedStyle() の同期レイアウト計算でフリーズするため使用しない。
   * URL ポーリング方式なら軽量で安全。
   */
  let spaNavTimer = null;
  let lastObservedUrl = "";
  let overlayDebounceTimer = null;

  function startImageOverlayObserver() {
    if (spaNavTimer) return;
    lastObservedUrl = location.href;
    spaNavTimer = setInterval(() => {
      if (location.href !== lastObservedUrl) {
        lastObservedUrl = location.href;
        // デバウンス: 高速な SPA 遷移（戻る/進む連打）で多重実行を防止
        clearTimeout(overlayDebounceTimer);
        overlayDebounceTimer = setTimeout(removeImageOverlays, SPA_NAV_PAINT_DELAY_MS);
      }
    }, SPA_NAV_INTERVAL_MS);
  }

  function stopImageOverlayObserver() {
    if (spaNavTimer) {
      clearInterval(spaNavTimer);
      spaNavTimer = null;
    }
    clearTimeout(overlayDebounceTimer);
    overlayDebounceTimer = null;
  }

  /**
   * ページ上のモーダル/ペイウォール系オーバーレイを除去する。
   * 全画面を覆う固定・絶対配置の高 z-index 要素を非表示にし、
   * body の overflow: hidden も解除する。
   */
  function removePageOverlays() {
    const allElements = document.querySelectorAll("body > *, body > * > *");
    const screenW = window.innerWidth;
    const screenH = window.innerHeight;

    for (const el of allElements) {
      const style = getComputedStyle(el);
      const isFixed = style.position === "fixed" || style.position === "absolute";
      if (!isFixed) continue; // 早期スキップで offsetWidth/Height の reflow を回避

      const zIndex = parseInt(style.zIndex, 10);
      const isHighZ = zIndex > HIGH_Z_INDEX;
      const hasSemiTransparency = parseFloat(style.opacity) < BACKDROP_OPACITY ||
        style.backgroundColor.includes("rgba");
      if (!isHighZ && !hasSemiTransparency) continue; // 早期スキップ

      const coversScreen =
        el.offsetWidth >= screenW * SCREEN_COVER_RATIO &&
        el.offsetHeight >= screenH * SCREEN_COVER_RATIO;

      if (coversScreen) {
        el.style.setProperty("display", "none", "important");
      }
    }

    // body の overflow: hidden を解除（モーダル表示時のスクロールロック解除）
    document.body.style.setProperty("overflow", "auto", "important");
    document.documentElement.style.setProperty("overflow", "auto", "important");
  }

  /**
   * background.js にメインワールドでのインラインハンドラ除去を依頼する。
   * chrome.scripting.executeScript({ world: "MAIN" }) は CSP やブラウザ制限の
   * 影響を受けないため、<script> タグ注入より確実。
   */
  function requestMainWorldRemoval(settings) {
    chrome.runtime.sendMessage({
      action: Actions.REMOVE_HANDLERS_MW,
      data: settings,
    }).catch(() => {});
  }

  /**
   * 設定を適用する。
   * 単純なイベントブロック系は EVENT_BLOCK_MAP テーブルで一括処理し、
   * 特殊な処理が必要な機能のみ個別に記述する。
   */
  function applySettings(settings) {
    currentSettings = { ...getDefaultSettings(), ...settings };

    // --- テーブル駆動: 単純なイベントブロック/インラインハンドラ除去 ---
    for (const { key, events, attrs } of EVENT_BLOCK_MAP) {
      if (currentSettings[key]) {
        events.forEach((ev) => blockSiteHandler(ev));
        removeInlineHandlers(attrs);
      } else {
        events.forEach((ev) => unblockSiteHandler(ev));
      }
    }

    // --- 印刷制限解除: CSS クラス追加 ---
    toggleCssClass("__cpa-enable-print", currentSettings[Features.PRINT]);

    // --- テキスト選択制限解除 ---
    if (currentSettings[Features.TEXT_SELECT]) {
      blockSiteHandler("selectstart");
      blockSiteHandler("dragstart");
      removeInlineHandlers(["onselectstart", "ondragstart"]);
      toggleCssClass("__cpa-enable-select", true);
    } else {
      unblockSiteHandler("selectstart");
      unblockSiteHandler("dragstart");
      toggleCssClass("__cpa-enable-select", false);
    }

    // --- カーソル制御解除 ---
    toggleCssClass("__cpa-reset-cursor", currentSettings[Features.CURSOR_RESET]);

    // --- ドラッグ&ドロップ制限解除 ---
    if (currentSettings[Features.DRAG_DROP]) {
      blockSiteHandler("dragstart");
      blockSiteHandler("drag");
      blockSiteHandler("drop");
      removeInlineHandlers(["ondragstart", "ondrag", "ondrop"]);
      toggleCssClass("__cpa-enable-drag", true);
    } else {
      // テキスト選択が dragstart をブロック中なら解除しない
      if (!currentSettings[Features.TEXT_SELECT]) {
        unblockSiteHandler("dragstart");
      }
      unblockSiteHandler("drag");
      unblockSiteHandler("drop");
      toggleCssClass("__cpa-enable-drag", false);
    }

    // --- キーボードショートカット制限解除（カスタムハンドラ使用） ---
    if (currentSettings[Features.KEYBOARD]) {
      blockSiteHandler("keydown", keyboardUnblockHandler);
      blockSiteHandler("keyup", keyboardKeyupHandler);
      removeInlineHandlers(["onkeydown", "onkeypress", "onkeyup"]);
    } else {
      unblockSiteHandler("keydown");
      unblockSiteHandler("keyup");
    }

    // --- 画像保存制限解除（透明オーバーレイ除去） ---
    if (currentSettings[Features.IMAGE_SAVE]) {
      removeImageOverlays();
      startImageOverlayObserver(); // SPA遷移後の動的DOM変更にも対応
      toggleCssClass("__cpa-image-save", true);
    } else {
      stopImageOverlayObserver();
      toggleCssClass("__cpa-image-save", false);
    }

    // --- オーバーレイ除去（モーダル・ペイウォール） ---
    if (currentSettings[Features.OVERLAY_REMOVE]) {
      removePageOverlays();
    }

    // メインワールドでのインラインハンドラ除去を background.js に依頼
    // content script（isolated world）からの除去が反映されないケースに対応
    requestMainWorldRemoval(currentSettings);
  }

  // ---------- メッセージ受信 ----------
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === Actions.APPLY_SETTINGS_CS) {
      applySettings(request.data);
      sendResponse({ ok: true });
    }
  });

  // 初回ロード時: storage から設定を読み込んで自動適用
  function initializeFromStorage() {
    chrome.storage.local.get(StorageKeys.SETTINGS).then((result) => {
      const saved = result[StorageKeys.SETTINGS];
      if (!saved) return;
      // 有効な機能が1つもなければスキップ
      const hasActiveFeature = Object.values(saved).some((v) => v === true);
      if (!hasActiveFeature) return;
      applySettings(saved);
    });
  }

  // サイトが window.onload でハンドラを設定するケースに対応するため、
  // load イベント完了後に初期化する。setTimeout(0) で onload ハンドラ実行後を保証。
  if (document.readyState === "complete") {
    initializeFromStorage();
  } else {
    window.addEventListener("load", () => setTimeout(initializeFromStorage, 0));
  }
})();
