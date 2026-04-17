importScripts("/src/lib/actions.js");

// ---------- 初期化 ----------
// onInstalled: 初回インストール/アップデート時
//   - 旧バージョンの設定キー（copyPasteSettings）をクリーンアップ
//   - ENABLED が未設定ならデフォルト ON
//   - 右クリックメニューを現在の ENABLED 状態に合わせて作成
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove("copyPasteSettings").catch(() => {});
  const stored = await chrome.storage.local.get(StorageKeys.ENABLED);
  if (!(StorageKeys.ENABLED in stored)) {
    await chrome.storage.local.set({ [StorageKeys.ENABLED]: true });
  }
  await updateContextMenus();
});

// onStartup: ブラウザ起動時。右クリックメニューは persist されないケースがあるため再構築
chrome.runtime.onStartup.addListener(() => {
  updateContextMenus();
});

// ---------- メッセージハンドラ ----------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === Actions.APPLY_SETTINGS) {
    handleApplySettings(request.data)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  } else if (request.action === Actions.REMOVE_HANDLERS_MW && sender.tab?.id) {
    removeInlineHandlersInMainWorld(sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  } else if (request.action === Actions.READ_CLIPBOARD) {
    // content script が http:// 等の非 secure context で動作する場合、
    // 直接 navigator.clipboard.readText を呼ぶと reject されるため
    // offscreen document (chrome-extension:// = secure) 経由で読み取る
    readClipboardViaOffscreen()
      .then((text) => sendResponse({ ok: true, text }))
      .catch(() => sendResponse({ ok: false, text: "" }));
    return true;
  }
});

// ---------- 右クリックメニュー クリック ----------
// frameId を指定してクリックされたフレームの content script のみにメッセージを届ける。
// 指定しないと chrome.tabs.sendMessage はトップフレームにしか届かず、
// iframe 内の編集可能要素が活性状態のケースで forcePaste が no-op になる。
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const sendOptions = typeof info.frameId === "number" ? { frameId: info.frameId } : undefined;
  if (info.menuItemId === ContextMenuIds.FORCE_PASTE) {
    chrome.tabs.sendMessage(tab.id, { action: Actions.FORCE_PASTE }, sendOptions).catch(() => {});
  } else if (info.menuItemId === ContextMenuIds.FORCE_COPY) {
    chrome.tabs.sendMessage(
      tab.id,
      {
        action: Actions.FORCE_COPY,
        data: { selectionText: info.selectionText ?? "" },
      },
      sendOptions
    ).catch(() => {});
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/**
 * Popup から有効/無効切替を受けた際の処理。
 * storage 保存 → 右クリックメニュー更新 → content script へ通知 → メインワールド除去。
 */
async function handleApplySettings(settings) {
  const enabled = !!settings?.enabled;
  await chrome.storage.local.set({ [StorageKeys.ENABLED]: enabled });
  await updateContextMenus();

  const tab = await getActiveTab();
  if (!tab?.id) return;

  // content_scripts の matches (http://*/* と https://*/*) と足並みを揃える。
  // chrome://, edge://, about:, file:// などではそもそも content script が注入されないため
  // メッセージ送信と MW 実行をスキップする。
  const url = tab.url ?? "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return;
  }

  await chrome.tabs.sendMessage(tab.id, {
    action: Actions.APPLY_SETTINGS_CS,
    data: { enabled },
  }).catch(() => {});

  if (enabled) {
    await removeInlineHandlersInMainWorld(tab.id);
  }
}

/**
 * 右クリックメニューを現在の ENABLED 状態に合わせて再構築。
 * ENABLED=false のときはメニューを出さないため removeAll のみ。
 */
async function updateContextMenus() {
  await chrome.contextMenus.removeAll();
  const stored = await chrome.storage.local.get(StorageKeys.ENABLED);
  if (stored[StorageKeys.ENABLED] !== true) return;

  chrome.contextMenus.create({
    id: ContextMenuIds.FORCE_PASTE,
    title: "📋 強制ペースト",
    contexts: ["editable"],
  });
  chrome.contextMenus.create({
    id: ContextMenuIds.FORCE_COPY,
    title: "✂️ 強制コピー",
    contexts: ["selection"],
  });
}

/**
 * メインワールド（ページ側の JS 実行コンテキスト）で window/document/html/body の
 * インラインハンドラプロパティを null 化する。
 *
 * content script の removeInlineHandlers() は isolated world で動作するため、
 * DOM 属性（HTML 側）と DOM 要素プロパティは共有されるものの、
 * window/document 等の「グローバルオブジェクトのプロパティ」は別世界で独立している。
 * ここで MAIN world を経由することでページ側の `window.oncontextmenu = ...` 等の
 * 動的ハンドラも確実に解除できる（CSP の影響も受けない）。
 */
// ---------- Offscreen Document 管理 ----------
// 並行 createDocument 防止: "Only one offscreen document may be created" エラーを避ける
let offscreenCreatingPromise = null;

/**
 * Offscreen Document が未作成なら作成する。
 * chrome.runtime.getContexts (Chrome 116+) で存在確認を試み、失敗時は
 * createDocument を直接呼ぶ（二重作成エラーは catch で握り潰す）。
 */
async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return false;
  const url = chrome.runtime.getURL(Offscreen.PATH);

  try {
    if (typeof chrome.runtime.getContexts === "function") {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [url],
      });
      if (contexts.length > 0) return true;
    }
  } catch {}

  if (offscreenCreatingPromise) {
    await offscreenCreatingPromise;
    return true;
  }
  offscreenCreatingPromise = chrome.offscreen
    .createDocument({
      url: Offscreen.PATH,
      reasons: ["CLIPBOARD"],
      justification: "強制ペースト機能のためにクリップボードを読み取り",
    })
    .catch(() => {}); // 既に存在するケース等は握り潰す
  await offscreenCreatingPromise;
  offscreenCreatingPromise = null;
  return true;
}

/**
 * Offscreen Document 経由でクリップボードのテキストを読み取る。
 * 失敗時は空文字を返す。
 */
async function readClipboardViaOffscreen() {
  await ensureOffscreenDocument();
  try {
    const response = await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_READ,
    });
    return response?.text ?? "";
  } catch {
    return "";
  }
}

async function removeInlineHandlersInMainWorld(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: (attrs) => {
      [document, document.documentElement, document.body, window].forEach((root) => {
        if (!root) return;
        attrs.forEach((attr) => { root[attr] = null; });
      });
      attrs.forEach((attr) => {
        document.querySelectorAll("[" + attr + "]").forEach((el) => {
          el.removeAttribute(attr);
          el[attr] = null;
        });
      });
    },
    args: [SilentUnlock.INLINE_ATTRS],
  }).catch(() => {});
}
