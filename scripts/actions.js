/** @readonly メッセージアクション定義 */
const Actions = Object.freeze({
  /** ポップアップ → background: 機能の有効化/無効化を適用 */
  APPLY_SETTINGS: "applySettings",
  /** background → content script: 設定を反映 */
  APPLY_SETTINGS_CS: "applySettingsCS",
  /** content script → background: メインワールドでインラインハンドラを除去 */
  REMOVE_HANDLERS_MW: "removeHandlersMW",
});

/** @readonly 機能キー定義 */
const Features = Object.freeze({
  /** 右クリック制限解除 */
  RIGHT_CLICK: "rightClick",
  /** ペースト制限解除（Ctrl+V / 右クリックペースト） */
  PASTE: "paste",
  /** コピー制限解除（Ctrl+C） */
  COPY: "copy",
  /** テキスト選択制限解除 */
  TEXT_SELECT: "textSelect",
  /** カーソル制御解除 */
  CURSOR_RESET: "cursorReset",
  /** 印刷制限解除 */
  PRINT: "print",
  /** ドラッグ&ドロップ制限解除 */
  DRAG_DROP: "dragDrop",
  /** キーボードショートカット制限解除 */
  KEYBOARD: "keyboard",
  /** 画像保存制限解除（透明オーバーレイ除去） */
  IMAGE_SAVE: "imageSave",
  /** オーバーレイ除去（モーダル・ペイウォール） */
  OVERLAY_REMOVE: "overlayRemove",
});

/** @readonly ストレージキー */
const StorageKeys = Object.freeze({
  SETTINGS: "copyPasteSettings",
});

/** デフォルト設定（全て無効）— Features との同期を自動で保つ */
function getDefaultSettings() {
  return Object.fromEntries(
    Object.values(Features).map((key) => [key, false])
  );
}
