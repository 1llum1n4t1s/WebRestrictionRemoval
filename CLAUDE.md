# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WEB閲覧アシスト (Web Viewing Assist) は Chrome 拡張機能 (Manifest V3)。Web ブラウジングを快適にする 12 機能を提供する：「セッション維持（現在のサイト単位）」「YouTube クリーナー（Shorts 削除・コメント欄非表示・ライブチャット非表示・登録チャンネル拡張を含む 30 サブ機能）」「Amazon 定期おトク便 月別合計」「Amazon ランキングへ移動ボタン（商品詳細欄の売れ筋ランキングリンクを商品情報最上部の集約ボタンにまとめ、一番細かいサブカテゴリへ同タブ移動）」「Instagram クリーナー（11 サブ機能）」「TikTok クリーナー（3 サブ機能：コメント欄非表示・おすすめのアカウント非表示・画像ダウンロードボタン）」「音量ブースター（マスタートグル付き・自動歪み防止 / 自動音量正規化 / ナイトモード サブトグル付き・ミュートトグル付き・設定グローバル永続化・タブ切替で自動適用）」「動画ガンマ補正（全タブ共通スライダー、SVG `<feComponentTransfer type="gamma">` 独自実装）」「動画の黒帯除去（ウルトラワイド画面などで動画の上下/左右の黒帯をズーム/引き伸ばしで除去、動画縦横比は自動検出・全タブ共通設定）」「ルーペ（マウス追従の円形拡大鏡、`chrome.tabs.captureVisibleTab` で取得した JPEG 静止画を `background-position` で追従表示、倍率 3 段階 / レンズサイズ可変）」「RTX 動画強化（`<video>` 要素のあるページに 1×1 透明 hint 要素を inject して GPU ドライバ側映像補正の動画ページ検知を補助）」「カラーピッカー（EyeDropper API ベース・popup 内完結）」。全 12 機能のうち 11 機能がマスタートグル付きオプトイン（**全てデフォルト OFF**）、カラーピッカーは popup タブとして常時利用可。画像ダウンロード機能は Instagram / TikTok の各クリーナーのサブ機能として共通実装（YouTube では未提供）。カラーピッカー履歴は最大 20 件、`chrome.storage.local` 内のみで外部送信ゼロ。すべての機能はクライアントサイド DOM/CSS 操作と Chrome 標準 API のみによる独自実装で、外部送信ゼロ。

popup は **5 タブ構成** (`調整 / YouTube / Instagram / TikTok / カラーピッカー`)。タブ順序は `PopupTabs.ALL` 配列で管理、`POPUP_LAST_TAB` storage key に最後のタブを永続化。

設定は `chrome.storage.local` の各 boolean / 数値キーで保存。UI は **Chrome i18n API でローカライズ**（ブラウザ UI 言語が `ja` → 日本語 / それ以外 → 英語にフォールバック）。`manifest.json` の `default_locale: "en"` + `_locales/{en,ja}/messages.json` を単一情報源とし、popup 静的テキストは `data-i18n` 属性、popup の動的テキストと content script の DOM 注入テキストは `chrome.i18n.getMessage()` 経由で取得する。コードコメント / `console.log` メッセージは開発者向けで日本語のまま残す。**インストール直後は全マスタートグル OFF**（音量ブースターもマスター OFF かつ全サブトグル OFF = 完全に無処理）。サイト挙動を勝手に書き換えないオプトイン方針。バージョン番号は `/vava` スキル経由でのみ更新する。

## Build Commands

```bash
npm install                  # 初回 / 開発用
npm run ci:install           # CI 用 (npm ci。lockfile 厳守)
npm run build                # アイコン + スクリーンショット一括生成
npm run generate-icons       # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
npm run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer, concurrency=2)
npm run lint                 # ESLint v10 flat config + no-implicit-globals (warn) + 18 globalThis 定数列挙 (/rere D-004 + /opop Phase 1 で導入、v1.0.31 で Dependabot 経由 v10 化)
npm test                     # Node.js 標準 test runner、79 件（FEATURES 件数アサート + ALLOWED_HOSTS scontent- prefix + 音量ブースター 6 キー + RTX_ENHANCER_ENABLED + cdninstagram scontent- prefix + Loupe pure function 群 + extractHandleFromHref の Unicode 境界値 + SettingsSchema 整合 + VolumeBooster.isEmeHost / isEmeUrl 境界値 を含む）
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
  && node --check src/content/amazon-ranking-jump.js \
  && node --check src/content/instagram-cleaner.js \
  && node --check src/content/tiktok-cleaner.js \
  && node --check src/content/video-gamma.js \
  && node --check src/content/loupe.js \
  && node --check src/content/rtx-enhancer.js \
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
                        ──APPLY_KEEP_ALIVE_CS / APPLY_SEARCH_FIXER_CS / APPLY_AMAZON_DELIVERY_TOTAL_CS
                          / APPLY_INSTAGRAM_CLEANER_CS / APPLY_TIKTOK_CLEANER_CS / APPLY_VIDEO_GAMMA_CS
                          / APPLY_LOUPE_CS / APPLY_IMAGE_DOWNLOADER_CS──▶ 各 Content Script

[音量ブースター MediaElementSource 経路 (v1.0.33+ デフォルト、普通サイト向け)]
  Popup ──chrome.storage.local.set (gain, antiClip, normalize, nightMode, muted)──▶ Storage
                                                                                       │ onChanged
  Content Script (src/content/volume-booster.js, 全 http(s) + all_frames:true) ◀───────┘
    │ isEmeHost(location.hostname) で EME 多用サイト (Netflix 等) なら早期 return
    │ <video> / <audio> 検出 (起動時 querySelectorAll + MutationObserver で動的追従)
    │ ctx.createMediaElementSource(media) で attach
    │ source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination
    └ user gesture 不要で動画再生開始前から自動適用 (popup を開かなくて OK)

[音量ブースター tabCapture 経路 (EME fallback、Netflix / Prime Video / DAZN 等で必須)]
  Popup ──VOLUME_BOOSTER_SET_GAIN (gain, antiClip, normalize, nightMode, muted)──▶ Background
                                    │ active tab が isEmeUrl のとき popup から呼ばれる
                                    │ chrome.tabCapture.getMediaStreamId
                                    ──ACTION_VOLUME_SET_GAIN──▶ Offscreen Document
                                                                  │ getUserMedia + AudioContext
                                                                  │ source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination
                                                                  └ EME 動画でも decrypted output を捕獲して増幅 (popup 必須 = user gesture)

[ルーペ]
  Content Script ──LOUPE_REQUEST_CAPTURE──▶ Background
                                              │ chrome.tabs.captureVisibleTab(windowId, {jpeg, quality:70})
                                              └ JPEG DataURL を sendResponse で返却 → content script が Blob URL 化して lens に貼付
```

### Popup (`src/popup/popup.html`, `src/popup/popup.js`, `src/popup/popup.css`)
5 タブ構成（調整 / YouTube / Instagram / TikTok / カラーピッカー）。**9 マスタートグル**（セッション維持 / YouTube クリーナー / Amazon 合計 / Instagram クリーナー / TikTok クリーナー / 動画ガンマ補正 / ルーペ / RTX 動画強化 / 音量ブースター）+ 音量ブースタースライダー（左端にミュート 🔊/🔇 ボタン）+ 音量サブトグル × 3（自動歪み防止 / 自動音量正規化 / ナイトモード）+ 動画ガンマスライダー（中央 1.0 = 補正なし、左 3.0 で暗く、右 0.3 で明るく）+ ルーペ倍率セグメント（1.5× / 2.5× / 4×）+ ルーペサイズスライダー（150〜1000px）+ 各クリーナー専用パネル × 3（YouTube クリーナー 30 機能 / Instagram クリーナー 11 機能 / TikTok クリーナー 3 機能）。Shorts 削除・コメント欄非表示は YouTube クリーナーのサブ機能（`removeShortsShelf` 等 / `hideComments`）として統合。幅 380px。トグル変更で即 `APPLY_SETTINGS` を background へ送信、設定は `chrome.storage.local` から復元（未設定時 false）。音量ブースターのマスタートグル OFF 時はスライダー・サブトグル・ミュートボタンを `.volume-disabled` で dim 化。ルーペ ON 時のみ倍率セグメント + サイズスライダーが表示される（`.sub-block.hidden` トグル）。

**クリーナーアコーディオン**: サブ機能行は **1 行 1 トグル + 説明文** の縦積みレイアウト。各機能の `desc` は `actions.js` の `SearchFixer.FEATURES` / `InstagramCleaner.FEATURES` を単一情報源として popup.js が動的にレンダリングする（FEATURES に追加するだけで UI 自動生成）。

**テーマ**: アクセントカラーは茜系（ライト `#C0605A` / ダーク `#df8983`）。`<meta name="color-scheme" content="light dark">` でネイティブ要素を `prefers-color-scheme` に追従させ、CSS は `:root` のライト用トークン + `@media (prefers-color-scheme: dark)` のダーク上書きの 2 層構造。色値はすべて CSS 変数経由でハードコードなし。CSP meta 明示。

**音量ブースター親トグル**: `volumeBoosterEnabled` (boolean) で master 制御。v1.0.33 以降は **MES 経路がデフォルト** で、popup の `pushVolumeNow` は (1) 音量関連 6 キーを `chrome.storage.local.set` で書き込み (content script の `storage.onChanged` で全タブ MES 経路が反応)、(2) active tab が `VolumeBooster.isEmeUrl(tab.url)` で EME 多用サイト判定なら旧 `VOLUME_BOOSTER_SET_GAIN` 経路で background → tabCapture → offscreen の流れも併用、という 2 経路設計に変更。OFF で `chrome.storage.local.set` のみ（content script が解放 + background の `storage.onChanged` リスナーが `releaseAllVolumeBoosterTabs()` で旧経路の AudioContext も解放）。**OFF でも gain / サブトグル設定は storage に残す**（次回 ON 時に復元）。

**音量スライダー / サブトグル**: input 時 120ms debounce → `pushVolumeNow`（`gain`, `antiClip`, `normalize`, `nightMode`, `muted` を全部 storage に書く + EME ホスト時のみ tabCapture 経路も呼ぶ）。change（マウスアップ）で即 push、100% に戻すボタンは `pushVolumeNow(100)` で release 経路へ。popup 起動時は `chrome.storage.local` の `volumeBoosterLastGain` からスライダー初期値を復元する（offscreen への round-trip 不要）。スライダー UI は 0..200 の内部値を使い、左端 0% / 中央 100% / 右端 300% の実音量へ変換する。マスター ON 時のみ popup open で即座に `pushVolumeNow` して active tab に適用。サブトグル (`volumeBoosterAntiClipEnabled` / `volumeBoosterNormalizeEnabled` / `volumeBoosterNightModeEnabled`) は change で `cancelVolumePush` → `pushVolumeNow(currentGain)` の順で即時反映（既存 MES / AudioContext があれば自動ゲイン / compressor 状態だけ切り替わり音切れなし）。EME ホストでのエラーは `formatVolumeError(res.error)` で日本語に翻訳。

### Background (`src/background/background.js`)
Service worker。役割:
1. **設定の集約と各 content script への配布**: `APPLY_SETTINGS` を popup から受信し、`handleApplySettings` で **storage 既存値とマージしてから** `normalizeSettings` → `chrome.storage.local.set` + `notifyContentScripts` の順で処理する (`APPLY_SETTINGS_KEYS` 列挙ベースの merge 防御、Important Patterns「APPLY_SETTINGS 経路の partial payload 防御」参照)。`notifyContentScripts` は 5〜8 個の `chrome.tabs.sendMessage` を **`Promise.all` で並列発射** し、各 send は `safeSendMessage` ヘルパーで `.catch(() => {})` 集約 (受信側不在は expected error として silent skip)。YouTube タブ / Amazon `auto-deliveries` タブ判定は URL パターンで条件付き dispatch。
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
`searchFixerEnabled` (master) と `searchFixerFeatures` (オブジェクト) と `searchFixerGridItems` (数値: 0/4/5/6) の 3 キーで管理（変数名は履歴的に `searchFixer*` を使用）。30 機能の単一情報源は `actions.js` の `SearchFixer.FEATURES`。実装: top frame 限定で MutationObserver + `yt-navigate-finish` / `yt-navigate-start` イベントで onSettingsChanged を再実行（SPA navigation で CLASS_PROCESSED マーカーをリセットするため）。マスター OFF 時は observer / 注入 CSS / 装飾クラスをすべて停止。**Shorts 5 サブ機能の実装は search-fixer.js ではなく youtube-shorts.js が担当**（責務分離: SPA URL リダイレクト + サイト横断 DOM 削除は検索ページ限定の clean-up とは別レイヤ）。

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

**設計上の不変条件**:
- `captureInFlight` + `pendingRecapture` フラグで重複リクエスト防止 (同時 capture は 1 つまで、進行中の trigger は後追い実行)
- Blob URL は cleanup 時に必ず revoke (DataURL は revoke 不可なので Blob URL に変換する設計)
- top frame 限定 (`window === window.top` ガード + manifest `all_frames: false`)
- MutationObserver は `subtree: false` で body 直下のみ監視 (SPA top-level navigation 検知に十分、深い tree の頻発変化を避ける)
- 左クリック OFF は `capture: true` で document level listener、サイト側 click より先に stopPropagation して副作用を防ぐ
- 倍率 / サイズ変更は popup → storage 直書き → content script の `storage.onChanged` で同期 (background の `normalizeSettings` を経由しない、音量ブースター直書きパターンと同型)
- タブ切替時 (`visibilitychange` で hidden 検知) は cleanup、**フォアグラウンド復帰時は `readSettingsAndApply()` で自動 reactivate** する (storage の `loupeEnabled === true` のままなら lens 復帰、音量ブースターと UX 統一 / /rere D-1 で確立)
- `readSettingsAndApply` は `applyInFlight` / `applyQueued` で並列実行を直列化 (storage.onChanged / runtime.onMessage / visibilitychange 復帰の重複呼出で activate と deactivate が race するのを防ぐ / /rere B1-E3)
- 再キャプチャ debounce 500ms は `chrome.tabs.captureVisibleTab` の Chrome 公式レート上限 (2fps = 500ms 周期) と一致させる安全値
- background の `LOUPE_REQUEST_CAPTURE` ハンドラは **`tabId === activeTabId` を assert** してから撮影 (`chrome.tabs.query({ active: true, windowId })` で確認、バックグラウンドタブからの別タブピクセル取得を遮断 / /rere A1-I1)

### RTX 動画強化 (`src/content/rtx-enhancer.js`)
全 http(s) サイトの top frame に注入される独立機能。`rtxEnhancerEnabled` (boolean、デフォルト OFF オプトイン) 1 storage key で管理。ON 時に `<video>` 要素が存在するページに対して **極小の透明 hint 要素** (1×1 px / opacity:0 / pointer-events:none / aria-hidden) を video の直近祖先 (`parentElement`) に inject する。NVIDIA RTX Super Resolution / AMD FidelityFX Super Resolution for Browser などの GPU ドライバ側映像補正は「動画ページ」を検知して自動補正を入れるため、この hint 要素が動画ページ判定の補助となる。**ドライバ機能の有効化自体は GPU 側設定** (NVIDIA Control Panel など) に依存し、本拡張機能はブラウザ側の hint inject のみを担う。

実装上の不変条件:
- top frame 限定 (`window === window.top` 早期 return)、iframe 内 `<video>` は site 側 player に任せる
- 同 `<video>` への重複 inject は `dataset.__cpaRtxAttached === "1"` マーカーで防ぐ
- MutationObserver `subtree: true` で SPA 経路の遅延 inject された `<video>` も検知して追従
- context invalidation guard (`chrome.runtime?.id` チェック) を主要 entry point に配置、orphan 化したら MutationObserver を必ず `disconnect` (CPU リーク防止)
- master OFF / pagehide で全 hint 要素を `removeAllHints()` で撤去、site の DOM を残骸で汚さない
- `readSettingsAndApply` は `applyInFlight` / `applyQueued` で並列実行を直列化 (storage.onChanged / runtime.onMessage 重複呼出のレース防止、ルーペと同じパターン)
- pure DOM 操作のみ・外部送信ゼロ・ドライバ依存の有効化はユーザー責任 (privacy-policy にも明記)
- アプローチは sabamotto/rtx-activator-extension (MIT) を **参考** にした独自実装 (コード行は reproduce せず、概念のみ)

### Amazon 定期おトク便 月別合計 (`src/content/amazon-delivery-total.js`)
`*://www.amazon.co.jp/auto-deliveries*` 限定。`amazonDeliveryTotalEnabled` (boolean) で master 制御。Amazon の DOM 構造（`[data-delivery-type]` セクションと `.subscription-price` 価格表示）に基づく独自実装で、配送月ごとの合計を計算してページに挿入する。

**フリーズ対策**: 旧実装は `MutationObserver(subtree: true)` 監視中に自身が `target.append(root)` / `priceEl.textContent = ...` で DOM を書き戻すと再発火 → 再 render → 無限ループでブラウザがフリーズする問題があった。修正版は **rAF coalesce + observer disconnect / takeRecords / reconnect ガード** パターン:
1. `scheduleRender()` を `requestAnimationFrame` で 1 フレームに 1 回に圧縮
2. `runRenderInsideObserverGuard()` 内で `observer.disconnect()` → `renderAllTotals()` → `observer.takeRecords()`（蓄積分を破棄）→ `observer.observe()` で再接続
3. `priceEl.textContent` は変化時のみ更新（同じ文字列の再代入でも `MutationRecord` は積まれるため）

**動作対象**: top frame 限定、`[data-delivery-type]` セクションの `.subscription-price` を `/\D/g` で数値化して合計、各セクションの `.a-fixed-left-grid-col` に `__cpa-amzn-delivery-total` クラスのルート要素を append。OFF 時は observer 切断 + 既存挿入要素を全部撤去（撤去操作も同じ guard 経由）。

### Amazon ランキングへ移動ボタン (`src/content/amazon-ranking-jump.js` + `src/content/amazon-ranking-jump.css`)
`*://www.amazon.co.jp/*` 限定（top frame のみ）。`amazonRankingJumpEnabled` (boolean、デフォルト OFF オプトイン) 1 storage key で master 制御。商品詳細欄の「Amazon 売れ筋ランキング」リンクは商品ページごとに出現位置がバラバラで探しにくいので、商品情報の最上部（`#title_feature_div` の直前を第一候補にフォールバック順に挿入）に「この商品が所属するランキングへ移動」ボタン (`<a href>`) を 1 つ集約して表示する。クリックでブラウザ標準ナビゲーションにより**同じタブ**でランキングへ移動。外部送信ゼロ・純粋 DOM 操作（価格・履歴の取得は一切しない）。

**移動先選定**: `AmazonRankingJump.DETAIL_CONTAINER_SELECTORS`（`#detailBulletsWrapper_feature_div` 等の商品詳細コンテナ id 群）の中の `a[href*="bestsellers/"]` だけを走査する（カテゴリページ等の無関係なベストセラーリンクを拾わず**商品ページで自己ゲート**）。集めた href から `AmazonRankingJump.selectTargetHref` で「一番細かいサブカテゴリ」= ノード id を持つサブカテゴリリンク (`/bestsellers/<slug>/<digits>/`) のうち DOM 上で最後のものを選ぶ（Amazon は広い→細かいの順に並べるため）。サブカテゴリが無ければ最後のリンクにフォールバック。`isSubcategoryHref` / `selectTargetHref` は actions.js の純粋関数で、`test/actions.test.js` が境界値を検証する。

**実装上の不変条件**: top frame 限定、`window.__cpaAmazonRankingJumpRunning` で二重実行防止。MutationObserver で遅延読み込みされる商品詳細欄に追従し、自分のボタン挿入 / href 更新による再発火は **rAF coalesce + disconnect → render → takeRecords → observe ガード**（定期おトク便と同型）で抑える。ボタンは差分更新（href / カテゴリ名が変化時のみ書き込み）+ `isConnected` チェックで Amazon の再 render による剥落時に再挿入。context invalidation guard で orphan 化時に observer disconnect + ボタン撤去。master OFF / 非商品ページ（ランキングリンク無し）でボタン撤去。

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

### 音量ブースター (2 経路設計、v1.0.33+ )
2 経路で構成され、ホスト種別に応じて使い分ける:

#### 経路 A: MediaElementSource (デフォルト、`src/content/volume-booster.js`)
全 http(s) サイト + 全 frame に注入される content script。`<video>` / `<audio>` 要素に対して `ctx.createMediaElementSource(media)` を attach し、6 ノードチェーン (`source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination`) を構築する。**user gesture 不要で動画再生開始前から自動適用** されるのが旧 tabCapture 経路との最大の違い (popup を一度も開かずにブラウザ起動後すぐ音量補正が効く)。

**EME ホスト除外**: 起動直後に `VolumeBooster.isEmeHost(location.hostname)` を判定し、EME 多用サイト (Netflix / Prime Video / DAZN / Disney+ / Hulu / Apple TV+ / Abema / U-NEXT / TVer / NHK オンデマンド / Spotify / FOD / SPOOX 等、15 サイト) では **早期 return して MES attach 自体をスキップ** する。理由: EME (DRM) 保護動画は復号後の音声 sample を AudioContext に流さない仕様 (Chrome/Firefox 共通) のため、MES attach すると **動画の音そのものが完全無音化** する致命的副作用がある。これらのサイトでは経路 B (tabCapture) で boost する。

**設計の不変条件は Important Patterns「音量ブースター・MediaElementSource 経路」に集約**。

#### 経路 B: tabCapture + Offscreen Document (EME fallback、`src/background/background.js` + `src/offscreen/offscreen.js`)
旧来の `chrome.tabCapture.getMediaStreamId` + `getUserMedia` + AudioContext 方式。v1.0.33 以降は EME 多用サイト用 fallback として継続保持。`chrome.tabCapture` は OS / ブラウザレベルで復号された後のタブ音声出力を捕獲するため、EME 動画でもブースト可能。

**popup 必須**: `chrome.tabCapture.getMediaStreamId` は user gesture が必須で、background SW から自動呼び出しは Chrome 仕様で禁止。`popup.js pushVolumeNow` が `VolumeBooster.isEmeUrl(tab.url)` で EME ホストと判定したときのみ `VOLUME_BOOSTER_SET_GAIN` を background に送る (popup open 自体が user gesture)。

**処理フロー (経路 B)**:
1. popup の `pushVolumeNow` で active tab が EME ホストと判定 → `VOLUME_BOOSTER_SET_GAIN`（`tabId`, `gain`, `antiClip`, `normalize`, `nightMode`, `muted`）を background に送信
2. background: gain が UNITY かつ全サブトグル OFF かつミュート OFF なら `releaseVolumeBoosterTab` で AudioContext 解放して終了。それ以外は `chrome.tabCapture.getMediaStreamId({ targetTabId })` で MediaStream ID 取得（既存 AudioContext があれば streamId なしで gain / 自動ゲイン / preset / mute だけ更新）
3. background → offscreen: `ACTION_VOLUME_SET_GAIN`（`tabId`, `streamId`, `gain`, `antiClip`, `normalize`, `nightMode`, `muted`）
4. offscreen: 未登録タブなら `getUserMedia` → 6 ノード接続。登録済みなら GainNode を `setTargetAtTime` で 45ms ramp、正規化 timer の開始/停止、各 DynamicsCompressor のパラメータ切替
5. **タブ切替で自動適用**: `tabs.onActivated` → `autoApplyVolumeBooster(tabId)` → **`boostedTabIds` に既登録のタブのみ**が対象（既存 AudioContext があるので `getMediaStreamId` 不要で user gesture 制約に引っかからない）

**共通仕様**:
- `volumeBoosterEnabled` (master) + `volumeBoosterLastGain` (数値 0〜300、初期 100) + `volumeBoosterAntiClipEnabled` / `volumeBoosterNormalizeEnabled` / `volumeBoosterNightModeEnabled` / `volumeBoosterMutedEnabled` の **6 storage key** で管理
- 全設定はグローバル永続化（タブ間共通）。マスター OFF は両経路の AudioContext を解放
- **ミュート UI**: popup の音量スライダー左にトグルボタン（🔊/🔇、`aria-pressed` ベース）。ミュート ON 中もスライダー値は last gain 位置のまま表示・操作可能で、ユーザーは「ミュート維持のままスライダー値を変更 → ミュート解除で意図した音量に復帰」できる
- 数値の単一情報源は [`src/lib/actions.js`](src/lib/actions.js) の `VolumeBooster` 定数 — ドキュメントとコードに齟齬が出たら必ずコードを正とすること

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 設定; permissions: `activeTab`, `storage`, `offscreen`, `tabCapture` |
| `src/lib/actions.js` | `Object.freeze` された 20 個の定数を IIFE wrap + globalThis 公開: SettingsSchema / Actions / ExtensionPaths / SenderCheck / Offscreen / StorageKeys / KeepAlive / YouTubeShorts / SearchFixer / AmazonDeliveryTotal / AmazonRankingJump / InstagramCleaner / TikTokCleaner / ImageDownloader / VolumeBooster (`isEmeHost` / `isEmeUrl` 含む、15 ホストブラックリスト) / VideoGamma / VideoFill / Loupe / ColorPicker / PopupTabs |
| `src/background/background.js` | Service worker: sender 検証付きメッセージ転送、設定マイグレーション、offscreen document 管理、音量ブースター制御 (v1.0.33+ は EME fallback 専用、普通サイトは content script の MES 経路に移行) |
| `src/content/keepalive.js` | 合成アクティビティ + 同一オリジン HTTP ping ポーラー（top + cross-origin iframe）+ 起動ランナー |
| `src/content/early-framework.js` | document_start early script 共通フレームワーク。`<style>` 注入 / pre クラス同期付与 / `storage.local.get` / `storage.onChanged` 購読を `window.__cpaEarlyFramework.setup(config)` に集約。各 early エントリで先頭ロード、actions.js には依存しない |
| `src/content/youtube-early.js` | YouTube watch ページ向け `document_start` 注入の最小スクリプト。hideLiveChat ON 時に `<html>` へ `__cpa-sfx-hide-live-chat-pre` クラスを最速付与し、ライブチャット枠の体感ラグを消す。early-framework.js 経由でボイラープレート共通化、サイト固有の MutationObserver / force-hide のみ独自実装 |
| `src/content/youtube-shorts.{js,css}` | YouTube クリーナーの Shorts 5 サブ機能（Shelf / Chip / Sidebar / Redirect / Btn、top frame のみ）: MutationObserver + URL リダイレクト + 機能ごとの `__cpa-yt-shorts-hide-{shelf,chip,sidebar}` / `__cpa-yt-shorts-redirect-active` クラスで `display: none` |
| `src/content/search-fixer.{js,css}` | YouTube クリーナー（30 機能 = 検索結果ノイズ除去・Shorts 5 サブ機能・動画ページ整形・グリッド列数・ホーム/フィードのグリッド整列・登録チャンネル拡張 3 機能を含む）: master + features + gridItems で駆動、`/feed/channels` グリッド化 / leftnav 全件展開 / すべての登録チャンネルショートカットを含む |
| `src/content/amazon-delivery-total.{js,css}` | Amazon 定期おトク便ページ: 月別合計を rAF coalesce + observer guard 駆動で挿入 + `__cpa-amzn-delivery-total` 配色 |
| `src/content/instagram-early.js` | Instagram 向け `document_start` 注入の最小スクリプト。hideComments ON 時に `<html>` へ `__cpa-ig-comments-pre` クラスを最速付与し、`div:has(> ul._a9ym)`（各コメント UL の親 div）を CSS rule + MutationObserver inline force-hide で先制非表示にする。`_a9z6`（外側 UL）には post caption が同居しているので触らず、`_a9ym` 親 div だけを対象にして caption 巻き込み防止（actions.js は読み込まない） |
| `src/content/instagram-cleaner.{js,css}` | Instagram クリーナー: master + features で body クラス駆動、URL リダイレクト + DOM スイープ + 意味論的セレクタのみ（aria-label / href / role / data-pagelet / SVG path data） |
| `src/content/tiktok-early.js` | TikTok 用 `document_start` 注入の最小スクリプト。`tiktokCleanerEnabled` + `tiktokCleanerFeatures` を読んで `<html>` に `__cpa-tt-comments` / `__cpa-tt-suggested` 同期付与 + inline `<style>` で主要セレクタ焼き込み（FOUC 防止、actions.js 非依存） |
| `src/content/tiktok-cleaner.{js,css}` | TikTok クリーナー: master + features で body クラス駆動、CSS-only 実装（DOM スイープ / URL リダイレクト不要）。photo / video 用 `[class*="RightPanelContainer"]` + modal viewer 用 `[class*="DivCommentListContainer"]` の 2 系統セレクタ併用 |
| `src/content/amazon-ranking-jump.{js,css}` | Amazon ランキングへ移動ボタン: `*://www.amazon.co.jp/*` の top frame に注入、商品詳細欄の売れ筋ランキングリンクから「一番細かいサブカテゴリ」を選んで商品情報最上部に集約ボタン (`<a href>`) を挿入、同じタブで移動。商品ページで自己ゲート、rAF coalesce + observer guard、外部送信ゼロ |
| `src/content/video-gamma.js` | 動画ガンマ補正: 全 http(s) + iframe に注入、SVG `<feComponentTransfer type="gamma">` を `<body>` に inject + CSS `filter: url(#...)` で `<video>` に適用 |
| `src/content/loupe.{js,css}` | ルーペ機能: 全 http(s) の top frame に注入、`chrome.tabs.captureVisibleTab` で取得した JPEG 静止画を `position: fixed` 円形レンズに `background-image` で貼り、mousemove で `background-position` を rAF コアレス 60fps 更新。再キャプチャ trigger は初回 / scroll (500ms debounced) / MutationObserver(childList, subtree:false) / resize。Blob URL に変換して `<img>`/`background-image` で参照し cleanup 時に `URL.revokeObjectURL` で確実に解放 |
| `src/content/rtx-enhancer.js` | RTX 動画強化: 全 http(s) の top frame に注入、`<video>` を持つページに極小の透明 hint 要素を inject して GPU ドライバ側映像補正 (NVIDIA RTX Super Resolution など) の動画ページ検知を補助。`dataset.__cpaRtxAttached` マーカーで二重 inject 防止、MutationObserver で遅延 `<video>` 追従、master OFF/pagehide で `removeAllHints()` 撤去。外部送信ゼロ、ドライバ機能の有効化は GPU 側設定 (NVIDIA Control Panel 等) に依存 |
| `src/content/image-downloader.{js,css}` | 画像ダウンロード（Instagram / TikTok 共通、YouTube は未提供）: 各クリーナー features の `imageDownload` ON 時に動作。site adapter で各サイトのコンテンツ画像（投稿写真 / 動画サムネ）を判定 → hover で左上に DL ボタン overlay → クリックで `<a download>` + Blob URL 経由で保存。最大解像度 URL 取得 / URL ホワイトリスト ALLOWED_HOSTS / fetch セキュリティ 4 原則 / sibling overlay 検出による host 1 階層上昇 / SCANNED マーカー src 値ベース。`__cpa-img-dl-` クラスプレフィックス。 |
| `src/popup/popup.{html,js,css}` | ポップアップ UI: 5 タブ構成（調整 / YouTube / Instagram / TikTok / カラーピッカー）。調整タブは **9 マスタートグル** + 音量スライダー（左端 🔊/🔇 ミュートボタン）+ 音量サブトグル × 3 + 動画ガンマスライダー + ルーペ master + 倍率セグメント + サイズスライダー + RTX 動画強化 master、各クリーナータブは独立パネル（FEATURES 配列駆動の動的レンダリング、1 行 1 トグル + 説明文）、カラーピッカータブは EyeDropper 採取 + HEX/RGB/HSL 表示 + format chips + 履歴グリッド。設定保存・復元、適用フィードバック、ダーク/ライト追従、IBM Plex Sans JP サブセット同梱 |
| `src/content/volume-booster.js` | **音量ブースター MediaElementSource 経路 (v1.0.33+ デフォルト)**: 全 http(s) + all_frames:true に注入、`<video>` / `<audio>` 要素を検出して `ctx.createMediaElementSource(media)` で 6 ノードチェーン attach、storage.onChanged で音量関連 6 キーに即反応。**user gesture 不要で動画再生開始前から自動適用** (popup 開かなくて OK)。冒頭で `VolumeBooster.isEmeHost(location.hostname)` 判定 → EME 多用サイト (Netflix 等) は早期 return して silent 化を防ぐ。MutationObserver で動的追加 video に追従、WeakMap で state 管理 |
| `src/offscreen/offscreen.{html,js}` | 音量ブースター **EME fallback 用** offscreen document: AudioContext + AnalyserNode + 自動 GainNode + 手動 GainNode + DynamicsCompressor × 2 (night mode / anti-clip) で正規化 + 増幅 + 圧縮。v1.0.33 以降は EME 多用サイト (Netflix / Prime Video / DAZN 等) で popup 経由の tabCapture 経路でのみ使われる |
| `icons/icon.svg` | ソースアイコン (512×512); PNG は `icons/icon-{16,48,128}.png` に生成 |
| `webstore/` | ストア申請用: HTML テンプレート、生成画像、`store-listing.txt`。`generate-screenshots.js` が popup.html から `popup-render.html` + `popup-shim.js` を動的生成 → `01-popup-ui.html` が iframe で実 popup を埋め込んで撮影（drift ゼロ）。生成物 `popup-render.html` / `popup-shim.js` は .gitignore 対象 |
| `manifest.firefox.json` | Firefox AMO 申請用 manifest (Chrome 用 `manifest.json` から `offscreen` / `tabCapture` permission 除外 + `browser_specific_settings.gecko` + `background.scripts` 併記)。zip スクリプトが Firefox xpi 生成時にこれを `manifest.json` として同梱する |
| `.amo-metadata.json` | `web-ext sign --amo-metadata=...` で AMO 初回登録時に渡すメタデータ (license: MIT, categories: ["other"])。CI からは新規 add-on 作成不可なため、初回のみローカル `web-ext sign` で使う |
| `zip.ps1` / `zip.sh` | ストア申請用 ZIP / xpi パッケージ生成 (Windows / Unix)。`-Target chrome\|firefox\|both` で対象切替 |
| `docs/privacy-policy.md` | プライバシーポリシー |
| `test/actions.test.js` | 純粋関数テスト 79 件: globalThis 18 個公開 (SettingsSchema 含む) / **FEATURES 件数アサート (SearchFixer 30 / IG 11 / TT 3)** / mergeFeatures / ImageDownloader.isAllowedFetchUrl (Instagram fbcdn / cdninstagram は scontent- prefix 限定 / TikTok p\\d+ 必須 / YouTube 廃止) / detectHost / buildFilename / **RTX_ENHANCER_ENABLED storage key + APPLY_RTX_ENHANCER_CS action (drift 防止)** / **Loupe.validateZoom / clampSize / computeLensPosition / computeBackgroundPosition / formatLoupeError 境界値** / **SearchFixer.extractHandleFromHref の ASCII + Unicode + URL encoded 境界値** / **SettingsSchema 整合** / **VolumeBooster.isEmeHost / isEmeUrl 境界値 (suffix attack 防御含む 5 件、v1.0.33)** 等。件数 drift を CI で検知できる単一情報源 |
| `.github/workflows/publish.yml` | `push: branches: release/**` トリガーで **Chrome Web Store** に **アップロード + Submit for review まで自動化** + **Firefox AMO** に `web-ext sign --channel=listed` で並列 submit。Chrome step 失敗時も `if: success() \|\| failure()` で Firefox AMO step は独立実行する (ReplaceFontSelect 流派)。必要 Secrets: `CWS_*` (Chrome 4 件) + `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` (Firefox 2 件)。**listing (説明文 / スクリーンショット / カテゴリ) 変更時は CWS / AMO ともに API 更新エンドポイントが弱いため Dashboard で先行手動更新が必要**。 |
| `memory-bank/WebRestrictionRemoval/*.md` | プロジェクト横断の長期記憶（projectbrief / productContext / systemPatterns / techContext / activeContext / progress の 6 コアファイル）。activeContext と progress は頻繁更新、systemPatterns は設計パターン履歴。**ホスト側ファイルを直接 Read/Edit せず必ず memory-bank-mcp 経由で操作** |

## Important Patterns

新機能追加・既存機能の改修で踏むべき原則と、過去にハマった罠の対策。詳細はファイル冒頭コメントと該当セクションを参照。

### Firefox AMO 対応 (2026-05-16 確立、ReplaceFontSelect の知見ベース)

WebRestrictionRemoval は Chrome + Firefox 両対応。**v1.0.33 以降は音量ブースターも Firefox で部分動作する** (MES 経路で普通サイトのみ、EME 多用サイトは tabCapture 未対応のため不可)。Firefox 版ビルドの不変条件:

1. **専用 manifest 分割** — `manifest.firefox.json` を別ファイルで持ち、zip スクリプトが Firefox xpi 生成時に `manifest.json` として同梱する。Chrome 版とは以下が違う:
   - `offscreen` / `tabCapture` permission を **除外** (Firefox MV3 未対応)
   - `browser_specific_settings.gecko` に gecko id + `strict_min_version: "142.0"` + `data_collection_permissions: {required: ["none"]}` を追加 (v1.0.33 で 140 → 142 化。`data_collection_permissions` は Firefox Android 142+ で導入されたため strict_min_version 140 だと矛盾警告が出る)
   - **`background.scripts` 単独**（`service_worker` は記載しない / v1.0.33 で削除）。Firefox MV3 は `service_worker` を ignored 警告対象とするため。Chrome 版は manifest.json 側で従来どおり `service_worker` のみ
   - `minimum_chrome_version` 削除
   - `host_permissions: ["<all_urls>"]` を追加 (Firefox AMO 推奨)

2. **`importScripts` ガード** — `background.js` 冒頭は `if (typeof importScripts === "function") importScripts("/src/lib/actions.js");` でガードする。Firefox event page では importScripts は worker 限定 API のため呼べないが、manifest の `background.scripts` で actions.js を先に評価しているので skip して OK。

3. **`HAS_VOLUME_BOOSTER` ランタイム検知** — `const HAS_VOLUME_BOOSTER = typeof chrome.offscreen !== "undefined" && typeof chrome.tabCapture !== "undefined";` を background.js で定義し、`VOLUME_BOOSTER_SET_GAIN` / `VOLUME_BOOSTER_RELEASE_TAB` メッセージ handler、`chrome.tabs.onActivated` / `chrome.tabs.onRemoved` / `chrome.storage.onChanged` の音量関連経路で早期 return する。

4. **popup の UI 隠し** — `popup.html` の audio section に `id="audioGroupSection"` を付与、`popup.js` の DOMContentLoaded で `if (!HAS_VOLUME_BOOSTER) $audioSection.style.display = "none";`。section は DOM 上残るので `getElementById('volumeBoosterToggle')` が null にならず popup ロジック全体が壊れない設計。

5. **AMO 初回登録** — CI からは新規 add-on 作成不可。ローカルで `WEB_EXT_API_KEY=$AMO_JWT_ISSUER WEB_EXT_API_SECRET=$AMO_JWT_SECRET npx --no web-ext sign --source-dir=firefox-build --channel=listed --amo-metadata=.amo-metadata.json` を実行 → gecko id (manifest 内) で AMO 上に新規 add-on 自動作成。**初回完了後は CI の `publish-firefox` job が新バージョン提出を担う**。

6. **web-ext lint で受理性確認** — `npx --no web-ext lint --source-dir=firefox-build` で AMO validator 相当チェック。**v1.0.33 から errors / warnings / notices すべて 0 件達成済み**。過去に「許容済み warning」だった 4 カテゴリ (`BACKGROUND_SERVICE_WORKER_IGNORED` / `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` / `UNSUPPORTED_API` / `UNSAFE_VAR_ASSIGNMENT`) は #10 のパターンで全部 0 件化済み。新規 warning が出たら同じ手法で潰すこと。

7. **`if: success() || failure()` で Chrome / Firefox 独立実行** — publish.yml の `publish-firefox` job に必須。Chrome publish が同 version 重複 upload 等で失敗しても Firefox AMO step は連鎖 skip されず独立 submit される (ReplaceFontSelect が release/3.0.3 で踏んで確立した不変条件)。

8. **AMO listing は plain text 化される** — API 経由で送る `<ul>` 等は `&lt;ul&gt;` としてエスケープ保存される。リッチ HTML 表示は AMO Dashboard のリッチテキストエディタ経由のみ可能。`webstore/store-listing.firefox.{ja,en}.txt` は絵文字 + `・` 等で plain text 構造化済み。

9. **`web-ext sign --channel=listed` の `Approval: timeout exceeded` は warning 化済み** (v1.0.31 publish.yml で実装) — Mozilla の AMO 自動 sign は listed channel で動かないため、CLI は 15 分待って `WebExtError: Approval: timeout exceeded` で `exit 1` を返す。 ただし submission 自体は **AMO に受理済み** (ログ URL `addons.mozilla.org/.../versions/<id>` で確認可能)。publish.yml では `tee /tmp/web-ext.log` + `grep "Approval: timeout exceeded"` で検出時のみ `::warning::` + `exit 0` 化して CI を green に保つ。それ以外の `exit 1` (credentials 不備等) はそのまま fail として残す設計。同 version 再 push は AMO に重複拒否されるため、release/X.Y.Z への fast-forward は控える運用。

10. **AMO warning 完全 0 件化パターン (v1.0.33 で達成、8 件 → 0 件)** — 過去に「許容済み warning」として残していた 4 カテゴリを以下の対処で物理的に消した:
    - **`BACKGROUND_SERVICE_WORKER_IGNORED` (1 件)** → `manifest.firefox.json` から `background.service_worker` を削除し `background.scripts` 単独化（#1 参照）
    - **`KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` (1 件)** → `strict_min_version` を `"140.0"` → `"142.0"` に引き上げ（#1 参照）
    - **`UNSAFE_VAR_ASSIGNMENT` (innerHTML 動的代入、3 件)** → 2 経路で対処:
      - `src/content/video-gamma.js` の SVG filter は **`DOMParser("image/svg+xml")` + `document.importNode`** で構築。`createElementNS` は color-interpolation-filters の hyphen 属性で Chromium が filter 解決失敗する既知問題があるため不採用 → XML パーサに namespace 解釈を任せれば両 issue を回避
      - `src/popup/popup.html` の `data-i18n-html` は廃止し、**3 セグメント分割** に書き換え: `<span data-i18n="*Pre">前半</span><code>...</code><span data-i18n="*Post">後半</span>`。`code` の中身 (例: `<video>` / `/auto-deliveries`) は両言語共通の固定文字列なので HTML に直接書く。`popup.js` から `[data-i18n-html]` ハンドラを削除、`_locales/{ja,en}/messages.json` で `*Pre` / `*Post` キーペアに分割
    - **`UNSUPPORTED_API` (chrome.offscreen / chrome.tabCapture、3 件)** → **`__FIREFOX_STRIP_BEGIN__` / `__FIREFOX_STRIP_END__` マーカー方式**。`background.js` の `chrome.offscreen.createDocument` / `chrome.offscreen.closeDocument` / `chrome.tabCapture.getMediaStreamId` 呼び出しブロックをマーカーで囲み、`zip.ps1` / `zip.sh` / `.github/workflows/publish.yml` の Firefox source 構築ステップで `perl -i -0pe 's{\s*//\s*__FIREFOX_STRIP_BEGIN__.*?//\s*__FIREFOX_STRIP_END__\s*\n}{\n}gs'` で物理削除する。マーカー外側の `if (!chrome.offscreen) return false;` と `HAS_VOLUME_BOOSTER` guard は残るので、Firefox 環境では関数が早期 return し、AMO linter からは未対応 API 呼び出しが見えなくなる。**新規に Firefox 未対応 API を呼ぶコードを追加する場合は同じマーカーで囲むこと**。


### 設計の起点
- **`src/lib/actions.js` は単一情報源** — 新機能追加は actions.js から手をつける。Actions / StorageKeys / 機能 FEATURES 配列がここに集約され、popup の動的レンダリング → background の dispatch → content script の購読が全てここの定数を参照する。FEATURES に追加すれば popup UI は自動生成される。actions.js は古典的グローバル定数方式（ES modules ではない）で 4 経路で共有: ① background の `importScripts()`、② manifest content_scripts の最初のエントリで全 http(s) フレームに自動注入、③ popup.html の `<script>` タグ、④ offscreen.html の `<script>` タグ。
- **バージョン番号は手動で書き換えない** — `manifest.json` / `package.json` / `package-lock.json` の `version` フィールドおよびドキュメント中の `v1.x.y` 表記は `/vava` スキル経由でのみ更新する。コード変更コミットでバージョン番号には触れない。
- **デフォルト OFF 方針徹底** — 9 マスタートグル（セッション維持 / YouTube クリーナー / Amazon 合計 / Instagram クリーナー / TikTok クリーナー / 動画ガンマ補正 / ルーペ / RTX 動画強化 / 音量ブースター）が `onInstalled` で false 初期化、復元は `=== true` で防御的に判定。音量ブースターはマスター OFF に加え、ON でも「スライダー 100% かつ全サブトグル OFF かつミュート OFF」のときリソース解放される（インストール直後はマスター OFF かつ全サブトグル OFF = 完全に無処理）。ルーペもマスター OFF で content script 内の DOM / リスナーがすべて撤去される（Blob URL も revoke）。RTX 動画強化もマスター OFF で `removeAllHints()` で hint 要素を撤去 + MutationObserver 解除。

### メッセージング・content script
- **sender 検証必須** — background の各ハンドラ冒頭で `SenderCheck.isFromPopup()` / `isFromContentScript()` を呼ぶ。新メッセージ追加時はどちらの由来を許可するか明示。
- **content_scripts の二重ロード許容** — `actions.js` は **各 content_scripts エントリで個別にロード** する（manifest.json の各エントリの `js` 配列冒頭に含める）。同一 isolated world で複数回ロードされても `__cpaActionsLoaded` ガード (`src/lib/actions.js` 冒頭) で 2 回目以降は即 return するため、定数二重宣言エラーを起こさず安全。これにより各サイトエントリの実行順序や `run_at` 差異に依存せず、`actions.js` 依存を持つ全 content script が確実に `Actions` / `StorageKeys` 等の定数を参照できる。**例外: `document_start` 専用 early script (`youtube-early.js` / `instagram-early.js` / `tiktok-early.js`) は actions.js を含めない** (最速注入のため、生 storage key 文字列で書く)。理由: `document_start` 注入と `document_idle` 注入は別エントリ扱いだが、同一 isolated world で同じ `const` を二重宣言すると SyntaxError になるため、early は最小スクリプト + actions.js 非読込で衝突を防ぐ。
- **early script は共通フレームワーク経由** — `src/content/early-framework.js` が `<style>` 注入・pre クラス同期付与・`chrome.storage.local.get`・`storage.onChanged` 購読のボイラープレートを集約する (`window.__cpaEarlyFramework.setup(config)`)。各 document_start エントリの `js` 配列で `early-framework.js` を **先頭** に置き、各 early script (`youtube-early.js` / `instagram-early.js` / `tiktok-early.js`) が config を渡して setup を呼ぶ。新サイトの early script を追加する場合もこのパターンに乗せる。サイト固有の MutationObserver / force-hide / URL redirect は各 early script に残す (差異が大きすぎて framework に押し込むと config 肥大化する)。
- **二重実行防止** — `window.__cpaKeepAliveRunning` / `window.__cpaSearchFixerRunning` / `window.__amazonDeliveryTotalRunning` / `window.__ytShortsRemoverRunning` / `window.__cpaInstagramCleanerRunning` / `window.__cpaTikTokCleanerRunning` / `window.__cpaImageDownloaderRunning` / `window.__cpaVideoGammaRunning` / `window.__cpaLoupeRunning` / `window.__cpaRtxEnhancerRunning` / `window.__cpaYtEarlyRunning` / `window.__cpaIgEarlyRunning` / `window.__cpaTtEarlyRunning` のグローバルフラグで同一フレーム内の二重実行を防ぐ。新 content script を足すときも同じ命名で揃える。`__amazonDeliveryTotalRunning` と `__ytShortsRemoverRunning` のみ `__cpa` プレフィックスなしの歴史的命名（互換性のため変更しない、/rere レビュー B1-003）。
- **iframe 多重対策** — keepalive は `shouldFireHttpPing()` でトップフレーム or クロスオリジン iframe のみ ping を発射。同一オリジン iframe はトップに任せる。

### MutationObserver 取り扱い
- **DOM 書き戻しは observer guard 必須** — `subtree: true` 監視中に自身が DOM を書き戻すと再帰発火 → 無限ループでフリーズ。Amazon 月別合計の修正で確立した **`disconnect → render → takeRecords → observe` ガード + `requestAnimationFrame` coalesce** の二重防御を新規 DOM 書き込みロジックでも踏襲する。
- **cross-document な iframe 内 DOM 変化は MutationObserver で観察できない** — `subtree: true` でも iframe の中身は別ドキュメント扱いで届かない。iframe 内要素を相手にする場合は `iframe.addEventListener("load", ...)` で再評価タイミングを別経路で確保する（hideLiveChat の close button click はこのパターンに該当）。

### Extension context invalidation guard PATTERN SYNC (/rere v1.0.28+ 確立)
拡張機能リロード / 自動更新後、既存タブの content script は **orphan 化** する。`chrome.runtime.id` が `undefined` になり、`chrome.i18n.getMessage` / `chrome.runtime.sendMessage` 等が "Extension context invalidated" で throw する。MutationObserver / setInterval は orphan でも止まらないため、自前で停止する必要がある。

**実装済みファイル (10 ファイル)**: `image-downloader.js` / `amazon-delivery-total.js` / `search-fixer.js` (5 つの MO callback + pagehide + 共通 `cleanupAllSearchFixerStateForOrphan` で集約、/rere B2-012+B2-018 で v1.0.30 に追加) / `keepalive.js` / `video-gamma.js` / `loupe.js` / `rtx-enhancer.js` / `tiktok-cleaner.js` / `youtube-shorts.js` / `instagram-cleaner.js` (instagram-early.js / tiktok-early.js / youtube-early.js も同パターン)

**実装パターン** (PATTERN SYNC):
- 主要 timer / observer callback / 高頻度発火関数の入口で `if (!chrome.runtime?.id)` チェック
- 検知時に: ① 該当 timer の `clearInterval` / `clearTimeout` ② MutationObserver の `disconnect` ③ 必要なら body class / DOM marker / Blob URL の cleanup
- chrome API 非依存の cleanup 関数 (`removeAllOverlays` / `removeAllTotals` / `deactivate` / `cleanup` 等) は orphan 後でも安全に呼べる
- 1 回検知したらフラグで「以後検知しない」状態に固定して CPU 浪費ゼロ化

**新規 content script を書く場合**:
- timer / observer がある場合は **必ず** この PATTERN を踏襲
- 入口ガードは「主要発火経路 (300ms ポーリングなど)」に置き、保険的に複数箇所に置いてもよい
- 「実害は限定的」(observer callback の早期 return) でも CPU を持続的に食う経路があるので、無条件で `disconnect` する設計が望ましい

### hideLiveChat（YouTube ライブチャット非表示）
hideLiveChat は **iframe 内 close button の公式 click 1 つ** に責務を集約した最小設計に到達している (詳細フローは Architecture 章「YouTube クリーナー」の `hideLiveChat 体感ラグ消滅の先制非表示パターン」7 ステップ参照)。新機能を足すときに **絶対に復活させてはいけない過去の失敗経路** が複数あるため、ここで明文化しておく。

採用パターン (要約):
- `findLiveChatPanelCloseButton` → `iframe.contentDocument` 経由で `yt-live-chat-header-renderer #close-button button` を取得
- `fireUserLikeClick` で iframe の window から取った `PointerEvent`/`MouseEvent` で full sequence 発火
- `iframe.addEventListener("load", ...)` の idempotent hook で load 後 50ms に再評価
- **CSS 先制非表示で体感ラグ消滅** — `youtube-early.js` (document_start) が `<html>` に `__cpa-sfx-hide-live-chat-pre` を付与 → CSS で `ytd-live-chat-frame { display: none !important }` → click 成功で frame に `collapsed` 属性が付くまで rAF polling してから pre クラス剥がし → YouTube 公式 collapsed bar 表示。リトライ上限到達 / detach / OFF 切替の 3 経路で fail-safe に pre クラス剥がし（永久に隠れたままを防ぐ）
- **`visibility: hidden` ではなく `display: none` を採用** している (旧 visibility:hidden 案では layout 領域 402×964 px が空白枠として 2 秒残る実機問題があり置換済み)。pre クラスは click 成功で必ず剥がれる設計なので、過去 NG だった `__cpa-sfx-live-chat-force-hide` の「永続 display:none」とは別物

復活禁止の失敗パターン:
- 独自クラス `__cpa-sfx-live-chat-force-hide` を frame に付与 → frame ごと `display: none` で collapsed view ヘッダー（「パネルを開く」）まで消し、SPA 副作用も誘発
- `setAttribute("collapsed", "")` で標準属性を直接立てる → ライブ配信中で player 再初期化 →「動画を処理しています」エラー
- CSS `iframe.ytd-live-chat-frame { height: 0 }` (collapsed 条件付き or 無条件いずれも) → SPA panel state が不整合で player 副作用
- CSS `#chat-container:has(...) { display: none }` / `--ytd-watch-flexy-sidebar-width: 0` → 同上 + ユーザーが「パネルを開く」を再表示できなくなる
- frame 内の `#close-button` を top frame から `document.querySelector` で探す → そもそも iframe の中なので届かない（`iframe.contentDocument` 必須）
- pre クラス剥がしを click 成功 *直後* に行う → YouTube が collapsed transition を DOM 反映する前に display:none が解除され、frame default expand state が paint されてしまう (Edge 動画キャプチャで約 270ms expand 表示を確認)。必ず `collapsed` 属性付与を rAF polling で待つ

### 音量ブースター・MediaElementSource 経路 (v1.0.33+ デフォルト)

`src/content/volume-booster.js` (全 http(s) + all_frames:true) が `<video>` / `<audio>` 要素に直接 attach する経路。tabCapture と違って **user gesture 不要で自動適用** されるのが最大の利点。

**設計上の不変条件**:
- **EME ホスト早期 return** — 起動直後に `VolumeBooster.isEmeHost(location.hostname)` を判定し、`EME_HOSTS` (15 サイト) のいずれかにマッチしたら `return` で何もしない。MES attach すると EME (DRM) 保護動画は **動画の音そのものが完全無音化** する Chrome/Firefox 仕様のため、ホスト名ベースで予防する。新規 EME サイトを追加するときは `actions.js` の `VolumeBooster.EME_HOSTS` に正規表現を追加 + `test/actions.test.js` の isEmeHost テスト追加
- **WeakMap state 管理** — `WeakMap<HTMLMediaElement, AudioState>` で video/audio 要素 → state を保持。要素が DOM から外れれば GC で自動解放されるため、明示的な cleanup なしでメモリリークを防げる。WeakMap は iterate できないので、全 state 操作 (settings 反映 / detach 全体) は `document.querySelectorAll("video, audio")` で iterate して STATE.get で参照する設計
- **二重 attach 防止 3 層ガード** — `STATE.has(media)` (既 attach) + `EME_DETECTED.has(media)` (EME 検出済み) + `ATTACHING.has(media)` (進行中 race) の 3 つの WeakSet/WeakMap で防ぐ。MediaElementSource は同じ要素に対して 1 度しか attach できず、二重呼び出しは InvalidStateError
- **encrypted event で後発 EME 検出** — ホスト名で除外できないサイトで EME 動画再生時、`encrypted` イベント発火で `EME_DETECTED.add(media)` + `detachFromMedia(media)` を実行。ただし detach 後の音声経路復元はブラウザ実装依存で完全保証なし → ホスト名ブラックリストが第一防御線
- **autoplay policy 対応** — `play` イベントで `ctx.state === "suspended"` のとき `ctx.resume()` を試す。Chrome の autoplay policy で AudioContext が suspended で生まれるケースを防ぐ
- **ノード順序・ramp・preset は経路 B と完全共通** — `source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination` の 6 ノード接続、`setTargetAtTime` で 45ms ramp、`COMPRESSOR_BYPASS` preset で OFF 時パススルー化。コードは offscreen.js から物理コピーしたものなので、片方を更新したら必ず他方も同期する
- **MutationObserver で動的 video/audio 追従** — `observer.observe(document.documentElement, { subtree: true, childList: true })` で SPA navigation や lazy load された video にも自動追従。callback 冒頭で `chrome.runtime?.id` チェック (extension context invalidation guard) → orphan なら observer disconnect
- **UNITY release 条件** — gain 100% + 全サブトグル OFF + muted OFF のときは AudioContext を解放して完全 no-op に戻す (経路 B と同じ条件)
- **pagehide で全 cleanup** — observer.disconnect + 全 media 要素を detachFromMedia で AudioContext close

### 音量ブースター・Offscreen Document (EME fallback、v1.0.33+ は経路 B 専用)

v1.0.33 以降は経路 A (MediaElementSource) がデフォルトになり、この offscreen + tabCapture 経路は **EME 多用サイト (Netflix / Prime Video / DAZN 等) のフォールバック専用**。以下の不変条件は EME fallback で生き続ける。

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

### 外部 fetch allowlist 設計 (`ImageDownloader.ALLOWED_HOSTS`)
画像ダウンロード機能が許可する CDN ホストは `actions.js` の `ImageDownloader.ALLOWED_HOSTS` で regex 配列として宣言する。**任意サブドメインを通す広いパターンは禁止** (`evil.{cdn}.com` を allowlist 通過させて代理 fetch 攻撃面を作る)。

**採用パターン**:
- **Instagram fbcdn** は `scontent-` prefix 限定 (`/^scontent-[a-z0-9-]+\.fna\.fbcdn\.net$/` 等) — `evil.fbcdn.net` 等を通さない設計
- **TikTok** は `p\d+` プレフィックス必須 (`/^p\d+(-[a-z0-9-]+)?\.tiktokcdn(-us)?\.com$/`) — `evil.tiktokcdn.com` / `tracking.tiktokcdn-us.com` / `static.tiktokcdn.com` を全部拒否 (/rere レビュー A2-SC-1 で確立)
- 新サブドメインを追加する場合は **prefix 必須化** を守ること (実 prefix が「p<数字>」「scontent-」のような構造プレフィックスを持っている場合のみ許可)

**fetch セキュリティ 4 原則** (image-downloader.js / search-fixer.js / keepalive.js 共通):
1. `credentials: "omit"` — クロスオリジン Cookie 送信を回避
2. `redirect: "manual"` — 302 経由の第三者ドメインへの認証情報送信を遮断 (opaqueredirect は `r.ok === false` 扱いで自動スキップ)
3. `referrerPolicy: "no-referrer"` — リファラ送信ゼロ
4. `hostname` を `ALLOWED_HOSTS` で検証 — 攻撃者注入 `<img>` 経由の代理 fetch を防ぐ

### image-downloader 並列化のセマンティクス維持
`fetchFirstAvailable` は srcset の最大解像度から順に並んだ候補配列を受け取り、**「最初に 200 OK を返した最大解像度」** を採用する。
- 旧逐次実装: `for...of` で順次 fetch、最悪 N × RTT (体感 1-3 秒遅延)
- 新並列実装 (/rere C-#4 で確立): `Promise.allSettled` で全候補同時発射 → 全結果待ってから **配列順 (=解像度降順) で先頭 fulfilled を採用**
- `Promise.any` だと「最速応答」になり CDN のキャッシュヒット状況で低解像度が混入する罠 → **採用してはいけない**
- `signal.aborted` (ユーザー OFF) の検知は全 fetch 完了後の最終チェックで AbortError を throw する設計

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

### APPLY_SETTINGS 経路の partial payload 防御 (v1.0.31 で確立、「いつの間にか OFF」4 経路対策)

ユーザーが「拡張機能の更新で設定がいつの間にか OFF になる」と感じる現象は **コードレベルの 4 つの落とし穴** が原因。各経路は独立しているため **複合防御** が必須。新規 master トグル / storage key 追加時は本セクションのチェックリストを必ず通すこと。

**経路 A: サイト単位 ON 設計の不可視性 (UX)**
セッション維持のように「現在のサイト単位」で ON/OFF する設計だと、別サイトで popup を開いた瞬間にトグルが OFF 表示される → 「消えた」と誤認される。
- 対策: popup に「N サイト保存中」型のサマリバッジを必ず添える (`updateKeepAliveSitesCount()` パターン、i18n キーは `<feature>SitesCount` 形式)。サイト単位設計を採用する新機能でも同様に visualize する

**経路 B: popup 内変数の stale 化 race**
popup の `apply()` が popup load 時のスナップショット変数を元に storage を書き戻すと、複数 popup 同時開きや別経路書き換えで race が起きて他 popup の追加分が wipe される。
- 対策 1: popup の `apply()` 入口で対象キーを `chrome.storage.local.get(KEY)` で **再取得してからマージ**する。失敗時のみ popup 内変数フォールバック
- 対策 2: popup の `chrome.storage.onChanged` リスナーで対象キーを監視 → popup 内変数 + UI を即同期 (二重防御)
- 対策 3: 該当 syncing をヘルパー関数化 (`syncKeepAliveToggleFromState()` 等) して popup load 時の評価ロジックと共通化

**経路 C: handleApplySettings の partial payload による上書き**
`normalizeSettings(settings)` は `settings?.X === true` で正規化するため、popup が送らないキーは `undefined` → `false` に化けて全キー一括 storage 書き込みで既存 true が wipe される。
- 対策: `handleApplySettings` で **storage 既存値とマージしてから** normalize する。`APPLY_SETTINGS_KEYS` 配列で対象キーをホワイトリスト化:
  ```js
  const existing = await chrome.storage.local.get(APPLY_SETTINGS_KEYS).catch(() => ({}));
  const merged = { ...existing, ...(settings ?? {}) };
  const normalized = normalizeSettings(merged);
  await chrome.storage.local.set(toStorageRecord(normalized));
  ```
- popup の `apply()` が全キーを送る現行設計と組み合わせて二重防御。新規 storage key を追加したら `APPLY_SETTINGS_KEYS` にも追加すること

**経路 D: popup の stored get リスト欠落 (致命バグパターン、RTX で発覚)**
popup load 時の `stored = await chrome.storage.local.get([...keys])` リストと、stored 参照箇所 (`stored[KEY]`) は完全に対応している必要がある。**get リストに無いキーを参照すると `undefined` → UI で常に false 表示 → apply() で false 上書き → storage の既存 true が破壊**される。
- 対策: 新規 master トグル / 設定キー追加時の **6 ポイントチェックリスト** を必ず通す
  1. `StorageKeys.<KEY>` を `src/lib/actions.js` に追加
  2. `onInstalled` の defaults 初期化リスト (`background.js`) に `<KEY>` を追加
  3. `APPLY_SETTINGS_KEYS` / `normalizeSettings` / `toStorageRecord` の 3 関数全てに `<KEY>` を追加 (drift 防止)
  4. **popup の `stored = chrome.storage.local.get([...])` リストに `<KEY>` を追加** ⚠️
  5. popup の `apply()` payload に `<KEY>` を含める
  6. `test/actions.test.js` の `SettingsSchema` 整合アサートで件数を更新
- 過去事例: v1.0.31 で `RTX_ENHANCER_ENABLED` が #4 だけ漏れていて、popup 表示が常に OFF → 別トグル変更で storage 上書き → 永久 OFF 化する致命バグを修正

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
