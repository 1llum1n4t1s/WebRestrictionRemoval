# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WEB閲覧アシスト (Web Viewing Assist) は Chrome 拡張機能 (Manifest V3)。Web ブラウジングを快適にする 6 機能を提供する：「セッション維持（現在のサイト単位）」「YouTube クリーナー（Shorts 削除・コメント欄非表示・ライブチャット非表示を含む 22 サブ機能）」「Amazon 定期おトク便 月別合計」「Instagram クリーナー」「音量ブースター（自動歪み防止 / 自動音量正規化 / ナイトモードの 3 サブトグル付き）」「カラーピッカー（EyeDropper API ベース）」。前 4 機能は独立オプトイントグル（**全てデフォルト OFF**）、音量ブースターのみマスタートグルなしの常時表示型（スライダー 100% かつ全サブトグル OFF でリソース解放、サブトグル 3 種もデフォルト OFF）、カラーピッカーは popup タブ内で完結。すべての機能はクライアントサイド DOM/CSS 操作と Chrome 標準 API のみによる独自実装で、外部送信ゼロ。

> **v1.0.18 までの主な変更点（適用済み）**: v1.0.x の「制限解除」（右クリック解除 / テキスト選択解除 / 強制ペースト / 強制コピー / カスタム右クリック許可リスト）を全廃。`clipboardRead` / `clipboardWrite` / `contextMenus` / `scripting` permission も削除済み。拡張機能名は「WEB制限解除サポート」→「WEB閲覧アシスト」に改名。バージョン番号確定は `/vava` スキル経由で行う。

設定は `chrome.storage.local` の各 boolean / 数値キーで保存。UI は日本語。**インストール直後は全マスタートグル OFF**（音量ブースターは 100% = 解放状態）。サイト挙動を勝手に書き換えないオプトイン方針。

## Build Commands

```bash
npm install                  # 初回 / 開発用
npm run ci:install           # CI 用 (npm ci。lockfile 厳守)
npm run build                # アイコン + スクリーンショット一括生成
npm run generate-icons       # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
npm run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer, concurrency=2)
npm test                     # Node.js 標準 test runner による純粋関数テスト
powershell -ExecutionPolicy Bypass -File zip.ps1  # ストア申請用 ZIP パッケージ生成 (Windows)
bash ./zip.sh                # 同上 (Unix)
```

リンターは未導入。Node.js 標準 test runner による純粋関数テストは `npm test` で実行できる。Chrome 拡張としての動作確認は Chrome に拡張機能を読み込んで手動テスト。

## Architecture

3 つのレイヤが `chrome.runtime` メッセージパッシングで連携する。アクション定数は `src/lib/actions.js` で集中管理。

```text
Popup (src/popup/popup.{html,js,css})
  ──APPLY_SETTINGS──▶ Background (src/background/background.js)
                        │ storage 更新 +
                        ──APPLY_KEEP_ALIVE_CS / APPLY_SEARCH_FIXER_CS / APPLY_AMAZON_DELIVERY_TOTAL_CS / APPLY_INSTAGRAM_CLEANER_CS──▶
                          各 Content Script

[音量ブースター]
  Popup ──VOLUME_BOOSTER_SET_GAIN──▶ Background
                                    │ chrome.tabCapture.getMediaStreamId
                                    ──ACTION_VOLUME_SET_GAIN──▶ Offscreen Document
                                                                  │ getUserMedia + AudioContext + GainNode
                                                                  └ 増幅して再出力
```

### Popup (`src/popup/popup.html`, `src/popup/popup.js`, `src/popup/popup.css`)
4 マスタートグル（セッション維持 / YouTube クリーナー / Amazon 合計 / Instagram クリーナー）+ 音量ブースタースライダー（マスタートグルなしの常時表示）+ クリーナー詳細アコーディオン × 2（YouTube クリーナー 22 機能 / Instagram クリーナー 10 機能）。Shorts 削除は YouTube クリーナーのサブ機能 `removeShorts`（「サイト全体」カテゴリ）として統合済み。幅 380px。トグル変更で即 `APPLY_SETTINGS` を background へ送信。設定は `chrome.storage.local` の各キーから復元（未設定時は全 false）。アクセントカラーは茜系（ライト `#C0605A` / ダーク `#df8983`）。CSP meta を明示。`<meta name="color-scheme" content="light dark">` でネイティブ要素を `prefers-color-scheme` に追従させ、CSS は `:root` のライト用トークン定義 + `@media (prefers-color-scheme: dark)` のダーク用トークン上書きの 2 層構造。色値はすべて CSS 変数経由でハードコードなし。

音量ブースターは：
- スライダー入力 → 120ms debounce → `VOLUME_BOOSTER_SET_GAIN` で background 経由で offscreen に送信
- スライダー変更（マウスアップ）→ 即 push
- 100% に戻すボタン → `pushVolumeNow(100)` → background 側で `releaseVolumeBoosterTab` 呼出
- popup 起動時に `VOLUME_BOOSTER_GET_GAIN` で active tab の現在 gain を取得して反映
- エラーは `formatVolumeError(res.error)` で人間可読な日本語メッセージに翻訳して表示

### Background (`src/background/background.js`)
Service worker。役割:
1. **設定の集約と各 content script への配布**: `APPLY_SETTINGS` を popup から受信し、storage 保存と active tab 通知を行う。YouTube タブ / Amazon `auto-deliveries` タブ判定は URL パターンで行う。非マッチタブには receiver 不在で例外になるため `try/catch` でガード。
2. **Offscreen Document ライフサイクル管理**: `ensureOffscreenDocument()` で並行作成ガード、`scheduleOffscreenClose()` で 30 秒アイドル後に自動クローズ。**音量ブースト中タブが残っている間は close を再延期**（`isVolumeBoosterActive` で確認、SW 再起動直後は安全側に倒す）。`reasons` は `["USER_MEDIA", "AUDIO_PLAYBACK"]`。
3. **音量ブースター制御**: `setVolumeBoosterGain(tabId, gain)` がエントリ。スライダーが UNITY (100%) のときは `releaseVolumeBoosterTab` を呼ぶだけで `getMediaStreamId` をスキップ（リソース節約）。既存 AudioContext がある場合も streamId なしで gain 値だけ更新。
4. **Message Handler の sender 検証**: `SenderCheck.isFromPopup` / `isFromContentScript` ヘルパーで由来を検証。`APPLY_SETTINGS` / `VOLUME_BOOSTER_*` は popup 由来のみ受け付ける。
5. **タブクローズで自動 release**: `chrome.tabs.onRemoved` で `ACTION_VOLUME_RELEASE_TAB` を offscreen に送信(permission 不要、SW 再起動でも永続的に発火する)。
6. **設定マイグレーション**: `onInstalled` で旧キー (`copyPasteSettings` / `enabled` / `volumeBoosterEnabled` / `contextMenuAllowDomains` / `ytShortsRemovalEnabled`) を削除し、各機能トグルを未設定なら false で初期化。**v1.0.18**: `ytShortsRemovalEnabled === true` だった既存ユーザーは `searchFixerFeatures.removeShorts = true` + `searchFixerEnabled = true` に転写してから旧キー削除。

`chrome://`, `edge://`, `about:`, `file://` などの非 HTTP(S) ページにはメッセージ送信をスキップ（`content_scripts.matches` が `http(s)://*/*` のみのため）。

### Keepalive (`src/content/keepalive.js`)
全 http(s) の top frame にのみ注入される汎用 content script。`keepAliveOrigins` に保存された現在サイト単位の許可リストで有効化する。役割:
1. `createKeepAlive` ファクトリで合成イベント dispatch + 同一オリジン HTTP ping ロジックを定義
2. ファイル末尾の IIFE ランナーが起動責任を持ち、`chrome.storage.local` の `keepAliveEnabled` / `keepAliveIntervalMs` を読み出して keeper を on/off
3. `chrome.runtime.onMessage` で `APPLY_KEEP_ALIVE_CS`、`chrome.storage.onChanged` で全タブ・全フレーム横断の同期を実装
4. `window.__cpaKeepAliveRunning` で同一フレーム二重実行を防ぐ

合成アクティビティは `mousemove` / `pointermove` / `scroll` / `focus` を `document` / `window` に dispatch（クリック / keydown は副作用が大きいため避ける）— **常時実行・副作用ゼロ**。**合成イベントは top frame のみで dispatch** する（`window !== window.top` で早期 return）。iframe 全部に撃ち続けると企業 DLP/SIEM が「ユーザー操作なしの mousemove 連発」をボット行動として検知するルールに引っかかりうるため、HTTP ping と同様の保守的な範囲に揃える。

HTTP ping は **`keepAliveHttpPingEnabled` storage key で別途オプトイン**（デフォルト OFF）。有効時のみ `KeepAlive.PRESET_ENDPOINTS`（SharePoint 等）の同一オリジン GET → 現在 URL に HEAD → origin root に HEAD のフォールバックを発射する。`credentials: "same-origin"` + `redirect: "manual"` で第三者ドメインへの認証情報送信を防ぎ（cross-origin 302 を opaqueredirect 応答で `ok: false` 扱い）、`AbortSignal.timeout(5000)` で永久 pending を防止。同一オリジン iframe は `shouldFireHttpPing()` で多重発射を回避。デフォルト OFF にしている理由は認証プロキシ環境（Zscaler 等）で 401/302 ループや SIEM ログアラートを誘発しうるため。

### Offscreen (`src/offscreen/offscreen.html`, `src/offscreen/offscreen.js`)
音量ブースター専用の extension-context ドキュメント。`chrome-extension://` は常に secure context のため `getUserMedia({ chromeMediaSourceId })` が動く。`audioStates` Map で tabId → `{ ctx, gainNode, stream }` を保持し、release 時に `stream.getTracks().stop()` → `ctx.close()` をこの順で呼ぶ（逆順だと生きているソースから出力先消失でエラーになり得る）。`pagehide` / `unload` で全 audioStates を cleanup。streamId は `typeof streamId !== "string"` の型チェックのみ通してから `getUserMedia` に流す（過去に `^[a-zA-Z0-9_:.\-]{8,256}$` の正規表現検証を試したが、Chrome の `getMediaStreamId` 戻り値とマッチしないケースで誤拒否が出たため撤去）。`mandatory.chromeMediaSource = "tab"` 形式を先に試して、失敗時のみ `chromeMediaSourceId` フラット形式にフォールバック。

### YouTube Shorts Removal (`src/content/youtube-shorts.js`)
`*://*.youtube.com/*` 限定の content_scripts エントリで `all_frames: false`（top frame のみ）に注入。`window.__ytShortsRemoverRunning` で二重実行防止。`window === window.top` チェックで埋め込みプレーヤーには注入せず CPU 負荷を抑える。

**v1.0.18 統合**: 独立 storage key (`ytShortsRemovalEnabled`) と独自メッセージ (`APPLY_YT_SHORTS_CS`) を廃止し、YouTube クリーナーのサブ機能 `searchFixerFeatures.removeShorts` として統合。アクティブ判定は `searchFixerEnabled === true` AND `features.removeShorts === true` の AND。`APPLY_SEARCH_FIXER_CS` メッセージを search-fixer.js と共に購読する（同一 isolated world で同じメッセージを 2 ファイルが受けて、それぞれの責務に応じて反応する設計）。

**actions.js の二重ロード回避**: youtube.com は最初のエントリ（`http(s)://*/*`）にもマッチするため、両エントリで `actions.js` を読み込むと同じ isolated world で `const Actions = ...` が再宣言され SyntaxError になる。Chrome の同一拡張・同一ページの content scripts は同一 isolated world で「script scope」を共有するため、最初のエントリで読み込んだ `Actions` / `StorageKeys` 等の定数は 2 番目以降のエントリからも参照できる。よって 2 番目以降の `js` 配列には `actions.js` を含めない。

### YouTube クリーナー (`src/content/search-fixer.js`)
`searchFixerEnabled` (master) と `searchFixerFeatures` (オブジェクト) と `searchFixerGridItems` (数値: 0/4/5/6) の 3 キーで管理（変数名は履歴的に `searchFixer*` を使用）。22 機能の単一情報源は `actions.js` の `SearchFixer.FEATURES`（v1.0.18 で `removeShorts` を「サイト全体」カテゴリに追加、続いて `hideComments` と `hideLiveChat` を「動画ページ」カテゴリに追加）。実装: top frame 限定で MutationObserver + `yt-navigate-finish` / `yt-navigate-start` イベントで onSettingsChanged を再実行（SPA navigation で CLASS_PROCESSED マーカーをリセットするため）。マスター OFF 時は observer / 注入 CSS / 装飾クラスをすべて停止。**`removeShorts` サブ機能の実装は youtube-shorts.js 側に存在**（責務分離）。

### Amazon 定期おトク便 月別合計 (`src/content/amazon-delivery-total.js`)
`*://www.amazon.co.jp/auto-deliveries*` 限定。`amazonDeliveryTotalEnabled` (boolean) で master 制御。Amazon の DOM 構造（`[data-delivery-type]` セクションと `.subscription-price` 価格表示）に基づく独自実装で、配送月ごとの合計を計算してページに挿入する。

**フリーズ対策**: 旧実装は `MutationObserver(subtree: true)` 監視中に自身が `target.append(root)` / `priceEl.textContent = ...` で DOM を書き戻すと再発火 → 再 render → 無限ループでブラウザがフリーズする問題があった。修正版は **rAF coalesce + observer disconnect / takeRecords / reconnect ガード** パターン:
1. `scheduleRender()` を `requestAnimationFrame` で 1 フレームに 1 回に圧縮
2. `runRenderInsideObserverGuard()` 内で `observer.disconnect()` → `renderAllTotals()` → `observer.takeRecords()`（蓄積分を破棄）→ `observer.observe()` で再接続
3. `priceEl.textContent` は変化時のみ更新（同じ文字列の再代入でも `MutationRecord` は積まれるため）

**動作対象**: top frame 限定、`[data-delivery-type]` セクションの `.subscription-price` を `/\D/g` で数値化して合計、各セクションの `.a-fixed-left-grid-col` に `__cpa-amzn-delivery-total` クラスのルート要素を append。OFF 時は observer 切断 + 既存挿入要素を全部撤去（撤去操作も同じ guard 経由）。

### Instagram クリーナー (`src/content/instagram-cleaner.js` + `src/content/instagram-cleaner.css`)
`*://*.instagram.com/*` 限定の content_scripts エントリで `all_frames: false`（top frame のみ）に `run_at: document_idle` で注入。`window.__cpaInstagramCleanerRunning` で二重実行防止。`instagramCleanerEnabled` (master) + `instagramCleanerFeatures` (オブジェクト) の 2 キーで管理。10 機能の単一情報源は `actions.js` の `InstagramCleaner.FEATURES`。

**run_at 注意**: 最初の content_scripts エントリ（`http(s)://*/*` で `actions.js` を含む）が `document_idle` のため、Instagram エントリも揃えないと「`InstagramCleaner is not defined`」エラーになる。Chrome は `run_at` が違うと早い方を先に評価するので、`document_start` を指定すると `actions.js` 未ロード状態で走ってしまう。CSS は manifest の `css:` 配列で別経路で document_start に近いタイミングで注入されるため、JS を idle にしても見た目への影響は小さい。

Instagram の冗長 UI（Reels / Explore / Stories / Threads / いいね数 / 動画 / コメント / Notes / メッセージカウンター）を非表示にする独自実装。クリーンアップ目的に機能を絞っており、寄付ボタン UI 注入・多言語ローカライズ・フォント変更・グレースケール / 正方形化等は実装しない。

**実装パターン**:
1. **body クラスベースの CSS 駆動**: `applyBodyClasses()` で `<html>` に `__cpa-ig-{reels,explore,stories,...}` クラスを付け外し。CSS 側は各セレクタを `html.__cpa-ig-XXX` で prefix し、クラスが付いていないときは完全に不活性化する
2. **DOM スイープ (300ms ポーリング)**: `block_videos` 機能では `<article>` 内 `<video>` を検出 → 親に `__cpa-ig-article-video` マーカーを付与 → CSS でサムネ差し替え。`vanity` 機能では `<article>` 内 `<button>` の innerText が純粋な数値表現（カンマ・小数点・k/M/万 単位等）にマッチする場合に `__cpa-ig-hide-counter` マーカーを付ける
3. **URL リダイレクト (300ms ポーリング)**: `reels` / `explore` / `storiesAll` 機能が ON のとき、対応する URL パスでホーム `/` に `location.assign("/")`。SPA の history hook より単純で確実
4. **master OFF 時の cleanup**: domSweepTimer / urlGuardTimer を停止し、付与済みマーカークラスをすべて剥がして元の Instagram UI に戻す

**CSS セレクター戦略**: Instagram の難読化 class 名（`.x9f619` 等）は build ごとに変わるため**意図的に避け**、`aria-label` / `href` / `role` / `data-pagelet` / SVG path data などの意味論的属性のみで構成する。例: Reels は `a[href="/reels/"]` + `aria-label="Reels"` + 日本語ロケール用 `aria-label="リール"` + SVG path data の 4 重に重ね、どれか 1 つでもヒットすれば隠れる構造。

### 音量ブースター (`src/offscreen/offscreen.js` の Volume Booster 部分)
Chrome の標準 API（`chrome.tabCapture.getMediaStreamId` + `getUserMedia` + AudioContext + GainNode）のみを使ったタブ音声増幅の独自実装。Equalizer や音質変更は持たず、純粋な GainNode ベースの音量増幅のみ。

**master トグル廃止**: スライダーが UNITY (100%) のときに `getMediaStreamId` を呼ばず AudioContext を release してリソース返却する設計に変更。`volumeBoosterEnabled` storage key も削除済み。これにより：
- ON/OFF を意識せず「音を上げたいときにスライダーを動かす」だけで動作
- 100% のままなら一切リソースを使わない
- chrome:// など tabCapture 不可ページで master 概念が無いので状態混乱が起きない

**処理フロー**:
1. popup でスライダー操作（実音量 0-300%、UI 上は 100% が中央）→ 120ms debounce
2. popup → background: `VOLUME_BOOSTER_SET_GAIN` メッセージ（`tabId`, `gain`）
3. background: gain が UNITY なら `releaseVolumeBoosterTab` を呼んで終了。それ以外なら `chrome.tabCapture.getMediaStreamId({ targetTabId })` で MediaStream ID 取得（ただし既存 AudioContext がある場合は streamId なしで gain だけ更新）
4. background → offscreen: `ACTION_VOLUME_SET_GAIN`（`tabId`, `streamId`, `gain`）
5. offscreen: 未登録タブなら `getUserMedia({mandatory:{chromeMediaSource:"tab", chromeMediaSourceId:streamId}})` で stream 取得 → `AudioContext` + `GainNode` 構築 → `mediaSource → gainNode → destination` の 3 ノード接続。登録済みなら GainNode の `.value` だけ更新

**ライフサイクル**:
- `chrome.tabs.onRemoved`: タブ閉じで該当 `tabId` を offscreen から release
- スライダー 100% 復帰: `releaseVolumeBoosterTab(tabId)` で release
- アイドル close 抑止: `scheduleOffscreenClose` 発火時に `ACTION_VOLUME_QUERY_ACTIVE` を送り、boost 中タブが残っていれば close をスキップ

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 設定; permissions: `activeTab`, `storage`, `offscreen`, `tabCapture` |
| `src/lib/actions.js` | `Object.freeze` された Actions / Offscreen / StorageKeys / KeepAlive / SenderCheck / YouTubeShorts / SearchFixer / AmazonDeliveryTotal / InstagramCleaner / VolumeBooster / ExtensionPaths 定数 |
| `src/background/background.js` | Service worker: sender 検証付きメッセージ転送、設定マイグレーション、offscreen document 管理、音量ブースター制御 |
| `src/content/keepalive.js` | 合成アクティビティ + 同一オリジン HTTP ping ポーラー（top + cross-origin iframe）+ 起動ランナー |
| `src/content/youtube-shorts.js` | YouTube クリーナーの `removeShorts` サブ機能（top frame のみ）: MutationObserver + URL リダイレクト |
| `src/content/youtube-shorts.css` | `__cpa-yt-shorts-hidden` クラス付与時に Shorts UI を `display: none` |
| `src/content/search-fixer.js` | YouTube クリーナー（22 機能 + グリッド列数）: master + features + gridItems で駆動 |
| `src/content/search-fixer.css` | サムネ枠装飾 / タイトル中央 / 説明文フル幅 等のクラス定義 |
| `src/content/amazon-delivery-total.js` | Amazon 定期おトク便ページ: 月別合計を rAF coalesce + observer guard 駆動で挿入 |
| `src/content/amazon-delivery-total.css` | `.__cpa-amzn-delivery-total` の Amazon 配色合計表示スタイル |
| `src/content/instagram-cleaner.js` | Instagram クリーナー: master + features で body クラス駆動、URL リダイレクト + DOM スイープ |
| `src/content/instagram-cleaner.css` | `html.__cpa-ig-*` 駆動の隠蔽 CSS（aria-label / href / role / data-pagelet / SVG path data ベースの意味論的セレクタのみ） |
| `src/popup/popup.{html,js,css}` | ポップアップ UI: 4 トグル + 音量スライダー + クリーナー詳細アコーディオン × 2（1 行 1 トグル + 説明文）、設定保存・復元、適用フィードバック、ダーク/ライト追従 |
| `src/offscreen/offscreen.{html,js}` | 音量ブースター専用 offscreen document: AudioContext + GainNode で増幅 |
| `icons/icon.svg` | ソースアイコン (512×512); PNG は `icons/icon-{16,48,128}.png` に生成 |
| `webstore/` | ストア申請用: HTML テンプレート、生成画像、`store-listing.txt` |
| `zip.ps1` / `zip.sh` | ストア申請用 ZIP パッケージ生成 (Windows / Unix) |
| `docs/privacy-policy.md` | プライバシーポリシー |

## Important Patterns

- **Message Handler の sender 検証** — background は `SenderCheck.isFromPopup()` / `isFromContentScript()` を各ハンドラ冒頭で呼ぶ。新しいメッセージアクションを追加するときは必ずどちらの由来を許可するか明示すること。
- **アクション定数は `src/lib/actions.js` を 4 経路で共有** — `importScripts("/src/lib/actions.js")` (background) + `content_scripts` (manifest.json で自動注入、**全エントリで `js` 配列の先頭に明示**) + `<script src="../lib/actions.js">` (popup.html) + `<script src="../lib/actions.js">` (offscreen.html)。ES modules ではなく従来のスクリプト形式で共通定数を共有。**actions.js は IIFE wrap + `globalThis` 公開方式** で、複数の content_scripts エントリ経由で再評価されても `__cpaActionsLoaded` ガードで安全に early return する。Chrome の「同一拡張・同一ページの content_scripts は同一 isolated world で script scope 共有」という文書化されていない実装詳細には依存しない設計（仕様変更耐性確保）。
- **二重実行防止** — `window.__cpaKeepAliveRunning` / `window.__cpaSearchFixerRunning` / `window.__amazonDeliveryTotalRunning` / `window.__ytShortsRemoverRunning` / `window.__cpaInstagramCleanerRunning` のグローバルフラグで同一フレーム内の二重実行を防ぐ。
- **iframe 多重対策** — keepalive は `shouldFireHttpPing()` でトップフレーム or クロスオリジン iframe のみ ping を発射。同一オリジン iframe はトップに任せる。
- **Offscreen Document の 1 拡張 1 文書制約** — 元々 clipboard + 音量ブースターを同居していたが、clipboard 削除に伴い USER_MEDIA + AUDIO_PLAYBACK のみに整理。
- **音量ブースターのアイドル close 抑止** — `isVolumeBoosterActive` で boost 中タブを query。SW 再起動直後など通信失敗時は安全側（active 扱い）に倒し、ブースト中の音を急に切らない。
- **タブクローズで自動 release** — `chrome.tabs.onRemoved` は permission 不要 + SW 再起動でも永続的に発火する API のため、AudioContext の取り残しを防げる。
- **Amazon フリーズ対策** — MutationObserver は subtree: true で監視中に自身が DOM 書き戻すと再帰発火するため、`disconnect → render → takeRecords → observe` の guard と `requestAnimationFrame` coalesce の二重防御を必ず適用する。新しい DOM 書き込みロジックを追加するときも同じパターンを踏襲すること。
- **content_scripts の actions.js ロード方針** — `actions.js` は **全エントリの `js` 配列の先頭に明示的に追加** する（v1.0.23 以降）。actions.js 本体は IIFE wrap + `__cpaActionsLoaded` ガードで再評価耐性を持つため、複数エントリ経由でロードされても 2 回目以降は early return する。**`run_at` も最初のエントリと揃える（`document_idle`）**。これにより Chrome の「同一 isolated world で script scope 共有」という文書化されていない実装詳細への依存をゼロにし、Chrome 仕様変更時の `InstagramCleaner is not defined` 等の silent failure リスクを回避できる。
- **設定マイグレーション** — `onInstalled` で旧キー (`copyPasteSettings` / `enabled` / `volumeBoosterEnabled` / `contextMenuAllowDomains` / `ytShortsRemovalEnabled`) を削除し、各 storage key を未設定なら false で初期化（オプトイン方針）。`ytShortsRemovalEnabled === true` のユーザーは v1.0.18 で `searchFixerFeatures.removeShorts = true` + `searchFixerEnabled = true` に転写してから旧キー削除。
- **デフォルト OFF 方針徹底** — 4 マスタートグル（セッション維持 / YouTube クリーナー / Amazon 合計 / Instagram クリーナー）が `onInstalled` で false 初期化、復元は `=== true` で防御的に判定。音量ブースターはマスタートグルなしだが、スライダー 100% でリソース解放されるため「インストール直後はサイトに何も影響しない」を維持できる。

---

# CLAUDE.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WEB閲覧アシスト (Web Viewing Assist) は Chrome 拡張機能 (Manifest V3)。Web ブラウジングを快適にする 6 機能を提供する：「セッション維持（現在のサイト単位）」「YouTube クリーナー（Shorts 削除・コメント欄非表示・ライブチャット非表示を含む 22 サブ機能）」「Amazon 定期おトク便 月別合計」「Instagram クリーナー」「音量ブースター（自動歪み防止 / 自動音量正規化 / ナイトモード サブトグル付き）」「カラーピッカー（EyeDropper API ベース・popup 内完結）」。前 4 機能は独立オプトイントグル（**全てデフォルト OFF**）、音量ブースターのみマスタートグルなしの常時表示型（スライダー 100% でリソース解放、サブトグル 3 種もデフォルト OFF）、カラーピッカーは popup タブとして常時利用可（履歴は最大 20 件、`chrome.storage.local` 内のみで外部送信ゼロ）。すべての機能はクライアントサイド DOM/CSS 操作と Chrome 標準 API のみによる独自実装で、外部送信ゼロ。

設定は `chrome.storage.local` の各 boolean / 数値キーで保存。UI は日本語。**インストール直後は全マスタートグル OFF**（音量ブースターも 100% かつ全サブトグル OFF = 完全に無処理）。サイト挙動を勝手に書き換えないオプトイン方針。バージョン番号は `/vava` スキル経由でのみ更新する。

## Build Commands

```bash
npm install                  # 初回 / 開発用
npm run ci:install           # CI 用 (npm ci。lockfile 厳守)
npm run build                # アイコン + スクリーンショット一括生成
npm run generate-icons       # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
npm run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer, concurrency=2)
npm test                     # Node.js 標準 test runner による純粋関数テスト
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
  && node --check src/content/youtube-shorts.js \
  && node --check src/content/search-fixer.js \
  && node --check src/content/keepalive.js \
  && node --check src/content/amazon-delivery-total.js \
  && node --check src/content/instagram-cleaner.js \
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
4 マスタートグル（セッション維持 / YouTube クリーナー / Amazon 合計 / Instagram クリーナー）+ 音量ブースタースライダー（マスタートグルなしの常時表示）+ 音量サブトグル × 3（自動歪み防止 / 自動音量正規化 / ナイトモード）+ クリーナー詳細アコーディオン × 2（YouTube クリーナー 22 機能 / Instagram クリーナー 10 機能）。Shorts 削除・コメント欄非表示は YouTube クリーナーのサブ機能（`removeShorts` / `hideComments`）として統合。幅 380px。トグル変更で即 `APPLY_SETTINGS` を background へ送信、設定は `chrome.storage.local` から復元（未設定時 false）。

**クリーナーアコーディオン**: サブ機能行は **1 行 1 トグル + 説明文** の縦積みレイアウト。各機能の `desc` は `actions.js` の `SearchFixer.FEATURES` / `InstagramCleaner.FEATURES` を単一情報源として popup.js が動的にレンダリングする（FEATURES に追加するだけで UI 自動生成）。

**テーマ**: アクセントカラーは茜系（ライト `#C0605A` / ダーク `#df8983`）。`<meta name="color-scheme" content="light dark">` でネイティブ要素を `prefers-color-scheme` に追従させ、CSS は `:root` のライト用トークン + `@media (prefers-color-scheme: dark)` のダーク上書きの 2 層構造。色値はすべて CSS 変数経由でハードコードなし。CSP meta 明示。

**音量スライダー / サブトグル**: input 時 120ms debounce → `VOLUME_BOOSTER_SET_GAIN`（`gain`, `antiClip`, `normalize`, `nightMode`）。change（マウスアップ）で即 push、100% に戻すボタンは `pushVolumeNow(100)` で release 経路へ。popup 起動時は `VOLUME_BOOSTER_GET_GAIN` で active tab の現在 gain を取得して反映。スライダー UI は 0..200 の内部値を使い、左端 0% / 中央 100% / 右端 300% の実音量へ変換する。サブトグル (`volumeBoosterAntiClipEnabled` / `volumeBoosterNormalizeEnabled` / `volumeBoosterNightModeEnabled`) は change で `cancelVolumePush` → storage.set fire-and-forget → `pushVolumeNow(currentGain)` の順で即時反映（既存 AudioContext があれば自動ゲイン / compressor 状態だけ切り替わり音切れなし）。エラーは `formatVolumeError(res.error)` で日本語に翻訳。

### Background (`src/background/background.js`)
Service worker。役割:
1. **設定の集約と各 content script への配布**: `APPLY_SETTINGS` を popup から受信し、storage 保存と active tab 通知を行う。YouTube タブ / Amazon `auto-deliveries` タブ判定は URL パターンで行う。非マッチタブには receiver 不在で例外になるため `try/catch` でガード。
2. **Offscreen Document ライフサイクル管理**: `ensureOffscreenDocument()` で並行作成ガード、`scheduleOffscreenClose()` で 30 秒アイドル後に自動クローズ。**音量ブースト中タブが残っている間は close を再延期**（`isVolumeBoosterActive` で確認、SW 再起動直後は安全側に倒す）。`reasons` は `["USER_MEDIA", "AUDIO_PLAYBACK"]`。
3. **音量ブースター制御**: `setVolumeBoosterGain(tabId, gain, antiClip, normalize, nightMode)` がエントリ。UNITY release 条件・既存 AudioContext 経路・自動ゲイン / compressor preset の詳細は Important Patterns 参照。
4. **Message Handler の sender 検証**: `SenderCheck.isFromPopup` / `isFromContentScript` ヘルパーで由来を検証。`APPLY_SETTINGS` / `VOLUME_BOOSTER_*` は popup 由来のみ受け付ける。
5. **タブクローズで自動 release**: `chrome.tabs.onRemoved` で `ACTION_VOLUME_RELEASE_TAB` を offscreen に送信（permission 不要、SW 再起動でも永続的に発火する）。
6. **設定マイグレーション**: `onInstalled` で旧キー削除 + 未設定キーの初期化（詳細は Important Patterns の「マイグレーション」を参照）。

`chrome://`, `edge://`, `about:`, `file://` などの非 HTTP(S) ページにはメッセージ送信をスキップ（`content_scripts.matches` が `http(s)://*/*` のみのため）。

### Keepalive (`src/content/keepalive.js`)
全 http(s) フレームに `all_frames: true` で注入される唯一の汎用 content script。役割:
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

**YouTube クリーナーへの統合**: 独立 storage key と独自メッセージは持たず、YouTube クリーナーのサブ機能 `searchFixerFeatures.removeShorts` として動作。アクティブ判定は `searchFixerEnabled === true` AND `features.removeShorts === true` の AND。`APPLY_SEARCH_FIXER_CS` メッセージを search-fixer.js と共に購読する（同一 isolated world で同じメッセージを 2 ファイルが受けて、それぞれの責務に応じて反応する設計）。`storage.onChanged` は片方の key だけ変わった場合に備え、両 key を再取得してから `computeActive()` で判定する（変更されてないキーが undefined になる罠を回避）。

### YouTube クリーナー (`src/content/search-fixer.js`)
`searchFixerEnabled` (master) と `searchFixerFeatures` (オブジェクト) と `searchFixerGridItems` (数値: 0/4/5/6) の 3 キーで管理（変数名は履歴的に `searchFixer*` を使用）。22 機能の単一情報源は `actions.js` の `SearchFixer.FEATURES`（v1.0.18 で `removeShorts` を「サイト全体」カテゴリに追加 19 → 20、続いて `hideComments` を「動画ページ」カテゴリに追加 20 → 21、その後 `hideLiveChat` を「動画ページ」カテゴリに追加 21 → 22）。実装: top frame 限定で MutationObserver + `yt-navigate-finish` / `yt-navigate-start` イベントで onSettingsChanged を再実行（SPA navigation で CLASS_PROCESSED マーカーをリセットするため）。マスター OFF 時は observer / 注入 CSS / 装飾クラスをすべて停止。**`removeShorts` サブ機能の実装は search-fixer.js ではなく youtube-shorts.js が担当**（責務分離: SPA URL リダイレクト + サイト横断 DOM 削除は検索ページ限定の clean-up とは別レイヤ）。

**`hideComments` 実装上の注意**: `applyWatchPageClasses()` は `<html>` に `__cpa-sfx-hide-comments` クラスを付け外しする実装で、**`isWatchPage()` 判定を経由せず無条件に呼ぶ**こと。watch page 限定にすると SPA で video → home に遷移したとき `<html>` クラスが残置されて他ページに副作用が出る（CodeRabbit レビューで実際に指摘された罠）。CSS 側は `html.__cpa-sfx-hide-comments ytd-comments#comments { display: none !important; }` で watch page 以外には影響しないため、JS は無条件 toggle で良い。

### Amazon 定期おトク便 月別合計 (`src/content/amazon-delivery-total.js`)
`*://www.amazon.co.jp/auto-deliveries*` 限定。`amazonDeliveryTotalEnabled` (boolean) で master 制御。Amazon の DOM 構造（`[data-delivery-type]` セクションと `.subscription-price` 価格表示）に基づく独自実装で、配送月ごとの合計を計算してページに挿入する。

**フリーズ対策**: 旧実装は `MutationObserver(subtree: true)` 監視中に自身が `target.append(root)` / `priceEl.textContent = ...` で DOM を書き戻すと再発火 → 再 render → 無限ループでブラウザがフリーズする問題があった。修正版は **rAF coalesce + observer disconnect / takeRecords / reconnect ガード** パターン:
1. `scheduleRender()` を `requestAnimationFrame` で 1 フレームに 1 回に圧縮
2. `runRenderInsideObserverGuard()` 内で `observer.disconnect()` → `renderAllTotals()` → `observer.takeRecords()`（蓄積分を破棄）→ `observer.observe()` で再接続
3. `priceEl.textContent` は変化時のみ更新（同じ文字列の再代入でも `MutationRecord` は積まれるため）

**動作対象**: top frame 限定、`[data-delivery-type]` セクションの `.subscription-price` を `/\D/g` で数値化して合計、各セクションの `.a-fixed-left-grid-col` に `__cpa-amzn-delivery-total` クラスのルート要素を append。OFF 時は observer 切断 + 既存挿入要素を全部撤去（撤去操作も同じ guard 経由）。

### Instagram クリーナー (`src/content/instagram-cleaner.js` + `src/content/instagram-cleaner.css`)
`*://*.instagram.com/*` 限定の content_scripts エントリで `all_frames: false`（top frame のみ）に `run_at: document_idle` で注入。`window.__cpaInstagramCleanerRunning` で二重実行防止。`instagramCleanerEnabled` (master) + `instagramCleanerFeatures` (オブジェクト) の 2 キーで管理。10 機能の単一情報源は `actions.js` の `InstagramCleaner.FEATURES`。

**run_at 注意**: 最初の content_scripts エントリ（`http(s)://*/*` で `actions.js` を含む）が `document_idle` のため、Instagram エントリも揃えないと「`InstagramCleaner is not defined`」エラーになる。Chrome は `run_at` が違うと早い方を先に評価するので、`document_start` を指定すると `actions.js` 未ロード状態で走ってしまう。CSS は manifest の `css:` 配列で別経路で document_start に近いタイミングで注入されるため、JS を idle にしても見た目への影響は小さい。

Instagram の冗長 UI（Reels / Explore / Stories / Threads / いいね数 / 動画 / コメント / Notes / メッセージカウンター）を非表示にする独自実装。クリーンアップ目的に機能を絞っており、寄付ボタン UI 注入・多言語ローカライズ・フォント変更・グレースケール / 正方形化等は実装しない。

**実装パターン**:
1. **body クラスベースの CSS 駆動**: `applyBodyClasses()` で `<html>` に `__cpa-ig-{reels,explore,stories,...}` クラスを付け外し。CSS 側は各セレクタを `html.__cpa-ig-XXX` で prefix し、クラスが付いていないときは完全に不活性化する
2. **DOM スイープ (300ms ポーリング)**: `block_videos` 機能では `<article>` 内 `<video>` を検出 → 親に `__cpa-ig-article-video` マーカーを付与 → CSS でサムネ差し替え。`vanity` 機能では `<article>` 内 `<button>` の innerText が純粋な数値表現（カンマ・小数点・k/M/万 単位等）にマッチする場合に `__cpa-ig-hide-counter` マーカーを付ける
3. **URL リダイレクト (300ms ポーリング)**: `reels` / `explore` / `storiesAll` 機能が ON のとき、対応する URL パスでホーム `/` に `location.assign("/")`。SPA の history hook より単純で確実
4. **master OFF 時の cleanup**: domSweepTimer / urlGuardTimer を停止し、付与済みマーカークラスをすべて剥がして元の Instagram UI に戻す

**CSS セレクター戦略**: Instagram の難読化 class 名（`.x9f619` 等）は build ごとに変わるため**意図的に避け**、`aria-label` / `href` / `role` / `data-pagelet` / SVG path data などの意味論的属性のみで構成する。例: Reels は `a[href="/reels/"]` + `aria-label="Reels"` + 日本語ロケール用 `aria-label="リール"` + SVG path data の 4 重に重ね、どれか 1 つでもヒットすれば隠れる構造。

### 音量ブースター (`src/offscreen/offscreen.js` の Volume Booster 部分)
Chrome の標準 API（`chrome.tabCapture.getMediaStreamId` + `getUserMedia` + AudioContext + AnalyserNode + GainNode + DynamicsCompressorNode × 2）のみを使ったタブ音声補正 + 増幅の独自実装。Equalizer や音質変更は持たず、自動音量正規化は短時間RMS測定 + 自動 GainNode、ナイトモード / 自動歪み防止は DynamicsCompressorNode で実装する。`volumeBoosterAntiClipEnabled` / `volumeBoosterNormalizeEnabled` / `volumeBoosterNightModeEnabled` storage key で個別管理。マスタートグルレス設計で `volumeBoosterEnabled` storage key も持たない。

**処理フロー**:
1. popup でスライダー / サブトグル操作 → 120ms debounce → `VOLUME_BOOSTER_SET_GAIN`（`tabId`, `gain`, `antiClip`, `normalize`, `nightMode`）
2. background: gain が UNITY かつ全サブトグル OFF なら `releaseVolumeBoosterTab` で AudioContext 解放して終了。それ以外は `chrome.tabCapture.getMediaStreamId({ targetTabId })` で MediaStream ID 取得（既存 AudioContext があれば streamId なしで gain / 自動ゲイン / preset だけ更新）
3. background → offscreen: `ACTION_VOLUME_SET_GAIN`（`tabId`, `streamId`, `gain`, `antiClip`, `normalize`, `nightMode`）
4. offscreen: 未登録タブなら `getUserMedia` → `source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination` の 6 ノード接続。登録済みなら GainNode を `setTargetAtTime` で 45ms ramp、正規化 timer の開始/停止、各 DynamicsCompressor のパラメータ切替

ノード順序・対数マッピング・gain ramp・compressor preset・UNITY release 条件などの**設計上の不変条件は Important Patterns「音量ブースター・Offscreen Document」に集約**。数値の単一情報源は [`src/lib/actions.js`](src/lib/actions.js) の `VolumeBooster` 定数 — ドキュメントとコードに齟齬が出たら必ずコードを正とすること。

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 設定; permissions: `activeTab`, `storage`, `offscreen`, `tabCapture` |
| `src/lib/actions.js` | `Object.freeze` された Actions / Offscreen / StorageKeys / KeepAlive / SenderCheck / YouTubeShorts / SearchFixer / AmazonDeliveryTotal / InstagramCleaner / VolumeBooster / ExtensionPaths 定数 |
| `src/background/background.js` | Service worker: sender 検証付きメッセージ転送、設定マイグレーション、offscreen document 管理、音量ブースター制御 |
| `src/content/keepalive.js` | 合成アクティビティ + 同一オリジン HTTP ping ポーラー（top + cross-origin iframe）+ 起動ランナー |
| `src/content/youtube-shorts.{js,css}` | YouTube クリーナーの `removeShorts` サブ機能（top frame のみ）: MutationObserver + URL リダイレクト + `__cpa-yt-shorts-hidden` で `display: none` |
| `src/content/search-fixer.{js,css}` | YouTube クリーナー（22 機能 + グリッド列数）: master + features + gridItems で駆動 + サムネ枠装飾等 |
| `src/content/amazon-delivery-total.{js,css}` | Amazon 定期おトク便ページ: 月別合計を rAF coalesce + observer guard 駆動で挿入 + `__cpa-amzn-delivery-total` 配色 |
| `src/content/instagram-cleaner.{js,css}` | Instagram クリーナー: master + features で body クラス駆動、URL リダイレクト + DOM スイープ + 意味論的セレクタのみ（aria-label / href / role / data-pagelet / SVG path data） |
| `src/popup/popup.{html,js,css}` | ポップアップ UI: アシスト / カラーピッカーの 2 タブ構成。アシストタブは 4 トグル + 音量スライダー + 音量サブトグル × 3 + クリーナー詳細アコーディオン × 2（1 行 1 トグル + 説明文）、カラーピッカータブは EyeDropper 採取 + HEX/RGB/HSL 表示 + format chips + 履歴グリッド。設定保存・復元、適用フィードバック、ダーク/ライト追従、IBM Plex Sans JP サブセット同梱 |
| `src/offscreen/offscreen.{html,js}` | 音量ブースター専用 offscreen document: AudioContext + AnalyserNode + 自動 GainNode + 手動 GainNode + DynamicsCompressor × 2 (night mode / anti-clip) で正規化 + 増幅 + 圧縮 |
| `icons/icon.svg` | ソースアイコン (512×512); PNG は `icons/icon-{16,48,128}.png` に生成 |
| `webstore/` | ストア申請用: HTML テンプレート、生成画像、`store-listing.txt`。`generate-screenshots.js` が popup.html から `popup-render.html` + `popup-shim.js` を動的生成 → `01-popup-ui.html` が iframe で実 popup を埋め込んで撮影（drift ゼロ）。生成物 `popup-render.html` / `popup-shim.js` は .gitignore 対象 |
| `zip.ps1` / `zip.sh` | ストア申請用 ZIP パッケージ生成 (Windows / Unix) |
| `docs/privacy-policy.md` | プライバシーポリシー |

## Important Patterns

新機能追加・既存機能の改修で踏むべき原則と、過去にハマった罠の対策。詳細はファイル冒頭コメントと該当セクションを参照。

### 設計の起点
- **`src/lib/actions.js` は単一情報源** — 新機能追加は actions.js から手をつける。Actions / StorageKeys / 機能 FEATURES 配列がここに集約され、popup の動的レンダリング → background の dispatch → content script の購読が全てここの定数を参照する。FEATURES に追加すれば popup UI は自動生成される。actions.js は古典的グローバル定数方式（ES modules ではない）で 4 経路で共有: ① background の `importScripts()`、② manifest content_scripts の最初のエントリで全 http(s) フレームに自動注入、③ popup.html の `<script>` タグ、④ offscreen.html の `<script>` タグ。
- **バージョン番号は手動で書き換えない** — `manifest.json` / `package.json` / `package-lock.json` の `version` フィールドおよびドキュメント中の `v1.x.y` 表記は `/vava` スキル経由でのみ更新する。コード変更コミットでバージョン番号には触れない。
- **デフォルト OFF 方針徹底** — 4 マスタートグル（セッション維持 / YouTube クリーナー / Amazon 合計 / Instagram クリーナー）が `onInstalled` で false 初期化、復元は `=== true` で防御的に判定。音量ブースターはマスタートグルなしだが「スライダー 100% かつ全サブトグル OFF」のときリソース解放される（サブトグル 2 種もデフォルト OFF なのでインストール直後は完全に無処理）。

### メッセージング・content script
- **sender 検証必須** — background の各ハンドラ冒頭で `SenderCheck.isFromPopup()` / `isFromContentScript()` を呼ぶ。新メッセージ追加時はどちらの由来を許可するか明示。
- **content_scripts の二重ロード回避** — `actions.js` は最初のエントリ（`http(s)://*/*`）でのみロード。2 番目以降の YouTube / Amazon / Instagram エントリは `js` 配列に含めない（同一 isolated world で script scope 共有）。**`run_at` も最初のエントリと揃える（`document_idle`）**。先行ロード前に走ると `InstagramCleaner is not defined` 等で即死する。
- **二重実行防止** — `window.__cpaKeepAliveRunning` / `window.__cpaSearchFixerRunning` / `window.__amazonDeliveryTotalRunning` / `window.__ytShortsRemoverRunning` / `window.__cpaInstagramCleanerRunning` のグローバルフラグで同一フレーム内の二重実行を防ぐ。新 content script を足すときも同じ命名で揃える。
- **iframe 多重対策** — keepalive は `shouldFireHttpPing()` でトップフレーム or クロスオリジン iframe のみ ping を発射。同一オリジン iframe はトップに任せる。

### MutationObserver 取り扱い
- **DOM 書き戻しは observer guard 必須** — `subtree: true` 監視中に自身が DOM を書き戻すと再帰発火 → 無限ループでフリーズ。Amazon 月別合計の修正で確立した **`disconnect → render → takeRecords → observe` ガード + `requestAnimationFrame` coalesce** の二重防御を新規 DOM 書き込みロジックでも踏襲する。

### 音量ブースター・Offscreen Document

**オーディオ路の不変条件**:
- **ノード順序は `source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination` に固定** — 正規化は入力直後の短時間RMSを測って自動 GainNode で平均音量を整え、ナイトモードでダイナミックレンジを狭め、手動 gain の後段に limiter を置く。gain を先頭に置く配置は禁止（v1.0.20 まで誤実装で「正規化 ON で boost が効かない」問題があった）。
- **gain は対数マッピング + `setTargetAtTime` ramp** — UI スライダーは内部値 0..200、実音量は左端 0% / 中央 100% / 右端 300%。100..300 区間の実 gain は `VolumeBooster.percentToGain()` で対数変換し、等距離 = 等 dB ステップにする。`gainNode.gain` への直接 `.value =` 代入はサンプル境界の不連続でクリック発生 → 必ず `cancelScheduledValues` → `setValueAtTime(現在値, now)` → `setTargetAtTime(target, now, RAMP_TIME_CONSTANT)` の三点セットで ramp 経由（`RAMP_TIME_CONSTANT = 0.015` で 3τ ≈ 45ms 95% 到達、popup の 120ms debounce より十分短い）。
- **自動音量正規化は compressor ではなく timer 駆動の自動 GainNode** — `AnalyserNode.getFloatTimeDomainData()` で短時間RMSを測り、`NORMALIZE_TARGET_RMS_DB` に近づくよう `normalizerGainNode.gain` をゆっくり更新する。`NORMALIZE_SILENCE_GATE_DB` 未満は無音/ノイズ扱いで 1.0x に戻し、ノイズだけを持ち上げない。
- **DynamicsCompressor は disconnect ではなく BYPASS preset で OFF** — ナイトモード / 自動歪み防止のサブトグル OFF 時にノードを disconnect/reconnect すると AudioContext のグラフが切れて一瞬無音になりプチノイズが乗る。`COMPRESSOR_BYPASS`（`ratio:1`、threshold/knee 中立）を `applyCompressorPreset` で当てれば素通り化が無音ゼロで実現（切替頻度が低くアタックが速い 1〜50ms ため `setTargetAtTime` 不要、`.value =` 直接代入で十分）。
- **volumeGetGain は `state.lastSetPercent` を返す** — `gain.value` はランプ中で目標値と一致しないため、ユーザーが最後に指定した整数 percent を保持して round-trip 誤差ゼロを担保。`gainToPercent(gain.value)` 経由だと使えない。

**ライフサイクルの不変条件**:
- **UNITY release 条件は「100% かつ全サブトグル OFF」** — `setVolumeBoosterGain` で UNITY 早期 return するのは `clamped === UNITY && !antiClipFlag && !normalizeFlag && !nightModeFlag` のときだけ。100% でもサブトグル ON なら AudioContext 維持で自動ゲイン / compressor を効かせる。「音量は変えずに正規化だけ」「突発音だけ抑える」「ナイトモードだけ使う」ユースケースを維持する。
- **アイドル close 抑止** — `isVolumeBoosterActive` で boost 中タブを query。先頭で `offscreenState === "CLOSED"` を見て早期 false return すること（query 不要 + receiver 不在経路の誤判定回避）。SW 再起動直後など sendMessage が一時失敗した場合のみ安全側（active 扱い）に倒す。
- **タブクローズで自動 release** — `chrome.tabs.onRemoved` は permission 不要 + SW 再起動でも永続発火するため、AudioContext の取り残しを防げる。

**API / 制約**:
- **Offscreen Document の 1 拡張 1 文書制約** — `reasons` は `["USER_MEDIA", "AUDIO_PLAYBACK"]`。新しい用途を追加するときは既存ドキュメントに同居させること。
- **`minimum_chrome_version: "140"` 固定** — `chrome.runtime.getContexts`（116+）等の new API は **typeof チェックなしで直接呼んで良い**。legacy fallback の `if (typeof chrome.runtime.getContexts !== "function")` 分岐はバグ温床（receiver 不在エラーを active 扱いして 30 秒 cycle 無限再 schedule した Codex P2 指摘あり）なので追加しないこと。

### マイグレーション
- **`onInstalled` で旧キー削除 + 値転写** — 廃止 storage key（過去例: `copyPasteSettings` / `enabled` / `volumeBoosterEnabled` / `contextMenuAllowDomains` / `ytShortsRemovalEnabled`）は `chrome.storage.local.remove` で取り除く。値の意味が新キーに引き継がれるなら、削除前に転写する（v1.0.18 で `ytShortsRemovalEnabled === true` → `searchFixerFeatures.removeShorts = true` + `searchFixerEnabled = true` を実施）。**動作継続を最優先**で設計する。
- **新規 storage key は `onInstalled` で必ず初期化** — `volumeBoosterAntiClipEnabled` / `volumeBoosterNormalizeEnabled` / `volumeBoosterNightModeEnabled` / `searchFixerFeatures.hideComments` のような後追いキーは未設定時 `undefined` で UI 側に出るとトグルが表示されない・無効状態になるため、必ず `onInstalled` で `false` 初期化する。`normalizeSettings()` 側でも `=== true` 防御的判定を入れる（`!!value` だと storage の落ちた object 値で誤判定が出るため）。

