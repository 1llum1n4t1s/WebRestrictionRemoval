(function () {
  "use strict";

  // 二重実行防止
  if (window.__copyPasteAssistRunning) return;
  window.__copyPasteAssistRunning = true;

  /** キャプチャフェーズでブロックしたイベントハンドラ登録簿 */
  const blockHandlers = {};

  /**
   * 直近の右クリック対象のうち編集可能だった要素をキャッシュする。
   * chrome.contextMenus クリック時に document.activeElement が <body> に
   * リセットされるケース（Chrome のフォーカス仕様）があり、forcePaste で
   * フォールバック参照するための保険。
   */
  let lastContextEditable = null;

  function isEditableElement(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
  }

  /**
   * 右クリック時の編集可能要素キャッシュ。capture + passive で登録することで
   * サイト側リスナーの発火有無や preventDefault に影響されずに先行実行される。
   * ブロックハンドラ登録時に stopImmediatePropagation されるが、それは同じフェーズ
   * の後続リスナーに対するもので、先に addEventListener したこのハンドラは実行される。
   */
  document.addEventListener(
    "contextmenu",
    (e) => {
      lastContextEditable = isEditableElement(e.target) ? e.target : null;
    },
    { capture: true, passive: true }
  );

  /**
   * キャプチャフェーズでイベントを横取りしてサイト側のリスナー発火を封じる。
   * document 1箇所のみに登録するため処理負荷は極小。
   */
  function blockEvent(eventName) {
    if (blockHandlers[eventName]) return;
    const handler = (e) => { e.stopImmediatePropagation(); };
    blockHandlers[eventName] = handler;
    document.addEventListener(eventName, handler, true);
  }

  function unblockEvent(eventName) {
    if (!blockHandlers[eventName]) return;
    document.removeEventListener(eventName, blockHandlers[eventName], true);
    delete blockHandlers[eventName];
  }

  /**
   * インラインハンドラを isolated world 側で除去する。
   * DOM 要素のプロパティ/属性は isolated world と MAIN world で共有されるため、
   * ここで querySelectorAll でヒットした要素の属性・プロパティ除去はページ側にも反映される。
   * ただし document/html/body の各ノード「プロパティ」は隔離されているため、
   * ページ側のグローバル設定分は background.js の removeInlineHandlersInMainWorld で別途除去する。
   * 属性セレクタヒットと主要3ノードのみ対象にして全DOM走査を回避する。
   */
  function removeInlineHandlers() {
    const attrs = SilentUnlock.INLINE_ATTRS;
    const selector = attrs.map((a) => `[${a}]`).join(",");
    document.querySelectorAll(selector).forEach((el) => {
      attrs.forEach((a) => {
        el.removeAttribute(a);
        el[a] = null;
      });
    });
    [document, document.documentElement, document.body].forEach((root) => {
      if (!root) return;
      attrs.forEach((a) => { root[a] = null; });
    });
  }

  /**
   * サイレント自動解除を有効化/無効化する。
   * 対象: 右クリック制限 + テキスト選択制限（processing cost を抑えるため自動発動）
   */
  function applyEnabled(isEnabled) {
    if (isEnabled) {
      SilentUnlock.EVENTS.forEach(blockEvent);
      removeInlineHandlers();
      document.documentElement.classList.add(SilentUnlock.CSS_CLASS_SELECT);
      // メインワールドでの除去を background に依頼（CSP 等の影響を回避）
      chrome.runtime.sendMessage({ action: Actions.REMOVE_HANDLERS_MW }).catch(() => {});
    } else {
      SilentUnlock.EVENTS.forEach(unblockEvent);
      document.documentElement.classList.remove(SilentUnlock.CSS_CLASS_SELECT);
    }
  }

  // ---------- 強制ペースト ----------
  /**
   * クリップボードを読み取り、編集可能な要素に書き込む。
   * 対象要素の解決優先度:
   *   1. document.activeElement（編集可能な場合のみ）
   *   2. lastContextEditable（直前の右クリック対象キャッシュ）
   *      → Chrome が contextmenu 後に activeElement を body にリセットするケースへの対応。
   * input/textarea: native setter を使って React 等のフレームワークにも反映。
   * contenteditable: Range API でキャレット位置に挿入。
   * execCommand を最初に試し、失敗時のみフォールバック。
   */
  async function forcePaste() {
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;

    const active = document.activeElement;
    const el = isEditableElement(active) ? active : lastContextEditable;
    if (!isEditableElement(el)) return;

    // キャッシュフォールバック時はフォーカスを戻してから execCommand を実行
    // （execCommand("insertText") はフォーカス要素に対して作用するため）
    if (el !== active && typeof el.focus === "function") {
      try { el.focus(); } catch {}
    }

    // execCommand('insertText') は input/textarea/contenteditable 全てで動作し
    // 多くのフレームワークでも適切にイベントが発火される
    try {
      if (document.execCommand("insertText", false, text)) return;
    } catch {}

    // フォールバック: 要素種別で振り分け
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      insertIntoInput(el, text);
    } else if (el.isContentEditable) {
      insertIntoContentEditable(el, text);
    }
  }

  function insertIntoInput(el, text) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    // React 等のコントロールドコンポーネント対応のため native setter で代入
    const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, next);
    } else {
      el.value = next;
    }
    const caret = start + text.length;
    try { el.setSelectionRange(caret, caret); } catch {}
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function insertIntoContentEditable(el, text) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      // セレクションが無い / 対象外の場合は末尾に textNode として追記する。
      // `el.textContent += text` は editable 配下のマークアップを全破壊するため使わない。
      const node = document.createTextNode(text);
      el.appendChild(node);
      // キャレットを挿入直後に移動（可能なら）
      try {
        const range = document.createRange();
        range.setStartAfter(node);
        range.collapse(true);
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {}
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }

  // ---------- 強制コピー ----------
  /**
   * 選択範囲のテキストをクリップボードに書き込む。
   * 優先度: background から渡された info.selectionText → window.getSelection()
   */
  async function forceCopy(selectionText) {
    let text = selectionText;
    if (!text) {
      text = window.getSelection()?.toString() ?? "";
    }
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // フォールバック: 一時テキストエリア経由の execCommand('copy')
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {}
    }
  }

  // ---------- メッセージ受信 ----------
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === Actions.APPLY_SETTINGS_CS) {
      applyEnabled(request.data?.enabled === true);
      sendResponse({ ok: true });
    } else if (request.action === Actions.FORCE_PASTE) {
      forcePaste();
      sendResponse({ ok: true });
    } else if (request.action === Actions.FORCE_COPY) {
      forceCopy(request.data?.selectionText);
      sendResponse({ ok: true });
    }
  });

  // ---------- 初回ロード ----------
  function initialize() {
    chrome.storage.local.get(StorageKeys.ENABLED).then((result) => {
      // 未設定時はデフォルト ON 扱い（初回インストールで background 初期化前の content script 読込に対応）
      applyEnabled(result[StorageKeys.ENABLED] !== false);
    });
  }

  // サイトが window.onload でハンドラを設定するケースに対応するため
  // load 完了後に初期化する
  if (document.readyState === "complete") {
    initialize();
  } else {
    window.addEventListener("load", () => setTimeout(initialize, 0));
  }
})();
