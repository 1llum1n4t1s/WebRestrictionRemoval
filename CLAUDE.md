# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WEB制限解除サポート (Web Restriction Remover) は Chrome 拡張機能 (Manifest V3)。Webページのコピー・ペースト・右クリック・テキスト選択の制限を解除する。4つの機能をトグルでオン/オフ切り替え可能。設定は `chrome.storage.local` でグローバル保存・復元される。UI は日本語。

## Build Commands

```bash
npm run build                # アイコン + スクリーンショット一括生成
npm run generate-icons       # icons/icon.svg → images/icon-{16,48,128}.png (sharp)
npm run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer)
powershell -ExecutionPolicy Bypass -File zip.ps1  # ストア申請用 ZIP パッケージ生成
```

テストフレームワーク・リンターは未導入。動作確認は Chrome に拡張機能を読み込んで手動テスト。

## Architecture

3つのコンポーネントが `chrome.runtime` メッセージパッシングで連携する。アクション定数は `scripts/actions.js` で定義（`APPLY_SETTINGS`, `APPLY_SETTINGS_CS`）。

```
Popup (popup.html/js/css)
  ──APPLY_SETTINGS──▶  Background (scripts/background.js)
                          │ scripts/content.js + actions.js + css/content.css を注入後:
                          ──APPLY_SETTINGS_CS──▶  Content Script (scripts/content.js)
```

### Popup (`popup.html`, `popup.js`, `popup.css`)
4つの機能トグルを表示（幅400px、高さ自動 max-height: 550px）。適用ボタンで `APPLY_SETTINGS` に設定を載せて background へ送信後、ポップアップを閉じる。全ON/全OFFボタンあり。設定は `chrome.storage.local` から復元。アクセントカラーは赤系（`#C0605A`）。

### Background (`scripts/background.js`)
Service worker。content script へのメッセージ転送 + メインワールドでのインラインハンドラ除去を担当。`chrome://`, `edge://`, `about:` ページではスキップ。`onInstalled` イベントで旧バージョンの削除済み機能キーを storage からクリーンアップするマイグレーション処理を実行。

### Content Script (`scripts/content.js`)
IIFE でラップ。4つの制限解除機能を実装:
1. **右クリック**: `contextmenu` イベントのキャプチャフェーズで `stopImmediatePropagation()` + インラインハンドラ除去
2. **ペースト**: `paste`, `beforepaste` イベントの同様の処理
3. **コピー**: `copy`, `beforecopy` イベントの同様の処理
4. **テキスト選択**: `selectstart`, `dragstart` イベント + CSS `user-select: text !important` で上書き

### Styling (`css/content.css`)
`!important` を使用してページスタイルを上書き。CSSクラスプレフィックス `__cpa-`:
- `__cpa-enable-select`: `user-select: text` を強制

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 設定; permissions: `activeTab`, `scripting`, `storage` |
| `scripts/actions.js` | `Object.freeze` されたアクション・機能キー・ストレージキー定数 |
| `scripts/background.js` | Service worker: メッセージ転送、MW ハンドラ除去、設定マイグレーション |
| `scripts/content.js` | 制限解除ロジック: イベントブロック、インラインハンドラ除去、CSS 切替 |
| `popup.js` | ポップアップ UI: トグル管理、設定保存・復元、適用 |
| `css/content.css` | 制限解除スタイル (`!important` で上書き) |
| `icons/icon.svg` | ソースアイコン (512×512 スパナデザイン 赤系); PNG は `images/` に生成 |
| `webstore/` | ストア申請用: HTML テンプレート、生成画像、`store-listing.txt` |
| `zip.ps1` | ストア申請用 ZIP パッケージ生成 (PowerShell) |
| `privacy-policy.md` | プライバシーポリシー |

## Store Asset Generation

`icons/icon.svg` → sharp で PNG 変換 (`scripts/generate-icons.js`)。`webstore/*.html` → Puppeteer でスクリーンショット PNG 生成 (`webstore/generate-screenshots.js`)。Chrome Web Store 画像サイズ: スクリーンショット 1280×800、プロモ小 440×280、マーキー 1400×560。

## Important Patterns

- **content script の二重実行防止** — `window.__copyPasteAssistRunning` グローバルフラグで管理。
- **イベントブロックの仕組み** — キャプチャフェーズで `stopImmediatePropagation()` を呼び、サイト側のリスナーが発火する前に制御を奪う。
- **インラインハンドラの除去** — `oncontextmenu` 等の HTML 属性と DOM プロパティの両方を null 化。document 自体のハンドラも対象。
- **CSS クラスによるスタイル切替** — `__cpa-enable-select` クラスを `<html>` に付与/除去して制限解除を切替。
- **`actions.js` は `importScripts` (background) と `content_scripts` (manifest.json 自動注入) と `<script>` (popup.html) の3経路で読み込まれる** — ES modules ではなく従来のスクリプト形式。
- **設定マイグレーション** — `onInstalled` イベントで旧バージョン（v1.0.6以前）の削除済み機能キーを storage からクリーンアップ。
