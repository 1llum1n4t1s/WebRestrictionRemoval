# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WEB閲覧アシスト (Web Viewing Assist) は Chrome 拡張機能 (Manifest V3)。Web ブラウジングを快適にする 9 機能を提供する：「セッション維持（現在のサイト単位）」「YouTube クリーナー（Shorts 削除・コメント欄非表示・ライブチャット非表示・登録チャンネル拡張を含む 29 サブ機能）」「Amazon 定期おトク便 月別合計」「Instagram クリーナー（11 サブ機能）」「TikTok クリーナー（3 サブ機能：コメント欄非表示・おすすめのアカウント非表示・画像ダウンロードボタン）」「音量ブースター（マスタートグル付き・自動歪み防止 / 自動音量正規化 / ナイトモード サブトグル付き・ミュートトグル付き・設定グローバル永続化・タブ切替で自動適用）」「動画ガンマ補正（全タブ共通スライダー、SVG `<feComponentTransfer type="gamma">` 独自実装）」「ルーペ（マウス追従の円形拡大鏡、`chrome.tabs.captureVisibleTab` で取得した JPEG 静止画を `background-position` で追従表示、倍率 3 段階 / レンズサイズ可変）」「カラーピッカー（EyeDropper API ベース・popup 内完結）」。全 9 機能がマスタートグル付きオプトイン（**全てデフォルト OFF**）。画像ダウンロード機能は Instagram / TikTok の各クリーナーのサブ機能として共通実装（YouTube では未提供）。カラーピッカーは popup タブとして常時利用可（履歴は最大 20 件、`chrome.storage.local` 内のみで外部送信ゼロ）。すべての機能はクライアントサイド DOM/CSS 操作と Chrome 標準 API のみによる独自実装で、外部送信ゼロ。

popup は **5 タブ構成** (`調整 / YouTube / Instagram / TikTok / カラーピッカー`)。タブ順序は `PopupTabs.ALL` 配列で管理、`POPUP_LAST_TAB` storage key に最後のタブを永続化。

設定は `chrome.storage.local` の各 boolean / 数値キーで保存。UI は **Chrome i18n API でローカライズ**（ブラウザ UI 言語が `ja` → 日本語 / それ以外 → 英語にフォールバック）。`manifest.json` の `default_locale: "en"` + `_locales/{en,ja}/messages.json` を単一情報源とし、popup 静的テキストは `data-i18n` 属性、popup の動的テキストと content script の DOM 注入テキストは `chrome.i18n.getMessage()` 経由で取得する。コードコメント / `console.log` メッセージは開発者向けで日本語のまま残す。**インストール直後は全マスタートグル OFF**（音量ブースターもマスター OFF かつ全サブトグル OFF = 完全に無処理）。サイト挙動を勝手に書き換えないオプトイン方針。バージョン番号は `/vava` スキル経由でのみ更新する。

## Build Commands

```bash
npm install                  # 初回 / 開発用
npm run ci:install           # CI 用 (npm ci。lockfile 厳守)
npm run build                # アイコン + スクリーンショット一括生成
npm run generate-icons       # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
npm run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer, concurrency=2)
npm test                     # Node.js 標準 test runner、59 件（FEATURES 件数アサート + ALLOWED_HOSTS scontent- prefix + 音量ブースター 6 キー + Loupe pure function 群 + extractHandleFromHref の Unicode 境界値を含む）
powershell -ExecutionPolicy Bypass -File zip.ps1  # ストア申請用 ZIP (Windows、Unix は ./zip.sh)
```

## Development Workflow

### Chrome に未パッケージ拡張機能をロード
1. `chrome://extensions` を開く → デベロッパーモード ON
2. 「パッケージ化されていない拡張機能を読み込む」→ プロジェクトルートを選択
3. コード変更後は拡張機能カードの 🔄 リロードボタン
4. content script 変更時は対象タブを再読込、background SW 変更時は SW 再起動が必要

### JS 構文チェック / テスト
Lint は未導入。コード変更後は最低限以下を実行:

```bash
node --check src/lib/actions.js \
  && node --check src/popup/popup.js \
  && node --check src/background/background.js \
  && node --check src/content/early-framework.js \
  && node --check src/content/youtube-early.js \
  && node --check src/content/instagram-early.js \
  && node --check src/content/tiktok-early.js \
  && node --check src/content/youtube-shorts.js \
  && node --check src/content/search-fixer.js \
  && node --check src/content/keepalive.js \
  && node --check src/content/amazon-delivery-total.js \
  && node --check src/content/instagram-cleaner.js \
  && node --check src/content/tiktok-cleaner.js \
  && node --check src/content/video-gamma.js \
  && node --check src/content/loupe.js \
  && node --check src/content/image-downloader.js \
  && node --check src/offscreen/offscreen.js
```

```bash
npm test
```

### デバッグ
- popup: ポップアップ右クリック →「検証」で DevTools
- background SW: `chrome://extensions` の「Service Worker」リンク
- offscreen: `chrome://inspect/#other` で `chrome-extension://<id>/src/offscreen/offscreen.html` を開く
- content script: 対象タブの DevTools Console（ログ prefix `[WebViewingAssist]`）

## Architecture

3 つのレイヤが `chrome.runtime` メッセージパッシングで連携する。アクション定数は `src/lib/actions.js` で集中管理。

```text
Popup (src/popup/popup.{html,js,css})
  ──APPLY_SETTINGS──▶ Background (src/background/background.js)
                        │ storage 更新 +
                        ──APPLY_KEEP_ALIVE_CS / APPLY_SEARCH_FIXER_CS / APPLY_AMAZON_DELIVERY_TOTAL_CS / APPLY_INSTAGRAM_CLEANER_CS──▶
                          各 Content Script

[音量ブースター]
  Popup ──VOLUME_BOOSTER_SET_GAIN (gain, antiClip, normalize, nightMode)──▶ Background
                                    │ chrome.tabCapture.getMediaStreamId
                                    ──ACTION_VOLUME_SET_GAIN──▶ Offscreen Document
                                                                  │ getUserMedia + AudioContext
                                                                  │ source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination
                                                                  │ (短時間RMS正規化 → ナイトモード圧縮 → 手動ゲイン → リミッタ)
                                                                  └ 自動ゲイン補正 + 圧縮 + 増幅して再出力
```

### Popup (`src/popup/popup.html`, `src/popup/popup.js`, `src/popup/popup.css`)
5 タブ構成（調整 / YouTube / Instagram / TikTok / カラーピッカー）。**8 マスタートグル**（セッション維持 / YouTube クリーナー / Amazon 合計 / Instagram クリーナー / TikTok クリーナー / 動画ガンマ補正 / ルーペ / 音量ブースター）+ 音量ブースタースライダー（左端にミュート 🔊/🔇 ボタン）+ 音量サブトグル × 3（自動歪み防止 / 自動音量正規化 / ナイトモード）+ 動画ガンマスライダー（中央 1.0 = 補正なし、左 3.0 で暗く、右 0.3 で明るく）+ ルーペ倍率セグメント（1.5× / 2.5× / 4×）+ ルーペサイズスライダー（150〜1000px）+ 各クリーナー専用パネル × 3（YouTube クリーナー 29 機能 / Instagram クリーナー 11 機能 / TikTok クリーナー 3 機能）。Shorts 削除・コメント欄非表示は YouTube クリーナーのサブ機能（`removeShortsShelf` 等 / `hideComments`）として統合。幅 380px。トグル変更で即 `APPLY_SETTINGS` を background へ送信、設定は `chrome.storage.local` から復元（未設定時 false）。音量ブースターのマスタートグル OFF 時はスライダー・サブトグル・ミュートボタンを `.volume-disabled` で dim 化。ルーペ ON 時のみ倍率セグメント + サイズスライダーが表示される（`.sub-block.hidden` トグル）。

**クリーナーアコーディオン**: サブ機能行は **1 行 1 トグル + 説明文** の縦積みレイアウト。各機能の `desc` は `actions.js` の `SearchFixer.FEATURES` / `InstagramCleaner.FEATURES` を単一情報源として popup.js が動的にレンダリングする（FEATURES に追加するだけで UI 自動生成）。

**テーマ**: アクセントカラーは茜系（ライト `#C0605A` / ダーク `#df8983`）。`<meta name="color-scheme" content="light dark">` でネイティブ要素を `prefers-color-scheme` に追従させ、CSS は `:root` のライト用トークン + `@media (prefers-color-scheme: dark)` のダーク上書きの 2 層構造。色値はすべて CSS 変数経由でハードコードなし。CSP meta 明示。

**音量ブースター親トグル**: `volumeBoosterEnabled` (boolean) で master 制御。ON で `pushVolumeNow` → background へ `VOLUME_BOOSTER_SET_GAIN` 送信、OFF で `chrome.storage.local.set` のみ（background の `storage.onChanged` リスナーが `releaseAllVolumeBoosterTabs()` で全 AudioContext を解放）。**OFF でも gain / サブトグル設定は storage に残す**（次回 ON 時に復元）。

**音量スライダー / サブトグル**: input 時 120ms debounce → `VOLUME_BOOSTER_SET_GAIN`（`gain`, `antiClip`, `normalize`, `nightMode`）。change（マウスアップ）で即 push、100% に戻すボタンは `pushVolumeNow(100)` で release 経路へ。popup 起動時は `chrome.storage.local` の `volumeBoosterLastGain` からスライダー初期値を復元する（offscreen への round-trip 不要）。スライダー UI は 0..200 の内部値を使い、左端 0% / 中央 100% / 右端 300% の実音量へ変換する。マスター ON 時のみ popup open で即座に `pushVolumeNow` して active tab に適用。サブトグル (`volumeBoosterAntiClipEnabled` / `volumeBoosterNormalizeEnabled` / `volumeBoosterNightModeEnabled`) は change で `cancelVolumePush` → storage.set fire-and-forget → `pushVolumeNow(currentGain)` の順で即時反映（既存 AudioContext があれば自動ゲイン / compressor 状態だけ切り替わり音切れなし）。エラーは `formatVolumeError(res.error)` で日本語に翻訳。

### Background (`src/background/background.js`)
Service worker。役割:
1. **設定の集約と各 content script への配布**: `APPLY_SETTINGS` を popup から受信し、storage 保存と active tab 通知を行う。YouTube タブ / Amazon `auto-deliveries` タブ判定は URL パターンで行う。非マッチタブには receiver 不在で例外になるため `try/catch` でガード。
2. **Offscreen Document ライフサイクル管理**: `ensureOffscreenDocument()` で並行作成ガード、`scheduleOffscreenClose()` で 30 秒アイドル後に自動クローズ。**音量ブースト中タブが残っている間は close を再延期**（`isVolumeBoosterActive` で確認、SW 再起動直後は安全側に倒す）。`reasons` は `["USER_MEDIA", "AUDIO_PLAYBACK"]`。
3. **音量ブースター制御**: `setVolumeBoosterGain(tabId, gain, antiClip, normalize, nightMode, muted)` がエントリ。UNITY release 条件・既存 AudioContext 経路・自動ゲイン / compressor preset・ミュート時の gain ramp to 0 の詳細は Important Patterns 参照。
4. **音量ブースター自動適用**: `chrome.tabs.onActivated` で `autoApplyVolumeBooster(tabId)` を呼び出し。**既に boost 中のタブのみ**（`boostedTabIds.has(tabId)` ガード）が対象。新規タブは `tabCapture.getMediaStreamId` の user gesture 要件によりpopup open が必要。`chrome.storage.onChanged` で `volumeBoosterEnabled` が `false` になったら `releaseAllVolumeBoosterTabs()` で全 AudioContext を即座に解放（SW 再起動後 `boostedTabIds` が空の場合は offscreen に `ACTION_VOLUME_RELEASE_ALL` を直接送信するフォールバック経路あり）。
5. **Message Handler の sender 検証**: `SenderCheck.isFromPopup` / `isFromContentScript` ヘルパーで由来を検証。`APPLY_SETTINGS` / `VOLUME_BOOSTER_*` は popup 由来のみ受け付ける。
6. **タブクローズで自動 release**: `chrome.tabs.onRemoved` で `ACTION_VOLUME_RELEASE_TAB` を offscreen に送信(permission 不要、SW 再起動でも永続的に発火する)。
7. **設定マイグレーション**: `onInstalled` で旧キー削除 + 未設定キーの初期化（詳細は Important Patterns の「マイグレーション」を参照）。
8. **ルーペ用 captureVisibleTab**: content script からの `LOUPE_REQUEST_CAPTURE` を受け、`chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 })` を実行して JPEG DataURL を `sendResponse` で返す。`SenderCheck.isFromContentScript` で由来検証、sender.tab から targetTab を解決。Chrome 公式 2fps quota は content script の 500ms debounce で対応。

`chrome://`, `edge://`, `about:`, `file://` などの非 HTTP(S) ページにはメッセージ送信をスキップ（`content_scripts.matches` が `http(s)://*/*` のみのため）。

### Keepalive (`src/content/keepalive.js`)
全 http(s) ページのトップフレームに `all_frames: false` で注入される汎用 content script。役割:
1. `createKeepAlive` ファクトリで合成イベント dispatch + 同一オリジン HTTP ping ロジックを定義
2. ファイル末尾の IIFE ランナーが起動責任を持ち、`chrome.storage.local` の `keepAliveEnabled` / `keepAliveIntervalMs` を読み出して keeper を on/off
3. `chrome.runtime.onMessage` で `APPLY_KEEP_ALIVE_CS`、`chrome.storage.onChanged` で全タブ・全フレーム横断の同期を実装
4. `window.__cpaKeepAliveRunning` で同一フレーム二重実行を防ぐ

合成アクティビティは `mousemove` / `pointermove` / `scroll` / `focus` を `document` / `window` に dispatch（クリック / keydown は副作用が大きいため避ける）— **常時実行・副作用ゼロ**。**合成イベントは top frame のみで dispatch** する（`window !== window.top` で早期 return）。iframe 全部に撃ち続けると企業 DLP/SIEM が「ユーザー操作なしの mousemove 連発」をボット行動として検知するルールに引っかかりうるため、HTTP ping と同様の保守的な範囲に揃える。

HTTP ping は **`keepAliveHttpPingEnabled` storage key で別途オプトイン**（デフォルト OFF）。有効時のみ `KeepAlive.PRESET_ENDPOINTS`（SharePoint 等）の同一オリジン GET → 現在 URL に HEAD → origin root に HEAD のフォールバックを発射する。`credentials: "same-origin"` + `redirect: "manual"` で第三者ドメインへの認証情報送信を防ぎ（cross-origin 302 を opaqueredirect 応答で `ok: false` 扱い）、`AbortSignal.timeout(5000)` で永久 pending を防止。同一オリジン iframe は `shouldFireHttpPing()` で多重発射を回避。デフォルト OFF にしている理由は認証プロキシ環境（Zscaler 等）で 401/302 ループや SIEM ログアラートを誘発しうるため。

### Offscreen (`src/offscreen/offscreen.html`, `src/offscreen/offscreen.js`)
音量ブースター専用の extension-context ドキュメント。`chrome-extension://` は常に secure context のため `getUserMedia({ chromeMediaSourceId })` が動く。`audioStates` Map で tabId → `{ ctx, gainNode, normalizerAnalyzer, normalizerGainNode, normalizerBuffer, normalizerTimer, normalizeEnabled, normalizerTargetGain, nightModeNode, antiClipNode, stream, lastSetPercent }` を保持。6 ノードチェーンの構築・自動ゲイン更新・preset 切替・gain ramp の詳細は **Important Patterns 「音量ブースター・Offscreen」** を参照。release 時は normalizer timer 停止 → `stream.getTracks().stop()` → `ctx.close()` の順（逆順だと生きているソースから出力先消失でエラー）。`pagehide` で全 audioStates を cleanup。streamId は `typeof streamId !== "string"` の型チェックのみで `getUserMedia` に流す（過去に正規表現検証で誤拒否が出たため撤去）。`mandatory.chromeMediaSource = "tab"` 形式を先に試し、失敗時のみフラット `chromeMediaSourceId` にフォールバック。

### YouTube Shorts Removal (`src/content/youtube-shorts.js`)
`*://*.youtube.com/*` 限定の content_scripts エントリで `all_frames: false`（top frame のみ）に注入。`window === window.top` チェックで埋め込みプレーヤーには注入せず CPU 負荷を抑える。

**5 サブ機能 + 1 グローバル nav**: Shelf / Chip / Sidebar / Redirect / Btn の 5 サブ機能と「ホーム / Shorts / 登録チャンネル」global nav を 1 ファイルで担当。CSS は機能ごとに `__cpa-yt-shorts-hide-shelf` / `__cpa-yt-shorts-hide-chip` / `__cpa-yt-shorts-hide-sidebar` / `__cpa-yt-shorts-redirect-active` クラスを `<html>` に付け外し（per-feature 独立化、Codex P2 指摘で v1.0.18 にて分割済）。

**YouTube クリーナーへの統合**: 独立 storage key と独自メッセージは持たず、YouTube クリーナーのサブ機能として動作（`searchFixerFeatures.removeShortsShelf` / `removeShortsChip` / `removeShortsSidebar` / `redirectShortsUrl` / `removeShortsBtn`）。アクティブ判定は `searchFixerEnabled === true` AND 各 features フラグの AND。`APPLY_SEARCH_FIXER_CS` メッセージを search-fixer.js と共に購読する（同一 isolated world で同じメッセージを 2 ファイルが受けて、それぞれの責務に応じて反応する設計）。`storage.onChanged` は片方の key だけ変わった場合に備え、両 key を再取得してから `computeActive()` で判定する（変更されてないキーが undefined になる罠を回避）。

**サイドバー 多言語対応**: `aria-label="Shorts"` (英語) と `aria-label="ショート"` (日本語) を CSS selector に併記する。日本語ロケールの初期 flash を CSS で即時非表示にするため。`title` 属性も同様。

### YouTube クリーナー (`src/content/search-fixer.js`)
`searchFixerEnabled` (master) と `searchFixerFeatures` (オブジェクト) と `searchFixerGridItems` (数値: 0/4/5/6) の 3 キーで管理（変数名は履歴的に `searchFixer*` を使用）。29 機能の単一情報源は `actions.js` の `SearchFixer.FEATURES`。実装: top frame 限定で MutationObserver + `yt-navigate-finish` / `yt-navigate-start` イベントで onSettingsChanged を再実行（SPA navigation で CLASS_PROCESSED マーカーをリセットするため）。マスター OFF 時は observer / 注入 CSS / 装飾クラスをすべて停止。**Shorts 5 サブ機能の実装は search-fixer.js ではなく youtube-shorts.js が担当**（責務分離: SPA URL リダイレクト + サイト横断 DOM 削除は検索ページ限定の clean-up とは別レイヤ）。

**`hideComments` 実装上の注意**: `applyWatchPageClasses()` は `<html>` に `__cpa-sfx-hide-comments` クラスを付け外しする実装で、**`isWatchPage()` 判定を経由せず無条件に呼ぶ**こと。watch page 限定にすると SPA で video → home に遷移したとき `<html>` クラスが残置されて他ページに副作用が出る（CodeRabbit レビューで実際に指摘された罠）。CSS 側は `html.__cpa-sfx-hide-comments ytd-comments#comments { display: none !important; }` で watch page 以外には影響しないため、JS は無条件 toggle で良い。

**`hideLiveChat` 実装上の注意**: hideLiveChat の close 操作の本体はすべて JS 経由で行う。実装は `ytd-live-chat-frame` 配下の iframe (`youtube.com/live_chat_replay`) 内の `yt-live-chat-header-renderer #close-button button[aria-label="閉じる"]` を **`iframe.contentDocument` 経由で取得し**、`fireUserLikeClick` で **full pointer/mouse event sequence** (`pointerdown → mousedown → pointerup → mouseup → click`) を発火する。youtube.com same-origin かつ sandbox 制約なしなので contentDocument にアクセス可能。**frame・iframe・親 `#chat-container`・theater 用 `--ytd-watch-flexy-sidebar-width` には一切触らない**（過去にこれらを CSS や独自属性で操作するたびに player 再初期化 / レイアウト崩れ / 「動画を処理しています」エラー / 再展開不能などの副作用を起こした経緯。なお「動画を処理しています」自体は YouTube 側のタイミング bug だが、保守的に介入は避ける方針）。close button が見つからない場合は何もしない。MutationObserver は cross-document な iframe 内 DOM 変化を観察できないため、`iframe.addEventListener("load", ...)` を `__cpaLiveChatLoadAttached` marker で idempotent に hook し、load 後 50ms で `collapseLiveChatIfNeeded` を再実行することで close button が ready になったタイミングを取りこぼさない。fireUserLikeClick は `btn.ownerDocument.defaultView` 経由で iframe の window から `PointerEvent`/`MouseEvent` constructor を取得する（別 realm の event 扱いを避けるため）。

**hideLiveChat 体感ラグ消滅の先制非表示パターン**: 上記 click ベース実装は「公式 close button の hydration 待ち + click 発火」までの数百 ms、ライブチャット枠が完全展開状態で見えてしまう体感ラグがある。これを消すため、**`document_start` で `<html>` に `__cpa-sfx-hide-live-chat-pre` クラスを付け、CSS で `ytd-live-chat-frame { display: none !important }` を当てる先制非表示**を入れる (※当初 `visibility: hidden` で実装したが layout 領域 402×964 px が空白枠として 2 秒残る実機問題があり `display: none` に変更済み、詳細は手順 2 参照):

1. **`src/content/youtube-early.js`**: 新規 content_scripts エントリ（`*://*.youtube.com/*` / `run_at: document_start` / 単独エントリ）。actions.js は読み込まず生 storage key 文字列で書く最小スクリプト。**オプトアウト方式 + `<style>` inline 注入**: (a) `<style id="__cpa-sfx-early-hide-live-chat">` を `<html>` 直下に同期 prepend して CSS rule を即時 effective 化、(b) `<html>` に `__cpa-sfx-hide-live-chat-pre` を **同期で無条件付与**、(c) `chrome.storage.local` から `searchFixerEnabled` / `searchFixerFeatures` を非同期取得、(d) master OFF または hideLiveChat OFF or `/watch` 以外なら剥がす。**`<style>` inline 注入の理由**: search-fixer.css は manifest css 経由で挿入されるが、SPA navigation や frame DOM 追加タイミングによっては CSS rule の effective 化が paint cycle に間に合わないケースが Edge Trace で確認されたため、youtube-early.js 自身で CSS rule を確保する保険。**オプトアウト方式の理由**: オプトイン方式（storage 確認後に付与）だと `chrome.storage.local.get` の async 待ち（数十 ms）の間に frame が DOM 出現してチャット枠が一瞬見えてしまう実機問題があったため。OFF ユーザーには frame hydration 完了前 (数百 ms) に剥がし完了するので実質見えない
2. **`search-fixer.css`**: `html.__cpa-sfx-hide-live-chat-pre ytd-live-chat-frame { display: none !important; }` のみ。**当初 `visibility: hidden` を採用したが layout 領域 (402×964 px) が約 2 秒間空白枠として右側に残り「一瞬コメント欄が見える」と認識される実機問題があったため `display: none` に変更**。pre クラスは click 成功 / リトライ上限到達 / detach の 3 経路で必ず剥がされる設計なので、過去 NG だった `__cpa-sfx-live-chat-force-hide` の「永続 display:none」とは違い、数秒間だけ display:none → click 成功で剥がし → YouTube 公式 collapsed bar 表示、というフローになる。「動画を処理しています」エラーは YouTube 側のタイミング bug で CSS 介入とは無関係
3. **`search-fixer.js` の `syncLiveChatCollapse`**: 入口で `<html>.classList.add(LIVE_CHAT_PRE_HIDE_CLASS)`（初回直アクセスは youtube-early.js が付与済みなので idempotent）
3.5. **`search-fixer.js` の `onNavigationStart`**: `yt-navigate-start` で `hideLiveChat` ON のとき pre クラスを **先制付与**。理由: yt-navigate-finish 後の syncLiveChatCollapse まで待つと、その間に YouTube が SPA で再利用される frame を expand 状態に戻す瞬間が paint されて「一瞬見える」現象が Edge の Performance Trace で確認されたため。副作用: hideLiveChat OFF や watch 以外のページでも一瞬 pre クラスが付くが、frame が無いページは CSS rule マッチ無しで副作用ゼロ、frame あり OFF ページは syncLiveChatCollapse で OFF 判定で剥がされる
4. **`search-fixer.js` の `collapseLiveChatIfNeeded`**: click 成功 *直後* には pre クラスを剥がさず `schedulePreHideRelease()` で **frame に `collapsed` 属性が付くまで rAF polling** してから `clearLiveChatPreHide()`。理由: click 直後に剥がすと YouTube が collapsed transition を DOM 反映する前に display:none が解除され、frame default expand state が paint されてしまう (Edge 動画キャプチャで約 270ms expand 表示を確認)。タイムアウト 30 フレーム (≈500ms) で fallback 剥がし
5. **`search-fixer.js` の `detachLiveChatObserver`**: hideLiveChat OFF / 別ページ遷移時にも pre クラス削除（class 残置で「機能 OFF 後も枠が見えない」バグ防止）
6. **`search-fixer.js` の `scheduleLiveChatCollapseRetry` 上限到達分岐**: fail-safe で pre クラス削除（live chat なし動画 / hydration 異常で永遠に click 成功しない場合に備え、frame を永久に隠したままにせず元 UI を見せる）
7. **delay 短縮**: iframe load 後 delay は **300ms → 50ms**、リトライバックオフは **[200, 600, 1500] → [50, 200, 800]** に短縮（pre クラスで見た目はすでに隠れているため、hydration 完了次第すぐ click → 公式 collapsed bar 表示、を最速化）

**復活禁止の失敗パターン**: 詳細列挙は本ドキュメント末尾の Important Patterns「hideLiveChat（YouTube ライブチャット非表示）」を参照。要約すると `display:none` / `height:0` / `setAttribute("collapsed")` / `#chat-container:has(...){display:none}` / 独自クラスでの frame 全体非表示はすべて NG（SPA panel state を破壊して player 副作用 / 「パネルを開く」消失 / 再展開不能になる）。`visibility:hidden` は layout のみへの影響で Polymer state に介入しないため安全。

**登録チャンネル拡張（v1.0.27 で完成）**: 3 機能セットで構成される。
1. **`subsChannelsGrid`**: `/feed/channels` をレスポンシブグリッドに変形 + 検索ボックス。各カードは IntersectionObserver で viewport 進入時 lazy fetch でチャンネルページ HTML から最初の `"videoId":"..."` (Featured 動画) を抽出して `https://i.ytimg.com/vi/{videoId}/maxresdefault.jpg` (16:9, 1280x720) を表示。404 で `mqdefault.jpg` (320x180, 16:9) フォールバック。`sessionStorage` に handle 単位 24h cache (prefix `__cpa_subs_thumb_v5::`)。**サムネ取得は YouTube が `/feeds/videos.xml` を 404 化したため HTML 内 videoId 抽出方式に切替済（v1.0.27）**。
2. **`subsLeftnavInjectAll`**: YouTube が表示上限で隠す登録チャンネルも全件 leftnav に inline 注入。`/feed/channels` から同一オリジン取得、24h cache。`#items` の中（Polymer dom-repeat 配下）に `<a>` を直接 inject する安全パターン。
3. **`subsAllShortcut`**: `/feed/channels` への 1 クリックエントリを「登録チャンネル」section の `#items` 内、最初のチャンネル entry の直前に entry エントリ風（高さ 40px / icon 24px / text 72px 位置）で挿入し、公式メニューの一部に見せる。

**sort dropdown 関連の補正コードは入れない (再発禁止)**: 1 回目 sort 切替で label rollback / 「新しいアクティビティ」再選択で並び戻らない / 2 回目以降の挙動などは **YouTube 側 bug で extension では補正不能**。実機検証 (extension OFF/ON 比較) で確定済み。cooldown / click capture / popup-closed listener / scan gate / observer scoping は **逆効果**でしかなかったため全撤去 (v1.0.27)。

### 動画ガンマ補正 (`src/content/video-gamma.js`)
全 http(s) ページに `all_frames: true` で注入される content script。`videoGammaEnabled` (master) + `videoGammaValue` (数値 0.3〜3.0、初期 1.0) で管理。SVG `<feComponentTransfer type="gamma">` ベースの独自実装で、CSS `filter: url(#__cpa-video-gamma)` を `<video>` 要素に当てて全タブ共通のガンマ補正を適用する。スライダーは中央 (1.0) が補正なし、左に動かすほど暗く（最大 3.0）、右に動かすほど明るく（最小 0.3）。iframe 内の `<video>`（YouTube 埋め込み等）にも `all_frames: true` で同じ補正が当たる。動画データの読み取りや保存は行わない（filter 適用のみ）。

### ルーペ (`src/content/loupe.js` + `src/content/loupe.css`)
全 http(s) サイトの top frame に注入される独立機能。`loupeEnabled` (master) + `loupeZoom` (1.5/2.5/4.0、初期 2.5) + `loupeSize` (150〜1000px、step 10、初期 220) の **3 storage key** で管理。`chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 70 })` で active tab の静止画を取得し、`position: fixed; clip-path: circle()` の円形レンズ DOM に `background-image` として貼り付け、`mousemove` から `background-position` を rAF コアレス 60fps で更新する。倍率は popup のセグメントコントロールから 3 段階で選択、レンズサイズは popup のスライダーで可変。動画 / iframe / canvas を含む描画ピクセルを captureVisibleTab で取得するため「動画を一時停止してから細部を確認」する用途に最適。**popup で master トグルを ON にすると popup が自動クローズする** (ON 状態だと popup 自体がレンズで拡大したい領域を隠す UX 問題を回避、`setTimeout(50)` で APPLY_SETTINGS message dispatch を完了させてから close)。

**処理フロー**:
1. popup でマスタートグル ON → `APPLY_SETTINGS` → background → `notifyContentScripts` → `APPLY_LOUPE_CS` を top frame に送信
2. content script: `activate()` → DOM 構築 + リスナー登録 → `requestCaptureAndUpdate()` で background に `LOUPE_REQUEST_CAPTURE` 送信
3. background: `chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: Loupe.CAPTURE_QUALITY })` → JPEG DataURL を `sendResponse`
4. content script: DataURL を `fetch` 経由で Blob URL 化 → `lensEl.style.backgroundImage = url(blobURL)` で表示
5. mousemove: `Loupe.computeLensPosition` + `Loupe.computeBackgroundPosition` で座標計算 → rAF コアレスで描画
6. 再キャプチャ: scroll (500ms debounced) / MutationObserver(childList, subtree:false) / resize で `scheduleRecapture()` → `requestCaptureAndUpdate()` 再実行
7. 左クリック / master OFF / visibilitychange / storage.onChanged(loupeEnabled:false) で `deactivate()` → DOM 撤去 + リスナー解除 + `URL.revokeObjectURL` で Blob URL 解放

**設計上の不変条件** (Important Patterns 「ルーペ」セクション参照):
- `captureInFlight` + `pendingRecapture` フラグで重複リクエスト防止 (同時 capture は 1 つまで、進行中の trigger は後追い実行)
- Blob URL は cleanup 時に必ず revoke (DataURL は revoke 不可なので Blob URL に変換する設計)
- top frame 限定 (`window === window.top` ガード + manifest `all_frames: false`)
- MutationObserver は `subtree: false` で body 直下のみ監視 (SPA top-level navigation 検知に十分、深い tree の頻発変化を避ける)
- 左クリック OFF は `capture: true` で document level listener、サイト側 click より先に stopPropagation して副作用を防ぐ
- 倍率 / サイズ変更は popup → storage 直書き → content script の `storage.onChanged` で同期 (background の `normalizeSettings` を経由しない、音量ブースター直書きパターンと同型)
- タブ切替時 (`visibilitychange` で hidden 検知) は cleanup する (古い画面が新タブで残らないようにする、音量ブースターの「既存 boost 中タブのみ自動適用」とは意図的に異なる UX)
- 再キャプチャ debounce 500ms は `chrome.tabs.captureVisibleTab` の Chrome 公式レート上限 (2fps = 500ms 周期) と一致させる安全値

### Amazon 定期おトク便 月別合計 (`src/content/amazon-delivery-total.js`)
`*://www.amazon.co.jp/auto-deliveries*` 限定。`amazonDeliveryTotalEnabled` (boolean) で master 制御。Amazon の DOM 構造（`[data-delivery-type]` セクションと `.subscription-price` 価格表示）に基づく独自実装で、配送月ごとの合計を計算してページに挿入する。

**フリーズ対策**: 旧実装は `MutationObserver(subtree: true)` 監視中に自身が `target.append(root)` / `priceEl.textContent = ...` で DOM を書き戻すと再発火 → 再 render → 無限ループでブラウザがフリーズする問題があった。修正版は **rAF coalesce + observer disconnect / takeRecords / reconnect ガード** パターン:
1. `scheduleRender()` を `requestAnimationFrame` で 1 フレームに 1 回に圧縮
2. `runRenderInsideObserverGuard()` 内で `observer.disconnect()` → `renderAllTotals()` → `observer.takeRecords()`（蓄積分を破棄）→ `observer.observe()` で再接続
3. `priceEl.textContent` は変化時のみ更新（同じ文字列の再代入でも `MutationRecord` は積まれるため）

**動作対象**: top frame 限定、`[data-delivery-type]` セクションの `.subscription-price` を `/\D/g` で数値化して合計、各セクションの `.a-fixed-left-grid-col` に `__cpa-amzn-delivery-total` クラスのルート要素を append。OFF 時は observer 切断 + 既存挿入要素を全部撤去（撤去操作も同じ guard 経由）。

### Instagram クリーナー (`src/content/instagram-cleaner.js` + `src/content/instagram-cleaner.css`)
`*://*.instagram.com/*` 限定の content_scripts エントリで `all_frames: false`（top frame のみ）に `run_at: document_idle` で注入。`window.__cpaInstagramCleanerRunning` で二重実行防止。`instagramCleanerEnabled` (master) + `instagramCleanerFeatures` (オブジェクト) の 2 キーで管理。11 機能の単一情報源は `actions.js` の `InstagramCleaner.FEATURES`。

**run_at 注意**: 最初の content_scripts エントリ（`http(s)://*/*` で `actions.js` を含む）が `document_idle` のため、Instagram エントリも揃えないと「`InstagramCleaner is not defined`」エラーになる。Chrome は `run_at` が違うと早い方を先に評価するので、`document_start` を指定すると `actions.js` 未ロード状態で走ってしまう。CSS は manifest の `css:` 配列で別経路で document_start に近いタイミングで注入されるため、JS を idle にしても見た目への影響は小さい。

Instagram の冗長 UI（Reels / Explore / Stories / Threads / いいね数 / 動画 / コメント / Notes / メッセージカウンター）を非表示にする独自実装。クリーンアップ目的に機能を絞っており、寄付ボタン UI 注入・多言語ローカライズ・フォント変更・グレースケール / 正方形化等は実装しない。

**実装パターン**:
1. **body クラスベースの CSS 駆動**: `applyBodyClasses()` で `<html>` に `__cpa-ig-{reels,explore,stories,...}` クラスを付け外し。CSS 側は各セレクタを `html.__cpa-ig-XXX` で prefix し、クラスが付いていないときは完全に不活性化する
2. **DOM スイープ (300ms ポーリング)**: `block_videos` 機能では `<article>` 内 `<video>` を検出 → 親に `__cpa-ig-article-video` マーカーを付与 → CSS でサムネ差し替え。`vanity` 機能では `<article>` 内 `<button>` の innerText が純粋な数値表現（カンマ・小数点・k/M/万 単位等）にマッチする場合に `__cpa-ig-hide-counter` マーカーを付ける
3. **URL リダイレクト (300ms ポーリング)**: `reels` / `explore` / `storiesAll` 機能が ON のとき、対応する URL パスでホーム `/` に `location.assign("/")`。SPA の history hook より単純で確実
4. **master OFF 時の cleanup**: domSweepTimer / urlGuardTimer を停止し、付与済みマーカークラスをすべて剥がして元の Instagram UI に戻す

**CSS セレクター戦略**: Instagram の難読化 class 名（`.x9f619` 等）は build ごとに変わるため**意図的に避け**、`aria-label` / `href` / `role` / `data-pagelet` / SVG path data などの意味論的属性のみで構成する。例: Reels は `a[href="/reels/"]` + `aria-label="Reels"` + 日本語ロケール用 `aria-label="リール"` + SVG path data の 4 重に重ね、どれか 1 つでもヒットすれば隠れる構造。

### TikTok クリーナー (`src/content/tiktok-cleaner.js` + `src/content/tiktok-cleaner.css` + `src/content/tiktok-early.js`)
`*://*.tiktok.com/*` 限定の content_scripts エントリ。Instagram クリーナーと同じ master + FEATURES の 2 段構造 (`tiktokCleanerEnabled` / `tiktokCleanerFeatures`)、ただし機能は **3 つ** (`hideComments` / `hideSuggested` / `imageDownload`)。

**実装パターン**:
1. **CSS-only body クラス駆動** — `applyBodyClasses()` で `<html>` に `__cpa-tt-comments` / `__cpa-tt-suggested` を toggle するだけ。Instagram の structural triple-gate detection や URL リダイレクトなど複雑処理は不要
2. **early エントリ (document_start) で FOUC 防止** — `tiktok-early.js` が同期で `<style>` を `<html>` 直下に注入 + pre クラス無条件付与（オプトアウト方式）→ `chrome.storage.local.get` で OFF 時のみ剥がす。actions.js 非依存
3. **idempotent ガード**: `window.__cpaTikTokCleanerRunning` / `window.__cpaTtEarlyRunning`

**CSS セレクタ戦略 (TikTok の DOM 2 系統)**: 同じ photo / video コンテンツでも 2 つの異なるレイアウトがあり、両系統を CSS rule で網羅する必要がある。

#### A. photo / video の直接 URL アクセス (`/@user/photo/...` 直接)
- 右側パネル `[class*="RightPanelContainer"]` に「コメント / あなたにおすすめ」の **2 タブを同居**
- `tiktok-XXX-7937d88b--RightPanelContainer` のハッシュ部分は build ごとに変わるので **`*=` contains マッチ** で吸収
- セレクタ: `html.__cpa-tt-comments [class*="RightPanelContainer"]`, `html.__cpa-tt-suggested [class*="RightPanelContainer"]`
- **「シンプル方式」採用**: hideComments / hideSuggested いずれか ON で右パネル全体非表示（コメント + あなたにおすすめ両方）。CSS で個別タブ非表示は `:contains()` 不在のため不可、JS マーカー方式は overengineering と判断（ゆろさん承認 2026-05-09）

#### B. modal viewer / Browser Mode (ユーザーページ → サムネクリック)
- `[class*="DivBrowserModeContainer"]` がモーダル全体 (2040x1020)
- 内部は左 = `DivVideoContainer` (1496x1020) / 右 = `DivContentContainer` (544x1020) の 2 column
- 右 column の中に `DivProfileWrapper` (308 height = プロフィール + キャプション) + `DivCommentListContainer` (935 height = コメントリスト) が縦並び
- セレクタ: `html.__cpa-tt-comments [class*="DivCommentListContainer"]` で **コメントリストのみピンポイント非表示**。`DivCommentContainer` 全体だとプロフィール / キャプションも消えるので使わない
- modal viewer 内の data-e2e は `browse-` prefix が付く (`browse-comment-icon` / `browse-comment-count` / `browse-user-avatar`)。photo / video 直接アクセス時の prefix 無し版 (`comment-icon` / `comment-count`) と CSS に併記

**意味論セレクタのみ**: 難読化 class (`tiktok-XYZ-7937d88b--*` のハッシュ部) には依存しない。`[class*="..."]` の安定 marker word (RightPanelContainer / DivCommentListContainer / DivBrowserModeContainer 等) と `data-e2e` 属性のみ使用。

**復活禁止の失敗パターン**:
- `[data-e2e="browse-comment"]` / `[data-e2e="comment-list"]` / `[data-e2e="comment-item"]` 直接マッチ → TikTok 現行 DOM には存在しない属性
- 単純 `[data-e2e="recommend-list-item-container"]` 一律非表示 → 通常動画も巻き込んで全消し
- modal viewer で `DivCommentContainer` 全体非表示 → プロフィール + キャプション巻き込み

### 音量ブースター (`src/offscreen/offscreen.js` の Volume Booster 部分)
Chrome の標準 API（`chrome.tabCapture.getMediaStreamId` + `getUserMedia` + AudioContext + AnalyserNode + GainNode + DynamicsCompressorNode × 2）のみを使ったタブ音声補正 + 増幅の独自実装。Equalizer や音質変更は持たず、自動音量正規化は短時間RMS測定 + 自動 GainNode、ナイトモード / 自動歪み防止は DynamicsCompressorNode で実装する。`volumeBoosterEnabled` (master) + `volumeBoosterLastGain` (数値 0〜300、初期 100) + `volumeBoosterAntiClipEnabled` / `volumeBoosterNormalizeEnabled` / `volumeBoosterNightModeEnabled` / `volumeBoosterMutedEnabled` の **6 storage key** で管理。全設定はグローバル永続化（タブ間共通）。マスター OFF は AudioContext 解放のみで設定値は保持。**ミュートは boost パイプライン経由の独立レイヤ**で Chrome 標準のタブミュートとは共存（両方 ON なら二重消音、片方解除でも他方が残っていれば無音継続）。

**処理フロー**:
1. popup でスライダー / サブトグル / ミュート操作 → 120ms debounce（ミュートは即時）→ `VOLUME_BOOSTER_SET_GAIN`（`tabId`, `gain`, `antiClip`, `normalize`, `nightMode`, `muted`）。**マスター OFF 時は `pushVolumeNow` が早期 return**（background に送信しない）
2. background: gain が UNITY かつ全サブトグル OFF かつミュート OFF なら `releaseVolumeBoosterTab` で AudioContext 解放して終了。それ以外は `chrome.tabCapture.getMediaStreamId({ targetTabId })` で MediaStream ID 取得（既存 AudioContext があれば streamId なしで gain / 自動ゲイン / preset / mute だけ更新）
3. background → offscreen: `ACTION_VOLUME_SET_GAIN`（`tabId`, `streamId`, `gain`, `antiClip`, `normalize`, `nightMode`, `muted`）
4. offscreen: 未登録タブなら `getUserMedia` → `source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination` の 6 ノード接続。登録済みなら GainNode を `setTargetAtTime` で 45ms ramp（`muted=true` のときは percentToGain を無視して 0 にランプ、`lastSetPercent` はユーザーが意図したスライダー値を保持）、正規化 timer の開始/停止、各 DynamicsCompressor のパラメータ切替
5. **タブ切替で自動適用**: `tabs.onActivated` → `autoApplyVolumeBooster(tabId)` → **`boostedTabIds` に既登録のタブのみ**が対象（既存 AudioContext があるので `getMediaStreamId` 不要で user gesture 制約に引っかからない）。新規タブへの初回適用は popup open が必要（popup open 自体が user gesture）
6. **ミュート UI**: popup の音量スライダー左にトグルボタン（🔊/🔇、`aria-pressed` ベース）。ミュート ON 中もスライダー値は last gain 位置のまま表示・操作可能で、ユーザーは「ミュート維持のままスライダー値を変更 → ミュート解除で意図した音量に復帰」できる

ノード順序・対数マッピング・gain ramp・compressor preset・UNITY release 条件などの**設計上の不変条件は Important Patterns「音量ブースター・Offscreen Document」に集約**。数値の単一情報源は [`src/lib/actions.js`](src/lib/actions.js) の `VolumeBooster` 定数 — ドキュメントとコードに齟齬が出たら必ずコードを正とすること。

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 設定; permissions: `activeTab`, `storage`, `offscreen`, `tabCapture` |
| `src/lib/actions.js` | `Object.freeze` された 17 個の定数を IIFE wrap + globalThis 公開: Actions / ExtensionPaths / SenderCheck / Offscreen / StorageKeys / KeepAlive / YouTubeShorts / SearchFixer / AmazonDeliveryTotal / InstagramCleaner / TikTokCleaner / ImageDownloader / VolumeBooster / VideoGamma / Loupe / ColorPicker / PopupTabs |
| `src/background/background.js` | Service worker: sender 検証付きメッセージ転送、設定マイグレーション、offscreen document 管理、音量ブースター制御 |
| `src/content/keepalive.js` | 合成アクティビティ + 同一オリジン HTTP ping ポーラー（top + cross-origin iframe）+ 起動ランナー |
| `src/content/early-framework.js` | document_start early script 共通フレームワーク。`<style>` 注入 / pre クラス同期付与 / `storage.local.get` / `storage.onChanged` 購読を `window.__cpaEarlyFramework.setup(config)` に集約。各 early エントリで先頭ロード、actions.js には依存しない |
| `src/content/youtube-early.js` | YouTube watch ページ向け `document_start` 注入の最小スクリプト。hideLiveChat ON 時に `<html>` へ `__cpa-sfx-hide-live-chat-pre` クラスを最速付与し、ライブチャット枠の体感ラグを消す。early-framework.js 経由でボイラープレート共通化、サイト固有の MutationObserver / force-hide のみ独自実装 |
| `src/content/youtube-shorts.{js,css}` | YouTube クリーナーの Shorts 5 サブ機能（Shelf / Chip / Sidebar / Redirect / Btn、top frame のみ）: MutationObserver + URL リダイレクト + 機能ごとの `__cpa-yt-shorts-hide-{shelf,chip,sidebar}` / `__cpa-yt-shorts-redirect-active` クラスで `display: none` |
| `src/content/search-fixer.{js,css}` | YouTube クリーナー（29 機能 = 検索結果ノイズ除去・Shorts 5 サブ機能・動画ページ整形・グリッド列数・登録チャンネル拡張 3 機能を含む）: master + features + gridItems で駆動、`/feed/channels` グリッド化 / leftnav 全件展開 / すべての登録チャンネルショートカットを含む |
| `src/content/amazon-delivery-total.{js,css}` | Amazon 定期おトク便ページ: 月別合計を rAF coalesce + observer guard 駆動で挿入 + `__cpa-amzn-delivery-total` 配色 |
| `src/content/instagram-early.js` | Instagram 向け `document_start` 注入の最小スクリプト。hideComments ON 時に `<html>` へ `__cpa-ig-comments-pre` クラスを最速付与し、`div:has(> ul._a9ym)`（各コメント UL の親 div）を CSS rule + MutationObserver inline force-hide で先制非表示にする。`_a9z6`（外側 UL）には post caption が同居しているので触らず、`_a9ym` 親 div だけを対象にして caption 巻き込み防止（actions.js は読み込まない） |
| `src/content/instagram-cleaner.{js,css}` | Instagram クリーナー: master + features で body クラス駆動、URL リダイレクト + DOM スイープ + 意味論的セレクタのみ（aria-label / href / role / data-pagelet / SVG path data） |
| `src/content/tiktok-early.js` | TikTok 用 `document_start` 注入の最小スクリプト。`tiktokCleanerEnabled` + `tiktokCleanerFeatures` を読んで `<html>` に `__cpa-tt-comments` / `__cpa-tt-suggested` 同期付与 + inline `<style>` で主要セレクタ焼き込み（FOUC 防止、actions.js 非依存） |
| `src/content/tiktok-cleaner.{js,css}` | TikTok クリーナー: master + features で body クラス駆動、CSS-only 実装（DOM スイープ / URL リダイレクト不要）。photo / video 用 `[class*="RightPanelContainer"]` + modal viewer 用 `[class*="DivCommentListContainer"]` の 2 系統セレクタ併用 |
| `src/content/video-gamma.js` | 動画ガンマ補正: 全 http(s) + iframe に注入、SVG `<feComponentTransfer type="gamma">` を `<body>` に inject + CSS `filter: url(#...)` で `<video>` に適用 |
| `src/content/loupe.{js,css}` | ルーペ機能: 全 http(s) の top frame に注入、`chrome.tabs.captureVisibleTab` で取得した JPEG 静止画を `position: fixed` 円形レンズに `background-image` で貼り、mousemove で `background-position` を rAF コアレス 60fps 更新。再キャプチャ trigger は初回 / scroll (500ms debounced) / MutationObserver(childList, subtree:false) / resize。Blob URL に変換して `<img>`/`background-image` で参照し cleanup 時に `URL.revokeObjectURL` で確実に解放 |
| `src/content/image-downloader.{js,css}` | 画像ダウンロード（Instagram / TikTok 共通、YouTube は未提供）: 各クリーナー features の `imageDownload` ON 時に動作。site adapter で各サイトのコンテンツ画像（投稿写真 / 動画サムネ）を判定 → hover で左上に DL ボタン overlay → クリックで `<a download>` + Blob URL 経由で保存。最大解像度 URL 取得 / URL ホワイトリスト ALLOWED_HOSTS / fetch セキュリティ 4 原則 / sibling overlay 検出による host 1 階層上昇 / SCANNED マーカー src 値ベース。`__cpa-img-dl-` クラスプレフィックス。 |
| `src/popup/popup.{html,js,css}` | ポップアップ UI: 5 タブ構成（調整 / YouTube / Instagram / TikTok / カラーピッカー）。調整タブは 4 トグル + 音量スライダー（左端 🔊/🔇 ミュートボタン）+ 音量サブトグル × 3 + 動画ガンマスライダー + ルーペ master + 倍率セグメント + サイズスライダー、各クリーナータブは独立パネル（FEATURES 配列駆動の動的レンダリング、1 行 1 トグル + 説明文）、カラーピッカータブは EyeDropper 採取 + HEX/RGB/HSL 表示 + format chips + 履歴グリッド。設定保存・復元、適用フィードバック、ダーク/ライト追従、IBM Plex Sans JP サブセット同梱 |
| `src/offscreen/offscreen.{html,js}` | 音量ブースター専用 offscreen document: AudioContext + AnalyserNode + 自動 GainNode + 手動 GainNode + DynamicsCompressor × 2 (night mode / anti-clip) で正規化 + 増幅 + 圧縮 |
| `icons/icon.svg` | ソースアイコン (512×512); PNG は `icons/icon-{16,48,128}.png` に生成 |
| `webstore/` | ストア申請用: HTML テンプレート、生成画像、`store-listing.txt`。`generate-screenshots.js` が popup.html から `popup-render.html` + `popup-shim.js` を動的生成 → `01-popup-ui.html` が iframe で実 popup を埋め込んで撮影（drift ゼロ）。生成物 `popup-render.html` / `popup-shim.js` は .gitignore 対象 |
| `zip.ps1` / `zip.sh` | ストア申請用 ZIP パッケージ生成 (Windows / Unix) |
| `docs/privacy-policy.md` | プライバシーポリシー |
| `test/actions.test.js` | 純粋関数テスト 59 件: globalThis 17 個公開 / **FEATURES 件数アサート (SearchFixer 29 / IG 11 / TT 3)** / mergeFeatures / ImageDownloader.isAllowedFetchUrl (Instagram fbcdn は scontent- prefix 限定 / TikTok / YouTube 廃止) / detectHost / buildFilename / **Loupe.validateZoom / clampSize / computeLensPosition / computeBackgroundPosition / formatLoupeError 境界値** / **SearchFixer.extractHandleFromHref の ASCII + Unicode + URL encoded 境界値** 等。件数 drift を CI で検知できる単一情報源 |
| `.github/workflows/publish.yml` | `push: branches: release/**` トリガーで Chrome Web Store に Draft 自動アップロード。OAuth Bearer Token を curl で取得し `token_response` / `access_token` 両方を `::add-mask::` 登録してから upload。**Draft only** で自動公開しない設計（Dashboard で listing 確認後に手動公開） |
| `memory-bank/WebRestrictionRemoval/*.md` | プロジェクト横断の長期記憶（projectbrief / productContext / systemPatterns / techContext / activeContext / progress の 6 コアファイル）。activeContext と progress は頻繁更新、systemPatterns は設計パターン履歴。**ホスト側ファイルを直接 Read/Edit せず必ず memory-bank-mcp 経由で操作** |

## Important Patterns

新機能追加・既存機能の改修で踏むべき原則と、過去にハマった罠の対策。詳細はファイル冒頭コメントと該当セクションを参照。

### 設計の起点
- **`src/lib/actions.js` は単一情報源** — 新機能追加は actions.js から手をつける。Actions / StorageKeys / 機能 FEATURES 配列がここに集約され、popup の動的レンダリング → background の dispatch → content script の購読が全てここの定数を参照する。FEATURES に追加すれば popup UI は自動生成される。actions.js は古典的グローバル定数方式（ES modules ではない）で 4 経路で共有: ① background の `importScripts()`、② manifest content_scripts の最初のエントリで全 http(s) フレームに自動注入、③ popup.html の `<script>` タグ、④ offscreen.html の `<script>` タグ。
- **バージョン番号は手動で書き換えない** — `manifest.json` / `package.json` / `package-lock.json` の `version` フィールドおよびドキュメント中の `v1.x.y` 表記は `/vava` スキル経由でのみ更新する。コード変更コミットでバージョン番号には触れない。
- **デフォルト OFF 方針徹底** — 8 マスタートグル（セッション維持 / YouTube クリーナー / Amazon 合計 / Instagram クリーナー / TikTok クリーナー / 動画ガンマ補正 / ルーペ / 音量ブースター）が `onInstalled` で false 初期化、復元は `=== true` で防御的に判定。音量ブースターはマスター OFF に加え、ON でも「スライダー 100% かつ全サブトグル OFF かつミュート OFF」のときリソース解放される（インストール直後はマスター OFF かつ全サブトグル OFF = 完全に無処理）。ルーペもマスター OFF で content script 内の DOM / リスナーがすべて撤去される（Blob URL も revoke）。

### メッセージング・content script
- **sender 検証必須** — background の各ハンドラ冒頭で `SenderCheck.isFromPopup()` / `isFromContentScript()` を呼ぶ。新メッセージ追加時はどちらの由来を許可するか明示。
- **content_scripts の二重ロード許容** — `actions.js` は **各 content_scripts エントリで個別にロード** する（manifest.json の各エントリの `js` 配列冒頭に含める）。同一 isolated world で複数回ロードされても `__cpaActionsLoaded` ガード (`src/lib/actions.js` 冒頭) で 2 回目以降は即 return するため、定数二重宣言エラーを起こさず安全。これにより各サイトエントリの実行順序や `run_at` 差異に依存せず、`actions.js` 依存を持つ全 content script が確実に `Actions` / `StorageKeys` 等の定数を参照できる。**例外: `document_start` 専用 early script (`youtube-early.js` / `instagram-early.js` / `tiktok-early.js`) は actions.js を含めない** (最速注入のため、生 storage key 文字列で書く)。
- **`document_start` 専用エントリは actions.js を読み込まない** — youtube-early.js のように `document_start` で走るエントリは、actions.js 依存（`StorageKeys` 等）を持たず生 storage key 文字列で書く。理由: `document_start` 注入と `document_idle` 注入は別エントリ扱いだが、同一 isolated world で同じ `const` を二重宣言すると SyntaxError になる。最小スクリプト + actions.js 非読込で衝突を防ぐ。
- **early script は共通フレームワーク経由** — `src/content/early-framework.js` が `<style>` 注入・pre クラス同期付与・`chrome.storage.local.get`・`storage.onChanged` 購読のボイラープレートを集約する (`window.__cpaEarlyFramework.setup(config)`)。各 document_start エントリの `js` 配列で `early-framework.js` を **先頭** に置き、各 early script (`youtube-early.js` / `instagram-early.js` / `tiktok-early.js`) が config を渡して setup を呼ぶ。新サイトの early script を追加する場合もこのパターンに乗せる。サイト固有の MutationObserver / force-hide / URL redirect は各 early script に残す (差異が大きすぎて framework に押し込むと config 肥大化する)。
- **二重実行防止** — `window.__cpaKeepAliveRunning` / `window.__cpaSearchFixerRunning` / `window.__amazonDeliveryTotalRunning` / `window.__ytShortsRemoverRunning` / `window.__cpaInstagramCleanerRunning` / `window.__cpaTikTokCleanerRunning` / `window.__cpaImageDownloaderRunning` / `window.__cpaVideoGammaRunning` / `window.__cpaLoupeRunning` / `window.__cpaYtEarlyRunning` / `window.__cpaIgEarlyRunning` / `window.__cpaTtEarlyRunning` のグローバルフラグで同一フレーム内の二重実行を防ぐ。新 content script を足すときも同じ命名で揃える。`__amazonDeliveryTotalRunning` のみ `__cpa` プレフィックスなしの歴史的命名 (互換性のため変更しない)。
- **iframe 多重対策** — keepalive は `shouldFireHttpPing()` でトップフレーム or クロスオリジン iframe のみ ping を発射。同一オリジン iframe はトップに任せる。

### MutationObserver 取り扱い
- **DOM 書き戻しは observer guard 必須** — `subtree: true` 監視中に自身が DOM を書き戻すと再帰発火 → 無限ループでフリーズ。Amazon 月別合計の修正で確立した **`disconnect → render → takeRecords → observe` ガード + `requestAnimationFrame` coalesce** の二重防御を新規 DOM 書き込みロジックでも踏襲する。
- **cross-document な iframe 内 DOM 変化は MutationObserver で観察できない** — `subtree: true` でも iframe の中身は別ドキュメント扱いで届かない。iframe 内要素を相手にする場合は `iframe.addEventListener("load", ...)` で再評価タイミングを別経路で確保する（hideLiveChat の close button click はこのパターンに該当）。

### hideLiveChat（YouTube ライブチャット非表示）
hideLiveChat は **iframe 内 close button の公式 click 1 つ** に責務を集約した最小設計に到達している。新機能を足すときに **絶対に復活させてはいけない過去の失敗経路** が複数あるため、ここで明文化しておく。

採用パターン:
- `findLiveChatPanelCloseButton` → `iframe.contentDocument` 経由で `yt-live-chat-header-renderer #close-button button` を取得
- `fireUserLikeClick` で iframe の window から取った `PointerEvent`/`MouseEvent` で full sequence 発火
- `iframe.addEventListener("load", ...)` の idempotent hook で load 後 50ms に再評価
- **CSS 先制非表示で体感ラグ消滅** — `youtube-early.js` (document_start) が `<html>` に `__cpa-sfx-hide-live-chat-pre` を付与 → CSS で `ytd-live-chat-frame { visibility: hidden !important }` → click 成功時に search-fixer.js が pre クラスを剥がす → YouTube 公式 collapsed bar 表示。`visibility: hidden` は frame の Polymer state / iframe load を壊さないため安全（`display: none` の NG パターンとは別レイヤ）。リトライ上限到達時は fail-safe で pre クラス剥がし（永久に隠れたままを防ぐ）。詳細は本ドキュメントの「`hideLiveChat` 体感ラグ消滅の先制非表示パターン」を参照

復活禁止の失敗パターン:
- 独自クラス `__cpa-sfx-live-chat-force-hide` を frame に付与 → frame ごと `display: none` で collapsed view ヘッダー（「パネルを開く」）まで消し、SPA 副作用も誘発
- `setAttribute("collapsed", "")` で標準属性を直接立てる → ライブ配信中で player 再初期化 →「動画を処理しています」エラー
- CSS `iframe.ytd-live-chat-frame { height: 0 }` (collapsed 条件付き or 無条件いずれも) → SPA panel state が不整合で player 副作用
- CSS `#chat-container:has(...) { display: none }` / `--ytd-watch-flexy-sidebar-width: 0` → 同上 + ユーザーが「パネルを開く」を再表示できなくなる
- frame 内の `#close-button` を top frame から `document.querySelector` で探す → そもそも iframe の中なので届かない（`iframe.contentDocument` 必須）

### 音量ブースター・Offscreen Document

**オーディオ路の不変条件**:
- **ノード順序は `source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination` に固定** — 正規化は入力直後の短時間RMSを測って自動 GainNode で平均音量を整え、ナイトモードでダイナミックレンジを狭め、手動 gain の後段に limiter を置く。gain を先頭に置く配置は禁止（v1.0.20 まで誤実装で「正規化 ON で boost が効かない」問題があった）。
- **gain は対数マッピング + `setTargetAtTime` ramp** — UI スライダーは内部値 0..200、実音量は左端 0% / 中央 100% / 右端 300%。100..300 区間の実 gain は `VolumeBooster.percentToGain()` で対数変換し、等距離 = 等 dB ステップにする。`gainNode.gain` への直接 `.value =` 代入はサンプル境界の不連続でクリック発生 → 必ず `cancelScheduledValues` → `setValueAtTime(現在値, now)` → `setTargetAtTime(target, now, RAMP_TIME_CONSTANT)` の三点セットで ramp 経由（`RAMP_TIME_CONSTANT = 0.015` で 3τ ≈ 45ms 95% 到達、popup の 120ms debounce より十分短い）。
- **自動音量正規化は compressor ではなく timer 駆動の自動 GainNode** — `AnalyserNode.getFloatTimeDomainData()` で短時間RMSを測り、`NORMALIZE_TARGET_RMS_DB` に近づくよう `normalizerGainNode.gain` をゆっくり更新する。`NORMALIZE_SILENCE_GATE_DB` 未満は無音/ノイズ扱いで 1.0x に戻し、ノイズだけを持ち上げない。
- **DynamicsCompressor は disconnect ではなく BYPASS preset で OFF** — ナイトモード / 自動歪み防止のサブトグル OFF 時にノードを disconnect/reconnect すると AudioContext のグラフが切れて一瞬無音になりプチノイズが乗る。`COMPRESSOR_BYPASS`（`ratio:1`、threshold/knee 中立）を `applyCompressorPreset` で当てれば素通り化が無音ゼロで実現（切替頻度が低くアタックが速い 1〜50ms ため `setTargetAtTime` 不要、`.value =` 直接代入で十分）。
- **volumeGetGain は `state.lastSetPercent` を返す** — `gain.value` はランプ中で目標値と一致しないため、ユーザーが最後に指定した整数 percent を保持して round-trip 誤差ゼロを担保。`gainToPercent(gain.value)` 経由だと使えない。

**ライフサイクルの不変条件**:
- **マスター OFF = パイプライン解放、設定は保持** — `volumeBoosterEnabled` が `false` になったら `releaseAllVolumeBoosterTabs()` で全 AudioContext を解放するが、`volumeBoosterLastGain` / サブトグルの storage 値は一切触らない。次回 ON 時に保存済み値を復元する。
- **UNITY release 条件は「100% かつ全サブトグル OFF かつミュート OFF」** — `setVolumeBoosterGain` で UNITY 早期 return するのは `clamped === UNITY && !antiClipFlag && !normalizeFlag && !nightModeFlag && !mutedFlag` のときだけ。100% でもサブトグル ON なら AudioContext 維持で自動ゲイン / compressor を効かせる。「音量は変えずに正規化だけ」「突発音だけ抑える」「ナイトモードだけ使う」「100% で完全消音」ユースケースを維持する。
- **`releaseAllVolumeBoosterTabs` の SW 再起動フォールバック** — SW 再起動後は `boostedTabIds` が空だが offscreen に生きた AudioContext がある可能性あり。`boostedTabIds` が空かつ `offscreenState !== "CLOSED"` のとき `ACTION_VOLUME_RELEASE_ALL` を offscreen に直接送信する。
- **`autoApplyVolumeBooster` は既 boost タブ限定** — `boostedTabIds.has(tabId)` ガードにより、`tabs.onActivated` では既存 AudioContext の gain ramp だけが走る。新規タブへの初回適用は popup open（= user gesture）が必要（`tabCapture.getMediaStreamId` の user gesture 要件）。
- **アイドル close 抑止** — `isVolumeBoosterActive` で boost 中タブを query。先頭で `offscreenState === "CLOSED"` を見て早期 false return すること（query 不要 + receiver 不在経路の誤判定回避）。SW 再起動直後など sendMessage が一時失敗した場合のみ安全側（active 扱い）に倒す。
- **タブクローズで自動 release** — `chrome.tabs.onRemoved` は permission 不要 + SW 再起動でも永続発火するため、AudioContext の取り残しを防げる。

**API / 制約**:
- **Offscreen Document の 1 拡張 1 文書制約** — `reasons` は `["USER_MEDIA", "AUDIO_PLAYBACK"]`。新しい用途を追加するときは既存ドキュメントに同居させること。
- **`minimum_chrome_version: "140"` 固定** — `chrome.runtime.getContexts`（116+）等の new API は **typeof チェックなしで直接呼んで良い**。legacy fallback の `if (typeof chrome.runtime.getContexts !== "function")` 分岐はバグ温床（receiver 不在エラーを active 扱いして 30 秒 cycle 無限再 schedule した Codex P2 指摘あり）なので追加しないこと。

### YouTube DOM の罠（v1.0.27 で得た知見）
- **YouTube `/feeds/videos.xml` は廃止済み (404)** — credentials 有無 / channel_id を変えても全部 404。代替は `/${handle}` HTML 内の `"videoId":"..."` から `https://i.ytimg.com/vi/{videoId}/maxresdefault.jpg` を組む方式。
- **thumbnail URL のアスペクト比は要確認** — `hqdefault.jpg` (480x360, **4:3** = letterbox あり) は 16:9 枠で違和感が出るので使わない。`maxresdefault.jpg` (1280x720, 16:9) を第一候補、404 で `mqdefault.jpg` (320x180, 16:9, 全動画必須) フォールバック。
- **YouTube native CSS の `max-width` 制約** — `[use-bigger-thumbs] #avatar-section { max-width: 500px }` のような制約は `width: 100% !important` だけでは超えられない。card 全幅にしたい場合は **`max-width: none !important`** を明示する。
- **Polymer dom-repeat 配下に `<a>` を sibling 挿入してはいけない** — `ytd-guide-section-renderer` 等の Polymer 管理下に外部から sibling として `<a>` を挿入すると、Polymer が「list 構造が変わった」と検知して内部 reorder を発動し、想定外の section 移動が起こる。代わりに **`#items` の中**に `<a>` を inject する（`subsLeftnavInjectAll` / `subsAllShortcut` のパターン）。
- **subs section の DOM 構造**: `#header-entry` は別の `#header` div、`#items.firstElementChild` は collapsible (見出しっぽい expander)。`querySelector("ytd-guide-entry-renderer:not(#header-entry)")` で最初のチャンネル entry を取得して直前に挿入するのが正解。
- **Trusted Types policy 対応**: YouTube は Trusted Types を有効化しているため、`innerHTML` 文字列代入は MAIN world で弾かれる。content script の isolated world では制約緩いが、安全側で **`createElement` ベース**で構築。SVG は `createElementNS` を使う。
- **handle は ASCII 限定じゃない、URL エンコード必須**（2026-05-13 修正） — YouTube ハンドルには日本語 / 韓国語 / 中国語 / アクセント記号など Unicode が含まれるケースが多数（`@むめいの有名になりたい` / `@あゆむさんぽ` / `@Ailas足脚の世界` 等）。DOM の `getAttribute("href")` は **URL エンコード形式** (`/@%E3%82%80...`) で返すため、`href.match(/(@[\w.-]{1,60})/)` のような ASCII 専用正規表現では完全に失敗する。`SearchFixer.extractHandleFromHref` (`src/lib/actions.js`) で **`decodeURIComponent` → Unicode property escapes `\p{L}\p{N}` マッチ** で実装している。subsChannelsGrid のサムネ取得が日本語ハンドルで永遠にスキップされる重大バグの原因だった。新規に handle を扱うコードを書くときは必ず `SearchFixer.extractHandleFromHref` を使うこと。

### Observer / async の罠
- **MutationObserver / IntersectionObserver の callback は stale の前提で書く** — `disconnect()` を呼んでも **既に queue 入りした notification は cancel されない** (IO/MO 共通仕様)。observer インスタンスは **closure に capture** + callback 冒頭で **state null guard** を入れる。
- **state 完全上書き前に古い observer を必ず disconnect** — `state = { ..., observer: null }` のように state object を完全上書きする経路では、上書き前に古い `state.observer.disconnect()` を呼ぶ。参照を null にするだけでは observer 自体は GC 対象にならず、callback が継続発火する。
- **in-flight fetch には dedup ガードを付ける** — sort-wipe 経路で marker 一括 clear → 再 observe で同 handle に対する重複 fetch が走るパターンは要注意。`Set` ベースの in-flight tracking で重複を防ぐ。
- **async fetch の post-await guard には「caller の identity」もチェック** — DOM 要素を await 越しで操作する場合、その要素が別 entity に書き換わってる可能性を考える。`ytd-channel-renderer` は YouTube の Polymer dom-repeat で物理移動だけで並び替わるケースがあり、`#main-link` の href が別チャンネルに切り替わる。await 前に capture した identity (handle / id / key) を保存して await 後に比較。`isConnected` / `has-already` 系の guard だけでは不十分。
- **legacy schema cleanup は「正規形式の全バリアント」を考慮する** — 旧形式判定で単純条件 (`!img` 等) を使うと、img を持たない正規 fallback entry を巻き込んで毎 cycle 削除・再生成 → flicker。正規形式の全バリアントを網羅した判定にする。

### 多言語ロケール
- **`aria-label` / `title` は両言語で書く** — YouTube は ja / en で `Shorts` ⇔ `ショート` のように label が変わる。CSS selector で要素を hide する場合、両言語版を併記しないと初期 flash が出る（JS による DOM 削除が走るまで素のまま見える）。

### マイグレーション
- **`onInstalled` で旧キー削除 + 値転写** — 廃止 storage key（過去例: `copyPasteSettings` / `enabled` / `contextMenuAllowDomains` / `ytShortsRemovalEnabled`）は `chrome.storage.local.remove` で取り除く。値の意味が新キーに引き継がれるなら、削除前に転写する（v1.0.18 で `ytShortsRemovalEnabled === true` → `searchFixerFeatures.removeShorts = true` + `searchFixerEnabled = true` を実施）。**動作継続を最優先**で設計する。注: `volumeBoosterEnabled` は過去に廃止→再導入されたキー。legacy 削除リストに含めないこと。
- **新規 storage key は `onInstalled` で必ず初期化** — `volumeBoosterEnabled` / `volumeBoosterLastGain` / `volumeBoosterAntiClipEnabled` / `volumeBoosterNormalizeEnabled` / `volumeBoosterNightModeEnabled` / `searchFixerFeatures.hideComments` のような後追いキーは未設定時 `undefined` で UI 側に出るとトグルが表示されない・無効状態になるため、必ず `onInstalled` で `false` (boolean) / `VolumeBooster.DEFAULT` (数値) 初期化する。`normalizeSettings()` 側でも `=== true` 防御的判定を入れる（`!!value` だと storage の落ちた object 値で誤判定が出るため）。

### 音量ブースター popup → storage 直書きの防御 (/rere v1.0.28 確立)
**音量ブースター 6 キー** (`volumeBoosterEnabled` / `volumeBoosterLastGain` / `volumeBoosterAntiClipEnabled` / `volumeBoosterNormalizeEnabled` / `volumeBoosterNightModeEnabled` / `volumeBoosterMutedEnabled`) のみ popup から直接 `chrome.storage.local.set` する設計で、background の `normalizeSettings` を経由しない。
- popup の `pushVolumeNow` は **必ず `VolumeBooster.clampValue(value)` を経由**して storage / `VOLUME_BOOSTER_SET_GAIN` 両方に渡す（範囲外値が storage に紛れ込むのを防ぐ二重防御）
- popup クローズ後の orphan await から戻ったときは `document.body.isConnected` チェックで DOM 触らない（detached DOM 操作の no-op 化）
- 将来 `APPLY_SETTINGS` 経路に統合する場合は popup と background 両方の大規模変更が必要

### SW モジュールスコープのストレージキャッシュ (/rere v1.0.28 確立)
`chrome.tabs.onActivated` のように **高頻度発火する経路** で `chrome.storage.local.get` を毎回呼ぶと IPC RTT が累積する。
- SW モジュールスコープ変数（例: `cachedVolumeSettings = null`）にキャッシュし、`chrome.storage.onChanged` で監視対象キーいずれかが変化したら null に invalidate するパターン
- SW 再起動でキャッシュ消失するため、初回呼び出し時の **`if (cache === null) { cache = await chrome.storage.local.get(...) }`** フォールバック必須
- 新しい音量関連 storage key を追加する場合は `chrome.storage.onChanged` リスナーの監視キーリストにも忘れず追加

### 外部 fetch の exponential backoff (/rere v1.0.28 確立)
社内プロキシ環境（Zscaler 等）で 401 / 302 が続く外部 fetch（YouTube `/feed/channels` 等）は **80ms cycle のリトライループで CPU を食う** リスクがある。
- 実装: `subsListFetchBackoffMs` を 2s スタート → 倍々 → **60s 上限**。成功で 0 リセット
- `subsListFetchLastFailedAt = Date.now()` を記録して、`Date.now() - lastFailedAt < backoffMs` の間は早期 return
- 同類のリトライ経路（fetch 系で MutationObserver / IntersectionObserver から呼ばれる）を新規追加する場合はこのパターンを踏襲

### Observer guard の 4 段防御 + finally 状態再取得 (/rere v1.0.28 強化)
`MutationObserver(subtree: true)` 監視中の自身 DOM 書き戻しは **`disconnect → render → takeRecords → observe`** の 4 段ガード（Amazon 月別合計で確立）。さらに:
- `applySubsLeftnavInjection` のように **内部で observer を再構築する関数を呼ぶ**ケースは、`finally` ブロックで **観察対象を再取得**する（render 後の `leftnavInjectObserver` / `leftnavSectionWatched` / `#items` の 3 つ全部）
- entry 時点の値を closure capture して finally で使うと、render 中に observer が detach + 再 attach されたケースで stale items に observe したり、新規 observer に観察対象を与え忘れる

### FEATURES 件数アサートテスト (/rere v1.0.28 確立)
`test/actions.test.js` の **「FEATURES 件数の固定アサート」テスト** がドキュメント整合性の単一情報源。
- 件数を増減する場合は **同時に**: (1) FEATURES 配列に追加、(2) アサート値更新、(3) CLAUDE.md / README / docs/privacy-policy.md / webstore/store-listing.txt / popup.html コメント / actions.js 内コメント の数値を全部更新
- 1 つでも update 漏れると `npm test` で fail → CI で drift を検知できる
- 過去に 22 / 25 / 26 / 29 が混在した状態が再発しないようにこのテストで防御

### `chrome.runtime.sendMessage` の expected error (/rere v1.0.28 確立)
マッチしないタブ（`chrome://` / `file://` / `about:` 等）への `chrome.tabs.sendMessage` は **受信側不在で必ず reject** する → これは **expected behavior**。
- 該当箇所の `.catch(() => {})` は silent skip が正解
- 一括 `console.debug` 化は spam ログを生むので NG（毎回のタブ切替で大量出力）
- 将来の観測性改善は「URL pattern マッチが先に確定している経路（例: `isYouTubeUrl(tab.url) === true` のあと）でのみ詳細ログ」の **expected/unexpected 分離設計** が前提
