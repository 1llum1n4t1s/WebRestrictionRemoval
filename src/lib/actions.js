"use strict";

// P0-#2: content_scripts のスコープ共有依存を断つため IIFE wrap + globalThis 公開方式に変更。
// 旧設計は「Chrome の同一拡張・同一ページの content scripts は同一 isolated world で script scope 共有」
// という Chrome の文書化されていない実装詳細に依存していた（Chrome 公式 API ドキュメントに記述なし）。
// 新設計:
//   1. 全定数を IIFE で wrap し、`globalThis.X` にアサインして明示的に共有する
//   2. 同一ファイルが複数 content_scripts エントリ経由で再評価されても `__cpaActionsLoaded` ガードで安全
//   3. manifest.json の各 content_scripts エントリで `actions.js` を先頭に追加して、スコープ共有に
//      頼らずとも各エントリ単独で全定数にアクセスできる
//   4. background は `importScripts` で 1 度だけ読み、再評価しない
// `Actions.X` のような bare 名アクセスは globalThis のプロパティとして JS 言語仕様上そのまま動く。
(() => {
  if (globalThis.__cpaActionsLoaded === true) return;
  globalThis.__cpaActionsLoaded = true;

/** @readonly メッセージアクション定義 */
const Actions = Object.freeze({
  /** ポップアップ → background: 設定変更を反映 */
  APPLY_SETTINGS: "applySettings",
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
  /** background → video-gamma content script: <video> ガンマ補正設定を反映（全タブ共通設定） */
  APPLY_VIDEO_GAMMA_CS: "applyVideoGammaCS",
  /** background → video-fill content script: <video> 黒帯除去（ズーム/引き伸ばし）設定を反映（全タブ共通設定） */
  APPLY_VIDEO_FILL_CS: "applyVideoFillCS",
  /** background → loupe content script: ルーペ機能の有効/無効を反映 */
  APPLY_LOUPE_CS: "applyLoupeCS",
  // 接続モニターは YouTube 機能拡張のサブ機能 (searchFixerFeatures.connectionMonitor) に統合済み。
  // 独自 action は持たず APPLY_SEARCH_FIXER_CS を購読する (youtube-shorts.js と同方式)。
  /** popup → background: 音量ブースターの gain を指定タブで変更 */
  VOLUME_BOOSTER_SET_GAIN: "volumeBoosterSetGain",
  /** popup → background: 指定タブのブーストを解放（スライダー 100% 復帰時） */
  VOLUME_BOOSTER_RELEASE_TAB: "volumeBoosterReleaseTab",
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
  /** sender が content script 由来か（background から呼ぶ）。 */
  isFromContentScript(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    return typeof sender.tab?.id === "number";
  },
});

/** @readonly Offscreen Document 関連定数（音量ブースター専用） */
const Offscreen = Object.freeze({
  PATH: "src/offscreen/offscreen.html",
  TARGET: "offscreen",
  /** 音量ブースト: 指定タブの gain を設定（必要なら AudioContext を新規構築） */
  ACTION_VOLUME_SET_GAIN: "volumeSetGain",
  /** 音量ブースト: 指定タブの現在 gain を取得（未登録タブなら null を返す） */
  ACTION_VOLUME_GET_GAIN: "volumeGetGain",
  /** 音量ブースト: 指定タブの AudioContext を解放 */
  ACTION_VOLUME_RELEASE_TAB: "volumeReleaseTab",
  /** 音量ブースト: 全タブの AudioContext を解放 */
  ACTION_VOLUME_RELEASE_ALL: "volumeReleaseAll",
  /** 音量ブースト: 現在 boost 中のタブ数を返す（アイドル close 判定に使用） */
  ACTION_VOLUME_QUERY_ACTIVE: "volumeQueryActive",
  /** 使用後のアイドル close 待機時間（ms）。tabCapture 系の連続操作を吸収できる長さ */
  IDLE_MS: 30_000,
  /**
   * createDocument の reasons 配列。tabCapture (USER_MEDIA) + AudioContext 出力 (AUDIO_PLAYBACK)。
   */
  REASONS: Object.freeze(["USER_MEDIA", "AUDIO_PLAYBACK"]),
});

/** @readonly ストレージキー */
const StorageKeys = Object.freeze({
  /** YouTube 機能拡張マスタートグル（Shorts 削除・コメント欄非表示・ライブチャット非表示・登録チャンネル拡張を含む全 34 サブ機能の親） */
  SEARCH_FIXER_ENABLED: "searchFixerEnabled",
  /** YouTube 機能拡張の個別機能オン/オフ（オブジェクト） */
  SEARCH_FIXER_FEATURES: "searchFixerFeatures",
  /** ホームページのリッチグリッド列数（0 = YouTube デフォルト、4/5/6 が選択肢） */
  SEARCH_FIXER_GRID_ITEMS: "searchFixerGridItems",
  /** 検索結果から除外するチャンネルのリスト（{key, name} 配列。key = "@handle" 小文字 or "UC..." チャンネル ID）。
   *  popup → storage 直書きパターン（SettingsSchema 非経由、content script は storage.onChanged で購読）。 */
  SEARCH_FIXER_BLOCKED_CHANNELS: "searchFixerBlockedChannels",
  /** NotebookLM 送信の送信先 Google アカウント（`authuser` インデックス、0 = 既定）。
   *  content script → storage 直書きパターン（SettingsSchema 非経由）。マルチログイン環境で
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
  /** 音量ブースター: 自動歪み防止（DynamicsCompressor で hard limit 化） */
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
  // 接続モニターは独立 storage key を持たず、YouTube 機能拡張の searchFixerFeatures.connectionMonitor
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
  /** インストール / 起動 sentinel。`onInstalled` で必ず 1 を書き込み、popup 起動時に消失していたら
   *  `chrome.storage.local` が破損・リセットされた可能性として開発者コンソールに警告を出す（#3）。
   *  接頭辞 "_" でユーザー向け設定キーと区別する。 */
  INSTALL_SENTINEL: "_installSentinel",
});

/**
 * @readonly YouTube Shorts 関連の定数（独自実装）。
 *
 * v1.0.x で「Shorts 関連」単独カテゴリを廃止し、Shorts に関する各機能を他のフィルタ機能と
 * 同列に並べる方針に変更。実装としては以下の独立トグルが動作する:
 *   - `removeShortsShelf`:   Shorts 棚（ホーム / 検索）削除 → 動画フィルタカテゴリ
 *   - `removeShortsChip`:    Shorts フィルタチップ（検索ページ上部のタブ）削除 → 検索結果カテゴリ
 *   - `removeShortsSidebar`: 左サイドバーの「ショート」メニュー削除 → メニュー/UI カテゴリ
 *   - `redirectShortsUrl`:   `/shorts/<id>` URL を `/watch?v=<id>` にリダイレクト → 動画ページカテゴリ
 * 個別 Shorts 動画の削除は search-fixer.js の `shortsBtn` 機能（動画フィルタ）が担当。
 *
 * `searchFixerEnabled` (master) AND 上記いずれかが true のときに youtube-shorts.js が起動する。
 */
const YouTubeShorts = Object.freeze({
  /**
   * Shorts 棚の DOM 削除セレクタ。`removeShortsShelf` 機能用。
   * 検索結果の横並び棚 (ytd-reel-shelf-renderer)、ホームの Shorts 棚
   * (ytd-rich-shelf-renderer[is-shorts])、モバイル版両者を含む。
   */
  SELECTORS_SHELF: Object.freeze([
    "ytd-reel-shelf-renderer",
    "ytd-rich-shelf-renderer[is-shorts]",
    "ytm-reel-shelf-renderer",
    "ytm-rich-section-renderer",
  ]),
  /**
   * Shorts フィルタチップの DOM 削除セレクタ。`removeShortsChip` 機能用。
   * 検索ページ上部のフィルタチップ群（「すべて / 動画 / Shorts / プレイリスト / ...」）の中で
   * textContent === "Shorts" のものだけを除去する（他のチップを巻き込まない判定は
   * youtube-shorts.js の purge ループで CHIP_LABEL を使って行う）。
   */
  SELECTORS_CHIP: Object.freeze([
    "yt-chip-cloud-chip-renderer:has(#text)",
  ]),
  /**
   * 左サイドバーの「ショート」メニューエントリ削除セレクタ。`removeShortsSidebar` 機能用。
   *   - ytd-guide-entry-renderer:      フル展開時のメインエントリ
   *   - ytd-mini-guide-entry-renderer: 折りたたみ時のアイコンのみエントリ
   *
   * YouTube SPA の Shorts エントリは <a> に href を持たず、click handler で reelWatchEndpoint へ
   * 遷移する設計のため、href 属性ではマッチしない（ChromeMCP 実機検証で確認済み: href=null）。
   * 代わりに `title="ショート"` / `title="Shorts"` で識別する。日英 2 言語カバーで日本語ユーザー
   * 主体の本拡張機能ではほぼ全数を捕捉できる。他ロケール（中文/韓国語等）は要望次第で追加する。
   */
  SELECTORS_SIDEBAR: Object.freeze([
    'ytd-guide-entry-renderer:has(a[title="ショート"])',
    'ytd-guide-entry-renderer:has(a[title="Shorts"])',
    'ytd-mini-guide-entry-renderer:has(a[title="ショート"])',
    'ytd-mini-guide-entry-renderer:has(a[title="Shorts"])',
  ]),
  CHIP_LABEL: "Shorts",
  SHORTS_PATH_RE: /\/shorts\/([\w-]{6,})/,
  URL_POLL_MS: 1000,
});

/**
 * @readonly YouTube 機能拡張の機能定義と定数（独自実装）。変数名は履歴的に `SearchFixer` を使用。
 *
 * YouTube の検索結果・動画ページ・ホームグリッドの冗長 UI を非表示にするための
 * クライアントサイド DOM/CSS 操作。外部送信ゼロのプライバシー方針。設定は
 * `chrome.storage.local` の `searchFixerFeatures` キー（オブジェクト）と
 * `searchFixerGridItems`（数値）で保持する。
 *
 * セレクタは YouTube が公開する DOM 要素タグ名（`ytd-video-renderer` 等）に依存する事実情報。
 */
const SearchFixerFeatures = Object.freeze([
  // === カテゴリ "video_filter": 動画フィルタ（検索結果ページ + ホーム / 登録チャンネル / 急上昇等のフィードページで動作）===
  // ChromeMCP 実機検証済みの 5 機能 + Shorts 棚削除。yt-lockup-view-model 系フィードと
  // 検索結果 ytd-video-renderer の両方で同じ判定ロジックを適用する（検索専用 DOM の機能は
  // category="search_only" を参照）。
  // ラベル / 説明文は _locales/{en,ja}/messages.json の `feat_sf_<key>_{label,desc}` を参照。
  Object.freeze({ key: "playlist", category: "video_filter" }),
  Object.freeze({ key: "mix", category: "video_filter" }),
  Object.freeze({ key: "shortsBtn", category: "video_filter" }),
  Object.freeze({ key: "removeShortsShelf", category: "video_filter" }),
  Object.freeze({ key: "live", category: "video_filter" }),
  Object.freeze({ key: "membersOnly", category: "video_filter" }),
  Object.freeze({ key: "watched", category: "video_filter" }),
  // ホームのおすすめセクション一括除去（「その他のトピック」「ニュース速報」「ゲームルーム」）。
  // 旧 removeTopicsSection / removeBreakingNewsSection を統合した機能（background の onInstalled で転写）。
  Object.freeze({ key: "removeFeedSections", category: "video_filter" }),
  // チャンネルブロックリスト: YouTube ホームの公式「このチャンネルは表示しない」に相当する機能を
  // 独自拡張した版。登録は検索結果カードの登録ボタンから行うが、除去自体は検索結果 /
  // ホーム・登録チャンネル・急上昇等のフィードページ双方の動画カードに一律適用される
  // （2026-07-14 に検索結果限定から拡張。yt-lockup-view-model はメタデータ内のチャンネル名が
  // `a.ytAttributedStringLink[href^="/channel/"|"/@"]` としてリンク化されておりキー抽出可能な
  // ことを実機確認済み。視聴ページの関連動画欄はプレーンテキストでリンクが無いため対象外）。
  // リストは popup で管理（一覧 + 個別解除）。
  Object.freeze({ key: "channelBlocklist", category: "video_filter" }),
  // 海外チャンネル除外: 自分の国以外のチャンネルの動画をフィード / 検索結果から除去する。
  // YouTube 標準の検索フィルタには国の条件が無い（「場所」は動画のジオタグ絞り込みで別物）ため
  // 独自実装。判定は 2 段のハイブリッド:
  //   1. 言語ヒューリスティック（純粋関数 detectTextOrigin）— タイトル + チャンネル名の文字種で即決。
  //      fetch ゼロ。自国固有スクリプト（日本語なら仮名）があれば home、別スクリプトなら foreign。
  //   2. 1 で決まらない (unknown = ラテン文字のみ / 漢字のみ) カードだけ、チャンネルの
  //      `/@handle/about` を **同一オリジン** fetch して `"country"` を読む（外部送信ゼロを維持）。
  //      結果はチャンネル単位で sessionStorage キャッシュ。国非公開チャンネルは判定不能 = 残す
  //      （fail-open。誤って自国チャンネルを消さないことを優先する）。
  Object.freeze({ key: "hideForeignChannels", category: "video_filter" }),
  // === カテゴリ "search_only": 検索結果（検索結果ページ固有の DOM のみが対象）===
  // shelf / cardList / course / channel / reel / secondary / chapter は検索結果ページ固有の DOM
  // 構造（ytd-shelf-renderer / ytd-channel-renderer 等）に依存。verified / artist は現状検索のみで
  // 動作（フィード対応は次版予定）。demoteUnmatched / highlightThumb / searchGrid は検索結果ページ
  // のレイアウトや装飾を直接いじる機能で、フィードには対応 DOM が無い。
  Object.freeze({ key: "shelf", category: "search_only" }),
  Object.freeze({ key: "cardList", category: "search_only" }),
  Object.freeze({ key: "course", category: "search_only" }),
  Object.freeze({ key: "channel", category: "search_only" }),
  Object.freeze({ key: "reel", category: "search_only" }),
  Object.freeze({ key: "secondary", category: "search_only" }),
  Object.freeze({ key: "verified", category: "search_only" }),
  Object.freeze({ key: "artist", category: "search_only" }),
  Object.freeze({ key: "chapter", category: "search_only" }),
  Object.freeze({ key: "demoteUnmatched", category: "search_only" }),
  Object.freeze({ key: "highlightThumb", category: "search_only" }),
  Object.freeze({ key: "hideComments", category: "watch_page" }),
  Object.freeze({ key: "hideLiveChat", category: "watch_page" }),
  // 接続モニター: ライブ配信視聴中のクルクル要因を切り分ける in-player HUD。
  // 拡張機能内で唯一の外部 fetch（Google generate_204 / Cloudflare cdn-cgi/trace への RTT 計測のみ）。
  // 実装は専用 content script youtube-connection-monitor.js（純粋ロジックは ConnectionMonitor namespace）。
  Object.freeze({ key: "connectionMonitor", category: "watch_page" }),
  // 配信時刻オーバーレイ: 配信アーカイブ (過去ライブの VOD) 再生中に、その瞬間が実際に配信
  // されていた時刻 (yyyy/MM/dd　hh:mm:ss) をプレーヤー内 HUD に重ねる。純粋ロジックは
  // BroadcastClock namespace、実装は専用 content script youtube-broadcast-clock.js。
  Object.freeze({ key: "broadcastClock", category: "watch_page" }),
  Object.freeze({ key: "redirectShortsUrl", category: "watch_page" }),
  Object.freeze({ key: "searchGrid", category: "search_only" }),
  Object.freeze({ key: "removeShortsChip", category: "search_only" }),
  // === カテゴリ "menu_ui": メニュー / UI（左サイドバーやレイアウト系）===
  Object.freeze({ key: "removeShortsSidebar", category: "menu_ui" }),
  // 登録チャンネル拡張 3 機能（YouTube が上限を持つ leftnav 表示と /feed/channels の縦長一覧を補強）。
  // /feed/channels は ytd-channel-renderer で全件 DOM に存在するためスキャンで全件取得可能。
  // leftnav は ytd-guide-section-renderer 内に「もっと見る」展開しても件数上限あり、
  // /feed/channels から取得した一覧を末尾に append して全件可視化する。
  Object.freeze({ key: "subsLeftnavInjectAll", category: "menu_ui" }),
  Object.freeze({ key: "subsAllShortcut", category: "menu_ui" }),
  Object.freeze({ key: "subsChannelsGrid", category: "menu_ui" }),
  // ホーム / 登録 / 急上昇等のフィードを隙間なく dense グリッド整列する。列数『自動』のときも
  // 有効化したいユーザー向けのトグル（4/5/6 列を選んだ場合は本トグル OFF でも従来どおりグリッド化）。
  Object.freeze({ key: "homeGrid", category: "menu_ui" }),
  // === カテゴリ "integration": 外部サービス連携 ===
  // NotebookLM 送信: 視聴中の動画 / 検索結果 / プレイリスト / チャンネルの動画を Google NotebookLM の
  // ソースとして追加する。**本拡張で唯一、ユーザー操作を起点にユーザー自身の Google アカウントへ
  // データ（動画 URL）を送る機能**（接続モニターの RTT 計測と並ぶ外部通信の例外）。実装は専用
  // content script youtube-notebooklm.js + background の NotebookLm RPC クライアント。
  Object.freeze({ key: "notebookLmSend", category: "integration" }),
]);

const SearchFixerDefaultFeatures = Object.freeze(
  Object.fromEntries(SearchFixerFeatures.map((feature) => [feature.key, false]))
);

/**
 * フィードページ判定で使う pathname プレフィックス一覧。
 * ルート "/" はホーム、`/feed/subscriptions` は登録チャンネル、`/feed/trending` は急上昇など。
 * 検索結果 "/results" はここには含まない（呼び出し側で別途判定）。
 *
 * v1.0.x で「適用範囲」セレクタを廃止し、動画フィルタは常時このフィードページ + 検索結果ページで動作する。
 */
const SearchFixerFeedPathPrefixes = Object.freeze([
  "/feed/subscriptions",
  "/feed/trending",
  "/feed/explore",
  "/feed/history",
  "/feed/library",
]);

/**
 * 海外チャンネル除外の言語ヒューリスティックで使うスクリプト（文字体系）判定。
 *
 * ラテン文字は「英語圏 = 自国」とも「英語タイトルを付けた自国チャンネル」とも取れて決め手に
 * ならないため、home / foreign のどちらにも直結させず unknown 側に倒す（about fetch で確定させる）。
 * 漢字 (Han) も日本語 / 中国語で共有されるため同じ扱い。
 */
const SearchFixerScriptTests = Object.freeze([
  Object.freeze({ id: "hiragana", re: /\p{Script=Hiragana}/u }),
  Object.freeze({ id: "katakana", re: /\p{Script=Katakana}/u }),
  Object.freeze({ id: "hangul", re: /\p{Script=Hangul}/u }),
  Object.freeze({ id: "cyrillic", re: /\p{Script=Cyrillic}/u }),
  Object.freeze({ id: "arabic", re: /\p{Script=Arabic}/u }),
  Object.freeze({ id: "hebrew", re: /\p{Script=Hebrew}/u }),
  Object.freeze({ id: "thai", re: /\p{Script=Thai}/u }),
  Object.freeze({ id: "devanagari", re: /\p{Script=Devanagari}/u }),
  Object.freeze({ id: "greek", re: /\p{Script=Greek}/u }),
]);

/**
 * 言語 → 「その言語圏に固有」と見なせるスクリプト。ここに載るスクリプトが本文にあれば home 確定。
 * 載っていない言語（en / de / fr 等のラテン文字圏）は home 確定に使える固有スクリプトが無いので
 * 空配列 = 常に unknown 経由で about fetch に回る。
 */
const SearchFixerHomeScripts = Object.freeze({
  ja: Object.freeze(["hiragana", "katakana"]),
  ko: Object.freeze(["hangul"]),
  th: Object.freeze(["thai"]),
  ru: Object.freeze(["cyrillic"]),
  uk: Object.freeze(["cyrillic"]),
  ar: Object.freeze(["arabic"]),
  he: Object.freeze(["hebrew"]),
  hi: Object.freeze(["devanagari"]),
  el: Object.freeze(["greek"]),
});

/** 地域サブタグを持たない言語コードから既定の地域を推定するフォールバック表。 */
const SearchFixerDefaultRegions = Object.freeze({
  ja: "JP", ko: "KR", th: "TH", vi: "VN", id: "ID", zh: "CN",
  en: "US", de: "DE", fr: "FR", es: "ES", pt: "BR", it: "IT",
  nl: "NL", pl: "PL", ru: "RU", uk: "UA", tr: "TR", ar: "SA",
  hi: "IN", sv: "SE", no: "NO", da: "DK", fi: "FI", cs: "CZ", el: "GR",
});

const SearchFixer = Object.freeze({
  FEATURES: SearchFixerFeatures,

  // category.label は _locales/.../messages.json の `category<CamelId>` (例: categoryMenuUi)。
  CATEGORIES: Object.freeze([
    Object.freeze({ id: "menu_ui",      icon: "🧭" }),
    Object.freeze({ id: "video_filter", icon: "🗑️" }),
    Object.freeze({ id: "watch_page",   icon: "🎬" }),
    Object.freeze({ id: "search_only",  icon: "🔍" }),
    Object.freeze({ id: "integration",  icon: "🔗" }),
  ]),

  DEFAULT_FEATURES: SearchFixerDefaultFeatures,

  // option.label は _locales/.../messages.json の `gridAuto` / `grid4Cols` / `grid5Cols` / `grid6Cols`。
  GRID_OPTIONS: Object.freeze([
    Object.freeze({ value: 0, messageKey: "gridAuto" }),
    Object.freeze({ value: 4, messageKey: "grid4Cols" }),
    Object.freeze({ value: 5, messageKey: "grid5Cols" }),
    Object.freeze({ value: 6, messageKey: "grid6Cols" }),
  ]),

  mergeFeatures(stored) {
    const out = { ...SearchFixer.DEFAULT_FEATURES };
    if (stored && typeof stored === "object") {
      for (const key of Object.keys(SearchFixer.DEFAULT_FEATURES)) {
        if (stored[key] === true) out[key] = true;
        else if (stored[key] === false) out[key] = false;
      }
    }
    return out;
  },

  clampGridItems(value) {
    const n = Number(value);
    if (n === 4 || n === 5 || n === 6) return n;
    return 0;
  },

  /**
   * pathname がフィードページ（ホーム / 登録 / 急上昇 等）に該当するか判定。
   * 検索結果 "/results" はここには含まない（呼び出し側で別途判定）。
   */
  isFeedPath(pathname) {
    if (typeof pathname !== "string") return false;
    if (pathname === "/" || pathname === "") return true;
    for (const prefix of SearchFixerFeedPathPrefixes) {
      if (pathname.startsWith(prefix)) return true;
    }
    return false;
  },

  /**
   * `/@handle` 形式の href から handle 文字列 (`@xxx`) を抽出する pure function。
   *
   * 設計上の注意:
   *   - YouTube のハンドルは ASCII (`@nagumorui`) だけでなく Unicode 文字 (日本語 / 韓国語 /
   *     中国語 / アクセント記号) を含むケースが多数ある (`@むめいの有名になりたい` 等)。
   *   - DOM 上の `href` 属性は URL エンコード形式 (`/@%E3%82%80...`) で保持されているため、
   *     先に `decodeURIComponent` でデコードしてから正規表現マッチする。
   *   - Unicode property escapes `\p{L}\p{N}` で Letter + Number を許可
   *     (ES2018+、Chrome 64+ で対応、minimum_chrome_version: 140 では完全サポート)。
   *
   * 失敗パターンとフォールバック:
   *   - href が null / 空文字 → null
   *   - `@` 形式じゃない URL (`/channel/UCxxx` 等) → null
   *   - 不正な % シーケンス (decodeURIComponent が throw) → 素の href にフォールバックして再試行
   *
   * 過去の罠: 旧実装は `(@[\w.-]{1,60})(?:\/|$|\?)` で ASCII 限定だったため、日本語ハンドルの
   * カードでサムネ取得が永遠にスキップされる重大バグがあった (subsChannelsGrid 経由で発覚)。
   *
   * @param {string|null|undefined} href "/@xxx" 形式の URL
   * @returns {string|null} "@xxx" または null
   */
  extractHandleFromHref(href) {
    if (!href) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      // 不正な % シーケンス（壊れた encoding）の場合は素の href にフォールバック
      decoded = href;
    }
    const m = decoded.match(/(@[\p{L}\p{N}._-]{1,60})(?:\/|$|\?|#)/u);
    return m ? m[1] : null;
  },

  /** チャンネルブロックリストの登録上限。storage 肥大と検索ページの照合コストの上限を兼ねる。 */
  BLOCKED_CHANNELS_MAX: 500,

  /**
   * チャンネルリンク href からブロックリスト照合用のチャンネルキーを抽出する（純粋関数）。
   *
   *   - "/@handle" 形式 → "@handle" を **小文字化** して返す（YouTube ハンドルは大文字小文字を
   *     区別しないため、照合キーは常に小文字で正規化する。extractHandleFromHref の Unicode 対応
   *     をそのまま利用し、日本語ハンドルにも対応）
   *   - "/channel/UCxxxx" 形式 → "UCxxxx" をそのまま返す（チャンネル ID は case-sensitive）
   *   - どちらでもない（動画リンク / null / 空文字）→ null
   *
   * @param {string|null|undefined} href チャンネルへのリンク href
   * @returns {string|null} 照合キー（"@handle" 小文字 or "UC..."）または null
   */
  extractChannelKeyFromHref(href) {
    if (!href) return null;
    const handle = SearchFixer.extractHandleFromHref(href);
    if (handle) return handle.toLowerCase();
    const m = String(href).match(/\/channel\/(UC[\w-]{10,64})(?:\/|$|\?|#)/);
    return m ? m[1] : null;
  },

  /**
   * storage から読んだブロックリスト値を正規化する（純粋関数）。
   *
   * 期待形式: [{ key: "@handle" | "UC...", name: "表示名" }, ...]
   *   - 配列以外 / 壊れた値 → []
   *   - key が空文字 / 非 string / 128 文字超のエントリは捨てる
   *   - key は "@..." なら小文字化して正規化（extractChannelKeyFromHref と対称）
   *   - name は string 以外 / 空なら key を表示名として代用、100 文字で切り詰め
   *   - key 重複は先勝ちで dedupe、BLOCKED_CHANNELS_MAX 件で打ち切り
   *
   * @param {unknown} value storage 生値
   * @returns {Array<{key: string, name: string}>} 正規化済みリスト（常に新規配列）
   */
  normalizeBlockedChannels(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const entry of value) {
      if (out.length >= SearchFixer.BLOCKED_CHANNELS_MAX) break;
      if (!entry || typeof entry !== "object") continue;
      let key = typeof entry.key === "string" ? entry.key.trim() : "";
      if (!key || key.length > 128) continue;
      if (key.startsWith("@")) key = key.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (!name) name = key;
      if (name.length > 100) name = name.slice(0, 100);
      out.push({ key, name });
    }
    return out;
  },

  // ---------- 海外チャンネル除外 (hideForeignChannels) ----------

  /** チャンネル国キャッシュ (sessionStorage) の prefix。判定ロジックを変えたら version を上げる。 */
  FOREIGN_CACHE_PREFIX: "__cpa_ch_country_v1::",
  /** チャンネル国キャッシュの有効期間。チャンネルの所在国はほぼ変わらないので長め。 */
  FOREIGN_CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  /** about ページ取得の同時実行数。1 ページ 1〜3 MB あるので絞る。 */
  FOREIGN_FETCH_CONCURRENCY: 2,
  /**
   * 1 ページセッションあたりの about 取得の総数上限（/rere RC-I）。
   * 固有スクリプトを持たない言語圏（en / de / fr 等）では全カードが判定不能になり、
   * 同時実行数の制限だけでは総転送量を抑えられない。上限に達した分は「判定を保留」
   * （= 残す）に倒れるので、fail-open の不変条件は保たれる。
   */
  FOREIGN_FETCH_SESSION_MAX: 60,
  /** about 取得のタイムアウト。無いとスロットを永久占有して待ち行列が止まる（/rere RC-C）。 */
  FOREIGN_FETCH_TIMEOUT_MS: 15000,

  /**
   * タイトル / チャンネル名の文字種から、そのカードが自国コンテンツか判定する（純粋関数）。
   *
   *   - 自国固有スクリプト（`SearchFixerHomeScripts`、日本語なら仮名）を含む → "home"
   *   - 自国固有ではない非ラテンスクリプト（ハングル / キリル / アラビア等）を含む → "foreign"
   *   - どちらでもない（ラテン文字のみ / 漢字のみ / 記号・数字のみ / 空）→ "unknown"
   *
   * 漢字とラテン文字を決め手にしないのが要点。漢字は日中で共有され、ラテン文字は
   * 「英語タイトルを付けた自国チャンネル」と区別できないため、誤除外を避けて unknown に倒し、
   * 呼び出し側の about fetch（国の実データ）に判定を委ねる。
   *
   * @param {string|null|undefined} text 判定対象（タイトル + チャンネル名を連結したもの）
   * @param {string|null|undefined} homeLang 自分の言語（"ja" / "ja-JP" どちらでも可）
   * @returns {"home"|"foreign"|"unknown"}
   */
  detectTextOrigin(text, homeLang) {
    if (typeof text !== "string" || text.trim() === "") return "unknown";
    const lang = typeof homeLang === "string" ? homeLang.toLowerCase().split("-")[0] : "";
    // 自分の言語が不明なら「自国のスクリプト」を定義できないので、全部 unknown に倒す（fail-open）。
    if (lang === "") return "unknown";
    const homeScripts = SearchFixerHomeScripts[lang] ?? [];
    let sawForeign = false;
    for (const test of SearchFixerScriptTests) {
      if (!test.re.test(text)) continue;
      if (homeScripts.includes(test.id)) return "home";
      sawForeign = true;
    }
    return sawForeign ? "foreign" : "unknown";
  },

  /**
   * ブラウザの言語設定から自分の国コード（ISO 3166-1 alpha-2）を推定する（純粋関数）。
   *
   *   1. 地域サブタグ付きのタグ（"ja-JP"）があれば、その地域を最優先で採用
   *   2. 無ければ言語コードから `SearchFixerDefaultRegions` でフォールバック（"ja" → "JP"）
   *   3. どちらも取れなければ null（呼び出し側は機能を no-op にする）
   *
   * @param {ReadonlyArray<string>|null|undefined} languages `navigator.languages` 相当
   * @returns {string|null} 大文字 2 文字の国コード、または null
   */
  resolveHomeRegion(languages) {
    if (!Array.isArray(languages)) return null;
    const tags = languages.filter((t) => typeof t === "string" && t !== "");
    for (const tag of tags) {
      const m = tag.match(/^[a-z]{2,3}-(?:[A-Za-z]{4}-)?([A-Za-z]{2})$/i);
      if (m) return m[1].toUpperCase();
    }
    for (const tag of tags) {
      const base = tag.toLowerCase().split("-")[0];
      if (SearchFixerDefaultRegions[base]) return SearchFixerDefaultRegions[base];
    }
    return null;
  },

  /**
   * チャンネルの about ページ HTML から国名を抽出する（純粋関数）。
   *
   * YouTube の `aboutChannelViewModel` は `"country":"アメリカ合衆国"` のように
   * **表示言語でローカライズされた国名**を持つ（ISO コードではない）。国を公開していない
   * チャンネルではフィールドごと欠落するため、その場合は null を返して呼び出し側で
   * 「判定不能 = 残す」に倒す。
   *
   * **検索窓を `aboutChannelViewModel` 以降に限定する**（/rere RC-G）。about ページは 1〜3 MB
   * あり、HTML 全体への先頭一致だと ytcfg 等に含まれる**視聴者側の国**（`"country":"JP"` 形式の
   * ISO コード等）を先に拾いうる。誤った国名は呼び出し側で `foreign` 確定 → カード除去に
   * 直結するため、スコープ限定は誤除去を防ぐ実質的な防御になる。
   *
   * @param {string|null|undefined} html about ページの HTML
   * @returns {string|null} 国名（表示言語のまま）または null
   */
  parseChannelCountry(html) {
    if (typeof html !== "string" || html === "") return null;
    // aboutChannelViewModel が見つからない HTML（別レイアウト / ログイン誘導ページ等）は
    // 判定材料が無いものとして null を返す（fail-open。全体走査へのフォールバックはしない）。
    const anchor = html.indexOf("aboutChannelViewModel");
    if (anchor < 0) return null;
    const m = html.slice(anchor).match(/"country":"((?:[^"\\]|\\.){1,120})"/);
    if (!m) return null;
    let raw = m[1];
    try {
      raw = JSON.parse(`"${raw}"`);
    } catch {
      // 壊れたエスケープ列は素の文字列にフォールバック（比較で外れれば unknown 側に倒れるだけ）
    }
    const name = raw.trim();
    return name === "" ? null : name;
  },

  /**
   * about の国名と自国名エイリアスを突き合わせる（純粋関数）。
   *
   * **三値を返すのが要点**（/rere RC-H）。旧実装は `aliases.has(name) ? "home" : "foreign"` の
   * 二値で、「自国名の表記ゆれで照合できなかった」だけのケースまで `foreign`（= 除去）に
   * 倒していた。about の国名は **YouTube の UI 言語**でローカライズされるため、ブラウザの
   * `navigator.languages` と YouTube のアカウント言語設定が違う環境（例: ブラウザ en-US /
   * YouTube UI 日本語）では自国チャンネルが軒並み除去される破綻があった。
   *
   * 対策として「その言語で表現しうる全 region 名の集合」を渡してもらい、**集合に載らない
   * 国名は `unknown`（= 残す）** に倒す。これで fail-open の不変条件を回復する。
   *
   * @param {string|null|undefined} countryName about から抽出した国名
   * @param {Set<string>|null|undefined} homeAliases 自国を指す表記の集合（小文字化済み）
   * @param {Set<string>|null|undefined} knownCountries 既知の国名表記の集合（小文字化済み）
   * @returns {"home"|"foreign"|"unknown"}
   */
  classifyCountryName(countryName, homeAliases, knownCountries) {
    if (typeof countryName !== "string" || countryName.trim() === "") return "unknown";
    const name = countryName.trim().toLowerCase();
    if (homeAliases instanceof Set && homeAliases.has(name)) return "home";
    // 既知の国名として解決できない表記は「自国の別表記かもしれない」ので判定不能に倒す。
    if (!(knownCountries instanceof Set) || !knownCountries.has(name)) return "unknown";
    return "foreign";
  },
});

/**
 * @readonly Amazon 定期おトク便 月別合計金額表示の定数（独自実装）。
 *
 * Amazon 定期おトク便ページの DOM 構造を解析し、配送月ごとの合計金額を独自に計算・表示する。
 * 動作対象: `https://www.amazon.co.jp/auto-deliveries*` のみ。外部送信ゼロ。
 *
 * セレクタは Amazon が公開する DOM 属性（`[data-delivery-type]`, `.subscription-price`,
 * `.a-fixed-left-grid-col`）に依存する事実情報。
 */
const AmazonDeliveryTotal = Object.freeze({
  SECTION_SELECTOR: "[data-delivery-type]",
  PRICE_SELECTOR: ".subscription-price",
  INSERT_TARGET_SELECTOR: ".a-fixed-left-grid-col",
  TOTAL_ROOT_CLASS: "__cpa-amzn-delivery-total",
  PRICE_NORMALIZE_RE: /\D/g,
});

/**
 * @readonly Amazon 商品ページの「この商品が所属するランキングへ移動」ボタン機能の定数（独自実装）。
 *
 * 商品詳細欄の「Amazon 売れ筋ランキング」に含まれる売れ筋ランキングへのリンクは、商品ページごとに
 * 出現位置がバラバラで探しにくい。これを商品ページ上部の固定ボタンに集約し、ワンクリックで
 * 「この商品が所属する一番細かいサブカテゴリ」のランキングへ移動できるようにする。
 *
 * 動作対象: `*://www.amazon.co.jp/*`（manifest content_scripts.matches で限定）。
 * 売れ筋ランキングリンクを含む商品ページでのみボタンを出す（自己ゲート）。外部送信ゼロ・純粋 DOM 操作。
 *
 * セレクタ戦略: 難読化 class には依存せず、商品詳細コンテナ（id ベース）の中の
 * `a[href*="bestsellers/"]` のみを対象にする。これによりカテゴリページ等の無関係な
 * ベストセラーリンクを拾わず、商品ページ限定で動作する。
 */
const AmazonRankingJump = Object.freeze({
  /** ボタンと装飾クラスの接頭辞 */
  ROOT_CLASS: "__cpa-amzn-ranking-jump",
  /**
   * 売れ筋ランキングリンクを探す商品詳細コンテナ群（この中だけを走査して非商品ページの誤検出を防ぐ）。
   * Amazon の新 layout (例: B0FXKSZRDM 「by Amazon あたりめ」等の Private Brand / 食品系新カード UI)
   * では従来の `detailBullets` 系コンテナに売れ筋リンクが入らず、`#item_details` に移動するため
   * 両方を併記する。同一ページ内に複数コンテナが共存することもあるが selectTargetHref が
   * 「DOM 出現順で最後のサブカテゴリ」を選ぶため、重複しても結果は安定する。
   */
  DETAIL_CONTAINER_SELECTORS: Object.freeze([
    "#detailBulletsWrapper_feature_div",
    "#detailBullets_feature_div",
    "#productDetails_detailBullets_sections1",
    "#prodDetails",
    "#SalesRank",
    "#item_details", // 新 layout (B0FXKSZRDM 等の新カード UI でランキングリンクが集約される)
  ]),
  /** 売れ筋ランキングへのアンカー（商品詳細コンテナ内から取得） */
  BESTSELLER_LINK_SELECTOR: 'a[href*="bestsellers/"]',
  /**
   * サブカテゴリのランキングリンク判定。
   * 例: `/gp/bestsellers/electronics/19349884051/ref=pd_zg_hrsr_electronics`
   *  → カテゴリ slug の後ろに数値ノード id があるものを「細かいサブカテゴリ」とみなす。
   * 広いカテゴリの「○○の売れ筋ランキングを見る」リンク (`/gp/bestsellers/electronics/ref=...`) は
   * ノード id を持たないので false。
   */
  SUBCATEGORY_PATH_RE: /\/bestsellers\/[^/]+\/\d+(?:[/?]|$)/,

  /** href（絶対 / 相対どちらも可）が細かいサブカテゴリのランキングリンクか判定する純粋関数。 */
  isSubcategoryHref(href) {
    if (typeof href !== "string" || href.length === 0) return false;
    let pathname;
    try {
      pathname = new URL(href, "https://www.amazon.co.jp").pathname;
    } catch {
      return false;
    }
    return AmazonRankingJump.SUBCATEGORY_PATH_RE.test(pathname);
  },

  /**
   * 売れ筋ランキングリンク href の配列（DOM 出現順）から移動先を 1 つ選ぶ純粋関数。
   * 「一番細かいサブカテゴリ」= サブカテゴリリンクのうち DOM 上で最後のもの
   * （Amazon は広い→細かいの順に並べるため）。サブカテゴリが無ければ最後のリンク、空なら null。
   */
  selectTargetHref(hrefs) {
    if (!Array.isArray(hrefs) || hrefs.length === 0) return null;
    const subs = hrefs.filter((h) => AmazonRankingJump.isSubcategoryHref(h));
    const pool = subs.length > 0 ? subs : hrefs;
    return pool[pool.length - 1] ?? null;
  },
});

/**
 * @readonly Amazon 商品ページ「販売元・出荷元バッジ」表示の定数と純粋関数（独自実装）。
 *
 * Amazon は商品ページに `#merchantInfoFeature_feature_div` / `#fulfillerInfoFeature_feature_div`
 * という 2 つの隠し div で販売元・出荷元の値を保持している（実表示は別レンダリング先で fragile だが、
 * これらの隠し div はマーケット商品でも値が入っており、データ source として安定）。これを集約して
 * ランキングボタンの隣に「販売: XXX / 出荷: YYY」バッジで表示する。
 *
 * 設計判断:
 *   - master トグル `amazonMerchantInfoEnabled` で制御（オプトイン・デフォルト OFF）
 *   - Amazon 直販と マーケット出品 を視覚的に区別する（直販=緑 / マーケット=オレンジ警告色）
 *   - Amazon 直販判定は `#merchantInfoFeature_feature_div` 内 `<script>` の JSON フラグ
 *     `isInternal` を最優先（Amazon 自身が出す信頼できるフラグ）。script 欠落時は販売元名で推定
 *   - クリック不可（`<span>` ベース、`<a>` ではない）の情報パネル
 *   - 純粋関数 `parseIsInternal` / `isAmazonOwnedName` で境界値テスト可能化
 */
const AmazonMerchantInfo = Object.freeze({
  /** バッジと装飾クラスの接頭辞 */
  ROOT_CLASS: "__cpa-amzn-merchant-info",
  /** 販売元情報を持つ Amazon 隠し div の id（マーケット商品でも visible:false で値は入っている） */
  MERCHANT_DIV_ID: "merchantInfoFeature_feature_div",
  /** 出荷元情報を持つ Amazon 隠し div の id */
  FULFILLER_DIV_ID: "fulfillerInfoFeature_feature_div",
  /** 値テキストを持つ安定マーカー span（Amazon の build を跨いで残る class） */
  VALUE_SELECTOR: "span.offer-display-feature-text-message",
  /**
   * isInternal フラグを持つ merchant-stats JSON `<script>` が埋め込まれる可能性のあるコンテナ群。
   * Amazon の新 layout (例: B0FXKSZRDM 「by Amazon」Private Brand 等) では
   * `#merchantInfoFeature_feature_div` 内に script が無く、availability 系コンテナ配下に
   * 移動している。同じ ASIN の merchant-stats は同一値なので、先頭一致でも main product の
   * isInternal を取り違える心配は無い (実機検証で 5 個全部同 ASIN 確認済 2026-06-07)。
   *
   * 配列順は narrower → broader の優先度。最初に typeof boolean が取れた script を採用。
   */
  IS_INTERNAL_CONTAINER_SELECTORS: Object.freeze([
    "#merchantInfoFeature_feature_div", // 旧 layout (script が seller div 内に直接ある)
    "#addToCart",                       // 新 layout (買い物カゴ周辺の availability accordion 配下)
    "#dp-container",                    // 最終フォールバック (商品詳細ページの最大スコープ)
  ]),
  /** Amazon 自身を示す販売元名のパターン（部分一致）。Amazon 直販と推定するときの fallback 用 */
  AMAZON_OWNED_NAMES: Object.freeze(["Amazon.co.jp", "Amazon.com", "Amazon"]),

  /**
   * merchantInfoFeature 内の `<script>` テキストから isInternal フラグを抽出する純粋関数。
   * Amazon は merchant-stats-pagestate-holder-0 等の div 内に
   *   {"marketplaceId":"...","isInternal":true|false,"isRobot":false,"merchantId":"...","asin":"..."}
   * 形式の JSON を埋めている。これは Amazon 自身が出すフラグで Amazon 直販判定の最も信頼できる source。
   *
   * @param {unknown} text JSON 文字列（先頭が "{" であることを期待）
   * @returns {boolean|null} true=Amazon 直販, false=マーケット, null=parse 失敗
   */
  parseIsInternal(text) {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed[0] !== "{") return null;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj?.isInternal === "boolean") return obj.isInternal;
      return null;
    } catch {
      return null;
    }
  },

  /**
   * 販売元名から Amazon 直販っぽさを推定する純粋関数。isInternal が取れないとき (script 欠落) の保険判定。
   * 「Amazon.co.jp」「Amazon.com」「Amazon」のいずれかを部分一致で含むなら true。
   * マーケット出品名（例: "Amazon Renewed Hub", "By Amazon ..." 等）の偽陽性は許容範囲。
   *
   * @param {unknown} name 販売元名
   * @returns {boolean}
   */
  isAmazonOwnedName(name) {
    if (typeof name !== "string") return false;
    const trimmed = name.trim();
    if (trimmed.length === 0) return false;
    return AmazonMerchantInfo.AMAZON_OWNED_NAMES.some((n) => trimmed.includes(n));
  },
});

/**
 * @readonly Instagram クリーナーの機能定義と定数（独自実装）。
 *
 * Instagram の冗長 UI（Reels / Explore / Stories / Threads / いいね数 / 動画 / コメント /
 * Notes / メッセージカウンター）を非表示にするための、クライアントサイド DOM/CSS 操作。
 * 外部送信ゼロのプライバシー方針。設定は `chrome.storage.local` の `instagramCleanerEnabled`
 * (master) と `instagramCleanerFeatures` (オブジェクト) の 2 キーで管理する。
 *
 * 動作対象: `*://*.instagram.com/*` のみ（manifest content_scripts.matches で限定）。
 *
 * セレクタ戦略: aria-label / href / role / data-pagelet / SVG path data など Instagram が
 * 公開する意味論的属性に依存（難読化 class への依存は避けて安定性とライセンス安全性を確保）。
 */
const InstagramCleanerFeatures = Object.freeze([
  // ラベル / 説明文は _locales/{en,ja}/messages.json の `feat_ig_<key>_{label,desc}` を参照。
  Object.freeze({ key: "reels", category: "ig_main" }),
  Object.freeze({ key: "explore", category: "ig_main" }),
  Object.freeze({ key: "stories", category: "ig_main" }),
  Object.freeze({ key: "storiesAll", category: "ig_main" }),
  Object.freeze({ key: "threads", category: "ig_main" }),
  Object.freeze({ key: "vanity", category: "ig_extra" }),
  Object.freeze({ key: "blockVideos", category: "ig_extra" }),
  Object.freeze({ key: "comments", category: "ig_extra" }),
  Object.freeze({ key: "notes", category: "ig_extra" }),
  Object.freeze({ key: "msgCounters", category: "ig_extra" }),
  // === 画像ダウンロード（YouTube / Instagram / TikTok 共通機能。実装は src/content/image-downloader.js）===
  Object.freeze({ key: "imageDownload", category: "ig_extra" }),
]);

const InstagramCleanerDefaultFeatures = Object.freeze(
  Object.fromEntries(InstagramCleanerFeatures.map((feature) => [feature.key, false]))
);

const InstagramCleaner = Object.freeze({
  FEATURES: InstagramCleanerFeatures,

  // category.label は _locales/.../messages.json の `categoryIgMain` / `categoryIgExtra`。
  CATEGORIES: Object.freeze([
    Object.freeze({ id: "ig_main",  icon: "🚫" }),
    Object.freeze({ id: "ig_extra", icon: "✂️" }),
  ]),

  DEFAULT_FEATURES: InstagramCleanerDefaultFeatures,

  /** body に付与する CSS クラス名（feature key → クラス名） */
  BODY_CLASS: Object.freeze({
    reels: "__cpa-ig-reels",
    explore: "__cpa-ig-explore",
    stories: "__cpa-ig-stories",
    storiesAll: "__cpa-ig-stories-all",
    threads: "__cpa-ig-threads",
    vanity: "__cpa-ig-vanity",
    blockVideos: "__cpa-ig-block-videos",
    comments: "__cpa-ig-comments",
    notes: "__cpa-ig-notes",
    msgCounters: "__cpa-ig-msg-counters",
  }),

  /** block_videos 機能で `<article>` に追加するマーカークラス（CSS 側のサムネ差し替えと連動） */
  ARTICLE_VIDEO_CLASS: "__cpa-ig-article-video",
  /** vanity 機能で数字ボタンに追加する非表示マーカークラス */
  VANITY_HIDE_CLASS: "__cpa-ig-hide-counter",
  /** vanity 機能で検査済み要素に追加するマーカークラス（再スキャン抑制用） */
  VANITY_CHECKED_CLASS: "__cpa-ig-counter-checked",
  /** comments 機能でコメント入力フォームに追加するマーカー */
  COMMENT_INPUT_CLASS: "__cpa-ig-comment-input",
  /** comments 機能で「View all N comments」/「N 件のコメントを見る」リンクに追加するマーカー */
  COMMENT_VIEW_CLASS: "__cpa-ig-comment-view",
  /** comments 機能でコメントリスト `<ul>` に追加するマーカー（厳格な判定のもと付与） */
  COMMENT_LIST_CLASS: "__cpa-ig-comment-list",

  mergeFeatures(stored) {
    const out = { ...InstagramCleaner.DEFAULT_FEATURES };
    if (stored && typeof stored === "object") {
      for (const key of Object.keys(InstagramCleaner.DEFAULT_FEATURES)) {
        if (stored[key] === true) out[key] = true;
        else if (stored[key] === false) out[key] = false;
      }
    }
    return out;
  },
});


/**
 * @readonly TikTok クリーナーの機能定義と定数（独自実装）。
 *
 * TikTok の冗長 UI（コメントパネル / コメントボタン / おすすめのアカウント等）を非表示にする。
 * Instagram クリーナーと同じ body クラス駆動 CSS パターン。設定は `chrome.storage.local` の
 * `tiktokCleanerEnabled` (master) + `tiktokCleanerFeatures` (object) で保持する。
 *
 * セレクタは TikTok が公開している `data-e2e` 属性 / `aria-label` を第一選択とし、難読化 class
 * 名（ビルドごとに変わる）には依存しない。
 */
const TikTokCleanerFeatures = Object.freeze([
  // ラベル / 説明文は _locales/{en,ja}/messages.json の `feat_tt_<key>_{label,desc}` を参照。
  Object.freeze({ key: "hideComments", category: "tt_main" }),
  Object.freeze({ key: "hideSuggested", category: "tt_main" }),
  // === 画像ダウンロード（YouTube / Instagram / TikTok 共通機能。実装は src/content/image-downloader.js）===
  Object.freeze({ key: "imageDownload", category: "tt_main" }),
]);

const TikTokCleanerDefaultFeatures = Object.freeze(
  Object.fromEntries(TikTokCleanerFeatures.map((feature) => [feature.key, false]))
);

const TikTokCleaner = Object.freeze({
  FEATURES: TikTokCleanerFeatures,

  // category.label は _locales/.../messages.json の `categoryTtMain`。
  CATEGORIES: Object.freeze([
    Object.freeze({ id: "tt_main", icon: "🚫" }),
  ]),

  DEFAULT_FEATURES: TikTokCleanerDefaultFeatures,

  /** body に付与する CSS クラス名（feature key → クラス名） */
  BODY_CLASS: Object.freeze({
    hideComments: "__cpa-tt-comments",
    hideSuggested: "__cpa-tt-suggested",
  }),

  mergeFeatures(stored) {
    const out = { ...TikTokCleaner.DEFAULT_FEATURES };
    if (stored && typeof stored === "object") {
      for (const key of Object.keys(TikTokCleaner.DEFAULT_FEATURES)) {
        if (stored[key] === true) out[key] = true;
        else if (stored[key] === false) out[key] = false;
      }
    }
    return out;
  },
});

/**
 * @readonly X（旧 Twitter）クリーナーの機能定義と定数（独自実装）。
 *
 * X の 3 ペインレイアウト（左ナビ / タイムライン / 右ペイン）のうち、閲覧の邪魔になる
 * 右ペインや広告・勧誘 UI を隠す。設定は `chrome.storage.local` の `xCleanerEnabled` (master)
 * + `xCleanerFeatures` (object) で保持し、TikTok / Instagram と同じ body クラス駆動 CSS で当てる。
 *
 * **セレクタは `data-testid` と `:has()` だけで構成し、`aria-label` の文言に依存しない**。
 * X の `aria-label` は UI 言語でローカライズされる（実機で「トレンド」「プレミアムプラスに
 * アップグレード」を確認済み）ため、文言マッチは日本語環境でしか動かない。代わりに
 * 「トレンド項目を含む section」「UserCell を含む aside」のような**構造**で特定する
 * （`:has()` は minimum_chrome_version 140 / Firefox 142 のいずれでも利用可）。
 *
 * 実機確認済みの構造（2026-07-28、ログイン状態の x.com/home）:
 *   - 右ペイン全体   … `[data-testid="sidebarColumn"]`
 *   - トレンド       … 右ペイン内の `section:has([data-testid="trend"])`
 *   - おすすめユーザー … 右ペイン内の `aside:has([data-testid="UserCell"])`
 *   - プレミアム勧誘  … 右ペイン内の `aside:not(:has([data-testid="UserCell"]))`
 *   - 広告投稿       … `[data-testid="cellInnerDiv"]:has([data-testid="placementTracking"])`
 *   - ホームのタブ    … `[role="tablist"] [role="tab"]` の index 0 = おすすめ / 1 = フォロー中
 */
const XCleanerFeatures = Object.freeze([
  // ラベル / 説明文は _locales/{en,ja}/messages.json の `feat_x_<key>_{label,desc}` を参照。
  Object.freeze({ key: "hideRightPane", category: "x_layout" }),
  Object.freeze({ key: "hideTrends", category: "x_layout" }),
  Object.freeze({ key: "hideWhoToFollow", category: "x_layout" }),
  Object.freeze({ key: "hideMessagesDock", category: "x_layout" }),
  Object.freeze({ key: "hidePromoted", category: "x_noise" }),
  Object.freeze({ key: "hidePremiumUpsell", category: "x_noise" }),
  Object.freeze({ key: "hideGrok", category: "x_noise" }),
  Object.freeze({ key: "hideEngagementCounts", category: "x_noise" }),
  Object.freeze({ key: "followingTabDefault", category: "x_timeline" }),
]);

const XCleanerDefaultFeatures = Object.freeze(
  Object.fromEntries(XCleanerFeatures.map((feature) => [feature.key, false]))
);

const XCleaner = Object.freeze({
  FEATURES: XCleanerFeatures,

  // category.label は _locales/.../messages.json の `categoryX*`。
  CATEGORIES: Object.freeze([
    Object.freeze({ id: "x_layout", icon: "🪟" }),
    Object.freeze({ id: "x_noise", icon: "🚫" }),
    Object.freeze({ id: "x_timeline", icon: "🧭" }),
  ]),

  DEFAULT_FEATURES: XCleanerDefaultFeatures,

  /** `<html>` に付与する CSS クラス名（feature key → クラス名）。CSS 側の prefix と対で使う。 */
  BODY_CLASS: Object.freeze({
    hideRightPane: "__cpa-x-right-pane",
    hideTrends: "__cpa-x-trends",
    hideWhoToFollow: "__cpa-x-who-to-follow",
    hideMessagesDock: "__cpa-x-dock",
    hidePromoted: "__cpa-x-promoted",
    hidePremiumUpsell: "__cpa-x-premium",
    hideGrok: "__cpa-x-grok",
    hideEngagementCounts: "__cpa-x-counts",
    // followingTabDefault は CSS ではなく JS（タブ選択）なので BODY_CLASS を持たない。
  }),

  /**
   * ホームタイムラインのタブ位置（`[role="tablist"] [role="tab"]` の index）。
   * **文言ではなく位置で特定する**（「おすすめ」「For you」はロケールで変わるが、
   * ピン留めリストは 2 番目より後ろに並ぶため先頭 2 つの順序は不変）。
   */
  TAB_INDEX: Object.freeze({ FOR_YOU: 0, FOLLOWING: 1 }),

  /** followingTabDefault が動作するパス（ホームのみ。個別ポストやプロフィールでは何もしない） */
  HOME_PATHS: Object.freeze(["/home"]),

  /** `followingTabDefault` の対象ページか判定する（純粋関数）。 */
  isHomePath(pathname) {
    if (typeof pathname !== "string") return false;
    const path = pathname.replace(/\/+$/, "") || "/";
    return XCleaner.HOME_PATHS.includes(path);
  },

  mergeFeatures(stored) {
    const out = { ...XCleaner.DEFAULT_FEATURES };
    if (stored && typeof stored === "object") {
      for (const key of Object.keys(XCleaner.DEFAULT_FEATURES)) {
        if (stored[key] === true) out[key] = true;
        else if (stored[key] === false) out[key] = false;
      }
    }
    return out;
  },
});

/**
 * @readonly 画像ダウンロード機能の定数（Instagram / TikTok 共通、独自実装）。
 *
 * 各コンテンツ画像にホバー時のダウンロードボタンを overlay 表示し、Blob URL + `<a download>`
 * 方式で保存する。`downloads` permission は追加しない（既存 permissions のままで動作）。
 *
 * 動作対象:
 *   - Instagram: 投稿写真（フィード / プロフィールグリッド / 投稿詳細）+ リールカバー
 *   - TikTok: フォト投稿 + 動画サムネ
 *
 * 機能の有効/無効は **各サイトクリーナーの features.imageDownload** が単一情報源（共通 master
 * トグルは持たない）。サイトクリーナー master OFF 時は機能ごと無効になる設計。
 *
 * 設計上の不変条件:
 *   - サイズ閾値 MIN_SIZE_PX 未満の画像（avatar / アイコン）は対象外
 *   - クリーナーで非表示の画像にはボタンを付与しない（content script 側で computed style 確認）
 *   - `__cpa-img-dl-` プレフィックスでサイト CSS との衝突回避
 */
const ImageDownloader = Object.freeze({
  /** 対応サイトのキー（detectHost の戻り値、features の所属サイト解決に使う） */
  HOSTS: Object.freeze({
    INSTAGRAM: "instagram",
    TIKTOK: "tiktok",
  }),

  /**
   * コンテンツ画像と UI アイコンを区別するサイズ閾値（width / height のいずれかが
   * この値以上ならコンテンツ画像と判定）。avatar (40px), アイコン (24px) は確実に除外。
   */
  MIN_SIZE_PX: 200,

  /** 注入する DL ボタンに付ける CSS クラス名 */
  BUTTON_CLASS: "__cpa-img-dl-button",
  /** 画像の親要素（hover ターゲット）に付ける CSS クラス名 */
  HOST_CLASS: "__cpa-img-dl-host",
  /** ダウンロード処理中のボタンに付与する状態クラス（CSS で disabled 表示） */
  BUSY_CLASS: "__cpa-img-dl-busy",
  /** position が static でない host に付与する代替クラス（既存 position を尊重して overlay 配置） */
  HOST_POSITIONED_CLASS: "__cpa-img-dl-host-positioned",
  /**
   * 処理済みの画像に最後に評価した src URL を格納する dataset キー（element.dataset[KEY]）。
   * SPA / Polymer dom-repeat で同じ `<img>` 要素の src が別画像に差し替わったとき、
   * 値の不一致で再評価をトリガーする（古いボタンを除去 → 新規 src で再 decorate）。
   */
  SCANNED_SRC_DATASET_KEY: "cpaImgDlSrc",
  /**
   * `SCANNED_SRC_DATASET_KEY` に対応する CSS 属性セレクタ。
   * dataset キーは camelCase、HTML 属性は kebab-case（`cpaImgDlSrc` → `data-cpa-img-dl-src`）の
   * 変換規則のため、両者を別々に保持して querySelector の食い違いを防ぐ。
   * SCANNED_SRC_DATASET_KEY を変更したら必ずここも揃えること。
   */
  SCANNED_SRC_ATTR_SELECTOR: "img[data-cpa-img-dl-src]",
  /** scan を skip した画像のマーカー値（コンテンツ画像でないと判定された） */
  SKIP_MARKER: "__cpa-skip__",

  /**
   * 各サイトの fetch を許可する CDN ホスト名ホワイトリスト。
   * `<img src>` を拡張機能が代理 fetch するため、攻撃者注入 img や任意オリジンへの
   * 代理リクエスト経路を塞ぐ目的で URL の hostname をこの一覧と照合する。
   * 対応していない hostname は fetch 候補から除外される（次の候補にフォールバック）。
   *
   * - 文字列 → 完全一致
   * - 配列の正規表現 → サブドメインを含むパターンマッチ
   */
  ALLOWED_HOSTS: Object.freeze({
    instagram: Object.freeze([
      /^scontent(-[a-z0-9]+)?(-[a-z0-9]+)?\.cdninstagram\.com$/,
      // /rere レビュー A2-002 修正: 旧 `[a-z0-9-]+\.cdninstagram\.com$` パターンは任意 1 段
      // サブドメインを通過させ、Meta が将来 cdninstagram.com 配下に tracker / リダイレクタ /
      // OAuth エンドポイント等を追加した場合に攻撃者注入 `<img src="https://tracker.cdninstagram.com/log">`
      // から代理 fetch される経路ができる。fbcdn.net 系 (665, 670-676 行) や TikTok 側
      // (`p\d+` 必須化) と対称防御原則を揃えて `scontent-` prefix 必須化する。
      /^scontent-[a-z0-9-]+\.cdninstagram\.com$/,
      // Meta の正規 fbcdn CDN は `scontent.{POP}-{NUM}.fna.fbcdn.net` または
      // `scontent-{POP}.fna.fbcdn.net` 形式の 2 段サブドメイン。
      // 任意の `evil.attacker.fbcdn.net` を通さないため `scontent[-.]` で開始を限定する。
      /^scontent\.[a-z]+\d+-\d+\.fna\.fbcdn\.net$/,
      /^scontent-[a-z0-9-]+\.fna\.fbcdn\.net$/,
      // 1 段サブドメインの fbcdn.net も scontent- prefix 限定で許可する。
      // `tracking.fbcdn.net` / `video.fbcdn.net` 等の非画像 CDN への代理 fetch を
      // 防ぐため、上の 2 段パターン（fna.fbcdn.net 系）に加えてこの 1 段パターンも
      // `scontent-` 限定にする（過剰許可で外部追跡経路化するのを遮断）。
      /^scontent-[a-z0-9-]+\.fbcdn\.net$/,
    ]),
    tiktok: Object.freeze([
      /^p\d*-sign[a-z0-9-]*\.tiktokcdn(-us)?\.com$/,
      /^p\d*-pu[a-z0-9-]*\.tiktokcdn(-us)?\.com$/,
      // TikTok の正規 CDN サブドメインは `p<数字>` または `p<数字>-<region>` 形式。
      // 旧 `[a-z0-9-]+\.tiktokcdn\.com$` パターンは `evil.tiktokcdn.com` や
      // `tracking.tiktokcdn.com` 等の任意サブドメインを通過させて代理 fetch 攻撃面を広げる
      // 設計欠陥があった (/rere レビュー A2-SC-1 指摘)。`p\d+` プレフィックス必須化で
      // 攻撃面を絞り込む。Instagram 側が `scontent-` prefix 限定なのと対称的な設計。
      /^p\d+(-[a-z0-9-]+)?\.tiktokcdn(-us)?\.com$/,
    ]),
  }),

  /**
   * `location.hostname` から対応サイトを判定し、HOSTS の値（"instagram" / "tiktok"）
   * または null を返す。`*.instagram.com` / `*.tiktok.com` のサブドメインも認識。
   */
  detectHost(loc) {
    if (!loc || typeof loc.hostname !== "string") return null;
    const host = loc.hostname.toLowerCase();
    if (host === "instagram.com" || host.endsWith(".instagram.com")) {
      return ImageDownloader.HOSTS.INSTAGRAM;
    }
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
      return ImageDownloader.HOSTS.TIKTOK;
    }
    return null;
  },

  /**
   * `{host}_{YYYYMMDD_HHMMSS}.{ext}` 形式のファイル名を生成。
   * ext は MIME タイプから抽出（`image/jpeg` → `jpg`、`image/webp` → `webp`、`image/png` → `png`）。
   * 不明な MIME は `jpg` にフォールバック（Instagram / TikTok の画像はほぼ jpg/webp）。
   */
  buildFilename(host, mimeType) {
    const safeHost = ImageDownloader._isValidHost(host) ? host : "image";
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const stamp = `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
    const ext = ImageDownloader._mimeToExt(mimeType);
    return `${safeHost}_${stamp}.${ext}`;
  },

  _isValidHost(host) {
    return host === "instagram" || host === "tiktok";
  },

  /**
   * URL が指定 host (`"instagram"` / `"tiktok"`) のホワイトリスト CDN に
   * 該当するかを判定。`new URL()` で hostname を取り出して ALLOWED_HOSTS と照合する。
   * 不正 URL や非 http(s) スキームは false。
   */
  isAllowedFetchUrl(host, url) {
    if (!ImageDownloader._isValidHost(host)) return false;
    if (typeof url !== "string" || !url) return false;
    let hostname;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      hostname = u.hostname.toLowerCase();
    } catch {
      return false;
    }
    const allowed = ImageDownloader.ALLOWED_HOSTS[host];
    if (!allowed) return false;
    for (const pattern of allowed) {
      if (typeof pattern === "string") {
        if (hostname === pattern) return true;
      } else if (pattern instanceof RegExp) {
        if (pattern.test(hostname)) return true;
      }
    }
    return false;
  },

  /** MIME タイプから拡張子を返す。不明な MIME は jpg にフォールバック。 */
  _mimeToExt(mimeType) {
    if (typeof mimeType !== "string") return "jpg";
    const m = mimeType.toLowerCase();
    if (m === "image/jpeg" || m === "image/jpg") return "jpg";
    if (m === "image/png") return "png";
    if (m === "image/webp") return "webp";
    if (m === "image/gif") return "gif";
    if (m === "image/heic") return "heic";
    return "jpg";
  },
});

/**
 * @readonly 音量ブースター（タブごとの音量増幅）の定数（独自実装）。
 *
 * Chrome の標準 API（`chrome.tabCapture.getMediaStreamId` + `getUserMedia` + AudioContext +
 * GainNode）のみを使ってタブ音声を増幅する。`tabCapture` で取得した MediaStream を offscreen
 * の AudioContext に流し込み、単純な GainNode で増幅して `destination` に再出力するパイプライン
 * （音質変更などの追加処理は持たない）。
 *
 * master トグルなしのスライダーのみ構成。UNITY (100%) のときは AudioContext を解放、
 * それ以外の値が設定された時点でブーストを起動する。
 */
const VolumeBooster = Object.freeze({
  MIN: 0,
  /** デフォルト音量 (%)。100 で原音そのまま（gain 1.0、リソース解放状態）。 */
  DEFAULT: 100,
  MAX: 300,
  /** スライダー上の「等倍ライン」。この値ではブースト処理を起動せず AudioContext を解放する。 */
  UNITY: 100,
  /** UI スライダーの内部最小値。実音量 percent とは別に扱い、100% を中央へ置く。 */
  SLIDER_MIN: 0,
  /** UI スライダーの中央/等倍位置。 */
  SLIDER_UNITY: 100,
  /** UI スライダーの内部最大値。左半分 0..100% / 右半分 100..300% に割り当てる。 */
  SLIDER_MAX: 200,
  STEP: 1,
  /**
   * ± ボタン 1 回あたりの増減幅（**表示 % = 実音量倍率**なので 10 = 0.1 倍）。
   * スライダーは中央 100% を境に左右で割り当てが違う（左 0..100% / 右 100..300%）ため、
   * 増減は「スライダー位置」ではなく **percent 側で計算**して位置へ変換し直す。
   */
  NUDGE_STEP: 10,
  /**
   * gain 変更時の `setTargetAtTime` time constant (秒)。
   * 約 3τ (~45ms) で目標値の 95% に到達する設定。
   * 直接 `.value =` 代入だとサンプル境界で不連続が発生し、クリック/プチノイズの原因になる。
   * popup 側の debounce が 120ms なのでドラッグ中も次の更新前にランプが収束する。
   */
  RAMP_TIME_CONSTANT: 0.015,
  clampValue(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return VolumeBooster.DEFAULT;
    if (n < VolumeBooster.MIN) return VolumeBooster.MIN;
    if (n > VolumeBooster.MAX) return VolumeBooster.MAX;
    return Math.round(n);
  },
  /**
   * UNITY release 判定（音量ブースターが実質無処理な状態か）: gain が UNITY(100%) かつ
   * 全サブトグル OFF かつミュート OFF かつ EQ OFF なら AudioContext / MES パイプラインを
   * 解放してよい（100% でもサブトグル / EQ / ミュートのいずれかが ON なら処理を維持）。
   * background.js（tabCapture 経路の release 早期 return）と volume-booster-mes.js
   * （Firefox MES 経路の bypass 判定）が同一条件をベタ書きして per-browser drift の温床に
   * なっていたのを単一情報源化する（/rere D-002）。
   * settings は {gain, antiClip, nightMode, bassCut, muted, eqEnabled}（gain は clampValue 済み整数を想定）。
   */
  isUnityRelease(settings) {
    return (
      settings.gain === VolumeBooster.UNITY &&
      !settings.antiClip &&
      !settings.nightMode &&
      !settings.bassCut &&
      !settings.muted &&
      !settings.eqEnabled
    );
  },
  /**
   * スライダー percent (0..MAX) を実 gain 倍率に変換する線形マッピング。
   *
   * 「表示 % = 実音量倍率」を一致させる: 100% = 1.0x / 150% = 1.5x / 200% = 2.0x /
   * MAX(300)% = 3.0x。単純に percent / 100 を返すだけ。
   *
   * 旧実装は 100..MAX を対数（等 dB ステップ）で配分してドラッグ体感を均一化していたが、
   * 表示 % と実倍率が乖離し「150% なのに約 1.2 倍」とユーザーに誤読される問題があったため
   * 線形に統一した（ゆろさん指摘 2026-06-27）。スライダー UI は sliderPositionToPercent 側で
   * 中央 = 等倍 (100%)・左で減衰・右で増幅の配置を維持しているので操作感は変わらない。
   */
  percentToGain(percent) {
    return VolumeBooster.clampValue(percent) / 100;
  },
  /**
   * percentToGain の逆関数。実 gain 倍率からスライダー上の整数 percent を復元する。
   * 線形マッピングなので gain × 100 を四捨五入して 0..MAX にクランプするだけ。
   * popup syncCurrentTabVolume などで AudioContext 内の現在 gain を表示値に戻すときに使う。
   */
  gainToPercent(gain) {
    const g = Number(gain);
    if (!Number.isFinite(g) || g <= 0) return VolumeBooster.MIN;
    return VolumeBooster.clampValue(Math.round(g * 100));
  },
  /**
   * UI スライダー位置 (0..200) を実音量 percent (0..MAX) に変換する。
   * 100% を中央へ置くため、下げる側は 0..100、上げる側は 100..MAX に分ける。
   */
  sliderPositionToPercent(position) {
    const n = Number(position);
    const p = Number.isFinite(n) ? n : VolumeBooster.SLIDER_UNITY;
    const clamped = Math.min(VolumeBooster.SLIDER_MAX, Math.max(VolumeBooster.SLIDER_MIN, p));
    if (clamped <= VolumeBooster.SLIDER_UNITY) {
      return VolumeBooster.clampValue(clamped);
    }
    const t = (clamped - VolumeBooster.SLIDER_UNITY) /
      (VolumeBooster.SLIDER_MAX - VolumeBooster.SLIDER_UNITY);
    return VolumeBooster.clampValue(
      VolumeBooster.UNITY + t * (VolumeBooster.MAX - VolumeBooster.UNITY)
    );
  },
  /** 実音量 percent (0..MAX) から UI スライダー位置 (0..200) を復元する。 */
  /**
   * 現在の音量 (%) を `delta` だけ動かして範囲内へ収める（純粋関数）。
   * ± ボタン用。端では clamp されるだけで、範囲外へは出ない。
   *
   * @param {unknown} percent 現在値（不正値は DEFAULT 扱い）
   * @param {unknown} delta 増減量（不正値は 0 扱い＝現在値を維持）
   * @returns {number} MIN〜MAX に収めた整数 %
   */
  nudgePercent(percent, delta) {
    const base = VolumeBooster.clampValue(percent);
    const d = Number(delta);
    if (!Number.isFinite(d)) return base;
    return VolumeBooster.clampValue(Math.round(base + d));
  },

  percentToSliderPosition(percent) {
    const p = VolumeBooster.clampValue(percent);
    if (p <= VolumeBooster.UNITY) return p;
    const t = (p - VolumeBooster.UNITY) / (VolumeBooster.MAX - VolumeBooster.UNITY);
    return Math.round(
      VolumeBooster.SLIDER_UNITY + t * (VolumeBooster.SLIDER_MAX - VolumeBooster.SLIDER_UNITY)
    );
  },
  /**
   * 自動歪み防止用 DynamicsCompressor プリセット（ブリックウォール風リミッタ）。
   * threshold:-3dBFS / ratio:12 で実質的な hard limiter として動作し、
   * attack:1ms / release:50ms で過渡応答を最優先（瞬間ピークを確実に抑える）。
   */
  ANTI_CLIP_PRESET: Object.freeze({
    threshold: -3,
    knee: 0,
    ratio: 12,
    attack: 0.001,
    release: 0.05,
  }),
  /**
   * ナイトモード用コンプレッサー（ダイナミックレンジを縮める）。
   *
   * 履歴:
   * - 旧 ratio:2.5 / release:0.4 はゲーム配信の爆音抑制向きだが、BGM + ナレーション動画で
   *   「喋りが圧縮 → やめた瞬間に release で BGM が立ち上がる」ポンピングが目立った。
   * - 中間 threshold:-18 / ratio:2.0 / release:1.0s は語間ポンピングは抑えられたものの、
   *   「圧縮が弱くて大きい音と小さい音の幅が広すぎる」という体感問題が残った。
   *
   * 現行 threshold:-30 / knee:12 / ratio:4.0 / release:1.0s:
   *   - threshold を -18 → -30 dBFS まで下げ、ダイアログ帯（-22〜-28 dBFS RMS）を確実に
   *     圧縮対象に収める。typical な action 動画の 24dB ダイナミックレンジ（softest -30dB,
   *     loudest -6dB）が圧縮後 6dB 程度（-30 → -24dB）に縮まり、夜間視聴で大きい音が
   *     飛び出してこなくなる。
   *   - ratio を 2.0 → 4.0 に倍化。ratio:4 は放送向け圧縮の標準値で、aggressive すぎず
   *     dynamic range をしっかり潰せる落としどころ。
   *   - knee を 8 → 12 dB に広げて、threshold 越えの折れ目を滑らかにし「圧縮感」を耳に
   *     付かなくする。dialog 中心帯が knee 内で扱われるため、自然なフェード圧縮になる。
   *   - release は引き続き 1.0s（Chrome の nominal max）で句末ポンピング抑制を維持。
   * threshold/knee/attack/release を強めても 1ms 未満のピークは antiClipNode (limiter)
   * が後段で受け止めるため、瞬間ピーク抑制の二段構えは崩れない。
   */
  NIGHT_MODE_PRESET: Object.freeze({
    threshold: -30,
    knee: 12,
    ratio: 4.0,
    attack: 0.02,
    release: 1.0,
  }),
  /**
   * compressor 機能 OFF 時のバイパス設定（ratio:1 で実質パススルー）。
   * AudioContext の構築コストを避けるためチェーン上は常時接続のままパラメータで制御する。
   *
   * attack:0.003 / release:0.25 は Web Audio API の DynamicsCompressor デフォルト値。
   * `0` を渡すと Chrome が内部最小値 (~0.0003 秒) に clamp し DevTools 警告を出すケースが
   * あるため、安全側のデフォルト値を採用してパススルー時の DSP 負荷も最小化する。
   */
  COMPRESSOR_BYPASS: Object.freeze({
    threshold: 0,
    knee: 0,
    ratio: 1,
    attack: 0.003,
    release: 0.25,
  }),
  /**
   * 壁ドン対策モード用 highpass フィルタ段数。
   * 2次 Butterworth を2段直列にして Linkwitz-Riley 4次相当（24dB/oct）にする。
   * 1段（12dB/oct）ではカットオフ直下の低音が残りやすく、壁・床の振動対策として弱かった。
   */
  BASS_CUT_STAGES: 2,
  /**
   * 壁ドン対策モード用 highpass フィルタプリセット（各 BiquadFilterNode type:"highpass"）。
   * カットオフ 150Hz は、壁・床を伝って隣室に響きやすいサブベース〜低音域（ドスドス感の主因）を
   * 除去しつつ、ボーカルや楽器の芯（中音域）は残す落としどころ。各段の Q は 0.7071
   * （Butterworth）で固定し、同一段の直列化で共振ピークを作らず減衰だけを急峻にする。
   */
  BASS_CUT_PRESET: Object.freeze({
    frequency: 150,
    Q: 0.7071,
  }),
  /**
   * 壁ドン対策モード OFF 時のバイパス設定。highpass のカットオフを 0Hz にすると
   * 可聴域全体を素通しできる（disconnect/reconnect による音切れを避けるため、
   * COMPRESSOR_BYPASS と同じ「ノードは繋いだままパラメータで無効化」方式）。
   */
  BASS_CUT_BYPASS: Object.freeze({
    frequency: 0,
    Q: 0.7071,
  }),

  // ===== Firefox 専用 MES (MediaElementSource) 経路 =====
  /**
   * EME (DRM) 動画を多用するサイトの hostname ブラックリスト (Firefox MES 経路専用)。
   *
   * これらのサイトでは MediaElementSource 経路 (content script の volume-booster-mes.js) を
   * 起動しない。理由: `createMediaElementSource(video)` で video の音声経路を AudioContext に
   * redirect すると、EME 保護動画は復号後の音声 sample を AudioContext に流さない仕様
   * (Chrome / Firefox 共通) のため、結果として **動画の音そのものが完全無音化** する副作用がある。
   *
   * Chrome には tabCapture フォールバックがあるが、Firefox MV3 は tabCapture 未対応なので
   * これらのサイトでは音量ブースターは効かない (動画の音は普通に出る)。
   *
   * このリストにないサイトでも runtime で EME を検出した場合 (`mediaKeys` / `encrypted` event) は
   * volume-booster-mes.js が attach 回避 / detach する fallback がある。完璧な保護は
   * ホスト名ブラックリストのみなので、追加要望があったら hostname を確認して RegExp を追加すること。
   *
   * 履歴: v1.0.33 の MES 経路 (Chrome + Firefox 両対応、URL 分岐あり) 用に導入 → v1.0.35 で
   * MES 経路ごと撤去 → 2026-07-02 に Firefox 専用パイプラインとして復活 (Chrome は tabCapture 一本のまま)。
   */
  EME_HOSTS: Object.freeze([
    /(^|\.)netflix\.com$/,
    /(^|\.)primevideo\.com$/,
    // Amazon Prime Video は amazon.co.jp / amazon.com の `/gp/video/` 配下に統合されているため
    // 親ドメイン全体を入れる。Amazon ランキング機能 (amazon-ranking-jump.js) と同居するが、
    // ランキングは商品ページ DOM 操作 + 外部送信ゼロなので衝突しない (volume-booster-mes だけ EME skip)。
    /(^|\.)amazon\.co\.jp$/,
    /(^|\.)amazon\.com$/,
    /(^|\.)dazn\.com$/,
    /(^|\.)disneyplus\.com$/,
    /(^|\.)hulu\.com$/,
    /(^|\.)hulu\.jp$/,
    /(^|\.)tv\.apple\.com$/,
    /(^|\.)abema\.tv$/,
    /(^|\.)unext\.jp$/,
    /(^|\.)tver\.jp$/,
    /(^|\.)nhk-ondemand\.jp$/,
    /(^|\.)spotify\.com$/,
    /(^|\.)fod\.fujitv\.co\.jp$/,
    /(^|\.)spoox\.jp$/,
  ]),

  /**
   * hostname が EME_HOSTS のいずれかに該当するか判定する純粋関数 (Firefox MES 経路専用)。
   * volume-booster-mes.js が起動時に `location.hostname` を渡して MES 起動を skip する。
   *
   * @param {string|null|undefined} hostname `location.hostname` または URL から抽出した hostname
   * @returns {boolean} true なら EME 多用サイトで MES 経路を使わない
   */
  isEmeHost(hostname) {
    if (typeof hostname !== "string" || hostname.length === 0) return false;
    const lower = hostname.toLowerCase();
    for (const re of VolumeBooster.EME_HOSTS) {
      if (re.test(lower)) return true;
    }
    return false;
  },

  /**
   * MES attach 可否のためのメディアソース安全性分類 (Firefox MES 経路専用の純粋関数)。
   *
   * cross-origin かつ CORS 未検証のメディアに MediaElementSource を繋ぐと、Web Audio 仕様で
   * 例外ではなく **出力が無音になる** (site の音が消えたように見える最悪の failure mode)。
   * さらに Firefox では一度 attach した要素は `ctx.close()` でも直接出力に復帰しないため、
   * 誤 attach は「ページ再読み込みまで無音」になり得る。attach 前の分類で徹底的に防ぐ。
   * - `"safe"`: 即 attach してよい。blob: / data: (MSE・インラインは taint しない)、または
   *   `crossorigin` 属性付き http(s) (CORS 検証を通ったリソースしか再生されない = リダイレクト先も
   *   含めて taint し得ない)
   * - `"probe"`: same-origin http(s) かつ crossorigin 属性なし。URL 上は安全に見えるが、HTML 仕様上
   *   `currentSrc` は**リダイレクト前の URL** を返すため、same-origin → cross-origin redirect 配信
   *   (メディアプロキシ / presigned CDN 等) だと opaque taint で無音化する。caller が
   *   `redirect: "manual"` の same-origin HEAD probe で opaqueredirect でないことを確認してから
   *   attach する (probe 失敗 / redirect 検出時は attach しない = 音は普通に出る fail-safe)
   * - `"pending"`: ソース未確定 (currentSrc が空)。loadedmetadata / loadstart で再評価する
   * - `"unsafe"`: cross-origin かつ CORS 未検証。attach すると無音化するため skip
   *
   * `srcObject` (MediaStream 等) は URL を持たないため本関数の対象外で、caller が別途 safe 扱いする。
   *
   * @param {string|null|undefined} currentSrc `media.currentSrc`
   * @param {string|null|undefined} crossOrigin `media.crossOrigin` ("anonymous" / "use-credentials" / null)
   * @param {string} pageHref `location.href` (相対 URL 解決 + same-origin 判定基準)
   * @returns {"safe"|"probe"|"pending"|"unsafe"}
   */
  classifyMesSource(currentSrc, crossOrigin, pageHref) {
    if (typeof currentSrc !== "string" || currentSrc === "") return "pending";
    let url;
    try {
      url = new URL(currentSrc, pageHref);
    } catch {
      return "unsafe";
    }
    if (url.protocol === "blob:" || url.protocol === "data:") return "safe";
    if (url.protocol === "http:" || url.protocol === "https:") {
      // crossorigin 属性付きは CORS 検証済みリソースしか再生されない (redirect 先も含む) ため
      // same-origin / cross-origin を問わず safe
      if (crossOrigin === "anonymous" || crossOrigin === "use-credentials") return "safe";
      let pageOrigin = null;
      try {
        pageOrigin = new URL(pageHref).origin;
      } catch {
        // pageHref 不正時は same-origin 判定不能 → 安全側で unsafe に倒す
      }
      if (pageOrigin !== null && url.origin === pageOrigin) return "probe";
      return "unsafe";
    }
    return "unsafe";
  },

  // ===== グラフィックイコライザ (10 バンド peaking) =====
  /**
   * イコライザの中心周波数 (Hz)。各バンド ~1 オクターブ間隔。offscreen で
   * BiquadFilterNode(type:"peaking") を 10 個直列接続し、各 gain をスライダー値 (dB) に設定する。
   * 正規化 (撤去済み) と違ってフィードバックなしの固定フィルタなので決定論的で安定。
   */
  EQ_BANDS: Object.freeze([32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]),
  EQ_BAND_COUNT: 10,
  /** 各バンドの gain 範囲 (dB)。BiquadFilterNode.gain は peaking で dB 単位。 */
  EQ_GAIN_MIN: -12,
  EQ_GAIN_MAX: 12,
  EQ_GAIN_DEFAULT: 0,
  /** プリアンプ (全体ゲイン) 範囲 (dB)。各バンド boost によるクリップを補正する用途。 */
  EQ_PREAMP_MIN: -12,
  EQ_PREAMP_MAX: 12,
  EQ_PREAMP_DEFAULT: 0,
  /** peaking フィルタの Q。~1 オクターブ間隔 10 バンドの定番値 (√2 ≈ 1.41)。 */
  EQ_Q: 1.41,
  /** プリセット未選択 (手動調整) を表す id。EQ_PRESETS には含めない特別値。 */
  EQ_PRESET_CUSTOM: "custom",
  EQ_PRESET_DEFAULT: "flat",
  /**
   * 同梱プリセット。各値は EQ_BANDS と同順の 10 バンド gain (dB)。
   * popup のドロップダウンから選択でき、手動でスライダーを動かすと "custom" に切り替わる。
   *
   * コミュニティプリセット (eargasm / eargasmKai / perfect / perfectKai) の出典:
   * - eargasm: Spotify ユーザー間で世界的に有名な "Eargasm Explosion"。iTunes / eqMac 10 バンド
   *   原典 (dacci gist, iyusuke.jp 他)。perfect の 4kHz バンドだけを +9 → +4 に下げた派生として
   *   2014 年頃に登場 (日本発、SoraNews24 が英語圏に紹介)。
   * - eargasmKai: SONY Android WALKMAN NW-A100 シリーズ向けの「Eargasm Explosion 改」
   *   (楽天ブログ hisat 氏、2021-12-04)。低域 +10 / 超高域 +10 のドンシャリ強化型。
   *   NW-A100 の 31/62Hz は Vuora の 32/64Hz と同一バンドの別表記なので直接マッピング。
   * - perfect: 2004 年頃から iTunes 10 バンド EQ で「完璧過ぎる最強の EQ 設定」として広まった
   *   preset (hints.macworld.com 2004, methodshop.com)。eargasm と 4kHz バンド (+9 vs +4) のみ
   *   異なる原典。ゆろさん判断で iTunes 10 バンド原典を採用 (Spotify 6 バンド補間版は不採用)。
   * - perfectKai: perfect を全帯域 -6dB した派生 (minkara スバルフォレスター記事 / musicfab.ne.jp
   *   ガイドで値完全一致)。「カーブ形状維持 + スピーカー負担軽減」狙い。
   *
   * 出典の詳細・補間方法・調査経緯は memory-bank / PR #27 の deep-research 結果 (wnhg9pt91) 参照。
   */
  EQ_PRESETS: Object.freeze({
    flat: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    bassBoost: Object.freeze([6, 5, 4, 2, 0, 0, 0, 0, 0, 0]),
    trebleBoost: Object.freeze([0, 0, 0, 0, 0, 0, 2, 4, 5, 6]),
    vocal: Object.freeze([-2, -1, 0, 2, 3, 3, 2, 1, 0, -1]),
    loudness: Object.freeze([5, 4, 2, 0, -1, -1, 0, 2, 4, 5]),
    eargasm: Object.freeze([3, 6, 9, 7, 6, 5, 7, 4, 11, 8]),
    eargasmKai: Object.freeze([10, 10, 10, 6, 5, 4, 6, 3, 9, 10]),
    perfect: Object.freeze([3, 6, 9, 7, 6, 5, 7, 9, 11, 8]),
    perfectKai: Object.freeze([-3, 0, 3, 1, 0, -1, 1, 3, 5, 2]),
  }),
  /**
   * プリセット id → i18n キーの対応表。`EQ_PRESETS` の全キー + `EQ_PRESET_CUSTOM` を網羅。
   * popup の dropdown 構築でラベル表示に使う (旧実装は popup.js 側 const で TDZ workaround が
   * 必要だったが、データの正しい在処はプリセット定義と同じ actions.js)。
   */
  EQ_PRESET_I18N_KEYS: Object.freeze({
    flat: "volumeEqPresetFlat",
    bassBoost: "volumeEqPresetBass",
    trebleBoost: "volumeEqPresetTreble",
    vocal: "volumeEqPresetVocal",
    loudness: "volumeEqPresetLoudness",
    eargasm: "volumeEqPresetEargasm",
    eargasmKai: "volumeEqPresetEargasmKai",
    perfect: "volumeEqPresetPerfect",
    perfectKai: "volumeEqPresetPerfectKai",
    custom: "volumeEqPresetCustom",
  }),
  /** 1 バンドの gain を EQ_GAIN_MIN..MAX に clamp し整数化。不正値は EQ_GAIN_DEFAULT。 */
  clampEqGain(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return VolumeBooster.EQ_GAIN_DEFAULT;
    if (n < VolumeBooster.EQ_GAIN_MIN) return VolumeBooster.EQ_GAIN_MIN;
    if (n > VolumeBooster.EQ_GAIN_MAX) return VolumeBooster.EQ_GAIN_MAX;
    return Math.round(n);
  },
  /** プリアンプを EQ_PREAMP_MIN..MAX に clamp し整数化。不正値は EQ_PREAMP_DEFAULT。 */
  clampEqPreamp(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return VolumeBooster.EQ_PREAMP_DEFAULT;
    if (n < VolumeBooster.EQ_PREAMP_MIN) return VolumeBooster.EQ_PREAMP_MIN;
    if (n > VolumeBooster.EQ_PREAMP_MAX) return VolumeBooster.EQ_PREAMP_MAX;
    return Math.round(n);
  },
  /**
   * 任意の入力を 10 バンドの gain 配列に正規化する。
   * 配列でなければ全 EQ_GAIN_DEFAULT、長さ不足は補完、超過は切り捨て、各要素 clampEqGain。
   */
  clampEqGains(arr) {
    const src = Array.isArray(arr) ? arr : [];
    const out = new Array(VolumeBooster.EQ_BAND_COUNT);
    for (let i = 0; i < VolumeBooster.EQ_BAND_COUNT; i += 1) {
      out[i] = VolumeBooster.clampEqGain(src[i] ?? VolumeBooster.EQ_GAIN_DEFAULT);
    }
    return out;
  },
  /** プリセット id を正規化。既知プリセット or CUSTOM のみ許可、未知は EQ_PRESET_DEFAULT。 */
  normalizeEqPreset(id) {
    if (id === VolumeBooster.EQ_PRESET_CUSTOM) return VolumeBooster.EQ_PRESET_CUSTOM;
    return Object.hasOwn(VolumeBooster.EQ_PRESETS, id)
      ? id
      : VolumeBooster.EQ_PRESET_DEFAULT;
  },
  /** プリセット id から 10 バンド gain 配列 (コピー) を返す。CUSTOM / 未知は null。 */
  eqPresetGains(id) {
    if (Object.hasOwn(VolumeBooster.EQ_PRESETS, id)) {
      return VolumeBooster.EQ_PRESETS[id].slice();
    }
    return null;
  },
});

/**
 * @readonly 動画ガンマ補正（独自実装）の定数。
 *
 * `<video>` 要素に対して SVG `<feComponentTransfer type="gamma">` フィルタを適用し、
 * 暗い動画を明るくしたり、明るすぎる動画のコントラストを抑えたりする画質補正。
 *
 * 全タブ共通の単一値（タブごと独立ではない）。マスタートグル ON 時のみ content script が
 * SVG filter と style 要素を `<body>` に注入し、`video { filter: url(#__cpa-video-gamma) }`
 * で適用する。マスタートグル OFF / ガンマ値 1.0 のいずれかで filter を解除（DOM クリーンアップ）。
 *
 * SVG ガンマ式: C' = amplitude * pow(C, exponent) + offset。amplitude=1, offset=0, exponent=N
 * のとき純粋なガンマ補正。N < 1 で暗部を持ち上げて全体的に明るく、N > 1 で暗部を潰して暗く。
 */
const VideoGamma = Object.freeze({
  MIN: 0.3,
  MAX: 3.0,
  /** 補正なし（filter 不適用と等価）。スライダー中央位置。 */
  DEFAULT: 1.0,
  /**
   * スライダー UI の整数表現。中央 (SLIDER_DEFAULT) = ガンマ 1.0、
   * 右端 (SLIDER_MAX) = ガンマ MIN (明るい)、左端 (SLIDER_MIN) = ガンマ MAX (暗い) という
   * 対称配置。`<input type="range">` の `min/max/step` と直結し、左右半分で線形マッピングする。
   */
  SLIDER_MIN: 0,
  SLIDER_MAX: 200,
  SLIDER_DEFAULT: 100,
  SLIDER_STEP: 1,
  /** SVG filter の id（ページ側 CSS と衝突しないよう __cpa- 接頭辞）。 */
  FILTER_ID: "__cpa-video-gamma",
  /** 注入する SVG 要素の id（同上）。 */
  SVG_ID: "__cpa-video-gamma-svg",
  clampValue(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return VideoGamma.DEFAULT;
    if (n < VideoGamma.MIN) return VideoGamma.MIN;
    if (n > VideoGamma.MAX) return VideoGamma.MAX;
    // 0.01 単位に丸めて round-trip 誤差を抑える。
    return Math.round(n * 100) / 100;
  },
  /**
   * スライダー整数 (SLIDER_MIN..SLIDER_MAX) → 実ガンマ値 (MIN..MAX)。
   *
   * 中央 (SLIDER_DEFAULT) = DEFAULT (1.0) を境に左右半分で別の線形マッピングを行う:
   *   - 左半分 [SLIDER_MIN..SLIDER_DEFAULT] → ガンマ [MAX..DEFAULT] (3.0..1.0、暗い側)
   *   - 右半分 [SLIDER_DEFAULT..SLIDER_MAX] → ガンマ [DEFAULT..MIN] (1.0..0.3、明るい側)
   *
   * 「右が明るい」UX を保ちつつ、SVG filter の exponent は素直に渡せるよう
   * UI 値 ↔ ガンマ値の変換だけここで反転させる。
   */
  sliderToValue(sliderInt) {
    const n = Number(sliderInt);
    if (!Number.isFinite(n)) return VideoGamma.DEFAULT;
    const s = Math.min(VideoGamma.SLIDER_MAX, Math.max(VideoGamma.SLIDER_MIN, n));
    if (s <= VideoGamma.SLIDER_DEFAULT) {
      const t = (VideoGamma.SLIDER_DEFAULT - s) / (VideoGamma.SLIDER_DEFAULT - VideoGamma.SLIDER_MIN);
      return VideoGamma.clampValue(VideoGamma.DEFAULT + t * (VideoGamma.MAX - VideoGamma.DEFAULT));
    }
    const t = (s - VideoGamma.SLIDER_DEFAULT) / (VideoGamma.SLIDER_MAX - VideoGamma.SLIDER_DEFAULT);
    return VideoGamma.clampValue(VideoGamma.DEFAULT - t * (VideoGamma.DEFAULT - VideoGamma.MIN));
  },
  /** sliderToValue の逆関数。実ガンマ値 → スライダー整数。 */
  valueToSlider(value) {
    const v = VideoGamma.clampValue(value);
    if (v >= VideoGamma.DEFAULT) {
      const t = (v - VideoGamma.DEFAULT) / (VideoGamma.MAX - VideoGamma.DEFAULT);
      return Math.round(VideoGamma.SLIDER_DEFAULT - t * (VideoGamma.SLIDER_DEFAULT - VideoGamma.SLIDER_MIN));
    }
    const t = (VideoGamma.DEFAULT - v) / (VideoGamma.DEFAULT - VideoGamma.MIN);
    return Math.round(VideoGamma.SLIDER_DEFAULT + t * (VideoGamma.SLIDER_MAX - VideoGamma.SLIDER_DEFAULT));
  },
  /** ガンマ値が DEFAULT (1.0) と十分近いか。content script が DOM 注入をスキップする判定用。 */
  isUnity(value) {
    const v = VideoGamma.clampValue(value);
    return Math.abs(v - VideoGamma.DEFAULT) < 0.005;
  },
});

/**
 * @readonly 動画黒帯除去（ワイド表示）の定数。
 *
 * ウルトラワイド画面（21:9 / 32:9 等）で動画の上下/左右に出るレターボックス黒帯を、
 * `<video>` 要素への CSS `transform` で除去する独自実装。考え方は "UltraWide Video" 系
 * 拡張機能を参考にしているが、コードは流用せず、動画メタの外部送信等は一切行わない
 * （本プロジェクトの「外部送信ゼロ」方針を堅持）。
 *
 * **方式: 「モニターの縦横比だけユーザーが選び、動画側の縦横比は自動検出」**
 *   - ユーザーは popup のドロップダウンで「お使いのモニターの縦横比 / 解像度」(= targetAspect) を選ぶ。
 *   - content script は各 `<video>` の intrinsic 縦横比 (videoWidth/videoHeight) を読み、
 *     targetAspect いっぱいに収まる拡大率を **動画ごとに** 計算して transform を当てる。
 *   - これにより 16:9 動画でも 21:9 シネマ動画でも 4:3 動画でも、それぞれ正しく黒帯を除去できる
 *     （「動画は 16:9 固定」と決め打ちしないので、動画がワイドなケースでも破綻しない）。
 *
 * 2 モード:
 *   - zoom    : `scale(s)` でアスペクト比を保ったまま拡大（はみ出した辺はクロップ）
 *   - stretch : `scaleX(s)` / `scaleY(s)` で不足軸のみ引き伸ばし（比率は変わるがクロップなし）
 *
 * content script は per-video で `el.style.transform` を `!important` で当て/外しする
 * （MutationObserver で新規 video を追従、loadedmetadata で intrinsic サイズ確定を待つ）。
 * マスター OFF、または「動画とモニターの縦横比が一致して補正不要」のときは transform を外す。
 */
const VideoFill = Object.freeze({
  MODE_ZOOM: "zoom",
  MODE_STRETCH: "stretch",
  DEFAULT_MODE: "zoom",
  /** 計算結果の拡大率の上限（4:3 動画 → 32:9 等の極端な組み合わせの暴走を防ぐ）。 */
  MAX_SCALE: 4.0,
  /** ON 直後の既定ターゲット（最も普及しているウルトラワイド）。 */
  DEFAULT_TARGET: "21:9",
  /**
   * モニターのプリセット一覧（popup のドロップダウンの単一情報源）。
   *   - id     : storage に保存する識別子
   *   - group  : "aspect"（縦横比）/ "resolution"（解像度）。optgroup 振り分け用
   *   - label  : 表示文字列（数値のみなのでロケール非依存、i18n 不要）
   *   - aspect : 目標縦横比（W/H）。解像度は実ピクセルから算出した値を直接持つ
   */
  PRESETS: Object.freeze([
    Object.freeze({ id: "16:9", group: "aspect", label: "16:9", aspect: 16 / 9 }),
    Object.freeze({ id: "16:10", group: "aspect", label: "16:10", aspect: 16 / 10 }),
    Object.freeze({ id: "21:9", group: "aspect", label: "21:9", aspect: 2560 / 1080 }),
    Object.freeze({ id: "24:10", group: "aspect", label: "24:10", aspect: 24 / 10 }),
    Object.freeze({ id: "32:9", group: "aspect", label: "32:9", aspect: 32 / 9 }),
    Object.freeze({ id: "1920x1080", group: "resolution", label: "1920×1080 (16:9)", aspect: 1920 / 1080 }),
    Object.freeze({ id: "2560x1080", group: "resolution", label: "2560×1080 (21:9)", aspect: 2560 / 1080 }),
    Object.freeze({ id: "3440x1440", group: "resolution", label: "3440×1440 (21:9)", aspect: 3440 / 1440 }),
    Object.freeze({ id: "3840x1600", group: "resolution", label: "3840×1600 (24:10)", aspect: 3840 / 1600 }),
    Object.freeze({ id: "5120x1440", group: "resolution", label: "5120×1440 (32:9)", aspect: 5120 / 1440 }),
  ]),
  /** optgroup の並び順とラベル i18n キー。 */
  GROUPS: Object.freeze([
    Object.freeze({ id: "aspect", messageKey: "videoFillGroupAspect" }),
    Object.freeze({ id: "resolution", messageKey: "videoFillGroupResolution" }),
  ]),
  normalizeMode(mode) {
    return mode === VideoFill.MODE_STRETCH ? VideoFill.MODE_STRETCH : VideoFill.MODE_ZOOM;
  },
  /** ターゲット id を検証。未知の値は DEFAULT_TARGET にフォールバック。 */
  normalizeTarget(id) {
    for (const p of VideoFill.PRESETS) if (p.id === id) return id;
    return VideoFill.DEFAULT_TARGET;
  },
  /** ターゲット id → 目標縦横比（W/H）。未知なら DEFAULT_TARGET の縦横比。 */
  targetAspect(id) {
    for (const p of VideoFill.PRESETS) if (p.id === id) return p.aspect;
    for (const p of VideoFill.PRESETS) if (p.id === VideoFill.DEFAULT_TARGET) return p.aspect;
    return 16 / 9;
  },
  /**
   * 目標縦横比 (targetAspect) と動画の実寸 (videoW × videoH) から、その動画を
   * モニターいっぱいに収めるための CSS transform 文字列を組み立てる pure function。
   *
   * - zoom    : アスペクト比を保ったまま、収まっている側の辺を埋めるよう一様 `scale(s)`。
   *             s = (target >= video) ? target/video : video/target （常に 1 以上、はみ出しはクロップ）。
   * - stretch : 不足している軸だけを引き伸ばす（`scaleX` または `scaleY`）。クロップは発生しない。
   *
   * 補正不要（動画とモニターの縦横比がほぼ一致）なら空文字を返し、呼び出し側は transform を外す。
   * 値は数値のみを埋め込む（ユーザー入力経路なし）ため XSS リスクゼロ。MAX_SCALE で clamp。
   *
   * @returns {string} "scale(1.33)" / "scaleX(1.33)" / "scaleY(1.2)" / "" のいずれか
   */
  computeTransform(targetAspect, videoW, videoH, mode) {
    const ta = Number(targetAspect);
    const va = Number(videoW) / Number(videoH);
    if (!Number.isFinite(ta) || ta <= 0) return "";
    if (!Number.isFinite(va) || va <= 0) return "";
    const clamp = (s) => Math.round(Math.min(VideoFill.MAX_SCALE, Math.max(1, s)) * 1000) / 1000;
    const EPS = 0.01;
    if (VideoFill.normalizeMode(mode) === VideoFill.MODE_STRETCH) {
      if (ta > va + EPS) return `scaleX(${clamp(ta / va)})`;
      if (va > ta + EPS) return `scaleY(${clamp(va / ta)})`;
      return "";
    }
    const s = ta >= va ? ta / va : va / ta;
    if (s <= 1 + 0.005) return "";
    return `scale(${clamp(s)})`;
  },
});

/**
 * @readonly ルーペ機能（独自実装）の定数。
 *
 * `chrome.tabs.captureVisibleTab` で active tab の静止画を JPEG quality:70 で取得し、
 * content script の `position: fixed` 円形レンズに `background-image` として貼り付ける。
 * マウス座標 (clientX/clientY) から `background-position` をリアルタイム計算 (60fps、rAF コアレス)
 * してレンズに「カーソル下を拡大した内容」を表示する仕組み。
 *
 * iframe / canvas / video の現在フレームも captureVisibleTab で「描画ピクセル」として取得できるため、
 * 動画を一時停止して細部を確認する用途に最適。テキストはビットマップ拡大で多少ぼやけるが、
 * 動画 / iframe を含む汎用拡大鏡として機能する。DOM clone 方式と異なり Trusted Types の影響を受けない。
 *
 * 設計上の不変条件:
 *   - 全 http(s) サイトの top frame に注入（all_frames: false）
 *   - 左クリックで OFF（master トグル OFF と同じ挙動 + storage の loupeEnabled も false に書き戻し）
 *   - 再キャプチャ trigger: 初回 / scroll 500ms debounced / MutationObserver(childList, subtree:false) / resize
 *   - メモリ管理: DataURL を Blob URL に変換して <img>/background-image で参照、cleanup 時に必ず revoke
 *   - z-index: 2147483646 (image-downloader と同値で前面確保)
 *   - tabs.onActivated での自動適用はしない（visibilitychange で旧タブ cleanup、新タブは OFF 開始）
 *
 * 関連 storage key:
 *   - LOUPE_ENABLED (boolean, default false): マスタートグル
 *   - LOUPE_ZOOM (number, default 2.5): 倍率（ZOOM_LEVELS のいずれか）
 *   - LOUPE_SIZE (number, default 220): レンズ直径 px（SIZE_MIN..MAX）
 */
const Loupe = Object.freeze({
  /** 選択可能な倍率の列挙（popup のセグメントコントロールの 3 ボタンに対応） */
  ZOOM_LEVELS: Object.freeze([1.5, 2.5, 4.0]),
  /** デフォルト倍率（必ず ZOOM_LEVELS に含まれる値であること） */
  DEFAULT_ZOOM: 2.5,
  /** レンズ直径の最小値 (px)。これより小さいと中央のクロスヘアと倍率バッジが視認困難 */
  SIZE_MIN: 150,
  /** レンズ直径の最大値 (px)。1000 までは「画面の大部分を覆う巨大ルーペ」用途（小さい表 / 細字法律文書を
   *  ほぼ全画面で読みたい等）を想定。一般的な viewport (1920×1080 / 1440×900) でも画面に収まり、
   *  4× 倍率なら 250×250 ピクセル分を 1000×1000 で見られる */
  SIZE_MAX: 1000,
  /** デフォルトレンズ直径 (px)。SIZE_MIN..SIZE_MAX の中央値より小さめで、初期表示で邪魔にならない位置 */
  SIZE_DEFAULT: 220,
  /** スライダーの step (px)。10px 単位で十分滑らかな調整感、storage の値が無駄に細かくなるのを防ぐ */
  SIZE_STEP: 10,
  /** captureVisibleTab の JPEG 品質 (0-100)。70 で payload 約 300-600KB、視認性とのバランス最適 */
  CAPTURE_QUALITY: 70,
  /**
   * スクロール / DOM 変化 / resize 後の再キャプチャ debounce (ms)。
   * captureVisibleTab の Chrome 公式レート上限は 2fps = 500ms ごと 1 回までなので、
   * これより短い debounce 値にすると quota エラーが発生する。500ms は最小安全値。
   */
  RECAPTURE_DEBOUNCE_MS: 500,
  /** 注入する DOM 要素の id 名 / class 名 */
  LENS_ID: "__cpa-loupe-lens",
  CLASS_LENS: "__cpa-loupe-lens",
  CLASS_CROSSHAIR: "__cpa-loupe-crosshair",
  CLASS_BADGE: "__cpa-loupe-badge",

  /**
   * 倍率値の正規化。ZOOM_LEVELS に含まれない値（不正な storage 値、古いバージョンからの移行値等）は
   * DEFAULT_ZOOM にフォールバック。文字列 / NaN / null / undefined も同様に DEFAULT_ZOOM。
   *
   * @param {unknown} v 検証する倍率値
   * @returns {number} ZOOM_LEVELS のいずれかの値
   */
  validateZoom(v) {
    const n = Number(v);
    if (Loupe.ZOOM_LEVELS.includes(n)) return n;
    return Loupe.DEFAULT_ZOOM;
  },

  /**
   * レンズ直径の正規化。SIZE_MIN..SIZE_MAX に clamp し、SIZE_STEP 単位に丸める。
   * 不正値（NaN / 文字列 / undefined）は SIZE_DEFAULT にフォールバック。
   *
   * @param {unknown} v 検証するサイズ値
   * @returns {number} SIZE_MIN..SIZE_MAX の整数（SIZE_STEP の倍数）
   */
  clampSize(v) {
    // null は Number(null) === 0 になるため、明示的に DEFAULT へ倒す。
    // storage 未設定時の `undefined` も DEFAULT 扱い（uninitialized 値を MIN に倒さない）。
    if (v === null || v === undefined) return Loupe.SIZE_DEFAULT;
    const n = Number(v);
    if (!Number.isFinite(n)) return Loupe.SIZE_DEFAULT;
    const clamped = Math.min(Loupe.SIZE_MAX, Math.max(Loupe.SIZE_MIN, n));
    return Math.round(clamped / Loupe.SIZE_STEP) * Loupe.SIZE_STEP;
  },

  /**
   * マウス座標からレンズ DOM の screen 上の left/top 座標を計算する pure function。
   * カーソルがレンズの中央に来るように配置する。viewport 端を超えても clamp はしない
   * (典型的なルーペ UX に合わせて、レンズの一部が画面外にはみ出すのを許容)。
   *
   * @param {number} mouseX clientX
   * @param {number} mouseY clientY
   * @param {number} lensSize レンズ直径 px
   * @returns {{left: number, top: number}}
   */
  computeLensPosition(mouseX, mouseY, lensSize) {
    const r = lensSize / 2;
    return {
      left: mouseX - r,
      top: mouseY - r,
    };
  },

  /**
   * マウス座標からレンズの `background-position` 値を計算する pure function。
   *
   * 設計:
   *   - background-size = viewport * zoom（キャプチャ画像を倍率で拡大した内部仮想サイズ）
   *   - background-position はその拡大画像を「レンズ div の左上を起点に」どこにオフセットするか
   *   - カーソル位置 (mouseX, mouseY) に対応する画像ピクセル (mouseX*zoom, mouseY*zoom) を
   *     レンズの中心 (r, r) に重ねるための shift = (r - mouseX*zoom, r - mouseY*zoom)
   *
   * @param {number} mouseX clientX
   * @param {number} mouseY clientY
   * @param {number} zoom 倍率（ZOOM_LEVELS のいずれか）
   * @param {number} lensRadius レンズ半径 px（lensSize / 2）
   * @returns {{bgX: number, bgY: number}}
   */
  computeBackgroundPosition(mouseX, mouseY, zoom, lensRadius) {
    return {
      bgX: lensRadius - mouseX * zoom,
      bgY: lensRadius - mouseY * zoom,
    };
  },

  /**
   * background から返ってくる error code を i18n キー文字列に変換する pure function。
   * 想定: 将来 popup に「ルーペが起動できなかった理由」を表示する hint 領域を追加する際の橋渡し
   * （音量ブースターの `formatVolumeError` と同型の設計）。
   *
   * **現状はまだ呼び出し元なし**: content script は console.warn でエラー詳細を残し、ユーザーへの
   * 通知は「レンズが表示されない」という暗黙的フィードバックに留めている。popup の hint 領域を
   * 整備するときに `chrome.i18n.getMessage(formatLoupeError(res.error))` として呼び出す予定。
   * テスト (test/actions.test.js) は事前に書いてあるので、将来導入時に追加検証は不要。
   *
   * @param {string|undefined|null} code background エラー code
   * @returns {string} i18n キー
   */
  formatLoupeError(code) {
    if (!code) return "loupeErrorUnknown";
    const s = String(code);
    if (/no tab|invalid-tab-id|tab not found|cannot find tab/i.test(s)) return "loupeErrorInvalidTab";
    if (/not allowed|cannot capture|chrome:|edge:|file:|about:/i.test(s)) {
      return "loupeErrorUnsupportedPage";
    }
    if (/permission/i.test(s)) return "loupeErrorPermission";
    if (/MAX_CAPTURE|quota/i.test(s)) return "loupeErrorQuota";
    return "loupeErrorUnknown";
  },
});

/**
 * @readonly YouTube ライブ配信の接続モニター（独自実装）の定数。
 *
 * ライブ視聴中に「クルクル（バッファリング）の原因」を切り分けて表示する HUD 機能。
 * `*://*.youtube.com/*` の watch / live ページ top frame のみで動作し、`<video>.duration === Infinity`
 * のときだけ計測ループとオーバーレイを起動する（通常動画では一切介入しない）。
 *
 * ## 計測ソース（クライアントサイドのみ・外部送信なし）
 *   - `<video>.getVideoPlaybackQuality()` → droppedVideoFrames / totalVideoFrames（PC 性能切り分け）
 *   - `<video>` の `waiting` / `playing` イベント → バッファリング開始 / 終了のピンポイント検知
 *   - `<video>.buffered` / `currentTime` → 先読みバッファ秒数
 *   - `navigator.connection` → downlink (Mbps) / rtt (ms) / effectiveType（回線品質）
 *
 * ## 経路診断（公開無認証 endpoint への RTT 計測のみ・個人特定情報なし）
 *   - Google 側 RTT: `https://www.gstatic.com/generate_204` (Google が ChromeOS/Android 接続確認用に
 *     公開している 204 No Content endpoint、no-cors + GET で軽量)
 *   - Cloudflare 側 RTT: `https://speed.cloudflare.com/__down?bytes=10` (Cloudflare 公式 speedtest endpoint。
 *     初期実装の `https://1.1.1.1/cdn-cgi/trace` は ISP / 企業 firewall / OS DNS 設定によって 1.1.1.1 への
 *     直 IP HTTPS アクセスがブロックされる環境が一定数あり、実機実測で TypeError 連発を確認したため変更。
 *     `speed.cloudflare.com` は HTTPS でドメイン解決経由、地理的に近い Cloudflare エッジへ確実に到達する)
 *   - 両者は **代表 CDN への到達時間** を比較対照する目的で固定。例えば Google だけ遅ければ
 *     YouTube CDN/Google エッジ側の不調、両方遅ければ国際線/中継 ISP 経路の遅延と推定する。
 *   - fetch は `mode:"no-cors"` + `credentials:"omit"` + `referrerPolicy:"no-referrer"` で
 *     クロスオリジン Cookie 送信ゼロ・リファラ送信ゼロを保証する。
 *
 * ## 判定ヒューリスティクス（直近 30 秒の中央値ベース）
 *   - buffering 発生時 downlink が baseline の `DOWNLINK_DROP_RATIO` 以下 → **回線が原因**
 *   - dropped frames 増分が `DROPPED_FRAME_RATIO` 以上 → **PC 性能が原因**
 *   - 両方該当しない場合は経路診断:
 *       - Google も Cloudflare も < `RTT_GOOD_MS` → **YouTube CDN 個別不調**
 *       - Google だけ > `RTT_BAD_MS` → **Google エッジ / ルーティング異常**
 *       - 両方 > `RTT_BAD_MS` → **国際線 / 中継 ISP 経由の遅延**
 *   - 直近 1 分間 buffering 0 回 → **安定**
 *
 * ## 動作対象 / 設計上の不変条件
 *   - master OFF / 非 YouTube / 非ライブ / orphan 化のいずれかで HUD・タイマー・listener を完全撤去
 *   - top frame 限定（埋め込みプレイヤーには介入しない）
 *   - VERDICT 値は popup / content script の表示分岐キーに使う固定文字列（i18n キーへのマッピングは
 *     content script 側で行う、ここでは識別子のみ）
 */
const ConnectionMonitor = Object.freeze({
  /** メイン計測タイマー間隔（video 状態 + Network Information API スナップショット） */
  SAMPLE_INTERVAL_MS: 1000,
  /** 経路診断タイマー間隔（generate_204 + speed.cloudflare.com への fetch RTT 計測） */
  DIAGNOSIS_INTERVAL_MS: 5000,
  /** メイン計測の ring buffer サイズ（直近 30 秒分） */
  RING_BUFFER_SIZE: 30,
  /** 経路診断の ring buffer サイズ（直近 6 サンプル ≒ 30 秒の中央値判定用） */
  DIAGNOSIS_BUFFER_SIZE: 6,
  /** 経路診断 fetch の timeout（DIAGNOSIS_INTERVAL_MS 未満に抑えて重複発射を防ぐ） */
  ENDPOINT_TIMEOUT_MS: 4500,
  /** 経路診断: Google 側 endpoint（204 No Content を返す軽量診断 URL） */
  ENDPOINT_GOOGLE: "https://www.gstatic.com/generate_204",
  /** 経路診断: Cloudflare 側 endpoint（Cloudflare 公式 speedtest 用、bytes=10 で最小ペイロード）。
   * 1.1.1.1 直 IP / cdn-cgi/trace パスは ISP / firewall でブロックされる環境があるため speed.cloudflare.com に変更 */
  ENDPOINT_CLOUDFLARE: "https://speed.cloudflare.com/__down?bytes=10",

  /** baseline 帯域中央値に対するこの比率以下なら「回線が原因」と判定する閾値（0.5 = 50%） */
  DOWNLINK_DROP_RATIO: 0.5,
  /** 直近サンプル間の dropped frames 増分 / 総フレームがこの比率以上なら「PC 性能不足」と判定する閾値（0.3 = 30%） */
  DROPPED_FRAME_RATIO: 0.3,
  /** RTT がこの値未満なら「高速」扱い（経路診断ロジック用） */
  RTT_GOOD_MS: 100,
  /** RTT がこの値超過なら「異常」扱い（経路診断ロジック用） */
  RTT_BAD_MS: 200,
  /** 「直近 N 分の buffering 回数」を集計するウィンドウ */
  BUFFERING_WINDOW_MS: 60_000,

  /** HUD の最小描画間隔（mousemove や value 微変動で再描画しすぎないように間引く） */
  RENDER_THROTTLE_MS: 250,

  /** バッファリングイベントを「直近」として扱う期間。BUFFERING_WINDOW_MS と同じ */
  EVENT_RETENTION_MS: 60_000,

  /**
   * 動画 chunk の実 throughput 計測の最小バイト数。これ未満の chunk は warmup overhead が支配して
   * throughput 指標として無意味なので除外する（manifest / 末尾 segment / range-request の小片など）。
   * 50KB なら ~1 秒分の audio chunk より大きく、video chunk として意味ある粒度。
   */
  VIDEO_CHUNK_MIN_BYTES: 50_000,

  /** 実 throughput サンプルの保持ウィンドウ（60 秒で min/avg/max を計算） */
  VIDEO_THROUGHPUT_WINDOW_MS: 60_000,

  /**
   * 結論識別子（popup / content script の表示分岐用）。i18n メッセージキーへのマッピングは
   * content script 側で `cm_verdict_<id>_label` のような prefix で行う設計。
   */
  VERDICT: Object.freeze({
    STABLE: "stable",
    NETWORK: "network",
    DEVICE: "device",
    YOUTUBE_CDN: "youtube_cdn",
    ROUTING: "routing",
    INTERNATIONAL: "international",
    UNKNOWN: "unknown",
  }),

  /** オーバーレイ位置（ドラッグで動かしたあとの座標）の localStorage キー */
  LS_KEY_OVERLAY_POS: "__cpa_cm_overlay_pos",
  /** オーバーレイ折りたたみ状態の localStorage キー */
  LS_KEY_OVERLAY_COLLAPSED: "__cpa_cm_overlay_collapsed",

  /**
   * 数値列の中央値（不正値・空配列で null を返す純粋関数）。
   * baseline 計算 / RTT サンプル集約に使う。
   */
  median(values) {
    if (!Array.isArray(values)) return null;
    const xs = values.filter((v) => Number.isFinite(v));
    if (xs.length === 0) return null;
    const sorted = xs.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  },

  /**
   * 状態スナップショットを判定識別子に変換する純粋関数。
   *
   * @param {object} input
   *   - bufferingCountRecent: 直近 BUFFERING_WINDOW_MS の buffering 回数
   *   - downlinkBaseline: 直近 baseline downlink 中央値 (Mbps、null 許容)
   *   - downlinkDuringBuffering: buffering 発生時の downlink 中央値 (Mbps、null 許容)
   *   - droppedFramesRatio: 直近の dropped/total フレーム比 (0..1、null 許容)
   *   - googleRttMedian: Google 診断 endpoint の RTT 中央値 (ms、null 許容)
   *   - cloudflareRttMedian: Cloudflare 診断 endpoint の RTT 中央値 (ms、null 許容)
   * @returns {string} VERDICT.* の値
   */
  classify(input) {
    if (!input || typeof input !== "object") return ConnectionMonitor.VERDICT.UNKNOWN;
    const {
      bufferingCountRecent = 0,
      downlinkBaseline = null,
      downlinkDuringBuffering = null,
      droppedFramesRatio = null,
      googleRttMedian = null,
      cloudflareRttMedian = null,
    } = input;

    // バッファリング 0 回 → 安定
    if (bufferingCountRecent === 0) return ConnectionMonitor.VERDICT.STABLE;

    // 回線が原因: buffering 発生時の downlink が baseline の 50% 以下
    if (
      Number.isFinite(downlinkBaseline) &&
      Number.isFinite(downlinkDuringBuffering) &&
      downlinkBaseline > 0 &&
      downlinkDuringBuffering <= downlinkBaseline * ConnectionMonitor.DOWNLINK_DROP_RATIO
    ) {
      return ConnectionMonitor.VERDICT.NETWORK;
    }

    // PC 性能不足: 直近 dropped frames 比率が 30% 以上
    if (
      Number.isFinite(droppedFramesRatio) &&
      droppedFramesRatio >= ConnectionMonitor.DROPPED_FRAME_RATIO
    ) {
      return ConnectionMonitor.VERDICT.DEVICE;
    }

    // 経路診断: Google と Cloudflare の RTT を比較
    const googleOk = Number.isFinite(googleRttMedian);
    const cfOk = Number.isFinite(cloudflareRttMedian);
    if (googleOk && cfOk) {
      if (googleRttMedian < ConnectionMonitor.RTT_GOOD_MS && cloudflareRttMedian < ConnectionMonitor.RTT_GOOD_MS) {
        return ConnectionMonitor.VERDICT.YOUTUBE_CDN;
      }
      if (googleRttMedian > ConnectionMonitor.RTT_BAD_MS && cloudflareRttMedian < ConnectionMonitor.RTT_GOOD_MS) {
        return ConnectionMonitor.VERDICT.ROUTING;
      }
      if (googleRttMedian > ConnectionMonitor.RTT_BAD_MS && cloudflareRttMedian > ConnectionMonitor.RTT_BAD_MS) {
        return ConnectionMonitor.VERDICT.INTERNATIONAL;
      }
    }

    // 経路診断が不確定なら YouTube CDN 側を疑う（最も無難な fallback）
    return ConnectionMonitor.VERDICT.YOUTUBE_CDN;
  },
});

/**
 * @readonly YouTube 配信アーカイブの「配信時刻オーバーレイ」定数 + 純粋関数。
 *
 * ライブ配信のアーカイブ（過去のライブを VOD 化したもの）を再生中、その瞬間が「実際に
 * 配信されていた時刻」をプレーヤー内 HUD に重ねて表示する独自実装。配信開始時刻
 * （liveBroadcastDetails.startTimestamp）に再生位置（video.currentTime）を加算して算出する。
 *
 * データ取得: content script（isolated world）からは MAIN world の ytInitialPlayerResponse を
 * 直接読めないため、`/watch?v=<id>` を same-origin fetch して HTML 内の liveBroadcastDetails を
 * 正規表現で抽出する（search-fixer.js の /feed/channels 取得と同型の same-origin 認証 fetch、
 * credentials:"same-origin" + redirect:"manual"。外部送信ゼロの方針内＝自オリジンへの取得のみ）。
 *
 * 対象: liveBroadcastDetails を持ち、かつ配信終了済み（isLiveNow !== true）のアーカイブのみ。
 * 通常動画・配信中のライブ・プレミア公開待ちには表示しない。
 *
 * 精度の限界: currentTime=0 が配信開始ちょうどに対応する線形マッピング前提のため、配信途中の
 * 回線断・再接続や編集カットがあるアーカイブでは、その地点以降に実時刻がずれる（原理的限界で
 * どんな実装でも避けられない）。
 *
 * 純粋関数（extractVideoId / parseLiveBroadcastDetails / computeBroadcastEpochMs / formatTimestamp）
 * は test/actions.test.js で境界値テストする。
 */
const BroadcastClock = Object.freeze({
  /** 配信情報（startMs / endMs / isLiveNow）の sessionStorage cache prefix（videoId 単位）。
   *  HTML fetch を動画ごと 1 回に抑える。負例（通常動画＝配信由来でない）も `{ none: true }` で cache する */
  CACHE_PREFIX: "__cpa_bc_info_v1::",

  /** オーバーレイ位置（ドラッグ後の座標）の localStorage キー */
  LS_KEY_OVERLAY_POS: "__cpa_bc_overlay_pos",

  /** HUD 再描画の最小間隔（時刻表示は秒粒度なので 250ms で十分） */
  RENDER_THROTTLE_MS: 250,

  /**
   * URL / location（search や pathname）から YouTube videoId（11 文字）を抽出する純粋関数。
   * `/watch?v=<id>` と `/live/<id>` の両形式に対応。取れなければ null。
   * @param {string} input location.search / location.pathname / 完全 URL いずれも可
   * @returns {string|null}
   */
  extractVideoId(input) {
    if (typeof input !== "string" || input.length === 0) return null;
    const liveM = input.match(/\/live\/([A-Za-z0-9_-]{11})(?:[/?#&]|$)/);
    if (liveM) return liveM[1];
    const vM = input.match(/[?&]v=([A-Za-z0-9_-]{11})(?:[&#]|$)/);
    if (vM) return vM[1];
    return null;
  },

  /**
   * watch ページの HTML から liveBroadcastDetails を抽出する純粋関数。
   *
   * liveBroadcastDetails はフラットなオブジェクト
   * （`{"isLiveNow":false,"startTimestamp":"...","endTimestamp":"..."}`）なので、
   * nested brace を含まない `[^{}]*` で 1 ブロックを安全に切り出せる。
   *
   * @param {string} html
   * @returns {{ startMs:number, endMs:(number|null), isLiveNow:boolean } | null}
   *   startTimestamp が取れない（＝配信由来でない通常動画）ときは null。
   */
  parseLiveBroadcastDetails(html) {
    if (typeof html !== "string" || html.length === 0) return null;
    const block = html.match(/"liveBroadcastDetails"\s*:\s*\{[^{}]*\}/);
    if (!block) return null;
    const seg = block[0];
    const startM = seg.match(/"startTimestamp"\s*:\s*"([^"]+)"/);
    if (!startM) return null;
    const startMs = Date.parse(startM[1]);
    if (!Number.isFinite(startMs)) return null;
    const endM = seg.match(/"endTimestamp"\s*:\s*"([^"]+)"/);
    const endMs = endM ? Date.parse(endM[1]) : NaN;
    const isLiveNow = /"isLiveNow"\s*:\s*true/.test(seg);
    return {
      startMs,
      endMs: Number.isFinite(endMs) ? endMs : null,
      isLiveNow,
    };
  },

  /**
   * 配信開始 epoch(ms) と再生位置(sec) から、その瞬間の実時刻 epoch(ms) を返す純粋関数。
   * @param {number} startMs 配信開始時刻（epoch ms）
   * @param {number} currentTimeSec 再生位置（秒）。非有限・負値は 0 とみなす
   * @returns {number|null} startMs が非有限なら null
   */
  computeBroadcastEpochMs(startMs, currentTimeSec) {
    if (!Number.isFinite(startMs)) return null;
    const t = Number.isFinite(currentTimeSec) && currentTimeSec > 0 ? currentTimeSec : 0;
    return startMs + t * 1000;
  },

  /**
   * epoch(ms) を `yyyy/MM/dd　hh:mm:ss`（全角スペース区切り・全桁ゼロ埋め・24 時間制・ローカルタイム）
   * に整形する純粋関数。非有限値 / Invalid Date は空文字を返す。
   * @param {number} epochMs
   * @returns {string}
   */
  formatTimestamp(epochMs) {
    if (!Number.isFinite(epochMs)) return "";
    const d = new Date(epochMs);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return (
      `${p(d.getFullYear(), 4)}/${p(d.getMonth() + 1)}/${p(d.getDate())}` +
      `　${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    );
  },
});

/**
 * @readonly NotebookLM 送信の定数とプロトコル純粋関数。
 *
 * YouTube の動画 / 検索結果 / プレイリスト / チャンネルの URL を、ユーザー自身の Google
 * アカウントの NotebookLM にソースとして追加する。NotebookLM には公開 API が存在しないため、
 * Web アプリ自身が使う `batchexecute` RPC を利用する（Google の非公開内部エンドポイント）。
 *
 * **重要な前提**:
 *   - RPC ID (`RPC_*`) は Google 側の都合で予告なく変わる。壊れたら「NotebookLM 側の変更」を
 *     まず疑うこと。UI 自動操作より壊れにくいが、公開契約ではない
 *   - 認証はユーザーのブラウザに既にある Google セッション Cookie に依存する
 *     （`credentials: "include"` の cross-origin fetch。拡張は資格情報を保存も送信もしない）
 *   - 送信されるのは **ユーザーがボタンを押したときの YouTube URL だけ**。視聴履歴の収集や
 *     バックグラウンド送信は行わない
 *
 * トークンはトップページ HTML の埋め込み値を使う: `cfb2h` = build label (`bl` パラメータ)、
 * `SNlM0e` = XSRF トークン (`at` パラメータ)。
 */
const NotebookLm = Object.freeze({
  /**
   * NotebookLM Web アプリのオリジン（トークン取得と RPC の宛先）。
   *
   * **復活禁止: `notebook.google.com`**。旧オリジンは `notebooklm.google.com` へ 302 する
   * だけの別ホストで、`redirect:"manual"` 必須の設計では opaqueredirect（`res.ok === false`）
   * になり、**ログイン済みでも必ず not-authorized**（「ログインしてください」）に落ちていた。
   */
  ORIGIN: "https://notebooklm.google.com",
  /** batchexecute エンドポイント（Web アプリ内部 RPC の入口）。 */
  BATCH_PATH: "/_/LabsTailwindUi/data/batchexecute",
  /** ソース仕様（1 ソース分の配列）の要素数。末尾は必ず `1`。 */
  SOURCE_SPEC_LENGTH: 11,
  /** ノートブック新規作成。ペイロードは `[title, null, null, options]`、応答から UUID を拾う。 */
  RPC_CREATE_NOTEBOOK: "CCqFvf",
  /** ソース追加。ペイロードは `[sources, notebookId, options]`（options 必須）。 */
  RPC_ADD_SOURCES: "izAoDd",
  /** ノートブック一覧。ペイロードは `[null, 1, null, [2]]`。 */
  RPC_LIST_NOTEBOOKS: "wXbhsf",
  /** プラン判定（1 ノートブックあたりのソース上限を返す）。 */
  RPC_SOURCE_LIMIT: "ozz5Z",
  /** RPC_SOURCE_LIMIT の固定ペイロード（Web アプリが送っている値そのまま）。 */
  SOURCE_LIMIT_PAYLOAD: '[[[[null,"1",627],null,1]]]',
  /** 上限判定に失敗したときのフォールバック（無料プラン相当の保守的な値）。 */
  SOURCE_LIMIT_FALLBACK: 50,
  /** Plus 表示が無いアカウントで採用する上限（background のマジックナンバー再掲を解消）。 */
  SOURCE_LIMIT_PLUS: 300,
  /** NotebookLM への各 fetch のタイムアウト（無いと送信ボタンが固着する / rere RC-C）。 */
  FETCH_TIMEOUT_MS: 20000,
  /** 一括送信 1 回あたりに DOM から集める URL の上限（暴走防止のハードキャップ）。 */
  MAX_COLLECT: 300,
  /** 一覧に表示するノートブックの上限。 */
  MAX_LIST: 50,
  /** 選択できる Google アカウント（`authuser`）の最大インデックス。 */
  MAX_ACCOUNT_INDEX: 9,
  /**
   * ログイン中アカウントのメールアドレスが入っている WIZ キー（実機で確認）。
   * `extractToken(html, ACCOUNT_EMAIL_KEY)` で 1 件だけ取れる。取れなくなったら
   * 「アカウント N」という番号だけの表示にフォールバックする（機能は止めない）。
   */
  ACCOUNT_EMAIL_KEY: "oPEP7c",
  /**
   * アカウント probe でメールアドレスを探す最大バイト数（超えたら諦める）。
   * 実測では `ACCOUNT_EMAIL_KEY` はトップページ HTML の先頭 10%（約 33 KB / 全体 330 KB）に
   * 現れるため、ストリームを途中で打ち切れば転送量を 1 桁減らせる。
   */
  ACCOUNT_SCAN_MAX_CHARS: 262144,
  /** アカウント一覧キャッシュの有効期間（12 時間）。ログインの増減はこの周期で追従する。 */
  ACCOUNTS_CACHE_TTL_MS: 12 * 60 * 60 * 1000,

  /**
   * アカウントインデックス（`authuser`）を正規化する（純粋関数）。
   * マルチログイン環境では既定アカウント以外で NotebookLM を使っていることがあり、
   * 指定しないと常に u/0 に解決される（/rere D-5）。
   *
   * @param {unknown} value storage / メッセージ由来の生値
   * @returns {number} 0 〜 MAX_ACCOUNT_INDEX の整数（不正値は 0）
   */
  normalizeAccountIndex(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > NotebookLm.MAX_ACCOUNT_INDEX) return 0;
    return n;
  },

  /**
   * batchexecute への 1 リクエスト分の URL と body を組み立てる（純粋関数）。
   *
   * **リクエスト形状をテスト可能にするための切り出し**（/rere B2-10）。応答パース側は
   * 純粋関数化されていたのに、`f.req` のネスト段数・`at` / `bl` / `source-path` / `rt` の
   * 付与といった送信側は fetch に埋め込まれていて、リグレッションが CI を素通りしていた。
   *
   * @param {{rpcId: string, payload: string, sourcePath: string, bl: string, at: string,
   *          reqId: number|string, accountIndex?: number}} input
   * @returns {{url: string, body: string}}
   */
  buildRpcRequest(input) {
    const accountIndex = NotebookLm.normalizeAccountIndex(input?.accountIndex);
    const params = new URLSearchParams({
      rpcids: String(input?.rpcId ?? ""),
      "source-path": String(input?.sourcePath ?? "/"),
      bl: String(input?.bl ?? ""),
      // _reqid は Web アプリが付ける連番。値自体に意味はないので範囲内の乱数で足りる。
      _reqid: String(input?.reqId ?? ""),
      rt: "c",
    });
    // authuser は既定アカウント (0) のときは付けない（Web アプリの挙動に合わせる）。
    if (accountIndex > 0) params.set("authuser", String(accountIndex));
    const body = new URLSearchParams({
      "f.req": JSON.stringify([[[String(input?.rpcId ?? ""), String(input?.payload ?? ""), null, "generic"]]]),
      at: String(input?.at ?? ""),
    }).toString();
    return { url: `${NotebookLm.ORIGIN}${NotebookLm.BATCH_PATH}?${params.toString()}`, body };
  },

  /**
   * トークン取得用のトップページ URL を組み立てる（純粋関数）。
   * @param {number} [accountIndex]
   */
  buildHomeUrl(accountIndex) {
    const n = NotebookLm.normalizeAccountIndex(accountIndex);
    return n > 0 ? `${NotebookLm.ORIGIN}/?authuser=${n}` : `${NotebookLm.ORIGIN}/`;
  },

  /**
   * ノートブックの表示 URL を組み立てる（純粋関数）。
   * アカウント指定があるときは `authuser` を保って開かないと、既定アカウントで開いて
   * 「作ったはずのノートブックが無い」状態になる。
   *
   * @param {string} notebookId
   * @param {number} [accountIndex]
   */
  buildNotebookUrl(notebookId, accountIndex) {
    const n = NotebookLm.normalizeAccountIndex(accountIndex);
    const base = `${NotebookLm.ORIGIN}/notebook/${notebookId}`;
    return n > 0 ? `${base}?authuser=${n}` : base;
  },

  /**
   * ノートブック一覧の応答からノートブック配列を取り出す（純粋関数）。
   * batchexecute の応答は 1 行目に長さ、以降に JSON 断片が並ぶ独自フレーミングで、
   * 実データは 4 行目 (index 3) の JSON の `[0][2]` に**文字列として**入れ子になっている。
   *
   * @param {string|null|undefined} text 応答ボディ
   * @returns {unknown[]|null} 内側の配列、または取り出せなければ null
   */
  parseBatchPayload(text) {
    if (typeof text !== "string" || text === "") return null;
    try {
      const line = text.split("\n")[3];
      if (!line) return null;
      const outer = JSON.parse(line);
      const inner = outer?.[0]?.[2];
      if (typeof inner !== "string") return null;
      const parsed = JSON.parse(inner);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },

  /**
   * ノートブック一覧の応答を `{id, name, sources, emoji}` の配列に正規化する（純粋関数）。
   * 6 番目の要素が `[3, ...]` のエントリは自分のノートブックではない（共有・お手本）ので除外する。
   *
   * @param {string|null|undefined} text 応答ボディ
   * @returns {Array<{id: string, name: string, sources: number, emoji: string}>}
   */
  parseNotebookList(text) {
    const rows = NotebookLm.parseBatchPayload(text)?.[0];
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const row of rows) {
      if (out.length >= NotebookLm.MAX_LIST) break;
      if (!Array.isArray(row) || row.length < 6) continue;
      const kind = row[5];
      if (Array.isArray(kind) && kind.length > 0 && kind[0] === 3) continue;
      const [name, sources, id, emoji] = row;
      if (typeof id !== "string" || id === "") continue;
      out.push({
        id,
        name: typeof name === "string" && name.trim() !== "" ? name.trim() : "Untitled notebook",
        sources: Array.isArray(sources) ? sources.length : 0,
        emoji: typeof emoji === "string" && emoji !== "" ? emoji : "📔",
      });
    }
    return out;
  },

  /**
   * ページ HTML に埋め込まれた `"key":"value"` 形式のトークンを取り出す（純粋関数）。
   * `cfb2h`（build label）と `SNlM0e`（XSRF トークン）の取得に使う。
   *
   * @param {string|null|undefined} html ページ HTML
   * @param {string} key トークンのキー
   * @returns {string|null}
   */
  extractToken(html, key) {
    if (typeof html !== "string" || typeof key !== "string" || key === "") return null;
    const m = html.match(new RegExp(`"${key}":"([^"]+)"`));
    return m ? m[1] : null;
  },

  /**
   * ノートブック作成応答から UUID を取り出す（純粋関数）。
   *
   * @param {string|null|undefined} text 応答ボディ
   * @returns {string|null}
   */
  extractNotebookId(text) {
    if (typeof text !== "string") return null;
    const m = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    return m ? m[0] : null;
  },

  /**
   * URL 配列を RPC_ADD_SOURCES のソース配列に変換する（純粋関数）。
   * YouTube URL は「YouTube ソース」用の 8 番目のスロット、それ以外は「Web サイト」用の
   * 3 番目のスロットに入れる（NotebookLM 側でソース種別が変わる）。
   *
   * **ソース仕様は 11 要素で、末尾（index 10）に `1` が必須**。旧実装は URL スロットまでの
   * 短い配列（YouTube 8 要素 / Web 3 要素）を送っており、サーバーは 200 + 正常フレームを
   * 返すのにソースが 1 件も登録されない（＝空のノートブックが開く）状態だった。
   *
   * @param {ReadonlyArray<string>|null|undefined} urls
   * @returns {Array<Array<unknown>>}
   */
  buildSourcePayload(urls) {
    if (!Array.isArray(urls)) return [];
    const out = [];
    const seen = new Set();
    for (const url of urls) {
      if (typeof url !== "string" || url === "") continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const spec = new Array(NotebookLm.SOURCE_SPEC_LENGTH).fill(null);
      spec[NotebookLm.isYouTubeUrl(url) ? 7 : 2] = [url];
      spec[NotebookLm.SOURCE_SPEC_LENGTH - 1] = 1;
      out.push(spec);
    }
    return out;
  },

  /**
   * RPC_ADD_SOURCES の 3 番目に付ける共通リクエストオプション（純粋関数）。
   * NotebookLM の Web アプリが notebook スコープの RPC に必ず付けている capability 宣言で、
   * これが無いとバックエンドのルーティングが変わりソース追加が黙って無視される。
   *
   * @returns {Array<unknown>} 毎回新しい配列（呼び出し側での破壊的変更を持ち越さない）
   */
  buildRequestOptions() {
    return [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]];
  },

  /** URL が YouTube の動画 URL か判定する（純粋関数）。 */
  isYouTubeUrl(url) {
    if (typeof url !== "string") return false;
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
    } catch {
      return false;
    }
  },

  /**
   * videoId から正規化した watch URL を作る（純粋関数）。
   * DOM 上の href は `?t=` や `&list=` を伴うことがあり、そのまま送ると NotebookLM 側で
   * 別ソース扱いになって重複するため、常に `https://www.youtube.com/watch?v=<id>` に揃える。
   *
   * @param {string|null|undefined} href `/watch?v=xxx&list=...` などの href
   * @returns {string|null} 正規化 URL または null
   */
  normalizeWatchUrl(href) {
    if (typeof href !== "string" || href === "") return null;
    let id = null;
    const m = href.match(/[?&]v=([\w-]{11})(?:[&#]|$)/);
    if (m) id = m[1];
    else {
      const short = href.match(/(?:youtu\.be\/|\/shorts\/|\/live\/|\/embed\/)([\w-]{11})(?:[/?#]|$)/);
      if (short) id = short[1];
    }
    return id ? `https://www.youtube.com/watch?v=${id}` : null;
  },
});

/**
 * @readonly カラーピッカー（独自実装）の定数。
 *
 * Web 標準の EyeDropper API（Chrome 95+。本拡張機能の minimum_chrome_version は 140）で
 * 画面上のピクセル色を採取し、HEX / RGB / HSL の 3 形式で表示・コピーする小さな採色机。
 * 履歴は `chrome.storage.local` に最大 20 件まで保持し、popup を閉じても永続化される。
 *
 * 動作対象: 拡張機能ポップアップ (src/popup/popup.html) のタブ内のみ。Web ページに対する
 * DOM/CSS 操作・content script 注入は一切なく、外部送信ゼロ。色形式変換はすべて独自の
 * 数学変換（IEC 61966-2-1 sRGB の HSL 変換アルゴリズム）。
 */
const ColorPicker = Object.freeze({
  /** 履歴の保存上限（FIFO：超えたら末尾から削除） */
  HISTORY_LIMIT: 20,
  /** 既定の出力形式（ユーザー未設定時のフォールバック） */
  DEFAULT_FORMAT: "hex",
  /** 利用可能な出力形式の一覧（順序は UI の表示順と一致させること） */
  FORMATS: Object.freeze(["hex", "rgb", "hsl"]),
  /** HEX 検証用。先頭 # 必須、6 桁または 3 桁短縮形を許容 */
  HEX_RE: /^#([0-9a-f]{6}|[0-9a-f]{3})$/i,

  /** "hex" / "rgb" / "hsl" のいずれかなら true */
  isValidFormat(value) {
    return ColorPicker.FORMATS.includes(value);
  },

  /** 不正値はデフォルト形式 "hex" にフォールバック */
  normalizeFormat(value) {
    return ColorPicker.isValidFormat(value) ? value : ColorPicker.DEFAULT_FORMAT;
  },
});

/**
 * @readonly Popup のタブ識別子。
 *
 * v1.0.x: タブを「アシスト / カラーピッカー」の 2 つから「調整 / YouTube /
 * Instagram / TikTok / カラーピッカー」の 5 つに再編。アコーディオンを廃止して
 * YouTube 機能拡張 (34 機能)・Instagram クリーナー (11 機能)・TikTok クリーナー (3 機能)
 * を専用タブで直接表示する設計に移行した。
 *
 * 旧値 "assist" は `migrate()` で "tune" に変換する（POPUP_LAST_TAB の後方互換）。
 */
const PopupTabs = Object.freeze({
  TUNE: "tune",
  YOUTUBE: "youtube",
  INSTAGRAM: "instagram",
  TIKTOK: "tiktok",
  X: "x",
  PICKER: "picker",
  /** UI の並び順と一致させる（矢印キー巡回の順序に使われる）。X は YouTube の次に置く。 */
  ALL: Object.freeze(["tune", "youtube", "x", "instagram", "tiktok", "picker"]),

  /** タブ識別子のいずれかなら true */
  isValid(value) {
    return PopupTabs.ALL.includes(value);
  },

  /** 不正値はデフォルト "tune" にフォールバック */
  normalize(value) {
    return PopupTabs.isValid(value) ? value : PopupTabs.TUNE;
  },

  /**
   * 旧値 "assist" を "tune" に変換しつつ正規化する。background の `onInstalled`
   * マイグレーションと、popup 起動時のフォールバック読み出しの両方で使う。
   */
  migrate(value) {
    if (value === "assist") return PopupTabs.TUNE;
    return PopupTabs.normalize(value);
  },
});

  /**
   * /rere レビュー B1-002 修正 (簡易版): APPLY_SETTINGS 経路で popup → background → content script
   * 間で同期される設定の **単一情報源**。background.js の `normalizeSettings` / `toStorageRecord` /
   * `notifyContentScripts` の 3 関数を手書きで実装する現状の保険として、本配列を test/actions.test.js
   * から照合し、新機能追加時に「StorageKey と Actions の整合は取れているか」「3 関数すべてで配線が
   * 揃っているか」を CI 検知する。
   *
   * v1.0.29 で発覚した RTX 動画強化機能完全破壊バグ (A2-001) と同型の drift を再発防止する。
   *
   * 各エントリ:
   *   - field: settings オブジェクトのキー名 (popup → background で送る field 名)
   *   - storageKey: chrome.storage.local のキー (StorageKeys 参照)
   *   - applyAction: background → content script の APPLY_*_CS メッセージ (Actions 参照、null = 配信なし)
   *
   * 将来 schema 駆動化する場合は本配列に normalize / urlPattern / frameId 関数を追加し、
   * 3 関数を generated にする (中規模リファクタ、別 PR シリーズ)。
   */
  const SettingsSchema = Object.freeze([
    Object.freeze({ field: "searchFixerEnabled", storageKey: StorageKeys.SEARCH_FIXER_ENABLED, applyAction: Actions.APPLY_SEARCH_FIXER_CS }),
    Object.freeze({ field: "searchFixerFeatures", storageKey: StorageKeys.SEARCH_FIXER_FEATURES, applyAction: Actions.APPLY_SEARCH_FIXER_CS }),
    Object.freeze({ field: "searchFixerGridItems", storageKey: StorageKeys.SEARCH_FIXER_GRID_ITEMS, applyAction: Actions.APPLY_SEARCH_FIXER_CS }),
    Object.freeze({ field: "amazonDeliveryTotalEnabled", storageKey: StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED, applyAction: Actions.APPLY_AMAZON_DELIVERY_TOTAL_CS }),
    Object.freeze({ field: "amazonRankingJumpEnabled", storageKey: StorageKeys.AMAZON_RANKING_JUMP_ENABLED, applyAction: Actions.APPLY_AMAZON_RANKING_JUMP_CS }),
    Object.freeze({ field: "amazonMerchantInfoEnabled", storageKey: StorageKeys.AMAZON_MERCHANT_INFO_ENABLED, applyAction: Actions.APPLY_AMAZON_MERCHANT_INFO_CS }),
    Object.freeze({ field: "instagramCleanerEnabled", storageKey: StorageKeys.INSTAGRAM_CLEANER_ENABLED, applyAction: Actions.APPLY_INSTAGRAM_CLEANER_CS }),
    Object.freeze({ field: "instagramCleanerFeatures", storageKey: StorageKeys.INSTAGRAM_CLEANER_FEATURES, applyAction: Actions.APPLY_INSTAGRAM_CLEANER_CS }),
    Object.freeze({ field: "tiktokCleanerEnabled", storageKey: StorageKeys.TIKTOK_CLEANER_ENABLED, applyAction: Actions.APPLY_TIKTOK_CLEANER_CS }),
    Object.freeze({ field: "tiktokCleanerFeatures", storageKey: StorageKeys.TIKTOK_CLEANER_FEATURES, applyAction: Actions.APPLY_TIKTOK_CLEANER_CS }),
    Object.freeze({ field: "xCleanerEnabled", storageKey: StorageKeys.X_CLEANER_ENABLED, applyAction: Actions.APPLY_X_CLEANER_CS }),
    Object.freeze({ field: "xCleanerFeatures", storageKey: StorageKeys.X_CLEANER_FEATURES, applyAction: Actions.APPLY_X_CLEANER_CS }),
    Object.freeze({ field: "videoGammaEnabled", storageKey: StorageKeys.VIDEO_GAMMA_ENABLED, applyAction: Actions.APPLY_VIDEO_GAMMA_CS }),
    Object.freeze({ field: "videoGammaValue", storageKey: StorageKeys.VIDEO_GAMMA_VALUE, applyAction: Actions.APPLY_VIDEO_GAMMA_CS }),
    Object.freeze({ field: "videoFillEnabled", storageKey: StorageKeys.VIDEO_FILL_ENABLED, applyAction: Actions.APPLY_VIDEO_FILL_CS }),
    Object.freeze({ field: "videoFillMode", storageKey: StorageKeys.VIDEO_FILL_MODE, applyAction: Actions.APPLY_VIDEO_FILL_CS }),
    Object.freeze({ field: "videoFillTarget", storageKey: StorageKeys.VIDEO_FILL_TARGET, applyAction: Actions.APPLY_VIDEO_FILL_CS }),
    Object.freeze({ field: "loupeEnabled", storageKey: StorageKeys.LOUPE_ENABLED, applyAction: Actions.APPLY_LOUPE_CS }),
    // 接続モニターは searchFixerFeatures.connectionMonitor サブ機能のため SettingsSchema には独立 entry を持たない。
  ]);

  // P0-#2: 全定数を globalThis に明示的に公開する。これで content scripts / popup / offscreen /
  // background が `Actions.X` の bare 名でアクセスできる（globalThis のプロパティは bare 名で
  // 参照可能という JS 言語仕様）。Chrome 実装の script scope 共有に依存しない安全な設計。
  globalThis.SettingsSchema = SettingsSchema;
  globalThis.Actions = Actions;
  globalThis.ExtensionPaths = ExtensionPaths;
  globalThis.SenderCheck = SenderCheck;
  globalThis.Offscreen = Offscreen;
  globalThis.StorageKeys = StorageKeys;
  globalThis.YouTubeShorts = YouTubeShorts;
  globalThis.SearchFixer = SearchFixer;
  globalThis.AmazonDeliveryTotal = AmazonDeliveryTotal;
  globalThis.AmazonRankingJump = AmazonRankingJump;
  globalThis.AmazonMerchantInfo = AmazonMerchantInfo;
  globalThis.InstagramCleaner = InstagramCleaner;
  globalThis.TikTokCleaner = TikTokCleaner;
  globalThis.XCleaner = XCleaner;
  globalThis.ImageDownloader = ImageDownloader;
  globalThis.VolumeBooster = VolumeBooster;
  globalThis.VideoGamma = VideoGamma;
  globalThis.VideoFill = VideoFill;
  globalThis.Loupe = Loupe;
  globalThis.ConnectionMonitor = ConnectionMonitor;
  globalThis.BroadcastClock = BroadcastClock;
  globalThis.NotebookLm = NotebookLm;
  globalThis.ColorPicker = ColorPicker;
  globalThis.PopupTabs = PopupTabs;
})();
