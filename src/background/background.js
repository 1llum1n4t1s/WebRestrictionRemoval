// Chrome service worker は importScripts で actions.js をロードする。
// Firefox MV3 (event page) では importScripts は worker 限定 API のため呼べないが、
// manifest.firefox.json の background.scripts に actions.js を併記してあり、
// background.js 実行時には既に評価済みなのでここでは skip する。
if (typeof importScripts === "function") {
  importScripts("/src/lib/actions.js");
}

// 音量ブースターの tabCapture → offscreen 経路は offscreen + tabCapture API に依存する
// (Firefox MV3 未対応)。このフラグで「Chrome ベースで動いてるか」を判定し、Firefox 環境では
// background の音量関連処理を全て skip する。Firefox では代わりに MES 経路
// (manifest.firefox.json 専用の volume-booster-mes.js) が popup → storage 直書きを
// storage.onChanged で購読して自動適用するため、background は音量ブースターに一切関与しない。
const HAS_VOLUME_BOOSTER = typeof chrome.offscreen !== "undefined" && typeof chrome.tabCapture !== "undefined";

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
    // 旧 ytShortsRemovalEnabled === true の人は YouTube 機能拡張マスターも ON にしないと
    // サブ機能が動かない（master 必須）。マイグレーションでは「動作継続」を最優先で master ON。
    if (legacy?.ytShortsRemovalEnabled === true) {
      migrate[StorageKeys.SEARCH_FIXER_ENABLED] = true;
    }
    await chrome.storage.local.set(migrate).catch(() => {});
  }

  // 旧 removeTopicsSection / removeBreakingNewsSection サブ機能を removeFeedSections に統合。
  // どちらかが true だったユーザーは新キーへ ON を転写する（新キーが storage 生値で明示設定済みなら尊重）。
  // 旧キー自体は新 FEATURES に存在しないため mergeFeatures の戻り値には含まれず自動消滅する。
  //
  // 重要 (Codex P2): 判定は必ず「最初の get の生値 existingFeatures」を基準にする。上の Shorts
  // migration が走った場合、mergeFeatures 済みの書き込みで旧セクションキーは既に strip され、
  // removeFeedSections も default false で seed されているため、書き込み後の再取得値で判定すると
  // (1) hasLegacySectionKeys が常に false になり転写が走らない
  // (2) seed された false を「ユーザー明示 false」と誤認する
  // の 2 重の罠がある（Shorts migration 冒頭コメントと同じ existingFeatures 基準の原則）。
  {
    const hasLegacySectionKeys =
      existingFeatures.removeTopicsSection !== undefined ||
      existingFeatures.removeBreakingNewsSection !== undefined;
    if (hasLegacySectionKeys) {
      // 書き込み base は Shorts migration の反映後を尊重したいので storage を再取得する
      // （取得失敗・欠落時は existingFeatures にフォールバック）。
      const cur = await chrome.storage.local.get(StorageKeys.SEARCH_FIXER_FEATURES).catch(() => ({}));
      const curFeatures = cur?.[StorageKeys.SEARCH_FIXER_FEATURES];
      const mergedFeatures = SearchFixer.mergeFeatures(
        curFeatures && typeof curFeatures === "object" ? curFeatures : existingFeatures
      );
      const legacySectionActive =
        existingFeatures.removeTopicsSection === true ||
        existingFeatures.removeBreakingNewsSection === true;
      if (legacySectionActive && existingFeatures.removeFeedSections === undefined) {
        mergedFeatures.removeFeedSections = true;
      }
      await chrome.storage.local
        .set({ [StorageKeys.SEARCH_FIXER_FEATURES]: mergedFeatures })
        .catch(() => {});
    }
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

  // セッション維持機能の撤去に伴い旧キー (keepAliveOrigins / keepAliveEnabled /
  // keepAliveIntervalMs / keepAliveHttpPingEnabled)、RTX 動画強化の rtxEnhancerEnabled、
  // 自動音量正規化サブ機能の volumeBoosterNormalizeEnabled を一括削除する
  // (自動音量正規化は現実的でないため撤去、CLAUDE.md「撤去済み機能と教訓」参照)。
  await chrome.storage.local
    .remove([
      "keepAliveOrigins",
      "keepAliveEnabled",
      "keepAliveIntervalMs",
      "keepAliveHttpPingEnabled",
      "rtxEnhancerEnabled",
      "volumeBoosterNormalizeEnabled",
    ])
    .catch(() => {});

  const stored = await chrome.storage.local.get([
    StorageKeys.SEARCH_FIXER_ENABLED,
    StorageKeys.SEARCH_FIXER_FEATURES,
    StorageKeys.SEARCH_FIXER_GRID_ITEMS,
    StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS,
    StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED,
    StorageKeys.AMAZON_RANKING_JUMP_ENABLED,
    StorageKeys.AMAZON_MERCHANT_INFO_ENABLED,
    StorageKeys.INSTAGRAM_CLEANER_ENABLED,
    StorageKeys.INSTAGRAM_CLEANER_FEATURES,
    StorageKeys.TIKTOK_CLEANER_ENABLED,
    StorageKeys.TIKTOK_CLEANER_FEATURES,
    StorageKeys.X_CLEANER_ENABLED,
    StorageKeys.X_CLEANER_FEATURES,
    StorageKeys.VOLUME_BOOSTER_ENABLED,
    StorageKeys.VOLUME_BOOSTER_LAST_GAIN,
    StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
    StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED,
    StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED,
    StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED,
    StorageKeys.VOLUME_BOOSTER_EQ_ENABLED,
    StorageKeys.VOLUME_BOOSTER_EQ_GAINS,
    StorageKeys.VOLUME_BOOSTER_EQ_PREAMP,
    StorageKeys.VOLUME_BOOSTER_EQ_PRESET,
    StorageKeys.VIDEO_GAMMA_ENABLED,
    StorageKeys.VIDEO_GAMMA_VALUE,
    StorageKeys.VIDEO_FILL_ENABLED,
    StorageKeys.VIDEO_FILL_MODE,
    StorageKeys.VIDEO_FILL_TARGET,
    StorageKeys.LOUPE_ENABLED,
    StorageKeys.LOUPE_ZOOM,
    StorageKeys.LOUPE_SIZE,
    StorageKeys.COLOR_PICKER_HISTORY,
    StorageKeys.COLOR_PICKER_DEFAULT_FORMAT,
    StorageKeys.COLOR_PICKER_HEX_HASH,
    StorageKeys.POPUP_LAST_TAB,
    StorageKeys.POPUP_LAST_SUBTAB,
  ]);
  const defaults = {};
  if (!(StorageKeys.SEARCH_FIXER_ENABLED in stored)) {
    defaults[StorageKeys.SEARCH_FIXER_ENABLED] = false;
  }
  if (!(StorageKeys.SEARCH_FIXER_FEATURES in stored)) {
    defaults[StorageKeys.SEARCH_FIXER_FEATURES] = SearchFixer.mergeFeatures({});
  }
  if (!(StorageKeys.SEARCH_FIXER_GRID_ITEMS in stored)) {
    defaults[StorageKeys.SEARCH_FIXER_GRID_ITEMS] = 0;
  }
  if (!(StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS in stored)) {
    defaults[StorageKeys.SEARCH_FIXER_BLOCKED_CHANNELS] = [];
  }
  if (!(StorageKeys.NOTEBOOK_LM_ACCOUNT_INDEX in stored)) {
    // NotebookLM 送信の送信先 Google アカウント（0 = 既定アカウント / rere D-5）
    defaults[StorageKeys.NOTEBOOK_LM_ACCOUNT_INDEX] = 0;
  }
  if (!(StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED in stored)) {
    defaults[StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED] = false;
  }
  if (!(StorageKeys.AMAZON_RANKING_JUMP_ENABLED in stored)) {
    defaults[StorageKeys.AMAZON_RANKING_JUMP_ENABLED] = false;
  }
  if (!(StorageKeys.AMAZON_MERCHANT_INFO_ENABLED in stored)) {
    defaults[StorageKeys.AMAZON_MERCHANT_INFO_ENABLED] = false;
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
  if (!(StorageKeys.X_CLEANER_ENABLED in stored)) {
    defaults[StorageKeys.X_CLEANER_ENABLED] = false;
  }
  if (!(StorageKeys.X_CLEANER_FEATURES in stored)) {
    defaults[StorageKeys.X_CLEANER_FEATURES] = XCleaner.mergeFeatures({});
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
  if (!(StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED] = false;
  }
  if (!(StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED] = false;
  }
  if (!(StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED] = false;
  }
  // イコライザ: OFF / 全バンド 0dB / プリアンプ 0dB / プリセット flat で初期化（OFF なので素通り）
  if (!(StorageKeys.VOLUME_BOOSTER_EQ_ENABLED in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_EQ_ENABLED] = false;
  }
  if (!(StorageKeys.VOLUME_BOOSTER_EQ_GAINS in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_EQ_GAINS] = VolumeBooster.clampEqGains([]);
  }
  if (!(StorageKeys.VOLUME_BOOSTER_EQ_PREAMP in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_EQ_PREAMP] = VolumeBooster.EQ_PREAMP_DEFAULT;
  }
  if (!(StorageKeys.VOLUME_BOOSTER_EQ_PRESET in stored)) {
    defaults[StorageKeys.VOLUME_BOOSTER_EQ_PRESET] = VolumeBooster.EQ_PRESET_DEFAULT;
  }
  // 動画ガンマ補正: master OFF / 値 1.0 で初期化（インストール直後は完全に無処理）
  if (!(StorageKeys.VIDEO_GAMMA_ENABLED in stored)) {
    defaults[StorageKeys.VIDEO_GAMMA_ENABLED] = false;
  }
  if (!(StorageKeys.VIDEO_GAMMA_VALUE in stored)) {
    defaults[StorageKeys.VIDEO_GAMMA_VALUE] = VideoGamma.DEFAULT;
  }
  // 動画黒帯除去: master OFF / モード zoom / ターゲット DEFAULT_TARGET で初期化（インストール直後は完全に無処理）
  if (!(StorageKeys.VIDEO_FILL_ENABLED in stored)) {
    defaults[StorageKeys.VIDEO_FILL_ENABLED] = false;
  }
  if (!(StorageKeys.VIDEO_FILL_MODE in stored)) {
    defaults[StorageKeys.VIDEO_FILL_MODE] = VideoFill.DEFAULT_MODE;
  }
  if (!(StorageKeys.VIDEO_FILL_TARGET in stored)) {
    defaults[StorageKeys.VIDEO_FILL_TARGET] = VideoFill.DEFAULT_TARGET;
  }
  // ルーペ: master OFF / 倍率 DEFAULT_ZOOM (2.5) / サイズ SIZE_DEFAULT (220) で初期化。
  // インストール直後は完全に無処理（content script ロードはされるが activate しない）。
  if (!(StorageKeys.LOUPE_ENABLED in stored)) {
    defaults[StorageKeys.LOUPE_ENABLED] = false;
  }
  // 接続モニターは searchFixerFeatures.connectionMonitor サブ機能に統合済み。SearchFixer.mergeFeatures が
  // 未設定キーを false に埋めるため、独立した onInstalled 初期化は不要（master searchFixerEnabled も既定 OFF）。
  if (!(StorageKeys.LOUPE_ZOOM in stored)) {
    defaults[StorageKeys.LOUPE_ZOOM] = Loupe.DEFAULT_ZOOM;
  }
  if (!(StorageKeys.LOUPE_SIZE in stored)) {
    defaults[StorageKeys.LOUPE_SIZE] = Loupe.SIZE_DEFAULT;
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
  if (!(StorageKeys.POPUP_LAST_SUBTAB in stored)) {
    // 空レコード = 各タブとも先頭サブタブから開始（popup 側が実在判定でフォールバックする）
    defaults[StorageKeys.POPUP_LAST_SUBTAB] = {};
  }
  if (Object.keys(defaults).length > 0) {
    // defaults 書き込みが reject しても直後の INSTALL_SENTINEL 書き込み（破損検知の要）に
    // 必ず到達させるため個別に catch する。sentinel 機構が自身の前提（defaults 成功）に
    // 依存して機能停止するのを防ぐ。失敗理由は [WebViewingAssist] prefix で可視化。
    await chrome.storage.local.set(defaults).catch((err) => {
      console.warn("[WebViewingAssist] onInstalled defaults write failed:", err);
    });
  }

  // P0-#3 storage 破損検知: install / update のたびに sentinel を必ず書き込む。
  // popup 起動時にこのキーが消えていたら chrome.storage.local がリセット・破損した可能性として
  // 開発者コンソールに警告（外部送信ゼロ方針なので telemetry は出さない）。
  await chrome.storage.local
    .set({ [StorageKeys.INSTALL_SENTINEL]: 1 })
    .catch(() => {});
});

// ---------- メッセージハンドラ ----------
// /rere B1-001 修正: 旧実装は sender 検証 fail 時 `return;` (= undefined) で sendResponse channel を
// 即廃棄していたため、popup 側で `await chrome.runtime.sendMessage` が **undefined で resolve** し、
// `res?.ok` が falsy → applyError 誤発火という silent failure を起こしていた。
// `sendResponse({ ok: false, error: "sender-rejected" }); return false;` に変更することで、
// (1) popup 側に明示的な拒否理由が届く、(2) Chrome MV3 仕様上の sendResponse channel が
// 同期的にクローズされる (return false = 同期応答完了)、の両立を実現する。
// 未知 action 経路も最末尾で `return false;` を明示し、将来の handler 追加で `return true` 漏れの
// 罠を物理的に避ける (現状の implicit `undefined` 返しでは同じ silent failure リスクが残る)。
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === Actions.APPLY_SETTINGS) {
    if (!SenderCheck.isFromPopup(sender)) {
      sendResponse({ ok: false, error: "sender-rejected" });
      return false;
    }
    handleApplySettings(request.data)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        // storage.set の quota 超過 / notifyContentScripts 失敗等をここで可視化する。
        // 同ファイル他経路 (createAudioState / ensureOffscreenDocument 等) の
        // [WebViewingAssist] prefix console.warn パターンに揃え、ユーザー報告時の切り分け材料を残す。
        console.warn("[WebViewingAssist] handleApplySettings failed:", err);
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      });
    return true;
  } else if (request.action === Actions.VOLUME_BOOSTER_SET_GAIN) {
    // popup が user gesture を持つので、popup → background → tabCapture の連鎖で getMediaStreamId が動く。
    if (!SenderCheck.isFromPopup(sender)) {
      sendResponse({ ok: false, error: "sender-rejected" });
      return false;
    }
    if (!HAS_VOLUME_BOOSTER) {
      // Firefox 版の popup は MES 経路 (storage 直書きのみ) で本メッセージを送らないため、
      // ここに到達するのは想定外だが、防御深層として明示的に reject する
      // (例外を吐かず popup の error 表示で安全に終わる)。
      sendResponse({ ok: false, error: "volume-booster-unavailable" });
      return true;
    }
    setVolumeBoosterGain(
      request.data?.tabId,
      request.data?.gain,
      request.data?.antiClip,
      request.data?.nightMode,
      request.data?.bassCut,
      request.data?.muted,
      request.data?.eqEnabled,
      request.data?.eqGains,
      request.data?.eqPreamp
    )
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  } else if (request.action === Actions.VOLUME_BOOSTER_RELEASE_TAB) {
    if (!SenderCheck.isFromPopup(sender)) {
      sendResponse({ ok: false, error: "sender-rejected" });
      return false;
    }
    if (!HAS_VOLUME_BOOSTER) {
      sendResponse({ ok: false, error: "volume-booster-unavailable" });
      return true;
    }
    releaseVolumeBoosterTab(request.data?.tabId)
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ ok: false }));
    return true;
  } else if (request.action === Actions.LOUPE_REQUEST_CAPTURE) {
    // ルーペ content script からの captureVisibleTab 要求。
    // sender 検証: content script 由来のみ受け付け（popup からは来ない設計）。
    if (!SenderCheck.isFromContentScript(sender)) {
      sendResponse({ ok: false, error: "sender-rejected" });
      return false;
    }
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) {
      sendResponse({ ok: false, error: "invalid-tab-id" });
      return true;
    }
    // タブ一致確認 (/rere レビュー A1-I1 防御): `chrome.tabs.captureVisibleTab(windowId, ...)` は
    // 指定ウィンドウの **現在アクティブなタブ** のスクリーンショットを撮る。loupe.js の
    // visibilitychange cleanup が将来何らかの理由で失敗した場合、バックグラウンドタブの
    // content script が別タブ (アクティブ) のピクセルを取得できる理論的経路がある。
    // sender.tab.id が windowId のアクティブタブと一致することを assert してから撮影する。
    // /rere レビュー B2-021 修正: sendResponse の二重呼出を防ぎつつ、すべての完了経路で
    // 必ず 1 回 sendResponse が呼ばれることを保証する。captureVisibleTab が null/undefined
    // を resolve する Chrome 側の境界条件 (bug 報告複数あり) で content script が hang
    // する経路を塞ぐ。
    let responded = false;
    const safeRespond = (msg) => {
      if (responded) return;
      responded = true;
      sendResponse(msg);
    };
    chrome.tabs
      .query({ active: true, windowId })
      .then((tabs) => {
        const activeTabId = tabs[0]?.id;
        if (activeTabId !== tabId) {
          safeRespond({ ok: false, error: "tab-not-active" });
          return null;
        }
        // captureVisibleTab は背景 SW から activeTab 権限で動作する。
        // JPEG quality:70 で payload を約 300-600KB に抑え、PNG (数 MB) より高速転送。
        // 500ms debounce が content 側にあるため Chrome 公式 2fps quota 内に収まる。
        return chrome.tabs.captureVisibleTab(windowId, {
          format: "jpeg",
          quality: Loupe.CAPTURE_QUALITY,
        });
      })
      .then((dataUrl) => {
        if (dataUrl != null) {
          safeRespond({ ok: true, dataUrl });
        } else {
          // Chrome API 仕様上ここに来るのは前段の `return null` (tab-not-active) のみで、
          // その場合は既に safeRespond 済みなので no-op。captureVisibleTab が稀に
          // null/undefined を resolve した場合のみここで初めて応答する。
          safeRespond({ ok: false, error: "no-capture" });
        }
      })
      .catch((err) => safeRespond({ ok: false, error: String(err?.message ?? err) }));
    return true;
  } else if (request.action === Actions.NOTEBOOK_LM_LIST) {
    // NotebookLM のノートブック一覧。YouTube タブの content script 由来のみ受け付ける。
    if (!isFromYouTubeContentScript(sender)) {
      sendResponse({ ok: false, error: "sender-rejected" });
      return false;
    }
    listNotebookLmNotebooks(request.data?.accountIndex)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  } else if (request.action === Actions.NOTEBOOK_LM_SEND) {
    // NotebookLM へのソース追加。YouTube タブの content script 由来のみ受け付ける。
    if (!isFromYouTubeContentScript(sender)) {
      sendResponse({ ok: false, error: "sender-rejected" });
      return false;
    }
    sendToNotebookLm(request.data)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  } else if (request.action === Actions.NOTEBOOK_LM_ACCOUNTS) {
    // ログイン中の Google アカウント一覧。YouTube タブの content script 由来のみ受け付ける。
    if (!isFromYouTubeContentScript(sender)) {
      sendResponse({ ok: false, error: "sender-rejected" });
      return false;
    }
    listNotebookLmAccounts()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }
  // /rere B1-001 修正: 未知 action は明示的に return false で channel をクローズ。
  // implicit undefined 返しだと将来の handler 追加時に sendResponse 漏れの罠を踏みやすい。
  return false;
});

// ---------- NotebookLM 送信 (YouTube 機能拡張のサブ機能 notebookLmSend) ----------
//
// NotebookLM には公開 API が無いため、Web アプリ自身が使う batchexecute RPC を叩く。
// content script (youtube.com) から直接呼ぶと cross-origin になるので、host_permissions を
// 持つ background で実行する（`<all_urls>` 既存のため権限追加は不要）。
//
// 認証はユーザーのブラウザにある Google セッション Cookie に依存する（`credentials: "include"`）。
// 拡張機能は資格情報を読み取らず保存もしない。送るのはユーザーがボタンを押した瞬間の
// YouTube URL のみで、バックグラウンドでの送信や視聴履歴の収集は行わない。
//
// 壊れたときの見立て: RPC ID (actions.js の NotebookLm.RPC_*) は Google の非公開契約であり
// 予告なく変わる。401/403 ではなく「応答は 200 なのに ID が取れない」形で壊れることが多い。

/**
 * NotebookLM トップページから build label (`bl`) と XSRF トークン (`at`) を取得する。
 *
 * 失敗理由を戻り値で区別する（/rere RC-J）。旧実装は「未ログイン」と「Google が HTML の
 * トークンキーを変えた」を同じ null に潰していたため、ログイン済みのユーザーに
 * 「ログインしてください」と表示して原因を誤誘導していた。
 *
 * @returns {Promise<{ok: true, bl: string, at: string} | {ok: false, error: string}>}
 */
async function fetchNotebookLmTokens(accountIndex) {
  let res;
  try {
    // redirect:"manual" は CLAUDE.md §外部 fetch allowlist 設計の共通必須要件（/rere RC-F）。
    // 未ログイン時の accounts.google.com へのリダイレクトは opaqueredirect（res.ok === false）
    // になり not-authorized に落ちるため、認証検出の要件は満たせる。
    res = await fetch(NotebookLm.buildHomeUrl(accountIndex), {
      credentials: "include",
      redirect: "manual",
      signal: AbortSignal.timeout(NotebookLm.FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    logNotebookLm("token fetch failed", err);
    return { ok: false, error: "network-failed" };
  }
  if (!res.ok) {
    // opaqueredirect（type === "opaqueredirect"）も status 0 / ok false で来る = 未ログイン。
    logNotebookLm(`token fetch not ok: status=${res.status} type=${res.type}`);
    return { ok: false, error: "not-authorized" };
  }
  const html = await res.text();
  const bl = NotebookLm.extractToken(html, "cfb2h");
  const at = NotebookLm.extractToken(html, "SNlM0e");
  if (bl && at) return { ok: true, bl, at, accountIndex: NotebookLm.normalizeAccountIndex(accountIndex) };
  // 200 が返ったのにトークンが取れない = NotebookLM 側の HTML 構造変更が最有力。
  logNotebookLm(`token extraction failed (cfb2h=${!!bl} SNlM0e=${!!at}) — NotebookLM 側の仕様変更の可能性`);
  return { ok: false, error: "protocol-changed" };
}

/**
 * NotebookLM 系メッセージの sender 検証（/rere RC-P）。
 *
 * `SenderCheck.isFromContentScript` は「自拡張の content script か」しか見ない。本拡張は
 * 全 http(s) サイトに content script を注入しているため、それだけでは「YouTube 由来のみ」
 * というコメント上の不変条件を実装できていなかった。Google セッション Cookie を使う RPC の
 * 起点なので、`sender.url` のオリジンまで確認して defense-in-depth を効かせる。
 */
function isFromYouTubeContentScript(sender) {
  if (!SenderCheck.isFromContentScript(sender)) return false;
  try {
    const host = new URL(sender.url ?? sender.tab?.url ?? "").hostname.toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

/**
 * NotebookLM 連携の診断ログ。テレメトリは持たない方針なので、切り分け材料は
 * 開発者ツールのコンソールにだけ残す（/rere RC-J）。トークン等の秘密値は出さない。
 */
function logNotebookLm(message, err) {
  if (err) console.warn(`[WebViewingAssist] NotebookLM: ${message}`, err);
  else console.warn(`[WebViewingAssist] NotebookLM: ${message}`);
}

/**
 * batchexecute を 1 回叩いて応答ボディ（テキスト）を返す。
 *
 * @param {{bl: string, at: string}} tokens fetchNotebookLmTokens の戻り値
 * @param {string} rpcId NotebookLm.RPC_* のいずれか
 * @param {string} payload `f.req` の内側に入れる JSON 文字列
 * @param {string} sourcePath `source-path` パラメータ（"/" または "/notebook/<id>"）
 * @returns {Promise<string|null>} 応答ボディ、失敗時 null
 */
async function callNotebookLmRpc(tokens, rpcId, payload, sourcePath) {
  // URL / body の組み立ては純粋関数に切り出してテスト可能にしてある（/rere B2-10）。
  const { url, body } = NotebookLm.buildRpcRequest({
    rpcId,
    payload,
    sourcePath,
    bl: tokens.bl,
    at: tokens.at,
    reqId: 100000 + Math.floor(Math.random() * 900000),
    accountIndex: tokens.accountIndex,
  });
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "include",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      // timeout が無いと応答が返らないまま sendResponse が呼ばれず、content script の
      // 送信ボタンが「送信中…」で固着して再送不能になる（/rere RC-C）。
      signal: AbortSignal.timeout(NotebookLm.FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    logNotebookLm(`rpc ${rpcId} fetch failed`, err);
    return null;
  }
  // HTTP ステータスを捨てず切り分け材料として残す（/rere RC-J）。
  if (!res.ok) {
    logNotebookLm(`rpc ${rpcId} not ok: status=${res.status} type=${res.type}`);
    return null;
  }
  return await res.text();
}

/**
 * ログイン中の Google アカウントを `authuser` の小さい順に列挙する（アカウント選択 UI 用）。
 *
 * 「アカウント 1」という番号だけでは**どれを選べばいいか分からない**ため、実際のメール
 * アドレスを出す。値は NotebookLM のトップページ HTML の `oPEP7c` キー（実機で確認）。
 *
 * 終了条件が要点: 存在しない `authuser` を指定しても Google はエラーにせず**既定アカウント
 * の HTML を返す**ので、「既出のメールアドレスが出たら打ち切り」でしか範囲を確定できない。
 * 1 回の probe が数百 KB の HTML 取得になるため、結果は SW のメモリにキャッシュする
 * （SW 再起動で消えるだけで、消えても再取得できる）。
 *
 * @returns {Promise<{ok: true, accounts: Array<{index: number, email: string}>}
 *                  | {ok: false, error: string}>}
 */
let cachedNotebookLmAccounts = null;
let inFlightNotebookLmAccounts = null;

/**
 * 1 アカウント分の probe。**メールアドレスが見つかった時点でストリームを打ち切る**。
 *
 * トップページ HTML は 1 件あたり約 330 KB あるが、目的のキーは先頭 10%（約 33 KB）に
 * 現れる（実測）。全文を読むと 10 アカウント probe で 3 MB を超えるため、逐次デコードして
 * 見つけ次第 abort する。`extractToken` は閉じ引用符まで要求するので、途中まで読んだ
 * バッファに対して使っても値が途中で切れることはない。
 *
 * @param {number} index `authuser` インデックス
 * @returns {Promise<{ok: true, email: string} | {ok: false, error: string}>}
 */
async function probeNotebookLmAccount(index) {
  const ctrl = new AbortController();
  const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(NotebookLm.FETCH_TIMEOUT_MS)]);
  let res;
  try {
    res = await fetch(NotebookLm.buildHomeUrl(index), { credentials: "include", redirect: "manual", signal });
  } catch (err) {
    logNotebookLm(`account probe ${index} fetch failed`, err);
    return { ok: false, error: "network-failed" };
  }
  // 未ログインは accounts.google.com への opaqueredirect（ok === false）。
  if (!res.ok) return { ok: false, error: "not-authorized" };
  const reader = res.body?.getReader?.();
  if (!reader) {
    const email = NotebookLm.extractToken(await res.text(), NotebookLm.ACCOUNT_EMAIL_KEY);
    return email ? { ok: true, email } : { ok: false, error: "protocol-changed" };
  }
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (buf.length < NotebookLm.ACCOUNT_SCAN_MAX_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const email = NotebookLm.extractToken(buf, NotebookLm.ACCOUNT_EMAIL_KEY);
      if (email) return { ok: true, email };
    }
  } catch (err) {
    logNotebookLm(`account probe ${index} read failed`, err);
    return { ok: false, error: "network-failed" };
  } finally {
    // 見つかった時点で残りの転送を止める（見つからなかった場合も接続を残さない）
    try { ctrl.abort(); } catch { /* 既に完了していれば無視 */ }
  }
  logNotebookLm(`account probe ${index}: メールアドレスを取得できません — 仕様変更の可能性`);
  return { ok: false, error: "protocol-changed" };
}

async function listNotebookLmAccounts() {
  if (cachedNotebookLmAccounts) return { ok: true, accounts: cachedNotebookLmAccounts };
  // 事前取得とパネル表示が重なっても probe は 1 回で済ませる（同時 10 fetch の二重発射を防ぐ）
  if (inFlightNotebookLmAccounts) return await inFlightNotebookLmAccounts;
  inFlightNotebookLmAccounts = (async () => {
    const stored = await chrome.storage.local
      .get(StorageKeys.NOTEBOOK_LM_ACCOUNTS_CACHE)
      .catch(() => ({}));
    const cache = stored?.[StorageKeys.NOTEBOOK_LM_ACCOUNTS_CACHE];
    if (
      cache && Array.isArray(cache.accounts) && cache.accounts.length > 0 &&
      Number.isFinite(cache.at) && Date.now() - cache.at < NotebookLm.ACCOUNTS_CACHE_TTL_MS
    ) {
      cachedNotebookLmAccounts = cache.accounts;
      return { ok: true, accounts: cache.accounts };
    }
    // probe は並列。逐次だとアカウント数ぶん RTT が積み上がり、パネルを開いた直後の
    // セレクタが番号表示のまま待たされる。
    const probes = await Promise.all(
      Array.from({ length: NotebookLm.MAX_ACCOUNT_INDEX + 1 }, (_, i) => probeNotebookLmAccount(i))
    );
    if (!probes[0].ok && probes[0].error === "not-authorized") return { ok: false, error: "not-authorized" };
    const accounts = [];
    const seen = new Set();
    for (let i = 0; i < probes.length; i++) {
      const probe = probes[i];
      if (!probe.ok) break;
      // 存在しない authuser は既定アカウントの HTML を返す。既出メールが終端の唯一の手がかり。
      if (seen.has(probe.email)) break;
      seen.add(probe.email);
      accounts.push({ index: i, email: probe.email });
    }
    if (accounts.length === 0) return { ok: false, error: "protocol-changed" };
    cachedNotebookLmAccounts = accounts;
    chrome.storage.local
      .set({ [StorageKeys.NOTEBOOK_LM_ACCOUNTS_CACHE]: { at: Date.now(), accounts } })
      .catch(() => {});
    return { ok: true, accounts };
  })();
  try {
    return await inFlightNotebookLmAccounts;
  } finally {
    inFlightNotebookLmAccounts = null;
  }
}

/** ノートブック一覧を返す（送信先セレクタ用）。 */
async function listNotebookLmNotebooks(accountIndex) {
  const tokens = await fetchNotebookLmTokens(accountIndex);
  if (!tokens.ok) return { ok: false, error: tokens.error };
  const text = await callNotebookLmRpc(
    tokens,
    NotebookLm.RPC_LIST_NOTEBOOKS,
    JSON.stringify([null, 1, null, [2]]),
    "/"
  );
  if (text == null) return { ok: false, error: "rpc-failed" };
  // 応答形式が変わった場合の空配列と「ノートブック 0 件の新規ユーザー」を区別する（/rere RC-J）。
  // 旧実装はどちらも同じ空パネルになり、故障が正常動作に見えていた。
  if (NotebookLm.parseBatchPayload(text) == null) {
    logNotebookLm("notebook list payload unparsable — NotebookLM 側の仕様変更の可能性");
    return { ok: false, error: "protocol-changed" };
  }
  return { ok: true, notebooks: NotebookLm.parseNotebookList(text) };
}

/**
 * 1 ノートブックあたりのソース上限を取得する（プラン依存。取れなければ保守的な既定値）。
 * 定数は actions.js の `NotebookLm` を単一情報源にする（/rere RC-O: 旧実装は同値の
 * マジックナンバーを background に再掲していて drift 予備軍だった）。
 */
async function fetchNotebookLmSourceLimit(tokens) {
  const text = await callNotebookLmRpc(
    tokens,
    NotebookLm.RPC_SOURCE_LIMIT,
    NotebookLm.SOURCE_LIMIT_PAYLOAD,
    "/"
  ).catch(() => null);
  if (text == null) return NotebookLm.SOURCE_LIMIT_FALLBACK;
  // Plus 表示 (notebooklm_plus_icon) が無いアカウントのほうが上限が大きい応答を返す。
  // 判定材料が消えた場合もフォールバック値まで落ちるだけで送信自体は成立する。
  return text.includes("notebooklm_plus_icon")
    ? NotebookLm.SOURCE_LIMIT_FALLBACK
    : NotebookLm.SOURCE_LIMIT_PLUS;
}

/**
 * URL 群を NotebookLM に送る。notebookId 未指定なら title でノートブックを新規作成する。
 *
 * @param {{urls?: string[], title?: string, notebookId?: string|null}} data
 * @returns {Promise<{ok: boolean, url?: string, added?: number, skipped?: number, error?: string}>}
 */
async function sendToNotebookLm(data) {
  const urls = Array.isArray(data?.urls) ? data.urls.filter((u) => typeof u === "string" && u !== "") : [];
  if (urls.length === 0) return { ok: false, error: "no-urls" };

  const accountIndex = NotebookLm.normalizeAccountIndex(data?.accountIndex);
  const tokens = await fetchNotebookLmTokens(accountIndex);
  if (!tokens.ok) return { ok: false, error: tokens.error };

  const createdHere = !(typeof data?.notebookId === "string" && data.notebookId !== "");
  let notebookId = createdHere ? null : data.notebookId;
  if (!notebookId) {
    const title = typeof data?.title === "string" && data.title.trim() !== ""
      ? data.title.trim().slice(0, 120)
      : "YouTube";
    const created = await callNotebookLmRpc(
      tokens,
      NotebookLm.RPC_CREATE_NOTEBOOK,
      // 作成側も Web アプリと同じ 4 要素形状（末尾に共通リクエストオプション）に揃える。
      JSON.stringify([title, null, null, NotebookLm.buildRequestOptions()]),
      "/"
    );
    notebookId = NotebookLm.extractNotebookId(created);
    if (!notebookId) {
      logNotebookLm("create: 応答からノートブック ID を取得できません — 仕様変更の可能性");
      return { ok: false, error: "create-failed" };
    }
  }

  // 既存ノートブックを選んだ場合は、その残容量を差し引いてから受理数を決める（/rere RC-O）。
  // 旧実装は既存ソース数を無視していたため、満杯近くのノートブックでも skipped: 0 と表示していた。
  const limit = await fetchNotebookLmSourceLimit(tokens);
  const used = Number.isInteger(data?.existingSources) && data.existingSources > 0 ? data.existingSources : 0;
  const room = Math.max(0, limit - used);
  const accepted = urls.slice(0, room);
  const sources = NotebookLm.buildSourcePayload(accepted);
  if (sources.length === 0) {
    return { ok: false, error: "notebook-full", notebookId, url: NotebookLm.buildNotebookUrl(notebookId, accountIndex) };
  }

  const added = await callNotebookLmRpc(
    tokens,
    NotebookLm.RPC_ADD_SOURCES,
    // 3 番目の共通リクエストオプションが無いとソースが黙って無視される（200 応答なのに
    // 空のノートブックが開く）。ソース仕様の末尾 `1` と合わせて Web アプリの形状に揃える。
    JSON.stringify([sources, notebookId, NotebookLm.buildRequestOptions()]),
    `/notebook/${notebookId}`
  );
  // 応答の中身を検証する（/rere RC-D）。batchexecute は失敗時も HTTP 200 + エラーフレームを
  // 返すため、`res.ok` だけで成功にすると「空のノートブックを開いて成功表示」になる。
  const addOk = added != null && NotebookLm.parseBatchPayload(added) != null;
  if (!addOk) {
    if (added != null) logNotebookLm("add: 200 応答だが payload を解釈できません — 仕様変更の可能性");
    // 作成済みノートブックの ID を返して再試行で使い回せるようにする（/rere RC-E）。
    // 返さないと、失敗のたびに空のノートブックが増え続ける。
    return {
      ok: false,
      error: "add-failed",
      notebookId,
      createdHere,
      url: NotebookLm.buildNotebookUrl(notebookId, accountIndex),
    };
  }

  // 送信先を開くのは background の仕事にする。content script の `window.open` は送信の
  // await を跨ぐと transient user activation が切れて popup blocker に弾かれ、代わりの
  // 「開く」リンクが毎回出てしまう（/rere RC-L の受け皿が常態化していた）。
  const url = NotebookLm.buildNotebookUrl(notebookId, accountIndex);
  let opened = false;
  try {
    await chrome.tabs.create({ url });
    opened = true;
  } catch (err) {
    logNotebookLm("送信先タブを開けませんでした（content script のリンクに退避）", err);
  }

  return {
    ok: true,
    url,
    opened,
    added: sources.length,
    // 上限で溢れた分は黙って捨てず件数を返し、content script 側でユーザーに伝える。
    skipped: urls.length - accepted.length,
  };
}

// ---------- タブクローズで音量ブーストを解放 ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!HAS_VOLUME_BOOSTER) return;  // Firefox 版では音量ブースター無効
  rememberRemovedVolumeBoosterTab(tabId);
  // P2-#19: タブが閉じられた時点でブースト中状態は確実に終了するため、ローカルキャッシュから即削除。
  // in-flight の set 処理が後から完了した場合も、removedVolumeBoosterTabIds で再登録を弾く。
  boostedTabIds.delete(tabId);
  // 同一タブの in-flight SET より後ろへ解放を並べ、古いSETの遅着によるstate復活を防ぐ。
  releaseVolumeBoosterTab(tabId).catch(() => {});
});

// ---------- 音量ブースター: マスター ON 時にタブ切替で自動適用 ----------
//
// `tabs.onActivated` はタブ切替のたびに発火するため、毎回 storage.get を 5 キー
// 発行すると IPC RTT がタブ切替遅延に響く。SW モジュールスコープで一度だけ取得して
// `chrome.storage.onChanged` で invalidate する方式にする (/rere C 2-A)。
// 注: SW 再起動でこの変数は消えるため、初回呼び出し時の null フォールバックは必須。
let cachedVolumeSettings = null;
// /rere F-003 race protection: cachedVolumeSettings の fetch 中に onChanged が invalidate しても、
// await 完了時に stale な fetch 結果で cache が上書きされる race を seqId で検出する。
// fetch 前と fetch 後で cacheSeqId が変わっていたら、その fetch 結果は stale なので破棄して再帰 fetch。
// 旧実装: ① autoApplyVolumeBooster の await 中に popup が storage.set →
//          ② onChanged listener が `cachedVolumeSettings = null` (cache 無効化)
//          ③ ①の await 完了 → 古い storage 値を `cachedVolumeSettings` に代入 (上書き)
//          ④ 古い値が以降のタブ切替で適用され、UI と挙動の乖離が発生
let cacheSeqId = 0;

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!HAS_VOLUME_BOOSTER) return;  // Firefox 版では音量ブースター無効
  autoApplyVolumeBooster(tabId).catch(() => {});
});

async function autoApplyVolumeBooster(tabId) {
  // getMediaStreamId は user gesture 必須なので、onActivated では新規 AudioContext を作れない。
  // 既に boost 中のタブに対して最新の保存設定を反映する用途に限定する。
  // 未 boost タブへの初回適用は popup 表示時の pushVolumeNow (user gesture あり) が担う。
  if (!boostedTabIds.has(tabId)) return;
  if (cachedVolumeSettings === null) {
    const seqAtFetch = cacheSeqId;
    const fetched = await chrome.storage.local.get([
      StorageKeys.VOLUME_BOOSTER_ENABLED,
      StorageKeys.VOLUME_BOOSTER_LAST_GAIN,
      StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
      StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED,
      StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED,
      StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED,
      StorageKeys.VOLUME_BOOSTER_EQ_ENABLED,
      StorageKeys.VOLUME_BOOSTER_EQ_GAINS,
      StorageKeys.VOLUME_BOOSTER_EQ_PREAMP,
    ]);
    // fetch 中に onChanged が cache を invalidate していたら、この fetch 結果は stale。
    // cache 代入をスキップし、再帰呼び出しで fresh fetch を試みる (cacheSeqId は invalidate 側で進む)。
    if (seqAtFetch !== cacheSeqId) {
      return autoApplyVolumeBooster(tabId);
    }
    cachedVolumeSettings = fetched;
  }
  const stored = cachedVolumeSettings;
  if (stored[StorageKeys.VOLUME_BOOSTER_ENABLED] !== true) return;
  const gain = VolumeBooster.clampValue(stored[StorageKeys.VOLUME_BOOSTER_LAST_GAIN] ?? VolumeBooster.DEFAULT);
  const antiClip = stored[StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED] === true;
  const nightMode = stored[StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED] === true;
  const bassCut = stored[StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED] === true;
  const muted = stored[StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED] === true;
  const eqEnabled = stored[StorageKeys.VOLUME_BOOSTER_EQ_ENABLED] === true;
  // gain と一貫させて offscreen への送信前にクランプ (audio-pipeline で再クランプされる二重防御)。
  const eqGains = VolumeBooster.clampEqGains(stored[StorageKeys.VOLUME_BOOSTER_EQ_GAINS]);
  const eqPreamp = VolumeBooster.clampEqPreamp(stored[StorageKeys.VOLUME_BOOSTER_EQ_PREAMP]);
  await setVolumeBoosterGain(tabId, gain, antiClip, nightMode, bassCut, muted, eqEnabled, eqGains, eqPreamp);
}

// ---------- 音量ブースター: マスター OFF で全タブの AudioContext を解放 + 設定キャッシュ無効化 ----------
chrome.storage.onChanged.addListener((changes) => {
  if (!HAS_VOLUME_BOOSTER) return;  // Firefox 版では音量ブースター無効、設定変化も無視
  // 音量関連キーいずれかが変化したら autoApplyVolumeBooster のキャッシュを invalidate
  // (EQ_PRESET は popup の表示状態のみで boost には EQ_GAINS が効くため監視不要)
  if (
    StorageKeys.VOLUME_BOOSTER_ENABLED in changes ||
    StorageKeys.VOLUME_BOOSTER_LAST_GAIN in changes ||
    StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED in changes ||
    StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED in changes ||
    StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED in changes ||
    StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED in changes ||
    StorageKeys.VOLUME_BOOSTER_EQ_ENABLED in changes ||
    StorageKeys.VOLUME_BOOSTER_EQ_GAINS in changes ||
    StorageKeys.VOLUME_BOOSTER_EQ_PREAMP in changes
  ) {
    cachedVolumeSettings = null;
    // /rere F-003: 進行中の autoApplyVolumeBooster の await が stale な fetch 結果で
    // cache を上書きする race を防ぐため seqId を進める (await 復帰時 seqId 不一致で破棄判定)
    cacheSeqId++;
  }
  if (
    StorageKeys.VOLUME_BOOSTER_ENABLED in changes &&
    changes[StorageKeys.VOLUME_BOOSTER_ENABLED].newValue === false
  ) {
    releaseAllVolumeBoosterTabs();
  }
});

function releaseAllVolumeBoosterTabs() {
  volumeReleaseGeneration += 1;
  // 前回releaseの後ろへ今回の本体を連結し、実処理開始前にbarrier参照を同期更新する。
  // これ以降に受信した新世代SETは、このcurrent完了まで進めない。
  const previousBarrier = volumeReleaseBarrier;
  const currentBarrier = previousBarrier
    .catch(() => {})
    .then(() => releaseAllVolumeBoosterTabsDirect())
    .catch(() => {});
  volumeReleaseBarrier = currentBarrier;
  return currentBarrier;
}

async function releaseAllVolumeBoosterTabsDirect() {
  // /rere B2-002 修正: SW 再起動直後 hydrate IIFE 未完了 → offscreenState='CLOSED' のまま
  // この関数に到達する race window があった。hydrate 完了を待ってから判定する
  // ことで offscreen 残存 AudioContext のリークを防ぐ。
  await offscreenHydratePromise.catch(() => {});
  // boostedTabIds は SW 再起動後に部分集合になり得るため、個別 release の対象一覧には使わない。
  // offscreen の RELEASE_ALL を正として、既知・未知を問わず全 state と初期化中 state を解放する。
  boostedTabIds.clear();
  try {
    const res = await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_VOLUME_RELEASE_ALL,
    });
    // hydrate の getContexts だけが一時失敗していた場合も、応答があれば実体は OPEN と確定する。
    if (res?.ok && offscreenState === "CLOSED") offscreenState = "OPEN";
  } catch {
    // offscreen 不在なら解放対象も存在しない。
  } finally {
    if (offscreenState !== "CLOSED") scheduleOffscreenClose();
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
// APPLY_SETTINGS payload で受け取った値だけを差分マージするために、
// toStorageRecord が扱う全キーを 1 箇所に列挙する。settings に含まれないキーは
// storage 既存値で補完してから normalizeSettings へ渡すことで、partial payload が
// 来ても他キーが「正規化で false 化」されて消える事故を防ぐ二重防御。
// /rere B2-I003/D-003 修正: SettingsSchema の storageKey から導出して手書き列挙を廃止。
// 新 master トグル / 設定キー追加時の「APPLY_SETTINGS_KEYS への追加忘れ」事故を構造的に防止。
// 旧実装は SettingsSchema と APPLY_SETTINGS_KEYS と normalizeSettings と toStorageRecord の
// 4 箇所で同じキー集合を手書きしていたため、4 箇所同期失敗 = drift = 永久 OFF バグの温床。
const APPLY_SETTINGS_KEYS = Object.freeze(SettingsSchema.map((entry) => entry.storageKey));

// APPLY_SETTINGS 直列化キュー (/rere B1-001):
// popup は change イベントごとにデバウンス無しで即時 apply() するため、複数トグルを
// 短時間に操作すると handleApplySettings が並行起動する。各呼び出しは独立した
// storage.set → notifyContentScripts の非同期チェーンで、両者の完了順序が独立に前後すると
// 「storage の値」と「content script への最終適用」が一時的に食い違う経路があった。
// 呼び出しを promise チェーンで直列化し、常に受理順に set → notify を完了させる。
let applySettingsChain = Promise.resolve();

async function handleApplySettings(settings) {
  const run = applySettingsChain.then(() => applySettingsInner(settings));
  // チェーンが reject で途切れないよう失敗は握って次段へ繋ぐ (エラー自体は caller が run で受け取る)。
  applySettingsChain = run.catch(() => {});
  return run;
}

async function applySettingsInner(settings) {
  // 既存 storage 値で補完してから normalize: settings に含まれないキーがあっても
  // 「現状の保存値」が引き継がれる。これで partial payload が紛れ込んでも
  // 他キーが false で wipe されないことを保証する (落とし穴 C 修正)。
  const existing = await chrome.storage.local.get(APPLY_SETTINGS_KEYS).catch(() => ({}));
  const merged = { ...existing, ...(settings ?? {}) };
  const normalized = normalizeSettings(merged);
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
 * **音量ブースターサブトグル (volumeBoosterAntiClipEnabled / NightMode / BassCut / Muted) は
 * APPLY_SETTINGS の対象外**: popup が VOLUME_BOOSTER_SET_GAIN メッセージで gain と一緒に
 * 渡してくるため、storage.set は popup 側で直接行う。content script への配信も不要なので
 * normalizeSettings / toStorageRecord には含めない。新しい音量関連 storage key を増やすときは
 * この方針を維持するか、APPLY_SETTINGS 経路に統合するかを先に判断すること。
 *
 * **ルーペの zoom / size (loupeZoom / loupeSize) も APPLY_SETTINGS の対象外**: 同じく popup が
 * `chrome.storage.local.set` で直接保存し、content script は `storage.onChanged` で同期する。
 * loupeEnabled だけ APPLY_SETTINGS 経路に乗せて active tab への即時通知 (APPLY_LOUPE_CS) を担保する。
 * これは音量ブースター 6 キー直書きパターン (CLAUDE.md「Important Patterns」#23) と同型。
 */
function normalizeSettings(settings) {
  return {
    searchFixerEnabled: settings?.searchFixerEnabled === true,
    searchFixerFeatures: SearchFixer.mergeFeatures(settings?.searchFixerFeatures),
    searchFixerGridItems: SearchFixer.clampGridItems(settings?.searchFixerGridItems),
    amazonDeliveryTotalEnabled: settings?.amazonDeliveryTotalEnabled === true,
    amazonRankingJumpEnabled: settings?.amazonRankingJumpEnabled === true,
    amazonMerchantInfoEnabled: settings?.amazonMerchantInfoEnabled === true,
    instagramCleanerEnabled: settings?.instagramCleanerEnabled === true,
    instagramCleanerFeatures: InstagramCleaner.mergeFeatures(settings?.instagramCleanerFeatures),
    tiktokCleanerEnabled: settings?.tiktokCleanerEnabled === true,
    tiktokCleanerFeatures: TikTokCleaner.mergeFeatures(settings?.tiktokCleanerFeatures),
    xCleanerEnabled: settings?.xCleanerEnabled === true,
    xCleanerFeatures: XCleaner.mergeFeatures(settings?.xCleanerFeatures),
    videoGammaEnabled: settings?.videoGammaEnabled === true,
    videoGammaValue: VideoGamma.clampValue(settings?.videoGammaValue),
    videoFillEnabled: settings?.videoFillEnabled === true,
    videoFillMode: VideoFill.normalizeMode(settings?.videoFillMode),
    videoFillTarget: VideoFill.normalizeTarget(settings?.videoFillTarget),
    loupeEnabled: settings?.loupeEnabled === true,
    // 接続モニターは searchFixerFeatures.connectionMonitor に統合済み（searchFixerFeatures 経由で正規化される）。
  };
}

/** 正規化済み settings から chrome.storage.local.set 用のレコードを構築。
 *  /rere B2-I003/D-003 修正: SettingsSchema から導出して手書き列挙を廃止。
 *  新 master トグル追加時の「toStorageRecord への追加忘れ」事故 (drift) を構造的に防止。
 *  各 entry は `{ field, storageKey }` を持ち、normalizeSettings の戻り値から storageKey 経由で
 *  storage レコードを generate する。normalizeSettings の戻り値キー (= field 名) と SettingsSchema
 *  の field が一致することは test/actions.test.js の "SettingsSchema" テストで保証されている。 */
function toStorageRecord(s) {
  return Object.fromEntries(
    SettingsSchema.map(({ field, storageKey }) => [storageKey, s[field]])
  );
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

  // A1-2 / #11 対策: top frame のみ注入の content script (search-fixer / amazon-delivery-total /
  // instagram-cleaner / tiktok-cleaner / loupe) は frameId 指定なしだと
  // 全フレームへブロードキャストされるため、`{ frameId: 0 }` で明示する。
  // video-gamma は `all_frames: true` で全フレーム必要なので意図的に frameId 指定なし。
  const TOP_FRAME = { frameId: 0 };

  // /opop PF-1 + CL-6: 各 sendMessage は独立 (受信側 cs は別 isolated world)、5〜8 RTT を
  // 直列 await ではなく Promise.all で並列発射して apply 経路全体のレイテンシを max(各 RTT) に圧縮。
  // 受信側不在 reject (chrome:// / about: / 非マッチタブ) は expected なので safeSendMessage で silent skip。
  const messages = [
    // 動画ガンマ補正: all_frames: true (iframe 内 <video> も対象)
    [{ action: Actions.APPLY_VIDEO_GAMMA_CS, data: {
      enabled: s.videoGammaEnabled,
      value: s.videoGammaValue,
    } }, undefined],
    // 動画黒帯除去: all_frames: true (iframe 内 <video> も対象)
    [{ action: Actions.APPLY_VIDEO_FILL_CS, data: {
      enabled: s.videoFillEnabled,
      mode: s.videoFillMode,
      target: s.videoFillTarget,
    } }, undefined],
    // ルーペ: top frame のみ
    [{ action: Actions.APPLY_LOUPE_CS, data: { enabled: s.loupeEnabled } }, TOP_FRAME],
  ];
  if (isYouTubeUrl(url)) {
    // Shorts 削除 (features.removeShorts*) と接続モニター (features.connectionMonitor) はいずれも
    // YouTube 機能拡張のサブ機能として統合されているため、メッセージは APPLY_SEARCH_FIXER_CS のみ。
    // search-fixer.js / youtube-shorts.js / youtube-connection-monitor.js の 3 つが同一 isolated world で
    // この 1 メッセージを購読し、各々の責務に応じて反応する。
    messages.push([{ action: Actions.APPLY_SEARCH_FIXER_CS, data: {
      enabled: s.searchFixerEnabled,
      features: s.searchFixerFeatures,
      gridItems: s.searchFixerGridItems,
    } }, TOP_FRAME]);
  }
  if (isAmazonAutoDeliveryUrl(url)) {
    messages.push([{ action: Actions.APPLY_AMAZON_DELIVERY_TOTAL_CS, data: {
      enabled: s.amazonDeliveryTotalEnabled,
    } }, TOP_FRAME]);
  }
  if (isAmazonUrl(url)) {
    // ランキング移動ボタンは www.amazon.co.jp 全ページ (商品ページで自己ゲート) に注入されるため
    // auto-deliveries 判定とは別に Amazon ドメイン全体で配信する。
    messages.push([{ action: Actions.APPLY_AMAZON_RANKING_JUMP_CS, data: {
      enabled: s.amazonRankingJumpEnabled,
    } }, TOP_FRAME]);
    // 販売元・出荷元バッジも ranking と同じく Amazon ドメイン全体で配信し、商品ページで自己ゲート。
    messages.push([{ action: Actions.APPLY_AMAZON_MERCHANT_INFO_CS, data: {
      enabled: s.amazonMerchantInfoEnabled,
    } }, TOP_FRAME]);
  }
  if (isInstagramUrl(url)) {
    messages.push([{ action: Actions.APPLY_INSTAGRAM_CLEANER_CS, data: {
      enabled: s.instagramCleanerEnabled,
      features: s.instagramCleanerFeatures,
    } }, TOP_FRAME]);
  }
  if (isTikTokUrl(url)) {
    messages.push([{ action: Actions.APPLY_TIKTOK_CLEANER_CS, data: {
      enabled: s.tiktokCleanerEnabled,
      features: s.tiktokCleanerFeatures,
    } }, TOP_FRAME]);
  }
  if (isXUrl(url)) {
    messages.push([{ action: Actions.APPLY_X_CLEANER_CS, data: {
      enabled: s.xCleanerEnabled,
      features: s.xCleanerFeatures,
    } }, TOP_FRAME]);
  }
  await Promise.all(messages.map(([msg, opts]) => safeSendMessage(tab.id, msg, opts)));
}

/**
 * 受信側不在 reject (chrome:// / about: / 非マッチタブ / content script 未注入) は expected なので
 * silent skip する。CLAUDE.md「`chrome.runtime.sendMessage` の expected error」参照。
 */
function safeSendMessage(tabId, message, options) {
  const p = options
    ? chrome.tabs.sendMessage(tabId, message, options)
    : chrome.tabs.sendMessage(tabId, message);
  return p.catch(() => {});
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

/** www.amazon.co.jp の任意ページ（ランキング移動ボタンの対象。商品ページかは content script が自己判定） */
function isAmazonUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.hostname.toLowerCase() === "www.amazon.co.jp";
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

/** X（旧 Twitter）。改名後も twitter.com は x.com へ転送されるだけで残っているため両方見る。 */
function isXUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "x.com" || h.endsWith(".x.com") || h === "twitter.com" || h.endsWith(".twitter.com");
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
// SET_GAIN / 再スケジュールのたびに進め、タイマー発火後の await 中 callback も失効させる。
let offscreenCloseGeneration = 0;
let activeVolumeSetGainCount = 0;
// master OFF より前に開始した非同期 SET_GAIN が、全解放後に state を再生成するのを防ぐ。
let volumeReleaseGeneration = 0;
// global RELEASE_ALLを直列化し、新世代SETも解放完了後まで待機させるbarrier。
let volumeReleaseBarrier = Promise.resolve();
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
/** @type {Map<number, Promise<unknown>>} タブ単位のSET/RELEASE受信順キュー */
const volumeTabOperationQueues = new Map();

function enqueueVolumeTabOperation(tabId, operation) {
  const previous = volumeTabOperationQueues.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  volumeTabOperationQueues.set(tabId, current);
  const cleanup = () => {
    // 後続operationが登録済みなら、そのPromiseを誤って削除しない。
    if (volumeTabOperationQueues.get(tabId) === current) {
      volumeTabOperationQueues.delete(tabId);
    }
  };
  current.then(cleanup, cleanup);
  return current;
}

function rememberRemovedVolumeBoosterTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  removedVolumeBoosterTabIds.add(tabId);
  setTimeout(() => {
    removedVolumeBoosterTabIds.delete(tabId);
  }, 5 * 60 * 1000);
}

async function markVolumeBoosterTabActive(tabId) {
  if (removedVolumeBoosterTabIds.has(tabId)) {
    // SET operation自身のキュー内なので、queued wrapperへ戻すと自己deadlockする。
    await releaseVolumeBoosterTabDirect(tabId).catch(() => {});
    return false;
  }
  boostedTabIds.add(tabId);
  return true;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return false;
  // __FIREFOX_STRIP_BEGIN__: Firefox MV3 は chrome.offscreen 未対応のため、build 時に
  // このブロックを削除する。chrome.offscreen guard により実行時はこの行に到達しないが、
  // AMO linter の static analysis は chrome.offscreen.createDocument(...) を検出して
  // UNSUPPORTED_API 警告を出すため、コード自体を物理的に削除して警告ゼロ化する。

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
  // __FIREFOX_STRIP_END__
}

function invalidateOffscreenCloseCycle() {
  offscreenCloseGeneration += 1;
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = null;
}

function scheduleOffscreenClose() {
  invalidateOffscreenCloseCycle();
  const closeGeneration = offscreenCloseGeneration;
  offscreenIdleTimer = setTimeout(async () => {
    if (closeGeneration !== offscreenCloseGeneration) return;
    offscreenIdleTimer = null;
    if (!chrome.offscreen) return;
    // __FIREFOX_STRIP_BEGIN__: Firefox MV3 は chrome.offscreen.closeDocument 未対応のため build 時に削除
    // EC-6 対策: CREATING 中はもちろん、CLOSING 中の二重呼び出しもガードする
    // （await `isVolumeBoosterActive` の最中に別タイマーが発火するケースで二重 close を防ぐ）。
    if (offscreenState === "CREATING" || offscreenState === "CLOSING") return;
    if (activeVolumeSetGainCount > 0) {
      scheduleOffscreenClose();
      return;
    }
    // 音量ブースト中タブが残っていれば close を再延期する。close すると AudioContext が
    // 解放されて音が一瞬で 100% に戻ってしまうため、ユーザー体験的に NG。
    const active = await isVolumeBoosterActive();
    // await 中に SET_GAIN や別の schedule が走った callback は、新しい AudioContext を閉じない。
    if (closeGeneration !== offscreenCloseGeneration) return;
    if (active) {
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
    if (closeGeneration !== offscreenCloseGeneration) return;
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
    // __FIREFOX_STRIP_END__
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
//
// /rere B2-002 修正: Promise を保持して release 経路で await できるようにする。
// SW 再起動直後に `storage.onChanged` で master OFF を検知する → `releaseAllVolumeBoosterTabs`
// が走るが、hydrate 完了前なら `offscreenState === "CLOSED"` のまま fallback 経路に入らず
// offscreen に残存 AudioContext がリークする経路があった。
const offscreenHydratePromise = (async () => {
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
 * `antiClip` / `nightMode` は popup から渡される DynamicsCompressor 機能フラグで、
 * offscreen 側で各 compressor のパラメータを切り替える。`bassCut`（壁ドン対策モード）は
 * highpass BiquadFilterNode の機能フラグ。いずれも OFF 時はチェーンに残したままバイパス
 * 設定（compressor は ratio:1、filter は frequency:0）にするため、トグル切替時に音切れは発生しない。
 */
async function setVolumeBoosterGain(tabId, gain, antiClip, nightMode, bassCut, muted, eqEnabled, eqGains, eqPreamp) {
  activeVolumeSetGainCount += 1;
  invalidateOffscreenCloseCycle();
  const operationGeneration = volumeReleaseGeneration;
  try {
    return await enqueueVolumeTabOperation(
      tabId,
      () => setVolumeBoosterGainImpl(
        tabId,
        gain,
        antiClip,
        nightMode,
        bassCut,
        muted,
        eqEnabled,
        eqGains,
        eqPreamp,
        operationGeneration,
      ),
    );
  } finally {
    activeVolumeSetGainCount -= 1;
    scheduleOffscreenClose();
  }
}

async function setVolumeBoosterGainImpl(
  tabId,
  gain,
  antiClip,
  nightMode,
  bassCut,
  muted,
  eqEnabled,
  eqGains,
  eqPreamp,
  operationGeneration,
) {
  // 呼出時点で公開されている最新global releaseを待つ。待機中にさらにreleaseが始まった場合も、
  // 直後の世代照合でこのoperationを失効させるため、新しいbarrierと並走しない。
  await volumeReleaseBarrier.catch(() => {});
  if (operationGeneration !== volumeReleaseGeneration) {
    return { ok: false, error: "release-all-during-set" };
  }
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
  const nightModeFlag = nightMode === true;
  const bassCutFlag = bassCut === true;
  const mutedFlag = muted === true;
  const eqActiveFlag = eqEnabled === true;

  // スライダーが等倍位置 (100%) かつ全サブトグル OFF かつミュート OFF かつイコライザ OFF のときだけ
  // release → リソース返却。100% でも自動歪み防止 / ナイトモード / 壁ドン対策 / イコライザのいずれかが
  // ON なら処理を効かせる必要があり、ミュート ON なら gain を 0 にランプし続ける必要があるため、
  // いずれの場合も AudioContext を維持して通常経路に進む（gain は 1.0x または 0 にランプ、各処理は
  // 設定通り適用）。判定条件は VolumeBooster.isUnityRelease に集約（Firefox MES 経路と同一条件・/rere D-002）。
  if (
    VolumeBooster.isUnityRelease({
      gain: clamped,
      antiClip: antiClipFlag,
      nightMode: nightModeFlag,
      bassCut: bassCutFlag,
      muted: mutedFlag,
      eqEnabled: eqActiveFlag,
    })
  ) {
    await releaseVolumeBoosterTabDirect(tabId).catch(() => {});
    return { ok: true, gain: VolumeBooster.UNITY };
  }

  const ready = await ensureOffscreenDocument();
  if (!ready) return { ok: false, error: "offscreen-unavailable" };
  if (operationGeneration !== volumeReleaseGeneration) {
    return { ok: false, error: "release-all-during-set" };
  }

  // 既存 AudioContext があれば streamId は不要（getMediaStreamId をスキップ）。
  // ensureOffscreenDocument が ready=true を返したので offscreen の存在は確定している。
  // getContexts 重複呼び出しを避けるため Direct 版を使う (2-C1 修正)。
  const existing = await getVolumeBoosterGainDirect(tabId);
  if (operationGeneration !== volumeReleaseGeneration) {
    return { ok: false, error: "release-all-during-set" };
  }
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
        nightMode: nightModeFlag,
        bassCut: bassCutFlag,
        muted: mutedFlag,
        eqEnabled: eqActiveFlag,
        eqGains,
        eqPreamp,
      });
    } catch (err) {
      // 例外: offscreen がリスタート途中など → fresh 取得経路へフォールスルー。
      // silent failure を防ぐため診断ログを残す（実害は fresh 経路で自己修復されるため軽微）。
      console.warn("[WebViewingAssist] existing-path sendMessage failed, falling through:", err);
    }
    if (operationGeneration !== volumeReleaseGeneration) {
      if (res?.ok) await releaseVolumeBoosterTabDirect(tabId).catch(() => {});
      return { ok: false, error: "release-all-during-set" };
    }
    // EC-2 対策: getVolumeBoosterGain で「state あり」と判定後に audioStates が削除される
    // race（onRemoved や release 経路と同時操作）に対して、offscreen が
    // `invalid-stream-id` を返した場合は fresh 取得経路に自動フォールスルーして自己修復する。
    // scheduleOffscreenClose は外側 wrapper の finally で全 return 経路を一括処理する。
    if (res?.ok) {
      // P2-#19: 成功確認後にローカルキャッシュへ追加（既存 state 経路ではすでに add 済みかもしれないが冪等）。
      await markVolumeBoosterTabActive(tabId);
      return res;
    }
    if (res && res.error !== "invalid-stream-id") {
      return res;
    }
    // res が undefined or invalid-stream-id → fresh 取得経路へ
  }

  // 新規接続: tabCapture から streamId を取得。
  // Chrome 119+ の Promise.withResolvers() で callback と Promise の参照位置を物理的に近く保つ
  // (/opop MN-2 適用、minimum_chrome_version 140 で利用可能)
  // __FIREFOX_STRIP_BEGIN__: Firefox MV3 は chrome.tabCapture 未対応のため build 時に削除。
  // この関数は HAS_VOLUME_BOOSTER guard により Firefox では呼ばれず、また到達前に
  // ensureOffscreenDocument が false を返して早期 return するため、strip しても実害ゼロ。
  let streamId = null;
  try {
    const { promise, resolve, reject } = Promise.withResolvers();
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(id);
    });
    streamId = await promise;
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  // __FIREFOX_STRIP_END__

  if (operationGeneration !== volumeReleaseGeneration) {
    return { ok: false, error: "release-all-during-set" };
  }

  try {
    const res = await chrome.runtime.sendMessage({
      target: Offscreen.TARGET,
      action: Offscreen.ACTION_VOLUME_SET_GAIN,
      tabId,
      streamId,
      gain: clamped,
      antiClip: antiClipFlag,
      nightMode: nightModeFlag,
      bassCut: bassCutFlag,
      muted: mutedFlag,
      eqEnabled: eqActiveFlag,
      eqGains,
      eqPreamp,
    });
    if (operationGeneration !== volumeReleaseGeneration) {
      if (res?.ok) await releaseVolumeBoosterTabDirect(tabId).catch(() => {});
      return { ok: false, error: "release-all-during-set" };
    }
    // P2-#19: 成功時のみローカルキャッシュに登録。失敗（offscreen エラー / no-response）の場合は
    // ブースト中状態にならないため Set には追加しない。
    // /rere B1-006 修正: markVolumeBoosterTabActive が false (= getMediaStreamId 完了後に
    // onRemoved がタブを閉じた race window で removedVolumeBoosterTabIds.has() がヒット →
    // release 実行 + false 返却) の場合、caller の res に整合性結果を反映する。旧実装では
    // markVolumeBoosterTabActive の戻り値を捨てて res をそのまま返していたため、popup 側で
    // 「offscreen ok だがタブは既に閉じられている」という整合性破れの ok:true を受けていた。
    if (res?.ok) {
      const marked = await markVolumeBoosterTabActive(tabId);
      if (!marked) {
        return { ok: false, error: "tab-closed-during-init" };
      }
    }
    return res ?? { ok: false, error: "no-response" };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
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
  return await enqueueVolumeTabOperation(tabId, () => releaseVolumeBoosterTabDirect(tabId));
}

// タブキュー内部専用。SET operation内からqueued wrapperを再入すると自己deadlockするため、
// UNITY・stale cleanup・タブ閉鎖検出からはこちらを呼ぶ。
async function releaseVolumeBoosterTabDirect(tabId) {
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
