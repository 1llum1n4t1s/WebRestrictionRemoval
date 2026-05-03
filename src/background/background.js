importScripts("/src/lib/actions.js");

// ---------- 初期化 ----------
// onInstalled: 初回インストール / アップデート時
//   - 旧バージョンの設定キー（v1.0.x の copyPasteSettings、v1.0.17 の enabled / volumeBoosterEnabled /
//     contextMenuAllowDomains）をクリーンアップ
//   - v1.0.18: 旧 `ytShortsRemovalEnabled` トグルを `searchFixerFeatures.removeShorts` に統合
//   - 各機能トグルが未設定なら Default OFF（オプトイン方針）で初期化
chrome.runtime.onInstalled.addListener(async () => {
  // v1.0.18 マイグレーション: 旧 Shorts 削除トグルを YouTube クリーナーのサブ機能に転写。
  // 既存ユーザーがアップデートしたとき、Shorts 削除を有効にしていた状態を失わないようにする。
  // 転写後は旧キーを削除する（remove リスト側で処理）。
  const legacy = await chrome.storage.local
    .get(["ytShortsRemovalEnabled", StorageKeys.SEARCH_FIXER_FEATURES, StorageKeys.SEARCH_FIXER_ENABLED])
    .catch(() => ({}));
  if (legacy?.ytShortsRemovalEnabled === true) {
    const mergedFeatures = SearchFixer.mergeFeatures(legacy[StorageKeys.SEARCH_FIXER_FEATURES] ?? {});
    mergedFeatures.removeShorts = true;
    const migrate = {
      [StorageKeys.SEARCH_FIXER_FEATURES]: mergedFeatures,
      // 旧 Shorts 削除を ON にしていた人は YouTube クリーナーマスターも ON にしないと
      // サブ機能が動かない（master 必須）。マイグレーションでは「動作継続」を最優先。
      [StorageKeys.SEARCH_FIXER_ENABLED]: true,
    };
    await chrome.storage.local.set(migrate).catch(() => {});
  }

  // 廃止キーの削除（v1.0.x 系 + v1.0.17 + v1.0.18 で統合した ytShortsRemovalEnabled）
  await chrome.storage.local
    .remove([
      "copyPasteSettings",
      "enabled",
      "volumeBoosterEnabled",
      "contextMenuAllowDomains",
      "ytShortsRemovalEnabled",
    ])
    .catch(() => {});

  const stored = await chrome.storage.local.get([
    StorageKeys.KEEP_ALIVE_ENABLED,
    StorageKeys.KEEP_ALIVE_INTERVAL_MS,
    StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED,
    StorageKeys.SEARCH_FIXER_ENABLED,
    StorageKeys.SEARCH_FIXER_FEATURES,
    StorageKeys.SEARCH_FIXER_GRID_ITEMS,
    StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED,
    StorageKeys.INSTAGRAM_CLEANER_ENABLED,
    StorageKeys.INSTAGRAM_CLEANER_FEATURES,
  ]);
  const defaults = {};
  if (!(StorageKeys.KEEP_ALIVE_ENABLED in stored)) defaults[StorageKeys.KEEP_ALIVE_ENABLED] = false;
  if (!(StorageKeys.KEEP_ALIVE_INTERVAL_MS in stored)) {
    defaults[StorageKeys.KEEP_ALIVE_INTERVAL_MS] = KeepAlive.DEFAULT_INTERVAL_MS;
  }
  if (!(StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED in stored)) {
    // HTTP ping は副作用大（認証プロキシ環境で 401/302 ループ誘発）のためデフォルト OFF
    defaults[StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED] = false;
  }
  if (!(StorageKeys.SEARCH_FIXER_ENABLED in stored)) {
    defaults[StorageKeys.SEARCH_FIXER_ENABLED] = false;
  }
  if (!(StorageKeys.SEARCH_FIXER_FEATURES in stored)) {
    defaults[StorageKeys.SEARCH_FIXER_FEATURES] = SearchFixer.mergeFeatures({});
  }
  if (!(StorageKeys.SEARCH_FIXER_GRID_ITEMS in stored)) {
    defaults[StorageKeys.SEARCH_FIXER_GRID_ITEMS] = 0;
  }
  if (!(StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED in stored)) {
    defaults[StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED] = false;
  }
  if (!(StorageKeys.INSTAGRAM_CLEANER_ENABLED in stored)) {
    defaults[StorageKeys.INSTAGRAM_CLEANER_ENABLED] = false;
  }
  if (!(StorageKeys.INSTAGRAM_CLEANER_FEATURES in stored)) {
    defaults[StorageKeys.INSTAGRAM_CLEANER_FEATURES] = InstagramCleaner.mergeFeatures({});
  }
  if (Object.keys(defaults).length > 0) {
    await chrome.storage.local.set(defaults);
  }
});

// ---------- メッセージハンドラ ----------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === Actions.APPLY_SETTINGS) {
    if (!SenderCheck.isFromPopup(sender)) return;
    handleApplySettings(request.data)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  } else if (request.action === Actions.VOLUME_BOOSTER_SET_GAIN) {
    // popup が user gesture を持つので、popup → background → tabCapture の連鎖で getMediaStreamId が動く。
    if (!SenderCheck.isFromPopup(sender)) return;
    setVolumeBoosterGain(request.data?.tabId, request.data?.gain)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  } else if (request.action === Actions.VOLUME_BOOSTER_GET_GAIN) {
    if (!SenderCheck.isFromPopup(sender)) return;
    getVolumeBoosterGain(request.data?.tabId)
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ gain: null }));
    return true;
  } else if (request.action === Actions.VOLUME_BOOSTER_RELEASE_TAB) {
    if (!SenderCheck.isFromPopup(sender)) return;
    releaseVolumeBoosterTab(request.data?.tabId)
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// ---------- タブクローズで音量ブーストを解放 ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.runtime
    .sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_VOLUME_RELEASE_TAB,
      tabId,
    })
    .catch(() => {})
    .finally(() => scheduleOffscreenClose());
});

async function getActiveTab() {
  // SW 再起動直後やウィンドウ未検出の境界条件で chrome.tabs.query が throw することがあるため
  // try/catch でガード。返り値 undefined は呼び出し元 (handleApplySettings) で `tab?.id` チェック済み。
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab;
  } catch {
    return undefined;
  }
}

/**
 * Popup から設定変更を受けた際のエントリ。
 *
 * 責務:
 *   1. 設定値の正規化（clamp / merge）
 *   2. chrome.storage.local への一括保存
 *   3. active tab への即時通知（`notifyContentScripts` に委譲）
 *
 * 「制限解除」機能の削除に伴い、対応するハンドラ（contextMenus 再構築 /
 * MW インラインハンドラ除去 / clipboard 関連 / カスタム右クリック許可リスト）も削除済み。
 */
async function handleApplySettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set(toStorageRecord(normalized));
  await notifyContentScripts(normalized);
}

/**
 * popup から受け取った生の settings オブジェクトを正規化（clamp / merge / boolean 化）。
 *
 * boolean フィールドは `=== true` で厳格判定する（`!!` は禁止）。
 * 理由: storage に紛れ込んだ非 boolean 値（"false" 文字列・数値 1 など）が
 * `!!` だと truthy 判定されて誤って ON 化されうる。デフォルト OFF 方針を堅持するため、
 * 明示的な `true` のときだけ有効化する。
 */
function normalizeSettings(settings) {
  return {
    keepAliveEnabled: settings?.keepAliveEnabled === true,
    keepAliveIntervalMs: KeepAlive.clampIntervalMs(settings?.keepAliveIntervalMs),
    keepAliveHttpPingEnabled: settings?.keepAliveHttpPingEnabled === true,
    searchFixerEnabled: settings?.searchFixerEnabled === true,
    searchFixerFeatures: SearchFixer.mergeFeatures(settings?.searchFixerFeatures),
    searchFixerGridItems: SearchFixer.clampGridItems(settings?.searchFixerGridItems),
    amazonDeliveryTotalEnabled: settings?.amazonDeliveryTotalEnabled === true,
    instagramCleanerEnabled: settings?.instagramCleanerEnabled === true,
    instagramCleanerFeatures: InstagramCleaner.mergeFeatures(settings?.instagramCleanerFeatures),
  };
}

/** 正規化済み settings から chrome.storage.local.set 用のレコードを構築。 */
function toStorageRecord(s) {
  return {
    [StorageKeys.KEEP_ALIVE_ENABLED]: s.keepAliveEnabled,
    [StorageKeys.KEEP_ALIVE_INTERVAL_MS]: s.keepAliveIntervalMs,
    [StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED]: s.keepAliveHttpPingEnabled,
    [StorageKeys.SEARCH_FIXER_ENABLED]: s.searchFixerEnabled,
    [StorageKeys.SEARCH_FIXER_FEATURES]: s.searchFixerFeatures,
    [StorageKeys.SEARCH_FIXER_GRID_ITEMS]: s.searchFixerGridItems,
    [StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED]: s.amazonDeliveryTotalEnabled,
    [StorageKeys.INSTAGRAM_CLEANER_ENABLED]: s.instagramCleanerEnabled,
    [StorageKeys.INSTAGRAM_CLEANER_FEATURES]: s.instagramCleanerFeatures,
  };
}

/**
 * active tab に対して URL に応じた APPLY_* メッセージを配布する。
 * storage.onChanged でも全タブ同期されるが、active tab だけは即時反映するためこのパスが必要。
 *
 * 各ターゲットへの sendMessage は受信側が居ないと例外になるため `.catch(() => {})` でガード。
 * 全機能スキップになる非 HTTP(S) ページ (`chrome://`, `file://` 等) は早期 return。
 */
async function notifyContentScripts(s) {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const url = tab.url ?? "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) return;

  // keepalive content script は全 http(s) ページに注入済みなので常に通知。
  await chrome.tabs
    .sendMessage(tab.id, {
      action: Actions.APPLY_KEEP_ALIVE_CS,
      data: {
        keepAliveEnabled: s.keepAliveEnabled,
        keepAliveIntervalMs: s.keepAliveIntervalMs,
        keepAliveHttpPingEnabled: s.keepAliveHttpPingEnabled,
      },
    })
    .catch(() => {});

  if (isYouTubeUrl(url)) {
    // Shorts 削除も YouTube クリーナーのサブ機能 (features.removeShorts) として
    // 統合されたため、メッセージは APPLY_SEARCH_FIXER_CS のみ。
    // youtube-shorts.js / search-fixer.js の両方が同一 isolated world で
    // この 1 メッセージを購読し、各々の責務に応じて反応する。
    await chrome.tabs
      .sendMessage(tab.id, {
        action: Actions.APPLY_SEARCH_FIXER_CS,
        data: {
          enabled: s.searchFixerEnabled,
          features: s.searchFixerFeatures,
          gridItems: s.searchFixerGridItems,
        },
      })
      .catch(() => {});
  }

  if (isAmazonAutoDeliveryUrl(url)) {
    await chrome.tabs
      .sendMessage(tab.id, {
        action: Actions.APPLY_AMAZON_DELIVERY_TOTAL_CS,
        data: { enabled: s.amazonDeliveryTotalEnabled },
      })
      .catch(() => {});
  }

  if (isInstagramUrl(url)) {
    await chrome.tabs
      .sendMessage(tab.id, {
        action: Actions.APPLY_INSTAGRAM_CLEANER_CS,
        data: {
          enabled: s.instagramCleanerEnabled,
          features: s.instagramCleanerFeatures,
        },
      })
      .catch(() => {});
  }
}

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

function isInstagramUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "instagram.com" || h.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

// ---------- Offscreen Document 管理 ----------
//
// 状態: CLOSED (初期/close 完了) / CREATING / OPEN / CLOSING
let offscreenState = "CLOSED";
let offscreenCreatingPromise = null;
let offscreenClosingPromise = null;
let offscreenIdleTimer = null;
// scheduleOffscreenClose の連続再スケジュール回数（soft tracking 用）。
// `isVolumeBoosterActive()` が true である限り再スケジュールを継続する設計のため、
// このカウンタは無限増加防止のリセット境界として機能する（実際の close 停止はしない）。
// 10 回 = 5 分。リセットしても close 試行ループ自体は継続し、
// `isVolumeBoosterActive()` が false に戻ったタイミングで初めて close へ進む。
const OFFSCREEN_CLOSE_RESCHEDULE_LIMIT = 10;
let offscreenCloseRescheduleCount = 0;

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return false;

  if (offscreenClosingPromise) {
    try { await offscreenClosingPromise; } catch {}
  }

  const url = chrome.runtime.getURL(Offscreen.PATH);

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
    console.warn("[WebViewingAssist] getContexts failed:", err);
    // EC-9 対策: getContexts 失敗時にすでに OPEN として記録済みなら create を再試行しない
    // （別経路で OPEN が確定しているケースで重複 createDocument を避ける）。
    if (offscreenState === "OPEN") return true;
  }

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
      reasons: Offscreen.REASONS,
      justification: "音量ブースター機能の AudioContext 維持と tabCapture ストリーム保持のため",
    })
    .then(() => {
      offscreenState = "OPEN";
      return true;
    })
    .catch((err) => {
      if (String(err?.message ?? "").includes("Only one offscreen document")) {
        offscreenState = "OPEN";
        return true;
      }
      console.warn("[WebViewingAssist] createDocument failed:", err);
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

function scheduleOffscreenClose() {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(async () => {
    offscreenIdleTimer = null;
    if (!chrome.offscreen) return;
    // EC-6 対策: CREATING 中はもちろん、CLOSING 中の二重呼び出しもガードする
    // （await `isVolumeBoosterActive` の最中に別タイマーが発火するケースで二重 close を防ぐ）。
    if (offscreenState === "CREATING" || offscreenState === "CLOSING") return;
    // 音量ブースト中タブが残っていれば close を再延期する。close すると AudioContext が
    // 解放されて音が一瞬で 100% に戻ってしまうため、ユーザー体験的に NG。
    if (await isVolumeBoosterActive()) {
      // PERF-11 対策: 通信失敗で `isVolumeBoosterActive` が常に true を返す状況でも、
      // 強制 close はブースト中の音を断つリスクがあるため避けて再スケジュールを継続する。
      // カウンタは「連続再スケジュール回数」を soft tracking する目的で保持し、
      // 上限到達時はリセットだけして次サイクルへ繰り越す（無限カウントアップ防止）。
      // close 試行を停止すると offscreen document が永久に残ってしまうため、
      // 上限到達後も `scheduleOffscreenClose()` を必ず呼んで cycle を維持する。
      offscreenCloseRescheduleCount += 1;
      if (offscreenCloseRescheduleCount >= OFFSCREEN_CLOSE_RESCHEDULE_LIMIT) {
        offscreenCloseRescheduleCount = 0;
      }
      scheduleOffscreenClose();
      return;
    }
    // ここまで到達 = boost なし → カウンタリセットして close へ
    offscreenCloseRescheduleCount = 0;
    offscreenState = "CLOSING";
    offscreenClosingPromise = chrome.offscreen
      .closeDocument()
      .catch(() => {})
      .finally(() => {
        offscreenState = "CLOSED";
        offscreenClosingPromise = null;
      });
  }, Offscreen.IDLE_MS);
}

async function isVolumeBoosterActive() {
  if (typeof chrome.runtime.getContexts !== "function") {
    try {
      const res = await chrome.runtime.sendMessage({
        target: Offscreen.TARGET,
        action: Offscreen.ACTION_VOLUME_QUERY_ACTIVE,
      });
      return Number(res?.activeCount ?? 0) > 0;
    } catch {
      // 通信失敗時は safe side で active 扱い（同関数内の他の catch も true 返却で揃える）。
      // false を返すとブースト中タブが残っているのに offscreen を close してしまうリスクあり。
      return true;
    }
  }
  try {
    const url = chrome.runtime.getURL(Offscreen.PATH);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (contexts.length === 0) return false;
  } catch {
    return true;
  }
  try {
    const res = await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_VOLUME_QUERY_ACTIVE,
    });
    return Number(res?.activeCount ?? 0) > 0;
  } catch {
    return true;
  }
}

// ---------- 音量ブースター ヘルパー ----------

/**
 * 指定タブの音量を設定する。スライダー値が UNITY (100) のときは AudioContext を解放するだけで
 * 新規 tabCapture は呼ばない（リソース節約 + chrome:// 等での無駄なエラー回避）。
 */
async function setVolumeBoosterGain(tabId, gain) {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, error: "invalid-tab-id" };
  }
  const clamped = VolumeBooster.clampValue(gain);

  // スライダーが等倍位置 (100%) ならブースト不要 → タブを解放してリソース返却。
  if (clamped === VolumeBooster.UNITY) {
    await releaseVolumeBoosterTab(tabId).catch(() => {});
    return { ok: true, gain: VolumeBooster.UNITY };
  }

  const ready = await ensureOffscreenDocument();
  if (!ready) return { ok: false, error: "offscreen-unavailable" };

  // 既存 AudioContext があれば streamId は不要（getMediaStreamId をスキップ）。
  const existing = await getVolumeBoosterGain(tabId);
  if (Number.isFinite(existing?.gain)) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        target: Offscreen.TARGET,
        action: Offscreen.ACTION_VOLUME_SET_GAIN,
        tabId,
        streamId: null,
        gain: clamped,
      });
    } catch (err) {
      // 例外: offscreen がリスタート途中など → fresh 取得経路へフォールスルー
    } finally {
      scheduleOffscreenClose();
    }
    // EC-2 対策: getVolumeBoosterGain で「state あり」と判定後に audioStates が削除される
    // race（onRemoved や release 経路と同時操作）に対して、offscreen が
    // `invalid-stream-id` を返した場合は fresh 取得経路に自動フォールスルーして自己修復する。
    if (res?.ok) return res;
    if (res && res.error !== "invalid-stream-id") return res;
    // res が undefined or invalid-stream-id → fresh 取得経路へ
  }

  // 新規接続: tabCapture から streamId を取得。
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

async function getVolumeBoosterGain(tabId) {
  if (typeof tabId !== "number") return { gain: null };
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
 * 指定タブの AudioContext を解放（スライダー 100% 復帰時に呼ぶ）。
 *
 * `chrome.runtime.getContexts` は Chrome 116+ の API で、本拡張がサポートしたい
 * 古い Chrome では未実装。getContexts が使える場合は最適化として「offscreen 不在なら
 * 早期 return」で無駄な sendMessage を抑制し、未実装環境では直接 release を送信して
 * 受信側が居なければ catch で握りつぶす。
 *
 * 旧実装は `getContexts` 未実装環境でも early return していたため、release メッセージが
 * 届かず AudioContext が永続的に残留する resource leak があった (CodeRabbit P2 指摘)。
 */
async function releaseVolumeBoosterTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return { ok: true };
  if (typeof chrome.runtime.getContexts === "function") {
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
  }
  try {
    await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_VOLUME_RELEASE_TAB,
      tabId,
    });
  } catch {
    // 既に閉じている / offscreen 不在等は無視
  } finally {
    scheduleOffscreenClose();
  }
  return { ok: true };
}
