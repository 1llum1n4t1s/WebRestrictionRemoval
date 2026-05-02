/** @readonly メッセージアクション定義 */
const Actions = Object.freeze({
  /** ポップアップ → background: 拡張機能の有効化/無効化を適用 */
  APPLY_SETTINGS: "applySettings",
  /** background → content script: 有効/無効を反映 */
  APPLY_SETTINGS_CS: "applySettingsCS",
  /** background → content script: 強制ペースト実行 */
  FORCE_PASTE: "forcePaste",
  /** background → content script: 強制コピー実行 */
  FORCE_COPY: "forceCopy",
  /** content script → background: メインワールドでインラインハンドラ除去 */
  REMOVE_HANDLERS_MW: "removeHandlersMW",
  /** content script → background: offscreen 経由でクリップボードを読み取り */
  READ_CLIPBOARD: "readClipboard",
  /** content script → background: offscreen 経由でクリップボードへ書き込み */
  WRITE_CLIPBOARD: "writeClipboard",
  /** background → YouTube content script: Shorts 削除の有効/無効を反映 */
  APPLY_YT_SHORTS_CS: "applyYtShortsCS",
  /** background → YouTube content script: Search Fixer 設定を反映 */
  APPLY_SEARCH_FIXER_CS: "applySearchFixerCS",
  /** background → Amazon 定期おトク便 content script: 合計金額表示の有効/無効を反映 */
  APPLY_AMAZON_DELIVERY_TOTAL_CS: "applyAmazonDeliveryTotalCS",
  /** popup → background: 音量ブースターの gain を指定タブで変更 */
  VOLUME_BOOSTER_SET_GAIN: "volumeBoosterSetGain",
  /** popup → background: 音量ブースターの現在 gain を指定タブで取得 */
  VOLUME_BOOSTER_GET_GAIN: "volumeBoosterGetGain",
  /** popup → background: 全タブのブーストを解放（master OFF 時） */
  VOLUME_BOOSTER_RELEASE_ALL: "volumeBoosterReleaseAll",
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
 * background Service Worker 由来のメッセージのみを受け付けるための
 * 三層チェック（id + tab 不在 + url 一致）を 1 関数に集約する。
 * 各 content script で同じ条件を書き散らかすと検証漏れが起きやすいため、
 * `actions.js` を読み込む全コンポーネントが同一実装を共有する設計。
 *
 * 真を返す = メッセージを処理してよい。偽を返す = 拒否。
 */
const SenderCheck = Object.freeze({
  /** sender が background SW 由来か（content / offscreen から呼ぶ）。 */
  isFromBackground(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (sender.tab) return false; // tab を持つのは content script
    // `sender.url` は SW スクリプトの URL に固定される（chrome-extension://<id>/...）
    return sender.url === chrome.runtime.getURL(ExtensionPaths.BACKGROUND);
  },
  /** sender が popup 由来か（background から呼ぶ）。 */
  isFromPopup(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (sender.tab) return false; // popup は tab を持たない
    // popup.html 以外（offscreen, options page 等）からの送信を拒否する。
    return sender.url === chrome.runtime.getURL(ExtensionPaths.POPUP);
  },
  /** sender が content script 由来か（background から呼ぶ）。 */
  isFromContentScript(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    return typeof sender.tab?.id === "number";
  },
});

/** @readonly Offscreen Document 関連定数 */
const Offscreen = Object.freeze({
  /** offscreen document の HTML パス（manifest 基準の相対パス） */
  PATH: "src/offscreen/offscreen.html",
  /** offscreen 側メッセージ向けの target タグ */
  TARGET: "offscreen",
  /** 読み取りアクション名（クリップボード） */
  ACTION_READ: "readClipboard",
  /** 書き込みアクション名（クリップボード） */
  ACTION_WRITE: "writeClipboard",
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
  /** 使用後のアイドル close 待機時間（ms）。メモリ常駐を避けつつ連続操作を吸収できる長さ */
  IDLE_MS: 30_000,
  /**
   * createDocument の reasons 配列。クリップボード読み書き + 音量ブースター用 tabCapture
   * (USER_MEDIA) + AudioContext 出力 (AUDIO_PLAYBACK) の 3 機能を 1 文書に集約する。
   * Chrome は 1 拡張機能 1 offscreen の制約があるため、機能ごとに別 offscreen を作れない。
   */
  REASONS: Object.freeze(["CLIPBOARD", "USER_MEDIA", "AUDIO_PLAYBACK"]),
});

/** @readonly ストレージキー */
const StorageKeys = Object.freeze({
  /** 拡張機能の有効/無効（単一トグル） */
  ENABLED: "enabled",
  /** セッション維持機能の有効/無効 */
  KEEP_ALIVE_ENABLED: "keepAliveEnabled",
  /** セッション維持のポーリング間隔（ミリ秒） */
  KEEP_ALIVE_INTERVAL_MS: "keepAliveIntervalMs",
  /** 右クリックブロックを無効にするユーザー追加ドメイン一覧（文字列配列） */
  CONTEXT_MENU_ALLOW_DOMAINS: "contextMenuAllowDomains",
  /** YouTube Shorts 削除機能の有効/無効 */
  YT_SHORTS_REMOVAL_ENABLED: "ytShortsRemovalEnabled",
  /** YouTube Search Fixer マスタートグル */
  SEARCH_FIXER_ENABLED: "searchFixerEnabled",
  /**
   * YouTube Search Fixer の個別機能オン/オフ。`{ shelf: true, cardList: false, ... }` 形式の
   * オブジェクトで保存し、未設定キーは `SearchFixer.DEFAULT_FEATURES` で補う。
   */
  SEARCH_FIXER_FEATURES: "searchFixerFeatures",
  /** ホームページのリッチグリッド列数（0 = YouTube デフォルト、4/5/6 が選択肢） */
  SEARCH_FIXER_GRID_ITEMS: "searchFixerGridItems",
  /** Amazon 定期おトク便ページの月別合計金額表示の有効/無効 */
  AMAZON_DELIVERY_TOTAL_ENABLED: "amazonDeliveryTotalEnabled",
  /** 音量ブースター（タブごとの音量を 0-600% で増幅）の有効/無効。
   *  master OFF にすると全タブの AudioContext が解放される（音量は 100% に戻る）。 */
  VOLUME_BOOSTER_ENABLED: "volumeBoosterEnabled",
});

/** @readonly セッション維持機能の定数 */
const KeepAlive = Object.freeze({
  /** 分 → ミリ秒の変換係数（UI 層で単位変換するときに使う） */
  MS_PER_MIN: 60_000,
  /** デフォルトのポーリング間隔（4分 = 300秒以内ターゲットの最もタイトな idle timeout の前に1回ヒット） */
  DEFAULT_INTERVAL_MS: 4 * 60 * 1000,
  /** 最小ポーリング間隔（1分） */
  MIN_INTERVAL_MS: 1 * 60 * 1000,
  /** 最大ポーリング間隔（15分） */
  MAX_INTERVAL_MS: 15 * 60 * 1000,
  /**
   * サイトプリセット: `test(hostname)` が true の場合、同一オリジン GET を追加実行してサーバー側
   * スライディングセッションをリフレッシュする（それ以外のサイトは keepalive.js 側で
   * 現在 URL / origin root への軽量 HEAD ping をフォールバックとして試す）。
   * 追加する場合は「認証済みで GET 安全（副作用なし）」な軽量エンドポイントを選ぶこと。
   * Box の Web UI は専用 GET の公開エンドポイントが明確でないため、汎用 HEAD fallback に委ねる。
   */
  PRESET_ENDPOINTS: Object.freeze([
    Object.freeze({
      name: "SharePoint",
      test: (hostname) =>
        /(^|\.)sharepoint\.(com|cn|de|us)$/i.test(hostname),
      paths: Object.freeze(["/_api/web"]),
    }),
  ]),
  /**
   * ポーリング間隔の値を許容範囲にクランプする（単一情報源）。
   * background / popup / keepalive の 3 経路で共有し、どこか 1 箇所で範囲外値が storage に
   * 永続化されても他の経路で補正できるようにする。
   */
  clampIntervalMs(ms) {
    if (!Number.isFinite(ms)) return KeepAlive.DEFAULT_INTERVAL_MS;
    if (ms < KeepAlive.MIN_INTERVAL_MS) return KeepAlive.MIN_INTERVAL_MS;
    if (ms > KeepAlive.MAX_INTERVAL_MS) return KeepAlive.MAX_INTERVAL_MS;
    return ms;
  },
});

/** @readonly 右クリックメニュー定義 */
const ContextMenuIds = Object.freeze({
  FORCE_PASTE: "forcePaste",
  FORCE_COPY: "forceCopy",
});

/** @readonly サイレント自動解除のイベント・属性・CSSクラス定義 */
const SilentUnlock = Object.freeze({
  /** ブロック対象イベント（キャプチャフェーズで stopImmediatePropagation） */
  EVENTS: ["contextmenu", "selectstart", "dragstart"],
  /** 除去対象インラインハンドラ属性 */
  INLINE_ATTRS: ["oncontextmenu", "onselectstart", "ondragstart"],
  /** テキスト選択解除用 CSS クラス（<html> に付与） */
  CSS_CLASS_SELECT: "__cpa-enable-select",
});

/**
 * matchesBuiltin のメモ化キャッシュ (#18)。Object.freeze されたオブジェクト内には
 * 可変 Map を持てないためモジュールスコープに置く。content script の lifetime に
 * 同期して GC されるので明示クリア不要。
 */
const _builtinCache = new Map();

/**
 * @readonly サイト側のカスタム右クリックメニューを尊重する許可リスト。
 *
 * 対象ホストでは contextmenu の stopImmediatePropagation を行わないため、
 * サイト側が独自に表示するメニュー（Excel Online のセル操作メニュー等）が機能する。
 * selectstart / dragstart ブロックと user-select CSS / インラインハンドラ除去は
 * 通常通り作用させる（カスタムメニューの UX を阻害しないため）。
 */
const ContextMenuAllowlist = Object.freeze({
  /**
   * 組み込み許可パターン。正規表現で hostname を判定する。
   * 追加基準: 「自前の右クリックメニューを主要な操作手段として提供している」SaaS。
   */
  BUILTIN_PATTERNS: Object.freeze([
    // Microsoft 365 / Office Online / OneDrive / SharePoint / Outlook Web
    /(^|\.)office\.com$/i,
    /(^|\.)officeapps\.live\.com$/i,
    /(^|\.)office365\.com$/i,
    /(^|\.)sharepoint\.(com|cn|de|us)$/i,
    /(^|\.)outlook\.com$/i,
    // `/(^|\.)live\.com$/i` が outlook.live.com / calendar.live.com 等をカバーするため、
    // 専用パターンの重複は削除（短絡評価で live.com が先にマッチするためデッドコード化していた）
    /(^|\.)live\.com$/i,
    // Google Workspace
    /^docs\.google\.com$/i,
    /^sheets\.google\.com$/i,
    /^slides\.google\.com$/i,
    /^drive\.google\.com$/i,
    /^mail\.google\.com$/i,
    /^keep\.google\.com$/i,
    // Notion
    /(^|\.)notion\.so$/i,
    /(^|\.)notion\.site$/i,
    // Figma / FigJam
    /(^|\.)figma\.com$/i,
    // Atlassian (Jira / Confluence)
    /(^|\.)atlassian\.net$/i,
    // Miro / Canva / Whimsical
    /(^|\.)miro\.com$/i,
    /(^|\.)canva\.com$/i,
    /(^|\.)whimsical\.com$/i,
    // Airtable / Asana / Monday
    /(^|\.)airtable\.com$/i,
    /(^|\.)asana\.com$/i,
    /(^|\.)monday\.com$/i,
    // VS Code Web / GitHub Codespaces
    /(^|\.)github\.dev$/i,
    /(^|\.)vscode\.dev$/i,
  ]),

  /** 組み込みパターンに hostname がマッチするか。
   *  メモ化 (#18): contextmenu 等の高頻度イベントから毎回 25 個の RegExp.test を回すのを避け、
   *  `_builtinCache` (Map<hostname, boolean>) で結果を再利用する。hostname の数は同一タブ内で
   *  実質有限のため、Map の成長は限定的。content script の lifetime に同期するため明示クリア不要。 */
  matchesBuiltin(hostname) {
    if (!hostname) return false;
    if (_builtinCache.has(hostname)) return _builtinCache.get(hostname);
    let hit = false;
    for (const re of this.BUILTIN_PATTERNS) {
      if (re.test(hostname)) { hit = true; break; }
    }
    _builtinCache.set(hostname, hit);
    return hit;
  },

  /**
   * ユーザー入力文字列をドメイン表記に正規化する。
   * 正規化失敗（ドットを含まない / 不正文字含む等）の場合は空文字を返す。
   * 受理例: "example.com", "https://example.com/path", "*.example.com", ".example.com"
   */
  normalizeDomain(input) {
    if (typeof input !== "string") return "";
    let d = input.trim().toLowerCase();
    if (!d) return "";
    d = d.replace(/^https?:\/\//, "");
    d = d.split("/")[0].split(":")[0];
    // 先頭の `*.` や `.`、末尾の `.` を除去。末尾ドットは `location.hostname` が
    // 末尾ドット付きで返るケースを考慮（正規化済みドメインと等しく扱うため）。
    d = d.replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "");
    if (!/^[a-z0-9.-]+$/.test(d)) return "";
    if (!d.includes(".")) return "";
    return d;
  },

  /**
   * ユーザー追加ドメインに hostname が suffix match するか（ドット境界あり）。
   * "example.com" は "example.com" / "foo.example.com" にマッチするが
   * "barexample.com" にはマッチしない。
   */
  matchesUserDomain(hostname, domain) {
    if (!hostname || !domain) return false;
    return hostname === domain || hostname.endsWith("." + domain);
  },

  /** 組み込み + ユーザー追加の総合判定。 */
  isAllowed(hostname, userDomains) {
    if (!hostname) return false;
    // hostname は location.hostname が末尾ドット付きで返るケースがあるため正規化する。
    // ユーザー追加ドメインは normalizeDomain で末尾ドット除去済みのため、ここで揃えれば
    // "example.com." と "example.com" の比較がマッチする。
    const lc = hostname.toLowerCase().replace(/\.$/, "");
    if (this.matchesBuiltin(lc)) return true;
    if (Array.isArray(userDomains)) {
      for (const d of userDomains) {
        if (this.matchesUserDomain(lc, d)) return true;
      }
    }
    return false;
  },
});

/**
 * @readonly YouTube Shorts 削除機能の定数。
 *
 * メイン制限解除トグルと独立にオプトインで動作する（デフォルト OFF）。
 * 元拡張機能 "Remove YouTube Shorts" の機能を模倣しつつ、外部送信処理は一切持たない。
 *
 * 役割分担:
 *   - SELECTORS_REMOVE: MutationObserver で DOM から物理削除する要素のセレクタ
 *   - CSS_HIDE_SELECTORS: CSS の display:none で隠す要素のセレクタ（DOM 走査不要）
 *   - SHORTS_URL_RE: /shorts/<videoId> をマッチさせて /watch?v=<id> へ書き換える正規表現
 */
const YouTubeShorts = Object.freeze({
  /**
   * MutationObserver で発見次第 remove() する要素セレクタ。
   * 完全に消し去る必要があるもの（チップ・動画行・iframe）に限る。
   * `:has()` を含むセレクタは Chrome 105+ でサポート済み（manifest minimum_chrome_version=92 と
   * 衝突するが、その場合 querySelectorAll が SyntaxError を投げるため try/catch で握り潰す）。
   */
  SELECTORS_REMOVE: Object.freeze([
    'yt-chip-cloud-chip-renderer:has(#text)',          // "Shorts" チップ（テキスト確認は JS 側）
    'ytd-video-renderer:has(a[href*="/shorts/"])',     // 検索結果に紛れる Shorts 行
    'ytd-reel-shelf-renderer',                         // Shorts 棚（ホーム / 関連）
    'ytd-rich-shelf-renderer[is-shorts]',              // リッチ Shorts 棚
    'ytm-reel-shelf-renderer',                         // モバイル Web の Shorts 棚
    'ytm-rich-section-renderer',                       // モバイル Web の Shorts セクション
  ]),

  /**
   * "Shorts" チップ判定用のラベル文字列。サイドバー / チップで使われる aria-label / innerText を
   * 比較する。多言語化対応はせず、英語の "Shorts" のみ判定する（日本語版でも DOM の aria-label は
   * "Shorts" のままのケースが多いが、ローカライズされたラベルは見逃すトレードオフ）。
   */
  CHIP_LABEL: "Shorts",

  /**
   * `/shorts/<videoId>` パスを `/watch?v=<videoId>` へ書き換えるための正規表現。
   * クエリ・ハッシュ込みの URL に対しても videoId を抽出できるよう非貪欲マッチを使う。
   */
  SHORTS_PATH_RE: /\/shorts\/([\w-]{6,})/,

  /**
   * URL リダイレクトの polling 間隔（ms）。SPA のため history.replaceState を捕捉できない
   * ケースに備え 1 秒間隔で監視する（元拡張と同じ）。
   */
  URL_POLL_MS: 1000,
});

/**
 * @readonly YouTube Search Fixer の機能定義と定数。
 *
 * 元拡張機能 "Search Fixer for YouTube" (`bojdknokkpgboeonegndfcgkaommhleo`) の
 * 機能を再実装。外部送信ゼロのプライバシー方針に揃え、設定は `chrome.storage.local`
 * の `searchFixerFeatures` キー（オブジェクト）と `searchFixerGridItems`（数値）で保持する。
 *
 * 設計判断:
 *   - 19 個の機能を 5 カテゴリに分類して popup UI のアコーディオンで開示する
 *   - 各機能の検索結果ページ DOM 操作は MutationObserver 内で適用される
 *   - 値はすべて boolean（true/false）。`itemsPerRow` 系の数値だけ別キーで持つ
 */
const SearchFixer = Object.freeze({
  /**
   * 機能定義の単一情報源。`key` は storage の `searchFixerFeatures` 内のプロパティ名 + UI の
   * data-feature 属性、`label` は popup での日本語表示名、`category` はアコーディオン分類用。
   * 定義順がそのまま popup 表示順になる。
   */
  FEATURES: Object.freeze([
    // 🗑️ 検索結果ノイズ（10）
    Object.freeze({ key: "shelf", label: "動画棚", category: "search_remove" }),
    Object.freeze({ key: "cardList", label: "カードリスト", category: "search_remove" }),
    Object.freeze({ key: "playlist", label: "プレイリスト", category: "search_remove" }),
    Object.freeze({ key: "mix", label: "ミックス", category: "search_remove" }),
    Object.freeze({ key: "course", label: "コース", category: "search_remove" }),
    Object.freeze({ key: "channel", label: "チャンネル", category: "search_remove" }),
    Object.freeze({ key: "reel", label: "Shorts 棚", category: "search_remove" }),
    Object.freeze({ key: "shortsBtn", label: "Shorts ボタン動画", category: "search_remove" }),
    Object.freeze({ key: "live", label: "ライブ / プレミア", category: "search_remove" }),
    Object.freeze({ key: "secondary", label: "関連検索ブロック", category: "search_remove" }),
    // 🚫 動画属性で削除（4）
    Object.freeze({ key: "verified", label: "認証チャンネルの動画", category: "by_badge" }),
    Object.freeze({ key: "artist", label: "アーティストチャンネルの動画", category: "by_badge" }),
    Object.freeze({ key: "watched", label: "視聴済み動画", category: "by_badge" }),
    Object.freeze({ key: "chapter", label: "チャプター付き動画", category: "by_badge" }),
    // ✨ ハイライト（2）
    Object.freeze({ key: "demoteUnmatched", label: "キーワード非マッチをグレー化", category: "highlight" }),
    Object.freeze({ key: "highlightThumb", label: "サムネ枠装飾", category: "highlight" }),
    // 🎬 動画ページ（2）
    Object.freeze({ key: "centerTitle", label: "タイトル中央配置", category: "watch_page" }),
    Object.freeze({ key: "fullWidthDesc", label: "説明文フル幅", category: "watch_page" }),
    // 📐 レイアウト（1。グリッド列数は別 storage キー）
    Object.freeze({ key: "searchGrid", label: "検索結果をグリッド表示", category: "layout" }),
  ]),

  /** カテゴリ表示名（popup の見出し）と表示順序 */
  CATEGORIES: Object.freeze([
    Object.freeze({ id: "search_remove", icon: "🗑️", label: "検索結果ノイズ" }),
    Object.freeze({ id: "by_badge",      icon: "🚫", label: "動画属性で削除" }),
    Object.freeze({ id: "highlight",     icon: "✨", label: "ハイライト" }),
    Object.freeze({ id: "watch_page",    icon: "🎬", label: "動画ページ" }),
    Object.freeze({ id: "layout",        icon: "📐", label: "レイアウト" }),
  ]),

  /** 各機能のデフォルト値（オプトイン方針: すべて false） */
  DEFAULT_FEATURES: Object.freeze({
    shelf: false, cardList: false, playlist: false, mix: false, course: false,
    channel: false, reel: false, shortsBtn: false, live: false, secondary: false,
    verified: false, artist: false, watched: false, chapter: false,
    demoteUnmatched: false, highlightThumb: false,
    centerTitle: false, fullWidthDesc: false, searchGrid: false,
  }),

  /**
   * グリッド列数の選択肢。0 は「YouTube デフォルト（自動）」を意味し、4/5/6 が固定列数。
   * popup の <select> はこの配列順で option を生成する。
   */
  GRID_OPTIONS: Object.freeze([
    Object.freeze({ value: 0, label: "自動（YouTube 既定）" }),
    Object.freeze({ value: 4, label: "4 列" }),
    Object.freeze({ value: 5, label: "5 列" }),
    Object.freeze({ value: 6, label: "6 列" }),
  ]),

  /**
   * `searchFixerFeatures` の値をマージしてデフォルトを補った完全なオブジェクトを返す。
   * popup / content / background のどこから読んでも欠損キーで undefined にならないようにする。
   */
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

  /** グリッド列数を許容値（0/4/5/6）にクランプする。範囲外は 0（自動）に落とす。 */
  clampGridItems(value) {
    const n = Number(value);
    if (n === 4 || n === 5 || n === 6) return n;
    return 0;
  },
});

/**
 * @readonly Amazon 定期おトク便 月別合計金額表示の定数。
 *
 * 元拡張機能 "Amazon定期おトク便の合計金額表示" (`npipdojmddhaehjoglciocbpengfoipp`) の機能を再実装。
 * 元実装は React + Webpack バンドルだが、機能が単純（DOM 集計と要素挿入のみ）なため
 * 軽量な vanilla JS で書き直す。
 *
 * 動作対象: `https://www.amazon.co.jp/auto-deliveries*` のみ。
 * 外部送信ゼロ。`chrome.storage.local.amazonDeliveryTotalEnabled` (boolean) で master 制御。
 */
const AmazonDeliveryTotal = Object.freeze({
  /** 月単位のセクション要素を識別するセレクタ（Amazon 側の attribute）。 */
  SECTION_SELECTOR: "[data-delivery-type]",
  /** セクション内の個別商品価格セレクタ。 */
  PRICE_SELECTOR: ".subscription-price",
  /** 合計表示の挿入先となる左カラムセレクタ。 */
  INSERT_TARGET_SELECTOR: ".a-fixed-left-grid-col",
  /** 合計金額を表示するルート要素のクラス（重複挿入防止用マーカーとしても使う）。 */
  TOTAL_ROOT_CLASS: "__cpa-amzn-delivery-total",
  /**
   * 価格テキストから数値を抽出するための正規表現。あらゆる非数字を除去する。
   * 日本円は整数のみ前提（小数点は登場しない）。元実装の `/￥|,|\D|\s/g` は
   * `\D` が全カテゴリを食うため意味的に `/\D/g` と等価。意図を明示するため簡潔形にした。
   */
  PRICE_NORMALIZE_RE: /\D/g,
});

/**
 * @readonly 音量ブースター（タブごとの音量増幅）の定数。
 *
 * 元拡張 "Volume Master" (`jghecgabfgfdldnmbfkhmffcabddioke`) の音量ブースト機能だけを移植。
 * 音質変更（Default / Voice boost / Bass Boost = BiquadFilter プリセット）は意図的に除外。
 * `tabCapture` で取得した MediaStream を offscreen の AudioContext に流し込み、
 * 単純な GainNode で増幅して `destination` に再出力する。
 *
 * 動作スコープ: アクティブタブ単位。タブごとに独立した AudioContext を offscreen 内に持つ。
 * master OFF / タブ close で AudioContext を解放する（メモリリーク防止）。
 */
const VolumeBooster = Object.freeze({
  /** 最小音量 (%)。0 でミュート。 */
  MIN: 0,
  /** デフォルト音量 (%)。100 で原音そのまま（gain 1.0）。 */
  DEFAULT: 100,
  /** 最大音量 (%)。元拡張の上限と揃える。600 = gain 6.0。 */
  MAX: 600,
  /** スライダー上で「等倍ライン」として強調する位置（％）。 */
  UNITY: 100,
  /** スライダーの step（％単位）。1 だと細かすぎ、5 だとプチプチ感が出るので 1 を採用。 */
  STEP: 1,
  /**
   * 値を許容範囲に丸める。NaN / Infinity / 範囲外は DEFAULT に落とす。
   * popup → background → offscreen の 3 経路で共有し、どこか 1 箇所で範囲外値が
   * 来ても同じロジックで補正されるようにする。
   */
  clampValue(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return VolumeBooster.DEFAULT;
    if (n < VolumeBooster.MIN) return VolumeBooster.MIN;
    if (n > VolumeBooster.MAX) return VolumeBooster.MAX;
    // 1% 刻みに丸める（端数を切り捨てて整数化、保存値の安定化）
    return Math.round(n);
  },
});
