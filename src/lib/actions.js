"use strict";

// サイト用定義と設定スキーマ。actions-core.js の後に読み込む。
(() => {
  if (globalThis.__cpaActionsLoaded === true) return;
  globalThis.__cpaActionsLoaded = true;

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
  /** offscreen → background: tabCapture stream の自然終了を通知 */
  ACTION_VOLUME_STREAM_ENDED: "volumeStreamEnded",
  /** 使用後のアイドル close 待機時間（ms）。tabCapture 系の連続操作を吸収できる長さ */
  IDLE_MS: 30_000,
  /**
   * createDocument の reasons 配列。tabCapture (USER_MEDIA) + AudioContext 出力 (AUDIO_PLAYBACK)。
   */
  REASONS: Object.freeze(["USER_MEDIA", "AUDIO_PLAYBACK"]),
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
  Object.freeze({ key: "hideSubscriptionsRelevant", category: "video_filter" }),
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
  // 配信時刻オーバーレイ: 配信アーカイブ (過去ライブの VOD) 再生中に、その瞬間が実際に配信
  // されていた時刻 (yyyy/MM/dd　hh:mm:ss) をプレーヤー内 HUD に重ねる。純粋ロジックは
  // BroadcastClock namespace、実装は専用 content script youtube-broadcast-clock.js。
  Object.freeze({ key: "broadcastClock", category: "watch_page" }),
  Object.freeze({ key: "liveLatency", category: "watch_page" }),
  Object.freeze({ key: "playbackQuality", category: "watch_page" }),
  Object.freeze({ key: "playbackRate", category: "watch_page" }),
  Object.freeze({ key: "playerVolume", category: "watch_page" }),
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

const YouTubePlayerControls = (() => {
  const DEFAULT_SETTINGS = {"latency":{"enabled":true,"playbackRate":1.1,"showPlaybackRate":false,"showLatency":false,"showHealth":false,"showEstimation":false,"showCurrent":false,"smooth":true,"smoothThreshold":3,"smoothAuto":true,"skip":false,"skipThreshold":300},"quality":{"values":["tiny","small","medium","large","hd720","hd1080","hd1440","auto","hd2160"],"enabled":[true,false,false,true,false,true,false,false,false]},"rate":{"values":[0.25,0.5,0.75,1,1.25,1.5,2,1.75,3,4,5,6,8,10,12,16],"enabled":[false,false,false,true,false,false,true,false,false,false,false,false,false,false,false,false]},"volume":{"values":[0,25,50,75,100],"enabled":[false,true,true,true,true],"hideSlider":false,"hideVolumeIcon":false}};
  for (const group of Object.values(DEFAULT_SETTINGS)) { for (const value of Object.values(group)) if (Array.isArray(value)) Object.freeze(value); Object.freeze(group); }
  Object.freeze(DEFAULT_SETTINGS);
  const QUALITY_VALUES = DEFAULT_SETTINGS.quality.values;
  const RATE_VALUES = DEFAULT_SETTINGS.rate.values;
  const NUMERIC_CHOICES = Object.freeze({
    playbackRate: Object.freeze([1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.5, 1.75, 2]),
    smoothThreshold: Object.freeze([0, .5, 1, 2, 3, 5, 10, 15, 20, 30, 60, 120]),
    skipThreshold: Object.freeze([1, 3, 5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400, 999999]),
  });
  const number = (v, d, min, max, step) => typeof v === "number" && Number.isFinite(v) ? Number((Math.round(Math.min(max, Math.max(min, v)) / step) * step).toFixed(2)) : d;
  function normalizeSettings(raw) {
    const out = {};
    for (const [group, defaults] of Object.entries(DEFAULT_SETTINGS)) {
      const data = raw?.[group]; out[group] = {};
      for (const [key, fallback] of Object.entries(defaults)) {
        const value = data?.[key];
        if (Array.isArray(fallback)) out[group][key] = fallback.map((d, i) => key === "enabled" ? (typeof value?.[i] === "boolean" ? value[i] : d) : group === "quality" ? (QUALITY_VALUES.includes(value?.[i]) ? value[i] : d) : number(value?.[i], d, group === "rate" ? 0.1 : 0, group === "rate" ? 16 : 100, group === "rate" ? 0.05 : 1));
        else if (typeof fallback === "boolean") out[group][key] = typeof value === "boolean" ? value : fallback;
        else out[group][key] = number(value, fallback, key === "playbackRate" ? 1.05 : key === "skipThreshold" ? 1 : 0, key === "playbackRate" ? 16 : key === "skipThreshold" ? 999999 : 120, key === "skipThreshold" ? 1 : 0.05);
      }
    }
    return out;
  }
  function mergeSettings(current, patch) {
    const out = normalizeSettings(current);
    for (const group of Object.keys(out)) for (const [key, value] of Object.entries(patch?.[group] ?? {})) {
      if (!Object.hasOwn(out[group], key)) continue;
      if (Array.isArray(out[group][key])) { for (const [index, item] of Object.entries(value ?? {})) if (/^\d+$/.test(index) && Number(index) < out[group][key].length) out[group][key][index] = item; }
      else out[group][key] = value;
    }
    return normalizeSettings(out);
  }
  function getPlaybackSettings(raw) {
    const settings = normalizeSettings(raw);
    // 保存形式は旧ボタン割り当てと互換を保ち、再生 UI とショートカットは固定候補で統一する。
    for (const group of ["quality", "rate", "volume"]) {
      settings[group].values = [...DEFAULT_SETTINGS[group].values].filter((value) => group !== "rate" || value <= 2);
      settings[group].enabled = settings[group].values.map(() => true);
    }
    return settings;
  }
  return Object.freeze({ DEFAULT_SETTINGS, QUALITY_VALUES, RATE_VALUES, NUMERIC_CHOICES, normalizeSettings, mergeSettings, getPlaybackSettings });
})();

const SearchFixer = Object.freeze({
  PLAYER_CONTROLS: YouTubePlayerControls,
  FEATURES: SearchFixerFeatures,

  // category.label は _locales/.../messages.json の `category<CamelId>` (例: categoryMenuUi)。
  // category.icon は popup.html のアイコンスプライトの symbol id (`ic-<icon>`)。
  // 絵文字は OS ごとに絵柄が変わり配色の質感が揃わないため、単色線画に統一している。
  CATEGORIES: Object.freeze([
    Object.freeze({ id: "menu_ui",      icon: "compass" }),
    Object.freeze({ id: "video_filter", icon: "trash" }),
    Object.freeze({ id: "watch_page",   icon: "clapper" }),
    Object.freeze({ id: "search_only",  icon: "search" }),
    Object.freeze({ id: "integration",  icon: "link" }),
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

  /** leftnav 注入に使える YouTube チャンネル URLだけを返す。 */
  normalizeChannelHref(href) {
    if (typeof href !== "string" || href === "") return "/";
    try {
      const url = new URL(href, "https://www.youtube.com");
      if (url.origin !== "https://www.youtube.com") return "/";
      if (!/^\/(?:@[^/]+|channel\/UC[\w-]{10,64})(?:\/|$)/u.test(url.pathname)) return "/";
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return "/";
    }
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
  /** 登録チャンネルの HTML / サムネ候補取得を止めるまでの上限。 */
  SUBS_FETCH_TIMEOUT_MS: 15000,
  /** 登録チャンネルカードのサムネ取得同時実行数。 */
  SUBS_THUMB_FETCH_CONCURRENCY: 2,

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
 * 従来の月別 DOM 属性と、現行の配送詳細に付く data-testid を使用する。
 */
const AmazonDeliveryTotal = Object.freeze({
  SECTION_SELECTOR: "[data-delivery-type]",
  INSERT_TARGET_SELECTOR: ".a-fixed-left-grid-col",
  DELIVERY_SECTION_SELECTOR: '[data-testid^="desktop-delivery-card-list-"]',
  DELIVERY_TARGET_SELECTOR: '[data-testid="desktop-delivery-card"]',
  DELIVERY_ITEM_SELECTOR: '[data-testid="desktop-subscription-tile"]',
  DELIVERY_PRICE_SELECTOR: '[data-testid="product-price"]',
  DELIVERY_QUANTITY_SELECTOR: '[data-testid="product-qty-frequency"]',
  OVERVIEW_CARD_SELECTOR: '#deliveriesDesktopScroller .hub-delivery-card',
  FETCH_TIMEOUT_MS: 15000,
  FETCH_CONCURRENCY: 2,
  MANAGE_QUERY_KEYS: Object.freeze(["_encoding", "shipId", "deliveryDate", "deliveryBundleDate", "deliveryBundleId", "isMixedBundle", "enableMydExperience", "ref_", "sourcePage", "pf_rd_p", "pf_rd_r"]),
  TOTAL_ROOT_CLASS: "__cpa-amzn-delivery-total",
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
 * Notes / メッセージカウンター）の整理と、動画シークバーを提供するクライアントサイド DOM/CSS 操作。
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
  Object.freeze({ key: "videoControls", category: "ig_extra" }),
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
    Object.freeze({ id: "ig_main",  icon: "ban" }),
    Object.freeze({ id: "ig_extra", icon: "scissors" }),
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
  /** videoControls 機能でシークバーの挿入先へ付ける cleanup 用マーカークラス */
  VIDEO_CONTROL_PARENT_CLASS: "__cpa-ig-video-control-parent",
  /** videoControls 機能が挿入するシークバー UI のルートクラス */
  VIDEO_CONTROL_CLASS: "__cpa-ig-video-control",

  /** Space ショートカットのブラウザ差を吸収する純粋判定。 */
  isSpaceKey(key, code) {
    return key === " " || key === "Spacebar" || code === "Space";
  },

  /** シークバー横へ表示する秒数を `m:ss` / `h:mm:ss` に整形する。 */
  formatVideoTime(value) {
    const total = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
    const seconds = String(total % 60).padStart(2, "0");
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
      : `${minutes}:${seconds}`;
  },

  /**
   * Space の対象動画を、モーダル内へ絞り込み → 再生中 → 直前操作 → 表示面積の順で選ぶ。
   * DOM 非依存の候補レコードにして、非表示動画や背面フィードを選ばない優先順位をテスト可能にする。
   */
  selectVideoCandidate(candidates) {
    if (!Array.isArray(candidates)) return null;
    const visible = candidates.filter((candidate) =>
      candidate && Number.isFinite(candidate.visibleArea) && candidate.visibleArea > 0
    );
    const largest = (items) => items.reduce((best, candidate) =>
      best === null || candidate.visibleArea > best.visibleArea ? candidate : best, null);
    const dialog = visible.filter((candidate) => candidate.dialog === true);
    const scoped = dialog.length ? dialog : visible;
    const playing = scoped.filter((candidate) => candidate.playing === true);
    if (playing.length) return largest(playing);
    const recent = scoped.find((candidate) => candidate.recent === true);
    if (recent) return recent;
    return largest(scoped);
  },

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
    Object.freeze({ id: "tt_main", icon: "ban" }),
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
  Object.freeze({ key: "imageDownload", category: "x_extra" }),
]);

const XCleanerDefaultFeatures = Object.freeze(
  Object.fromEntries(XCleanerFeatures.map((feature) => [feature.key, false]))
);

const XCleaner = Object.freeze({
  FEATURES: XCleanerFeatures,

  // category.label は _locales/.../messages.json の `categoryX*`。
  CATEGORIES: Object.freeze([
    Object.freeze({ id: "x_layout", icon: "window" }),
    Object.freeze({ id: "x_noise", icon: "ban" }),
    Object.freeze({ id: "x_timeline", icon: "compass" }),
    Object.freeze({ id: "x_extra", icon: "camera" }),
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
 * @readonly 画像ダウンロード機能の定数（Instagram / TikTok / X 共通、独自実装）。
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
    X: "x",
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
    x: Object.freeze(["pbs.twimg.com"]),
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
    if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) return ImageDownloader.HOSTS.X;
    return null;
  },

  /** 投稿画像だけを X CDN のオリジナルサイズ URL にする。アバター・動画サムネは対象外。 */
  xOriginalUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !ImageDownloader.ALLOWED_HOSTS.x.includes(url.hostname) || url.port || url.username || url.password) return null;
      const media = url.pathname.match(/^\/media\/([A-Za-z0-9_-]+)(?:\.(jpe?g|png|webp))?(?::(?:orig|large|medium|small|thumb|\d+x\d+))?$/i);
      const format = url.searchParams.get("format") || media?.[2];
      if (!media || !/^(?:jpe?g|png|webp)$/i.test(format || "")) return null;
      return `https://pbs.twimg.com/media/${media[1]}?format=${format.toLowerCase()}&name=orig`;
    } catch { return null; }
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
    return host === "instagram" || host === "tiktok" || host === "x";
  },

  /**
   * URL が指定 host (`"instagram"` / `"tiktok"`) のホワイトリスト CDN に
   * 該当するかを判定。`new URL()` で hostname を取り出して ALLOWED_HOSTS と照合する。
   * 不正 URL や非 http(s) スキームは false。
   */
  isAllowedFetchUrl(host, url) {
    if (!ImageDownloader._isValidHost(host)) return false;
    if (typeof url !== "string" || !url) return false;
    if (host === ImageDownloader.HOSTS.X) return ImageDownloader.xOriginalUrl(url) === url;
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
  /** 同一オリジンの配信情報取得を待つ上限。 */
  FETCH_TIMEOUT_MS: 15000,

  /** 配信情報（startMs / endMs / isLiveNow）の sessionStorage cache prefix（videoId 単位）。
   *  HTML fetch を動画ごと 1 回に抑える。負例（通常動画＝配信由来でない）も `{ none: true }` で cache する */
  CACHE_PREFIX: "__cpa_bc_info_v1::",

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
    const base = `${NotebookLm.ORIGIN}/notebook/${encodeURIComponent(String(notebookId ?? ""))}`;
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
    return NotebookLm.normalizeNotebookList(NotebookLm.parseBatchPayload(text));
  },

  /**
   * 解析済み batchexecute payload をノートブック一覧に正規化する。
   * @param {unknown[]|null} payload
   * @returns {Array<{id: string, name: string, sources: number, emoji: string}>}
   */
  normalizeNotebookList(payload) {
    const rows = payload?.[0];
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

  /** 外部入力が UUID そのものの場合だけ notebook ID として受理する。 */
  normalizeNotebookId(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    const id = NotebookLm.extractNotebookId(trimmed);
    return id && id.length === trimmed.length ? id : null;
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
    let url;
    try {
      url = new URL(href, "https://www.youtube.com");
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    const isYoutube = host === "youtube.com" || host.endsWith(".youtube.com");
    const isShort = host === "youtu.be";
    if (!isYoutube && !isShort) return null;
    let id = null;
    if (isShort) {
      const m = url.pathname.match(/^\/([\w-]{11})(?:\/|$)/);
      if (m) id = m[1];
    } else if (url.pathname === "/watch") {
      const value = url.searchParams.get("v");
      if (/^[\w-]{11}$/.test(value ?? "")) id = value;
    } else {
      const m = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})(?:\/|$)/);
      if (m) id = m[1];
    }
    return id ? `https://www.youtube.com/watch?v=${id}` : null;
  },
});

/**
 * @readonly カラーピッカー（独自実装）の定数。
 *
 * Web 標準の EyeDropper API（Chrome 95+。本拡張機能の minimum_chrome_version は 140）で
 * 画面上のピクセル色を採取し、HEX / RGB / HSL の 3 形式で表示・コピーする小さな採色机。
 * 3 形式の値欄は編集可能で、外から拾ってきたカラーコードを貼り付けるとその場でプレビューできる
 * （解釈は `parseColorInput`）。履歴は `chrome.storage.local` に最大 20 件まで保持し、popup を
 * 閉じても永続化される。
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

  /**
   * 受け取った任意の値を `#rrggbb` 6 桁小文字形式に正規化する。不正な入力は null。
   *   - 先頭 # の有無は問わない（"c0605a" も可）
   *   - 短縮 3 桁形式 (#abc) は #aabbcc に展開
   *   - 前後の余白は trim
   */
  normalizeHex(value) {
    if (typeof value !== "string") return null;
    let s = value.trim().toLowerCase();
    if (!s.startsWith("#")) s = "#" + s;
    if (!ColorPicker.HEX_RE.test(s)) return null;
    if (s.length === 4) {
      const r = s[1], g = s[2], b = s[3];
      s = `#${r}${r}${g}${g}${b}${b}`;
    }
    return s;
  },

  /** 数値を 0..255 の整数へ丸める（範囲外は CSS と同じくクランプ、非数は 0） */
  clampChannel(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 0;
    return Math.min(255, Math.max(0, n));
  },

  /** {r,g,b}（0..255）→ "#rrggbb"。範囲外はクランプする。 */
  rgbToHex(rgb) {
    const to2 = (v) => ColorPicker.clampChannel(v).toString(16).padStart(2, "0");
    return `#${to2(rgb?.r)}${to2(rgb?.g)}${to2(rgb?.b)}`;
  },

  /**
   * HSL（h: 度・任意実数で 360 を法に巻き戻す / s,l: 0..100 でクランプ）→ {r,g,b}（0..255 整数）。
   * CSS Color Module Level 4 の標準式をそのまま実装した数学変換。
   */
  hslToRgb(h, s, l) {
    const hh = ((Number(h) % 360) + 360) % 360;
    const ss = Math.min(100, Math.max(0, Number(s))) / 100;
    const ll = Math.min(100, Math.max(0, Number(l))) / 100;
    if (!Number.isFinite(hh) || !Number.isFinite(ss) || !Number.isFinite(ll)) {
      return { r: 0, g: 0, b: 0 };
    }
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = ll - c / 2;
    let rp = 0, gp = 0, bp = 0;
    if (hh < 60) { rp = c; gp = x; bp = 0; }
    else if (hh < 120) { rp = x; gp = c; bp = 0; }
    else if (hh < 180) { rp = 0; gp = c; bp = x; }
    else if (hh < 240) { rp = 0; gp = x; bp = c; }
    else if (hh < 300) { rp = x; gp = 0; bp = c; }
    else { rp = c; gp = 0; bp = x; }
    return {
      r: Math.round((rp + m) * 255),
      g: Math.round((gp + m) * 255),
      b: Math.round((bp + m) * 255),
    };
  },

  /**
   * {r,g,b}（0..255）→ {h: 0..360, s: 0..100, v: 0..100}（いずれも整数に丸め）。
   * 調色パレット（彩度×明度の 2D エリア + 色相スライダー）の座標計算に使う。
   * HSL ではなく HSV を使うのは、パレットの縦横が「白 → 純色」「純色 → 黒」に
   * 素直に対応して掴みやすいため（一般的なカラーピッカーの操作感に合わせる）。
   */
  rgbToHsv(rgb) {
    const r = ColorPicker.clampChannel(rgb?.r) / 255;
    const g = ColorPicker.clampChannel(rgb?.g) / 255;
    const b = ColorPicker.clampChannel(rgb?.b) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return {
      h: Math.round(h) % 360,
      s: Math.round((max === 0 ? 0 : d / max) * 100),
      v: Math.round(max * 100),
    };
  },

  /** {h: 度・360 を法に巻き戻し / s,v: 0..100 でクランプ} → {r,g,b}（0..255 整数）。 */
  hsvToRgb(h, s, v) {
    const hh = ((Number(h) % 360) + 360) % 360;
    const ss = Math.min(100, Math.max(0, Number(s))) / 100;
    const vv = Math.min(100, Math.max(0, Number(v))) / 100;
    if (!Number.isFinite(hh) || !Number.isFinite(ss) || !Number.isFinite(vv)) {
      return { r: 0, g: 0, b: 0 };
    }
    const c = vv * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = vv - c;
    let rp = 0, gp = 0, bp = 0;
    if (hh < 60) { rp = c; gp = x; bp = 0; }
    else if (hh < 120) { rp = x; gp = c; bp = 0; }
    else if (hh < 180) { rp = 0; gp = c; bp = x; }
    else if (hh < 240) { rp = 0; gp = x; bp = c; }
    else if (hh < 300) { rp = x; gp = 0; bp = c; }
    else { rp = c; gp = 0; bp = x; }
    return {
      r: Math.round((rp + m) * 255),
      g: Math.round((gp + m) * 255),
      b: Math.round((bp + m) * 255),
    };
  },

  /**
   * 調色パレットの状態（HSV）を現在色に追従させる。s=0（無彩色）や v=0（黒）では
   * 色相・彩度が数学的に定まらないので、直前の値を引き継いで「グレーに落としてから
   * 色相スライダーを動かしたら元の彩度で戻る」操作を成立させる。
   *
   * @param {string} hex "#rrggbb"
   * @param {{h:number,s:number,v:number}|null} prev 直前のパレット状態
   */
  hexToPaletteHsv(hex, prev) {
    const norm = ColorPicker.normalizeHex(hex);
    if (!norm) return { h: 0, s: 0, v: 0 };
    const next = ColorPicker.rgbToHsv({
      r: parseInt(norm.slice(1, 3), 16),
      g: parseInt(norm.slice(3, 5), 16),
      b: parseInt(norm.slice(5, 7), 16),
    });
    if (!prev) return next;
    if (next.v === 0) return { h: prev.h, s: prev.s, v: 0 };
    if (next.s === 0) return { h: prev.h, s: 0, v: next.v };
    return next;
  },

  /**
   * ユーザーが「現在の色」カードの値欄へ貼り付け / 入力した文字列を "#rrggbb" に解釈する。
   * 読み取れなければ null（呼び出し側は入力欄を「不正」表示にして値は消さない）。
   *
   * 受理する書式:
   *   - HEX: "#c0605a" / "c0605a" / "#abc" / "abc"
   *   - RGB: "rgb(192, 96, 90)" / "rgba(192 96 90 / 0.5)" / "192, 96, 90" / "rgb(50%, 50%, 50%)"
   *   - HSL: "hsl(213, 40%, 30%)" / "hsl(213deg 40% 30%)" / "213°, 40%, 30%"
   *   ※ alpha は 4 つ目の値として無視する（本機能は不透明色のみ扱う）
   *
   * 関数表記のない素の 3 数値は、1 番目に "°"/"deg" が付くか 2〜3 番目に "%" が付けば HSL、
   * それ以外は RGB と解釈する（UI の RGB 欄 "192, 96, 90" / HSL 欄 "213°, 40%, 30%" が
   * そのまま往復できる形に合わせた判定）。
   */
  parseColorInput(value) {
    if (typeof value !== "string") return null;
    const raw = value.trim();
    if (!raw) return null;

    const fn = /^([a-z]+)\s*\(([^()]*)\)$/i.exec(raw);
    const kind = fn ? fn[1].toLowerCase() : "";
    if (fn && !["rgb", "rgba", "hsl", "hsla"].includes(kind)) return null;

    if (!fn) {
      const hex = ColorPicker.normalizeHex(raw);
      if (hex) return hex;
      // "#" 始まりなのに HEX として読めない値は、数値列として解釈し直さない
      if (raw.startsWith("#")) return null;
    }

    const parts = (fn ? fn[2] : raw)
      .split(/[,/]|\s+/)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    if (parts.length < 3) return null;

    const numOf = (token) => {
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(%|°|deg)?$/i.exec(token);
      if (!m) return null;
      const n = Number(m[1]);
      if (!Number.isFinite(n)) return null;
      return { n, unit: (m[2] || "").toLowerCase() };
    };
    const a = numOf(parts[0]);
    const b = numOf(parts[1]);
    const c = numOf(parts[2]);
    if (!a || !b || !c) return null;

    const isHsl =
      kind === "hsl" ||
      kind === "hsla" ||
      (kind === "" && (a.unit === "°" || a.unit === "deg" || b.unit === "%" || c.unit === "%"));
    if (isHsl) return ColorPicker.rgbToHex(ColorPicker.hslToRgb(a.n, b.n, c.n));

    // rgb(50%, 50%, 50%) 形式のパーセント指定に対応
    const ch = (t) => (t.unit === "%" ? (t.n * 255) / 100 : t.n);
    return ColorPicker.rgbToHex({ r: ch(a), g: ch(b), b: ch(c) });
  },
});

/**
 * @readonly Popup のタブ識別子。
 *
 * v1.0.x: タブを「アシスト / カラーピッカー」の 2 つから「調整 / YouTube /
 * Instagram / TikTok / カラーピッカー」の 5 つに再編。アコーディオンを廃止して
 * YouTube 機能拡張 (38 機能)・Instagram クリーナー (12 機能)・TikTok クリーナー (3 機能)
 * を専用タブで直接表示する設計に移行した。
 *
 * 旧値 "assist" は `migrate()` で "tune" に変換する（POPUP_LAST_TAB の後方互換）。
 */
const WikipediaReader = Object.freeze({
  // 旧テーマは保存データとバックアップを読めるように残す。
  THEMES: Object.freeze(["original", "auto", "light", "dark", "sepia", "algae", "calmness", "deep-ocean", "desert", "fairy-dust", "grey", "nature",
    "one-dark", "one-light", "dracula", "nord", "monokai", "solarized-dark", "solarized-light", "github-dark", "github-light"]),
  AVAILABLE_THEMES: Object.freeze(["original", "auto", "one-dark", "one-light", "dracula", "nord", "monokai", "solarized-dark", "solarized-light", "github-dark", "github-light"]),
  // 本文用の同梱書体。固定ウェイトと可変書体のファイル共有を同じ入口で扱う。
  FONTS: Object.freeze([
    Object.freeze({ key: "noto-sans-jp", regular: "NotoSansJP-Regular.woff2", bold: "NotoSansJP-Bold.woff2" }),
    Object.freeze({ key: "ibm-plex-sans-jp", regular: "IBMPlexSansJP-Regular.woff2", bold: "IBMPlexSansJP-Bold.woff2" }),
    Object.freeze({ key: "m-plus-2", regular: "MPLUS2.woff2", bold: "MPLUS2.woff2" }),
    Object.freeze({ key: "m-plus-rounded-1c", regular: "MPLUSRounded1c-Regular.woff2", bold: "MPLUSRounded1c-Bold.woff2" }),
    Object.freeze({ key: "murecho", regular: "Murecho.woff2", bold: "Murecho.woff2" }),
    Object.freeze({ key: "zen-kaku-gothic-new", regular: "ZenKakuGothicNew-Regular.woff2", bold: "ZenKakuGothicNew-Bold.woff2" }),
    Object.freeze({ key: "line-seed-jp", regular: "LINESeedJP-Regular.woff2", bold: "LINESeedJP-Bold.woff2" }),
  ]),
  FEATURES: Object.freeze([
    Object.freeze({ key: "readableLayout", icon: "book" }),
    Object.freeze({ key: "stickyContents", icon: "list" }),
    Object.freeze({ key: "imageViewer", icon: "image" }),
    Object.freeze({ key: "linkPreview", icon: "link" }),
    Object.freeze({ key: "hideAppearance", icon: "list" }),
    Object.freeze({ key: "narrowContent", icon: "book" }),
  ]),
  DEFAULT_FEATURES: Object.freeze({ readableLayout: true, stickyContents: true, imageViewer: true, linkPreview: true, hideAppearance: false, narrowContent: false }),
  DEFAULT_APPEARANCE: Object.freeze({ theme: "original", font: "sans", fontSize: 18, contentWidth: 960, lineHeight: 1.85,
    headingFont: "inherit", linkStyle: "color", coverImage: "hide", borderRadius: "rounded", articleStyle: "full" }),
  mergeFeatures(value) {
    const out = { ...WikipediaReader.DEFAULT_FEATURES };
    for (const key of Object.keys(out)) if (typeof value?.[key] === "boolean") out[key] = value[key];
    return out;
  },
  // 旧設定も受け入れ、追加項目だけ既定値で補完する。
  isValidAppearance(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const required = ["theme", "font", "fontSize", "contentWidth"];
    if (!required.every((key) => Object.hasOwn(value, key))) return false;
    const normalized = WikipediaReader.normalizeAppearance(value);
    return Object.entries(value).every(([key, item]) => Object.hasOwn(normalized, key) && normalized[key] === item);
  },
  normalizeAppearance(value) {
    const d = WikipediaReader.DEFAULT_APPEARANCE;
    const integer = (v, fallback, min, max) => typeof v === "number" && Number.isFinite(v)
      ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
    return {
      theme: WikipediaReader.THEMES.includes(value?.theme) ? value.theme : d.theme,
      font: ["sans", "serif", ...WikipediaReader.FONTS.map(({ key }) => key)].includes(value?.font) ? value.font : d.font,
      fontSize: integer(value?.fontSize, d.fontSize, 14, 24),
      contentWidth: integer(value?.contentWidth, d.contentWidth, 640, 1200),
      lineHeight: typeof value?.lineHeight === "number" && Number.isFinite(value.lineHeight)
        ? Math.round(Math.min(2.4, Math.max(1.3, value.lineHeight)) * 20) / 20 : d.lineHeight,
      headingFont: ["inherit", "sans", "serif", ...WikipediaReader.FONTS.map(({ key }) => key)].includes(value?.headingFont) ? value.headingFont : d.headingFont,
      linkStyle: ["underline", "color"].includes(value?.linkStyle) ? value.linkStyle : d.linkStyle,
      coverImage: ["show", "hide"].includes(value?.coverImage) ? value.coverImage : d.coverImage,
      // 旧設定・バックアップの互換用。角の形は表示に使わない。
      borderRadius: ["rounded", "square"].includes(value?.borderRadius) ? value.borderRadius : d.borderRadius,
      articleStyle: ["full", "pictures", "text"].includes(value?.articleStyle) ? value.articleStyle : d.articleStyle,
    };
  },
});

const PopupTabs = Object.freeze({
  WIKIPEDIA: "wikipedia",
  TUNE: "tune",
  YOUTUBE: "youtube",
  INSTAGRAM: "instagram",
  TIKTOK: "tiktok",
  X: "x",
  PICKER: "picker",
  SETTINGS: "settings",
  /** UI の並び順と一致させる（矢印キー巡回の順序に使われる）。X は YouTube の次に置く。 */
  ALL: Object.freeze(["tune", "youtube", "x", "instagram", "tiktok", "wikipedia", "picker", "settings"]),

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

  /**
   * POPUP_LAST_SUBTAB の生値を「親タブ id → サブタブ id」のプレーンなレコードに正規化する。
   *
   * サブタブ id は各タブの CATEGORIES / 調整タブのセクション定義に依存して増減するため、
   * ここでは id の妥当性まで見ない（popup 側が「その id のサブタブが実在するか」で判定し、
   * 見つからなければ先頭にフォールバックする）。壊れた値・配列・非文字列は捨てる。
   *
   * @param {unknown} value chrome.storage.local の生値
   * @returns {Record<string, string>} 正規化済みレコード（不正値は空オブジェクト）
   */
  normalizeSubTabs(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out = {};
    for (const tabId of PopupTabs.ALL) {
      const subId = value[tabId];
      if (typeof subId === "string" && subId.length > 0) out[tabId] = subId;
    }
    return out;
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
    Object.freeze({ field: "wikipediaEnabled", storageKey: StorageKeys.WIKIPEDIA_ENABLED, applyAction: Actions.APPLY_WIKIPEDIA_CS }),
    Object.freeze({ field: "wikipediaFeatures", storageKey: StorageKeys.WIKIPEDIA_FEATURES, applyAction: Actions.APPLY_WIKIPEDIA_CS }),
    Object.freeze({ field: "wikipediaAppearance", storageKey: StorageKeys.WIKIPEDIA_APPEARANCE, applyAction: Actions.APPLY_WIKIPEDIA_CS }),
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
  ]);

  // サイト用定義を globalThis に明示的に公開する。これで content scripts / popup / offscreen /
  // background が `Actions.X` の bare 名でアクセスできる（globalThis のプロパティは bare 名で
  // 参照可能という JS 言語仕様）。Chrome 実装の script scope 共有に依存しない安全な設計。
  globalThis.SettingsSchema = SettingsSchema;
  globalThis.Offscreen = Offscreen;
  globalThis.YouTubeShorts = YouTubeShorts;
  globalThis.SearchFixer = SearchFixer;
  globalThis.AmazonDeliveryTotal = AmazonDeliveryTotal;
  globalThis.AmazonRankingJump = AmazonRankingJump;
  globalThis.AmazonMerchantInfo = AmazonMerchantInfo;
  globalThis.InstagramCleaner = InstagramCleaner;
  globalThis.TikTokCleaner = TikTokCleaner;
  globalThis.XCleaner = XCleaner;
  globalThis.WikipediaReader = WikipediaReader;
  globalThis.ImageDownloader = ImageDownloader;
  globalThis.BroadcastClock = BroadcastClock;
  globalThis.NotebookLm = NotebookLm;
  globalThis.ColorPicker = ColorPicker;
  globalThis.PopupTabs = PopupTabs;
})();
