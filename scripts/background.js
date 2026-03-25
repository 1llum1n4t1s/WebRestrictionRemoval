importScripts("/scripts/actions.js");

// ---------- 設定マイグレーション ----------
// v1.0.6 以前の削除済み機能キーを storage からクリーンアップ
const REMOVED_FEATURE_KEYS = ["cursorReset", "print", "dragDrop", "keyboard", "imageSave", "overlayRemove"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(StorageKeys.SETTINGS).then((result) => {
    const saved = result[StorageKeys.SETTINGS];
    if (!saved) return;
    let changed = false;
    for (const key of REMOVED_FEATURE_KEYS) {
      if (key in saved) {
        delete saved[key];
        changed = true;
      }
    }
    if (changed) {
      chrome.storage.local.set({ [StorageKeys.SETTINGS]: saved });
    }
  });
});

// ---------- Message Handler ----------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === Actions.APPLY_SETTINGS) {
    handleApplySettings(request.data)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // 非同期 sendResponse のため
  } else if (request.action === Actions.REMOVE_HANDLERS_MW && sender.tab?.id) {
    // content script からのメインワールド除去リクエスト
    // ページリロード時に content_scripts で自動注入された content.js が送信する
    removeInlineHandlersInMainWorld(sender.tab.id, request.data)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

async function getActiveTab() {
  // lastFocusedWindow: Service Worker コンテキストでも安定して動作する
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/**
 * Popup から設定適用リクエストを受けた際の処理。
 * content_scripts（manifest.json）で自動注入済みのため、動的注入は不要。
 * メッセージ送信 + メインワールドでのハンドラ除去のみ行う。
 */
async function handleApplySettings(settings) {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  // chrome://, edge://, about: などの特殊ページにはスクリプトを注入できない
  const url = tab.url ?? "";
  if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("file://")) {
    return;
  }

  // 設定を storage へ書き込み + content script にメッセージ送信
  await chrome.storage.local.set({ [StorageKeys.SETTINGS]: settings });
  await chrome.tabs.sendMessage(tab.id, {
    action: Actions.APPLY_SETTINGS_CS,
    data: settings,
  }).catch(() => {});

  // メインワールドでインラインハンドラを除去
  // content script の requestMainWorldRemoval でも同じ処理を依頼するが、
  // Popup 経由の場合はメッセージ送信→content script 受信→MW依頼の往復を待たず
  // 直接実行する方が応答性が良い（処理自体は冪等なので二重実行しても安全）
  await removeInlineHandlersInMainWorld(tab.id, settings);
}

/**
 * メインワールドでインラインイベントハンドラを除去する。
 * content script（isolated world）からの除去が反映されないケースに対応。
 * chrome.scripting.executeScript の world: "MAIN" はブラウザ API のため、
 * CSP やブラウザ独自のセキュリティ制限（Brave 等）の影響を受けない。
 */
async function removeInlineHandlersInMainWorld(tabId, settings) {
  // 設定に基づいて除去対象のインラインハンドラを決定（Set で重複排除）
  const attrSet = new Set();
  if (settings[Features.RIGHT_CLICK]) attrSet.add("oncontextmenu");
  if (settings[Features.PASTE]) { attrSet.add("onpaste"); attrSet.add("onbeforepaste"); }
  if (settings[Features.COPY]) { attrSet.add("oncopy"); attrSet.add("onbeforecopy"); }
  if (settings[Features.TEXT_SELECT]) { attrSet.add("onselectstart"); attrSet.add("ondragstart"); }

  const attrNames = [...attrSet];
  if (attrNames.length === 0) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (attrs) => {
      // インラインハンドラの除去
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
    args: [attrNames],
  }).catch(() => {});
}
