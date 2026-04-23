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
});

/** @readonly Offscreen Document 関連定数 */
const Offscreen = Object.freeze({
  /** offscreen document の HTML パス（manifest 基準の相対パス） */
  PATH: "src/offscreen/offscreen.html",
  /** offscreen 側メッセージ向けの target タグ */
  TARGET: "offscreen",
  /** 読み取りアクション名 */
  ACTION_READ: "readClipboard",
  /** 書き込みアクション名 */
  ACTION_WRITE: "writeClipboard",
  /** 使用後のアイドル close 待機時間（ms）。メモリ常駐を避けつつ連続操作を吸収できる長さ */
  IDLE_MS: 30_000,
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

  /** 組み込みパターンに hostname がマッチするか。 */
  matchesBuiltin(hostname) {
    if (!hostname) return false;
    // `this.BUILTIN_PATTERNS` で自己参照すれば、将来 ES modules 化してオブジェクト名の
    // バインディングが TDZ に入ったり変数名がリネームされても methods は壊れない。
    // ドット呼び出し前提（call/apply/bind/分離呼び出しはプロジェクト内で行われていない）。
    for (const re of this.BUILTIN_PATTERNS) {
      if (re.test(hostname)) return true;
    }
    return false;
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
