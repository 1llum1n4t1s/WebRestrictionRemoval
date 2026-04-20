# 🔧 WEB制限解除サポート

Webページの右クリック・テキスト選択の制限を自動で解除し、右クリックメニューから強制ペースト・強制コピーを実行できる Chrome 拡張機能です。v1.0.14 からは SharePoint / Box 等のセッションタイムアウトを緩和する **セッション維持** 機能も搭載しています。

## 機能

### ⚡ サイレント自動解除（制限解除 ON 時、常時動作）

| 機能 | 説明 |
|------|------|
| 🖱️ 右クリック制限解除 | コンテキストメニューの表示を妨害するスクリプトを無効化 |
| ✏️ テキスト選択制限解除 | `user-select: none` や `selectstart` / `dragstart` イベントの制限を解除 |

### 🖱️ 右クリックメニューから実行

| 機能 | 説明 |
|------|------|
| 📋 強制ペースト | 編集可能な入力欄で右クリック →「📋 強制ペースト」で貼り付け |
| ✂️ 強制コピー | テキスト選択中に右クリック →「✂️ 強制コピー」でクリップボードにコピー |

### 🔄 セッション維持（オプトイン、デフォルトOFF）

企業の SharePoint / Box 等で頻繁に起こるセッションタイムアウトを緩和します。

| 動作 | 説明 |
|------|------|
| 合成アクティビティ | 全サイトで定期的に `mousemove` イベントを dispatch して JS 側のアイドル検知をリセット |
| 同一オリジン ping | SharePoint (`*.sharepoint.{com,cn,de,us}`) では `/_api/web` に GET してサーバー側セッションをリフレッシュ |
| 間隔設定 | ポップアップのスライダーで 1〜15 分の範囲で調整可能（デフォルト 4 分） |

外部サーバーへの通信は一切発生せず、アクセス中のサイト自身へのリクエストのみです。

## 使い方

1. 拡張機能アイコンをクリックしてポップアップを開く
2. 「制限解除」トグル ON/OFF で自動解除を切替（即時適用）
3. 「セッション維持」トグル ON でポーリング開始、スライダーで間隔調整
4. 入力欄やテキスト選択中の右クリックメニューから強制ペースト／強制コピーを実行

設定は `chrome.storage.local` の `enabled` / `keepAliveEnabled` / `keepAliveIntervalMs` に保存され、次回以降も維持されます。初回インストール時のデフォルトは 制限解除=ON / セッション維持=OFF です。

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
npm run build                # アイコン + スクリーンショット一括生成
npm run generate-icons       # アイコンのみ生成
npm run generate-screenshots # スクリーンショットのみ生成
```

### ストア申請用パッケージ生成

```bash
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File zip.ps1

# Unix
bash ./zip.sh
```

`web-restriction-remover.zip` が生成されます。

## 技術詳細

- **Manifest V3** 対応
- **権限**: `activeTab`, `scripting`, `storage`, `contextMenus`, `clipboardRead`, `clipboardWrite`, `offscreen`
- 外部サーバーとの通信なし
- 個人情報の収集なし

### アーキテクチャ

```
Popup (src/popup/popup.{html,js,css})
  ──APPLY_SETTINGS──▶ Background (src/background/background.js)
                        │ storage 更新 + contextMenus 再構築 +
                        ──APPLY_SETTINGS_CS──▶ Content Script (src/content/content.js)

[右クリックメニュー]
  chrome.contextMenus.onClicked ─▶ Background
                                   ──FORCE_PASTE / FORCE_COPY──▶ Content Script

[クリップボード操作は HTTP ページ対応のため offscreen document 経由]
  Content Script ──READ_CLIPBOARD / WRITE_CLIPBOARD──▶ Background
                                                       ──target: "offscreen"──▶ Offscreen Document
                                                                                │ navigator.clipboard.read/writeText
                                                                                │ (失敗時は execCommand フォールバック)
                                                                                └──{ text | ok }──▶ Content Script
```

### 制限解除の仕組み

- **イベント制御**: `document` 1箇所のキャプチャフェーズで `contextmenu` / `selectstart` / `dragstart` を捕捉し `stopImmediatePropagation()` でサイト側リスナーを封じる
- **インラインハンドラ除去**: 属性セレクタヒット + 主要3ノード（document/html/body）のみ除去し全DOM走査を回避。`chrome.scripting.executeScript(world: "MAIN")` で CSP の影響を受けないメインワールド除去も併用
- **CSS 上書き**: `!important` + `__cpa-enable-select` クラスで `user-select: text` を強制
- **Offscreen Document**: HTTPページ上の content script では secure context 制限で `navigator.clipboard` が使えないため、extension context の offscreen document を経由してクリップボード操作を実行
- **セッション維持**: `setInterval` ベースのポーラーで合成 `mousemove` dispatch + プリセット該当サイトへの同一オリジン GET を発射。同一オリジン iframe での多重発射はクロスオリジン判定で回避。Memory Saver で freeze されたタブでは自然停止

## プライバシー

- 個人情報の収集は一切行いません
- すべての処理はユーザーの端末内で完結します
- 詳細は [プライバシーポリシー](docs/privacy-policy.md) を参照

## ライセンス

[MIT License](LICENSE)
