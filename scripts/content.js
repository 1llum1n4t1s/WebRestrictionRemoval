(function () {
  "use strict";

  // 二重実行防止フラグ
  if (window.__copyPasteAssistRunning) return;
  window.__copyPasteAssistRunning = true;

  /**
   * イベントブロック/解除のデータ駆動テーブル。
   * 「キャプチャフェーズでイベントを横取り + インラインハンドラ除去」パターンを
   * テーブルで一括定義し、applySettings の重複コードを排除する。
   * cssClass を指定すると <html> に付与/除去して制限解除スタイルを切り替える。
   */
  const EVENT_BLOCK_MAP = [
    { key: Features.RIGHT_CLICK, events: ["contextmenu"], attrs: ["oncontextmenu"] },
    { key: Features.PASTE, events: ["paste", "beforepaste"], attrs: ["onpaste", "onbeforepaste"] },
    { key: Features.COPY, events: ["copy", "beforecopy"], attrs: ["oncopy", "onbeforecopy"] },
    { key: Features.TEXT_SELECT, events: ["selectstart", "dragstart"], attrs: ["onselectstart", "ondragstart"], cssClass: "__cpa-enable-select" },
  ];

  /** 現在の設定状態 */
  let currentSettings = getDefaultSettings();

  /**
   * キャプチャフェーズでイベントを横取りし、サイトの制限を無効化する。
   * stopImmediatePropagation() でサイト側のリスナーが発火しないようにする。
   */
  const handlers = {};

  function blockSiteHandler(eventName) {
    if (handlers[eventName]) return; // 既に登録済み
    const handler = (e) => { e.stopImmediatePropagation(); };
    handlers[eventName] = handler;
    document.addEventListener(eventName, handler, true); // キャプチャフェーズ
  }

  function unblockSiteHandler(eventName) {
    if (!handlers[eventName]) return;
    document.removeEventListener(eventName, handlers[eventName], true);
    delete handlers[eventName];
  }

  /**
   * インライン属性ハンドラを除去する。
   * 属性セレクタで対象要素のみ取得し、全DOM走査を回避する。
   * さらに、JSで動的に設定されたハンドラにも対応するため、
   * 主要ノードのDOMプロパティを直接 null 化する。
   * メインワールドでの除去は requestMainWorldRemoval 経由で background.js が実行。
   */
  function removeInlineHandlers(attrNames) {
    const selector = attrNames.map((attr) => `[${attr}]`).join(",");
    const targets = document.querySelectorAll(selector);
    for (const el of targets) {
      for (const attr of attrNames) {
        el.removeAttribute(attr);
        el[attr] = null;
      }
    }
    const roots = [document, document.documentElement, document.body];
    for (const root of roots) {
      if (!root) continue;
      for (const attr of attrNames) {
        root[attr] = null;
      }
    }
  }

  /**
   * background.js にメインワールドでのインラインハンドラ除去を依頼する。
   */
  function requestMainWorldRemoval(settings) {
    chrome.runtime.sendMessage({
      action: Actions.REMOVE_HANDLERS_MW,
      data: settings,
    }).catch(() => {});
  }

  /**
   * 設定を適用する。
   * EVENT_BLOCK_MAP テーブルで全機能を一括処理する。
   */
  function applySettings(settings) {
    currentSettings = { ...getDefaultSettings(), ...settings };

    for (const { key, events, attrs, cssClass } of EVENT_BLOCK_MAP) {
      if (currentSettings[key]) {
        events.forEach((ev) => blockSiteHandler(ev));
        removeInlineHandlers(attrs);
      } else {
        events.forEach((ev) => unblockSiteHandler(ev));
      }
      if (cssClass) {
        document.documentElement.classList.toggle(cssClass, !!currentSettings[key]);
      }
    }

    // メインワールドでのインラインハンドラ除去を background.js に依頼
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
