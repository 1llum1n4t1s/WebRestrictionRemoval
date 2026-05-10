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
  /** background → YouTube content script: YouTube クリーナー設定を反映（Shorts 削除も含む） */
  APPLY_SEARCH_FIXER_CS: "applySearchFixerCS",
  /** background → Amazon 定期おトク便 content script: 合計金額表示の有効/無効を反映 */
  APPLY_AMAZON_DELIVERY_TOTAL_CS: "applyAmazonDeliveryTotalCS",
  /** background → keepalive content script: セッション維持設定を反映 */
  APPLY_KEEP_ALIVE_CS: "applyKeepAliveCS",
  /** background → Instagram content script: Instagram クリーナー設定を反映 */
  APPLY_INSTAGRAM_CLEANER_CS: "applyInstagramCleanerCS",
  /** background → TikTok content script: TikTok クリーナー設定を反映 */
  APPLY_TIKTOK_CLEANER_CS: "applyTiktokCleanerCS",
  /** background → video-gamma content script: <video> ガンマ補正設定を反映（全タブ共通設定） */
  APPLY_VIDEO_GAMMA_CS: "applyVideoGammaCS",
  /** popup → background: 音量ブースターの gain を指定タブで変更 */
  VOLUME_BOOSTER_SET_GAIN: "volumeBoosterSetGain",
  /** popup → background: 指定タブのブーストを解放（スライダー 100% 復帰時） */
  VOLUME_BOOSTER_RELEASE_TAB: "volumeBoosterReleaseTab",
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
  /** セッション維持機能の有効/無効 */
  KEEP_ALIVE_ENABLED: "keepAliveEnabled",
  /** セッション維持のポーリング間隔（ミリ秒） */
  KEEP_ALIVE_INTERVAL_MS: "keepAliveIntervalMs",
  /** セッション維持の HTTP ping 機能の有効/無効（オプトイン・デフォルト OFF）。
   *  master が ON でもこれが OFF のときは合成イベント dispatch のみ行い HTTP ping は出さない。
   *  認証プロキシ環境（Zscaler 等）で 401/302 ループや SIEM ログアラートを誘発するのを避ける用途。 */
  KEEP_ALIVE_HTTP_PING_ENABLED: "keepAliveHttpPingEnabled",
  /** セッション維持を許可した origin 一覧（例: https://example.com）。サイト単位で効かせる。 */
  KEEP_ALIVE_ORIGINS: "keepAliveOrigins",
  /** YouTube クリーナーマスタートグル（Shorts 削除・コメント欄非表示・ライブチャット非表示・登録チャンネル拡張を含む全 29 サブ機能の親） */
  SEARCH_FIXER_ENABLED: "searchFixerEnabled",
  /** YouTube クリーナーの個別機能オン/オフ（オブジェクト） */
  SEARCH_FIXER_FEATURES: "searchFixerFeatures",
  /** ホームページのリッチグリッド列数（0 = YouTube デフォルト、4/5/6 が選択肢） */
  SEARCH_FIXER_GRID_ITEMS: "searchFixerGridItems",
  /** Amazon 定期おトク便ページの月別合計金額表示の有効/無効 */
  AMAZON_DELIVERY_TOTAL_ENABLED: "amazonDeliveryTotalEnabled",
  /** Instagram クリーナーマスタートグル */
  INSTAGRAM_CLEANER_ENABLED: "instagramCleanerEnabled",
  /** Instagram クリーナーの個別機能オン/オフ（オブジェクト） */
  INSTAGRAM_CLEANER_FEATURES: "instagramCleanerFeatures",
  /** TikTok クリーナーマスタートグル */
  TIKTOK_CLEANER_ENABLED: "tiktokCleanerEnabled",
  /** TikTok クリーナーの個別機能オン/オフ（オブジェクト） */
  TIKTOK_CLEANER_FEATURES: "tiktokCleanerFeatures",
  /** 音量ブースター: マスタートグル（OFF 時は全タブの AudioContext を解放しパイプラインをカット。設定値は残す） */
  VOLUME_BOOSTER_ENABLED: "volumeBoosterEnabled",
  /** 音量ブースター: 保存されたスライダー位置 (0–300%)。マスター ON 時にタブ切替で自動適用される */
  VOLUME_BOOSTER_LAST_GAIN: "volumeBoosterLastGain",
  /** 音量ブースター: 自動歪み防止（DynamicsCompressor で hard limit 化） */
  VOLUME_BOOSTER_ANTI_CLIP_ENABLED: "volumeBoosterAntiClipEnabled",
  /** 音量ブースター: 自動音量正規化（短時間RMSを測って自動ゲイン調整） */
  VOLUME_BOOSTER_NORMALIZE_ENABLED: "volumeBoosterNormalizeEnabled",
  /** 音量ブースター: ナイトモード（ゲーム配信用途） */
  VOLUME_BOOSTER_NIGHT_MODE_ENABLED: "volumeBoosterNightModeEnabled",
  /** 動画ガンマ補正: マスタートグル（OFF 時は SVG filter 一切注入せず completely no-op） */
  VIDEO_GAMMA_ENABLED: "videoGammaEnabled",
  /** 動画ガンマ補正: ガンマ値（VideoGamma.MIN..MAX、デフォルト 1.0 = 補正なし） */
  VIDEO_GAMMA_VALUE: "videoGammaValue",
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

/** @readonly セッション維持機能の定数 */
const KeepAlive = Object.freeze({
  MS_PER_MIN: 60_000,
  /** デフォルトのポーリング間隔（4分） */
  DEFAULT_INTERVAL_MS: 4 * 60 * 1000,
  MIN_INTERVAL_MS: 1 * 60 * 1000,
  MAX_INTERVAL_MS: 15 * 60 * 1000,
  /** SharePoint 等のサイトプリセット（同一オリジン GET 用） */
  PRESET_ENDPOINTS: Object.freeze([
    Object.freeze({
      name: "SharePoint",
      test: (hostname) =>
        /(^|\.)sharepoint\.(com|cn|de|us)$/i.test(hostname),
      paths: Object.freeze(["/_api/web"]),
    }),
  ]),
  clampIntervalMs(ms) {
    if (!Number.isFinite(ms)) return KeepAlive.DEFAULT_INTERVAL_MS;
    if (ms < KeepAlive.MIN_INTERVAL_MS) return KeepAlive.MIN_INTERVAL_MS;
    if (ms > KeepAlive.MAX_INTERVAL_MS) return KeepAlive.MAX_INTERVAL_MS;
    return ms;
  },
  normalizeOrigin(value) {
    if (typeof value !== "string") return null;
    try {
      const u = new URL(value);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.origin;
    } catch {
      return null;
    }
  },
  normalizeOrigins(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    for (const raw of value) {
      const origin = KeepAlive.normalizeOrigin(raw);
      if (origin) seen.add(origin);
      if (seen.size >= 100) break;
    }
    return Array.from(seen);
  },
  isOriginAllowed(origins, origin) {
    const normalized = KeepAlive.normalizeOrigin(origin);
    if (!normalized) return false;
    if (!Array.isArray(origins)) return false;
    // normalizeOrigins() を毎回呼んで Array→Set→Array 変換するコストを避けるため、
    // 早期 return しつつ N 回 normalizeOrigin で比較する（hit 時に O(k), miss 時に O(N)）。
    for (const raw of origins) {
      if (KeepAlive.normalizeOrigin(raw) === normalized) return true;
    }
    return false;
  },
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
 * @readonly YouTube クリーナーの機能定義と定数（独自実装）。変数名は履歴的に `SearchFixer` を使用。
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
  Object.freeze({ key: "removeTopicsSection", category: "video_filter" }),
  Object.freeze({ key: "removeBreakingNewsSection", category: "video_filter" }),
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

const SearchFixer = Object.freeze({
  FEATURES: SearchFixerFeatures,

  // category.label は _locales/.../messages.json の `category<CamelId>` (例: categoryMenuUi)。
  CATEGORIES: Object.freeze([
    Object.freeze({ id: "menu_ui",      icon: "🧭" }),
    Object.freeze({ id: "video_filter", icon: "🗑️" }),
    Object.freeze({ id: "watch_page",   icon: "🎬" }),
    Object.freeze({ id: "search_only",  icon: "🔍" }),
  ]),

  DEFAULT_FEATURES: SearchFixerDefaultFeatures,

  // option.label は _locales/.../messages.json の `gridAuto` / `grid4Cols` / `grid5Cols` / `grid6Cols`。
  GRID_OPTIONS: Object.freeze([
    Object.freeze({ value: 0, messageKey: "gridAuto" }),
    Object.freeze({ value: 4, messageKey: "grid4Cols" }),
    Object.freeze({ value: 5, messageKey: "grid5Cols" }),
    Object.freeze({ value: 6, messageKey: "grid6Cols" }),
  ]),

  FEED_PATH_PREFIXES: SearchFixerFeedPathPrefixes,

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
      /^[a-z0-9-]+\.cdninstagram\.com$/,
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
      /^[a-z0-9-]+\.tiktokcdn(-us)?\.com$/,
      /^[a-z0-9-]+\.tiktokcdn-us\.com$/,
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
    } catch (_err) {
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
   * スライダー percent (0..MAX) を実 gain 倍率に変換する対数マッピング。
   *
   * 100% = 1.0x (unity) / MAX% = 3.0x の anchor を維持しつつ、
   * 100..MAX 区間を「等距離スライダー = 等 dB ステップ」になるよう対数で配分する。
   * 結果として 100→200 と 200→300 で同じ ~4.8dB ずつ上がるためドラッグ体感が均一化される。
   *
   * 0..100 区間（attenuation）は使用頻度が低いため線形のまま (percent/100)。
   *
   * 例: percentToGain(200) ≈ 1.73x (+4.8dB), percentToGain(300) = 3.0x (+9.5dB)
   */
  percentToGain(percent) {
    const p = VolumeBooster.clampValue(percent);
    if (p === VolumeBooster.UNITY) return 1;
    if (p < VolumeBooster.UNITY) return p / 100;
    const maxDb = 20 * Math.log10(VolumeBooster.MAX / 100);
    const t = (p - VolumeBooster.UNITY) / (VolumeBooster.MAX - VolumeBooster.UNITY);
    return Math.pow(10, (t * maxDb) / 20);
  },
  /**
   * percentToGain の逆関数。実 gain 倍率からスライダー上の整数 percent を復元する。
   * popup syncCurrentTabVolume などで AudioContext 内の現在 gain を表示値に戻すときに使う。
   */
  gainToPercent(gain) {
    const g = Number(gain);
    if (!Number.isFinite(g) || g <= 0) return VolumeBooster.MIN;
    if (g <= 1) return Math.round(g * 100);
    const maxGain = VolumeBooster.MAX / 100;
    if (g >= maxGain) return VolumeBooster.MAX;
    const maxDb = 20 * Math.log10(maxGain);
    const t = (20 * Math.log10(g)) / maxDb;
    return Math.round(VolumeBooster.UNITY + t * (VolumeBooster.MAX - VolumeBooster.UNITY));
  },
  /**
   * UI スライダー位置 (0..200) を実音量 percent (0..300) に変換する。
   * 100% を中央へ置くため、下げる側は 0..100、上げる側は 100..300 に分ける。
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
  /** 実音量 percent (0..300) から UI スライダー位置 (0..200) を復元する。 */
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
  /** 自動音量正規化: 目標RMS。厳密な LUFS ではなく、リアルタイム用途の短時間ラウドネス近似。 */
  NORMALIZE_TARGET_RMS_DB: -24,
  /**
   * 自動音量正規化: これ未満は無音/ノイズ扱いにして増幅しない。
   * BGM + 喋りの動画で「言葉と言葉の隙間に残る BGM」も無音側に倒すため、-50 → -38 に上げて
   * gate を強めにかける。-50 だと隙間 BGM の RMS でも有効音判定 → 目標 -24dB まで持ち上げる
   * → 喋り出した瞬間に下げる、というポンピングが発生していた。
   */
  NORMALIZE_SILENCE_GATE_DB: -38,
  /**
   * 自動音量正規化: 小さい音源を持ち上げる最大量。
   * +12dB (4倍ブースト) まで持ち上げて、YouTube 側スライダーで音量を 25% に下げても元の音量に戻せるようにする。
   * 過剰持ち上げによる環境ノイズの増幅は dead zone と silence gate (-38 dB) で抑制する設計。
   */
  NORMALIZE_MAX_GAIN_DB: 12,
  /** 自動音量正規化: 大きい音源を下げる最大量。 */
  NORMALIZE_MIN_GAIN_DB: -12,
  /**
   * 自動音量正規化: 音量測定とゲイン更新の間隔。
   * 250ms → 400ms に伸ばし、瞬間 RMS の揺れに対する応答頻度を下げる。
   */
  NORMALIZE_UPDATE_MS: 400,
  /**
   * 自動音量正規化: 音が大きいときに下げる追従速度。
   * 「サスペンションダンパー」イメージで上下とも遅く動かす方針。
   * 2.0s ≒ 3τ で 6 秒で 95% 到達。瞬間ピークでは下げず、平均的に大きい音源にだけ反応する。
   */
  NORMALIZE_GAIN_DOWN_TIME_CONSTANT: 2.0,
  /**
   * 自動音量正規化: 音が小さいときに上げる追従速度。
   * 4.0s ≒ 3τ で 12 秒で 95% 到達。動画ごとの音量差を 10〜15 秒で揃えつつ、
   * 言葉の隙間（数百 ms オーダー）では実質ノーリアクションで BGM のうねりを抑える設計。
   * DOWN (2.0s) より遅く設定することで、句末 BGM の立ち上がりよりは緩やかに上げる。
   */
  NORMALIZE_GAIN_UP_TIME_CONSTANT: 4.0,
  /**
   * 自動音量正規化: ヒステリシス（dead zone）。目標ゲインと現在ターゲットの差がこの dB 値
   * 未満ならゲイン更新をスキップし、細かい RMS 揺れによるポンピングを抑える。
   * ±3dB は「動画再生で気付かない」体感の安全領域（±2dB ≒ ラウドネス最小有意差より一段広めに取る）。
   */
  NORMALIZE_DEAD_ZONE_DB: 3,
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
  /** 注入する style 要素の id（同上）。 */
  STYLE_ID: "__cpa-video-gamma-style",
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
 * YouTube クリーナー (29 機能)・Instagram クリーナー (11 機能)・TikTok クリーナー (3 機能)
 * を専用タブで直接表示する設計に移行した。
 *
 * 旧値 "assist" は `migrate()` で "tune" に変換する（POPUP_LAST_TAB の後方互換）。
 */
const PopupTabs = Object.freeze({
  TUNE: "tune",
  YOUTUBE: "youtube",
  INSTAGRAM: "instagram",
  TIKTOK: "tiktok",
  PICKER: "picker",
  ALL: Object.freeze(["tune", "youtube", "instagram", "tiktok", "picker"]),

  /** 5 つのタブ識別子のいずれかなら true */
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

  // P0-#2: 全定数を globalThis に明示的に公開する。これで content scripts / popup / offscreen /
  // background が `Actions.X` の bare 名でアクセスできる（globalThis のプロパティは bare 名で
  // 参照可能という JS 言語仕様）。Chrome 実装の script scope 共有に依存しない安全な設計。
  globalThis.Actions = Actions;
  globalThis.ExtensionPaths = ExtensionPaths;
  globalThis.SenderCheck = SenderCheck;
  globalThis.Offscreen = Offscreen;
  globalThis.StorageKeys = StorageKeys;
  globalThis.KeepAlive = KeepAlive;
  globalThis.YouTubeShorts = YouTubeShorts;
  globalThis.SearchFixer = SearchFixer;
  globalThis.AmazonDeliveryTotal = AmazonDeliveryTotal;
  globalThis.InstagramCleaner = InstagramCleaner;
  globalThis.TikTokCleaner = TikTokCleaner;
  globalThis.ImageDownloader = ImageDownloader;
  globalThis.VolumeBooster = VolumeBooster;
  globalThis.VideoGamma = VideoGamma;
  globalThis.ColorPicker = ColorPicker;
  globalThis.PopupTabs = PopupTabs;
})();
