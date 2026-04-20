importScripts("/src/lib/actions.js");

// ---------- 初期化 ----------
// onInstalled: 初回インストール/アップデート時
//   - 旧バージョンの設定キー（copyPasteSettings）をクリーンアップ
//   - ENABLED が未設定ならデフォルト ON
//   - 右クリックメニューを現在の ENABLED 状態に合わせて作成
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove("copyPasteSettings").catch(() => {});
  const stored = await chrome.storage.local.get([
    StorageKeys.ENABLED,
    StorageKeys.KEEP_ALIVE_ENABLED,
    StorageKeys.KEEP_ALIVE_INTERVAL_MS,
    StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS,
  ]);
  const defaults = {};
  if (!(StorageKeys.ENABLED in stored)) defaults[StorageKeys.ENABLED] = true;
  // セッション維持はオプトイン（Default OFF）。HTTP ping を勝手に始めないため。
  if (!(StorageKeys.KEEP_ALIVE_ENABLED in stored)) defaults[StorageKeys.KEEP_ALIVE_ENABLED] = false;
  if (!(StorageKeys.KEEP_ALIVE_INTERVAL_MS in stored)) {
    defaults[StorageKeys.KEEP_ALIVE_INTERVAL_MS] = KeepAlive.DEFAULT_INTERVAL_MS;
  }
  // カスタム右クリック許可リストは初期空（組み込みパターンのみが効く）
  if (!(StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS in stored)) {
    defaults[StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS] = [];
  }
  if (Object.keys(defaults).length > 0) {
    await chrome.storage.local.set(defaults);
  }
  await updateContextMenus();
});

// onStartup: ブラウザ起動時。右クリックメニューは persist されないケースがあるため再構築
chrome.runtime.onStartup.addListener(() => {
  updateContextMenus();
});

// SW 初期化トップレベルでの再構築:
//   MV3 SW はアイドル（約 30 秒）で停止し、次のイベントで再起動する。このタイミングで
//   contextMenus が失われるケースがあるが、onInstalled / onStartup はブラウザ起動時のみ
//   発火するため idle 再起動に対応できない。SW 初期化ごとにトップレベルで再構築することで
//   全起動シナリオ（初回インストール / ブラウザ起動 / idle 再起動）をカバーする。
//   updateContextMenus は removeAll → create で冪等なので重複呼び出しでも副作用なし。
updateContextMenus().catch(() => {});

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
 *
 * `settings` は popup からの単一メッセージで制限解除トグルとセッション維持設定の両方を運ぶ:
 *   - `enabled`: 制限解除トグル
 *   - `keepAliveEnabled`: セッション維持トグル
 *   - `keepAliveIntervalMs`: ポーリング間隔（範囲外の値は content script 側でクランプ）
 *
 * MW インラインハンドラ除去は `enabled=true` のときのみ行うが、セッション維持のみ変更する
 * ケースでも active tab の content script には APPLY_SETTINGS_CS を届けて即時反映する
 * （storage.onChanged でも非アクティブタブ含め全タブ・全フレームに追従する）。
 */
async function handleApplySettings(settings) {
  const enabled = !!settings?.enabled;
  const keepAliveEnabled = !!settings?.keepAliveEnabled;
  // clampIntervalMs は Number.isFinite チェック + MIN/MAX クランプを一括で行うため、
  // 生値を渡せば常に安全な範囲の数値になる。不正値（負数・NaN）は DEFAULT に落ちる。
  const keepAliveIntervalMs = KeepAlive.clampIntervalMs(settings?.keepAliveIntervalMs);
  // 許可ドメイン配列は popup 側で正規化済み。background では型チェックのみ行い
  // 不正な要素（非文字列や空文字）を最終段で弾く（XSS 目的の非文字列を保存しない）。
  const contextMenuAllowDomains = Array.isArray(settings?.contextMenuAllowDomains)
    ? settings.contextMenuAllowDomains.filter((d) => typeof d === "string" && d.length > 0)
    : [];

  await chrome.storage.local.set({
    [StorageKeys.ENABLED]: enabled,
    [StorageKeys.KEEP_ALIVE_ENABLED]: keepAliveEnabled,
    [StorageKeys.KEEP_ALIVE_INTERVAL_MS]: keepAliveIntervalMs,
    [StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS]: contextMenuAllowDomains,
  });
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
    data: { enabled, keepAliveEnabled, keepAliveIntervalMs, contextMenuAllowDomains },
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
//
// ライフサイクルを明示的な状態機械で扱う。以下の並走を制御する:
//  1. 並行 createDocument: "Only one offscreen document may be created" エラー回避
//  2. close 中の create: 30 秒タイマー発火後 closeDocument の await 中に
//     新しいクリップボード操作が入って ensure が走るとレースする
//  3. create 失敗の誤信: create が reject した場合に ensure が true を返すと
//     呼び出し元は「存在する」と誤認して sendMessage が無応答で空文字を返し、
//     ユーザーから見ると強制ペーストが無音で失敗する
//
// 状態: CLOSED (初期/close 完了) / CREATING / OPEN / CLOSING
let offscreenState = "CLOSED";
// create / close それぞれの進行中 Promise。待機用
let offscreenCreatingPromise = null;
let offscreenClosingPromise = null;
// アイドル時の自動 close タイマー。クリップボード操作は頻度が低いので閉じて常駐回避
// （閾値は actions.js の Offscreen.IDLE_MS が単一情報源）
let offscreenIdleTimer = null;

/**
 * Offscreen Document が未作成なら作成する。
 * chrome.runtime.getContexts (Chrome 116+) で存在確認を試み、失敗時は
 * createDocument を直接呼ぶ。create 失敗は呼び出し元に false で伝播する。
 *
 * @returns {Promise<boolean>} 作成成功/既存確認なら true、失敗なら false
 */
async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return false;

  // CLOSING 中なら close の完了を待つ（次の create を走らせる前に close を完了させる）
  if (offscreenClosingPromise) {
    try { await offscreenClosingPromise; } catch {}
  }

  const url = chrome.runtime.getURL(Offscreen.PATH);

  // getContexts で既存確認（Chrome 116+）
  try {
    if (typeof chrome.runtime.getContexts === "function") {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [url],
      });
      if (contexts.length > 0) {
        offscreenState = "OPEN";
        return true;
      }
    }
  } catch (err) {
    // getContexts 自体が失敗するのは Chrome バージョンや API 変更が原因。
    // 診断導線確保のため最低限 warn する。以降は createDocument にフォールバック。
    console.warn("[WebRestrictionRemover] getContexts failed:", err);
  }

  // 並行 create ガード
  if (offscreenCreatingPromise) {
    try {
      const ok = await offscreenCreatingPromise;
      return ok === true;
    } catch {
      return false;
    }
  }

  offscreenState = "CREATING";
  offscreenCreatingPromise = chrome.offscreen
    .createDocument({
      url: Offscreen.PATH,
      reasons: ["CLIPBOARD"],
      justification: "強制ペースト機能のためにクリップボードを読み取り",
    })
    .then(() => {
      offscreenState = "OPEN";
      return true;
    })
    .catch((err) => {
      // "Only one offscreen document may be created" は並行作成レース。
      // 別経路で作成済みと見なして成功扱いにする。
      if (String(err?.message ?? "").includes("Only one offscreen document")) {
        offscreenState = "OPEN";
        return true;
      }
      // それ以外の失敗（メモリ逼迫 / API 無効環境等）は明示的に失敗を返し、
      // 呼び出し元が「offscreen は存在しない」と判断できるようにする。
      console.warn("[WebRestrictionRemover] createDocument failed:", err);
      offscreenState = "CLOSED";
      return false;
    });

  try {
    const ok = await offscreenCreatingPromise;
    return ok === true;
  } finally {
    offscreenCreatingPromise = null;
  }
}

/**
 * 次のクリップボード使用までアイドル状態が続いたら offscreen document を閉じる。
 * 使い終わるたびに呼び、前回予約があれば延長する。
 * closeDocument の await 中は offscreenClosingPromise で並走中の ensure を待機させる。
 */
function scheduleOffscreenClose() {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(() => {
    offscreenIdleTimer = null;
    if (!chrome.offscreen) return;
    if (offscreenState === "CREATING") return; // 作成中は閉じない
    offscreenState = "CLOSING";
    offscreenClosingPromise = chrome.offscreen
      .closeDocument()
      .catch(() => {
        // 既に閉じている場合は無視
      })
      .finally(() => {
        offscreenState = "CLOSED";
        offscreenClosingPromise = null;
      });
  }, Offscreen.IDLE_MS);
}

/**
 * Offscreen Document 経由でクリップボードのテキストを読み取る。
 * offscreen の作成に失敗した場合や sendMessage が失敗した場合は空文字を返す。
 */
async function readClipboardViaOffscreen() {
  const ready = await ensureOffscreenDocument();
  if (!ready) {
    // create 失敗時は sendMessage に進まず即時空文字返却（無音の誤信を避ける）
    return "";
  }
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
  const ready = await ensureOffscreenDocument();
  if (!ready) return false;
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
