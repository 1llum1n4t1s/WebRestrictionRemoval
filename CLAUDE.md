# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WEB制限解除サポート (Web Restriction Remover) は Chrome 拡張機能 (Manifest V3)。Webページの制限を解除する。**v1.1.0 以降はトグル1個**で拡張機能全体を ON/OFF 切替する設計。ON時の動作:

- **サイレント自動解除** (ON中は常時): 右クリック制限 / テキスト選択制限
- **右クリックメニューから手動実行**: 強制ペースト（`contexts: ["editable"]`）/ 強制コピー（`contexts: ["selection"]`）

設定は `chrome.storage.local` の `enabled` キー（boolean）で保存。UI は日本語。デフォルト ON。

## Build Commands

```bash
npm install                  # 初回 / 開発用
npm run ci:install           # CI 用 (npm ci。lockfile 厳守)
npm run build                # アイコン + スクリーンショット一括生成
npm run generate-icons       # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
npm run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer, concurrency=2)
powershell -ExecutionPolicy Bypass -File zip.ps1  # ストア申請用 ZIP パッケージ生成 (Windows)
bash ./zip.sh                # 同上 (Unix)
```

テストフレームワーク・リンターは未導入。動作確認は Chrome に拡張機能を読み込んで手動テスト。

## Architecture

4つのコンポーネントが `chrome.runtime` メッセージパッシングで連携する。アクション定数は `src/lib/actions.js` で定義。ファイルは `src/{popup,background,content,lib,offscreen}/` に配置。

```text
Popup (src/popup/popup.{html,js,css})
  ──APPLY_SETTINGS──▶  Background (src/background/background.js)
                          │ storage 更新 + chrome.contextMenus 再構築 +
                          ──APPLY_SETTINGS_CS──▶  Content Script (src/content/content.js)

[右クリックメニュー]
  chrome.contextMenus.onClicked ─▶ Background
                                   ──FORCE_PASTE / FORCE_COPY──▶ Content Script

[強制ペースト/コピー時のクリップボード操作 (HTTP ページ対応)]
  Content Script ──READ_CLIPBOARD / WRITE_CLIPBOARD──▶ Background
                                                       │ ensureOffscreenDocument()
                                                       ──target: "offscreen"──▶ Offscreen Document
                                                                                │ navigator.clipboard.readText / writeText
                                                                                │ (失敗時は execCommand("paste"/"copy"))
                                                                                └──{ text | ok }──▶ Background ──▶ Content Script
```

### Popup (`src/popup/popup.html`, `src/popup/popup.js`, `src/popup/popup.css`)
トグル1個のみ（幅340px）。トグル変更で即 `APPLY_SETTINGS` を background へ送信。ステータスメッセージ（成功/失敗）を1.5秒表示。設定は `chrome.storage.local.enabled` から復元（未設定時はデフォルト ON）。アクセントカラーは赤系（`#C0605A`）。CSP meta を明示（`default-src 'self'; script-src 'self'; style-src 'self'`）。

### Background (`src/background/background.js`)
Service worker。役割:
1. **右クリックメニュー管理**: `enabled=true` のときのみ「強制ペースト」「強制コピー」をメニュー登録。クリックイベントを受けて対応 content script にメッセージ転送（`info.frameId` を `sendMessage` に渡して iframe 直配送）。
2. **サイレント解除の補強**: メインワールドでのインラインハンドラ除去（`chrome.scripting.executeScript world: "MAIN"`, `allFrames: true`）。CSP 影響を回避。
3. **Offscreen Document ライフサイクル管理**: `ensureOffscreenDocument()` で並行作成ガード、`scheduleOffscreenClose()` で 30 秒アイドル後に自動クローズ（メモリ常駐回避）。`console.warn` で診断導線を確保（`getContexts` / `createDocument` 失敗時）。
4. **Message Handler の sender 検証**: `isFromPopup()` / `isFromContentScript()` ヘルパーで由来を検証。`APPLY_SETTINGS` は popup 由来のみ、`READ/WRITE_CLIPBOARD` と `REMOVE_HANDLERS_MW` は content script 由来のみ受け付ける（content script 乗っ取り経由のクリップボード不正読み取りを閉じる）。
5. **設定マイグレーション**: `onInstalled` で旧 `copyPasteSettings` キー（v1.0.x 以前）を削除し、`enabled` 未設定時はデフォルト ON で初期化。
6. **onStartup** でも `updateContextMenus()` を実行（Service Worker 再起動対策）。

`chrome://`, `edge://`, `about:`, `file://` などの非 HTTP(S) ページにはメッセージ送信をスキップ（`content_scripts.matches` が `http(s)://*/*` のみのため）。

### Content Script (`src/content/content.js`)
IIFE でラップ、`window.__copyPasteAssistRunning` で二重実行防止。`all_frames: true` で iframe にも注入されるため、`chrome.storage.onChanged` を購読して全フレーム横断でトグル状態に追従する。初期化は `document_idle` 直後に `chrome.storage.local.get` → `applyEnabled` を即時実行（`window.load` + `setTimeout` での遅延はしない。遅延すると blockEvent 登録前にサイト側 `contextmenu` が発火する空白期間が生じるため）。

`enabled=true` のとき:

**サイレント自動解除**（処理負荷を抑えるため document 1箇所のキャプチャフェーズで一括処理）:
- `contextmenu`, `selectstart`, `dragstart` イベントを `stopImmediatePropagation()` でブロック
- インラインハンドラ属性（`oncontextmenu`, `onselectstart`, `ondragstart`）は属性セレクタヒットと主要3ノード(document/html/body)のみ除去。`inlineHandlersRemoved` フラグで applyEnabled 複数回呼び出しでも1回のみ実行
- CSS クラス `__cpa-enable-select` を `<html>` に付与し `user-select: text !important` を有効化

**強制ペースト** (`FORCE_PASTE` 受信時):
1. `READ_CLIPBOARD` メッセージを background に送り、offscreen document 経由でクリップボードテキストを取得（content script 直接の `navigator.clipboard.readText()` は http:// 非 secure context で reject されるため）
2. 対象要素を決定: `document.activeElement` が編集可能ならそれを使用、そうでなければ `lastContextEditable`（直前の `contextmenu` イベントで記録した編集可能要素）にフォールバック。Chrome が contextmenu 後に activeElement を body にリセットするケース対応
3. フォールバック時は `el.focus()` してから `document.execCommand("insertText", ...)` を実行（input/textarea/contenteditable 全対応、React 等のフレームワーク対応）
4. execCommand 失敗時: `input`/`textarea` は native setter + `input`/`change` dispatch、`contenteditable` は Range API で挿入

**強制コピー** (`FORCE_COPY` 受信時):
1. `info.selectionText` または `window.getSelection()` からテキスト取得
2. `WRITE_CLIPBOARD` メッセージを background に送り、offscreen document 経由で書き込み（content script 直接の `navigator.clipboard.writeText` は http:// 非 secure context で reject されるうえ、`execCommand("copy")` フォールバックもサイト側の copy ブロッカーに阻害されうるため extension context で実行）
3. offscreen 側は `navigator.clipboard.writeText` を優先し、失敗時は hidden textarea + `execCommand("copy")`

### Offscreen (`src/offscreen/offscreen.html`, `src/offscreen/offscreen.js`)
クリップボード読み書き専用の extension-context ドキュメント。`chrome-extension://` は常に secure context のため `navigator.clipboard.{readText,writeText}` が使える。`target: Offscreen.TARGET` を先に検証してから `Offscreen.ACTION_READ` / `Offscreen.ACTION_WRITE` で分岐（文字列ハードコードではなく `actions.js` の定数を参照）。`offscreen.html` は `<script src="../lib/actions.js">` を先読みし、CSP meta を明示。

### Styling (`src/content/content.css`)
`!important` を使用してページスタイルを上書き。CSSクラスプレフィックス `__cpa-`:
- `__cpa-enable-select`: `user-select: text` を強制

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 設定; permissions: `activeTab`, `scripting`, `storage`, `contextMenus`, `clipboardRead`, `clipboardWrite`, `offscreen` |
| `src/lib/actions.js` | `Object.freeze` された Actions / Offscreen / StorageKeys / ContextMenuIds / SilentUnlock 定数 |
| `src/background/background.js` | Service worker: sender 検証付きメッセージ転送、contextMenus 管理、MW ハンドラ除去、offscreen document 管理、設定マイグレーション |
| `src/content/content.js` | サイレント解除 + 強制ペースト/コピーのロジック |
| `src/content/content.css` | 制限解除スタイル (`!important` で上書き) |
| `src/popup/popup.{html,js,css}` | ポップアップ UI: 単一トグル、設定保存・復元、適用フィードバック |
| `src/offscreen/offscreen.{html,js}` | クリップボード読み書き専用の offscreen document (HTTP ページ対応) |
| `icons/icon.svg` | ソースアイコン (512×512 スパナデザイン 赤系); PNG は `icons/icon-{16,48,128}.png` に生成 |
| `webstore/` | ストア申請用: HTML テンプレート、生成画像、`store-listing.txt` |
| `zip.ps1` / `zip.sh` | ストア申請用 ZIP パッケージ生成 (Windows / Unix)、npm install / アイコン生成失敗で exit 1 |
| `docs/privacy-policy.md` | プライバシーポリシー (`enabled` 単一キー + offscreen/clipboard 権限説明) |

## Store Asset Generation

`icons/icon.svg` → sharp で PNG 変換 (`scripts/generate-icons.js`, 個別失敗は `throw` → `process.exit(1)`)。`webstore/*.html` → Puppeteer でスクリーンショット PNG 生成 (`webstore/generate-screenshots.js`, worker-pool concurrency=2 で並列)。Chrome Web Store 画像サイズ: スクリーンショット 1280×800、プロモ小 440×280、マーキー 1400×560。

## Important Patterns

- **Message Handler の sender 検証** — background は `isFromPopup()` / `isFromContentScript()` を各ハンドラ冒頭で呼ぶ。`APPLY_SETTINGS` は popup 由来（`sender.tab` なし + `sender.id === chrome.runtime.id`）のみ、`READ/WRITE_CLIPBOARD` と `REMOVE_HANDLERS_MW` は content script 由来（`sender.tab?.id` 存在）のみ受ける。新しいメッセージアクションを追加するときは必ずどちらの由来を許可するか明示すること。
- **アクション定数は `src/lib/actions.js` を 4経路で共有** — `importScripts("/src/lib/actions.js")` (background) + `content_scripts` (manifest.json で自動注入) + `<script src="../lib/actions.js">` (popup.html) + `<script src="../lib/actions.js">` (offscreen.html)。ES modules ではなく従来のスクリプト形式で共通定数を共有。offscreen.js で文字列をハードコードしない（二重定義で保守ミスを誘発するため）。
- **二重実行防止** — `window.__copyPasteAssistRunning` グローバルフラグ。
- **軽量イベントブロック** — `document` 1箇所にキャプチャフェーズリスナーを登録し `stopImmediatePropagation()` でサイト側リスナー発火を封じる。全DOM走査なし。
- **インラインハンドラ除去の二重走査回避** — content script 側（isolated world）で属性セレクタヒット + 主要3ノード除去を行い、`inlineHandlersRemoved` フラグで初回のみ実行。background 側の MW 除去（`world: "MAIN"`）は `window/document/html/body` のグローバルプロパティ null 化のみ行い、属性セレクタは content 側に一本化（DOM 属性/プロパティは world 間共有）。
- **iframe 多重呼び出し対策** — `applyEnabled(enabled, { requestMwRemove })` オプションで MW 除去依頼の送信源を制限。`storage.onChanged` は全フレームで発火するため、トップフレーム (`window === window.top`) のみが `REMOVE_HANDLERS_MW` を送る（`chrome.scripting.executeScript allFrames: true` が全フレーム分を1回でカバーするため O(iframe²) を回避）。
- **初期化タイミング** — `document_idle` 注入後、`chrome.storage.local.get` の then で即時 `applyEnabled` を呼ぶ。`window.load` + `setTimeout(,0)` での遅延はしない（blockEvent 登録前のハンドラ発火を防ぐ）。
- **ペースト挿入の順序** — `execCommand("insertText")` を最初に試す（React 等のフレームワーク対応）。失敗時のみ native setter / Range API にフォールバック。
- **強制コピーのフォールバック** — offscreen document 側で `navigator.clipboard.writeText` が失敗した場合、同じ offscreen 内の hidden textarea + `execCommand("copy")` にフォールバック（extension context で実行するためサイト側の copy ブロッカーの影響を受けない）。
- **メインワールドでのハンドラ除去** — `chrome.scripting.executeScript world: "MAIN"` で CSP やブラウザ独自制限を回避。
- **contextMenus の再構築** — `ENABLED` 変更時・onStartup 時に `removeAll()` → `create()` で冪等に再構築。
- **iframe 対応** — `content_scripts.all_frames: true` + `match_origin_as_fallback: true` で通常の iframe に加え `about:blank` / `about:srcdoc` / `data:` / `blob:` 等の関連フレームにも content script を注入（親の origin が `matches` を満たせば）。右クリックメニュー経由の `FORCE_PASTE` / `FORCE_COPY` は `chrome.contextMenus.onClicked` の `info.frameId` を `chrome.tabs.sendMessage` の `frameId` オプションに渡してクリックされたフレームに直接届ける。MW インラインハンドラ除去も `chrome.scripting.executeScript` に `allFrames: true` を指定して全フレーム対象。
- **Offscreen Document のライフサイクル** — http:// の content script では secure context 制限で `navigator.clipboard.readText()` が reject される。`chrome.offscreen.createDocument({ reasons: ["CLIPBOARD"] })` で `src/offscreen/offscreen.html` を起動し、chrome-extension:// (secure) 側で読み取って background 経由で content script に返す。`ensureOffscreenDocument` は `getContexts` (Chrome 116+) での存在確認 + 並行作成ガード付き（"Only one offscreen document" エラー回避）。使用後 30 秒アイドルで `scheduleOffscreenClose()` により自動クローズしメモリ常駐を避ける。
- **設定マイグレーション** — `onInstalled` で旧 `copyPasteSettings` キー（v1.0.x 以前）を削除、`enabled` 未設定時はデフォルト true で初期化。
