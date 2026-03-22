# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WEB制限解除サポート (Web Restriction Remover) は Chrome 拡張機能 (Manifest V3)。Webページのコピー・ペースト・右クリック・キーボード・印刷・画像保存・オーバーレイ等の制限を解除する。10の機能をトグルでオン/オフ切り替え可能。設定は `chrome.storage.local` でグローバル保存・復元される。UI は日本語。

## Build Commands

```bash
npm run build                # アイコン + スクリーンショット一括生成
npm run generate-icons       # icons/icon.svg → images/icon-{16,48,128}.png (sharp)
npm run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer)
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
5つの機能トグル（右クリック、ペースト、コピー、テキスト選択、カーソル制御）を表示。適用ボタンで `APPLY_SETTINGS` に設定を載せて background へ送信後、ポップアップを閉じる。全ON/全OFFボタンあり。設定は `chrome.storage.local` から復元。

### Background (`scripts/background.js`)
Service worker。アクティブタブへ content script + CSS を動的注入（`window.__copyPasteAssistRunning` フラグで二重注入防止）。`chrome://`, `edge://`, `about:` ページではスキップ。

### Content Script (`scripts/content.js`)
IIFE でラップ。10の制限解除機能を実装:
1. **右クリック**: `contextmenu` イベントのキャプチャフェーズで `stopImmediatePropagation()` + インラインハンドラ除去
2. **ペースト**: `paste`, `beforepaste` イベントの同様の処理
3. **コピー**: `copy`, `beforecopy` イベントの同様の処理
4. **テキスト選択**: `selectstart`, `dragstart` イベント + CSS `user-select: text !important` で上書き
5. **カーソル**: CSS `cursor: auto !important` で上書き（リンク・ボタン・入力欄は適切なカーソルに）
6. **印刷**: `beforeprint`, `afterprint` イベントブロック + `window.print` の復元 + 印刷時CSSリセット
7. **ドラッグ&ドロップ**: `dragstart`, `drag`, `drop` イベントブロック + CSS `user-drag: auto` で上書き
8. **キーボード**: `keydown`, `keyup` のキャプチャフェーズで Ctrl+キー / Fキーを保護（通常入力は邪魔しない）
9. **画像保存**: 画像上の透明オーバーレイを検出し `pointer-events: none` で無効化
10. **オーバーレイ除去**: 全画面を覆う高z-index固定要素を非表示 + body のスクロールロック解除

### Styling (`css/content.css`)
`!important` を使用してページスタイルを上書き。CSSクラスプレフィックス `__cpa-`:
- `__cpa-enable-select`: `user-select: text` を強制
- `__cpa-reset-cursor`: カーソルをリセット（インタラクティブ要素は `pointer`、入力欄は `text`）
- `__cpa-enable-print`: 印刷時の非表示CSSを無効化
- `__cpa-enable-drag`: `user-drag: auto` で画像等のドラッグを許可
- `__cpa-image-save`: 画像の `pointer-events` を強制的に `auto` に

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 設定; permissions: `activeTab`, `scripting`, `storage` |
| `scripts/actions.js` | `Object.freeze` されたアクション・機能キー・ストレージキー定数 |
| `scripts/background.js` | Service worker: スクリプト注入、メッセージ転送 |
| `scripts/content.js` | 制限解除ロジック: イベントブロック、インラインハンドラ除去、CSS 切替 |
| `popup.js` | ポップアップ UI: トグル管理、設定保存・復元、適用 |
| `css/content.css` | 制限解除スタイル (`!important` で上書き) |
| `icons/icon.svg` | ソースアイコン (512×512); PNG は `images/` に生成 |
| `webstore/` | ストア申請用: HTML テンプレート、生成画像 |
| `privacy-policy.md` | プライバシーポリシー |

## Store Asset Generation

`icons/icon.svg` → sharp で PNG 変換 (`scripts/generate-icons.js`)。`webstore/*.html` → Puppeteer でスクリーンショット PNG 生成 (`webstore/generate-screenshots.js`)。Chrome Web Store 画像サイズ: スクリーンショット 1280×800、プロモ小 440×280、マーキー 1400×560。

## Important Patterns

- **content script の注入判定** — `window.__copyPasteAssistRunning` グローバルフラグで管理。background.js で `executeScript` → `func` 実行して確認。
- **イベントブロックの仕組み** — キャプチャフェーズで `stopImmediatePropagation()` を呼び、サイト側のリスナーが発火する前に制御を奪う。
- **インラインハンドラの除去** — `oncontextmenu` 等の HTML 属性と DOM プロパティの両方を null 化。document 自体のハンドラも対象。
- **CSS クラスによるスタイル切替** — `__cpa-enable-select` / `__cpa-reset-cursor` / `__cpa-enable-print` / `__cpa-enable-drag` / `__cpa-image-save` クラスを `<html>` に付与/除去して制限解除を切替。
- **キーボード制限解除はスマートフィルタリング** — Ctrl+キーとFキーのみを保護し、通常のテキスト入力は邪魔しない。
- **オーバーレイ除去はヒューリスティック** — 全画面を覆う高z-index固定要素を検出して非表示にする。body の overflow: hidden も解除。
- **ドラッグ&ドロップとテキスト選択の dragstart 共有** — 両方が `dragstart` をブロックするため、テキスト選択ONの場合はドラッグOFF時も `dragstart` ブロックを維持。
- **`actions.js` は `importScripts` (background) と `executeScript` (注入) の2経路で読み込まれる** — ES modules ではなく従来のスクリプト形式。
