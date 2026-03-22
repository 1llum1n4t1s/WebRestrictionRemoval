importScripts("/scripts/actions.js");

// ---------- Message Handler ----------
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === Actions.APPLY_SETTINGS) {
    handleApplySettings(request.data)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // 非同期 sendResponse のため
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function handleApplySettings(settings) {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  // chrome://, edge://, about: などの特殊ページにはスクリプトを注入できない
  const url = tab.url ?? "";
  if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("file://")) {
    return;
  }

  const tabId = tab.id;

  // 既にスクリプト注入済みか確認
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__copyPasteAssistRunning === true,
  });

  // 未注入なら content script + CSS を並列注入
  if (!result?.result) {
    // 設定を先に storage へ書き込む（content script が初期化時に読み取る）
    await chrome.storage.local.set({ [StorageKeys.SETTINGS]: settings });

    await Promise.all([
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["scripts/actions.js", "scripts/content.js"],
      }),
      chrome.scripting.insertCSS({
        target: { tabId },
        files: ["css/content.css"],
      }),
    ]);
    // 新規注入の場合、content script は初期化時に storage から設定を読むため
    // sendMessage は不要（リスナー未登録の競合を回避）
    return;
  }

  // 既に注入済みの場合は直接メッセージ送信
  await chrome.tabs.sendMessage(tabId, {
    action: Actions.APPLY_SETTINGS_CS,
    data: settings,
  }).catch(() => {});
}
