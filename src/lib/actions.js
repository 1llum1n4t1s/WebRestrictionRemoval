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
