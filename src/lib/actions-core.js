"use strict";

// 定義を globalThis で共有し、同じフレームでの再評価時も参照を維持する。
(() => {
  if (globalThis.__cpaActionsCoreLoaded === true) return;
  globalThis.__cpaActionsCoreLoaded = true;

/** @readonly メッセージアクション定義 */
const Actions = Object.freeze({
  /** ポップアップ → background: 設定変更を反映 */
  APPLY_SETTINGS: "applySettings",
  IMPORT_SETTINGS: "importSettings",
  /** background → YouTube content script: YouTube 機能拡張設定を反映（Shorts 削除も含む） */
  APPLY_SEARCH_FIXER_CS: "applySearchFixerCS",
  /** background → Amazon 定期おトク便 content script: 合計金額表示の有効/無効を反映 */
  APPLY_AMAZON_DELIVERY_TOTAL_CS: "applyAmazonDeliveryTotalCS",
  /** background → Amazon ランキング移動 content script: 「ランキングへ移動」ボタンの有効/無効を反映 */
  APPLY_AMAZON_RANKING_JUMP_CS: "applyAmazonRankingJumpCS",
  /** background → Amazon 販売元・出荷元バッジ content script: バッジ表示の有効/無効を反映 */
  APPLY_AMAZON_MERCHANT_INFO_CS: "applyAmazonMerchantInfoCS",
  /** background → Instagram content script: Instagram クリーナー設定を反映 */
  APPLY_INSTAGRAM_CLEANER_CS: "applyInstagramCleanerCS",
  /** background → TikTok content script: TikTok クリーナー設定を反映 */
  APPLY_TIKTOK_CLEANER_CS: "applyTiktokCleanerCS",
  /** background → X content script: X クリーナー設定を反映 */
  APPLY_X_CLEANER_CS: "applyXCleanerCS",
  APPLY_WIKIPEDIA_CS: "applyWikipediaCS",
  /** background → video-gamma content script: <video> ガンマ補正設定を反映（全タブ共通設定） */
  APPLY_VIDEO_GAMMA_CS: "applyVideoGammaCS",
  /** background → video-fill content script: <video> 黒帯除去（ズーム/引き伸ばし）設定を反映（全タブ共通設定） */
  APPLY_VIDEO_FILL_CS: "applyVideoFillCS",
  /** background → loupe content script: ルーペ機能の有効/無効を反映 */
  APPLY_LOUPE_CS: "applyLoupeCS",
  /** popup → background: 音量ブースターの gain を指定タブで変更 */
  VOLUME_BOOSTER_SET_GAIN: "volumeBoosterSetGain",
  /** loupe content script → background: 現在タブのスクリーンキャプチャを要求し、JPEG DataURL を取得する */
  LOUPE_REQUEST_CAPTURE: "loupeRequestCapture",
  /** youtube-notebooklm content script → background: NotebookLM のノートブック一覧を取得する */
  NOTEBOOK_LM_LIST: "notebookLmList",
  /** youtube-notebooklm content script → background: 指定 URL 群を NotebookLM のソースとして追加する */
  NOTEBOOK_LM_SEND: "notebookLmSend",
  /** youtube-notebooklm content script → background: ログイン中の Google アカウント一覧を取得する */
  NOTEBOOK_LM_ACCOUNTS: "notebookLmAccounts",
});

/**
 * @readonly Extension ページのパス。`chrome.runtime.getURL` と組み合わせて
 * `sender.url` の照合に使う。manifest.json のパスと完全一致させること。
 */
const ExtensionPaths = Object.freeze({
  BACKGROUND: "src/background/background.js",
  POPUP: "src/popup/popup.html",
  OFFSCREEN: "src/offscreen/offscreen.html",
});

/**
 * @readonly sender 検証ヘルパー（content script / offscreen 共通）。
 *
 * 各送信元 (popup / content / offscreen / background) のメッセージを
 * 受信側で確実に区別するため、id + tab 不在 + url 一致の三層で判定する。
 */
const SenderCheck = Object.freeze({
  /** sender が background SW 由来か（content / offscreen から呼ぶ）。 */
  isFromBackground(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (sender.tab) return false;
    return sender.url === chrome.runtime.getURL(ExtensionPaths.BACKGROUND);
  },
  /** sender が popup 由来か（background から呼ぶ）。 */
  isFromPopup(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (sender.tab) return false;
    return sender.url === chrome.runtime.getURL(ExtensionPaths.POPUP);
  },
  /** sender が offscreen document 由来か（background から呼ぶ）。 */
  isFromOffscreen(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (sender.tab) return false;
    return sender.url === chrome.runtime.getURL(ExtensionPaths.OFFSCREEN);
  },
  /** sender が content script 由来か（background から呼ぶ）。 */
  isFromContentScript(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    return typeof sender.tab?.id === "number";
  },
});

/** @readonly ストレージキー */
const StorageKeys = Object.freeze({
  WIKIPEDIA_ENABLED: "wikipediaEnabled",
  WIKIPEDIA_FEATURES: "wikipediaFeatures",
  WIKIPEDIA_APPEARANCE: "wikipediaAppearance",
  /** PC ごとの同期オプトインと、同期処理のローカル管理情報。 */
  SETTINGS_SYNC_ENABLED: "settingsSyncEnabled",
  SETTINGS_SYNC_STATE: "_settingsSyncState",
  SETTINGS_SYNC_STATUS: "_settingsSyncStatus",
  SETTINGS_SYNC_RETRY: "_settingsSyncRetry",
  SETTINGS_SYNC_APPLIED: "_settingsSyncApplied",
  /** YouTube 機能拡張マスタートグル（Shorts 削除・コメント欄非表示・ライブチャット非表示・登録チャンネル拡張を含む全 40 サブ機能の親） */
  SEARCH_FIXER_ENABLED: "searchFixerEnabled",
  /** YouTube 機能拡張の個別機能オン/オフ（オブジェクト） */
  SEARCH_FIXER_FEATURES: "searchFixerFeatures",
  YOUTUBE_PLAYER_SETTINGS: "youtubePlayerSettings",
  /** ホームページのリッチグリッド列数（0 = YouTube デフォルト、4/5/6 が選択肢） */
  SEARCH_FIXER_GRID_ITEMS: "searchFixerGridItems",
  /** 検索結果から除外するチャンネルのリスト（{key, name} 配列。key = "@handle" 小文字 or "UC..." チャンネル ID）。
   *  popup / content script → background（UPDATE_BLOCKED_CHANNELS）の保存キュー経由で更新する
   *  （SettingsSchema 非経由、content script は storage.onChanged で購読）。 */
  SEARCH_FIXER_BLOCKED_CHANNELS: "searchFixerBlockedChannels",
  /** NotebookLM 送信の送信先 Google アカウント（`authuser` インデックス、0 = 既定）。
   *  content script → background（SAVE_NOTEBOOK_ACCOUNT）の保存キュー経由で更新する（SettingsSchema 非経由）。マルチログイン環境で
   *  意図しないアカウントへ動画 URL が入るのを防ぐ（/rere D-5）。 */
  NOTEBOOK_LM_ACCOUNT_INDEX: "notebookLmAccountIndex",
  /** ログイン中 Google アカウント一覧のキャッシュ（`{at, accounts}`、background 直書き）。
   *  probe は 1 アカウントあたり数十 KB の取得になるため、TTL 付きで使い回す。 */
  NOTEBOOK_LM_ACCOUNTS_CACHE: "notebookLmAccountsCache",
  /** Amazon 定期おトク便ページの月別合計金額表示の有効/無効 */
  AMAZON_DELIVERY_TOTAL_ENABLED: "amazonDeliveryTotalEnabled",
  /** Amazon 商品ページに「この商品が所属するランキングへ移動」ボタンを表示するか（オプトイン・デフォルト OFF） */
  AMAZON_RANKING_JUMP_ENABLED: "amazonRankingJumpEnabled",
  /** Amazon 商品ページに販売元・出荷元バッジを表示するか（オプトイン・デフォルト OFF）。
   *  Amazon 直販と マーケット出品 を視覚的に区別する（直販=緑 / マーケット=オレンジ警告色）。 */
  AMAZON_MERCHANT_INFO_ENABLED: "amazonMerchantInfoEnabled",
  /** Instagram クリーナーマスタートグル */
  INSTAGRAM_CLEANER_ENABLED: "instagramCleanerEnabled",
  /** Instagram クリーナーの個別機能オン/オフ（オブジェクト） */
  INSTAGRAM_CLEANER_FEATURES: "instagramCleanerFeatures",
  /** TikTok クリーナーマスタートグル */
  TIKTOK_CLEANER_ENABLED: "tiktokCleanerEnabled",
  /** TikTok クリーナーの個別機能オン/オフ（オブジェクト） */
  TIKTOK_CLEANER_FEATURES: "tiktokCleanerFeatures",
  /** X クリーナーマスタートグル */
  X_CLEANER_ENABLED: "xCleanerEnabled",
  /** X クリーナーの個別機能オン/オフ（オブジェクト） */
  X_CLEANER_FEATURES: "xCleanerFeatures",
  /** 音量ブースター: マスタートグル（OFF 時は全タブの AudioContext を解放しパイプラインをカット。設定値は残す） */
  VOLUME_BOOSTER_ENABLED: "volumeBoosterEnabled",
  /** 音量ブースター: 保存されたスライダー位置 (0–300%)。マスター ON 時にタブ切替で自動適用される */
  VOLUME_BOOSTER_LAST_GAIN: "volumeBoosterLastGain",
  /** 音量ブースター: 自動歪み防止（DynamicsCompressor でピークを抑制） */
  VOLUME_BOOSTER_ANTI_CLIP_ENABLED: "volumeBoosterAntiClipEnabled",
  /** 音量ブースター: ナイトモード（ゲーム配信用途） */
  VOLUME_BOOSTER_NIGHT_MODE_ENABLED: "volumeBoosterNightModeEnabled",
  /** 音量ブースター: 壁ドン対策モード（highpass フィルタで低音をカットし、壁・床への振動伝達を抑える） */
  VOLUME_BOOSTER_BASS_CUT_ENABLED: "volumeBoosterBassCutEnabled",
  /** 音量ブースター: ミュート（スライダー値・サブトグル設定は保持したまま gain を 0 にランプ）。
   *  グローバル設定で、ON 中は UNITY release 条件をブロックして AudioContext を維持する。 */
  VOLUME_BOOSTER_MUTED_ENABLED: "volumeBoosterMutedEnabled",
  /** 音量ブースター: グラフィックイコライザ ON/OFF（10 バンド peaking フィルタ） */
  VOLUME_BOOSTER_EQ_ENABLED: "volumeBoosterEqEnabled",
  /** 音量ブースター: イコライザ各バンドの gain 配列 (dB, 10 要素、VolumeBooster.EQ_BANDS と同順) */
  VOLUME_BOOSTER_EQ_GAINS: "volumeBoosterEqGains",
  /** 音量ブースター: イコライザのプリアンプ (dB)。各バンド boost によるクリップ補正用 */
  VOLUME_BOOSTER_EQ_PREAMP: "volumeBoosterEqPreamp",
  /** 音量ブースター: イコライザの選択中プリセット id（VolumeBooster.EQ_PRESETS のキー or "custom"） */
  VOLUME_BOOSTER_EQ_PRESET: "volumeBoosterEqPreset",
  /** 動画ガンマ補正: マスタートグル（OFF 時は SVG filter 一切注入せず completely no-op） */
  VIDEO_GAMMA_ENABLED: "videoGammaEnabled",
  // サブ機能として searchFixerEnabled (master) AND で制御する (Shorts 5 サブ機能と同じ統合方式)。
  /** 動画ガンマ補正: ガンマ値（VideoGamma.MIN..MAX、デフォルト 1.0 = 補正なし） */
  VIDEO_GAMMA_VALUE: "videoGammaValue",
  /** 動画黒帯除去: マスタートグル（OFF または拡大率 1.0 のとき style 一切注入せず completely no-op、オプトイン） */
  VIDEO_FILL_ENABLED: "videoFillEnabled",
  /** 動画黒帯除去: 表示モード（"zoom" = アスペクト維持で拡大クロップ / "stretch" = 不足軸のみ引き伸ばし） */
  VIDEO_FILL_MODE: "videoFillMode",
  /** 動画黒帯除去: 目標モニターのプリセット id（VideoFill.PRESETS のいずれか、デフォルト "21:9"）。
   *  動画側の縦横比は content script が videoWidth/videoHeight から自動検出するため保存しない。 */
  VIDEO_FILL_TARGET: "videoFillTarget",
  /** ルーペ: マスタートグル（OFF 時は content script のレンズ DOM を即座に撤去し、リスナも全て解除） */
  LOUPE_ENABLED: "loupeEnabled",
  /** ルーペ: 倍率（Loupe.ZOOM_LEVELS のいずれか、デフォルト 2.5）。popup の倍率セグメントで選択 */
  LOUPE_ZOOM: "loupeZoom",
  /** ルーペ: レンズ直径 px（Loupe.SIZE_MIN..MAX、デフォルト 220）。popup のスライダーで可変 */
  LOUPE_SIZE: "loupeSize",
  /** カラーピッカー: 採取した色の履歴（最新が先頭。各要素 {hex, ts} の最大 20 件） */
  COLOR_PICKER_HISTORY: "colorPickerHistory",
  /** カラーピッカー: 既定の保存形式 ("hex" | "rgb" | "hsl") */
  COLOR_PICKER_DEFAULT_FORMAT: "colorPickerDefaultFormat",
  /** カラーピッカー: HEX コピー時に # を含めるか (boolean, default true) */
  COLOR_PICKER_HEX_HASH: "colorPickerHexHash",
  /** ポップアップで最後に開いていたタブ (PopupTabs.ALL のいずれか) */
  POPUP_LAST_TAB: "popupLastTab",
  /** ポップアップで最後に開いていたサブタブ（親タブ id → サブタブ id のレコード）。
   *  例 `{ tune: "video", youtube: "watch_page" }`。値の妥当性は各タブの構築時に
   *  「その id のサブタブが実在するか」で判定するので、ここでは形だけ正規化する。 */
  POPUP_LAST_SUBTAB: "popupLastSubTab",
  /** インストール / 起動 sentinel。`onInstalled` で必ず 1 を書き込み、popup 起動時に消失していたら
   *  `chrome.storage.local` が破損・リセットされた可能性として開発者コンソールに警告を出す（#3）。
   *  接頭辞 "_" でユーザー向け設定キーと区別する。 */
  INSTALL_SENTINEL: "_installSentinel",
  /** 表示言語の選択（"auto" 相当は未設定）。ポップアップのヘッダーで切り替える。端末内のみ（同期・バックアップ対象外）。 */
  UI_LANGUAGE: "uiLanguage",
  /** 選択した言語の文言（`Localizer.compact` の形）。コンテンツスクリプトも同じ言語で表示するため storage に置く。 */
  UI_MESSAGES: "uiMessages",
  /** `uiMessages` を作ったときの拡張機能の版。更新で文言が変わったら、新しい版の文言へ作り直す判定に使う。 */
  UI_VERSION: "uiMessagesVersion",
});

/**
 * 表示言語の切り替え。拡張機能の標準の `chrome.i18n` はブラウザの UI 言語に固定で変更できないため、
 * 利用者が選んだ言語の文言（_locales の messages.json）を storage に保存し、`chrome.i18n.getMessage` /
 * `getUILanguage` をその言語を優先する版に差し替える（既存の呼び出し箇所は変更不要）。
 * 未選択（自動）やキーが無いときはブラウザ標準の動作に戻す。manifest の `__MSG_*__`（拡張機能名・
 * ショートカットの説明）はブラウザが処理するため、ブラウザの言語のまま。
 */
const Localizer = (() => {
  const LANGUAGES = Object.freeze([
    Object.freeze({ code: "en", name: "English" }),
    Object.freeze({ code: "ja", name: "日本語" }),
    Object.freeze({ code: "zh_CN", name: "简体中文" }),
    Object.freeze({ code: "zh_TW", name: "繁體中文" }),
    Object.freeze({ code: "ko", name: "한국어" }),
    Object.freeze({ code: "es", name: "Español" }),
    Object.freeze({ code: "fr", name: "Français" }),
    Object.freeze({ code: "de", name: "Deutsch" }),
    Object.freeze({ code: "pt_BR", name: "Português (Brasil)" }),
  ]);
  const CODES = LANGUAGES.map((language) => language.code);
  const normalizeCode = (raw) => (CODES.includes(raw) ? raw : null);
  /** `zh_CN` → `zh-CN`（html の lang 属性用） */
  const toTag = (code) => String(code).replace("_", "-");

  /** messages.json を保存用に圧縮する（description を捨て、{ key: { m, p? } } にする）。 */
  function compact(json) {
    const out = {};
    if (!json || typeof json !== "object") return out;
    for (const [key, entry] of Object.entries(json)) {
      if (typeof entry?.message !== "string") continue;
      out[key] = entry.placeholders ? { m: entry.message, p: entry.placeholders } : { m: entry.message };
    }
    return out;
  }

  /** `$NAME$`（placeholders）→ `$1`…`$9`（引数）の順に置換する。Chrome の getMessage と同じ規則。 */
  function format(entry, substitutions) {
    const args = substitutions === undefined || substitutions === null ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
    let text = entry.m;
    if (entry.p) {
      for (const [name, value] of Object.entries(entry.p)) {
        text = text.replace(new RegExp(`\\$${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\$`, "gi"), () => String(value?.content ?? ""));
      }
    }
    return text.replace(/\$([1-9])|\$\$/g, (match, digit) => (digit ? String(args[Number(digit) - 1] ?? "") : "$"));
  }

  let code = null;
  let messages = null;
  let nativeGetMessage = null;
  let nativeGetUILanguage = null;

  /** 差し替えが実際に効いたか。効かない環境では選んだ言語を名乗らず、ブラウザ標準の言語のまま動かす。 */
  let installed = false;
  const KEYS = [StorageKeys.UI_LANGUAGE, StorageKeys.UI_MESSAGES, StorageKeys.UI_VERSION];

  function apply(stored) {
    const next = normalizeCode(stored?.[StorageKeys.UI_LANGUAGE]);
    const dictionary = stored?.[StorageKeys.UI_MESSAGES];
    code = installed && next && dictionary && typeof dictionary === "object" ? next : null;
    messages = code ? dictionary : null;
  }

  const currentVersion = () => { try { return chrome.runtime.getManifest().version; } catch { return null; } };
  const reload = () => chrome.storage.local.get(KEYS).then(apply).catch(() => {});

  /** 選んだ言語の文言を同梱の messages.json から読み、保存する（ポップアップの選択・更新後の再作成が使う）。 */
  async function save(raw) {
    const target = normalizeCode(raw);
    if (!target) throw new Error("unsupported-language");
    const response = await fetch(chrome.runtime.getURL(`_locales/${target}/messages.json`));
    if (!response.ok) throw new Error("locale-fetch-failed");
    const dictionary = compact(await response.json());
    await chrome.storage.local.set({ [StorageKeys.UI_LANGUAGE]: target, [StorageKeys.UI_MESSAGES]: dictionary, [StorageKeys.UI_VERSION]: currentVersion() });
  }

  /**
   * 拡張機能の更新後に、保存済みの辞書が古い版のままなら作り直す。更新でキーが増えたり文言が変わっても、
   * 選んだ言語とブラウザ標準の言語が混ざらないようにする（background の onInstalled とポップアップの起動時が呼ぶ）。
   */
  async function ensureFresh() {
    try {
      const stored = await chrome.storage.local.get(KEYS);
      const target = normalizeCode(stored[StorageKeys.UI_LANGUAGE]);
      if (target && stored[StorageKeys.UI_VERSION] !== currentVersion()) {
        await save(target);
        await reload();
      }
    } catch { /* 作り直せなければ保存済みの辞書で続ける */ }
  }

  function install() {
    const api = typeof chrome !== "undefined" ? chrome : null;
    if (!api?.i18n?.getMessage || !api?.storage?.local) return Promise.resolve();
    nativeGetMessage = api.i18n.getMessage.bind(api.i18n);
    nativeGetUILanguage = api.i18n.getUILanguage?.bind(api.i18n);
    const wrapper = (key, substitutions) => {
      const entry = messages?.[key];
      if (entry && typeof entry.m === "string") return format(entry, substitutions);
      return nativeGetMessage(key, substitutions);
    };
    try {
      api.i18n.getMessage = wrapper;
      if (nativeGetUILanguage) api.i18n.getUILanguage = () => (code ? toTag(code) : nativeGetUILanguage());
    } catch {
      // 代入できない環境では次の defineProperty を試す。
    }
    if (api.i18n.getMessage !== wrapper) {
      try { Object.defineProperty(api.i18n, "getMessage", { value: wrapper, configurable: true, writable: true }); } catch { /* 差し替え不可 */ }
    }
    // 差し替えが効いたときだけ選んだ言語を使う（効かないのに言語だけ名乗ると、表示と選択がずれる）。
    installed = api.i18n.getMessage === wrapper;
    try {
      api.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !(StorageKeys.UI_LANGUAGE in changes || StorageKeys.UI_MESSAGES in changes)) return;
        reload();
      });
    } catch { /* 文書破棄中 */ }
    return reload();
  }

  const ready = install();
  return Object.freeze({ LANGUAGES, normalizeCode, toTag, compact, format, save, ensureFresh, ready, get code() { return code; }, get installed() { return installed; } });
})();

  globalThis.Actions = Actions;
  globalThis.ExtensionPaths = ExtensionPaths;
  globalThis.SenderCheck = SenderCheck;
  globalThis.StorageKeys = StorageKeys;
  globalThis.Localizer = Localizer;
})();
