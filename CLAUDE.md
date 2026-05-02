# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WEB制限解除サポート (Web Restriction Remover) は Chrome 拡張機能 (Manifest V3)。Webページの制限を解除する。**「制限解除」「セッション維持」「YouTube Shorts 削除」「YouTube クリーナー (Search Fixer)」「Amazon 定期おトク便 月別合計」「音量ブースター」の 6 つの独立オプトイントグル + カスタム右クリック許可リスト**の構成。YouTube クリーナーは 19 個のサブトグル + グリッド列数 select を、音量ブースターは 0-600% スライダー + リセットボタンを内包する。制限解除 ON 時の動作:

- **サイレント自動解除** (ON中は常時): 右クリック制限 / テキスト選択制限
- **右クリックメニューから手動実行**: 強制ペースト（`contexts: ["editable"]`）/ 強制コピー（`contexts: ["selection"]`）

「制限解除」「セッション維持」「YouTube Shorts 削除」の 3 機能はすべて独立にオプトイン（**全てデフォルト OFF**）。「カスタム右クリック許可リスト」は常時機能し、組み込みパターン + ユーザー追加ドメインで判定する。

設定は `chrome.storage.local` の `enabled` キー（boolean）で保存。UI は日本語。**デフォルトは全機能 OFF**（インストール直後にサイト挙動を勝手に書き換えず、ユーザーが意図的に ON にした機能のみ動作する方針）。

Excel Online / Google Docs / Notion / Figma 等 **カスタム右クリックメニューを提供する SaaS** では、サイト側のメニューを尊重するため `contextmenu` ブロックをスキップする。判定は `actions.js` の `ContextMenuAllowlist`（組み込みパターン + ユーザー追加の `contextMenuAllowDomains`）で行う。許可ホストでも `selectstart`/`dragstart` ブロック・user-select CSS・インラインハンドラ除去は通常どおり作用する。ユーザー追加ドメインは popup のアコーディオン内 textarea（1行1ドメイン）で編集し、`ContextMenuAllowlist.normalizeDomain` で正規化してから保存。

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
トグル1個のみ（幅340px）。トグル変更で即 `APPLY_SETTINGS` を background へ送信。ステータスメッセージ（成功/失敗）を1.5秒表示。設定は `chrome.storage.local.enabled` から復元（未設定時は **デフォルト OFF**、`=== true` で防御的に判定）。アクセントカラーは赤系（ライト `#C0605A` / ダーク `#df8983`）。CSP meta を明示（`default-src 'self'; script-src 'self'; style-src 'self'`）。

**ダーク/ライトモード追従**: `<meta name="color-scheme" content="light dark">` でネイティブ要素も追従させ、CSS は `:root` のライト用トークン定義 + `@media (prefers-color-scheme: dark)` のダーク用トークン上書きの 2 層構造。色値はすべて CSS 変数経由で、本文セレクタにはハードコード色がない（茜色は HSL の色相を維持したまま明度・彩度を上げて夜空向けに調整、shadow も dark 時に強めて thumb 形状の判別を維持）。

### Background (`src/background/background.js`)
Service worker。役割:
1. **右クリックメニュー管理**: `enabled=true` のときのみ「強制ペースト」「強制コピー」をメニュー登録。クリックイベントを受けて対応 content script にメッセージ転送（`info.frameId` を `sendMessage` に渡して iframe 直配送）。
2. **サイレント解除の補強**: メインワールドでのインラインハンドラ除去（`chrome.scripting.executeScript world: "MAIN"`, `allFrames: true`）。CSP 影響を回避。
3. **Offscreen Document ライフサイクル管理**: `ensureOffscreenDocument()` で並行作成ガード、`scheduleOffscreenClose()` で 30 秒アイドル後に自動クローズ（メモリ常駐回避）。`console.warn` で診断導線を確保（`getContexts` / `createDocument` 失敗時）。
4. **Message Handler の sender 検証**: `isFromPopup()` / `isFromContentScript()` ヘルパーで由来を検証。`APPLY_SETTINGS` は popup 由来のみ、`READ/WRITE_CLIPBOARD` と `REMOVE_HANDLERS_MW` は content script 由来のみ受け付ける（content script 乗っ取り経由のクリップボード不正読み取りを閉じる）。
5. **設定マイグレーション**: `onInstalled` で旧 `copyPasteSettings` キー（v1.0.x 以前）を削除し、`enabled` / `keepAliveEnabled` / `ytShortsRemovalEnabled` 未設定時は **すべて false** で初期化（オプトイン方針）。
6. **onStartup** でも `updateContextMenus()` を実行（Service Worker 再起動対策）。

`chrome://`, `edge://`, `about:`, `file://` などの非 HTTP(S) ページにはメッセージ送信をスキップ（`content_scripts.matches` が `http(s)://*/*` のみのため）。

### Content Script (`src/content/content.js`)
IIFE でラップ、`window.__copyPasteAssistRunning` で二重実行防止。`all_frames: true` で iframe にも注入されるため、`chrome.storage.onChanged` を購読して全フレーム横断でトグル状態に追従する。初期化は `document_idle` 直後に `chrome.storage.local.get` → `applyEnabled` を即時実行（`window.load` + `setTimeout` での遅延はしない。遅延すると blockEvent 登録前にサイト側 `contextmenu` が発火する空白期間が生じるため）。

`enabled=true` のとき:

**サイレント自動解除**（処理負荷を抑えるため document 1箇所のキャプチャフェーズで一括処理）:
- `contextmenu`, `selectstart`, `dragstart` イベントを `stopImmediatePropagation()` でブロック
- **`ContextMenuAllowlist.isAllowed(location.hostname, currentAllowDomains)` が true のホストでは `contextmenu` のみ unblock** し、サイト側カスタムメニューを通す（例: Office Online / Google Docs / Notion）。`selectstart`/`dragstart` は通常どおりブロック
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

### 音量ブースター (`src/offscreen/offscreen.js` の Volume Booster 部分)
元拡張 "Volume Master" (`jghecgabfgfdldnmbfkhmffcabddioke`) の音量ブースト機能だけを移植したオプトイン機能。元拡張の Equalizer (Default / Voice boost / Bass Boost) は意図的に除外し、純粋な GainNode ベースの音量増幅のみ実装。`volumeBoosterEnabled` (boolean) で master 制御。

**処理フロー**:
1. popup でマスタートグル ON → スライダー操作（0-600%）
2. popup → background: `VOLUME_BOOSTER_SET_GAIN` メッセージ（`tabId`, `gain`）
3. background: `chrome.tabCapture.getMediaStreamId({ targetTabId })` で MediaStream ID 取得
4. background → offscreen: `ACTION_VOLUME_SET_GAIN`（`tabId`, `streamId`, `gain`）
5. offscreen: 未登録タブなら `getUserMedia({chromeMediaSource:"tab", chromeMediaSourceId:streamId})` で stream 取得 → `AudioContext` + `GainNode` 構築 → `mediaSource → gainNode → destination` の 3 ノード接続。登録済みなら GainNode の `.value` だけ更新

**ライフサイクル**:
- `chrome.tabs.onRemoved`: タブ閉じで該当 `tabId` を offscreen から release（`AudioContext.close()` + stream tracks 停止）
- master OFF 切替: `VOLUME_BOOSTER_RELEASE_ALL` で全タブを release
- アイドル close 抑止: `scheduleOffscreenClose` 発火時に `ACTION_VOLUME_QUERY_ACTIVE` を送り、boost 中タブが残っていれば close をスキップ（音が止まらないようにするため）

**Offscreen reasons の合算**: 既存 clipboard 用 offscreen と同居するため `Offscreen.REASONS = ["CLIPBOARD", "USER_MEDIA", "AUDIO_PLAYBACK"]`。Chrome は 1 拡張 1 offscreen 制約のため、機能ごとに別文書を作れない。

**popup UI**: `volumeBoosterToggle` ON 時のみ `volumeRow` を表示（`hidden` クラス制御）。スライダーは `input` イベントで 120ms debounce 後に gain 送信、`change` イベント（マウスアップ）で即送信。リセットボタンで 100% 復帰。

### Amazon 定期おトク便 月別合計 (`src/content/amazon-delivery-total.js`, `src/content/amazon-delivery-total.css`)
元拡張 "Amazon定期おトク便の合計金額表示" (`npipdojmddhaehjoglciocbpengfoipp`) を vanilla JS で再実装したオプトイン機能。`amazonDeliveryTotalEnabled` (boolean) で master 制御。

**動作対象**: `*://www.amazon.co.jp/auto-deliveries*` のみ（manifest の matches で限定）。top frame 限定。

**動作**:
1. `[data-delivery-type]` 要素（=月単位セクション）を `document.querySelectorAll` で取得
2. 各セクション内の `.subscription-price` 要素のテキストを `/\D/g` で非数字を除去して数値化
3. 合計を `Number.toLocaleString()` で 3 桁区切り表示
4. 各セクションの `.a-fixed-left-grid-col` に `.__cpa-amzn-delivery-total` クラスのルート要素を append
5. MutationObserver で動的更新（`queueMicrotask` で coalesce）

OFF 時は observer 切断 + 既存挿入要素 `.__cpa-amzn-delivery-total` を全部撤去。重複挿入防止のため、再描画では既存ルートが見つかれば数値表示部 `__price` の textContent だけ書き換える。

設定の同期は **`chrome.storage.onChanged` + `APPLY_AMAZON_DELIVERY_TOTAL_CS` メッセージ** の二重購読方針。background は `isAmazonAutoDeliveryUrl()` (hostname 厳密一致 `www.amazon.co.jp` + パスは `/auto-deliveries` prefix) でガードしてから送信する。

### YouTube Search Fixer (`src/content/search-fixer.js`, `src/content/search-fixer.css`)
元拡張 "Search Fixer for YouTube" (`bojdknokkpgboeonegndfcgkaommhleo`) の DOM 操作機能（19 機能 + グリッド列数）を再実装したオプトイン機能。`searchFixerEnabled` (master) と `searchFixerFeatures` (オブジェクト) と `searchFixerGridItems` (数値: 0/4/5/6) の 3 キーで管理。19 機能の単一情報源は `actions.js` の `SearchFixer.FEATURES` で、popup はこの定義から動的に DOM を生成する（人手二重管理を避ける）。

機能カテゴリ:
- 🗑️ **検索結果ノイズ** (10): 動画棚 / カードリスト / プレイリスト / ミックス / コース / チャンネル / Shorts 棚 / Shorts ボタン動画 / ライブ / 関連検索ブロック
- 🚫 **動画属性で削除** (4): 認証 / アーティスト / 視聴済み / チャプター付き
- ✨ **ハイライト** (2): キーワード非マッチをグレー化 / サムネ枠装飾
- 🎬 **動画ページ** (2): タイトル中央配置 / 説明文フル幅
- 📐 **レイアウト** (1): 検索結果グリッド表示

実装: top frame 限定で `MutationObserver(childList: true, subtree: true)` を起動し、`yt-navigate-finish` / `yt-navigate-start` イベントで onSettingsChanged を再実行する。マスター OFF 時は observer / 注入 CSS / 装飾クラスをすべて停止して DOM 副作用を残さない。

設定の同期は **`chrome.storage.onChanged` + `APPLY_SEARCH_FIXER_CS` メッセージ** の二重購読方針（YouTube Shorts 削除と同じパターン）。background は `isYouTubeUrl()` で active tab が youtube.com 系かを判定してからメッセージ送信する。

### YouTube Shorts Removal (`src/content/youtube-shorts.js`, `src/content/youtube-shorts.css`)
YouTube Shorts を非表示・物理削除するオプトイン機能（メイン制限解除トグルと独立）。manifest.json では `*://*.youtube.com/*` 限定の専用 content_scripts エントリで `all_frames: false`（top frame のみ）に注入し、汎用 content.js とは別ライフサイクルで動く。`window.__ytShortsRemoverRunning` で二重実行防止、`window === window.top` チェックで埋め込みプレーヤーには注入せず CPU 負荷を抑える。

**actions.js の二重ロード回避**: youtube.com は最初のエントリ（`http(s)://*/*`）にもマッチするため、両エントリで `actions.js` を読み込むと同じ isolated world で `const Actions = ...` が再宣言され SyntaxError になる。Chrome の同一拡張・同一ページの content scripts は同一 isolated world で「script scope」を共有するため、最初のエントリで読み込んだ `Actions` / `StorageKeys` / `YouTubeShorts` 定数は2番目のエントリの `youtube-shorts.js` からも参照できる。よって 2 番目のエントリの `js` 配列には `actions.js` を含めない。

`enabled=true` のとき:
- `<html>` に CSS クラス `__cpa-yt-shorts-hidden` を付与し `youtube-shorts.css` でサイドバー / チップ / 棚 / タブを `display: none !important`
- `MutationObserver(childList: true, subtree: true)` で `YouTubeShorts.SELECTORS_REMOVE` の要素を発見次第 `.remove()`。連続 mutation の coalesce には `queueMicrotask` を使う
- "Shorts" チップのみは `#text.textContent === "Shorts"` を確認してから削除（他のチップを巻き込まない）
- `setInterval(YouTubeShorts.URL_POLL_MS = 1000)` で `location.pathname` を監視し、`/shorts/<videoId>` を `/watch?v=<videoId>` へ `location.replace`（YouTube SPA は history.pushState を使うので popstate / load では捕捉できないため polling 必須）

`enabled=false` 切替時は observer / interval / CSS クラスをすべて停止（DOM から削除済みの要素は復元できないが、SPA 遷移で次回再構築されるため実用上問題なし）。

設定の同期は **`chrome.storage.onChanged` + `APPLY_YT_SHORTS_CS` メッセージ** の二重購読方針。background は `handleApplySettings` 内で `URL.hostname` が `youtube.com` または `*.youtube.com` のときのみ `APPLY_YT_SHORTS_CS` を送信する（receiver なしタブでの例外回避）。

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 設定; permissions: `activeTab`, `scripting`, `storage`, `contextMenus`, `clipboardRead`, `clipboardWrite`, `offscreen`, `tabCapture` |
| `src/lib/actions.js` | `Object.freeze` された Actions / Offscreen / StorageKeys / ContextMenuIds / SilentUnlock / ContextMenuAllowlist 定数 |
| `src/background/background.js` | Service worker: sender 検証付きメッセージ転送、contextMenus 管理、MW ハンドラ除去、offscreen document 管理、設定マイグレーション |
| `src/content/content.js` | サイレント解除 + 強制ペースト/コピーのロジック |
| `src/content/youtube-shorts.js` | YouTube Shorts 削除（top frame のみ）: MutationObserver + URL リダイレクト |
| `src/content/youtube-shorts.css` | `__cpa-yt-shorts-hidden` クラス付与時に Shorts UI を `display: none` |
| `src/content/search-fixer.js` | YouTube Search Fixer（19 機能 + グリッド列数）: master + features + gridItems で駆動 |
| `src/content/search-fixer.css` | サムネ枠装飾 / タイトル中央 / 説明文フル幅 等のクラス定義 |
| `src/content/amazon-delivery-total.js` | Amazon 定期おトク便ページ（matches 限定）: 月別合計を MutationObserver 駆動で挿入 |
| `src/content/amazon-delivery-total.css` | `.__cpa-amzn-delivery-total` の Amazon 配色合計表示スタイル |
| `src/content/content.css` | 制限解除スタイル (`!important` で上書き) |
| `src/popup/popup.{html,js,css}` | ポップアップ UI: 単一トグル、設定保存・復元、適用フィードバック |
| `src/offscreen/offscreen.{html,js}` | 多目的 offscreen document: クリップボード読み書き + 音量ブースターの AudioContext 維持 |
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
- **カスタム右クリック許可リスト** — Excel Online / Google Docs / Notion 等のカスタムメニュー提供サイトで `contextmenu` ブロックをスキップする。組み込みパターン（`ContextMenuAllowlist.BUILTIN_PATTERNS`）＋ユーザー追加ドメイン（`StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS` 配列）の 2 層構成。ユーザー追加値は popup 側で `ContextMenuAllowlist.normalizeDomain()` を通して保存（`https://` 等のプレフィックス除去、`*.` / 先頭ドット除去、不正文字行を reject）。suffix match はドット境界付き（`example.com` は `foo.example.com` にマッチ、`barexample.com` にはマッチしない）。content script 側は `currentAllowDomains` を closure 保持し、`storage.onChanged` と `APPLY_SETTINGS_CS` の両経路で同期する。allow-list が変化したら `applyEnabled` を再実行して block/unblock を切り替える（同じイベントを再 register しないガードは `blockHandlers` Map が担う）。
