importScripts("/scripts/actions.js");

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
  if (settings[Features.PRINT]) { attrSet.add("onbeforeprint"); attrSet.add("onafterprint"); }
  if (settings[Features.DRAG_DROP]) { attrSet.add("ondragstart"); attrSet.add("ondrag"); attrSet.add("ondrop"); }
  if (settings[Features.KEYBOARD]) { attrSet.add("onkeydown"); attrSet.add("onkeypress"); attrSet.add("onkeyup"); }

  const attrNames = [...attrSet];
  if (attrNames.length === 0 && !settings[Features.PRINT]) return;

  // ハンドラ除去 + 印刷復元を1回の executeScript にまとめる
  const shouldRestorePrint = !!settings[Features.PRINT];
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (attrs, restorePrint) => {
      // インラインハンドラの除去
      if (attrs.length > 0) {
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
      }
      // 印刷制限解除時は window.print も復元
      if (restorePrint && window.print !== Window.prototype.print) {
        window.print = Window.prototype.print;
      }
    },
    args: [attrNames, shouldRestorePrint],
  }).catch(() => {});
}
