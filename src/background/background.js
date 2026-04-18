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

// ---------- sender 検証ヘルパー ----------
// popup / option ページ由来: sender.tab が undefined、sender.id が自拡張の id
// content script 由来:        sender.tab.id が存在
// 外部 Web ページからの送信は manifest に externally_connectable が無い限り到達しないが、
// content script が XSS 等で乗っ取られた場合の間接操作を閉じるためハンドラごとに明示検証する。
function isFromPopup(sender) {
  return sender?.id === chrome.runtime.id && !sender?.tab;
}
function isFromContentScript(sender) {
  return sender?.id === chrome.runtime.id && typeof sender?.tab?.id === "number";
}

// ---------- メッセージハンドラ ----------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === Actions.APPLY_SETTINGS) {
    // 設定変更は popup のみ許可（content script から送らせない）
    if (!isFromPopup(sender)) return;
    handleApplySettings(request.data)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  } else if (request.action === Actions.REMOVE_HANDLERS_MW) {
    if (!isFromContentScript(sender)) return;
    removeInlineHandlersInMainWorld(sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  } else if (request.action === Actions.READ_CLIPBOARD) {
    // クリップボード読取は content script 由来のみ。
    // これが無いと同一拡張の任意コンテキストがユーザー意図なしで呼べる経路が残る。
    if (!isFromContentScript(sender)) return;
    // content script が http:// 等の非 secure context で動作する場合、
    // 直接 navigator.clipboard.readText を呼ぶと reject されるため
    // offscreen document (chrome-extension:// = secure) 経由で読み取る
    readClipboardViaOffscreen()
      .then((text) => sendResponse({ ok: true, text }))
      .catch(() => sendResponse({ ok: false, text: "" }));
    return true;
  } else if (request.action === Actions.WRITE_CLIPBOARD) {
    if (!isFromContentScript(sender)) return;
    // forceCopy も同様にサイトの copy ブロッカーや secure context 制限の影響を
    // 受けないよう、offscreen document (extension context) 経由で書き込む
    writeClipboardViaOffscreen(request.data?.text ?? "")
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
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

// ---------- Offscreen Document 管理 ----------
// 並行 createDocument 防止: "Only one offscreen document may be created" エラーを避ける
let offscreenCreatingPromise = null;
// アイドル時に offscreen を close するタイマー。クリップボード操作は頻度が低いため
// 使用後は閉じてメモリ常駐を避ける。
let offscreenIdleTimer = null;
const OFFSCREEN_IDLE_MS = 30_000;

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
  } catch (err) {
    // getContexts 自体が失敗するのは Chrome バージョンや API 変更が原因。
    // 診断導線確保のため最低限 warn する。以降は createDocument にフォールバック。
    console.warn("[WebRestrictionRemover] getContexts failed:", err);
  }

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
    .catch((err) => {
      // 既に存在するケース（並行作成レース）はこのまま true を返せば良いが、
      // それ以外の失敗は診断導線確保のため warn する。
      if (!String(err?.message ?? "").includes("Only one offscreen document")) {
        console.warn("[WebRestrictionRemover] createDocument failed:", err);
      }
    });
  await offscreenCreatingPromise;
  offscreenCreatingPromise = null;
  return true;
}

/**
 * 次のクリップボード使用までアイドル状態が続いたら offscreen document を閉じる。
 * 使い終わるたびに呼び、前回予約があれば延長する。
 */
function scheduleOffscreenClose() {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(async () => {
    offscreenIdleTimer = null;
    if (!chrome.offscreen) return;
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // 既に閉じている場合は無視
    }
  }, OFFSCREEN_IDLE_MS);
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
  } finally {
    scheduleOffscreenClose();
  }
}

/**
 * Offscreen Document 経由でクリップボードにテキストを書き込む。
 * content script 直接だと http:// で secure context 制限により reject され、
 * さらに execCommand("copy") フォールバックもページ側の copy ブロッカーの
 * 影響を受けうるため、extension context で書き込む。
 */
async function writeClipboardViaOffscreen(text) {
  if (!text) return false;
  await ensureOffscreenDocument();
  try {
    const response = await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_WRITE,
      text,
    });
    return !!response?.ok;
  } catch {
    return false;
  } finally {
    scheduleOffscreenClose();
  }
}

/**
 * メインワールド（ページ側の JS 実行コンテキスト）で window/document/html/body の
 * インラインハンドラプロパティを null 化する。
 *
 * content script の removeInlineHandlers() は isolated world で動作するが、
 * DOM 要素の「属性」と「プロパティ」は isolated world と MAIN world で共有される。
 * そのため属性セレクタヒットの除去は content script 側に任せ、ここでは
 * window/document 等の「グローバルオブジェクトのプロパティ」除去のみ行う（二重走査削減）。
 * document/html/body ノードのプロパティはどちらの world でも書けば OK だが、content script 側で
 * 書いた結果がページ側の getter/setter 経由だと隠されうるため MAIN 側でも明示的に null 化する。
 */
async function removeInlineHandlersInMainWorld(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: (attrs) => {
      [document, document.documentElement, document.body, window].forEach((root) => {
        if (!root) return;
        attrs.forEach((attr) => { root[attr] = null; });
      });
    },
    args: [SilentUnlock.INLINE_ATTRS],
  }).catch(() => {});
}
