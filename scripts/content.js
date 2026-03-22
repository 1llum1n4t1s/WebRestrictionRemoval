(function () {
  "use strict";

  // 二重実行防止フラグ
  if (window.__copyPasteAssistRunning) return;
  window.__copyPasteAssistRunning = true;

  /** 現在の設定状態 */
  let currentSettings = getDefaultSettings();

  /**
   * キャプチャフェーズでイベントを横取りし、サイトの制限を無効化する。
   * stopImmediatePropagation() でサイト側のリスナーが発火しないようにする。
   */
  const handlers = {};

  function blockSiteHandler(eventName) {
    if (handlers[eventName]) return; // 既に登録済み

    const handler = (e) => {
      e.stopImmediatePropagation();
    };
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
   */
  function removeInlineHandlers(attrNames) {
    // 属性セレクタで対象要素のみ取得（querySelectorAll("*") の全走査を回避）
    const selector = attrNames.map((attr) => `[${attr}]`).join(",");
    const targets = document.querySelectorAll(selector);
    for (const el of targets) {
      for (const attr of attrNames) {
        el.removeAttribute(attr);
        el[attr] = null;
      }
    }
    // document 自体のインラインハンドラも除去
    for (const attr of attrNames) {
      document[attr] = null;
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
      return;
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
   */
  function removeImageOverlays() {
    const candidates = document.querySelectorAll(
      'div, span, a, figure, picture'
    );
    for (const el of candidates) {
      const style = getComputedStyle(el);
      // 透明または半透明で、画像の上に絶対配置されているオーバーレイを検出
      const isTransparent = parseFloat(style.opacity) < 0.1 ||
        style.backgroundColor === "transparent" ||
        style.backgroundColor === "rgba(0, 0, 0, 0)";
      const isPositioned = style.position === "absolute" || style.position === "fixed";
      const hasNoContent = el.children.length === 0 && el.textContent.trim() === "";

      if (isTransparent && isPositioned && hasNoContent) {
        el.style.setProperty("pointer-events", "none", "important");
      }
    }
  }

  /**
   * ページ上のモーダル/ペイウォール系オーバーレイを除去する。
   * 全画面を覆う固定・絶対配置の高 z-index 要素を非表示にし、
   * body の overflow: hidden も解除する。
   */
  function removePageOverlays() {
    const allElements = document.querySelectorAll("body > *, body > * > *");
    for (const el of allElements) {
      const style = getComputedStyle(el);
      const zIndex = parseInt(style.zIndex, 10);
      const isFixed = style.position === "fixed" || style.position === "absolute";
      const coversScreen =
        el.offsetWidth >= window.innerWidth * 0.8 &&
        el.offsetHeight >= window.innerHeight * 0.8;
      const isHighZ = zIndex > 999;
      const hasBackdrop = parseFloat(style.opacity) < 1 ||
        style.backgroundColor.includes("rgba");

      // 全画面を覆う高 z-index の固定要素 = オーバーレイの可能性が高い
      if (isFixed && coversScreen && (isHighZ || hasBackdrop)) {
        el.style.setProperty("display", "none", "important");
      }
    }

    // body の overflow: hidden を解除（モーダル表示時のスクロールロック解除）
    document.body.style.setProperty("overflow", "auto", "important");
    document.documentElement.style.setProperty("overflow", "auto", "important");
  }

  /**
   * 設定を適用する
   */
  function applySettings(settings) {
    currentSettings = { ...getDefaultSettings(), ...settings };

    // 1. 右クリック制限解除
    if (currentSettings[Features.RIGHT_CLICK]) {
      blockSiteHandler("contextmenu");
      removeInlineHandlers(["oncontextmenu"]);
    } else {
      unblockSiteHandler("contextmenu");
    }

    // 2. ペースト制限解除
    if (currentSettings[Features.PASTE]) {
      blockSiteHandler("paste");
      blockSiteHandler("beforepaste");
      removeInlineHandlers(["onpaste", "onbeforepaste"]);
    } else {
      unblockSiteHandler("paste");
      unblockSiteHandler("beforepaste");
    }

    // 3. コピー制限解除
    if (currentSettings[Features.COPY]) {
      blockSiteHandler("copy");
      blockSiteHandler("beforecopy");
      removeInlineHandlers(["oncopy", "onbeforecopy"]);
    } else {
      unblockSiteHandler("copy");
      unblockSiteHandler("beforecopy");
    }

    // 4. テキスト選択制限解除
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

    // 5. カーソル制御解除
    toggleCssClass("__cpa-reset-cursor", currentSettings[Features.CURSOR_RESET]);

    // 6. 印刷制限解除
    if (currentSettings[Features.PRINT]) {
      blockSiteHandler("beforeprint");
      blockSiteHandler("afterprint");
      removeInlineHandlers(["onbeforeprint", "onafterprint"]);
      toggleCssClass("__cpa-enable-print", true);
      // window.print を復元（上書きされている場合）
      if (window.print !== Window.prototype.print) {
        window.print = Window.prototype.print;
      }
    } else {
      unblockSiteHandler("beforeprint");
      unblockSiteHandler("afterprint");
      toggleCssClass("__cpa-enable-print", false);
    }

    // 7. ドラッグ&ドロップ制限解除
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

    // 8. キーボードショートカット制限解除
    if (currentSettings[Features.KEYBOARD]) {
      if (!handlers["__keyboard_keydown"]) {
        handlers["__keyboard_keydown"] = keyboardUnblockHandler;
        document.addEventListener("keydown", keyboardUnblockHandler, true);
      }
      if (!handlers["__keyboard_keyup"]) {
        handlers["__keyboard_keyup"] = keyboardKeyupHandler;
        document.addEventListener("keyup", keyboardKeyupHandler, true);
      }
      removeInlineHandlers(["onkeydown", "onkeypress", "onkeyup"]);
    } else {
      if (handlers["__keyboard_keydown"]) {
        document.removeEventListener("keydown", handlers["__keyboard_keydown"], true);
        delete handlers["__keyboard_keydown"];
      }
      if (handlers["__keyboard_keyup"]) {
        document.removeEventListener("keyup", handlers["__keyboard_keyup"], true);
        delete handlers["__keyboard_keyup"];
      }
    }

    // 9. 画像保存制限解除（透明オーバーレイ除去）
    if (currentSettings[Features.IMAGE_SAVE]) {
      removeImageOverlays();
      toggleCssClass("__cpa-image-save", true);
    } else {
      toggleCssClass("__cpa-image-save", false);
    }

    // 10. オーバーレイ除去（モーダル・ペイウォール）
    if (currentSettings[Features.OVERLAY_REMOVE]) {
      removePageOverlays();
    }
  }

  // ---------- メッセージ受信 ----------
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === Actions.APPLY_SETTINGS_CS) {
      applySettings(request.data);
    }
  });

  // 初回ロード時: storage から設定を読み込んで自動適用
  chrome.storage.local.get(StorageKeys.SETTINGS).then((result) => {
    const saved = result[StorageKeys.SETTINGS];
    if (saved) {
      applySettings(saved);
    }
  });
})();
