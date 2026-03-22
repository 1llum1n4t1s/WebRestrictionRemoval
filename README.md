# WEB制限解除サポート

Webページのコピー・ペースト・右クリック・テキスト選択の制限をワンクリックで解除する Chrome 拡張機能です。

## 機能

### 基本機能

| 機能 | 説明 |
|------|------|
| 🖱️ 右クリック制限解除 | コンテキストメニューの表示を妨害するスクリプトを無効化 |
| 📋 ペースト制限解除 | Ctrl+V および右クリックペーストの制限を解除 |
| 📝 コピー制限解除 | Ctrl+C のコピー制限を解除 |
| ✏️ テキスト選択制限解除 | `user-select: none` や selectstart イベントの制限を解除 |
| 🔄 カーソル制御解除 | サイトが変更したカーソル形状を標準に戻す |

### 拡張機能

| 機能 | 説明 |
|------|------|
| 🖨️ 印刷制限解除 | Ctrl+P / window.print() のブロックを解除、印刷時の非表示CSSも無効化 |
| 🖐️ ドラッグ&ドロップ制限解除 | 画像やテキストのドラッグ禁止を解除 |
| ⌨️ キーボード制限解除 | Ctrl+A/S/P, F5/F11/F12 等のショートカット奪取を防止 |
| 🖼️ 画像保存制限解除 | 画像上の透明オーバーレイを検出・除去して直接保存可能に |
| 🚫 オーバーレイ除去 | ログインモーダルやペイウォールの全画面オーバーレイを除去 |

## 使い方

1. 拡張機能アイコンをクリック
2. 解除したい機能のトグルをONにする
3. 「適用」ボタンをクリック

設定はグローバルに保存され、次回以降も維持されます。

## インストール

### Chrome Web Store から

[Chrome Web Store](https://chrome.google.com/webstore) で「WEB制限解除サポート」を検索してインストール。

### 開発版を手動インストール

1. このリポジトリをクローン
2. `chrome://extensions/` を開く
3. 「デベロッパー モード」をON
4. 「パッケージ化されていない拡張機能を読み込む」でプロジェクトフォルダを選択

## ビルド

```bash
npm install
npm run build          # アイコン + スクリーンショット一括生成
npm run generate-icons # アイコンのみ生成
npm run generate-screenshots # スクリーンショットのみ生成
```

## 技術詳細

- **Manifest V3** 対応
- **権限**: `activeTab`, `scripting`, `storage`
- 外部サーバーとの通信なし
- 個人情報の収集なし

### アーキテクチャ

```
Popup (popup.html/js/css)
  ──APPLY_SETTINGS──▶ Background (scripts/background.js)
                        │ content script + CSS を動的注入後:
                        ──APPLY_SETTINGS_CS──▶ Content Script (scripts/content.js)
```

### 制限解除の仕組み

- **イベント制御**: キャプチャフェーズでイベントリスナーを登録し、`stopImmediatePropagation()` でサイト側の制限ハンドラを無効化
- **インラインハンドラ除去**: `oncontextmenu`, `oncopy`, `onpaste` 等の HTML 属性を除去
- **CSS 上書き**: `!important` で `user-select` や `cursor` プロパティを強制上書き

## プライバシー

- 個人情報の収集は一切行いません
- すべての処理はユーザーの端末内で完結します
- 詳細は [プライバシーポリシー](privacy-policy.md) を参照

## ライセンス

[MIT License](LICENSE)
