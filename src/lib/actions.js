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
});

/** @readonly ストレージキー */
const StorageKeys = Object.freeze({
  /** 拡張機能の有効/無効（単一トグル） */
  ENABLED: "enabled",
  /** セッション維持機能の有効/無効 */
  KEEP_ALIVE_ENABLED: "keepAliveEnabled",
  /** セッション維持のポーリング間隔（ミリ秒） */
  KEEP_ALIVE_INTERVAL_MS: "keepAliveIntervalMs",
});

/** @readonly セッション維持機能の定数 */
const KeepAlive = Object.freeze({
  /** デフォルトのポーリング間隔（4分 = 300秒以内ターゲットの最もタイトな idle timeout の前に1回ヒット） */
  DEFAULT_INTERVAL_MS: 4 * 60 * 1000,
  /** 最小ポーリング間隔（1分） */
  MIN_INTERVAL_MS: 1 * 60 * 1000,
  /** 最大ポーリング間隔（15分） */
  MAX_INTERVAL_MS: 15 * 60 * 1000,
  /**
   * サイトプリセット: `test(hostname)` が true の場合、同一オリジン GET を追加実行してサーバー側
   * スライディングセッションをリフレッシュする（それ以外のサイトは合成イベントのみ）。
   * 追加する場合は「認証済みで GET 安全（副作用なし）」な軽量エンドポイントを選ぶこと。
   * Box の Web UI は HTTP ping 対象の公開エンドポイントが明確でないため、合成イベントのみで対応する。
   */
  PRESET_ENDPOINTS: Object.freeze([
    Object.freeze({
      name: "SharePoint",
      test: (hostname) =>
        /(^|\.)sharepoint\.(com|cn|de|us)$/i.test(hostname),
      paths: Object.freeze(["/_api/web"]),
    }),
  ]),
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
