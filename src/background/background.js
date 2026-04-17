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
  }
});

// ---------- 右クリックメニュー クリック ----------
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === ContextMenuIds.FORCE_PASTE) {
    chrome.tabs.sendMessage(tab.id, { action: Actions.FORCE_PASTE }).catch(() => {});
  } else if (info.menuItemId === ContextMenuIds.FORCE_COPY) {
    chrome.tabs.sendMessage(tab.id, {
      action: Actions.FORCE_COPY,
      data: { selectionText: info.selectionText ?? "" },
    }).catch(() => {});
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
async function removeInlineHandlersInMainWorld(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
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
