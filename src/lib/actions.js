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
  /** popup → background: 音量ブースターの gain を指定タブで変更 */
  VOLUME_BOOSTER_SET_GAIN: "volumeBoosterSetGain",
  /** popup → background: 音量ブースターの現在 gain を指定タブで取得 */
  VOLUME_BOOSTER_GET_GAIN: "volumeBoosterGetGain",
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
  /** YouTube クリーナーマスタートグル（Shorts 削除・コメント欄非表示・ライブチャット非表示を含む全 22 サブ機能の親） */
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
  /** 音量ブースター: 自動歪み防止（DynamicsCompressor で hard limit 化） */
  VOLUME_BOOSTER_ANTI_CLIP_ENABLED: "volumeBoosterAntiClipEnabled",
  /** 音量ブースター: 自動音量正規化（短時間RMSを測って自動ゲイン調整） */
  VOLUME_BOOSTER_NORMALIZE_ENABLED: "volumeBoosterNormalizeEnabled",
  /** 音量ブースター: ナイトモード（ゲーム配信用途） */
  VOLUME_BOOSTER_NIGHT_MODE_ENABLED: "volumeBoosterNightModeEnabled",
  /** カラーピッカー: 採取した色の履歴（最新が先頭。各要素 {hex, ts} の最大 20 件） */
  COLOR_PICKER_HISTORY: "colorPickerHistory",
  /** カラーピッカー: 既定の保存形式 ("hex" | "rgb" | "hsl") */
  COLOR_PICKER_DEFAULT_FORMAT: "colorPickerDefaultFormat",
  /** カラーピッカー: HEX コピー時に # を含めるか (boolean, default true) */
  COLOR_PICKER_HEX_HASH: "colorPickerHexHash",
  /** ポップアップで最後に開いていたタブ ("assist" | "picker") */
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
    return KeepAlive.normalizeOrigins(origins).includes(normalized);
  },
});

/**
 * @readonly YouTube Shorts 削除機能の定数（独自実装）。
 *
 * v1.0.18 から YouTube クリーナーのサブ機能 `removeShorts` として統合された。
 * `searchFixerEnabled` (master) AND `searchFixerFeatures.removeShorts` の両方が
 * true のときに youtube-shorts.js が起動し、ここで定義したセレクタ・正規表現を使う。
 */
const YouTubeShorts = Object.freeze({
  SELECTORS_REMOVE: Object.freeze([
    'yt-chip-cloud-chip-renderer:has(#text)',
    'ytd-video-renderer:has(a[href*="/shorts/"])',
    'ytd-reel-shelf-renderer',
    'ytd-rich-shelf-renderer[is-shorts]',
    'ytm-reel-shelf-renderer',
    'ytm-rich-section-renderer',
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
  Object.freeze({
    key: "removeShorts",
    label: "Shorts 削除",
    desc: "サイドバー / 棚 / チップから Shorts UI を物理削除し、/shorts/<ID> URL は /watch?v=<ID> へ強制リダイレクト",
    category: "site_wide",
  }),
  Object.freeze({
    key: "shelf",
    label: "動画棚",
    desc: "検索結果の途中に挟まる「人気の急上昇」「ニュース」などの動画グループ (ytd-shelf-renderer) を除去",
    category: "search_remove",
  }),
  Object.freeze({
    key: "cardList",
    label: "カードリスト",
    desc: "検索結果中の横スクロール関連トピックカード (ytd-horizontal-card-list-renderer の 2 番目以降) を除去",
    category: "search_remove",
  }),
  Object.freeze({
    key: "playlist",
    label: "プレイリスト",
    desc: "検索結果中のプレイリスト項目（playlist?list= リンクや「N 本の動画」バッジ付き）を除去",
    category: "search_remove",
  }),
  Object.freeze({
    key: "mix",
    label: "ミックス",
    desc: "YouTube が自動生成するミックス（ラジオ・&list=RD&start_radio=1）項目を除去",
    category: "search_remove",
  }),
  Object.freeze({
    key: "course",
    label: "コース",
    desc: "「コース」バッジ付きの学習コンテンツカード (.yt-lockup-view-model--wrapper) を除去",
    category: "search_remove",
  }),
  Object.freeze({
    key: "channel",
    label: "チャンネル",
    desc: "検索結果のチャンネル紹介カード (ytd-channel-renderer) を除去",
    category: "search_remove",
  }),
  Object.freeze({
    key: "reel",
    label: "Shorts 棚",
    desc: "検索結果に挟まる Shorts 動画の横並び棚 (ytd-reel-shelf-renderer / grid-shelf-view-model) を除去",
    category: "search_remove",
  }),
  Object.freeze({
    key: "shortsBtn",
    label: "Shorts 動画",
    desc: "検索結果のうちサムネ URL が /shorts/ になっている縦動画項目を除去",
    category: "search_remove",
  }),
  Object.freeze({
    key: "live",
    label: "ライブ / プレミア",
    desc: "「LIVE」または「PREMIERE」バッジ付きの動画を検索結果から除去",
    category: "search_remove",
  }),
  Object.freeze({
    key: "secondary",
    label: "関連検索ブロック",
    desc: "検索結果下部の「関連する検索キーワード」候補ブロック (ytd-secondary-search-container-renderer) を除去",
    category: "search_remove",
  }),
  Object.freeze({
    key: "verified",
    label: "認証チャンネルの動画",
    desc: "Verified バッジを持つチャンネル（公式アカウント・ニュース）の動画を除去",
    category: "by_badge",
  }),
  Object.freeze({
    key: "artist",
    label: "アーティストチャンネルの動画",
    desc: "Official Artist Channel バッジ付きの動画（ミュージック公式 MV 等）を除去",
    category: "by_badge",
  }),
  Object.freeze({
    key: "watched",
    label: "視聴済み動画",
    desc: "再生位置バー（resume-playback overlay）が表示されている既視聴動画を除去",
    category: "by_badge",
  }),
  Object.freeze({
    key: "chapter",
    label: "チャプター付き動画",
    desc: "チャプター情報 (expandable-metadata-renderer) が展開可能な動画を除去",
    category: "by_badge",
  }),
  Object.freeze({
    key: "demoteUnmatched",
    label: "キーワード非マッチをグレー化",
    desc: "検索ワードがタイトル・説明文に含まれない動画を半透明 + グレースケール化（hover で復元）",
    category: "highlight",
  }),
  Object.freeze({
    key: "highlightThumb",
    label: "サムネ枠装飾",
    desc: "各動画サムネに茜色の枠線とドロップシャドウを追加して視認性を向上（ダーク/ライト両対応）",
    category: "highlight",
  }),
  Object.freeze({
    key: "centerTitle",
    label: "タイトル中央配置",
    desc: "動画ページのタイトル h1 を中央寄せにして雑誌風レイアウトに",
    category: "watch_page",
  }),
  Object.freeze({
    key: "fullWidthDesc",
    label: "説明文フル幅",
    desc: "動画ページの概要欄を画面幅いっぱいに展開して長文説明を読みやすく",
    category: "watch_page",
  }),
  Object.freeze({
    key: "hideComments",
    label: "コメント欄非表示",
    desc: "動画ページ下部のコメントセクション（件数・並び替え・入力欄・スレッド一覧）を一括で非表示化。ライブ配信のチャット欄は対象外",
    category: "watch_page",
  }),
  Object.freeze({
    key: "hideLiveChat",
    label: "ライブチャット欄非表示",
    desc: "ライブ配信アーカイブの右側に表示されるライブコメント欄を、YouTube 公式操作と同じ折りたたみで非表示化。通常動画には影響なし",
    category: "watch_page",
  }),
  Object.freeze({
    key: "searchGrid",
    label: "検索結果をグリッド表示",
    desc: "検索結果を 1 列リストから複数列グリッドに変更（ホーム列数が 4/5/6 ならその値、自動なら 3 列）",
    category: "layout",
  }),
]);

const SearchFixerDefaultFeatures = Object.freeze(
  Object.fromEntries(SearchFixerFeatures.map((feature) => [feature.key, false]))
);

const SearchFixer = Object.freeze({
  FEATURES: SearchFixerFeatures,

  CATEGORIES: Object.freeze([
    Object.freeze({ id: "site_wide",     icon: "📺", label: "サイト全体" }),
    Object.freeze({ id: "search_remove", icon: "🗑️", label: "検索結果ノイズ" }),
    Object.freeze({ id: "by_badge",      icon: "🚫", label: "動画属性で削除" }),
    Object.freeze({ id: "highlight",     icon: "✨", label: "ハイライト" }),
    Object.freeze({ id: "watch_page",    icon: "🎬", label: "動画ページ" }),
    Object.freeze({ id: "layout",        icon: "📐", label: "レイアウト" }),
  ]),

  DEFAULT_FEATURES: SearchFixerDefaultFeatures,

  GRID_OPTIONS: Object.freeze([
    Object.freeze({ value: 0, label: "自動（YouTube 既定）" }),
    Object.freeze({ value: 4, label: "4 列" }),
    Object.freeze({ value: 5, label: "5 列" }),
    Object.freeze({ value: 6, label: "6 列" }),
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
  Object.freeze({
    key: "reels",
    label: "Reels 削除",
    desc: "サイドバー / ナビの Reels 項目を非表示 + /reels/ URL アクセス時にホーム / へ強制リダイレクト",
    category: "ig_main",
  }),
  Object.freeze({
    key: "explore",
    label: "Explore 削除",
    desc: "サイドバー / ナビの Explore 項目を非表示 + /explore/ URL アクセス時にホーム / へ強制リダイレクト",
    category: "ig_main",
  }),
  Object.freeze({
    key: "stories",
    label: "ストーリー段非表示（ホーム）",
    desc: "ホームフィード上部のストーリーズ・トレイ（24h で消える短編動画群）を CSS で非表示化",
    category: "ig_main",
  }),
  Object.freeze({
    key: "storiesAll",
    label: "Stories URL をホームに戻す",
    desc: "/stories/ パスに直接アクセスした瞬間にホーム / へリダイレクト（リンク踏み防止）",
    category: "ig_main",
  }),
  Object.freeze({
    key: "threads",
    label: "Threads 誘導非表示",
    desc: "Threads アプリへの誘導バナー / サイドバー項目 / フッターリンクを非表示化",
    category: "ig_main",
  }),
  Object.freeze({
    key: "vanity",
    label: "いいね数・フォロワー数非表示",
    desc: "<article> 内の数値表記ボタン（カンマ・k・M・万など）を検出して非表示にし、比較疲れを軽減",
    category: "ig_extra",
  }),
  Object.freeze({
    key: "blockVideos",
    label: "投稿内の動画ブロック",
    desc: "フィード <article> 内の <video> 要素にマーカーを付け、CSS でサムネ画像に差し替えて自動再生を防止",
    category: "ig_extra",
  }),
  Object.freeze({
    key: "comments",
    label: "コメント欄非表示",
    desc: "コメント一覧 / 入力フォーム / 「N 件のコメントを見る」リンクをまとめて CSS で非表示化",
    category: "ig_extra",
  }),
  Object.freeze({
    key: "notes",
    label: "Notes 非表示",
    desc: "DM 画面上部の Notes（プロフィール写真の上に乗る短文ステータス）行を非表示",
    category: "ig_extra",
  }),
  Object.freeze({
    key: "msgCounters",
    label: "新規メッセージカウンター非表示",
    desc: "ナビゲーション上の未読 DM 件数バッジ（赤丸の数字）を非表示にして通知圧力を軽減",
    category: "ig_extra",
  }),
]);

const InstagramCleanerDefaultFeatures = Object.freeze(
  Object.fromEntries(InstagramCleanerFeatures.map((feature) => [feature.key, false]))
);

const InstagramCleaner = Object.freeze({
  FEATURES: InstagramCleanerFeatures,

  CATEGORIES: Object.freeze([
    Object.freeze({ id: "ig_main",  icon: "🚫", label: "主要機能" }),
    Object.freeze({ id: "ig_extra", icon: "✂️", label: "追加機能" }),
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
  /** 自動音量正規化: これ未満は無音/ノイズ扱いにして増幅しない。 */
  NORMALIZE_SILENCE_GATE_DB: -50,
  /** 自動音量正規化: 小さい音源を持ち上げる最大量。 */
  NORMALIZE_MAX_GAIN_DB: 9,
  /** 自動音量正規化: 大きい音源を下げる最大量。 */
  NORMALIZE_MIN_GAIN_DB: -12,
  /** 自動音量正規化: 音量測定とゲイン更新の間隔。 */
  NORMALIZE_UPDATE_MS: 250,
  /** 自動音量正規化: 音が大きいときに下げる追従速度。 */
  NORMALIZE_GAIN_DOWN_TIME_CONSTANT: 0.35,
  /** 自動音量正規化: 音が小さいときに上げる追従速度。 */
  NORMALIZE_GAIN_UP_TIME_CONSTANT: 1.2,
  /**
   * ナイトモード用コンプレッサー（ゲーム音のダイナミックレンジを縮める）。
   * threshold:-18dBFS / ratio:2.5 でピークを抑えつつ可逆的な声域を残し、
   * attack:20ms / release:400ms で自然な追従にする。
   */
  NIGHT_MODE_PRESET: Object.freeze({
    threshold: -18,
    knee: 8,
    ratio: 2.5,
    attack: 0.02,
    release: 0.4,
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
  /** タブ識別子。POPUP_LAST_TAB に保存される値はこのいずれか */
  TAB_ASSIST: "assist",
  TAB_PICKER: "picker",
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

  /** "assist" / "picker" のいずれかなら true */
  isValidTab(value) {
    return value === ColorPicker.TAB_ASSIST || value === ColorPicker.TAB_PICKER;
  },

  /** 不正値は assist にフォールバック */
  normalizeTab(value) {
    return ColorPicker.isValidTab(value) ? value : ColorPicker.TAB_ASSIST;
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
  globalThis.VolumeBooster = VolumeBooster;
  globalThis.ColorPicker = ColorPicker;
})();
