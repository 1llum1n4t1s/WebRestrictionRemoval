# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vuora は Chrome 拡張機能 (Manifest V3)。Web ブラウジングを快適にする 11 機能を提供する。

### 機能カウント早見表（単一情報源）

本文で出てくる「N 機能」「N サブ機能」「N マスタートグル」の数字はすべて以下の単一情報源を参照する。CI で drift 検知される値のみここに書く（CLAUDE.md 内 drift 防止）。

| カウント名 | 値 | 単一情報源（drift 検知元） |
|---|---|---|
| 機能カテゴリ | 11 | `SettingsSchema` + `test/actions.test.js` |
| マスタートグル | 7 | popup.html toggle-row 数（カラーピッカー除く 10 機能のうち 4 機能 = Shorts / Amazon ランキング / Amazon バッジ / 黒帯除去 は他 master の配下サブ機能扱い） |
| YouTube クリーナー サブ機能 | 32 | `SearchFixer.FEATURES`（内訳: 検索ノイズ除去 + Shorts 5 + 動画ページ整形 + 登録チャンネル拡張 3 + 接続モニター 1 + 配信時刻オーバーレイ 1 等） |
| Instagram クリーナー サブ機能 | 11 | `InstagramCleaner.FEATURES` |
| TikTok クリーナー サブ機能 | 3 | `TikTokCleaner.FEATURES` |
| Firefox 提供機能 | 10 | 上記 11 − 音量ブースター（tabCapture 未対応） |
| `globalThis` 公開定数 | 22 | `actions.js` + ScanRunner + AudioPipeline + CleanerCore |
| カラーピッカー履歴上限 | 20 件 | `ColorPicker.HISTORY_LIMIT` |
| popup タブ数 | 5 | `PopupTabs.ALL`（調整 / YouTube / Instagram / TikTok / カラーピッカー） |

### 機能一覧

1. **YouTube クリーナー** — Shorts 削除・コメント欄非表示・ライブチャット非表示・登録チャンネル拡張・接続モニター・配信時刻オーバーレイ（配信アーカイブに配信時刻を重ねる）を含む 32 サブ機能
2. **Amazon 定期おトク便 月別合計**
3. **Amazon ランキングへ移動ボタン** — 商品詳細欄の売れ筋リンクを商品情報最上部に集約、一番細かいサブカテゴリへ同タブ移動
4. **Amazon 販売元・出荷元バッジ** — 緑（Amazon 直販）/ オレンジ（マーケット出品）の視覚区別、判定は `isInternal` JSON フラグ最優先
5. **Instagram クリーナー** — 11 サブ機能
6. **TikTok クリーナー** — 3 サブ機能（コメント欄非表示 / おすすめアカウント非表示 / 画像ダウンロード）
7. **音量ブースター** — 自動歪み防止 / ナイトモード / ミュートトグル + **10 バンドグラフィックイコライザ (プリアンプ + プリセット)**、設定グローバル永続化、タブ切替で自動適用
8. **動画ガンマ補正** — SVG `<feComponentTransfer type="gamma">` 独自実装、全タブ共通スライダー
9. **動画の黒帯除去** — ウルトラワイド画面で動画の上下/左右の黒帯をズーム/引き伸ばしで除去、動画縦横比は自動検出
10. **ルーペ** — `chrome.tabs.captureVisibleTab` で取得した JPEG 静止画を `background-position` で追従表示、倍率 3 段階 / サイズ可変
11. **カラーピッカー** — EyeDropper API ベース、popup 内完結

### 設計方針

- **デフォルト OFF オプトイン**: 11 機能のうち 10 機能がマスタートグル付き、**全てデフォルト OFF**（カラーピッカーは popup タブとして常時利用可）。サイト挙動を勝手に書き換えない方針。
- **独立機能ではないサブ統合**:
  - 接続モニター = YouTube クリーナーのサブ機能 `connectionMonitor`（master `searchFixerEnabled` AND で制御）
  - 画像ダウンロード = Instagram / TikTok 各クリーナーのサブ機能として共通実装（YouTube では未提供）
- **外部送信ゼロ + 1 例外**: すべての機能はクライアントサイド DOM/CSS 操作と Chrome 標準 API のみによる独自実装で外部送信ゼロ。**例外**: 接続モニター ON 中の YouTube ライブ視聴時のみ 5 秒周期で `https://www.gstatic.com/generate_204` と `https://speed.cloudflare.com/__down?bytes=10` への RTT 計測 fetch（`mode: "no-cors"` + `credentials: "omit"` + `referrerPolicy: "no-referrer"`、レスポンス本文は破棄、識別子・cookie・ユーザーデータは送信せず）。
- **バージョン管理**: バージョン番号は `/vava` スキル経由でのみ更新する（コード変更コミットで `manifest.json` / `package.json` / `pnpm-lock.yaml` の version フィールドには触らない）。
- **旧呼称 drift check**: Vuora 改名前の「WEB閲覧アシスト」「Web Viewing Assist」「Web Restriction Removal Helper」が privacy-policy.en.md の `formerly` 表記以外で意図せず残ってないか定期確認:
  ```bash
  rtk grep -i "WEB閲覧アシスト\|Web Viewing Assist\|Web Restriction Removal Helper" --exclude-dir=node_modules --exclude=*.lock
  ```

popup は **5 タブ構成** (`調整 / YouTube / Instagram / TikTok / カラーピッカー`)。タブ順序は `PopupTabs.ALL` 配列で管理、`POPUP_LAST_TAB` storage key に最後のタブを永続化。

設定は `chrome.storage.local` の各 boolean / 数値キーで保存。UI は **Chrome i18n API でローカライズ**（ブラウザ UI 言語が `ja` → 日本語 / それ以外 → 英語にフォールバック）。`manifest.json` の `default_locale: "en"` + `_locales/{en,ja}/messages.json` を単一情報源とし、popup 静的テキストは `data-i18n` 属性、popup の動的テキストと content script の DOM 注入テキストは `chrome.i18n.getMessage()` 経由で取得する。コードコメント / `console.log` メッセージは開発者向けで日本語のまま残す。**インストール直後は全マスタートグル OFF**（音量ブースターもマスター OFF かつ全サブトグル OFF = 完全に無処理）。サイト挙動を勝手に書き換えないオプトイン方針。バージョン番号は `/vava` スキル経由でのみ更新する。

## Build Commands

```bash
pnpm install                  # 初回 / 開発用
pnpm run ci:install           # CI 用 (pnpm install --frozen-lockfile。lockfile 厳守)
pnpm run build                # アイコン + スクリーンショット一括生成
pnpm run generate-icons       # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
pnpm run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer, concurrency=2)
pnpm run lint                 # ESLint v10 flat config + no-implicit-globals (warn) + 25 globalThis 定数列挙 (actions.js 22 + ScanRunner + AudioPipeline + CleanerCore、/rere D-004 + /opop Phase 1 で導入、v1.0.31 で Dependabot 経由 v10 化)
pnpm test                     # Node.js 標準 test runner（syntax-check.test.js が src/**/*.js 全 24 ファイル構文 check + actions.test.js が FEATURES 件数アサート + ALLOWED_HOSTS scontent- prefix + 音量ブースター 5 キー + EQ 定数・clamp・プリセット (eargasm/eargasmKai/perfect/perfectKai 値固定 drift 検知含む) + cdninstagram scontent- prefix + Loupe pure function 群 + extractHandleFromHref の Unicode 境界値 + SettingsSchema 整合 + APPLY_SETTINGS_KEYS/toStorageRecord generated 検証 + popup get list drift 検知 + AmazonMerchantInfo.parseIsInternal/isAmazonOwnedName 境界値 + BroadcastClock 純粋関数境界値 + 撤去済み機能 drift 検知（自動音量正規化を含む）を含む、合計 127 ケース）
powershell -ExecutionPolicy Bypass -File zip.ps1  # ストア申請用 ZIP (Windows、Unix は ./zip.sh)
```

## Development Workflow

### Chrome に未パッケージ拡張機能をロード
1. `chrome://extensions` を開く → デベロッパーモード ON
2. 「パッケージ化されていない拡張機能を読み込む」→ プロジェクトルートを選択
3. コード変更後は拡張機能カードの 🔄 リロードボタン
4. content script 変更時は対象タブを再読込、background SW 変更時は SW 再起動が必要

### JS 構文チェック / テスト
コード変更後は以下 1 コマンドを実行（構文 check + 純粋関数テスト + drift 検知をすべて含む）:

```bash
pnpm test
```

内訳:
- `test/syntax-check.test.js` が `src/**/*.js` 全 24 ファイルを `vm.compileFunction` で動的列挙 + 構文 check（content_scripts 追加・削除の手動 drift 防御）
- `test/actions.test.js` が `globalThis` 22 個公開 / FEATURES 件数 / Loupe 純粋関数 / extractHandleFromHref Unicode 境界値 / BroadcastClock 純粋関数（videoId 抽出 / liveBroadcastDetails パース / 配信時刻算出 / yyyy/MM/dd　hh:mm:ss 整形）境界値 / SettingsSchema 整合 / **撤去済み機能 drift 検知（自動音量正規化を含む）** / **EQ 定数・clamp 関数・プリセット境界値・コミュニティ 4 プリセット (eargasm/eargasmKai/perfect/perfectKai) 値固定** 等 100+ ケースをアサート

Lint は ESLint v10 flat config:

```bash
pnpm lint
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
                        ──APPLY_SEARCH_FIXER_CS / APPLY_AMAZON_DELIVERY_TOTAL_CS
                          / APPLY_INSTAGRAM_CLEANER_CS / APPLY_TIKTOK_CLEANER_CS / APPLY_VIDEO_GAMMA_CS
                          / APPLY_LOUPE_CS / APPLY_IMAGE_DOWNLOADER_CS──▶ 各 Content Script

[音量ブースター tabCapture 経路 (全サイト一律・唯一の経路。Netflix / Prime Video 等 EME 動画も含む)]
  Popup ──VOLUME_BOOSTER_SET_GAIN (gain, antiClip, nightMode, muted, eqEnabled, eqGains, eqPreamp)──▶ Background
                                    │ URL 分岐なし。active tab に対して常に呼ぶ
                                    │ chrome.tabCapture.getMediaStreamId (user gesture = popup open)
                                    ──ACTION_VOLUME_SET_GAIN──▶ Offscreen Document
                                                                  │ getUserMedia + AudioContext
                                                                  │ source → preampNode → eqFilters[0..9] → nightModeNode → gainNode → antiClipNode → destination
                                                                  └ EME 動画でも decrypted output を捕獲して増幅
  ※ popup は (gain, antiClip, nightMode, muted, eqEnabled, eqGains, eqPreamp, eqPreset) を chrome.storage.local にも書くが、
    これは boost トリガーではなく永続化のみ (popup 復元 + autoApplyVolumeBooster がタブ切替時に参照)。
  ※ ブースト中のタブには Chrome の「このタブのコンテンツは共有されています」バナーが出る (tabCapture 仕様、抑止不可)。

[ルーペ]
  Content Script ──LOUPE_REQUEST_CAPTURE──▶ Background
                                              │ chrome.tabs.captureVisibleTab(windowId, {jpeg, quality:70})
                                              └ JPEG DataURL を sendResponse で返却 → content script が Blob URL 化して lens に貼付
```

### Popup (`src/popup/popup.html`, `src/popup/popup.js`, `src/popup/popup.css`)
5 タブ構成（調整 / YouTube / Instagram / TikTok / カラーピッカー）。**7 マスタートグル**（YouTube クリーナー / Amazon 合計 / Instagram クリーナー / TikTok クリーナー / 動画ガンマ補正 / ルーペ / 音量ブースター）+ 音量ブースタースライダー（左端にミュート 🔊/🔇 ボタン）+ 音量サブトグル × 2（自動歪み防止 / ナイトモード）+ **イコライザパネル（オン/オフ トグル + プリセット dropdown + プリアンプ縦スライダー + 10 バンド縦スライダー）** + 動画ガンマスライダー（中央 1.0 = 補正なし、左 3.0 で暗く、右 0.3 で明るく）+ ルーペ倍率セグメント（1.5× / 2.5× / 4×）+ ルーペサイズスライダー（150〜1000px）+ 各クリーナー専用パネル × 3（YouTube クリーナー 32 機能 / Instagram クリーナー 11 機能 / TikTok クリーナー 3 機能）。Shorts 削除・コメント欄非表示・接続モニター・配信時刻オーバーレイは YouTube クリーナーのサブ機能（`removeShortsShelf` 等 / `hideComments` / `connectionMonitor` / `broadcastClock`）として統合され、専用パネルのアコーディオン（接続モニター・配信時刻オーバーレイは `watch_page` カテゴリ）に FEATURES 駆動で自動描画される。幅 460px。トグル変更で即 `APPLY_SETTINGS` を background へ送信、設定は `chrome.storage.local` から復元（未設定時 false）。音量ブースターのマスタートグル OFF 時はスライダー・サブトグル・ミュートボタンを `.volume-disabled` で dim 化。ルーペ ON 時のみ倍率セグメント + サイズスライダーが表示される（`.sub-block.hidden` トグル）。

**クリーナーアコーディオン**: サブ機能行は **1 行 1 トグル + 説明文** の縦積みレイアウト。各機能の `desc` は `actions.js` の `SearchFixer.FEATURES` / `InstagramCleaner.FEATURES` を単一情報源として popup.js が動的にレンダリングする（FEATURES に追加するだけで UI 自動生成）。

**テーマ**: ROG (Republic of Gamers) inspired hardware HUD。アクセントカラーは ROG クリムゾン（ライト `#a8081e` / ダーク `#b80828`、変数 `--rog-red`）+ ガンメタル基調背景（ライト `#f0f0f2` / ダーク `#0a0a0c`）。装飾は左右非対称 + 斜めスラッシュ + ヘキサゴンメッシュ SVG + カーボンファイバー風 repeating-linear-gradient + メタリックベベル（`--bevel-top` / `--bevel-bottom`）の 4 層構成。`clip-path: polygon()` で装甲パーツの角カット表現。`<meta name="color-scheme" content="light dark">` でネイティブ要素を `prefers-color-scheme` に追従させ、CSS は `:root` のライト用トークン + `@media (prefers-color-scheme: dark)` のダーク上書きの 2 層構造。派生色は `color-mix(in srgb, var(--rog-red) N%, ...)` で本体色から導出してテーマ追従可能化。CSP meta 明示。詳細な設計判断は popup.css 冒頭コメント L1-44 を参照。

**音量ブースター親トグル**: `volumeBoosterEnabled` (boolean) で master 制御。音量ブースターは **tabCapture 経路一本**（background → offscreen、URL 分岐なし・全サイト一律）。popup の `pushVolumeNow` は (1) 音量関連キー (lastGain + サブトグル 2 + ミュート) を `chrome.storage.local.set` で **永続化** (boost トリガーではなく popup 復元 + `autoApplyVolumeBooster` 用)、(2) active tab に対して常に `VOLUME_BOOSTER_SET_GAIN` を background に送り tabCapture → offscreen で boost する。OFF で `chrome.storage.local.set` のみ（background の `storage.onChanged` リスナーが `releaseAllVolumeBoosterTabs()` で全 AudioContext を解放）。**OFF でも gain / サブトグル設定は storage に残す**（次回 ON 時に復元）。`chrome.tabCapture` は user gesture 必須なので **popup を開かないと boost されない**（自動適用は無し）。ブースト中タブには Chrome のタブ共有バナーが出る。

**音量スライダー / サブトグル**: input 時 120ms debounce → `pushVolumeNow`（`gain`, `antiClip`, `nightMode`, `muted`, `eqEnabled`, `eqGains`, `eqPreamp` を全部 storage に書く + active tab へ tabCapture 経路で送る）。change（マウスアップ）で即 push、100% に戻すボタンは `pushVolumeNow(100)` で release 経路へ。popup 起動時は `chrome.storage.local` の `volumeBoosterLastGain` からスライダー初期値を復元する（offscreen への round-trip 不要）。スライダー UI は 0..200 の内部値を使い、左端 0% / 中央 100% / 右端 600% の実音量へ変換する。マスター ON 時のみ popup open で即座に `pushVolumeNow` して active tab に適用。サブトグル (`volumeBoosterAntiClipEnabled` / `volumeBoosterNightModeEnabled`) は change で `cancelVolumePush` → `pushVolumeNow(currentGain)` の順で即時反映（既存 AudioContext があれば compressor 状態だけ切り替わり音切れなし）。エラーは `formatVolumeError(res.error)` で日本語に翻訳。

**イコライザ（10 バンドグラフィック EQ）**: 音量ブースターのサブ機能として統合。`volumeBoosterEqEnabled` (boolean、master OFF) + `volumeBoosterEqGains` (10 要素配列、各 ±12dB) + `volumeBoosterEqPreamp` (±12dB) + `volumeBoosterEqPreset` (`flat` / `bassBoost` / `trebleBoost` / `vocal` / `loudness` / `custom`) の **4 storage key** で管理。バンド = 32 / 64 / 125 / 250 / 500 / 1K / 2K / 4K / 8K / 16K Hz、Q=1.41 の 10 個の `BiquadFilterNode(type:"peaking")` を直列接続。popup ではプリアンプ + 10 バンドの縦スライダー (writing-mode: vertical-lr) + プリセット `<select>` を `VolumeBooster.EQ_BANDS` 駆動で動的生成し、手動でスライダーを動かすと自動で `custom` に切り替わる。EQ ON のときは 100% でも AudioContext を維持する（UNITY release 条件に `!eqActiveFlag` を追加）。**EQ_GAINS / EQ_PREAMP は popup → storage 直書きで `storage.onChanged` 同期から除外**（メイン音量スライダー `LAST_GAIN` と同じ非対称設計。self-write feedback でドラッグ中の値が clamp+整数化値で上書きされてカクつくのを防ぐ。`EQ_PRESET` は離散値で feedback 連続性問題がないため select 表示のみ同期）。撤去した自動音量正規化と違い**固定フィルタでフィードバックなし**なので決定論的に安定する。

### Background (`src/background/background.js`)
Service worker。役割:
1. **設定の集約と各 content script への配布**: `APPLY_SETTINGS` を popup から受信し、`handleApplySettings` で **storage 既存値とマージしてから** `normalizeSettings` → `chrome.storage.local.set` + `notifyContentScripts` の順で処理する (`APPLY_SETTINGS_KEYS` 列挙ベースの merge 防御、Important Patterns「APPLY_SETTINGS 経路の partial payload 防御」参照)。`notifyContentScripts` は 5〜8 個の `chrome.tabs.sendMessage` を **`Promise.all` で並列発射** し、各 send は `safeSendMessage` ヘルパーで `.catch(() => {})` 集約 (受信側不在は expected error として silent skip)。YouTube タブ / Amazon `auto-deliveries` タブ判定は URL パターンで条件付き dispatch。
2. **Offscreen Document ライフサイクル管理**: `ensureOffscreenDocument()` で並行作成ガード、`scheduleOffscreenClose()` で 30 秒アイドル後に自動クローズ。**音量ブースト中タブが残っている間は close を再延期**（`isVolumeBoosterActive` で確認、SW 再起動直後は安全側に倒す）。`reasons` は `["USER_MEDIA", "AUDIO_PLAYBACK"]`。
3. **音量ブースター制御**: `setVolumeBoosterGain(tabId, gain, antiClip, nightMode, muted, eqEnabled, eqGains, eqPreamp)` がエントリ。UNITY release 条件（EQ ON でも維持）・既存 AudioContext 経路・compressor preset / EQ preset 適用・ミュート時の gain ramp to 0 の詳細は Important Patterns 参照。
4. **音量ブースター自動適用**: `chrome.tabs.onActivated` で `autoApplyVolumeBooster(tabId)` を呼び出し。**既に boost 中のタブのみ**（`boostedTabIds.has(tabId)` ガード）が対象。新規タブは `tabCapture.getMediaStreamId` の user gesture 要件によりpopup open が必要。`chrome.storage.onChanged` で `volumeBoosterEnabled` が `false` になったら `releaseAllVolumeBoosterTabs()` で全 AudioContext を即座に解放（SW 再起動後 `boostedTabIds` が空の場合は offscreen に `ACTION_VOLUME_RELEASE_ALL` を直接送信するフォールバック経路あり）。
5. **Message Handler の sender 検証**: `SenderCheck.isFromPopup` / `isFromContentScript` ヘルパーで由来を検証。`APPLY_SETTINGS` / `VOLUME_BOOSTER_*` は popup 由来のみ受け付ける。
6. **タブクローズで自動 release**: `chrome.tabs.onRemoved` で `ACTION_VOLUME_RELEASE_TAB` を offscreen に送信(permission 不要、SW 再起動でも永続的に発火する)。
7. **設定マイグレーション**: `onInstalled` で旧キー削除 + 未設定キーの初期化（詳細は Important Patterns の「マイグレーション」を参照）。
8. **ルーペ用 captureVisibleTab**: content script からの `LOUPE_REQUEST_CAPTURE` を受け、`chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 })` を実行して JPEG DataURL を `sendResponse` で返す。`SenderCheck.isFromContentScript` で由来検証、sender.tab から targetTab を解決。Chrome 公式 2fps quota は content script の 500ms debounce で対応。

`chrome://`, `edge://`, `about:`, `file://` などの非 HTTP(S) ページにはメッセージ送信をスキップ（`content_scripts.matches` が `http(s)://*/*` のみのため）。

### Offscreen (`src/offscreen/offscreen.html`, `src/offscreen/offscreen.js`)
音量ブースター専用の extension-context ドキュメント。`chrome-extension://` は常に secure context のため `getUserMedia({ chromeMediaSourceId })` が動く。`audioStates` Map で tabId → `{ ctx, gainNode, preampNode, eqFilters, nightModeNode, antiClipNode, stream, lastSetPercent }` を保持。14 ノードチェーン (preamp + EQ 10 バンド + nightMode + gain + antiClip) の構築・preset 切替・gain ramp の詳細は **Important Patterns 「音量ブースター・Offscreen」** を参照。release 時は `stream.getTracks().stop()` → `ctx.close()` の順（逆順だと生きているソースから出力先消失でエラー）。`pagehide` で全 audioStates を cleanup。streamId は `typeof streamId !== "string"` 型チェック + 印字可能 ASCII (`/^[\x21-\x7e]{4,1024}$/`) regex で検証してから `getUserMedia` に流す（過去に厳格すぎる `^[a-zA-Z0-9_:.\-]{8,256}$` で誤拒否が出たため緩めて、「制御文字・空白を含まない」「長さが妥当」程度の保守的検証に再導入。background 経由で不正値が混入した場合の防御一段確保が目的）。`mandatory.chromeMediaSource = "tab"` 形式を先に試し、失敗時のみフラット `chromeMediaSourceId` にフォールバック。

### YouTube Shorts Removal (`src/content/youtube-shorts.js`)
`*://*.youtube.com/*` 限定の content_scripts エントリで `all_frames: false`（top frame のみ）に注入。`window === window.top` チェックで埋め込みプレーヤーには注入せず CPU 負荷を抑える。

**5 サブ機能 + 1 グローバル nav**: Shelf / Chip / Sidebar / Redirect / Btn の 5 サブ機能と「ホーム / Shorts / 登録チャンネル」global nav を 1 ファイルで担当。CSS は機能ごとに `__cpa-yt-shorts-hide-shelf` / `__cpa-yt-shorts-hide-chip` / `__cpa-yt-shorts-hide-sidebar` / `__cpa-yt-shorts-redirect-active` クラスを `<html>` に付け外し（per-feature 独立化、Codex P2 指摘で v1.0.18 にて分割済）。

**YouTube クリーナーへの統合**: 独立 storage key と独自メッセージは持たず、YouTube クリーナーのサブ機能として動作（`searchFixerFeatures.removeShortsShelf` / `removeShortsChip` / `removeShortsSidebar` / `redirectShortsUrl` / `removeShortsBtn`）。アクティブ判定は `searchFixerEnabled === true` AND 各 features フラグの AND。`APPLY_SEARCH_FIXER_CS` メッセージを search-fixer.js と共に購読する（同一 isolated world で同じメッセージを 2 ファイルが受けて、それぞれの責務に応じて反応する設計）。`storage.onChanged` は片方の key だけ変わった場合に備え、両 key を再取得してから `computeActive()` で判定する（変更されてないキーが undefined になる罠を回避）。

**サイドバー 多言語対応**: `aria-label="Shorts"` (英語) と `aria-label="ショート"` (日本語) を CSS selector に併記する。日本語ロケールの初期 flash を CSS で即時非表示にするため。`title` 属性も同様。

### YouTube クリーナー (`src/content/search-fixer.js`)
`searchFixerEnabled` (master) と `searchFixerFeatures` (オブジェクト) と `searchFixerGridItems` (数値: 0/4/5/6) の 3 キーで管理（変数名は履歴的に `searchFixer*` を使用）。32 機能の単一情報源は `actions.js` の `SearchFixer.FEATURES`。実装: top frame 限定で MutationObserver + `yt-navigate-finish` / `yt-navigate-start` イベントで onSettingsChanged を再実行（SPA navigation で CLASS_PROCESSED マーカーをリセットするため）。マスター OFF 時は observer / 注入 CSS / 装飾クラスをすべて停止。**Shorts 5 サブ機能の実装は search-fixer.js ではなく youtube-shorts.js が担当**（責務分離: SPA URL リダイレクト + サイト横断 DOM 削除は検索ページ限定の clean-up とは別レイヤ）。

**`hideComments` 実装上の注意**: `applyWatchPageClasses()` は `<html>` に `__cpa-sfx-hide-comments` クラスを付け外しする実装で、**`isWatchPage()` 判定を経由せず無条件に呼ぶ**こと。watch page 限定にすると SPA で video → home に遷移したとき `<html>` クラスが残置されて他ページに副作用が出る（CodeRabbit レビューで実際に指摘された罠）。CSS 側は `html.__cpa-sfx-hide-comments ytd-comments#comments { display: none !important; }` で watch page 以外には影響しないため、JS は無条件 toggle で良い。

**`hideLiveChat` 実装上の注意**: hideLiveChat の close 操作の本体はすべて JS 経由で行う。実装は `ytd-live-chat-frame` 配下の iframe (`youtube.com/live_chat_replay`) 内の `yt-live-chat-header-renderer #close-button button[aria-label="閉じる"]` を **`iframe.contentDocument` 経由で取得し**、`fireUserLikeClick` で **full pointer/mouse event sequence** (`pointerdown → mousedown → pointerup → mouseup → click`) を発火する。youtube.com same-origin かつ sandbox 制約なしなので contentDocument にアクセス可能。**frame・iframe・親 `#chat-container`・theater 用 `--ytd-watch-flexy-sidebar-width` には一切触らない**（過去にこれらを CSS や独自属性で操作するたびに player 再初期化 / レイアウト崩れ / 「動画を処理しています」エラー / 再展開不能などの副作用を起こした経緯。なお「動画を処理しています」自体は YouTube 側のタイミング bug だが、保守的に介入は避ける方針）。close button が見つからない場合は何もしない。MutationObserver は cross-document な iframe 内 DOM 変化を観察できないため、`iframe.addEventListener("load", ...)` を `__cpaLiveChatLoadAttached` marker で idempotent に hook し、load 後 50ms で `collapseLiveChatIfNeeded` を再実行することで close button が ready になったタイミングを取りこぼさない。fireUserLikeClick は `btn.ownerDocument.defaultView` 経由で iframe の window から `PointerEvent`/`MouseEvent` constructor を取得する（別 realm の event 扱いを避けるため）。

**hideLiveChat 体感ラグ消滅の先制非表示パターン**: 上記 click ベース実装は「公式 close button の hydration 待ち + click 発火」までの数百 ms、ライブチャット枠が完全展開状態で見えてしまう体感ラグがある。これを消すため、**`document_start` で `<html>` に `__cpa-sfx-hide-live-chat-pre` クラスを付け、CSS で `ytd-live-chat-frame { display: none !important; visibility: hidden !important }` を当てる先制非表示**を入れる (※`display: none` を主とし、SPA 遷移で YouTube が frame に inline `display:flex` を当てた 1 フレームでも class セレクタが負けてコメント本体が見えないよう `visibility: hidden` を併用する。旧「visibility:hidden 単独」は layout 領域 402×964 px が空白枠として 2 秒残る実機問題があったが、display:none が主で効く限り layout は出ないため再発しない。詳細は手順 2 参照):

1. **`src/content/youtube-early.js`**: 新規 content_scripts エントリ（`*://*.youtube.com/*` / `run_at: document_start` / 単独エントリ）。actions.js は読み込まず生 storage key 文字列で書く最小スクリプト。**オプトアウト方式 + `<style>` inline 注入**: (a) `<style id="__cpa-sfx-early-hide-live-chat">` を `<html>` 直下に同期 prepend して CSS rule を即時 effective 化、(b) `<html>` に `__cpa-sfx-hide-live-chat-pre` を **同期で無条件付与**、(c) `chrome.storage.local` から `searchFixerEnabled` / `searchFixerFeatures` を非同期取得、(d) master OFF または hideLiveChat OFF なら剥がす（対象は `/watch` + `/live` URL で、それ以外は早期 return で動作しない。/rere B2-2 で `/live` 直アクセスも対象化）。**`<style>` inline 注入の理由**: search-fixer.css は manifest css 経由で挿入されるが、SPA navigation や frame DOM 追加タイミングによっては CSS rule の effective 化が paint cycle に間に合わないケースが Edge Trace で確認されたため、youtube-early.js 自身で CSS rule を確保する保険。**オプトアウト方式の理由**: オプトイン方式（storage 確認後に付与）だと `chrome.storage.local.get` の async 待ち（数十 ms）の間に frame が DOM 出現してチャット枠が一瞬見えてしまう実機問題があったため。OFF ユーザーには frame hydration 完了前 (数百 ms) に剥がし完了するので実質見えない
2. **`search-fixer.css`**: `html.__cpa-sfx-hide-live-chat-pre ytd-live-chat-frame { display: none !important; visibility: hidden !important; }`。**`display: none` を主とし `visibility: hidden` を併用する**（SPA 遷移で YouTube が frame に inline `display:flex` を当てた 1 フレーム、class セレクタの display:none は inline に負けるが、YouTube は expand 時に visibility を触らないため visibility:hidden が子孫=コメント本体(iframe)に継承されて勝ち、一瞬チラ見えを防ぐ。/rere D-1/B1-A1。youtube-early.js の inline force-hide も display+visibility 両方を当てる）。旧「visibility:hidden 単独」は layout 領域 (402×964 px) が約 2 秒間空白枠として残る問題があったが、display:none が主で効く限り layout は出ないため再発しない。pre クラスは click 成功 / リトライ上限到達 / detach の 3 経路で必ず剥がされる設計なので、過去 NG だった `__cpa-sfx-live-chat-force-hide` の「永続 display:none」とは違い、数秒間だけ display:none + visibility:hidden → click 成功で剥がし → YouTube 公式 collapsed bar 表示、というフローになる。「動画を処理しています」エラーは YouTube 側のタイミング bug で CSS 介入とは無関係
3. **`search-fixer.js` の `syncLiveChatCollapse`**: 入口で `<html>.classList.add(LIVE_CHAT_PRE_HIDE_CLASS)`（初回直アクセスは youtube-early.js が付与済みなので idempotent）
3.5. **`search-fixer.js` の `onNavigationStart`**: `yt-navigate-start` で `hideLiveChat` ON のとき pre クラスを **先制付与**。理由: yt-navigate-finish 後の syncLiveChatCollapse まで待つと、その間に YouTube が SPA で再利用される frame を expand 状態に戻す瞬間が paint されて「一瞬見える」現象が Edge の Performance Trace で確認されたため。副作用: hideLiveChat OFF や watch 以外のページでも一瞬 pre クラスが付くが、frame が無いページは CSS rule マッチ無しで副作用ゼロ、frame あり OFF ページは syncLiveChatCollapse で OFF 判定で剥がされる
4. **`search-fixer.js` の `collapseLiveChatIfNeeded`**: click 成功 *直後* には pre クラスを剥がさず `schedulePreHideRelease()` で **frame に `collapsed` 属性が付くまで rAF polling** してから `clearLiveChatPreHide()`。理由: click 直後に剥がすと YouTube が collapsed transition を DOM 反映する前に display:none が解除され、frame default expand state が paint されてしまう (Edge 動画キャプチャで約 270ms expand 表示を確認)。タイムアウト 30 フレーム (≈500ms) で fallback 剥がし
5. **`search-fixer.js` の `detachLiveChatObserver`**: hideLiveChat OFF / 別ページ遷移時にも pre クラス削除（class 残置で「機能 OFF 後も枠が見えない」バグ防止）
6. **`search-fixer.js` の `scheduleLiveChatCollapseRetry` 上限到達分岐**: fail-safe で pre クラス削除（live chat なし動画 / hydration 異常で永遠に click 成功しない場合に備え、frame を永久に隠したままにせず元 UI を見せる）
7. **delay 短縮**: iframe load 後 delay は **300ms → 50ms**、リトライバックオフは **[200, 600, 1500] → [50, 200, 800]** に短縮（pre クラスで見た目はすでに隠れているため、hydration 完了次第すぐ click → 公式 collapsed bar 表示、を最速化）

**復活禁止の失敗パターン**: 詳細列挙は本ドキュメント末尾の Important Patterns「hideLiveChat（YouTube ライブチャット非表示）」を参照。要約すると `display:none` / `height:0` / `setAttribute("collapsed")` / `#chat-container:has(...){display:none}` / 独自クラスでの frame 全体非表示はすべて NG（SPA panel state を破壊して player 副作用 / 「パネルを開く」消失 / 再展開不能になる）。`visibility:hidden` は layout のみへの影響で Polymer state に介入しないため安全。

**登録チャンネル拡張（v1.0.27 で完成）**: 3 機能セットで構成される。
1. **`subsChannelsGrid`**: `/feed/channels` をレスポンシブグリッドに変形 + 検索ボックス。各カードは IntersectionObserver で viewport 進入時 lazy fetch で **チャンネルの `/videos` + `/streams` を並列取得** (v7、2026-05-28 から)、HTML 内の thumbnailBadgeViewModel から **LIVE 配信中の videoId を最優先**（`"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"` + `animationActivationTargetId`、言語非依存）、**配信予定 (UPCOMING) の videoId は除外**（`"text":"配信予定"` (ja) / `"Upcoming"` / `"Scheduled"` / `"Premieres"` / `"首播"` 多言語パターンマッチ、雑談チャット用枠の混入を防ぐ）。残り候補は HTML 出現順上位 10 件で maxresdefault HEAD 200 確認 → 全 404 なら hqdefault 30KB 超で Shorts 救済 (v6 から継承)。`sessionStorage` に handle 単位 24h cache (prefix `__cpa_subs_thumb_v5::`)。**サムネ取得は YouTube が `/feeds/videos.xml` を 404 化したため HTML 内 videoId 抽出方式に切替済 (v1.0.27)、その後 v6 で削除済み動画プレースホルダー除外、v7 で LIVE 優先 + UPCOMING 除外**。
2. **`subsLeftnavInjectAll`**: YouTube が表示上限で隠す登録チャンネルも全件 leftnav に inline 注入。`/feed/channels` から同一オリジン取得、24h cache。`#items` の中（Polymer dom-repeat 配下）に `<a>` を直接 inject する安全パターン。
3. **`subsAllShortcut`**: `/feed/channels` への 1 クリックエントリを「登録チャンネル」section の `#items` 内、最初のチャンネル entry の直前に entry エントリ風（高さ 40px / icon 24px / text 72px 位置）で挿入し、公式メニューの一部に見せる。

**sort dropdown 関連の補正コードは入れない (再発禁止)**: 1 回目 sort 切替で label rollback / 「新しいアクティビティ」再選択で並び戻らない / 2 回目以降の挙動などは **YouTube 側 bug で extension では補正不能**。実機検証 (extension OFF/ON 比較) で確定済み。cooldown / click capture / popup-closed listener / scan gate / observer scoping は **逆効果**でしかなかったため全撤去 (v1.0.27)。

### 動画ガンマ補正 (`src/content/video-gamma.js`)
全 http(s) ページに `all_frames: true` で注入される content script。`videoGammaEnabled` (master) + `videoGammaValue` (数値 0.3〜3.0、初期 1.0) で管理。SVG `<feComponentTransfer type="gamma">` ベースの独自実装で、CSS `filter: url(#__cpa-video-gamma)` を `<video>` 要素に当てて全タブ共通のガンマ補正を適用する。スライダーは中央 (1.0) が補正なし、左に動かすほど暗く（最大 3.0）、右に動かすほど明るく（最小 0.3）。iframe 内の `<video>`（YouTube 埋め込み等）にも `all_frames: true` で同じ補正が当たる。動画データの読み取りや保存は行わない（filter 適用のみ）。

### 動画の黒帯除去 (`src/content/video-fill.js`)
全 http(s) ページに `all_frames: true` で注入される content script (video-gamma と同 manifest エントリ)。`videoFillEnabled` (master) + `videoFillMode` (`zoom` / `stretch`、初期 `zoom`) + `videoFillTarget` (モニター aspect preset id、初期 `21:9`) の **3 storage key** で管理。ウルトラワイド画面など、モニター縦横比とコンテンツ縦横比が違うときに動画の上下/左右に出るレターボックス黒帯を除去する。**設定はモニター側の縦横比のみ**で、動画側の縦横比は `<video>` 要素ごとに `videoWidth` / `videoHeight` から自動検出して `VideoFill.computeTransform` で適切な拡大率を毎回算出する (16:9 / 21:9 / 4:3 等が混在しても破綻しない設計)。`zoom` モードは均一拡大で画面いっぱい (4 辺はみ出し許容)、`stretch` モードは縦横比を歪めて完全フィット。CSS `transform` を `!important` inline で当て、サイト stylesheet の `!important` にも cascade 優先度で勝つ。元の inline transform は WeakMap に退避し、撤去時に復元。

**実装上の不変条件**:
- `loadedmetadata` を待ってから適用 (videoWidth=0 段階では計算不能)
- `metaAttached` WeakSet で loadedmetadata listener の二重登録防止 (revertAll() の AbortController abort 時に `new WeakSet()` へ差し替えて detach 済み video 含め一括リセット。旧 DOM マーカー `__cpaVfMetaAttached` は detach 済みを取り残し reinsert+再 ON 時に listener 貼り直し不能になる Codex P2 があり廃止)
- MutationObserver `subtree: true` で SPA / 遅延追加 video に追従。**detach された video は同期で即 `revertVideo`（element の GC を妨げない）、再適用（`scanAndApply`）は `requestAnimationFrame` で 1 フレーム 1 回に coalesce**（all_frames:true + 高頻度 DOM 変更でのフル走査積み上がりを平準化）。observer は `childList` のみ監視で自前の inline style 書き込みは observe 対象外のため、disconnect→render→takeRecords→observe ガードは不要（無限ループしない）
- iframe 内 `<video>` (YouTube 埋め込み等) も all_frames:true で対象
- `pagehide`（`persisted=false` = 実際にドキュメント破棄される遷移のみ）で `disconnectObserver()` + `revertAll()`（= transform 復元 + `metaListenerCtrl.abort()`、teardownOrphan と同じ後始末）。bfcache 凍結（`persisted=true`）は observer も凍結され CPU 消費ゼロ + 復帰でそのまま継続できるので温存する（disconnect すると pageshow 再初期化が無いぶん復帰後に効かなくなるため）
- 焼き込み黒帯 (動画フレーム内に最初から入っている上下帯) は videoWidth/videoHeight に現れないため検出不能 (どの video player でも同じ原理的限界)
- 拡張リロード後の orphan は `chrome.runtime?.id` 検知で observer 切断 + `revertAll()` で全 transform 復元 (Extension context invalidation guard PATTERN SYNC 準拠)
- `window.__cpaVideoFillRunning` で同一フレーム内の二重実行防止

### ルーペ (`src/content/loupe.js` + `src/content/loupe.css`)
全 http(s) サイトの top frame に注入される独立機能。`loupeEnabled` (master) + `loupeZoom` (1.5/2.5/4.0、初期 2.5) + `loupeSize` (150〜1000px、step 10、初期 220) の **3 storage key** で管理。`chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 70 })` で active tab の静止画を取得し、`position: fixed; clip-path: circle()` の円形レンズ DOM に `background-image` として貼り付け、`mousemove` から `background-position` を rAF コアレス 60fps で更新する。倍率は popup のセグメントコントロールから 3 段階で選択、レンズサイズは popup のスライダーで可変。動画 / iframe / canvas を含む描画ピクセルを captureVisibleTab で取得するため「動画を一時停止してから細部を確認」する用途に最適。**popup で master トグルを ON にすると popup が自動クローズする** (ON 状態だと popup 自体がレンズで拡大したい領域を隠す UX 問題を回避、`setTimeout(50)` で APPLY_SETTINGS message dispatch を完了させてから close)。**v1.0.34 から `manifest.json` に `host_permissions: ["<all_urls>"]` を追加** している。理由: `activeTab` 権限のみだと popup auto-close 直後 + SPA ページ (Bing 検索等) の内部 navigation で `captureVisibleTab` が `Either '<all_urls>' or 'activeTab' permission is required` エラーで失敗する事例が Chrome / Edge 両方で発生したため。`<all_urls>` を host_permissions に明示することで activeTab grant 失効に依存せず常に capture 可能になる。アクセス可能範囲は content_scripts の `http://*/* + https://*/*` matches と実質同等。

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

### Amazon 販売元・出荷元バッジ (`src/content/amazon-merchant-info.js` + `src/content/amazon-merchant-info.css`)
`*://www.amazon.co.jp/*` 限定（top frame のみ）。`amazonMerchantInfoEnabled` (boolean、デフォルト OFF オプトイン) 1 storage key で master 制御。Amazon の隠し div (`#merchantInfoFeature_feature_div` / `#fulfillerInfoFeature_feature_div`) から販売元と出荷元を抽出し、商品情報の最上部（**ランキングへ移動ボタンの直後**、`insertAdjacentElement("afterend", ...)` で隣接配置。ランキングボタンが無い場合は `#title_feature_div` の直前等 ranking と同じフォールバック順）に **クリック不可の情報バッジ** (`<span role="img">`) を挿入する。表示は「📦 販売: XXX / 出荷: YYY」の 2 段構成で、**Amazon 直販 = 緑バッジ（落ち着いた信頼色）/ マーケット出品 = オレンジ警告バッジ** で詐欺マーケットプレイス回避の視覚シグナルになる。外部送信ゼロ・純粋 DOM 操作。

**Amazon 直販判定**: `AmazonMerchantInfo.parseIsInternal(scriptText)` が `#merchantInfoFeature_feature_div` 内 `<script>` 埋め込み JSON (`{"marketplaceId":"...","isInternal":true|false,"merchantId":"..."}`) から `isInternal` フラグを抽出する。これは Amazon 自身が出す信頼できるフラグ。script が欠落していた場合は `AmazonMerchantInfo.isAmazonOwnedName(name)` で販売元名に "Amazon" / "Amazon.co.jp" / "Amazon.com" が含まれるかの保険判定にフォールバック。両純粋関数とも `test/actions.test.js` で境界値テスト。

**DOM データ source**:
1. **販売元名**: `#merchantInfoFeature_feature_div span.offer-display-feature-text-message` の最初の textContent（マーケット商品でも `visible: false` の隠し div として値は埋まっている）
2. **出荷元名**: `#fulfillerInfoFeature_feature_div span.offer-display-feature-text-message` の最初の textContent。取れなければ「販売元 = 出荷元」と推定（Amazon 直販で fulfillerInfo が省略されているケースに対応、Amazon が 1 値集約表示している UI と整合）
3. **isInternal フラグ**: `#merchantInfoFeature_feature_div script` を全部走査、`parseIsInternal` で boolean が取れた最初の値を採用

**実装上の不変条件**: top frame 限定、`window.__cpaAmazonMerchantInfoRunning` で二重実行防止。MutationObserver で遅延読み込みされる商品詳細欄に追従し、自分のバッジ挿入による再発火は **rAF coalesce + disconnect → render → takeRecords → observe ガード**（ranking 移動 / 定期おトク便と同型）で抑える。バッジは差分更新（販売元・出荷元・variant が変化時のみ書き込み）+ `isConnected` チェックで再挿入。context invalidation guard で orphan 化時に observer disconnect + バッジ撤去。master OFF / 非商品ページ（merchantInfoFeature_feature_div 内の span 値が無い）でバッジ撤去。CSS の `data-variant="amazon"` / `data-variant="marketplace"` 属性で色切替（緑系 / オレンジ系）、light / dark テーマ両対応。

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

### 音量ブースター (tabCapture 経路一本、`src/background/background.js` + `src/offscreen/offscreen.js`)
`chrome.tabCapture.getMediaStreamId` + offscreen の `getUserMedia` + AudioContext 方式。**全サイト一律・URL 分岐なし**（Netflix / Prime Video / Amazon 等 EME 動画も含む）。`chrome.tabCapture` は OS / ブラウザレベルで復号された後のタブ音声出力を捕獲するため、EME 動画でもブースト可能。

> **設計史**: v1.0.33 で MediaElementSource (MES) 経路を content script に追加し「普通サイト=MES 自動適用 / EME サイト=tabCapture」の 2 経路 + URL 分岐設計にしたが、(1) Amazon など買い物ページと再生ページが同居するドメインで tabCapture のタブ共有バナーが再生と無関係なページに出る、(2) サイトによって挙動が変わる、という問題があり、ゆろさん指示で **tabCapture 一本（昔の方式）に戻した**（MES 経路 volume-booster.js / EME_HOSTS / isEmeHost / isEmeUrl は撤去済み）。トレードオフ: ①ブースト中タブに Chrome の「このタブのコンテンツは共有されています」バナーが出る（tabCapture 仕様で抑止不可）②popup を開かないと boost されない（自動適用なし）③Firefox MV3 は tabCapture 未対応なので音量ブースターは Chrome 専用（`HAS_VOLUME_BOOSTER` guard で Firefox は UI ごと非表示）。

**popup 必須**: `chrome.tabCapture.getMediaStreamId` は user gesture が必須で、background SW から自動呼び出しは Chrome 仕様で禁止。popup open 自体が user gesture を兼ねる。`popup.js pushVolumeNow` は active tab に対して **常に** `VOLUME_BOOSTER_SET_GAIN` を background に送る（URL 判定なし）。

**処理フロー**:
1. popup の `pushVolumeNow`: 音量関連キー（lastGain + サブトグル 2 + ミュート + EQ enabled/gains/preamp）を storage に永続化（boost トリガーではなく popup 復元 + `autoApplyVolumeBooster` 用）+ active tab へ `VOLUME_BOOSTER_SET_GAIN`（`tabId`, `gain`, `antiClip`, `nightMode`, `muted`, `eqEnabled`, `eqGains`, `eqPreamp`）を background に送信
2. background: gain が UNITY かつ全サブトグル OFF かつミュート OFF かつ EQ OFF なら `releaseVolumeBoosterTab` で AudioContext 解放して終了。それ以外は `chrome.tabCapture.getMediaStreamId({ targetTabId })` で MediaStream ID 取得（既存 AudioContext があれば streamId なしで gain / preset / mute / EQ だけ更新）
3. background → offscreen: `ACTION_VOLUME_SET_GAIN`（`tabId`, `streamId`, `gain`, `antiClip`, `nightMode`, `muted`, `eqEnabled`, `eqGains`, `eqPreamp`）
4. offscreen: 未登録タブなら `getUserMedia` → 14 ノード接続 (`source → preampNode → eqFilters[0..9] → nightModeNode → gainNode → antiClipNode → destination`)。登録済みなら GainNode を `setTargetAtTime` で 45ms ramp、各 DynamicsCompressor のパラメータ切替、`applyEqualizer` で preamp + 10 バンド gain を ramp 更新
5. **タブ切替で自動再適用**: `tabs.onActivated` → `autoApplyVolumeBooster(tabId)` → **`boostedTabIds` に既登録のタブのみ**が対象（既存 AudioContext があるので `getMediaStreamId` 不要で user gesture 制約に引っかからない）。未 boost タブへの初回適用は popup open（= user gesture）が必須

**共通仕様**:
- `volumeBoosterEnabled` (master) + `volumeBoosterLastGain` (数値 0〜600、初期 100) + `volumeBoosterAntiClipEnabled` / `volumeBoosterNightModeEnabled` / `volumeBoosterMutedEnabled` + イコライザ 4 キー (`volumeBoosterEqEnabled` / `volumeBoosterEqGains` 10 要素配列 / `volumeBoosterEqPreamp` / `volumeBoosterEqPreset`) の **9 storage key** で管理
- 全設定はグローバル永続化（タブ間共通）。マスター OFF は全 AudioContext を解放
- **ミュート UI**: popup の音量スライダー左にトグルボタン（🔊/🔇、`aria-pressed` ベース）。ミュート ON 中もスライダー値は last gain 位置のまま表示・操作可能で、ユーザーは「ミュート維持のままスライダー値を変更 → ミュート解除で意図した音量に復帰」できる
- 数値の単一情報源は [`src/lib/actions.js`](src/lib/actions.js) の `VolumeBooster` 定数 — ドキュメントとコードに齟齬が出たら必ずコードを正とすること

### 接続モニター (`src/content/youtube-connection-monitor.{js,css}`)
`*://*.youtube.com/*` 限定の content_scripts エントリ (top frame のみ、`document_idle`)。**YouTube クリーナーのサブ機能** として `searchFixerEnabled` (master) AND `searchFixerFeatures.connectionMonitor` の AND で制御する（独立 storage key は持たず、Shorts 5 サブ機能と同じ統合方式。`APPLY_SEARCH_FIXER_CS` を search-fixer.js / youtube-shorts.js と共に購読し、`computeActive()` で判定。`storage.onChanged` は `SEARCH_FIXER_ENABLED` / `SEARCH_FIXER_FEATURES` 両キーを監視 → `readSettingsAndApply` が両キーを再取得するので片方 undefined 化の罠を回避）。**YouTube ライブ配信視聴中のクルクル原因** を、自分の回線・端末性能・YouTube CDN・国際線経路に切り分ける in-player HUD を提供する。**拡張機能内で唯一、経路診断のために 5 秒周期で 2 つの公開ヘルスチェック endpoint への RTT 計測 fetch を行う**（後述）。

**機能のスコープ**:
- **ライブ配信のみ対象**: `isLiveVideo()` がライブと判定したときのみ動作する。VOD 動画ではバッファ判定の意味が違うので overlay は出さない。**判定は DOM シグナルベース**（`duration === Infinity` は DVR 対応ライブでは有限値かつ伸び続けるため使えない。実機実測で配信中 `video.duration` が 17620→17665 と増加するのを確認。`getVideoData().isLive` は MAIN world 限定で isolated world から読めない）。`isLiveVideo()` は ① `duration === Infinity`（DVR 無効ライブの最速パス）OR ② プレイヤー UI の `.ytp-time-display.ytp-live` クラス存在 OR ③ `.ytp-live-badge` が可視（VOD では DOM に存在するが display:none）の OR で判定。②③ が VOD で出ない / hidden になることは実機較正済み。プレイヤー UI ハイドレート時に MutationObserver 経由で `rescanForLiveVideo` が再走して拾う。**`isLiveTrackedVideo` sticky フラグで一度ライブ判定したら維持** — MutationObserver は `document.documentElement` の subtree:true を高頻度監視するため、YouTube プレイヤーの細かい再構築（scrubber hover / シアターモード切替 / 広告挿入直後 / SPA panel reflow）で `.ytp-time-display.ytp-live` / `.ytp-live-badge` が一瞬 false を返すケースがある。そのまま 1 フレームでも rescan が走ると `stopMeasuring → removeOverlay` で「ライブ中に overlay だけ勝手に消える」現象が起きるため、**trackedVideo の identity が同じ間は確定したライブ判定を維持**する設計（trackedVideo が別 element に差し替わったときだけ false にリセット）
- **検出ロジック (1 秒周期サンプル)**: `video.addEventListener("waiting" | "playing")` でバッファイベント、`video.getVideoPlaybackQuality()` で `droppedVideoFrames` / `totalVideoFrames`、`navigator.connection?.downlink` (Mbps) / `rtt` (ms) を ring buffer (30 サンプル = 30 秒) に記録
- **動画 chunk 実 throughput 計測 (PerformanceObserver)**: `navigator.connection.downlink` は Chromium のプライバシー保護で bucket 化された粗い見積もり値（10 Mbps 以上で頭打ち等、ゆろ君環境実測で常に 10.0 固定）なため、`PerformanceObserver({ type: "resource", buffered: true })` で `googlevideo.com` の resource entries を拾い `transferSize / (responseEnd - responseStart)` から実 throughput を計算してリング (30 サンプル) に蓄積する。**TAO（Timing-Allow-Origin）ヘッダ無しの cross-origin リクエストは `transferSize === 0` で除外**、**`VIDEO_CHUNK_MIN_BYTES` (50 KB) 未満の小 chunk は warmup overhead 支配で除外**。HUD のコンパクト Mbps と「帯域 60 秒」min/avg/max は **この実 throughput median を優先**、未計測時のみ `navigator.connection.downlink` にフォールバック（実機実測で navigator.connection 10.0 固定 vs 実 throughput min 0.08 / median 32.15 / max 34.9 Mbps と段違いの精度差を確認）
- **経路診断 (5 秒周期)**: `https://www.gstatic.com/generate_204` (Google エッジ) と `https://speed.cloudflare.com/__down?bytes=10` (Cloudflare 国際ベースライン) に対して **`fetch(url, { mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.any([diagnosisAbort.signal, AbortSignal.timeout(4500)]) })`** を発射し `performance.now()` 差分で RTT 実測。レスポンス本文は破棄、`response.ok` も見ない (no-cors なので opaque)。timeout / network error は `null` 扱いで ring buffer (6 サンプル = 30 秒) に格納し median を分類器に渡す
- **分類 (`ConnectionMonitor.classify(input)`)**: 純粋関数として `actions.js` に集約。直近 60 秒のバッファ回数 + buffering 時の downlink / baseline downlink / dropped frame 比率 / Google RTT / Cloudflare RTT を入力に **7 分類**: `stable` / `network` (回線) / `device` (端末性能) / `youtube_cdn` (YouTube CDN 個別不調) / `routing` (Google エッジ・ルーティング) / `international` (国際線・中継 ISP) / `unknown` (計測中)
- **HUD UI (2 段構成: コンパクト + 詳細展開)**: in-player 右上 (`#movie_player` の絶対配置子) に表示。
  - **コンパクト時 (デフォルト)**: 判定ラベル (verdict) + メトリクス 1 行 (`バッファ N 回 / 1 分 · BW Mbps · RTT ms`) を常時表示
  - **▼ ボタンで詳細展開**: コンパクトに加えて 3 つの詳細セクションが下に追加される
    1. **経路 RTT 個別**: Google / Cloudflare それぞれの median と sample 数を 2 行で（例: `Google: 23 ms (6 回)` / `Cloudflare: 18 ms (6 回)`）→ 経路切り分けの根拠が見える
    2. **直近バッファ履歴**: 最大 5 件、新しい順、相対時刻 + 起きた瞬間の帯域（例: `12 秒前 · 8.1 Mbps`）→ 「ちょうど今クルクルしたよね？」の客観タイムスタンプ
    3. **帯域 60 秒統計**: `最小 / 平均 / 最大` Mbps → 平均だけだと隠れる「瞬間的な帯域低下」を可視化
  - **dropped frames（端末性能指標）は表示しない方針** — ローカル GPU/CPU の性能は端末利用者が対処不能な情報のため UI で表示しない（内部で `device` 判定の根拠として使うが、それは verdict ラベルだけで十分）
  - **ドラッグで位置移動**・**▼ ボタンで折りたたみ ⇔ 展開**、位置と折りたたみ状態は `localStorage` に永続化 (`__cpa_cm_overlay_pos` / `__cpa_cm_overlay_collapsed`)。`:fullscreen` でも追従
  - 折りたたみ時の CSS 対象は `.__cpa-cm-detail` のみ（`.__cpa-cm-body` 全体ではない）→ metric 1 行は常時見える設計

**プライバシー / セキュリティ**:
- **endpoint は HTTPS 公開ヘルスチェックの 2 つに固定** (`actions.js` の `ConnectionMonitor.ENDPOINT_GOOGLE` / `ENDPOINT_CLOUDFLARE`、テスト `test/actions.test.js` で値固定をアサート)。任意 URL fetch / DNS query 可能化はしない
- `mode: "no-cors"` でレスポンス本文の読み取り不能化、`credentials: "omit"` で Cookie 送信遮断、`referrerPolicy: "no-referrer"` でリファラ送信ゼロ。送られるのは「Vuora が ON である事実」と「視聴中のおおよその時刻」だけ
- **identifier・cookie・ユーザーデータ・YouTube 視聴履歴は一切送信しない**。ring buffer は永続化せず content script スコープのメモリのみ、master OFF / overlay 撤去で破棄
- **master OFF / サブ機能 OFF でフルリソース解放**: 1s sample timer / 5s diagnosis timer / video event listeners / MutationObserver / overlay DOM / fetch in-flight が全て撤去される

**ライフサイクル**:
1. popup で YouTube クリーナーの接続モニターサブ機能を ON → `APPLY_SETTINGS` → background → `notifyContentScripts` (YouTube タブ判定分岐) → `APPLY_SEARCH_FIXER_CS` を top frame に送信 (search-fixer.js / youtube-shorts.js と共有の 1 メッセージ)
2. content script: `readSettingsAndApply()` を `applyInFlight`/`applyQueued` で直列化 (ルーペと同じパターン)。`computeActive()` = `searchFixerEnabled` AND `searchFixerFeatures.connectionMonitor` が true なら `activate()`、false なら `deactivate()`
3. `activate()`: 初期スキャン + MutationObserver / `yt-navigate-finish` 登録。`isLiveVideo()`（DOM シグナル判定、上記参照）true のライブ視聴時に sample timer (1s) + diagnosis timer (5s) + video イベントリスナー + overlay DOM を起動
4. SPA 遷移で VOD に戻ったら overlay 撤去 (timer は live 再検出のため軽量に維持)、別のライブに遷移したらそのまま継続
5. サブ機能 OFF / master OFF / `pagehide`(persisted=false) / `chrome.runtime?.id` 消失 で `deactivate()` (stopMeasuring + video/yt-navigate-finish/drag listener + MutationObserver + overlay を全撤去)

**実装上の不変条件**:
- top frame 限定 (`window === window.top` 早期 return)
- `window.__cpaConnectionMonitorRunning` で二重実行防止
- 設定購読 (`readSettingsAndApply`) は `applyInFlight`/`applyQueued` で並列実行を直列化 (storage.onChanged / runtime.onMessage / SPA 遷移の重複呼出で activate と deactivate が race するのを防ぐ。ルーペと同じ /rere B1-E3 パターン)
- HUD render は 250ms スロットルで rAF coalesce、ring buffer 更新は毎秒 + 古いサンプル切り捨て
- Extension context invalidation guard を sample / diagnose / observer callback の入口に配置、orphan 化したら全 timer clear + observer disconnect + overlay 撤去
- DOM 構築は `createElement` ベース (YouTube の Trusted Types policy に対応、isolated world でも安全側)
- fetch には `AbortSignal.timeout(4500)` 必須 (永久 pending を防ぐ、5s 周期より短い)。次サイクル開始時の in-flight キャンセルと両立させるため `AbortSignal.any([diagnosisAbort.signal, AbortSignal.timeout(ENDPOINT_TIMEOUT_MS)])` で 2 signal を束ねる (手動 setTimeout/clearTimeout は使わない、min Chrome 140 で `AbortSignal.any` = 124+ / `AbortSignal.timeout` = 116+ 利用可)

**分類器 (`ConnectionMonitor.classify`) の優先順位**: `actions.js` の純粋関数として `test/actions.test.js` で境界値テスト済み。
1. バッファ 0 回 → `stable`
2. buffering 時の downlink が baseline の 50% 以下 → `network` (回線)
3. dropped frame 比率 30% 以上 → `device` (端末性能 / GPU)
4. Google と Cloudflare 両方が悪 (> 200ms) → `international` (国際線 / 中継 ISP)
5. Google だけ悪 (> 200ms) かつ Cloudflare 快適 (< 100ms) → `routing` (Google エッジ / ルーティング)
6. それ以外 → `youtube_cdn` (YouTube 個別 CDN 不調が最も疑わしい fallback)

### 配信時刻オーバーレイ (`src/content/youtube-broadcast-clock.{js,css}`)
`*://*.youtube.com/*` の top frame に注入（`document_idle`、**接続モニターと同じ content_scripts エントリに相乗り**で actions.js 二重ロードを回避）。**YouTube クリーナーのサブ機能** `searchFixerFeatures.broadcastClock`（master `searchFixerEnabled` AND で制御。独立 storage key は持たず、`APPLY_SEARCH_FIXER_CS` を search-fixer.js / youtube-shorts.js / youtube-connection-monitor.js と共に購読し `computeActive()` で判定。接続モニター / Shorts 5 サブ機能と同じ統合方式）。**ライブ配信のアーカイブ（過去ライブの VOD）再生中に、その瞬間が実際に配信されていた時刻を `yyyy/MM/dd　hh:mm:ss`（全角スペース区切り・全桁ゼロ埋め・24 時間制・ローカルタイム）でプレーヤー左上 HUD に重ねて表示する**。純粋ロジックは `actions.js` の `BroadcastClock` namespace、DOM / fetch / lifecycle のみ本 cs が担当。

**配信時刻の算出**: `配信時刻 = liveBroadcastDetails.startTimestamp + video.currentTime`。`BroadcastClock.computeBroadcastEpochMs(startMs, currentTimeSec)` で epoch を出し `BroadcastClock.formatTimestamp(epochMs)` で整形する（両純粋関数とも `test/actions.test.js` で境界値テスト。全角スペース・ゼロ埋め・24 時間制を固定アサート）。

**データ取得（同一オリジン fetch、外部送信ゼロを維持）**: content script（isolated world）からは MAIN world の `ytInitialPlayerResponse` を直接読めないため、`/watch?v=<id>` を **same-origin 認証 fetch（`credentials:"same-origin"` + `redirect:"manual"`、search-fixer.js の `/feed/channels` 取得と同型。外部 CDN 向け fetch 4 原則とは別パターン）** して HTML 内の `liveBroadcastDetails` を `BroadcastClock.parseLiveBroadcastDetails` で正規表現抽出する（**自オリジンへの取得のみ＝接続モニターと違い外部送信はゼロ**）。結果は **videoId 単位で sessionStorage cache**（`__cpa_bc_info_v1::` prefix、負例＝通常動画も cache して再 fetch を防ぐ）、`fetchInFlightVideoId` で同一動画への重複 fetch を防止。

**対象判定**: `liveBroadcastDetails` を持ち、かつ配信終了済み（`isLiveNow !== true`）のアーカイブのみ表示。通常動画（liveBroadcastDetails なし）・配信中ライブ・プレミア公開待ちには出さない。videoId は `BroadcastClock.extractVideoId`（`/watch?v=` と `/live/<id>` 両対応、11 文字厳密マッチ）で取得。

**精度の限界**: `currentTime=0` が配信開始ちょうどに対応する線形マッピング前提のため、配信途中の回線断・再接続や編集カットがあるアーカイブでは、その地点以降に実時刻がずれる（原理的限界でどんな実装でも避けられない。messages.json の機能説明にも明記）。

**HUD UI / 実装上の不変条件（youtube-connection-monitor.js PATTERN SYNC）**:
- in-player **左上**に ROG クリムゾン HUD（接続モニターは右上なのでデフォルト位置を分けて衝突回避、どちらもドラッグ移動可）。位置は `localStorage`（`__cpa_bc_overlay_pos`）に永続化、`:fullscreen` 追従
- 時刻更新は video の `timeupdate` / `seeked` イベント駆動 + `RENDER_THROTTLE_MS`（250ms）throttle の rAF coalesce（一時停止中は currentTime 固定なので最後の値で静止）
- `createElement` ベースで Trusted Types 安全、`__cpa-bc-` クラスプレフィックスで名前空間化
- `applyInFlight`/`applyQueued` で設定購読を直列化、SPA 追跡は MutationObserver + `yt-navigate-finish`、`pagehide(persisted=false)` で teardown（bfcache 凍結は温存）
- context invalidation guard（`chrome.runtime?.id`）で orphan 化時に observer / listener / overlay を撤去
- top frame 限定（`window === window.top`）、`window.__cpaBroadcastClockRunning` で二重実行防止

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 設定; permissions: `activeTab`, `storage`, `offscreen`, `tabCapture` + host_permissions: `<all_urls>` (ルーペ `captureVisibleTab` を popup close 後 / SPA navigation 後でも確実に動作させるため、v1.0.34 で追加。content_scripts で既に全 http(s) に注入済みなので実質アクセス範囲は同じ) |
| `src/lib/actions.js` | `Object.freeze` された 22 個の定数を IIFE wrap + globalThis 公開: SettingsSchema / Actions / ExtensionPaths / SenderCheck / Offscreen / StorageKeys / YouTubeShorts / SearchFixer / AmazonDeliveryTotal / AmazonRankingJump / AmazonMerchantInfo / InstagramCleaner / TikTokCleaner / ImageDownloader / VolumeBooster / VideoGamma / VideoFill / Loupe / ConnectionMonitor / BroadcastClock / ColorPicker / PopupTabs |
| `src/lib/scan-runner.js` | content script 共通実行ランタイム (`/rere` B1-007/B2-I002/D-002 で抽出)。rAF coalesce + MutationObserver `disconnect → render → takeRecords → observe` ガード + Extension context invalidation guard を `ScanRunner.create({ render, cleanup })` に集約し `globalThis.ScanRunner` 公開。Amazon 3-cs (delivery-total / ranking-jump / merchant-info) が利用 (image-downloader / youtube-shorts は別バッチで移行予定)。cleanup は idempotent 必須。context invalidation 後でも throw しない i18n 取得 `ScanRunner.safeMsg(key, fallback)` も公開し Amazon 3-cs の重複ヘルパー (ranking-jump / merchant-info の同型コピー + delivery-total のインライン) を統合 (/opop) |
| `src/lib/audio-pipeline.js` | 音量ブースター DSP コア共有モジュール (`/rere` B1-004/B2-I001/D-001 で抽出)。`dbToGain` / `applyCompressorPreset` / `applyEqualizer` / `createEqChain` の 4 関数を `globalThis.AudioPipeline` 公開 (MES 経路 + 自動音量正規化の撤去後は compressor preset 適用 + EQ 構築 + EQ 適用 + dB 変換のみ残る、§撤去済み機能と教訓 参照)。`createEqChain(ctx)` は preampNode + 10 バンド peaking BiquadFilterNode を直列接続した {head, tail, preampNode, eqFilters} を返す (EQ DSP の構築と更新を同一モジュールに集約)。`applyEqualizer` は preampNode の dB→gain 倍率変換と eqFilters[10] の peaking gain を ramp 更新する。offscreen.js (tabCapture 経路・唯一の音量ブースター経路) が使用。値定数は actions.js の VolumeBooster 経由 |
| `src/lib/cleaner-core.js` | body-class クリーナーの設定購読共通ランタイム (/opop で抽出)。master + features 2 キーの購読 3 経路 (初期 storage.get / runtime.onMessage gate / storage.onChanged 部分更新) を `CleanerCore.subscribe({ masterKey, featuresKey, applyAction, mergeFeatures, onUpdate })` に集約し `globalThis.CleanerCore` 公開。Instagram / TikTok クリーナーが利用。active/features 保持と applyBodyClasses/固有ロジック (Instagram の DOM スイープ・URL guard 等) は各 cs に残す最小責務分離 (early-framework.js / scan-runner.js と同じ思想で config 肥大化を回避)。onUpdate(patch) は変わったキーだけ通知し各 cs が部分適用 (片方キーのみ変化時の undefined 上書き罠を回避) |
| `src/background/background.js` | Service worker: sender 検証付きメッセージ転送、設定マイグレーション、offscreen document 管理、音量ブースター制御 (tabCapture 経路一本、全サイト一律) |
| `src/content/early-framework.js` | document_start early script 共通フレームワーク。`<style>` 注入 / pre クラス同期付与 / `storage.local.get` / `storage.onChanged` 購読を `window.__cpaEarlyFramework.setup(config)` に集約。各 early エントリで先頭ロード、actions.js には依存しない |
| `src/content/youtube-early.js` | YouTube watch ページ向け `document_start` 注入の最小スクリプト。hideLiveChat ON 時に `<html>` へ `__cpa-sfx-hide-live-chat-pre` クラスを最速付与し、ライブチャット枠の体感ラグを消す。early-framework.js 経由でボイラープレート共通化、サイト固有の MutationObserver / force-hide のみ独自実装 |
| `src/content/youtube-shorts.{js,css}` | YouTube クリーナーの Shorts 5 サブ機能（Shelf / Chip / Sidebar / Redirect / Btn、top frame のみ）: MutationObserver + URL リダイレクト + 機能ごとの `__cpa-yt-shorts-hide-{shelf,chip,sidebar}` / `__cpa-yt-shorts-redirect-active` クラスで `display: none` |
| `src/content/search-fixer.{js,css}` | YouTube クリーナー（32 機能 = 検索結果ノイズ除去・Shorts 5 サブ機能・動画ページ整形・グリッド列数・ホーム/フィードのグリッド整列・登録チャンネル拡張 3 機能・接続モニター 1 機能・配信時刻オーバーレイ 1 機能を含む）: master + features + gridItems で駆動、`/feed/channels` グリッド化 / leftnav 全件展開 / すべての登録チャンネルショートカットを含む。接続モニターの実装は専用 content script `youtube-connection-monitor.js`（search-fixer.js 自体は担当しない） |
| `src/content/amazon-delivery-total.{js,css}` | Amazon 定期おトク便ページ: 月別合計を rAF coalesce + observer guard 駆動で挿入 + `__cpa-amzn-delivery-total` 配色 |
| `src/content/instagram-early.js` | Instagram 向け `document_start` 注入の最小スクリプト。hideComments ON 時に `<html>` へ `__cpa-ig-comments-pre` クラスを最速付与し、`div:has(> ul._a9ym)`（各コメント UL の親 div）を CSS rule + MutationObserver inline force-hide で先制非表示にする。`_a9z6`（外側 UL）には post caption が同居しているので触らず、`_a9ym` 親 div だけを対象にして caption 巻き込み防止（actions.js は読み込まない） |
| `src/content/instagram-cleaner.{js,css}` | Instagram クリーナー: master + features で body クラス駆動、URL リダイレクト + DOM スイープ + 意味論的セレクタのみ（aria-label / href / role / data-pagelet / SVG path data） |
| `src/content/tiktok-early.js` | TikTok 用 `document_start` 注入の最小スクリプト。`tiktokCleanerEnabled` + `tiktokCleanerFeatures` を読んで `<html>` に `__cpa-tt-comments` / `__cpa-tt-suggested` 同期付与 + inline `<style>` で主要セレクタ焼き込み（FOUC 防止、actions.js 非依存） |
| `src/content/tiktok-cleaner.{js,css}` | TikTok クリーナー: master + features で body クラス駆動、CSS-only 実装（DOM スイープ / URL リダイレクト不要）。photo / video 用 `[class*="RightPanelContainer"]` + modal viewer 用 `[class*="DivCommentListContainer"]` の 2 系統セレクタ併用 |
| `src/content/amazon-ranking-jump.{js,css}` | Amazon ランキングへ移動ボタン: `*://www.amazon.co.jp/*` の top frame に注入、商品詳細欄の売れ筋ランキングリンクから「一番細かいサブカテゴリ」を選んで商品情報最上部に集約ボタン (`<a href>`) を挿入、同じタブで移動。商品ページで自己ゲート、rAF coalesce + observer guard、外部送信ゼロ |
| `src/content/amazon-merchant-info.{js,css}` | Amazon 販売元・出荷元バッジ: `*://www.amazon.co.jp/*` の top frame に注入、隠し div (`#merchantInfoFeature_feature_div` / `#fulfillerInfoFeature_feature_div`) から販売元・出荷元を抽出し、「📦 販売: XXX / 出荷: YYY」を商品情報最上部 (ランキングボタンの隣) に **クリック不可の情報バッジ** (`<span>` ベース) で表示。**Amazon 直販 = 緑 / マーケット出品 = オレンジ警告** で視覚区別 (`data-variant` 属性で CSS 切替)。直販判定は `AmazonMerchantInfo.parseIsInternal` で script 埋め込み JSON の `isInternal` フラグを最優先、欠落時は `isAmazonOwnedName` の販売元名フォールバック (両純粋関数とも境界値テスト可能化)。商品ページで自己ゲート、rAF coalesce + observer guard + context invalidation guard、外部送信ゼロ |
| `src/content/video-gamma.js` | 動画ガンマ補正: 全 http(s) + iframe に注入、SVG `<feComponentTransfer type="gamma">` を `<body>` に inject。**v1.0.41 で video-fill と同型 lifecycle に統一**: 旧 CSS rule 一斉注入 → **per-video inline `style.setProperty("filter", "url(#...)", "important")` + `loadedmetadata` 待ち + WeakMap original + AbortController + MutationObserver で detach 即 revert**。動機: 旧設計が video element の readyState 関係なく filter 当てるため DRM player の session 取得中に attestation 干渉する理論的リスクを構造的に排除 |
| `src/content/video-fill.js` | 動画の黒帯除去 (ワイド表示): 全 http(s) + iframe に注入 (video-gamma と同 manifest エントリ)。`videoFillEnabled` (master) + `videoFillMode` (`zoom`/`stretch`) + `videoFillTarget` (モニター aspect preset) の 3 storage key。設定はモニター aspect のみ、動画側 aspect は `videoWidth`/`videoHeight` から要素ごとに自動検出して `VideoFill.computeTransform` で拡大率算出。`!important` inline transform で site stylesheet にも勝つ。`loadedmetadata` 待機 + MutationObserver(subtree) で遅延 video 追従 + Extension context invalidation guard で orphan 化対応。元 inline transform は WeakMap に退避し撤去時復元 |
| `src/content/loupe.{js,css}` | ルーペ機能: 全 http(s) の top frame に注入、`chrome.tabs.captureVisibleTab` で取得した JPEG 静止画を `position: fixed` 円形レンズに `background-image` で貼り、mousemove で `background-position` を rAF コアレス 60fps 更新。再キャプチャ trigger は初回 / scroll (500ms debounced) / MutationObserver(childList, subtree:false) / resize。Blob URL に変換して `<img>`/`background-image` で参照し cleanup 時に `URL.revokeObjectURL` で確実に解放 |
| `src/content/youtube-connection-monitor.{js,css}` | 接続モニター（**YouTube クリーナーのサブ機能** `searchFixerFeatures.connectionMonitor`、master `searchFixerEnabled` AND で制御。独立 storage key なし・`APPLY_SEARCH_FIXER_CS` を search-fixer.js / youtube-shorts.js と共に購読・`computeActive()` 判定）: `*://*.youtube.com/*` の top frame に注入 (`document_idle`)。`isLiveVideo()` の DOM シグナル判定（`.ytp-time-display.ytp-live` クラス OR `.ytp-live-badge` 可視 OR `duration === Infinity`。DVR ライブは duration が有限で伸びるため duration 単独では不可・実機較正済み）+ `isLiveTrackedVideo` sticky フラグ（trackedVideo identity 同一中はライブ判定維持で「DOM 一瞬ブレで overlay 消滅」防止）でライブ配信のみ対象。**HUD は 2 段構成: コンパクト = verdict + metric 1 行常時、▼ 展開 = 経路 RTT 個別 + 直近バッファ履歴 + 帯域 60 秒統計（dropped frames は端末対処不能のため非表示）**。1s 周期で `navigator.connection.downlink/rtt` + `getVideoPlaybackQuality().droppedVideoFrames` を 30 サンプル ring buffer に蓄積、5s 周期で `https://www.gstatic.com/generate_204` + `https://speed.cloudflare.com/__down?bytes=10` への RTT 計測 (`mode:"no-cors"` + `credentials:"omit"` + `referrerPolicy:"no-referrer"` + `AbortSignal.any([cancel, AbortSignal.timeout(4500)])`)、純粋関数 `ConnectionMonitor.classify` で 7 分類 (stable / network / device / youtube_cdn / routing / international / unknown)。in-player 右上に ROG クリムゾン HUD、ドラッグ + 折りたたみ可能、`localStorage` に位置 / 折りたたみ状態永続化、`:fullscreen` 追従。`applyInFlight`/`applyQueued` で設定購読を直列化、context invalidation guard で orphan 化時に全 timer + observer + overlay 撤去。`createElement` ベースで Trusted Types 安全。endpoint URL は `actions.js` 定数 + `test/actions.test.js` で値固定アサート。**接続モニターのみ外部 fetch あり** (それ以外の機能はすべて外部送信ゼロ) |
| `src/content/youtube-broadcast-clock.{js,css}` | 配信時刻オーバーレイ（**YouTube クリーナーのサブ機能** `searchFixerFeatures.broadcastClock`、master `searchFixerEnabled` AND で制御。独立 storage key なし・`APPLY_SEARCH_FIXER_CS` を search-fixer.js / youtube-shorts.js / youtube-connection-monitor.js と共に購読・`computeActive()` 判定。**接続モニターと同じ content_scripts エントリに相乗り**）: `*://*.youtube.com/*` の top frame に注入。ライブ配信アーカイブ（`liveBroadcastDetails` を持ち `isLiveNow !== true`）の再生中に、その瞬間の実配信時刻を `yyyy/MM/dd　hh:mm:ss`（全桁ゼロ埋め・全角スペース・24 時間制・ローカル）でプレーヤー左上 HUD に重ねる。配信開始時刻は `/watch?v=<id>` の **same-origin fetch**（`credentials:"same-origin"` + `redirect:"manual"`、search-fixer.js と同型・**外部送信ゼロ維持**）で HTML から `BroadcastClock.parseLiveBroadcastDetails` 抽出 → videoId 単位 sessionStorage cache。`配信時刻 = startTimestamp + currentTime` を `BroadcastClock.computeBroadcastEpochMs` / `formatTimestamp` で算出・整形（純粋関数、`test/actions.test.js` で境界値テスト）。`timeupdate`/`seeked` 駆動 + 250ms throttle、ドラッグ移動可（位置 localStorage 永続化）、`:fullscreen` 追従、context invalidation guard |
| `src/content/image-downloader.{js,css}` | 画像ダウンロード（Instagram / TikTok 共通、YouTube は未提供）: 各クリーナー features の `imageDownload` ON 時に動作。site adapter で各サイトのコンテンツ画像（投稿写真 / 動画サムネ）を判定 → hover で左上に DL ボタン overlay → クリックで `<a download>` + Blob URL 経由で保存。最大解像度 URL 取得 / URL ホワイトリスト ALLOWED_HOSTS / fetch セキュリティ 4 原則 / sibling overlay 検出による host 1 階層上昇 / SCANNED マーカー src 値ベース。`__cpa-img-dl-` クラスプレフィックス。 |
| `src/popup/popup.{html,js,css}` | ポップアップ UI: 5 タブ構成（調整 / YouTube / Instagram / TikTok / カラーピッカー）。調整タブは **7 マスタートグル** + 音量スライダー（左端 🔊/🔇 ミュートボタン）+ 音量サブトグル × 2 + **イコライザパネル（オン/オフ + プリセット + プリアンプ + 10 バンド縦スライダー、EQ_BANDS 駆動で動的生成）** + 動画ガンマスライダー + ルーペ master + 倍率セグメント + サイズスライダー、YouTube タブは 32 機能リスト（接続モニター・配信時刻オーバーレイは `watch_page` カテゴリのサブ機能として FEATURES 駆動で自動描画）、各クリーナータブは独立パネル（FEATURES 配列駆動の動的レンダリング、1 行 1 トグル + 説明文）、カラーピッカータブは EyeDropper 採取 + HEX/RGB/HSL 表示 + format chips + 履歴グリッド。設定保存・復元、適用フィードバック、ダーク/ライト追従、IBM Plex Sans JP サブセット (Regular 400 / SemiBold 600 / Bold 700) 同梱 + popup.html で 3 weight すべて preload |
| `src/popup/fonts/IBMPlexSansJP-{Regular,SemiBold,Bold}.woff2` | popup タイポグラフィ用 woff2 サブセット。Regular / SemiBold は IBM 純正の subset 済み版 (約 77 / 81 KB)、Bold は `scripts/fetch-bold-woff2.mjs` で IBM/plex full CJK Bold (npm `@ibm/plex-sans-jp@3.0.0`) を Regular と同じ cmap (652 unicode) で subset 化した版 (約 200 KB、subset-font の woff2 encoder が IBM 純正より圧縮率低めのため大きい)。preload で並列 fetch するので popup 起動コストへの影響は小 |
| `scripts/fetch-bold-woff2.mjs` | Bold woff2 再生成スクリプト。`pnpm add fontkit subset-font @ibm/plex-sans-jp@3.0.0` 後に `node scripts/fetch-bold-woff2.mjs` を実行すると、既存 Regular の cmap を読んで同じ unicode 集合の Bold woff2 を `src/popup/fonts/IBMPlexSansJP-Bold.woff2` に書き出す。完了後は `pnpm install --frozen-lockfile` で node_modules を pnpm-lock.yaml 通りに復元し、`package.json` / lockfile に紛れ込んだ 3 パッケージを取り除くこと (75 MB の @ibm/plex-sans-jp パッケージは devDependencies には含めない方針) |
| `src/offscreen/offscreen.{html,js}` | 音量ブースター用 offscreen document (tabCapture 経路の AudioContext 実体、**唯一の音量ブースター経路**): AudioContext + プリアンプ GainNode + BiquadFilterNode × 10 (peaking EQ) + DynamicsCompressor (night mode) + 手動 GainNode + DynamicsCompressor (anti-clip) で **EQ + 圧縮 + 増幅 + リミット**。全サイト一律 (EME 動画含む) で popup 経由の tabCapture 経路から使われる。DSP コアは `src/lib/audio-pipeline.js` を共有 |
| `icons/icon.svg` | ソースアイコン (512×512); PNG は `icons/icon-{16,48,128}.png` に生成 |
| `webstore/` | ストア申請用: HTML テンプレート、生成画像、`store-listing.txt`。`generate-screenshots.js` が popup.html から `popup-render.html` + `popup-shim.js` を動的生成 → `01-popup-ui.html` が iframe で実 popup を埋め込んで撮影（drift ゼロ）。生成物 `popup-render.html` / `popup-shim.js` は .gitignore 対象 |
| `manifest.firefox.json` | Firefox AMO 申請用 manifest (Chrome 用 `manifest.json` から `offscreen` / `tabCapture` permission 除外 + `browser_specific_settings.gecko` + `background.scripts` 併記)。zip スクリプトが Firefox xpi 生成時にこれを `manifest.json` として同梱する |
| `.amo-metadata.json` | `web-ext sign --amo-metadata=...` で AMO 初回登録時に渡すメタデータ (license: MIT, categories: ["other"])。CI からは新規 add-on 作成不可なため、初回のみローカル `web-ext sign` で使う |
| `zip.ps1` / `zip.sh` | ストア申請用 ZIP / xpi パッケージ生成 (Windows / Unix)。`-Target chrome\|firefox\|both` で対象切替 |
| `docs/privacy-policy.md` | プライバシーポリシー |
| `test/actions.test.js` | 純粋関数テスト: globalThis 21 個公開 (SettingsSchema 含む) / **FEATURES 件数アサート (SearchFixer 31 / IG 11 / TT 3)** / mergeFeatures / ImageDownloader.isAllowedFetchUrl (Instagram fbcdn / cdninstagram は scontent- prefix 限定 / TikTok p\\d+ 必須 / YouTube 廃止) / detectHost / buildFilename / **セッション維持 / RTX 動画強化 (v1.0.39 で撤去) の関連定数が actions.js から完全消去されている drift 検知** / **接続モニターが SearchFixer.FEATURES の connectionMonitor サブ機能 (watch_page) に統合・旧独立キー (CONNECTION_MONITOR_ENABLED / APPLY_CONNECTION_MONITOR_CS) 撤去済みの drift 検知 + ConnectionMonitor.classify 7 分類境界値 + median 境界値 + VERDICT 識別子固定 + endpoint URL 固定アサート (gstatic.com/generate_204 + 1.1.1.1/cdn-cgi/trace)** / **Loupe.validateZoom / clampSize / computeLensPosition / computeBackgroundPosition / formatLoupeError 境界値** / **SearchFixer.extractHandleFromHref の ASCII + Unicode + URL encoded 境界値** / **SettingsSchema 整合 + APPLY_SETTINGS_KEYS/toStorageRecord generated 検証 + popup get list drift 検知** 等。件数 drift を CI で検知できる単一情報源 |
| `.github/workflows/publish.yml` | `push: branches: release/**` トリガーで **Chrome Web Store** に **アップロード + Submit for review まで自動化** + **Firefox AMO** に `web-ext sign --channel=listed` で並列 submit。Chrome step 失敗時も `if: success() \|\| failure()` で Firefox AMO step は独立実行する (ReplaceFontSelect 流派)。必要 Secrets: `CWS_*` (Chrome 4 件) + `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` (Firefox 2 件)。**xpi / zip 自体はこのワークフローで CI 自動公開、listing メタデータは `~/.claude/skills/vava/scripts/update-amo-listing.mjs` (AMO は API 自動 push 可) / Dashboard 手動 (CWS は API 不対応) で別経路管理**。 |
| `.cws-id` | Chrome Web Store extension ID 単一行ファイル (現状 `lmkdjffdnkadifjjifameboongbngaep`)。`/vava` スキルの汎用 check-store-listing.mjs が env var `CWS_EXTENSION_ID` 未設定時にフォールバック読み込みする。**公開ストア URL の一部に含まれる identifier (秘密情報ではない) なのでコミット対象**、`.gitignore` 不要。`/vava` Step 8.7-B (CWS drift check) からも自動参照される |
| `vava.config.json` | `/vava` スキル (`~/.claude/skills/vava/scripts/{check-store-listing,update-amo-listing}.mjs`) に渡すプロジェクト固有設定。AMO slug / homepage / supportUrl / 表示名 / listing ファイルパス / privacy ファイルパス / categories / CWS extension ID ファイル / drift 判定キーワードを集約。**スクリプト本体はスキル側に汎用化集約**しており、プロジェクトには本ファイルだけ置けば動く設計 (他 Chrome 拡張機能プロジェクトでも同じスキルを再利用できる) |
| `~/.claude/skills/vava/scripts/check-store-listing.mjs` | ストア掲載 listing drift チェッカー (汎用版、スキル側集約)。CWS は公開ページ (`chromewebstore.google.com/detail/<id>`) を fetch して `<meta>` から name / description / version を抽出、AMO は API v5 `GET /addons/addon/{slug}/?lang=all` で取得。drift 判定キーワードは CWD の `vava.config.json` の `driftKeywords.{cws,amo}.{ja,en}` から取得 (未設定なら drift チェックをスキップ)。`--cws` / `--amo` で対象選択可。`/vava` Step 8.7-B から自動実行 |
| `~/.claude/skills/vava/scripts/update-amo-listing.mjs` | Firefox AMO listing 自動 push (汎用版、スキル側集約、API v5 `PATCH /addons/addon/{slug}/`)。name / summary / description / homepage / support_url / categories / privacy_policy を CWD の `vava.config.json` で指定された listing / privacy ファイルから構築して送信。**summary は 250 chars 拒否されるため 249 に truncate / description と privacy_policy は `<` `>` を `&lt;` `&gt;` に pre-escape する (AMO の HTML allowlist に `<video>` `<feComponentTransfer>` 等の技術タグが無く HTTP 406 で silent reject されるため、ReplaceFontSelect 知見ベース)**。screenshots は API 不対応で Dashboard 手動。`~/.amo_token` 2 行構成 (ISSUER / SECRET) から JWT HS256 生成。`/vava` Step 8.7-A から自動実行 |
| `memory-bank/WebRestrictionRemoval/*.md` | プロジェクト横断の長期記憶（projectbrief / productContext / systemPatterns / techContext / activeContext / progress の 6 コアファイル）。activeContext と progress は頻繁更新、systemPatterns は設計パターン履歴。**ホスト側ファイルを直接 Read/Edit せず必ず memory-bank-mcp 経由で操作** |

## Important Patterns

新機能追加・既存機能の改修で踏むべき原則と、過去にハマった罠の対策。詳細はファイル冒頭コメントと該当セクションを参照。

### 目次 (TOC)

**ビルド・配信**
- [Firefox AMO 対応](#firefox-amo-対応-2026-05-16-確立reactivefontselect-の知見ベース) — manifest 分岐 / web-ext lint 0 件化 / strip マーカー方式

**設計の原則**
- [設計の起点](#設計の起点) — actions.js 単一情報源 / バージョン番号運用 / デフォルト OFF 方針
- [メッセージング・content script](#メッセージングcontent-script) — sender 検証 / 二重ロード許容 / early script 共通フレームワーク
- [マイグレーション](#マイグレーション) — `onInstalled` で旧キー削除 + 新キー初期化

**観測・ガード**
- [MutationObserver 取り扱い](#mutationobserver-取り扱い) — 書き戻し guard / cross-document な iframe 制約
- [Extension context invalidation guard PATTERN SYNC](#extension-context-invalidation-guard-pattern-sync-rere-v1028-確立) — 拡張機能リロード後の orphan 化対策
- [Observer / async の罠](#observer--async-の罠) — stale callback / post-await guard
- [Observer guard の 4 段防御 + finally 状態再取得](#observer-guard-の-4-段防御--finally-状態再取得-rere-v1028-強化)

**機能別パターン**
- [hideLiveChat（YouTube ライブチャット非表示）](#hidelivechatyoutube-ライブチャット非表示) — iframe click + CSS 先制非表示 + 復活禁止パターン
- [音量ブースター・Offscreen Document](#音量ブースターoffscreen-document-tabcapture-経路の-audiocontext-実体唯一の経路) — DSP ノード順序 / compressor BYPASS preset / gain ramp 三点セット
- [YouTube DOM の罠](#youtube-dom-の罠v1027-で得た知見) — handle Unicode / Trusted Types / Polymer / thumbnail URL

**機能別パターン（追加）**
- [video-gamma / video-fill の lifecycle 統一](#video-gamma--video-fill-の-lifecycle-統一-v1041-で確立) — per-video inline style + loadedmetadata 待ち + WeakMap original + AbortController + MutationObserver

**外部 fetch / セキュリティ**
- [外部 fetch allowlist 設計](#外部-fetch-allowlist-設計-imagedownloaderallowed_hosts) — 4 原則 / scontent- prefix / same-origin との使い分け
- [image-downloader 並列化のセマンティクス維持](#image-downloader-並列化のセマンティクス維持) — Promise.allSettled で「最大解像度優先」
- [外部 fetch の exponential backoff](#外部-fetch-の-exponential-backoff-rere-v1028-確立)

**ロケール・UI**
- [多言語ロケール](#多言語ロケール) — `aria-label` の ja/en 併記

**ストレージ・設定経路**
- [APPLY_SETTINGS 経路の partial payload 防御](#apply_settings-経路の-partial-payload-防御-v1031-で確立いつの間にか-off4-経路対策) — 経路 A〜D + 6 ポイントチェックリスト
- [音量ブースター popup → storage 直書きの防御](#音量ブースター-popup--storage-直書きの防御-rere-v1028-確立)
- [SW モジュールスコープのストレージキャッシュ](#sw-モジュールスコープのストレージキャッシュ-rere-v1028-確立)

**テスト・観測性**
- [FEATURES 件数アサートテスト](#features-件数アサートテスト-rere-v1028-確立) — ドキュメント整合性の単一情報源
- [`chrome.runtime.sendMessage` の expected error](#chromeruntime sendmessage-の-expected-error-rere-v1028-確立)

**TODO 管理 / 履歴**
- [/rere レビュー TODO 集約](#rere-レビュー-todo-集約-議題化のみ実装は次バッチ判断) — `[active]` / `[settled]` / `[resolved]` タグ運用
- [撤去済み機能と教訓](#撤去済み機能と教訓) — セッション維持 / RTX 動画強化 / MES 経路 撤去履歴と教訓

---

### Firefox AMO 対応 (2026-05-16 確立、ReplaceFontSelect の知見ベース)

WebRestrictionRemoval は Chrome + Firefox 両対応。**音量ブースターは tabCapture 一本に戻したため Chrome 専用** (Firefox MV3 は `chrome.tabCapture` / `chrome.offscreen` 未対応)。Firefox では `HAS_VOLUME_BOOSTER` guard で popup の音量 UI ごと非表示になり、音量ブースター以外の全機能が動作する。Firefox 版ビルドの不変条件:

1. **専用 manifest 分割** — `manifest.firefox.json` を別ファイルで持ち、zip スクリプトが Firefox xpi 生成時に `manifest.json` として同梱する。Chrome 版とは以下が違う:
   - `offscreen` / `tabCapture` permission を **除外** (Firefox MV3 未対応)
   - `browser_specific_settings.gecko` に gecko id + `strict_min_version: "142.0"` + `data_collection_permissions: {required: ["none"]}` を追加 (v1.0.33 で 140 → 142 化。`data_collection_permissions` は Firefox Android 142+ で導入されたため strict_min_version 140 だと矛盾警告が出る)
   - **`background.scripts` 単独**（`service_worker` は記載しない / v1.0.33 で削除）。Firefox MV3 は `service_worker` を ignored 警告対象とするため。Chrome 版は manifest.json 側で従来どおり `service_worker` のみ
   - `minimum_chrome_version` 削除
   - `host_permissions: ["<all_urls>"]` を追加 (Firefox AMO 推奨)

2. **`importScripts` ガード** — `background.js` 冒頭は `if (typeof importScripts === "function") importScripts("/src/lib/actions.js");` でガードする。Firefox event page では importScripts は worker 限定 API のため呼べないが、manifest の `background.scripts` で actions.js を先に評価しているので skip して OK。

3. **`HAS_VOLUME_BOOSTER` ランタイム検知** — `const HAS_VOLUME_BOOSTER = typeof chrome.offscreen !== "undefined" && typeof chrome.tabCapture !== "undefined";` を background.js で定義し、`VOLUME_BOOSTER_SET_GAIN` / `VOLUME_BOOSTER_RELEASE_TAB` メッセージ handler、`chrome.tabs.onActivated` / `chrome.tabs.onRemoved` / `chrome.storage.onChanged` の音量関連経路で早期 return する。

4. **popup の UI 隠し** — `popup.html` の audio section に `id="audioGroupSection"` を付与、`popup.js` の DOMContentLoaded で `if (!HAS_VOLUME_BOOSTER) $audioSection.style.display = "none";`。section は DOM 上残るので `getElementById('volumeBoosterToggle')` が null にならず popup ロジック全体が壊れない設計。

5. **AMO 初回登録** — CI からは新規 add-on 作成不可。ローカルで `WEB_EXT_API_KEY=$AMO_JWT_ISSUER WEB_EXT_API_SECRET=$AMO_JWT_SECRET pnpm exec web-ext sign --source-dir=firefox-build --channel=listed --amo-metadata=.amo-metadata.json` を実行 → gecko id (manifest 内) で AMO 上に新規 add-on 自動作成。**初回完了後は CI の `publish-firefox` job が新バージョン提出を担う**。

6. **web-ext lint で受理性確認** — `pnpm exec web-ext lint --source-dir=firefox-build` で AMO validator 相当チェック。**v1.0.33 から errors / warnings / notices すべて 0 件達成済み**。過去に「許容済み warning」だった 4 カテゴリ (`BACKGROUND_SERVICE_WORKER_IGNORED` / `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` / `UNSUPPORTED_API` / `UNSAFE_VAR_ASSIGNMENT`) は #10 のパターンで全部 0 件化済み。新規 warning が出たら同じ手法で潰すこと。

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
- **バージョン番号は手動で書き換えない** — `manifest.json` / `package.json` の `version` フィールド（および `/vava` での lockfile 再生成で連動する `pnpm-lock.yaml`）およびドキュメント中の `v1.x.y` 表記は `/vava` スキル経由でのみ更新する。コード変更コミットでバージョン番号には触れない。
- **デフォルト OFF 方針徹底** — 7 マスタートグル（YouTube クリーナー / Amazon 合計 / Instagram クリーナー / TikTok クリーナー / 動画ガンマ補正 / ルーペ / 音量ブースター）が `onInstalled` で false 初期化、復元は `=== true` で防御的に判定。音量ブースターはマスター OFF に加え、ON でも「スライダー 100% かつ全サブトグル OFF かつミュート OFF」のときリソース解放される（インストール直後はマスター OFF かつ全サブトグル OFF = 完全に無処理）。ルーペもマスター OFF で content script 内の DOM / リスナーがすべて撤去される（Blob URL も revoke）。接続モニターは YouTube クリーナーのサブ機能（`searchFixerFeatures.connectionMonitor`、デフォルト OFF）で、master `searchFixerEnabled` OFF またはサブ機能 OFF で 1s サンプル timer / 5s 診断 timer / video イベントリスナー / MutationObserver / overlay DOM / drag listener をすべて撤去（外部 fetch も停止し、ライブ視聴中以外は overlay 非表示）。

### メッセージング・content script
- **sender 検証必須** — background の各ハンドラ冒頭で `SenderCheck.isFromPopup()` / `isFromContentScript()` を呼ぶ。新メッセージ追加時はどちらの由来を許可するか明示。
- **content_scripts の二重ロード許容** — `actions.js` は **各 content_scripts エントリで個別にロード** する（manifest.json の各エントリの `js` 配列冒頭に含める）。同一 isolated world で複数回ロードされても `__cpaActionsLoaded` ガード (`src/lib/actions.js` 冒頭) で 2 回目以降は即 return するため、定数二重宣言エラーを起こさず安全。これにより各サイトエントリの実行順序や `run_at` 差異に依存せず、`actions.js` 依存を持つ全 content script が確実に `Actions` / `StorageKeys` 等の定数を参照できる。**例外: `document_start` 専用 early script (`youtube-early.js` / `instagram-early.js` / `tiktok-early.js`) は actions.js を含めない** (最速注入のため、生 storage key 文字列で書く)。理由: `document_start` 注入と `document_idle` 注入は別エントリ扱いだが、同一 isolated world で同じ `const` を二重宣言すると SyntaxError になるため、early は最小スクリプト + actions.js 非読込で衝突を防ぐ。
- **early script は共通フレームワーク経由** — `src/content/early-framework.js` が `<style>` 注入・pre クラス同期付与・`chrome.storage.local.get`・`storage.onChanged` 購読のボイラープレートを集約する (`window.__cpaEarlyFramework.setup(config)`)。各 document_start エントリの `js` 配列で `early-framework.js` を **先頭** に置き、各 early script (`youtube-early.js` / `instagram-early.js` / `tiktok-early.js`) が config を渡して setup を呼ぶ。新サイトの early script を追加する場合もこのパターンに乗せる。サイト固有の MutationObserver / force-hide / URL redirect は各 early script に残す (差異が大きすぎて framework に押し込むと config 肥大化する)。
- **二重実行防止** — `window.__cpaSearchFixerRunning` / `window.__amazonDeliveryTotalRunning` / `window.__cpaAmazonRankingJumpRunning` / `window.__cpaAmazonMerchantInfoRunning` / `window.__ytShortsRemoverRunning` / `window.__cpaInstagramCleanerRunning` / `window.__cpaTikTokCleanerRunning` / `window.__cpaImageDownloaderRunning` / `window.__cpaVideoGammaRunning` / `window.__cpaVideoFillRunning` / `window.__cpaLoupeRunning` / `window.__cpaConnectionMonitorRunning` / `window.__cpaBroadcastClockRunning` / `window.__cpaYtEarlyRunning` / `window.__cpaIgEarlyRunning` / `window.__cpaTtEarlyRunning` のグローバルフラグで同一フレーム内の二重実行を防ぐ。新 content script を足すときも同じ命名で揃える。`__amazonDeliveryTotalRunning` と `__ytShortsRemoverRunning` のみ `__cpa` プレフィックスなしの歴史的命名（互換性のため変更しない、/rere レビュー B1-003）。

### MutationObserver 取り扱い
- **DOM 書き戻しは observer guard 必須** — `subtree: true` 監視中に自身が DOM を書き戻すと再帰発火 → 無限ループでフリーズ。Amazon 月別合計の修正で確立した **`disconnect → render → takeRecords → observe` ガード + `requestAnimationFrame` coalesce** の二重防御を新規 DOM 書き込みロジックでも踏襲する。
- **cross-document な iframe 内 DOM 変化は MutationObserver で観察できない** — `subtree: true` でも iframe の中身は別ドキュメント扱いで届かない。iframe 内要素を相手にする場合は `iframe.addEventListener("load", ...)` で再評価タイミングを別経路で確保する（hideLiveChat の close button click はこのパターンに該当）。

### Extension context invalidation guard PATTERN SYNC (/rere v1.0.28+ 確立)
拡張機能リロード / 自動更新後、既存タブの content script は **orphan 化** する。`chrome.runtime.id` が `undefined` になり、`chrome.i18n.getMessage` / `chrome.runtime.sendMessage` 等が "Extension context invalidated" で throw する。MutationObserver / setInterval は orphan でも止まらないため、自前で停止する必要がある。

**実装済みファイル (12 ファイル + early 3 ファイル)**: `image-downloader.js` / `amazon-delivery-total.js` / `amazon-ranking-jump.js` / `amazon-merchant-info.js` / `search-fixer.js` (5 つの MO callback + pagehide + 共通 `cleanupAllSearchFixerStateForOrphan` で集約、/rere B2-012+B2-018 で v1.0.30 に追加) / `video-gamma.js` / `video-fill.js` / `loupe.js` / `tiktok-cleaner.js` / `youtube-shorts.js` / `instagram-cleaner.js` / `youtube-broadcast-clock.js` (instagram-early.js / tiktok-early.js / youtube-early.js も同パターン: early-framework の `storage.onChanged` guard に加え、各 early script 自身の MutationObserver callback 冒頭に `chrome.runtime?.id` guard + OFF 時 `disconnect` を持つ。/rere F-1 で youtube-early.js の frameObserver の guard 欠落を修正し instagram-early.js と統一)

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
- **`display: none` を主とし `visibility: hidden` を併用** している (SPA 遷移で YouTube が frame に inline `display:flex` を当てた 1 フレーム、class の display:none は負けるが visibility:hidden は YouTube が触らないため勝ち、コメント本体の一瞬チラ見えを防ぐ。/rere D-1/B1-A1。CSS class と youtube-early.js の inline force-hide の両方で display+visibility を当てる)。旧「visibility:hidden 単独」は layout 領域 402×964 px が空白枠として 2 秒残る実機問題があったが、display:none が主で効く限り layout は出ないため再発しない。pre クラスは click 成功で必ず剥がれる設計なので、過去 NG だった `__cpa-sfx-live-chat-force-hide` の「永続 display:none」とは別物

復活禁止の失敗パターン:
- 独自クラス `__cpa-sfx-live-chat-force-hide` を frame に付与 → frame ごと `display: none` で collapsed view ヘッダー（「パネルを開く」）まで消し、SPA 副作用も誘発
- `setAttribute("collapsed", "")` で標準属性を直接立てる → ライブ配信中で player 再初期化 →「動画を処理しています」エラー
- CSS `iframe.ytd-live-chat-frame { height: 0 }` (collapsed 条件付き or 無条件いずれも) → SPA panel state が不整合で player 副作用
- CSS `#chat-container:has(...) { display: none }` / `--ytd-watch-flexy-sidebar-width: 0` → 同上 + ユーザーが「パネルを開く」を再表示できなくなる
- frame 内の `#close-button` を top frame から `document.querySelector` で探す → そもそも iframe の中なので届かない（`iframe.contentDocument` 必須）
- pre クラス剥がしを click 成功 *直後* に行う → YouTube が collapsed transition を DOM 反映する前に display:none が解除され、frame default expand state が paint されてしまう (Edge 動画キャプチャで約 270ms expand 表示を確認)。必ず `collapsed` 属性付与を rAF polling で待つ

### 音量ブースター・Offscreen Document (tabCapture 経路の AudioContext 実体、唯一の経路)

音量ブースターは tabCapture → offscreen の AudioContext 一本（MES 経路 `volume-booster.js` + 自動音量正規化は撤去済み、全サイト一律で EME 動画も含む）。以下の不変条件はこの唯一の経路に適用される。

**オーディオ路の不変条件**:
- **ノード順序は `source → preampNode → eqFilters[0..9] → nightModeNode → gainNode → antiClipNode → destination` に固定** — EQ プリアンプ → 10 バンド peaking フィルタ → ナイトモードでダイナミックレンジを狭め、手動 gain でブーストし、後段に limiter (anti-clip) を置く。gain を先頭に置かず compressor の後段に置くことで「EQ → 圧縮 → 増幅 → リミット」のマスタリング順を保つ。
- **gain は対数マッピング + `setTargetAtTime` ramp** — UI スライダーは内部値 0..200、実音量は左端 0% / 中央 100% / 右端 600%。100..600 区間の実 gain は `VolumeBooster.percentToGain()` で対数変換し、等距離 = 等 dB ステップにする。`gainNode.gain` への直接 `.value =` 代入はサンプル境界の不連続でクリック発生 → 必ず `cancelScheduledValues` → `setValueAtTime(現在値, now)` → `setTargetAtTime(target, now, RAMP_TIME_CONSTANT)` の三点セットで ramp 経由（`RAMP_TIME_CONSTANT = 0.015` で 3τ ≈ 45ms 95% 到達、popup の 120ms debounce より十分短い）。
- **DynamicsCompressor は disconnect ではなく BYPASS preset で OFF** — ナイトモード / 自動歪み防止のサブトグル OFF 時にノードを disconnect/reconnect すると AudioContext のグラフが切れて一瞬無音になりプチノイズが乗る。`COMPRESSOR_BYPASS`（`ratio:1`、threshold/knee 中立）を `applyCompressorPreset` で当てれば素通り化が無音ゼロで実現（切替頻度が低くアタックが速い 1〜50ms ため `setTargetAtTime` 不要、`.value =` 直接代入で十分）。
- **イコライザも disconnect ではなく 0dB / unity gain で OFF** — EQ OFF 時に BiquadFilterNode 群を disconnect/reconnect すると compressor と同様に音切れが起きる。`applyEqualizer(state, false, ...)` で preampNode.gain = unity (1.0)、eqFilters[i].gain = 0dB (素通り) に ramp で戻すことで、チェーン上は常時接続のままバイパス。手動操作中のスライダーでも周波数特性の連続変化が ramp で段差なし。**固定フィルタでフィードバック無し**（撤去した自動音量正規化と違って測定 → 補正ループがない）ため決定論的に安定。
- **volumeGetGain は `state.lastSetPercent` を返す** — `gain.value` はランプ中で目標値と一致しないため、ユーザーが最後に指定した整数 percent を保持して round-trip 誤差ゼロを担保。`gainToPercent(gain.value)` 経由だと使えない。

**ライフサイクルの不変条件**:
- **マスター OFF = パイプライン解放、設定は保持** — `volumeBoosterEnabled` が `false` になったら `releaseAllVolumeBoosterTabs()` で全 AudioContext を解放するが、`volumeBoosterLastGain` / サブトグルの storage 値は一切触らない。次回 ON 時に保存済み値を復元する。
- **UNITY release 条件は「100% かつ全サブトグル OFF かつミュート OFF かつ EQ OFF」** — `setVolumeBoosterGain` で UNITY 早期 return するのは `clamped === UNITY && !antiClipFlag && !nightModeFlag && !mutedFlag && !eqActiveFlag` のときだけ。100% でもサブトグル / EQ ON なら AudioContext 維持で compressor / EQ を効かせる。「突発音だけ抑える」「ナイトモードだけ使う」「100% で完全消音」「100% で EQ だけかける」ユースケースを維持する。
- **`releaseAllVolumeBoosterTabs` の SW 再起動フォールバック** — SW 再起動後は `boostedTabIds` が空だが offscreen に生きた AudioContext がある可能性あり。`boostedTabIds` が空かつ `offscreenState !== "CLOSED"` のとき `ACTION_VOLUME_RELEASE_ALL` を offscreen に直接送信する。
- **`autoApplyVolumeBooster` は既 boost タブ限定** — `boostedTabIds.has(tabId)` ガードにより、`tabs.onActivated` では既存 AudioContext の gain ramp だけが走る。新規タブへの初回適用は popup open（= user gesture）が必要（`tabCapture.getMediaStreamId` の user gesture 要件）。
- **アイドル close 抑止** — `isVolumeBoosterActive` で boost 中タブを query。先頭で `offscreenState === "CLOSED"` を見て早期 false return すること（query 不要 + receiver 不在経路の誤判定回避）。SW 再起動直後など sendMessage が一時失敗した場合のみ安全側（active 扱い）に倒す。
- **タブクローズで自動 release** — `chrome.tabs.onRemoved` は permission 不要 + SW 再起動でも永続発火するため、AudioContext の取り残しを防げる。

**API / 制約**:
- **Offscreen Document の 1 拡張 1 文書制約** — `reasons` は `["USER_MEDIA", "AUDIO_PLAYBACK"]`。新しい用途を追加するときは既存ドキュメントに同居させること。
- **`minimum_chrome_version: "140"` 固定** — `chrome.runtime.getContexts`（116+）等の new API は **typeof チェックなしで直接呼んで良い**。legacy fallback の `if (typeof chrome.runtime.getContexts !== "function")` 分岐はバグ温床（receiver 不在エラーを active 扱いして 30 秒 cycle 無限再 schedule した Codex P2 指摘あり）なので追加しないこと。

**DSP preset チューニング履歴** (新規に DSP に触る前に必ず読む。値定数の正は `src/lib/actions.js` `VolumeBooster`、フロー制御の正は `src/lib/audio-pipeline.js`。ナイトモード / 自動歪み防止 preset の調整履歴は actions.js の `NIGHT_MODE_PRESET` / `ANTI_CLIP_PRESET` コメントを参照):

| Version | 変更内容 | 動機 / 棄却された alternative |
|---|---|---|
| v1.0.x | DynamicsCompressor のサブトグル OFF で `disconnect/reconnect` 経路 | **棄却**: 一瞬無音化 + プチノイズ。`COMPRESSOR_BYPASS` preset (`ratio:1`、threshold/knee 中立) で素通り化に置換 → 切替頻度低 + アタック速 (1-50ms) のため `.value =` 直接代入で十分 |
| (基盤) | gain ramp は対数マッピング + `setTargetAtTime` 3 点セット | `gainNode.gain.value = X` 直接代入はサンプル境界の不連続でクリック音発生 → 必ず `cancelScheduledValues` → `setValueAtTime(現在値)` → `setTargetAtTime(target, now, τ)` の三点セット。`RAMP_TIME_CONSTANT = 0.015` で 3τ ≈ 45ms 95% 到達 (popup の 120ms debounce より短い) |

> 自動音量正規化 (EMA / silence gate 二重判定 / dead zone / 非対称 ramp 等の AGC チューニング) は v1.0.38 / v1.0.39 / 2026-06-07 と何度も調整したが、リアルタイム AGC として実用水準に届かず機能ごと撤去した (2026-06-19)。詳細な経緯と棄却した alternative は §撤去済み機能と教訓「自動音量正規化」を参照。

### YouTube DOM の罠（v1.0.27 で得た知見）
- **YouTube `/feeds/videos.xml` は廃止済み (404)** — credentials 有無 / channel_id を変えても全部 404。代替は `/${handle}` HTML 内の `"videoId":"..."` から `https://i.ytimg.com/vi/{videoId}/maxresdefault.jpg` を組む方式。
- **thumbnail URL のアスペクト比は要確認** — `hqdefault.jpg` (480x360, **4:3** = letterbox あり) は 16:9 枠で違和感が出るので使わない。`maxresdefault.jpg` (1280x720, 16:9) を第一候補、404 で `mqdefault.jpg` (320x180, 16:9, 全動画必須) フォールバック。
- **YouTube native CSS の `max-width` 制約** — `[use-bigger-thumbs] #avatar-section { max-width: 500px }` のような制約は `width: 100% !important` だけでは超えられない。card 全幅にしたい場合は **`max-width: none !important`** を明示する。
- **Polymer dom-repeat 配下に `<a>` を sibling 挿入してはいけない** — `ytd-guide-section-renderer` 等の Polymer 管理下に外部から sibling として `<a>` を挿入すると、Polymer が「list 構造が変わった」と検知して内部 reorder を発動し、想定外の section 移動が起こる。代わりに **`#items` の中**に `<a>` を inject する（`subsLeftnavInjectAll` / `subsAllShortcut` のパターン）。
- **subs section の DOM 構造**: `#header-entry` は別の `#header` div、`#items.firstElementChild` は collapsible (見出しっぽい expander)。`querySelector("ytd-guide-entry-renderer:not(#header-entry)")` で最初のチャンネル entry を取得して直前に挿入するのが正解。
- **Trusted Types policy 対応**: YouTube は Trusted Types を有効化しているため、`innerHTML` 文字列代入は MAIN world で弾かれる。content script の isolated world では制約緩いが、安全側で **`createElement` ベース**で構築。SVG は `createElementNS` を使う。
- **handle は ASCII 限定じゃない、URL エンコード必須**（2026-05-13 修正） — YouTube ハンドルには日本語 / 韓国語 / 中国語 / アクセント記号など Unicode が含まれるケースが多数（`@むめいの有名になりたい` / `@あゆむさんぽ` / `@Ailas足脚の世界` 等）。DOM の `getAttribute("href")` は **URL エンコード形式** (`/@%E3%82%80...`) で返すため、`href.match(/(@[\w.-]{1,60})/)` のような ASCII 専用正規表現では完全に失敗する。`SearchFixer.extractHandleFromHref` (`src/lib/actions.js`) で **`decodeURIComponent` → Unicode property escapes `\p{L}\p{N}` マッチ** で実装している。subsChannelsGrid のサムネ取得が日本語ハンドルで永遠にスキップされる重大バグの原因だった。新規に handle を扱うコードを書くときは必ず `SearchFixer.extractHandleFromHref` を使うこと。

### video-gamma / video-fill の lifecycle 統一 (v1.0.41 で確立)

video element に視覚エフェクト (filter / transform) を inline style で当てる content script は **video-fill のパターンを正として揃える** こと。video-gamma も v1.0.41 で旧 CSS rule 一斉注入から video-fill 同型に移行済み。

**統一パターン (両 cs 共通)**:
1. **per-video inline style + `!important`** で apply (CSS rule 注入はしない、`<head>` の `<style>` 注入も廃止)
2. **`loadedmetadata` 待ち** で apply (intrinsic size 不要な video-gamma でも待つ、DRM player の session 取得完了後に効果が当たる挙動に統一)
3. **`original` WeakMap** で元 inline style (priority 込み) を退避、`revertVideo` で復元 (撤去時の状態保証)
4. **`metaListenerCtrl` (AbortController)** で listener 一括 abort、`revertAll` で新 AbortController に差し替え
5. **`metaAttached` (WeakSet)** で二重登録防止、revertAll で `new WeakSet()` に差し替え (detach 済み video も含めた追跡を O(1) 一括リセット、DOM プロパティマーカーだと取り残し発生する Codex 4 巡目 P2 対策)
6. **MutationObserver(subtree)** で SPA / 遅延追加 video を追従、`removedNodes` 検知時に `isConnected` チェックで非接続 video を即 `revertVideo` (reparent は除外、後続 scanAndApply で再 attach)
7. **rAF coalesce (`scanRaf`)** で高頻度 mutation を 1 フレーム 1 回に間引き
8. **`pagehide` (persisted=false)** で teardown、bfcache 凍結 (persisted=true) は observer 凍結で CPU 消費ゼロのため温存
9. **`chrome.runtime?.id` orphan guard** で拡張リロード後の content script orphan 化を検知 → `teardownOrphan` で observer 切断 + revertAll + 関連 DOM 撤去

**video-fill 固有 (video-gamma にない)**:
- `videoWidth/videoHeight` を読んで `VideoFill.computeTransform` で video ごとに拡大率算出
- `MAX_SCALE` clamp
- `zoom` / `stretch` モード分岐

**video-gamma 固有 (video-fill にない)**:
- SVG filter ホスト (`ensureSvgFilter` で `<filter>` を `<body>` に inject、URL 参照 `filter: url(#__cpa-video-gamma)` のため同一ドキュメント必須)
- `removeSvgFilter` で OFF 時に svg host も撤去 (svg host だけ残置すると `pointer-events:none + off-screen` でも DOM 汚染)
- value 変更時は `ensureSvgFilter` の子ノード差し替えで exponent を更新 (host 再作成は不要)

**新規 video 系視覚エフェクト cs を追加する場合の必須チェックリスト**:
- [ ] inline style + `!important` で apply (CSS rule 注入はしない)
- [ ] `loadedmetadata` 待ちで apply (DRM player 干渉回避)
- [ ] `original` WeakMap で元 inline style 退避 + `revertVideo` で復元
- [ ] `metaListenerCtrl` AbortController で listener 一括解除
- [ ] `metaAttached` WeakSet で二重登録防止
- [ ] MutationObserver で detach 即 revert + rAF coalesce
- [ ] `pagehide(persisted=false)` で teardown
- [ ] `chrome.runtime?.id` orphan guard
- [ ] iframe 内 cs (`all_frames: true`) でも各 frame 自身の document に対して処理

**復活禁止の失敗パターン**:
- `<head>` に `<style>video { effect: ... !important }</style>` を CSS rule 注入する (= 旧 video-gamma 方式): video element の readyState 関係なく一斉適用 → DRM session 取得中に当たって player attestation 干渉する理論的リスク
- `loadedmetadata` を待たずに即 apply: 同上のリスク。intrinsic size 不要な effect でも待つ
- DOM プロパティマーカー (`v.__cpaAttached = true`) で listener 二重登録防止: detach 済み video のマーカーが取り残されて reinsert+再 ON 時に listener 再 attach 不能 (= Codex 4 巡目 P2 で実例化)

### 外部 fetch allowlist 設計 (`ImageDownloader.ALLOWED_HOSTS`)
画像ダウンロード機能が許可する CDN ホストは `actions.js` の `ImageDownloader.ALLOWED_HOSTS` で regex 配列として宣言する。**任意サブドメインを通す広いパターンは禁止** (`evil.{cdn}.com` を allowlist 通過させて代理 fetch 攻撃面を作る)。

**採用パターン**:
- **Instagram fbcdn** は `scontent-` prefix 限定 (`/^scontent-[a-z0-9-]+\.fna\.fbcdn\.net$/` 等) — `evil.fbcdn.net` 等を通さない設計
- **TikTok** は `p\d+` プレフィックス必須 (`/^p\d+(-[a-z0-9-]+)?\.tiktokcdn(-us)?\.com$/`) — `evil.tiktokcdn.com` / `tracking.tiktokcdn-us.com` / `static.tiktokcdn.com` を全部拒否 (/rere レビュー A2-SC-1 で確立)
- 新サブドメインを追加する場合は **prefix 必須化** を守ること (実 prefix が「p<数字>」「scontent-」のような構造プレフィックスを持っている場合のみ許可)

**fetch セキュリティ 4 原則** (**external cross-origin fetch 向け** — image-downloader.js の fbcdn / tiktokcdn / i.ytimg.com 等の CDN fetch):
1. `credentials: "omit"` — クロスオリジン Cookie 送信を回避
2. `redirect: "manual"` — 302 経由の第三者ドメインへの認証情報送信を遮断 (opaqueredirect は `r.ok === false` 扱いで自動スキップ)
3. `referrerPolicy: "no-referrer"` — リファラ送信ゼロ
4. `hostname` を `ALLOWED_HOSTS` で検証 — 攻撃者注入 `<img>` 経由の代理 fetch を防ぐ

**⚠️ 4 原則は external cross-origin fetch 専用。same-origin 認証 fetch は別パターン**: `/feed/channels` / `/${handle}/videos` / `/${handle}/streams` (search-fixer.js、YouTube 自身のログイン必須ページから登録チャンネル / 動画リストを取得) や SharePoint 等への HTTP ping (keepalive.js) は **`credentials: "same-origin"` + `redirect: "manual"`** を使う。`credentials: "omit"` にすると認証セッションが切れて登録チャンネル一覧等が取得できず機能が壊れる。`referrerPolicy: "no-referrer"` / `ALLOWED_HOSTS` 検証は same-origin では無意味なので付けない (referrer は自オリジンへの送信で漏洩にならず、宛先は固定 same-origin のため)。`redirect: "manual"` だけは両パターン共通で必須 (認証プロキシ環境の cross-origin 302 で Cookie が漏れる経路を opaqueredirect = `r.ok === false` 扱いで遮断)。**external CDN ルール (4 原則) を same-origin 認証 fetch に丸ごと適用しないこと** (/opop で CodeRabbit がこの 2 パターンを混同して `credentials: "omit"` を誤提案した実績あり)。

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
- **`onInstalled` で旧キー削除 + 値転写** — 廃止 storage key（過去例: `copyPasteSettings` / `enabled` / `contextMenuAllowDomains` / `ytShortsRemovalEnabled` / `keepAliveOrigins` / `keepAliveEnabled` / `keepAliveIntervalMs` / `keepAliveHttpPingEnabled` / `rtxEnhancerEnabled` / `volumeBoosterNormalizeEnabled`）は `chrome.storage.local.remove` で取り除く。値の意味が新キーに引き継がれるなら、削除前に転写する（v1.0.18 で `ytShortsRemovalEnabled === true` → `searchFixerFeatures.removeShorts = true` + `searchFixerEnabled = true` を実施）。**動作継続を最優先**で設計する。注: `volumeBoosterEnabled` は過去に廃止→再導入されたキー。legacy 削除リストに含めないこと。`keepAliveOrigins` は v1.0.34 でサイト単位設計→全タブ共通設計に変更時に削除、同時に `keepAliveEnabled` を強制 `false` リセット (UX 把握困難性の解消が目的のクリーンスタート方針、ゆろさん指示)。**「セッション維持」機能と「RTX 動画強化」機能自体は v1.0.39 で完全撤去**、関連 4 キーは `onInstalled` の legacy 削除リストに集約。
- **新規 storage key は `onInstalled` で必ず初期化** — `volumeBoosterEnabled` / `volumeBoosterLastGain` / `volumeBoosterAntiClipEnabled` / `volumeBoosterNightModeEnabled` / `searchFixerFeatures.hideComments` のような後追いキーは未設定時 `undefined` で UI 側に出るとトグルが表示されない・無効状態になるため、必ず `onInstalled` で `false` (boolean) / `VolumeBooster.DEFAULT` (数値) 初期化する。`normalizeSettings()` 側でも `=== true` 防御的判定を入れる（`!!value` だと storage の落ちた object 値で誤判定が出るため）。

### APPLY_SETTINGS 経路の partial payload 防御 (v1.0.31 で確立、「いつの間にか OFF」4 経路対策)

ユーザーが「拡張機能の更新で設定がいつの間にか OFF になる」と感じる現象は **コードレベルの 4 つの落とし穴** が原因。各経路は独立しているため **複合防御** が必須。新規 master トグル / storage key 追加時は本セクションのチェックリストを必ず通すこと。

**経路 A: サイト単位 ON 設計の不可視性 (歴史的経緯・現在は廃止)**
v1.0.x 系では「セッション維持」を `keepAliveOrigins` 配列で **サイト単位 ON/OFF** する設計にしていた。
しかし「いま何サイトに保存されているか」がユーザーから把握困難で、別サイトで popup を開くと
master トグルが OFF 表示になって「消えた」と誤認される UX 問題があった。`updateKeepAliveSitesCount()` で
「N サイト保存中」バッジを添えて可視化していたが、根本的にはサイト単位設計が把握コスト高で、
ゆろさん指示で **全タブ共通設計に統一** した (旧 `keepAliveOrigins` 関連コードは全削除済み)。
- **新機能でサイト単位 ON/OFF を採用しない**: 個別タブ単位での適用が必須な機能は「全タブ共通 master + content script 側でホスト判定して早期 return」のパターンを使う (例: Amazon 系 content script の URL パターン制限)。これで master 1 個で全体把握が可能、かつタブごとの差別化も両立できる。

**経路 B: popup 内変数の stale 化 race**
popup の `apply()` が popup load 時のスナップショット変数を元に storage を書き戻すと、複数 popup 同時開きや別経路書き換えで race が起きて他 popup の追加分が wipe される。
- 対策 1: popup の `apply()` 入口で対象キーを `chrome.storage.local.get(KEY)` で **再取得してからマージ**する。失敗時のみ popup 内変数フォールバック
- 対策 2: popup の `chrome.storage.onChanged` リスナーで対象キーを監視 → popup 内変数 + UI を即同期 (二重防御)
- 対策 3: 該当 syncing をヘルパー関数化 (`sync<Feature>ToggleFromState()` 命名規則) して popup load 時の評価ロジックと共通化。複合条件 (storage 値 × 現在タブ状態) を持つトグルで特に有効

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

**経路 D: popup の stored get リスト欠落 (致命バグパターン、過去 RTX 動画強化機能で発覚)**
popup load 時の `stored = await chrome.storage.local.get([...keys])` リストと、stored 参照箇所 (`stored[KEY]`) は完全に対応している必要がある。**get リストに無いキーを参照すると `undefined` → UI で常に false 表示 → apply() で false 上書き → storage の既存 true が破壊**される。
- 対策: 新規 master トグル / 設定キー追加時の **6 ポイントチェックリスト** を必ず通す
  1. `StorageKeys.<KEY>` を `src/lib/actions.js` に追加
  2. `onInstalled` の defaults 初期化リスト (`background.js`) に `<KEY>` を追加
  3. `APPLY_SETTINGS_KEYS` / `normalizeSettings` / `toStorageRecord` の 3 関数全てに `<KEY>` を追加 (drift 防止)
  4. **popup の `stored = chrome.storage.local.get([...])` リストに `<KEY>` を追加** ⚠️
  5. popup の `apply()` payload に `<KEY>` を含める
  6. `test/actions.test.js` の `SettingsSchema` 整合アサートで件数を更新
- 過去事例: v1.0.31 で当時の RTX 動画強化 master キーが #4 だけ漏れていて、popup 表示が常に OFF → 別トグル変更で storage 上書き → 永久 OFF 化する致命バグを修正 (RTX 動画強化機能自体は v1.0.39 で撤去済み、教訓だけ残置)

### 音量ブースター popup → storage 直書きの防御 (/rere v1.0.28 確立)
**音量ブースター 9 キー** (`volumeBoosterEnabled` / `volumeBoosterLastGain` / `volumeBoosterAntiClipEnabled` / `volumeBoosterNightModeEnabled` / `volumeBoosterMutedEnabled` + EQ 4 キー `volumeBoosterEqEnabled` / `volumeBoosterEqGains` / `volumeBoosterEqPreamp` / `volumeBoosterEqPreset`) のみ popup から直接 `chrome.storage.local.set` する設計で、background の `normalizeSettings` を経由しない。
- popup の `pushVolumeNow` は **必ず `VolumeBooster.clampValue(value)` を経由**して storage / `VOLUME_BOOSTER_SET_GAIN` 両方に渡す（範囲外値が storage に紛れ込むのを防ぐ二重防御）。EQ も同様に `clampEqGain` / `clampEqPreamp` / `normalizeEqPreset` で正規化済みの値だけ storage に書く。
- **EQ_GAINS / EQ_PREAMP は `storage.onChanged` 同期から除外** (メイン音量スライダー `LAST_GAIN` と同じ非対称設計): EQ スライダードラッグ中、自身の `persistEq` 書き込みが onChanged で同 popup に戻ると `syncEqUi` がドラッグ中のスライダー値を clamp+整数化値で上書きしてカクつく self-write feedback を防ぐ。`EQ_PRESET` は離散値で連続性問題がないため select 表示のみ同期する。
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
- 1 つでも update 漏れると `pnpm test` で fail → CI で drift を検知できる
- 過去に 22 / 25 / 26 / 29 が混在した状態が再発しないようにこのテストで防御

### `chrome.runtime.sendMessage` の expected error (/rere v1.0.28 確立)
マッチしないタブ（`chrome://` / `file://` / `about:` 等）への `chrome.tabs.sendMessage` は **受信側不在で必ず reject** する → これは **expected behavior**。
- 該当箇所の `.catch(() => {})` は silent skip が正解
- 一括 `console.debug` 化は spam ログを生むので NG（毎回のタブ切替で大量出力）
- 将来の観測性改善は「URL pattern マッチが先に確定している経路（例: `isYouTubeUrl(tab.url) === true` のあと）でのみ詳細ログ」の **expected/unexpected 分離設計** が前提

### /rere レビュー TODO 集約 (議題化のみ・実装は次バッチ判断)

ここは /rere レビューで信頼度 medium 以下に降格した、または arch-judgment として議題化のみと判定された項目を集約する。新しい /rere レビューを実行する前に必ず読み返し、`[active]` のみ再評価対象とする。

**状態タグ凡例**:
- `[active]` — 議題継続中。次の /rere バッチで再評価対象
- `[settled YYYY-MM-DD: 理由]` — 設計判断として議題打ち切り。同じ提案が再浮上したら settle 理由を参照
- `[resolved YYYY-MM-DD: 実装位置]` — 実装で解消済み。記録のみ残置

#### 1. `scheduleOffscreenClose` の N 個並列発射 (B1-003 / V2 downgrade) `[active]`
- 場所: `src/background/background.js` の `releaseVolumeBoosterTab` finally
- 状態: `scheduleOffscreenClose` 自体は `clearTimeout + setTimeout` で idempotent、機能破壊ゼロ。code smell + 最大 30 秒 close 遅延のみ
- 議題: 「`releaseAllVolumeBoosterTabs` の Promise.all の後で 1 回だけ呼ぶ」設計に変更すべきか、現状の冪等性に任せるか

#### 2. `chrome.runtime.lastError` 読み取り不統一 (B1-008 / V2 downgrade) `[active]`
- 場所: `src/background/background.js` の sendMessage 経路 (`getMediaStreamId` のみ callback で lastError 読み取り、他は Promise API で .catch)
- 状態: Promise API は Chrome 88+ で lastError を reject に自動変換するため実害ゼロ
- 議題: `safeSendMessage` ヘルパに統一するか、現状の dual style を残すか

#### 3. `isVolumeBoosterActive` 永久 cycle リスク (F-OPS-3 / D-006 / V2 downgrade) `[active]`
- 場所: `src/background/background.js:940-979, 858-908`
- 状態: SW 再起動直後の通信失敗で safe-side true → 30 秒 cycle 永続化リスクあるが、自己修復構造 (次回 sendMessage 成功で false に転じる) + 30 秒間隔で CPU 影響観測不能
- 議題: `chrome.offscreen.hasDocument` (Chrome 116+) や `chrome.runtime.getContexts` で物理確認して同期するべきか

#### 4. F-003 seqId race protection の再帰呼び出し (D-005 / V2 downgrade) `[active]`
- 場所: `src/background/background.js:385-415`
- 状態: 再帰経路は構造的に終端 (新規 seqId 発行で旧 seq invalidate、最大 1 階層) + popup ドラッグと onActivated 同時発火確率は実測ゼロに近い
- 議題: 完全 Promise-based reconciliation に置き換えるか、現状の再帰で十分か

#### 5. リリース失敗時の能動通知経路 (F-OPS-4 / V2 downgrade) `[active]`
- 場所: `.github/workflows/publish.yml`
- 状態: GitHub Actions の default email 通知で OAuth rotation 失敗等は検知可能
- 議題: `gh issue create` の `if: failure()` step を追加するか、現状の default 通知に任せるか

#### 6. sendMessage に相関 ID なし (F-OPS-5 / V2 downgrade) `[active]`
- 場所: 全 sendMessage 経路
- 状態: `captureVisibleTab` は windowId 単位で 1 callable な API のため、複数 window 同時 capture でも sender 経由でタブ ID 区別可能
- 議題: 複数タブ同時利用時の障害切り分け用途で `requestId: crypto.randomUUID()` を入れるか、必要になってから追加するか

#### 7. `applySubsGridFilter` 2 重走査 (C1-002 / V2 downgrade) `[active]`
- 場所: `src/content/search-fixer.js:2955-2997`
- 状態: 5000 ch 登録 + 高速 typing で 100ms hitch のみ (debounce 80ms で吸収)、現実的ユーザー稀
- 議題: 5000ch ユーザーが実機報告されたら shelf → cards グルーピング Map で最適化

#### 8. `:is()` セレクタ最適化コメント (C1-001 / V2 downgrade) `[active]`
- 場所: `src/content/image-downloader.js:600-617`
- 状態: 「10-30ms 削減」コメントの実測根拠なし。Chrome バージョン依存
- 議題: 性能測定で実測してコメント修正、または属性 selector を別 QSA に分離

#### 9. Firefox MV3 catch-up で `__FIREFOX_STRIP_BEGIN__` マーカー方式が負債化 (D-007 / arch-judgment) `[settled 2026-06-06: 現状運用安定、再評価トリガー設定済み]`
- 場所: `src/background/background.js` の strip マーカー 3 箇所 + `zip.{ps1,sh}` + `.github/workflows/publish.yml` の perl 削除処理
- 状態: 現状 3 マーカーで AMO warning 0 件達成、安定運用中
- 議題: Firefox が `chrome.offscreen` 対応した日 / 機能差異が線形に増加した日に「環境抽象層 `src/lib/env/{chrome,firefox}.js`」への移行を再評価
- 次の Firefox/Chrome 差異拡大ポイント (例: Chrome Side Panel API 採用 / Firefox declarativeNetRequest 差異対応) で再評価する

#### 10. `globalThis` 21 generic 名前 (D-004 / V2 drop) `[settled 2026-06-06: cost > benefit、theoretical リスクのみ]`
- drop 判定だが将来仕様変更耐性のため記録: MV3 で isolated world の realm 分割が来た場合の全機能死亡リスクは theoretical のみ。`__cpa` namespace への一段降格は cost 高 vs benefit 低の trade-off で現状維持

#### 11. captureVisibleTab 2fps 制限 (D-008 / V2 downgrade) `[settled 2026-06-06: 「動画一時停止用途」と明示的設計選択]`
- 場所: ルーペ動画拡大時の視覚的遅延
- 状態: CLAUDE.md で「動画一時停止用途」と明示的設計選択
- 議題: 将来「リアルタイム動画拡大」UX を追加するなら HTMLVideoElement.captureStream + canvas drawImage への hybrid 設計を検討

### 撤去済み機能と教訓

過去に実装したが運用上の問題で完全撤去した機能と、その撤去から得た教訓を集約する。本文の他箇所の言及は本セクションを参照する記法に統一する。**新規機能設計時に同じ罠を踏まないため、必ず読む**。

#### セッション維持 (撤去: v1.0.39、当初導入: 〜v1.0.33)
- **何だったか**: 指定したサイトを「ログイン状態保持」用に定期的に open / fetch して認証セッションを延命する機能。`keepAliveOrigins` 配列でサイト単位 ON/OFF。
- **撤去理由**: (1) 「いま何サイトに保存されているか」がユーザーから把握困難 (master トグル + サイトカウンタバッジでも認知負荷高)、(2) 別サイトで popup を開くと master が OFF 表示で「消えた」と誤認される UX 問題、(3) 全タブ共通設計に統一する過程でクリーンスタート判断。
- **撤去内容**: `keepalive.js` content script / `keepAliveOrigins` / `keepAliveEnabled` / `keepAliveIntervalMs` / `keepAliveHttpPingEnabled` の 4 storage key を `onInstalled` legacy 削除リストに集約。
- **教訓 1 (新規機能でサイト単位 ON/OFF を採用しない)**: 個別タブ単位での適用が必須な機能は「全タブ共通 master + content script 側でホスト判定して早期 return」のパターンを使う (例: Amazon 系 content script の URL パターン制限)。これで master 1 個で全体把握が可能、かつタブごとの差別化も両立できる。
- **教訓 2 (same-origin 認証 fetch のセキュリティパターンは別物)**: 撤去前のコードで使われていた `credentials: "same-origin"` + `redirect: "manual"` パターンは現存の `search-fixer.js` (`/feed/channels` 等) でも有効。`credentials: "omit"` 化提案 (CodeRabbit が誤提案実績あり) で機能が壊れるので external CDN ルール (4 原則) を same-origin 認証 fetch に丸ごと適用しない。→ §外部 fetch allowlist 設計 を参照。

#### RTX 動画強化 (撤去: v1.0.39、当初導入: 〜v1.0.33)
- **何だったか**: NVIDIA RTX Video Super Resolution / HDR を `<video>` 要素にトリガーする機能 (chrome:// flag を user に推奨 + content script 側で video element に必要な属性を付与)。
- **撤去理由**: (1) Chrome 内部実装変更で動作再現性が安定せず、(2) GPU / Chrome バージョンごとに有効性がばらつき、(3) extension で誘導する性質ではなく Chrome 側の機能制御に委ねるべきと判断。
- **撤去内容**: `rtx-enhancer.js` content script / `rtxEnhancerEnabled` storage key を `onInstalled` legacy 削除リストに集約。test/actions.test.js に撤去 drift 検知アサート追加。
- **教訓 1 (popup `stored` get リスト欠落で master 永久 OFF 化の致命バグ)**: 本機能の master キーが popup の `stored = chrome.storage.local.get([...])` リストに **#4 だけ漏れていて**、popup 表示が常に OFF → 別トグル変更で全 settings 上書き → storage の既存 true が破壊される事例があった。→ §APPLY_SETTINGS 経路の partial payload 防御 経路 D の 6 ポイントチェックリスト を新規 master トグル追加時に必ず通すこと。
- **教訓 2 (chrome:// flag 誘導機能は採用しない)**: 「ユーザーに `chrome://flags/#...` を開いて設定変更してもらう」前提の機能は、Chrome バージョン更新で flag id 変更・廃止が頻発するため壊れやすい。代わりに Chrome 標準 API で完結する設計を採用する。

#### MES (MediaElementSource) 経路 (撤去: 2026-06-01、当初導入: v1.0.33)
- **何だったか**: 音量ブースターを「普通サイト = MES 自動適用 / EME サイト (Netflix / Prime Video) = tabCapture」の 2 経路 + URL 分岐で実装。MES は content script 内で `audioContext.createMediaElementSource(video)` を使うため popup 不要 + バナーなし。
- **撤去理由**: (1) Amazon など買い物ページと再生ページが同居するドメインで、tabCapture のタブ共有バナーが「再生していないページ」にも出る UX 問題、(2) サイトによって挙動が変わる (= MES / tabCapture の経路が透明性なく切り替わる) ことをゆろさんが嫌った、(3) 「賢い URL 分岐より uniform 動作のほうが好み」というユーザー選好 (memory-bank `volume-booster-uniform-preference.md` 参照)。
- **撤去内容**: `volume-booster.js` content script / `EME_HOSTS` 配列 / `isEmeHost` / `isEmeUrl` 判定関数を完全削除。tabCapture 経路一本に戻した。
- **教訓 1 (「賢い分岐」より「uniform 動作」が選好されることがある)**: 機能的に上等な 2 経路設計でも、UX の透明性 (= ユーザーが挙動を予測できる) を優先する場合がある。新機能で「サイトによって挙動を変える」分岐を入れる前にユーザー選好を確認する。
- **教訓 2 (DSP コア共有モジュール構造は維持)**: `src/lib/audio-pipeline.js` は MES + tabCapture 両 caller の drift 解消が当初動機だったが、現在 caller は offscreen.js 単独。それでも Firefox MV3 が tabCapture / offscreen に catch-up したときの再利用に備えて共有モジュール構造は残している。

#### 自動音量正規化 (撤去: 2026-06-19、当初導入: v1.0.20 系)
- **何だったか**: 音量ブースターのサブ機能 (`volumeBoosterNormalizeEnabled`)。`AnalyserNode.getFloatTimeDomainData()` で短時間 RMS を測り、timer 駆動の自動 GainNode で「動画 / 配信ごとの平均音量」を目標 RMS (`NORMALIZE_TARGET_RMS_DB`) に寄せるラウドネス補正 (リアルタイム AGC)。offscreen のノードチェーン前段 (`normalizerAnalyzer → normalizerGainNode`) + `NORMALIZE_*` DSP 定数群 + audio-pipeline.js の normalizer 6 関数 (clampNormalizerGain / scheduleNormalizerGain / tickLoudnessNormalizer / startLoudnessNormalizer / stopLoudnessNormalizer / updateLoudnessNormalizer) で構成。
- **撤去理由**: ゆろさん判断「現実的でない」。EMA 平滑化 / silence gate 二重判定 / dead zone / 非対称 ramp 等を v1.0.38 / v1.0.39 / 2026-06-07 と何度もチューニングしたが、BGM の verse↔chorus・喋りの息継ぎ・シーン切替での「効き」と「ポンピング抑制」の両立が安定せず、リアルタイム AGC として実用水準に達しなかった。
- **撤去内容**: `volumeBoosterNormalizeEnabled` storage key を `onInstalled` legacy 削除リストに集約。actions.js の `VOLUME_BOOSTER_NORMALIZE_ENABLED` + `NORMALIZE_*` 10 定数、audio-pipeline.js の normalizer 6 関数 + `dbToGain` (normalizer 専用だったため)、offscreen のノードチェーン前段 + normalizer state フィールド、background / popup の normalize 配線、messages.json の volumeNormalize ラベル/説明を完全削除。test/actions.test.js に撤去 drift 検知アサート追加。音量サブトグルは自動歪み防止 / ナイトモードの 2 つ、storage key は 6 → 5、popup 直書きキーは 5 → 4 に減少。
- **教訓 1 (リアルタイム AGC は難物)**: 「動画ごとの平均音量を自動で揃える」は ReplayGain のような事前解析方式なら容易だが、リアルタイムでは測定窓・追従速度・無音判定の三つ巴チューニングが必要で、どれかを立てると別が崩れる。同種の「連続測定 → 連続補正」機能を再導入するときは、まず実用水準に届くかを小さく検証してから本実装する。
- **教訓 2 (audio-pipeline.js の構造は維持)**: normalizer 6 関数の撤去で一時 applyCompressorPreset のみになったが、後に 10 バンド EQ を追加した際に dbToGain (プリアンプの dB→倍率変換) / applyEqualizer (preamp + 10 バンド peaking gain 適用) / createEqChain (EQ チェーン構築) を再導入し、現在は **dbToGain / applyCompressorPreset / applyEqualizer / createEqChain の 4 関数構成** (Key Files 表 §audio-pipeline.js と整合)。当初の機能撤去 → 共有モジュール構造維持 → EQ 追加で再活用、という流れで「globalThis.AudioPipeline 公開定数 + Firefox catch-up 時の再利用枠を残す」判断が結果的に活きた事例。

#### 撤去パターン共通の不変条件
- **`onInstalled` で legacy storage key を必ず削除**: 廃止キーを残すと storage に dead value が永遠に残る + 将来 同名キーを再利用する場合に「OFF 化したつもりが ON で復元される」事故源。撤去時は必ず `onInstalled` の legacy 削除リストに追加。
- **`test/actions.test.js` に drift 検知アサート追加**: 撤去機能の定数・アクション・FEATURES エントリが actions.js から完全消去されていることをテストで物理確認。CI で再発防止。
- **CLAUDE.md からの参照削除は本セクション 1 箇所に集約**: 本文の他箇所 (Project Overview / Key Files / Important Patterns) は撤去機能に言及しない。教訓だけは「→ §撤去済み機能と教訓」リンクで本セクションを参照する。
