importScripts("/src/lib/actions.js");

// ---------- 初期化 ----------
// onInstalled: 初回インストール/アップデート時
//   - 旧バージョンの設定キー（copyPasteSettings）をクリーンアップ
//   - ENABLED が未設定ならデフォルト OFF（ユーザーが意図的に ON にした時のみ動作させるオプトイン方針）
//   - 右クリックメニューを現在の ENABLED 状態に合わせて作成
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove("copyPasteSettings").catch(() => {});
  const stored = await chrome.storage.local.get([
    StorageKeys.ENABLED,
    StorageKeys.KEEP_ALIVE_ENABLED,
    StorageKeys.KEEP_ALIVE_INTERVAL_MS,
    StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS,
    StorageKeys.YT_SHORTS_REMOVAL_ENABLED,
    StorageKeys.SEARCH_FIXER_ENABLED,
    StorageKeys.SEARCH_FIXER_FEATURES,
    StorageKeys.SEARCH_FIXER_GRID_ITEMS,
    StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED,
    StorageKeys.VOLUME_BOOSTER_ENABLED,
  ]);
  const defaults = {};
  // 制限解除はオプトイン（Default OFF）。インストール直後にサイト挙動を勝手に書き換えないため、
  // ユーザーが popup で明示的に ON にしたときのみ右クリック/選択ブロックの解除と
  // インラインハンドラ除去・右クリックメニュー登録を始める。
  if (!(StorageKeys.ENABLED in stored)) defaults[StorageKeys.ENABLED] = false;
  // セッション維持はオプトイン（Default OFF）。HTTP ping を勝手に始めないため。
  if (!(StorageKeys.KEEP_ALIVE_ENABLED in stored)) defaults[StorageKeys.KEEP_ALIVE_ENABLED] = false;
  if (!(StorageKeys.KEEP_ALIVE_INTERVAL_MS in stored)) {
    defaults[StorageKeys.KEEP_ALIVE_INTERVAL_MS] = KeepAlive.DEFAULT_INTERVAL_MS;
  }
  // カスタム右クリック許可リストは初期空（組み込みパターンのみが効く）
  if (!(StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS in stored)) {
    defaults[StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS] = [];
  }
  // YouTube Shorts 削除はオプトイン（Default OFF）。"web 制限解除" が主軸のため
  // YouTube 専用 DOM 改変を勝手に始めず、ユーザーが明示的に ON にしたときのみ動かす。
  if (!(StorageKeys.YT_SHORTS_REMOVAL_ENABLED in stored)) {
    defaults[StorageKeys.YT_SHORTS_REMOVAL_ENABLED] = false;
  }
  // YouTube Search Fixer もマスター OFF + 全機能 OFF + グリッド自動 で初期化（オプトイン方針）。
  if (!(StorageKeys.SEARCH_FIXER_ENABLED in stored)) {
    defaults[StorageKeys.SEARCH_FIXER_ENABLED] = false;
  }
  if (!(StorageKeys.SEARCH_FIXER_FEATURES in stored)) {
    defaults[StorageKeys.SEARCH_FIXER_FEATURES] = SearchFixer.mergeFeatures({});
  }
  if (!(StorageKeys.SEARCH_FIXER_GRID_ITEMS in stored)) {
    defaults[StorageKeys.SEARCH_FIXER_GRID_ITEMS] = 0;
  }
  // Amazon 定期おトク便の合計表示もオプトイン（Default OFF）。
  // ページに DOM 挿入を行うため、ユーザーが意図的に有効化したときのみ動かす。
  if (!(StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED in stored)) {
    defaults[StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED] = false;
  }
  // 音量ブースターもオプトイン（Default OFF）。tabCapture でタブ音声を取得するため、
  // ユーザーが明示的に有効化したときのみ動かす。OFF 時はマイク的な許可ダイアログも出ない。
  if (!(StorageKeys.VOLUME_BOOSTER_ENABLED in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_ENABLED] = false;
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
// 検証ロジックは actions.js の SenderCheck に集約。background 由来チェックは三層
// （id + !tab + url 一致）で popup / offscreen / option page を厳密に区別する。
// 旧実装の isFromPopup は !sender.tab だけを見ていたため offscreen 等が popup と
// 誤認される脆弱性があった（指摘 #11）。
const isFromPopup = SenderCheck.isFromPopup;
const isFromContentScript = SenderCheck.isFromContentScript;

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
  } else if (request.action === Actions.VOLUME_BOOSTER_SET_GAIN) {
    // 音量ブースト変更は popup 由来のみ。content script からの叩きは遮断する。
    // tabCapture は user gesture が要求されるが、popup の input 操作は user gesture として
    // 認められるため、popup → background → tabCapture の連鎖で getMediaStreamId が動く。
    if (!isFromPopup(sender)) return;
    setVolumeBoosterGain(request.data?.tabId, request.data?.gain)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  } else if (request.action === Actions.VOLUME_BOOSTER_GET_GAIN) {
    if (!isFromPopup(sender)) return;
    getVolumeBoosterGain(request.data?.tabId)
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ gain: null }));
    return true;
  } else if (request.action === Actions.VOLUME_BOOSTER_RELEASE_ALL) {
    if (!isFromPopup(sender)) return;
    releaseAllVolumeBoosts()
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// ---------- タブクローズで音量ブーストを解放 ----------
// chrome.tabs.onRemoved は permission 不要で永続的に発火する。タブを閉じた瞬間に
// SW が眠っていてもイベントで起動するため、AudioContext の取り残しを防げる。
chrome.tabs.onRemoved.addListener((tabId) => {
  // offscreen が無くてもメッセージは receiver 不在で空応答になるため、軽く投げて握り潰す。
  // ensureOffscreenDocument は呼ばない（タブクローズだけで offscreen を起こすのは無駄）。
  chrome.runtime.sendMessage({
    target: Offscreen.TARGET,
    action: Offscreen.ACTION_VOLUME_RELEASE_TAB,
    tabId,
  }).catch(() => {});
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
  // YouTube Shorts 削除トグル。メイン enabled と独立にオプトイン。
  const ytShortsRemovalEnabled = !!settings?.ytShortsRemovalEnabled;
  // YouTube Search Fixer マスタートグルと個別機能オブジェクト・グリッド列数。
  const searchFixerEnabled = !!settings?.searchFixerEnabled;
  const searchFixerFeatures = SearchFixer.mergeFeatures(settings?.searchFixerFeatures);
  const searchFixerGridItems = SearchFixer.clampGridItems(settings?.searchFixerGridItems);
  // Amazon 定期おトク便 月別合計表示マスタートグル。
  const amazonDeliveryTotalEnabled = !!settings?.amazonDeliveryTotalEnabled;
  // 音量ブースターマスタートグル。OFF なら必ず全タブを release する。
  // TOCTOU 競合 (#9): 旧実装は storage.get → set の間に別の APPLY_SETTINGS が割り込むと
  // wasEnabled の判定がずれて release 漏れになるリスクがあった。新値が false なら無条件で
  // releaseAllVolumeBoosts を呼ぶ設計に変更（offscreen 不在時は no-op で冪等）。
  // これにより read-before-write を排除し、storage.get の 1 IPC も削減 (#17)。
  const volumeBoosterEnabled = !!settings?.volumeBoosterEnabled;

  await chrome.storage.local.set({
    [StorageKeys.ENABLED]: enabled,
    [StorageKeys.KEEP_ALIVE_ENABLED]: keepAliveEnabled,
    [StorageKeys.KEEP_ALIVE_INTERVAL_MS]: keepAliveIntervalMs,
    [StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS]: contextMenuAllowDomains,
    [StorageKeys.YT_SHORTS_REMOVAL_ENABLED]: ytShortsRemovalEnabled,
    [StorageKeys.SEARCH_FIXER_ENABLED]: searchFixerEnabled,
    [StorageKeys.SEARCH_FIXER_FEATURES]: searchFixerFeatures,
    [StorageKeys.SEARCH_FIXER_GRID_ITEMS]: searchFixerGridItems,
    [StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED]: amazonDeliveryTotalEnabled,
    [StorageKeys.VOLUME_BOOSTER_ENABLED]: volumeBoosterEnabled,
  });
  await updateContextMenus();

  // 音量ブースター: 新値が false なら無条件に release。
  // OFF→OFF でも releaseAllVolumeBoosts は audioStates が空なら即 return するため冪等。
  // TOCTOU を構造的に排除し、wasEnabled の get を不要にした (#9, #17)。
  if (!volumeBoosterEnabled) {
    await releaseAllVolumeBoosts().catch(() => {});
  }

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

  // YouTube 系 content script (Shorts 削除 + Search Fixer) は matches=youtube.com 限定。
  // 非 YouTube タブに送ると receiver 不在で例外を投げるため URL 判定でガードする。
  // 非アクティブな YouTube タブは chrome.storage.onChanged 経由で自然に同期される。
  if (isYouTubeUrl(url)) {
    // Shorts 削除と Search Fixer は独立した content script で並行実行可能 (#26)。
    // 旧実装は逐次 await で 1 RTT 余計にかかっていた。
    await Promise.all([
      chrome.tabs.sendMessage(tab.id, {
        action: Actions.APPLY_YT_SHORTS_CS,
        data: { enabled: ytShortsRemovalEnabled },
      }).catch(() => {}),
      chrome.tabs.sendMessage(tab.id, {
        action: Actions.APPLY_SEARCH_FIXER_CS,
        data: {
          enabled: searchFixerEnabled,
          features: searchFixerFeatures,
          gridItems: searchFixerGridItems,
        },
      }).catch(() => {}),
    ]);
  }

  // Amazon 定期おトク便 content script は `*://www.amazon.co.jp/auto-deliveries*` 限定。
  // 非対象タブへの送信は receiver 不在で例外になるため URL 判定でガード。
  if (isAmazonAutoDeliveryUrl(url)) {
    await chrome.tabs.sendMessage(tab.id, {
      action: Actions.APPLY_AMAZON_DELIVERY_TOTAL_CS,
      data: { enabled: amazonDeliveryTotalEnabled },
    }).catch(() => {});
  }

  if (enabled) {
    await removeInlineHandlersInMainWorld(tab.id);
  }
}

/**
 * URL が youtube.com サブドメインかを判定する（content_scripts.matches "*://*.youtube.com/*" と一致）。
 * `*.youtube.com` の suffix match のみ。`example-youtube.com` のような偽装は弾く。
 */
function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "youtube.com" || h.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

/**
 * URL が Amazon.co.jp の定期おトク便ページかを判定する
 * （content_scripts.matches "*://www.amazon.co.jp/auto-deliveries*" と一致）。
 * hostname の厳密一致 + パスの prefix チェック。サブドメインや偽装は受け付けない。
 */
function isAmazonAutoDeliveryUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.hostname.toLowerCase() !== "www.amazon.co.jp") return false;
    return u.pathname.startsWith("/auto-deliveries");
  } catch {
    return false;
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
      // クリップボード + 音量ブースター用の tabCapture (USER_MEDIA) + AudioContext 出力
      // (AUDIO_PLAYBACK) を 1 つの offscreen で扱う。Chrome は 1 拡張 1 offscreen 制約。
      reasons: Offscreen.REASONS,
      justification:
        "強制ペースト機能のクリップボード読取と、音量ブースター機能の AudioContext 維持のため",
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
  offscreenIdleTimer = setTimeout(async () => {
    offscreenIdleTimer = null;
    if (!chrome.offscreen) return;
    if (offscreenState === "CREATING") return; // 作成中は閉じない
    // 音量ブースト中のタブが残っている場合は close を抑止する。
    // close すると AudioContext が解放されて音が一瞬で 100% に戻ってしまうため、
    // ユーザー体験的に NG。代わりに次のアイドル close を再スケジュールして
    // 「ブースト解除されるまで」 close を保留する。
    if (await isVolumeBoosterActive()) {
      scheduleOffscreenClose();
      return;
    }
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
 * Offscreen に「現在 boost 中のタブ数」を問い合わせ、1 件以上なら true を返す。
 * 通信失敗（offscreen が無い等）は false に倒す。
 */
async function isVolumeBoosterActive() {
  // SW 再起動直後など offscreen との通信が一瞬失敗するケースで、誤って close を走らせると
  // 進行中のブーストが無音になる。安全策として「通信失敗時はブースト中の可能性あり」と倒す。
  // ただし offscreen 文書自体が存在しない場合は確実にブーストもないので getContexts で先に確認する。
  if (typeof chrome.runtime.getContexts !== "function") {
    // getContexts API 未対応環境（古い Chrome）では sendMessage 結果を信じるしかない
    try {
      const res = await chrome.runtime.sendMessage({
        target: Offscreen.TARGET,
        action: Offscreen.ACTION_VOLUME_QUERY_ACTIVE,
      });
      return Number(res?.activeCount ?? 0) > 0;
    } catch {
      return false; // フォールバック: 古い環境では従来通り
    }
  }
  try {
    const url = chrome.runtime.getURL(Offscreen.PATH);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (contexts.length === 0) return false; // offscreen 不在 = ブースト不可能
  } catch {
    // getContexts 自体の失敗は安全側に倒す（close を保留）
    return true;
  }
  try {
    const res = await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_VOLUME_QUERY_ACTIVE,
    });
    return Number(res?.activeCount ?? 0) > 0;
  } catch {
    // offscreen は存在するが通信失敗 → SW 再起動直後の可能性あり、安全側で active 扱い
    return true;
  }
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
  // closeDocument の非同期破棄と次の sendMessage の間で receiver 不在の競合が起きうる (#16)。
  // 1 回だけ ensure → retry を入れて回復可能性を上げる。リトライしても失敗する場合は諦める。
  try {
    const response = await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_READ,
    });
    return response?.text ?? "";
  } catch {
    // receiver 不在 → ensure 再実行 → リトライ
    try {
      const ok = await ensureOffscreenDocument();
      if (!ok) return "";
      const response = await chrome.runtime.sendMessage({
        target: Offscreen.TARGET,
        action: Offscreen.ACTION_READ,
      });
      return response?.text ?? "";
    } catch {
      return "";
    }
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
  // closeDocument 非同期破棄レース対策で 1 回リトライする (#16)。
  try {
    const response = await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_WRITE,
      text,
    });
    return !!response?.ok;
  } catch {
    try {
      const ok = await ensureOffscreenDocument();
      if (!ok) return false;
      const response = await chrome.runtime.sendMessage({
        target: Offscreen.TARGET,
        action: Offscreen.ACTION_WRITE,
        text,
      });
      return !!response?.ok;
    } catch {
      return false;
    }
  } finally {
    scheduleOffscreenClose();
  }
}


// ---------- 音量ブースター ヘルパー ----------

/**
 * 指定タブの音量を設定する。
 *
 * フロー:
 *   1. master トグル `volumeBoosterEnabled` が true でなければ拒否
 *   2. ensureOffscreenDocument() で offscreen を起こす（reasons には USER_MEDIA / AUDIO_PLAYBACK 含む）
 *   3. chrome.tabCapture.getMediaStreamId({ targetTabId }) で MediaStream ID を取得
 *      （これは popup の user gesture が伝播している必要があるが、popup → background の
 *        sendMessage 連鎖で OK）
 *   4. offscreen に gain 変更メッセージを送信
 *   5. アイドル close を再スケジュール（ブースト中はスキップされる）
 *
 * @param {number} tabId
 * @param {number} gain  0-600 の整数（％）
 * @returns {Promise<{ok: boolean, gain?: number, error?: string}>}
 */
async function setVolumeBoosterGain(tabId, gain) {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    // #24: NaN / Infinity / 浮動小数点を弾く。typeof "number" だけでは不十分。
    return { ok: false, error: "invalid-tab-id" };
  }
  // master トグルガード（防御的: popup 側でもガードしているが、storage 直接書込みされたケースに備える）
  const stored = await chrome.storage.local.get(StorageKeys.VOLUME_BOOSTER_ENABLED);
  if (stored[StorageKeys.VOLUME_BOOSTER_ENABLED] !== true) {
    return { ok: false, error: "master-disabled" };
  }
  const ready = await ensureOffscreenDocument();
  if (!ready) return { ok: false, error: "offscreen-unavailable" };

  const clamped = VolumeBooster.clampValue(gain);

  // #12 最適化: 既に offscreen の audioStates にこのタブの AudioContext がある場合、
  // streamId は捨てられるだけなので getMediaStreamId 呼出を完全にスキップする。
  // 廃止予定 API への依存を減らし、スライダードラッグ時の連続コールも削減できる。
  const existing = await getVolumeBoosterGain(tabId);
  if (Number.isFinite(existing?.gain)) {
    try {
      const res = await chrome.runtime.sendMessage({
        target: Offscreen.TARGET,
        action: Offscreen.ACTION_VOLUME_SET_GAIN,
        tabId,
        streamId: null, // 既存 AudioContext あり → 不要
        gain: clamped,
      });
      return res ?? { ok: false, error: "no-response" };
    } catch (err) {
      // フォールスルーして fresh 取得経路へ
    } finally {
      scheduleOffscreenClose();
    }
  }

  // 新規接続パス: tabCapture から streamId を取得して offscreen で AudioContext を構築。
  // tabCapture.getMediaStreamId は user gesture が要求されるが、popup → background の
  // sendMessage で gesture が伝播するため動作する。
  let streamId = null;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: tabId },
        (id) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(id);
        }
      );
    });
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }

  try {
    const res = await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_VOLUME_SET_GAIN,
      tabId,
      streamId,
      gain: clamped,
    });
    return res ?? { ok: false, error: "no-response" };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    scheduleOffscreenClose();
  }
}

/**
 * 指定タブの現在 gain（％）を offscreen から取得する。
 * offscreen が起動していない場合は null を返す（= 未ブースト = 100% 相当）。
 */
async function getVolumeBoosterGain(tabId) {
  if (typeof tabId !== "number") return { gain: null };
  // offscreen を起こさずに query する。起動していなければ未ブーストと同義。
  if (typeof chrome.runtime.getContexts !== "function") return { gain: null };
  try {
    const url = chrome.runtime.getURL(Offscreen.PATH);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (contexts.length === 0) return { gain: null };
  } catch {
    return { gain: null };
  }
  try {
    const res = await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_VOLUME_GET_GAIN,
      tabId,
    });
    return { gain: res?.gain ?? null };
  } catch {
    return { gain: null };
  }
}

/**
 * 全タブの音量ブーストを解放する（master OFF 時に popup から呼ばれる）。
 * offscreen が無ければ何もしない（既に close 済み）。
 */
async function releaseAllVolumeBoosts() {
  if (typeof chrome.runtime.getContexts !== "function") return { ok: true };
  try {
    const url = chrome.runtime.getURL(Offscreen.PATH);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (contexts.length === 0) return { ok: true };
  } catch {
    return { ok: true };
  }
  try {
    await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_VOLUME_RELEASE_ALL,
    });
  } catch {
    // 既に閉じている等は無視
  } finally {
    // 全 release 後は次のアイドル close で確実に閉じる
    scheduleOffscreenClose();
  }
  return { ok: true };
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
