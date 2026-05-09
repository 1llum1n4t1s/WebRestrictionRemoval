importScripts("/src/lib/actions.js");

// ---------- 初期化 ----------
// onInstalled: 初回インストール / アップデート時
//   - 旧バージョンの設定キー（v1.0.x の copyPasteSettings、v1.0.17 の enabled / volumeBoosterEnabled /
//     contextMenuAllowDomains）をクリーンアップ
//   - v1.0.18: 旧 `ytShortsRemovalEnabled` トグルを `searchFixerFeatures.removeShorts` に統合
//   - 各機能トグルが未設定なら Default OFF（オプトイン方針）で初期化
chrome.runtime.onInstalled.addListener(async () => {
  // 過去 2 段階の Shorts 削除設定を新構造の 5 機能 (removeShortsShelf / removeShortsChip /
  // removeShortsSidebar / redirectShortsUrl / shortsBtn) に直接転写する。
  //
  // - v1.0.x まで:        ytShortsRemovalEnabled (bool) 単一トグル
  // - v1.0.18 〜 v1.0.x:  searchFixerFeatures.removeShorts (bool) サブ機能化（中間段階）
  // - 現バージョン:        5 機能に分割
  //
  // どちらの旧構造から来たユーザーも、storage 生値を見て新キーが未設定 (=== undefined) のものだけを
  // true に転写する。これでユーザーが新キーで明示的に false に設定していた場合は尊重される。
  // 重要: SearchFixer.mergeFeatures(...) は default false で 5 機能を seed するため、merged 側を
  // 見て undefined チェックすると seed された false を「ユーザー明示 false」と誤認する罠がある
  // （Codex P2 指摘）。必ず existingFeatures (storage 生値) を判定基準にする。
  const legacy = await chrome.storage.local
    .get(["ytShortsRemovalEnabled", StorageKeys.SEARCH_FIXER_FEATURES, StorageKeys.SEARCH_FIXER_ENABLED])
    .catch(() => ({}));
  const existingFeatures =
    legacy?.[StorageKeys.SEARCH_FIXER_FEATURES] && typeof legacy[StorageKeys.SEARCH_FIXER_FEATURES] === "object"
      ? legacy[StorageKeys.SEARCH_FIXER_FEATURES]
      : {};
  const legacyShortsActive =
    legacy?.ytShortsRemovalEnabled === true || existingFeatures.removeShorts === true;
  if (legacyShortsActive) {
    const mergedFeatures = SearchFixer.mergeFeatures(existingFeatures);
    // 5 機能とも storage 生値で未設定なら true に転写。明示 false は尊重。
    if (existingFeatures.removeShortsShelf === undefined) mergedFeatures.removeShortsShelf = true;
    if (existingFeatures.removeShortsChip === undefined) mergedFeatures.removeShortsChip = true;
    if (existingFeatures.removeShortsSidebar === undefined) mergedFeatures.removeShortsSidebar = true;
    if (existingFeatures.redirectShortsUrl === undefined) mergedFeatures.redirectShortsUrl = true;
    if (existingFeatures.shortsBtn === undefined) mergedFeatures.shortsBtn = true;
    // 旧キー removeShorts は新構造に存在しないため mergeFeatures の戻り値には含まれず自動消滅する。
    const migrate = {
      [StorageKeys.SEARCH_FIXER_FEATURES]: mergedFeatures,
    };
    // 旧 ytShortsRemovalEnabled === true の人は YouTube クリーナーマスターも ON にしないと
    // サブ機能が動かない（master 必須）。マイグレーションでは「動作継続」を最優先で master ON。
    if (legacy?.ytShortsRemovalEnabled === true) {
      migrate[StorageKeys.SEARCH_FIXER_ENABLED] = true;
    }
    await chrome.storage.local.set(migrate).catch(() => {});
  }

  // 廃止キーの削除（v1.0.x 系 + v1.0.17 + v1.0.18 で統合した ytShortsRemovalEnabled）
  // v1.0.x: タブを 4 つに増やしてアコーディオンを廃止したので、開閉状態キーも撤去
  // v1.0.x: 動画フィルタの「適用範囲」セレクタを廃止し常時 feed 動作に固定したので searchFixerScope も撤去
  await chrome.storage.local
    .remove([
      "copyPasteSettings",
      "enabled",
      "contextMenuAllowDomains",
      "ytShortsRemovalEnabled",
      "popupCleanerAccordionOpen",
      "popupIgCleanerAccordionOpen",
      "searchFixerScope",
    ])
    .catch(() => {});

  // POPUP_LAST_TAB の値マイグレーション: 旧 "assist" → 新 "tune"。
  // 4 タブ化（調整 / YouTube / Instagram / カラーピッカー）で識別子を変更したため、
  // 既存ユーザーの最後に開いていたタブが「不明値」扱いで TUNE に落ちないよう明示的に変換。
  const lastTab = (await chrome.storage.local.get(StorageKeys.POPUP_LAST_TAB))[StorageKeys.POPUP_LAST_TAB];
  if (lastTab === "assist") {
    await chrome.storage.local
      .set({ [StorageKeys.POPUP_LAST_TAB]: PopupTabs.TUNE })
      .catch(() => {});
  }

  const stored = await chrome.storage.local.get([
    StorageKeys.KEEP_ALIVE_ENABLED,
    StorageKeys.KEEP_ALIVE_INTERVAL_MS,
    StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED,
    StorageKeys.KEEP_ALIVE_ORIGINS,
    StorageKeys.SEARCH_FIXER_ENABLED,
    StorageKeys.SEARCH_FIXER_FEATURES,
    StorageKeys.SEARCH_FIXER_GRID_ITEMS,
    StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED,
    StorageKeys.INSTAGRAM_CLEANER_ENABLED,
    StorageKeys.INSTAGRAM_CLEANER_FEATURES,
    StorageKeys.TIKTOK_CLEANER_ENABLED,
    StorageKeys.TIKTOK_CLEANER_FEATURES,
    StorageKeys.VOLUME_BOOSTER_ENABLED,
    StorageKeys.VOLUME_BOOSTER_LAST_GAIN,
    StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
    StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED,
    StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED,
    StorageKeys.VIDEO_GAMMA_ENABLED,
    StorageKeys.VIDEO_GAMMA_VALUE,
    StorageKeys.COLOR_PICKER_HISTORY,
    StorageKeys.COLOR_PICKER_DEFAULT_FORMAT,
    StorageKeys.COLOR_PICKER_HEX_HASH,
    StorageKeys.POPUP_LAST_TAB,
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
  if (!(StorageKeys.KEEP_ALIVE_ORIGINS in stored)) {
    defaults[StorageKeys.KEEP_ALIVE_ORIGINS] = [];
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
  if (!(StorageKeys.TIKTOK_CLEANER_ENABLED in stored)) {
    defaults[StorageKeys.TIKTOK_CLEANER_ENABLED] = false;
  }
  if (!(StorageKeys.TIKTOK_CLEANER_FEATURES in stored)) {
    defaults[StorageKeys.TIKTOK_CLEANER_FEATURES] = TikTokCleaner.mergeFeatures({});
  }
  if (!(StorageKeys.VOLUME_BOOSTER_ENABLED in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_ENABLED] = false;
  }
  if (!(StorageKeys.VOLUME_BOOSTER_LAST_GAIN in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_LAST_GAIN] = VolumeBooster.DEFAULT;
  }
  if (!(StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED] = false;
  }
  if (!(StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED] = false;
  }
  if (!(StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED] = false;
  }
  // 動画ガンマ補正: master OFF / 値 1.0 で初期化（インストール直後は完全に無処理）
  if (!(StorageKeys.VIDEO_GAMMA_ENABLED in stored)) {
    defaults[StorageKeys.VIDEO_GAMMA_ENABLED] = false;
  }
  if (!(StorageKeys.VIDEO_GAMMA_VALUE in stored)) {
    defaults[StorageKeys.VIDEO_GAMMA_VALUE] = VideoGamma.DEFAULT;
  }
  // 顔料アトリエ（カラーピッカー）の新規キー: 履歴は空配列、既定形式は HEX、
  // 最終タブは「アシスト」で初期化。後追いキーが undefined のまま UI に出ないよう
  // 明示的に書き込む（CLAUDE.md の onInstalled 初期化方針）。
  if (!(StorageKeys.COLOR_PICKER_HISTORY in stored)) {
    defaults[StorageKeys.COLOR_PICKER_HISTORY] = [];
  }
  if (!(StorageKeys.COLOR_PICKER_DEFAULT_FORMAT in stored)) {
    defaults[StorageKeys.COLOR_PICKER_DEFAULT_FORMAT] = ColorPicker.DEFAULT_FORMAT;
  }
  if (!(StorageKeys.COLOR_PICKER_HEX_HASH in stored)) {
    defaults[StorageKeys.COLOR_PICKER_HEX_HASH] = true;
  }
  if (!(StorageKeys.POPUP_LAST_TAB in stored)) {
    defaults[StorageKeys.POPUP_LAST_TAB] = PopupTabs.TUNE;
  }
  if (Object.keys(defaults).length > 0) {
    await chrome.storage.local.set(defaults);
  }

  // P0-#3 storage 破損検知: install / update のたびに sentinel を必ず書き込む。
  // popup 起動時にこのキーが消えていたら chrome.storage.local がリセット・破損した可能性として
  // 開発者コンソールに警告（外部送信ゼロ方針なので telemetry は出さない）。
  await chrome.storage.local
    .set({ [StorageKeys.INSTALL_SENTINEL]: 1 })
    .catch(() => {});
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
    setVolumeBoosterGain(
      request.data?.tabId,
      request.data?.gain,
      request.data?.antiClip,
      request.data?.normalize,
      request.data?.nightMode
    )
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
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
  rememberRemovedVolumeBoosterTab(tabId);
  // P2-#19: タブが閉じられた時点でブースト中状態は確実に終了するため、ローカルキャッシュから即削除。
  // in-flight の set 処理が後から完了した場合も、removedVolumeBoosterTabIds で再登録を弾く。
  boostedTabIds.delete(tabId);
  chrome.runtime
    .sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_VOLUME_RELEASE_TAB,
      tabId,
    })
    .catch(() => {})
    .finally(() => scheduleOffscreenClose());
});

// ---------- 音量ブースター: マスター ON 時にタブ切替で自動適用 ----------
//
// `tabs.onActivated` はタブ切替のたびに発火するため、毎回 storage.get を 5 キー
// 発行すると IPC RTT がタブ切替遅延に響く。SW モジュールスコープで一度だけ取得して
// `chrome.storage.onChanged` で invalidate する方式にする (/rere C 2-A)。
// 注: SW 再起動でこの変数は消えるため、初回呼び出し時の null フォールバックは必須。
let cachedVolumeSettings = null;

chrome.tabs.onActivated.addListener(({ tabId }) => {
  autoApplyVolumeBooster(tabId).catch(() => {});
});

async function autoApplyVolumeBooster(tabId) {
  // getMediaStreamId は user gesture 必須なので、onActivated では新規 AudioContext を作れない。
  // 既に boost 中のタブに対して最新の保存設定を反映する用途に限定する。
  // 未 boost タブへの初回適用は popup 表示時の pushVolumeNow (user gesture あり) が担う。
  if (!boostedTabIds.has(tabId)) return;
  if (cachedVolumeSettings === null) {
    cachedVolumeSettings = await chrome.storage.local.get([
      StorageKeys.VOLUME_BOOSTER_ENABLED,
      StorageKeys.VOLUME_BOOSTER_LAST_GAIN,
      StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
      StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED,
      StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED,
    ]);
  }
  const stored = cachedVolumeSettings;
  if (stored[StorageKeys.VOLUME_BOOSTER_ENABLED] !== true) return;
  const gain = VolumeBooster.clampValue(stored[StorageKeys.VOLUME_BOOSTER_LAST_GAIN] ?? VolumeBooster.DEFAULT);
  const antiClip = stored[StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED] === true;
  const normalize = stored[StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED] === true;
  const nightMode = stored[StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED] === true;
  await setVolumeBoosterGain(tabId, gain, antiClip, normalize, nightMode);
}

// ---------- 音量ブースター: マスター OFF で全タブの AudioContext を解放 + 設定キャッシュ無効化 ----------
chrome.storage.onChanged.addListener((changes) => {
  // 5 キーいずれかが変化したら autoApplyVolumeBooster のキャッシュを invalidate
  if (
    StorageKeys.VOLUME_BOOSTER_ENABLED in changes ||
    StorageKeys.VOLUME_BOOSTER_LAST_GAIN in changes ||
    StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED in changes ||
    StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED in changes ||
    StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED in changes
  ) {
    cachedVolumeSettings = null;
  }
  if (
    StorageKeys.VOLUME_BOOSTER_ENABLED in changes &&
    changes[StorageKeys.VOLUME_BOOSTER_ENABLED].newValue === false
  ) {
    releaseAllVolumeBoosterTabs();
  }
});

async function releaseAllVolumeBoosterTabs() {
  const tabIds = [...boostedTabIds];
  if (tabIds.length > 0) {
    await Promise.all(tabIds.map((id) => releaseVolumeBoosterTab(id).catch(() => {})));
  } else if (offscreenState !== "CLOSED") {
    // SW 再起動後 boostedTabIds は空だが offscreen に残存 AudioContext があるかもしれない
    await chrome.runtime
      .sendMessage({ target: Offscreen.TARGET, action: Offscreen.ACTION_VOLUME_RELEASE_ALL })
      .catch(() => {});
    scheduleOffscreenClose();
  }
}

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
 *
 * **音量ブースターサブトグル (volumeBoosterAntiClipEnabled / Normalize / NightMode) は
 * APPLY_SETTINGS の対象外**: popup が VOLUME_BOOSTER_SET_GAIN メッセージで gain と一緒に
 * 渡してくるため、storage.set は popup 側で直接行う。content script への配信も不要なので
 * normalizeSettings / toStorageRecord には含めない。新しい音量関連 storage key を増やすときは
 * この方針を維持するか、APPLY_SETTINGS 経路に統合するかを先に判断すること。
 */
function normalizeSettings(settings) {
  return {
    keepAliveEnabled: settings?.keepAliveEnabled === true,
    keepAliveIntervalMs: KeepAlive.clampIntervalMs(settings?.keepAliveIntervalMs),
    keepAliveHttpPingEnabled: settings?.keepAliveHttpPingEnabled === true,
    keepAliveOrigins: KeepAlive.normalizeOrigins(settings?.keepAliveOrigins),
    searchFixerEnabled: settings?.searchFixerEnabled === true,
    searchFixerFeatures: SearchFixer.mergeFeatures(settings?.searchFixerFeatures),
    searchFixerGridItems: SearchFixer.clampGridItems(settings?.searchFixerGridItems),
    amazonDeliveryTotalEnabled: settings?.amazonDeliveryTotalEnabled === true,
    instagramCleanerEnabled: settings?.instagramCleanerEnabled === true,
    instagramCleanerFeatures: InstagramCleaner.mergeFeatures(settings?.instagramCleanerFeatures),
    tiktokCleanerEnabled: settings?.tiktokCleanerEnabled === true,
    tiktokCleanerFeatures: TikTokCleaner.mergeFeatures(settings?.tiktokCleanerFeatures),
    videoGammaEnabled: settings?.videoGammaEnabled === true,
    videoGammaValue: VideoGamma.clampValue(settings?.videoGammaValue),
  };
}

/** 正規化済み settings から chrome.storage.local.set 用のレコードを構築。 */
function toStorageRecord(s) {
  return {
    [StorageKeys.KEEP_ALIVE_ENABLED]: s.keepAliveEnabled,
    [StorageKeys.KEEP_ALIVE_INTERVAL_MS]: s.keepAliveIntervalMs,
    [StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED]: s.keepAliveHttpPingEnabled,
    [StorageKeys.KEEP_ALIVE_ORIGINS]: s.keepAliveOrigins,
    [StorageKeys.SEARCH_FIXER_ENABLED]: s.searchFixerEnabled,
    [StorageKeys.SEARCH_FIXER_FEATURES]: s.searchFixerFeatures,
    [StorageKeys.SEARCH_FIXER_GRID_ITEMS]: s.searchFixerGridItems,
    [StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED]: s.amazonDeliveryTotalEnabled,
    [StorageKeys.INSTAGRAM_CLEANER_ENABLED]: s.instagramCleanerEnabled,
    [StorageKeys.INSTAGRAM_CLEANER_FEATURES]: s.instagramCleanerFeatures,
    [StorageKeys.TIKTOK_CLEANER_ENABLED]: s.tiktokCleanerEnabled,
    [StorageKeys.TIKTOK_CLEANER_FEATURES]: s.tiktokCleanerFeatures,
    [StorageKeys.VIDEO_GAMMA_ENABLED]: s.videoGammaEnabled,
    [StorageKeys.VIDEO_GAMMA_VALUE]: s.videoGammaValue,
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
        keepAliveOrigins: s.keepAliveOrigins,
      },
    })
    .catch(() => {});

  // 動画ガンマ補正 content script も全 http(s) ページに注入済みなので常に通知。
  // all_frames: true 注入のため frameId を指定せず全フレームに broadcast する
  // （iframe 内 <video> も補正対象にするため、各フレームの content script 自身が反応する）。
  await chrome.tabs
    .sendMessage(tab.id, {
      action: Actions.APPLY_VIDEO_GAMMA_CS,
      data: {
        enabled: s.videoGammaEnabled,
        value: s.videoGammaValue,
      },
    })
    .catch(() => {});

  // A1-2 / #11 対策: youtube-shorts / search-fixer / amazon-delivery-total / instagram-cleaner は
  // いずれも `all_frames: false` で top frame にしか注入されない。それでも sendMessage に
  // frameId を指定しないと Chrome は全フレームへブロードキャストしてしまうため、`{ frameId: 0 }`
  // で top frame に明示的に絞ってメッセージング負荷を最小化する。
  // keepalive は `all_frames: true` で全フレームに注入されるため意図的に frameId 指定なし。
  const TOP_FRAME = { frameId: 0 };

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
      }, TOP_FRAME)
      .catch(() => {});
  }

  if (isAmazonAutoDeliveryUrl(url)) {
    await chrome.tabs
      .sendMessage(tab.id, {
        action: Actions.APPLY_AMAZON_DELIVERY_TOTAL_CS,
        data: { enabled: s.amazonDeliveryTotalEnabled },
      }, TOP_FRAME)
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
      }, TOP_FRAME)
      .catch(() => {});
  }

  if (isTikTokUrl(url)) {
    await chrome.tabs
      .sendMessage(tab.id, {
        action: Actions.APPLY_TIKTOK_CLEANER_CS,
        data: {
          enabled: s.tiktokCleanerEnabled,
          features: s.tiktokCleanerFeatures,
        },
      }, TOP_FRAME)
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

function isTikTokUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "tiktok.com" || h.endsWith(".tiktok.com");
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

// P2-#19: ブースト中タブの background 側ローカルキャッシュ。
// `setVolumeBoosterGain` が成功するたびに add、`releaseVolumeBoosterTab` 完了 / `chrome.tabs.onRemoved`
// で delete する。`isVolumeBoosterActive` はこの Set のサイズを優先確認することで、30 秒間隔の
// `scheduleOffscreenClose` cycle で発生していた sendMessage IPC RTT を排除する。
// SW 再起動直後は Set が空だが、その時点で `offscreenState === "OPEN"` なら従来通り offscreen に
// query してフォールバックする（hydrate）。
/** @type {Set<number>} */
const boostedTabIds = new Set();
/** @type {Set<number>} setVolumeBoosterGain の in-flight 完了より先に閉じられたタブ ID */
const removedVolumeBoosterTabIds = new Set();

function rememberRemovedVolumeBoosterTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  removedVolumeBoosterTabIds.add(tabId);
  setTimeout(() => {
    removedVolumeBoosterTabIds.delete(tabId);
  }, 5 * 60 * 1000);
}

async function markVolumeBoosterTabActive(tabId) {
  if (removedVolumeBoosterTabIds.has(tabId)) {
    await releaseVolumeBoosterTab(tabId).catch(() => {});
    return false;
  }
  boostedTabIds.add(tabId);
  return true;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return false;

  if (offscreenClosingPromise) {
    try { await offscreenClosingPromise; } catch {}
  }

  const url = chrome.runtime.getURL(Offscreen.PATH);

  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (contexts.length > 0) {
      offscreenState = "OPEN";
      return true;
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
  // EC-12 対策: createDocument 完了後も offscreenCreatingPromise を null に戻さず保持する。
  // 並行 caller 群が同じ Promise を共有して await することで、初回 caller の finally と
  // 後続 caller の `if (offscreenCreatingPromise)` チェックの間に発生する race window を
  // 完全に消す（B1-B1 修正）。Promise の null 化は (a) 失敗時即座に / (b) closeDocument の
  // finally で行い、「OPEN 状態のキャッシュされた成功 Promise」として再利用される。
  const localPromise = chrome.offscreen
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
      // 失敗時は即座に null 化して、次回 caller が新規 createDocument を発行できるように。
      if (offscreenCreatingPromise === localPromise) offscreenCreatingPromise = null;
      return false;
    });
  offscreenCreatingPromise = localPromise;
  return await localPromise;
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
    // P2-#12 TOCTOU 対策: `await isVolumeBoosterActive()` (sendMessage 往復で数十〜数百 ms かかる)
    // の最中に setVolumeBoosterGain → ensureOffscreenDocument が走り、新しい AudioContext が
    // 作られているかもしれない。offscreenState が OPEN 以外 (CREATING / CLOSING / CLOSED) に
    // 変化している場合は close を諦めて次サイクルに先送りし、確立直後の AudioContext を
    // 不意打ちで close しないようにする。
    if (offscreenState !== "OPEN") {
      if (offscreenState === "CLOSED") return;
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
        // close 完了で「キャッシュされた成功 Promise」を解放し、次回 ensureOffscreenDocument
        // が新規 createDocument を発行できるようにする（B1-B1 修正の対）。
        offscreenCreatingPromise = null;
      });
  }, Offscreen.IDLE_MS);
}

// B1-B5 対策: SW がスリープ → 再起動すると offscreenIdleTimer / offscreenCloseRescheduleCount
// などのモジュール変数がリセットされるため、offscreen document が残ったまま誰も close を
// スケジュールしない状態が起きうる（onRemoved や setVolumeBoosterGain が呼ばれるまで close
// しない）。SW 起動直後に「offscreen が残っていれば scheduleOffscreenClose を再発動」する。
//
// この処理は SW 再起動 / extension reload / Chrome 再起動の各経路で発火する。
// `chrome.runtime.getContexts` は Chrome 116+ なので minimum_chrome_version 140 では
// 直接呼んで良い（CLAUDE.md 規約）。
(async () => {
  try {
    const url = chrome.runtime.getURL(Offscreen.PATH);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (contexts.length > 0) {
      offscreenState = "OPEN";
      scheduleOffscreenClose();
    }
  } catch {
    // 起動直後の getContexts 失敗は無視。次に setVolumeBoosterGain 等が呼ばれた時点で
    // ensureOffscreenDocument が状態を再評価する。
  }
})();

async function isVolumeBoosterActive() {
  // 我々が把握する offscreen state が CLOSED なら、boost 中タブが残っている可能性はゼロ
  // （boost 中であれば必ず offscreen は OPEN）。query を発行せず即 false を返すことで、
  // 30 秒間隔の `scheduleOffscreenClose()` 再 schedule cycle を確実に止める。
  if (offscreenState === "CLOSED") return false;

  // P2-#19: background 側ローカルキャッシュが「ブースト中タブあり」と知っているなら IPC ゼロで返答。
  // 30 秒間隔の close cycle で sendMessage RTT を継続消費していた問題を解消する。
  if (boostedTabIds.size > 0) return true;

  // 2-C3 最適化: offscreenState === "OPEN" の場合は getContexts をスキップして
  // sendMessage 直行で 1 往復削減。実際に offscreen が消えていた場合は sendMessage が
  // 失敗 → catch で safe-side の active 扱いになり、次サイクルで自然修復される。
  // CREATING / CLOSING の中間状態のみ getContexts で実存を確認する。
  // SW 再起動直後で boostedTabIds が空でも、offscreen に audioStates が残っている可能性が
  // あるため、ここから先のフォールバック query で hydrate される。
  if (offscreenState !== "OPEN") {
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
  }
  try {
    const res = await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_VOLUME_QUERY_ACTIVE,
    });
    return Number(res?.activeCount ?? 0) > 0;
  } catch {
    // 通信失敗時は safe side で active 扱い（offscreen 健在だが SW 再起動直後など）。
    // false を返すとブースト中タブが残っているのに offscreen を close してしまうリスクあり。
    return true;
  }
}

// ---------- 音量ブースター ヘルパー ----------

/**
 * 指定タブの音量を設定する。スライダー値が UNITY (100) のときは AudioContext を解放するだけで
 * 新規 tabCapture は呼ばない（リソース節約 + chrome:// 等での無駄なエラー回避）。
 *
 * `antiClip` / `normalize` は popup から渡される DynamicsCompressor 機能フラグで、
 * offscreen 側で各 compressor のパラメータを切り替える。両 OFF 時もチェーンには残し
 * ratio:1 のバイパス設定にするため、トグル切替時に音切れは発生しない。
 */
async function setVolumeBoosterGain(tabId, gain, antiClip, normalize, nightMode) {
  // P2-#13: tabId は popup origin（SenderCheck.isFromPopup で検証済み）から渡されるが、
  // popup の中では `getActiveHttpTab()` 経由で active tab の id を入れて送ってくる。
  // popup CSP (`script-src 'self'`) で外部スクリプトが popup 内で動くことは事実上不可能なため、
  // popup が悪意ある tabId を送る経路は現状塞がれている。Number.isInteger + 正数の型検証だけで
  // 十分な信頼境界。将来 popup CSP が緩む / popup XSS が成立する場合は、
  // chrome.tabs.get(tabId) で url が http(s) に限定されているかを追加検証する案を検討する。
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, error: "invalid-tab-id" };
  }
  const clamped = VolumeBooster.clampValue(gain);
  const antiClipFlag = antiClip === true;
  const normalizeFlag = normalize === true;
  const nightModeFlag = nightMode === true;

  // スライダーが等倍位置 (100%) かつ全サブトグル OFF のときだけ release → リソース返却。
  // 100% でも自動歪み防止 / 自動音量正規化のいずれかが ON なら compressor を効かせる必要があるため
  // AudioContext を維持して通常経路に進む（gain は 1.0x にランプ、compressor は preset 通り適用）。
  if (clamped === VolumeBooster.UNITY && !antiClipFlag && !normalizeFlag && !nightModeFlag) {
    await releaseVolumeBoosterTab(tabId).catch(() => {});
    return { ok: true, gain: VolumeBooster.UNITY };
  }

  const ready = await ensureOffscreenDocument();
  if (!ready) return { ok: false, error: "offscreen-unavailable" };

  // 既存 AudioContext があれば streamId は不要（getMediaStreamId をスキップ）。
  // ensureOffscreenDocument が ready=true を返したので offscreen の存在は確定している。
  // getContexts 重複呼び出しを避けるため Direct 版を使う (2-C1 修正)。
  const existing = await getVolumeBoosterGainDirect(tabId);
  if (Number.isFinite(existing?.gain)) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        target: Offscreen.TARGET,
        action: Offscreen.ACTION_VOLUME_SET_GAIN,
        tabId,
        streamId: null,
        gain: clamped,
        antiClip: antiClipFlag,
        normalize: normalizeFlag,
        nightMode: nightModeFlag,
      });
    } catch (err) {
      // 例外: offscreen がリスタート途中など → fresh 取得経路へフォールスルー。
      // silent failure を防ぐため診断ログを残す（実害は fresh 経路で自己修復されるため軽微）。
      console.warn("[WebViewingAssist] existing-path sendMessage failed, falling through:", err);
    }
    // EC-2 対策: getVolumeBoosterGain で「state あり」と判定後に audioStates が削除される
    // race（onRemoved や release 経路と同時操作）に対して、offscreen が
    // `invalid-stream-id` を返した場合は fresh 取得経路に自動フォールスルーして自己修復する。
    // P2-#11: scheduleOffscreenClose は呼出側で 1 回だけ。fresh 取得経路にフォールスルーすると
    // 末尾 finally で呼ばれるので、ここでは早期 return パスでのみ明示的に呼ぶ。
    if (res?.ok) {
      // P2-#19: 成功確認後にローカルキャッシュへ追加（既存 state 経路ではすでに add 済みかもしれないが冪等）。
      await markVolumeBoosterTabActive(tabId);
      scheduleOffscreenClose();
      return res;
    }
    if (res && res.error !== "invalid-stream-id") {
      scheduleOffscreenClose();
      return res;
    }
    // res が undefined or invalid-stream-id → fresh 取得経路へ（末尾 finally で 1 回 schedule）
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
      antiClip: antiClipFlag,
      normalize: normalizeFlag,
      nightMode: nightModeFlag,
    });
    // P2-#19: 成功時のみローカルキャッシュに登録。失敗（offscreen エラー / no-response）の場合は
    // ブースト中状態にならないため Set には追加しない。
    if (res?.ok) await markVolumeBoosterTabActive(tabId);
    return res ?? { ok: false, error: "no-response" };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    scheduleOffscreenClose();
  }
}

/**
 * getContexts なしで offscreen に直接 GET_GAIN を送る軽量バージョン (2-C1 修正)。
 * `ensureOffscreenDocument` が直前で ready=true を返した呼び出し経路では offscreen の
 * 存在は確定しているため、`getContexts` 1 往復を省略して RTT を約 50% 削減できる。
 */
async function getVolumeBoosterGainDirect(tabId) {
  if (typeof tabId !== "number") return { gain: null };
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
 * 最適化として `chrome.runtime.getContexts` で「offscreen 不在なら早期 return」を行い
 * 無駄な sendMessage を抑制する。getContexts 自体が一時失敗した場合は release を
 * 諦めず sendMessage に fall-through し、受信側不在なら catch で握りつぶす。
 */
async function releaseVolumeBoosterTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return { ok: true };
  // P2-#19: release 経路に入った時点でローカルキャッシュからは確実に外す。offscreen 側の
  // sendMessage が失敗しても次回 setVolumeBoosterGain で正常に再 add されるため、楽観削除で OK。
  boostedTabIds.delete(tabId);
  try {
    const url = chrome.runtime.getURL(Offscreen.PATH);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    // offscreen 不在が確定したときのみ早期 return（release 不要）。
    if (contexts.length === 0) return { ok: true };
  } catch {
    // getContexts 自体の一時失敗では release を諦めない。下の sendMessage に fall-through。
    // 受信側不在なら finally の握りつぶしで安全に終わる。
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
