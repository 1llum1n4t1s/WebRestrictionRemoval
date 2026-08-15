# WebRestrictionRemoval アーキテクチャ詳細

このファイルは `AGENTS.md` から Architecture の詳細を分離したもの。毎ターンは要らないが、該当機能を触る前には必ず該当節を読む。

---

## Architecture

3 つのレイヤが `chrome.runtime` メッセージパッシングで連携する。アクション定数は `src/lib/actions.js` で集中管理。

```text
Popup (src/popup/popup.{html,js,css})
  ──APPLY_SETTINGS──▶ Background (src/background/background.js)
                        │ storage 更新 +
                        ──APPLY_SEARCH_FIXER_CS / APPLY_AMAZON_DELIVERY_TOTAL_CS
                          / APPLY_INSTAGRAM_CLEANER_CS / APPLY_TIKTOK_CLEANER_CS / APPLY_VIDEO_GAMMA_CS
                          / APPLY_LOUPE_CS / APPLY_IMAGE_DOWNLOADER_CS──▶ 各 Content Script

[音量ブースター tabCapture 経路 (全サイト一律・Chrome の唯一の経路。Netflix / Prime Video 等 EME 動画も含む)]
  Popup ──VOLUME_BOOSTER_SET_GAIN (gain, antiClip, nightMode, bassCut, muted, eqEnabled, eqGains, eqPreamp)──▶ Background
                                    │ URL 分岐なし。active tab に対して常に呼ぶ
                                    │ chrome.tabCapture.getMediaStreamId (user gesture = popup open)
                                    ──ACTION_VOLUME_SET_GAIN──▶ Offscreen Document
                                                                  │ getUserMedia + AudioContext
                                                                  │ source → preampNode → eqFilters[0..9] → nightModeNode → gainNode → bassCutNodes[0..1] → antiClipNode → destination
                                                                  └ EME 動画でも decrypted output を捕獲して増幅
  ※ popup は (gain, antiClip, nightMode, bassCut, muted, eqEnabled, eqGains, eqPreamp, eqPreset) を chrome.storage.local にも書くが、
    これは boost トリガーではなく永続化のみ (popup 復元 + autoApplyVolumeBooster がタブ切替時に参照)。
  ※ ブースト中のタブには Chrome の「このタブのコンテンツは共有されています」バナーが出る (tabCapture 仕様、抑止不可)。

[音量ブースター MES 経路 (Firefox 専用パイプライン。manifest.firefox.json のみに登録、Chrome には一切ロードされない)]
  Popup ──音量関連キーを chrome.storage.local 直書き (メッセージ送信なし)──▶ 全タブの volume-booster-mes.js
                                    │ storage.onChanged 購読が唯一のトリガー (user gesture 不要・popup 不要で自動適用)
                                    │ <video>/<audio> ごとに MediaElementSource + 18 処理ノード
                                    │ (dryGain + offscreen と同じ 16 DSP ノード + wetGain)
                                    └ EME (DRM) サイトは EME_HOSTS で起動 skip + mediaKeys / encrypted 事前検出で attach 回避、
                                      classifyMesSource (safe/probe/pending/unsafe) + same-origin redirect probe で無音化を予防
  ※ タブ共有バナーなし。DRM サイト (Netflix / Prime Video 等) では音量ブースター無効 (音は普通に出る)。
  ※ background は Firefox の音量ブースターに一切関与しない (HAS_VOLUME_BOOSTER guard で全 skip)。
  ※ Firefox では一度 attach した要素は ctx.close() でも直接出力に復帰しないため、OFF は bypass 維持。
     拡張リロード後の旧 graph も 20 秒 lease 失効で dry bypass へ戻る (詳細は Important Patterns)。

[ルーペ]
  Content Script ──LOUPE_REQUEST_CAPTURE──▶ Background
                                              │ chrome.tabs.captureVisibleTab(windowId, {jpeg, quality:70})
                                              └ JPEG DataURL を sendResponse で返却 → content script が Blob URL 化して lens に貼付
```

### Popup (`src/popup/popup.html`, `src/popup/popup.js`, `src/popup/popup.css`)
6 タブ構成（調整 / YouTube / X / Instagram / TikTok / カラーピッカー）。**10 マスタートグル**（YouTube 機能拡張 / Amazon 合計 / Amazon ランキング / Amazon バッジ / Instagram クリーナー / TikTok クリーナー / 動画ガンマ補正 / 動画黒帯除去 / ルーペ / 音量ブースター）+ 音量ブースタースライダー（左端にミュート 🔊/🔇 ボタン）+ 音量サブトグル × 3（自動歪み防止 / ナイトモード / 壁ドン対策モード）+ **イコライザパネル（オン/オフ トグル + プリセット dropdown + プリアンプ縦スライダー + 10 バンド縦スライダー）** + 動画ガンマスライダー（中央 1.0 = 補正なし、左 3.0 で暗く、右 0.3 で明るく）+ ルーペ倍率セグメント（1.5× / 2.5× / 4×）+ ルーペサイズスライダー（150〜1000px）+ 各クリーナー専用パネル × 3（YouTube 機能拡張 34 機能 / Instagram クリーナー 11 機能 / TikTok クリーナー 3 機能）。Shorts 削除・コメント欄非表示・接続モニター・配信時刻オーバーレイは YouTube 機能拡張のサブ機能（`removeShortsShelf` 等 / `hideComments` / `connectionMonitor` / `broadcastClock`）として統合され、専用パネルのアコーディオン（接続モニター・配信時刻オーバーレイは `watch_page` カテゴリ）に FEATURES 駆動で自動描画される。幅 460px。トグル変更で即 `APPLY_SETTINGS` を background へ送信、設定は `chrome.storage.local` から復元（未設定時 false）。音量ブースターのマスタートグル OFF 時はスライダー・サブトグル・ミュートボタンを `.volume-disabled` で dim 化。ルーペ ON 時のみ倍率セグメント + サイズスライダーが表示される（`.sub-block.hidden` トグル）。

**クリーナーアコーディオン**: サブ機能行は **1 行 1 トグル + 説明文** の縦積みレイアウト。各機能の `desc` は `actions.js` の `SearchFixer.FEATURES` / `InstagramCleaner.FEATURES` を単一情報源として popup.js が動的にレンダリングする（FEATURES に追加するだけで UI 自動生成）。

**テーマ**: 「生成り × 葡萄酒」。高級感をテーマにした立体表現（フラットではない）。**ライトは生成りの地に葡萄酒の差し色、ダークは葡萄酒そのものを地にして差し色を金へ入れ替える**（`--accent` はライトで `#7c2334`、ダークで `#c79a4a`。役割が入れ替わるので、差し色の上に載せる文字は必ず `--on-accent` を使う）。色数は地 / 文字 / 罫 / 差し色の 4 つに絞り、金は `--gold-line`（4 停止グラデ）の細線としてヘッダー周りにだけ使う。立体は光源を上 1 方向に固定した `--bevel-top` / `--bevel-bottom` / `--raise` / `--sink` / `--engrave` の 5 トークンで作り、**個別に box-shadow を書き足さない**（光源の向きが揃わなくなる）。大きなドロップシャドウは popup 外周のみ。角丸は 3px まで。**ダークは地に色があるため、カラーピッカーの色見本 (`.specimen-swatch`) と履歴グリッド (`.history-grid`) の下にだけ `--neutral-plate` の無彩色の台を敷き、拾った色が地の赤に引っ張られないようにする**。`<meta name="color-scheme" content="light dark">` でネイティブ要素を `prefers-color-scheme` に追従させ、CSS は `:root` のライト用トークン + `@media (prefers-color-scheme: dark)` のダーク上書きの 2 層構造。派生色は `color-mix(in srgb, var(--accent) N%, ...)` で本体色から導出してテーマ追従可能化。CSP meta 明示。詳細な設計判断は popup.css 冒頭コメントを参照。**復活禁止**: ROG 期の装甲造形（`clip-path: polygon()` の角カット / 斜めスラッシュ / ヘキサゴンメッシュ / カーボンファイバー / ネオングロー / `● PWR_ON` の点滅 / `FW//` `>>` `!!` の記号プレフィクス）。

**アイコンは popup.html のスプライト（`<symbol id="ic-*">` 23 種）に一本化する**。24×24 グリッドの単色線画で、`fill: none` + `stroke: currentColor` + `stroke-width: 1.5`。参照は HTML 側が `<svg class="ic"><use href="#ic-*"></use></svg>`、JS 側が popup.js の `createIcon(iconId, className)`（`createElementNS` 必須。`createElement` では SVG として描画されない）。`SearchFixer.CATEGORIES` などの `icon` フィールドの値は**絵文字ではなく symbol id**（例 `"compass"`）。**popup の chrome に絵文字を置かない**（OS ごとに絵柄・彩度・線の太さが変わり、金と葡萄酒の質感に揃わないため）。例外は、YouTube ページ側に content script が実際に描画する `🚫` ボタンを説明する文言（`blockedChannelsEmpty` など）— 実物を指す引用なので絵文字のまま残す。ヘッダーの印は絵文字ではなく頭文字モノグラム（`.hdr-mark`）。

**音量ブースター親トグル**: `volumeBoosterEnabled` (boolean) で master 制御。音量ブースターは **tabCapture 経路一本**（background → offscreen、URL 分岐なし・全サイト一律）。popup の `pushVolumeNow` は (1) 音量関連キー (lastGain + サブトグル 3 + ミュート) を `chrome.storage.local.set` で **永続化** (boost トリガーではなく popup 復元 + `autoApplyVolumeBooster` 用)、(2) active tab に対して常に `VOLUME_BOOSTER_SET_GAIN` を background に送り tabCapture → offscreen で boost する。OFF で `chrome.storage.local.set` のみ（background の `storage.onChanged` リスナーが `releaseAllVolumeBoosterTabs()` で全 AudioContext を解放）。**OFF でも gain / サブトグル設定は storage に残す**（次回 ON 時に復元）。`chrome.tabCapture` は user gesture 必須なので **popup を開かないと boost されない**（タブ切替等での自動適用は無し。popup open 時のみ後述の条件付き自動 push あり）。ブースト中タブには Chrome のタブ共有バナーが出る。

**音量スライダー / サブトグル**: input 時 120ms debounce → `pushVolumeNow`（`gain`, `antiClip`, `nightMode`, `bassCut`, `muted`, `eqEnabled`, `eqGains`, `eqPreamp` を全部 storage に書く + active tab へ tabCapture 経路で送る）。change（マウスアップ）で即 push、100% に戻すボタンは `pushVolumeNow(100)` で release 経路へ。popup 起動時は `chrome.storage.local` の `volumeBoosterLastGain` からスライダー初期値を復元する（offscreen への round-trip 不要）。スライダー UI は 0..200 の内部値を使い、左端 0% / 中央 100% / 右端 300% の実音量へ変換する。popup open（= 拡張機能アイコンクリック）時は **①マスター ON ②設定が中立でない（`!VolumeBooster.isUnityRelease`）③active tab が発音中（`tab.audible === true`）の 3 条件 AND** のときだけ `pushVolumeNow(savedGain)` して即適用する（2026-07-23 条件付き復活。旧・無条件 push は無音の買い物ページ等にタブ共有バナーを誤発させるため 2026-06-07 に撤去した経緯があり、audible ガードで再発を防ぐ。一時停止中タブは audible=false なので従来どおりスライダー等の能動操作が契機）。サブトグル (`volumeBoosterAntiClipEnabled` / `volumeBoosterNightModeEnabled` / `volumeBoosterBassCutEnabled`) は change で `cancelVolumePush` → `pushVolumeNow(currentGain)` の順で即時反映（既存 AudioContext があれば compressor / filter 状態だけ切り替わり音切れなし）。エラーは `formatVolumeError(res.error)` で日本語に翻訳。

**イコライザ（10 バンドグラフィック EQ）**: 音量ブースターのサブ機能として統合。`volumeBoosterEqEnabled` (boolean、master OFF) + `volumeBoosterEqGains` (10 要素配列、各 ±12dB) + `volumeBoosterEqPreamp` (±12dB) + `volumeBoosterEqPreset` (`flat` / `bassBoost` / `trebleBoost` / `vocal` / `loudness` / `custom`) の **4 storage key** で管理。バンド = 32 / 64 / 125 / 250 / 500 / 1K / 2K / 4K / 8K / 16K Hz、Q=1.41 の 10 個の `BiquadFilterNode(type:"peaking")` を直列接続。popup ではプリアンプ + 10 バンドの縦スライダー (writing-mode: vertical-lr) + プリセット `<select>` を `VolumeBooster.EQ_BANDS` 駆動で動的生成し、手動でスライダーを動かすと自動で `custom` に切り替わる。EQ ON のときは 100% でも AudioContext を維持する（UNITY release 条件に `!eqActiveFlag` を追加）。**EQ_GAINS / EQ_PREAMP は popup → storage 直書きで `storage.onChanged` 同期から除外**（メイン音量スライダー `LAST_GAIN` と同じ非対称設計。self-write feedback でドラッグ中の値が clamp+整数化値で上書きされてカクつくのを防ぐ。`EQ_PRESET` は離散値で feedback 連続性問題がないため select 表示のみ同期）。撤去した自動音量正規化と違い**固定フィルタでフィードバックなし**なので決定論的に安定する。

### Background (`src/background/background.js`)
Service worker。役割:
1. **設定の集約と各 content script への配布**: `APPLY_SETTINGS` を popup から受信し、`handleApplySettings` で **storage 既存値とマージしてから** `normalizeSettings` → `chrome.storage.local.set` + `notifyContentScripts` の順で処理する (`APPLY_SETTINGS_KEYS` 列挙ベースの merge 防御、Important Patterns「APPLY_SETTINGS 経路の partial payload 防御」参照)。`notifyContentScripts` は 5〜8 個の `chrome.tabs.sendMessage` を **`Promise.all` で並列発射** し、各 send は `safeSendMessage` ヘルパーで `.catch(() => {})` 集約 (受信側不在は expected error として silent skip)。YouTube タブ / Amazon `auto-deliveries` タブ判定は URL パターンで条件付き dispatch。
2. **Offscreen Document ライフサイクル管理**: `ensureOffscreenDocument()` で並行作成ガード、`scheduleOffscreenClose()` で 30 秒アイドル後に自動クローズ。**音量ブースト中タブが残っている間は close を再延期**（`isVolumeBoosterActive` で確認、SW 再起動直後は安全側に倒す）。`reasons` は `["USER_MEDIA", "AUDIO_PLAYBACK"]`。
3. **音量ブースター制御**: `setVolumeBoosterGain(tabId, gain, antiClip, nightMode, bassCut, muted, eqEnabled, eqGains, eqPreamp)` がエントリ。UNITY release 条件（EQ ON でも維持）・既存 AudioContext 経路・compressor preset / EQ preset 適用・ミュート時の gain ramp to 0 の詳細は Important Patterns 参照。
4. **音量ブースター自動適用**: `chrome.tabs.onActivated` で `autoApplyVolumeBooster(tabId)` を呼び出し。**既に boost 中のタブのみ**（`boostedTabIds.has(tabId)` ガード）が対象。新規タブは `tabCapture.getMediaStreamId` の user gesture 要件によりpopup open が必要。`chrome.storage.onChanged` で `volumeBoosterEnabled` が `false` になったら `releaseAllVolumeBoosterTabs()` で全 AudioContext を即座に解放（SW 再起動後 `boostedTabIds` が空の場合は offscreen に `ACTION_VOLUME_RELEASE_ALL` を直接送信するフォールバック経路あり）。
5. **Message Handler の sender 検証**: `SenderCheck.isFromPopup` / `isFromContentScript` ヘルパーで由来を検証。`APPLY_SETTINGS` / `VOLUME_BOOSTER_*` は popup 由来のみ受け付ける。
6. **タブクローズで自動 release**: `chrome.tabs.onRemoved` で `ACTION_VOLUME_RELEASE_TAB` を offscreen に送信(permission 不要、SW 再起動でも永続的に発火する)。
7. **設定マイグレーション**: `onInstalled` で旧キー削除 + 未設定キーの初期化（詳細は Important Patterns の「マイグレーション」を参照）。
8. **ルーペ用 captureVisibleTab**: content script からの `LOUPE_REQUEST_CAPTURE` を受け、`chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 })` を実行して JPEG DataURL を `sendResponse` で返す。`SenderCheck.isFromContentScript` で由来検証、sender.tab から targetTab を解決。Chrome 公式 2fps quota は content script の 500ms debounce で対応。

`chrome://`, `edge://`, `about:`, `file://` などの非 HTTP(S) ページにはメッセージ送信をスキップ（`content_scripts.matches` が `http(s)://*/*` のみのため）。

### Offscreen (`src/offscreen/offscreen.html`, `src/offscreen/offscreen.js`)
音量ブースター専用の extension-context ドキュメント。`chrome-extension://` は常に secure context のため `getUserMedia({ chromeMediaSourceId })` が動く。`audioStates` Map で tabId → `{ ctx, gainNode, preampNode, eqFilters, nightModeNode, bassCutNodes, antiClipNode, stream, lastSetPercent }` を保持。16 ノードチェーン (preamp + EQ 10 バンド + nightMode + gain + bassCut 2段 + antiClip) の構築・preset 切替・gain ramp の詳細は **Important Patterns 「音量ブースター・Offscreen」** を参照。release 時は `stream.getTracks().stop()` → `ctx.close()` の順（逆順だと生きているソースから出力先消失でエラー）。`pagehide` で全 audioStates を cleanup。streamId は `typeof streamId !== "string"` 型チェック + 印字可能 ASCII (`/^[\x21-\x7e]{4,1024}$/`) regex で検証してから `getUserMedia` に流す（過去に厳格すぎる `^[a-zA-Z0-9_:.\-]{8,256}$` で誤拒否が出たため緩めて、「制御文字・空白を含まない」「長さが妥当」程度の保守的検証に再導入。background 経由で不正値が混入した場合の防御一段確保が目的）。`mandatory.chromeMediaSource = "tab"` 形式を先に試し、失敗時のみフラット `chromeMediaSourceId` にフォールバック。

### YouTube Shorts Removal (`src/content/youtube-shorts.js`)
`*://*.youtube.com/*` 限定の content_scripts エントリで `all_frames: false`（top frame のみ）に注入。`window === window.top` チェックで埋め込みプレーヤーには注入せず CPU 負荷を抑える。

**5 サブ機能 + 1 グローバル nav**: Shelf / Chip / Sidebar / Redirect / Btn の 5 サブ機能と「ホーム / Shorts / 登録チャンネル」global nav を 1 ファイルで担当。CSS は機能ごとに `__cpa-yt-shorts-hide-shelf` / `__cpa-yt-shorts-hide-chip` / `__cpa-yt-shorts-hide-sidebar` / `__cpa-yt-shorts-redirect-active` クラスを `<html>` に付け外し（per-feature 独立化、Claude Code P2 指摘で v1.0.18 にて分割済）。

**YouTube 機能拡張への統合**: 独立 storage key と独自メッセージは持たず、YouTube 機能拡張のサブ機能として動作（`searchFixerFeatures.removeShortsShelf` / `removeShortsChip` / `removeShortsSidebar` / `redirectShortsUrl` / `removeShortsBtn`）。アクティブ判定は `searchFixerEnabled === true` AND 各 features フラグの AND。`APPLY_SEARCH_FIXER_CS` メッセージを search-fixer.js と共に購読する（同一 isolated world で同じメッセージを 2 ファイルが受けて、それぞれの責務に応じて反応する設計）。`storage.onChanged` は片方の key だけ変わった場合に備え、両 key を再取得してから `computeActive()` で判定する（変更されてないキーが undefined になる罠を回避）。

**サイドバー 多言語対応**: `aria-label="Shorts"` (英語) と `aria-label="ショート"` (日本語) を CSS selector に併記する。日本語ロケールの初期 flash を CSS で即時非表示にするため。`title` 属性も同様。

### YouTube 機能拡張 (`src/content/search-fixer.js`)
`searchFixerEnabled` (master) と `searchFixerFeatures` (オブジェクト) と `searchFixerGridItems` (数値: 0/4/5/6) と `searchFixerBlockedChannels` (配列) の 4 キーで管理（変数名は履歴的に `searchFixer*` を使用）。34 機能の単一情報源は `actions.js` の `SearchFixer.FEATURES`。実装: top frame 限定で MutationObserver + `yt-navigate-finish` / `yt-navigate-start` イベントで onSettingsChanged を再実行（SPA navigation で CLASS_PROCESSED マーカーをリセットするため）。マスター OFF 時は observer / 注入 CSS / 装飾クラスをすべて停止。**Shorts 5 サブ機能の実装は search-fixer.js ではなく youtube-shorts.js が担当**（責務分離: SPA URL リダイレクト + サイト横断 DOM 削除は検索ページ限定の clean-up とは別レイヤ）。

**チャンネルブロックリスト (`channelBlocklist`、video_filter カテゴリ)**: YouTube ホームの公式「このチャンネルは表示しない」の拡張版。`searchFixerBlockedChannels` (storage key、`{key, name}` 配列) に登録されたチャンネルの動画を **検索結果 + ホーム / 登録チャンネル / 急上昇等のフィードページの両方**から除去する（2026-07-14 に検索結果限定からフィードページへ拡張、category も `search_only` → `video_filter` に変更）。登録 UI は従来どおり **検索結果限定**: 未登録チャンネルのカードに **hover 表示の 🚫 登録ボタン**（`.__cpa-sfx-block-btn`）をチャンネル名 (`ytd-channel-name`) の直後 sibling として注入する（`<a>` の**外**に置く — 中に置くとクリックがナビゲーションと競合する）。実装上の要点:
- **検索結果の除去 + 登録ボタンは `applyChannelBlocklist()`**（`ytd-video-renderer` / `ytd-channel-renderer` が対象、`removeDistractions()` 内で `isResultsPage()` ゲート済み）
- **フィードページの除去は `purgeFeedDistractions()` に統合**（`yt-lockup-view-model` が対象、`isFeedPage()` ゲート済み）。`resolveLockupChannelKey()` がメタデータ内のチャンネル名リンク `a.ytAttributedStringLink[href^="/channel/"|"/@"]` からキーを取り出す（実機確認済み。視聴ページの関連動画欄はコンパクト variant でチャンネル名がプレーンテキスト化されておりリンクが無いため対象外 = 技術的に不可能）。ブロックリストが空なら Set 構築ごとスキップ（無駄走査防止）
- **照合キーは両経路とも `SearchFixer.extractChannelKeyFromHref`**（純粋関数・境界値テスト済み）: `@handle` は **小文字化**して正規化（YouTube ハンドルは case-insensitive）、`/channel/UC...` は ID をそのまま（case-sensitive）。storage 読込は必ず `SearchFixer.normalizeBlockedChannels` を通す（壊れた値→[] / dedupe 先勝ち / `BLOCKED_CHANNELS_MAX` = 500 件上限 / name 100 文字切り詰め）
- **popup → storage 直書きパターン**（ルーペ倍率と同型、`SettingsSchema` / `APPLY_SETTINGS` 非経由）: cs は初期 `storage.get` + `storage.onChanged` の 2 経路のみで同期（`APPLY_SEARCH_FIXER_CS` メッセージには乗らない）。`storage.onChanged` は `onSettingsChanged()` を経由して `purgeFeedDistractions()` も再実行するため、新規登録は開いているフィードページにも即時反映される。登録ボタン click / popup の解除ボタンとも **storage 現在値を再取得してから書き戻す**（経路 B stale race 防御）
- **管理 UI は popup の video_filter カテゴリ末尾**に `_buildBlockedChannelsManager` で動的挿入（gridItemsSelect の menu_ui 末尾挿入と同型）。一覧 + 個別解除ボタン、popup を開いたまま検索ページで登録された場合も `storage.onChanged` で即時反映
- **cleanup 3 経路**: master OFF / 検索ページ離脱 / orphan 化（`cleanupAllSearchFixerStateForOrphan`）のすべてで `removeAllBlockButtons()`（chrome API 非依存、登録ボタンのみ対象。フィードページの除去は DOM 除去のみで復元機構は無い＝他の video_filter 系除去機能と同じ一方向動作）。機能 OFF 時は `applyChannelBlocklist` 冒頭でもボタン全撤去

**海外チャンネル除外 (`hideForeignChannels`、video_filter カテゴリ)**: 自分の国以外のチャンネルの動画を **検索結果 + フィードページ両方**から除去する。YouTube 標準の検索フィルタには国の条件が存在せず（実測で確認した全項目は タイプ / 時間 / アップロード日 / 特徴 / 優先設定 のみ。「場所」は**動画のジオタグ**絞り込みでチャンネルの所属国とは別物）、ホーム等のフィードにはフィルタ UI 自体が無いため独自実装する。判定は 2 段ハイブリッド:
- **1 段目（言語ヒューリスティック・fetch ゼロ）**: `SearchFixer.detectTextOrigin(text, homeLang)`（純粋関数・境界値テスト済み）がタイトル + チャンネル名の**文字種**で判定。自国固有スクリプト（日本語なら仮名）があれば `home`、自国固有でない非ラテンスクリプト（ハングル / キリル / アラビア等）があれば `foreign`。**漢字とラテン文字は決め手にしない**（漢字は日中で共有、ラテン文字は「英語タイトルを付けた自国チャンネル」と区別不能）ので `unknown` に倒す
- **2 段目（about ページ取得）**: `unknown` のカードのチャンネルだけ `/@handle/about` を **same-origin fetch**（`credentials:"same-origin"` + `redirect:"manual"`、search-fixer.js の `/feed/channels` 取得と同型・**外部送信ゼロ維持**）して `SearchFixer.parseChannelCountry` で `"country"` を抽出。**値は ISO コードではなく表示言語でローカライズされた国名**（`"アメリカ合衆国"` / `"ドイツ"`）なので、`Intl.DisplayNames` で作った自国名エイリアス（表示言語 / 英語 / 国コード）と照合する。国を公開していないチャンネルは**フィールドごと欠落**する（実測で HIKAKIN が該当）
- **fail-open が不変条件**: 判定待ち / 国非公開 / fetch 失敗 / 自国が特定できない環境（`SearchFixer.resolveHomeRegion` が null）は**すべて「残す」**。自国チャンネルを誤って消すほうが体験を壊すため。fetch 完了で `foreign` に確定したカードは `scheduleForeignRescan()`（rAF coalesce）で後追い除去される
- **照合は三値 `SearchFixer.classifyCountryName`（復活禁止: 二値判定）**: `aliases.has(name) ? "home" : "foreign"` の二値にすると、**照合ロケールがずれただけで自国チャンネルが全滅する**（/rere RC-H で発見）。about の国名は **YouTube の UI 言語**でローカライズされ、`navigator.languages` とは独立に決まるため、ブラウザ en-US × YouTube UI 日本語のような環境で `"アメリカ合衆国"` が `{us, united states}` に一致せず全カードが `foreign` に倒れた。現行は「その言語で表現しうる全 region 名」の集合（`knownCountries`）を持ち、**集合に載らない表記は `unknown`（= 残す）** に倒す。照合ロケールには `document.documentElement.lang`（YouTube UI 言語）も含める
- **`parseChannelCountry` は `aboutChannelViewModel` 以降だけを見る**: HTML 全体への先頭一致だと ytcfg 等の**視聴者側の国**を拾い、同じく誤除去に直結する（/rere RC-G）
- **失敗はキャッシュしない**: `fetchChannelOrigin` は確定できたときだけ `writeForeignCache` する。旧実装は fetch 失敗も「国非公開の確定 unknown」と同じ値で焼き付け、一時的な通信断がそのチャンネルの再判定を恒久的に潰していた（/rere RC-B）
- **コスト対策**: about ページは 1 チャンネルあたり 1〜3 MB（`"country"` はドキュメント末尾 98% 地点にあるためストリーム早期 abort は効かない）。同時実行は `FOREIGN_FETCH_CONCURRENCY`（2）、**セッション総数は `FOREIGN_FETCH_SESSION_MAX`（60）** で絞る（固有スクリプトを持たない言語圏では全カードが判定不能になり、同時実行数だけでは総転送量を抑えられない / rere RC-I）。結果は**チャンネル単位**で sessionStorage（`__cpa_ch_country_v1::` prefix / TTL 7 日）+ メモリ Map にキャッシュ
- **停止経路 3 つ**: `AbortSignal`（`FOREIGN_FETCH_TIMEOUT_MS` = 15s）+ `abortForeignCountryFetch()` を master OFF / 対象外ページ遷移 / orphan 化から呼ぶ。旧実装はキューを破棄する経路が無く、機能を切った後も MB 単位の取得が完走していた（/rere RC-A・RC-C）
- **フィードのタイトル取得はカード全体の `textContent` を使わない**（`isForeignLockup`）。「8 か月前」等の相対日付に仮名が混ざり、全カードが自国判定になる罠がある。`a[href*="/watch"][title]` の title 属性 → `h3` の順で解決する

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
- `metaAttached` WeakSet で loadedmetadata listener の二重登録防止 (revertAll() の AbortController abort 時に `new WeakSet()` へ差し替えて detach 済み video 含め一括リセット。旧 DOM マーカー `__cpaVfMetaAttached` は detach 済みを取り残し reinsert+再 ON 時に listener 貼り直し不能になる Claude Code P2 があり廃止)
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

### X クリーナー (`src/content/x-cleaner.{js,css}` + `src/content/x-early.js`)
`*://x.com/*` / `*://*.x.com/*` / `*://twitter.com/*` / `*://*.twitter.com/*` の top frame 限定。TikTok クリーナーと同じ master + FEATURES の 2 段構造（`xCleanerEnabled` / `xCleanerFeatures`）+ CleanerCore 購読 + `<html>` クラス駆動 CSS で、**9 サブ機能**（レイアウト 4 / ノイズ除去 4 / タイムライン 1）を提供する。`window.__cpaXCleanerRunning` で二重実行防止。旧ドメイン `twitter.com` は x.com へ転送されるだけで残っているため、manifest matches と background の `isXUrl` の両方で併記する。

**セレクタ戦略（最重要）: `data-testid` + `:has()` の構造マッチのみ。`aria-label` の文言に依存しない。**
X の aria-label は UI 言語でローカライズされる（実機で「トレンド」「プレミアムプラスにアップグレード」を確認）ため、文言マッチだと日本語環境でしか動かない。難読化 class（`css-146c3p1` 等）はビルドごとに変わるので当然使わない。`:has()` は minimum_chrome_version 140 / Firefox 142 のどちらでも使える。

実機確認済みの構造（2026-07-28 / ログイン状態の `x.com/home`、3 ペイン幅は左ナビ 659 + タイムライン 600 + 右ペイン 350）:

| 対象 | セレクタ |
|---|---|
| 右ペイン全体 | `[data-testid="sidebarColumn"]`。**同時にタイムラインを右端まで広げる**（下記） |
| トレンド | 右ペイン内の `section:has([data-testid="trend"])` **＋「本日のニュース」の `[data-testid="news_sidebar"]`**（片方だけ残すと隠した意味が薄いので同じ機能で消す。検索ボックスは別要素なので残る） |
| おすすめユーザー | 右ペイン内の `aside:has([data-testid="UserCell"])` |
| プレミアム勧誘 | 右ペイン内の `aside:not(:has([data-testid="UserCell"]))` + 左ナビ `a[href^="/i/premium"]` + `[data-testid="premium-hub-tab"]` |
| Grok | `[data-testid="GrokDrawer"]` + 左ナビ `a[href^="/i/grok"]` |
| 広告投稿 | `[data-testid="cellInnerDiv"]:has([data-testid="placementTracking"])`（セル単位で消さないと余白が残る） |
| 反応数 | `[data-testid="{reply,retweet,like,…}"] [data-testid="app-text-transition-container"]`（ボタンは残しカウンタだけ消す） |
| メッセージドック | `[data-testid="chat-drawer-root"]`（旧 `DMDrawer` も併記） |

**`hideRightPane` は幅の制約を 2 段階で外す**（実機で確認 / 2026-07-28）。X はタイムライン幅を ①`[data-testid="primaryColumn"]` の `max-width: 600px` と ②その内側で timeline `section` を包む div の `max-width: 600px`（auto マージンで中央寄せ）の**2 か所**で止めている。①だけ外すと列は 1050px に広がるのに**投稿セルが 600px のまま中央に取り残される**ので、②も外す。②はクラス名が難読化されるため位置ではなく `div:has(> section)` の構造で特定する。ホーム / プロフィール / 投稿詳細で横スクロールが出ないことを実機確認済み。

**`followingTabDefault` だけ JS 実装**（唯一 CSS で書けない機能）。ホームのタブは `[role="tablist"] [role="tab"]` の **index 0 = おすすめ / 1 = フォロー中**で、ピン留めリストは 3 番目以降に並ぶため先頭 2 つの順序は不変（＝位置で特定すればロケール非依存）。ユーザー操作と競合させないため、**ホームで、かつ「おすすめ」が選択中のときだけ、1 ページ表示につき 1 回だけ**クリックする（自分で「おすすめ」に戻したあとは介入しない）。走査は MutationObserver + rAF coalesce、SPA 遷移は `popstate` でも拾う。機能 OFF / orphan / `pagehide(persisted=false)` で observer を切る（bfcache 凍結は温存）。

**early script は「レイアウトが動く 3 つ」だけ焼き込む**（`x-early.js`）: 右ペイン / トレンド / おすすめユーザー。広告・カウンタ・Grok はレイアウトを押し広げないので manifest css の到達で間に合い、早期 paint を無駄に遅らせない。

### 音量ブースター (tabCapture 経路一本、`src/background/background.js` + `src/offscreen/offscreen.js`)
`chrome.tabCapture.getMediaStreamId` + offscreen の `getUserMedia` + AudioContext 方式。**全サイト一律・URL 分岐なし**（Netflix / Prime Video / Amazon 等 EME 動画も含む）。`chrome.tabCapture` は OS / ブラウザレベルで復号された後のタブ音声出力を捕獲するため、EME 動画でもブースト可能。

> **設計史**: v1.0.33 で MediaElementSource (MES) 経路を content script に追加し「普通サイト=MES 自動適用 / EME サイト=tabCapture」の 2 経路 + URL 分岐設計にしたが、(1) Amazon など買い物ページと再生ページが同居するドメインで tabCapture のタブ共有バナーが再生と無関係なページに出る、(2) サイトによって挙動が変わる、という問題があり、ゆろさん指示で **tabCapture 一本（昔の方式）に戻した**（MES 経路 volume-booster.js / EME_HOSTS / isEmeHost / isEmeUrl は撤去済み）。トレードオフ: ①ブースト中タブに Chrome の「このタブのコンテンツは共有されています」バナーが出る（tabCapture 仕様で抑止不可）②popup を開かないと boost されない（自動適用なし）③Firefox MV3 は tabCapture 未対応なので、Firefox 版は専用の MES パイプライン（`volume-booster-mes.js`、manifest.firefox.json のみに登録、2026-07-02 追加。DRM サイト除く）で提供し、background の音量処理は `HAS_VOLUME_BOOSTER` guard で Firefox では全 skip。当時 MES を撤去した理由 (①バナー ②URL 分岐の不透明さ) はいずれも Chrome 固有で、Firefox にはバナーも 2 経路分岐も存在しないため per-browser uniform（Chrome = 常に tabCapture / Firefox = 常に MES）は保たれる。

**popup 必須**: `chrome.tabCapture.getMediaStreamId` は user gesture が必須で、background SW から自動呼び出しは Chrome 仕様で禁止。popup open 自体が user gesture を兼ねる。`popup.js pushVolumeNow` は active tab に対して **常に** `VOLUME_BOOSTER_SET_GAIN` を background に送る（URL 判定なし）。

**処理フロー**:
1. popup の `pushVolumeNow`: 音量関連キー（lastGain + サブトグル 3 + ミュート + EQ enabled/gains/preamp）を storage に永続化（boost トリガーではなく popup 復元 + `autoApplyVolumeBooster` 用）+ active tab へ `VOLUME_BOOSTER_SET_GAIN`（`tabId`, `gain`, `antiClip`, `nightMode`, `bassCut`, `muted`, `eqEnabled`, `eqGains`, `eqPreamp`）を background に送信
2. background: gain が UNITY かつ全サブトグル OFF かつミュート OFF かつ EQ OFF なら `releaseVolumeBoosterTab` で AudioContext 解放して終了。それ以外は `chrome.tabCapture.getMediaStreamId({ targetTabId })` で MediaStream ID 取得（既存 AudioContext があれば streamId なしで gain / preset / mute / EQ だけ更新）
3. background → offscreen: `ACTION_VOLUME_SET_GAIN`（`tabId`, `streamId`, `gain`, `antiClip`, `nightMode`, `bassCut`, `muted`, `eqEnabled`, `eqGains`, `eqPreamp`）
4. offscreen: 未登録タブなら `getUserMedia` → 16 ノード接続 (`source → preampNode → eqFilters[0..9] → nightModeNode → gainNode → bassCutNodes[0..1] → antiClipNode → destination`)。登録済みなら GainNode を `setTargetAtTime` で 45ms ramp、各 DynamicsCompressor / bassCut フィルタのパラメータ切替、`applyEqualizer` で preamp + 10 バンド gain を ramp 更新
5. **タブ切替で自動再適用**: `tabs.onActivated` → `autoApplyVolumeBooster(tabId)` → **`boostedTabIds` に既登録のタブのみ**が対象（既存 AudioContext があるので `getMediaStreamId` 不要で user gesture 制約に引っかからない）。未 boost タブへの初回適用は popup open（= user gesture）が必須

**共通仕様**:
- `volumeBoosterEnabled` (master) + `volumeBoosterLastGain` (数値 0〜300、初期 100) + `volumeBoosterAntiClipEnabled` / `volumeBoosterNightModeEnabled` / `volumeBoosterBassCutEnabled` / `volumeBoosterMutedEnabled` + イコライザ 4 キー (`volumeBoosterEqEnabled` / `volumeBoosterEqGains` 10 要素配列 / `volumeBoosterEqPreamp` / `volumeBoosterEqPreset`) の **10 storage key** で管理
- 全設定はグローバル永続化（タブ間共通）。マスター OFF は全 AudioContext を解放
- **ミュート UI**: popup の音量スライダー左にトグルボタン（🔊/🔇、`aria-pressed` ベース）。ミュート ON 中もスライダー値は last gain 位置のまま表示・操作可能で、ユーザーは「ミュート維持のままスライダー値を変更 → ミュート解除で意図した音量に復帰」できる
- 数値の単一情報源は [`src/lib/actions.js`](src/lib/actions.js) の `VolumeBooster` 定数 — ドキュメントとコードに齟齬が出たら必ずコードを正とすること

### 接続モニター (`src/content/youtube-connection-monitor.{js,css}`)
`*://*.youtube.com/*` 限定の content_scripts エントリ (top frame のみ、`document_idle`)。**YouTube 機能拡張のサブ機能** として `searchFixerEnabled` (master) AND `searchFixerFeatures.connectionMonitor` の AND で制御する（独立 storage key は持たず、Shorts 5 サブ機能と同じ統合方式。`APPLY_SEARCH_FIXER_CS` を search-fixer.js / youtube-shorts.js と共に購読し、`computeActive()` で判定。`storage.onChanged` は `SEARCH_FIXER_ENABLED` / `SEARCH_FIXER_FEATURES` 両キーを監視 → `readSettingsAndApply` が両キーを再取得するので片方 undefined 化の罠を回避）。**YouTube ライブ配信視聴中のクルクル原因** を、自分の回線・端末性能・YouTube CDN・国際線経路に切り分ける in-player HUD を提供する。**拡張機能内で唯一、経路診断のために 5 秒周期で 2 つの公開ヘルスチェック endpoint への RTT 計測 fetch を行う**（後述）。

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
1. popup で YouTube 機能拡張の接続モニターサブ機能を ON → `APPLY_SETTINGS` → background → `notifyContentScripts` (YouTube タブ判定分岐) → `APPLY_SEARCH_FIXER_CS` を top frame に送信 (search-fixer.js / youtube-shorts.js と共有の 1 メッセージ)
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

### Gemini Notebook 送信 (`src/content/youtube-notebooklm.{js,css}` + background の RPC クライアント)
`*://*.youtube.com/*` の top frame に注入（**接続モニター / 配信時刻オーバーレイと同じ content_scripts エントリに相乗り**で actions.js 二重ロードを回避）。**YouTube 機能拡張のサブ機能** `searchFixerFeatures.notebookLmSend`（master `searchFixerEnabled` AND で制御。独立 storage key は持たず `APPLY_SEARCH_FIXER_CS` を購読、`computeActive()` で判定）。視聴中の動画 / 検索結果 / プレイリスト / チャンネルの動画を、ユーザー自身の Google アカウントの **Gemini Notebook にソースとして追加**する。カテゴリは新設の `integration`（🔗）。

**外部送信の 3 例外目**: 本機能は接続モニターの RTT 計測・画像ダウンロードの CDN 取得と並ぶ、外部通信を行う例外。**送信されるのはユーザーがボタンを押した瞬間の YouTube 動画 URL と（新規作成時の）ノートブック名だけ**で、視聴履歴収集やバックグラウンド送信は行わない。docs/privacy-policy.{md,en.md} の「例外 3」に明記済み。

**通信方式（Gemini Notebook には公開 API が無い）**: Web アプリ自身が使う `batchexecute` RPC を叩く。純粋ロジックは `actions.js` の `NotebookLm` namespace（**コード上の識別子は `NotebookLm`。「Gemini Notebook」は表示名なので grep では引けない**）、cross-origin 通信は background（content script からは cross-origin になるため。`host_permissions: ["<all_urls>"]` は v1.0.34 のルーペ対応で既にあるので**権限追加は不要**）。
- **オリジンは `https://notebooklm.google.com`（復活禁止: `notebook.google.com`）**: 旧オリジンは別ホストへ 302 するだけで、全 fetch 共通要件の `redirect:"manual"` では opaqueredirect（`res.ok === false`）になり、**ログイン済みでも必ず `not-authorized`**（「ログインしてください」）に落ちる。「急に全部ログイン要求になった」ときは真っ先にここを疑う
- トークン: `https://notebooklm.google.com/` の HTML から `cfb2h`（build label → `bl`）と `SNlM0e`（XSRF → `at`）を `NotebookLm.extractToken` で抽出
- RPC ID（`test/actions.test.js` で値固定アサート）: `CCqFvf` = ノートブック作成（payload `[title, null, null, options]`、応答から UUID）/ `izAoDd` = ソース追加（payload `[sources, notebookId, options]`）/ `wXbhsf` = 一覧（payload `[null,1,null,[2]]`）/ `ozz5Z` = ソース上限（プラン判定）
- **ソース配列のスロットが種別を決める**（`NotebookLm.buildSourcePayload`）: **1 ソース = 11 要素**で、YouTube URL は 8 要素目・その他 URL は 3 要素目に `[url]` を入れ、**末尾（11 要素目）に `1` が必須**。ここを間違えると Gemini Notebook 側のソース種別が変わる
- **ソース追加 / ノートブック作成には共通リクエストオプションが必須（復活禁止: 省略形）**: `RPC_ADD_SOURCES` は `[sources, notebookId, NotebookLm.buildRequestOptions()]`、`RPC_CREATE_NOTEBOOK` は `[title, null, null, buildRequestOptions()]`。旧実装は `[sources, notebookId]` と短いソース仕様（8 / 3 要素）を送っており、**200 + 正常フレームが返るのにソースが 1 件も登録されない**（= 空のノートブックが開いて「成功」に見える）状態だった。`parseBatchPayload` の検証だけでは検知できないので、形状は `test/actions.test.js` で値固定する
- 応答は独自フレーミング（1 行目に長さ、実データは 4 行目 JSON の `[0][2]` に**文字列として**入れ子）。`NotebookLm.parseBatchPayload` / `parseNotebookList` が担当。一覧の 6 番目要素が `[3,...]` のものは自分のノートブックではないので除外
- 認証はブラウザの既存 Google セッション Cookie（`credentials: "include"`）。拡張は資格情報を読まず保存もしない
- **壊れたときの見立て**: RPC ID は Google の非公開契約で予告なく変わる。「401/403」ではなく**「200 応答なのに ID が取れない」形で壊れる**ことが多い
- **応答は必ず `parseBatchPayload` で中身を検証する（復活禁止: `res.ok` だけで成功判定）**: batchexecute は失敗時も HTTP 200 + エラーフレームを返すため、ステータスだけ見ると**空のノートブックを開いて「成功」と表示**する（/rere RC-D）。ソース追加・一覧取得の両方で payload 検証を通す
- **失敗理由を潰さない**: `fetchNotebookLmTokens` は `not-authorized`（未ログイン）/ `protocol-changed`（200 だがトークンが取れない = 仕様変更）/ `network-failed` を区別して返す。旧実装は全部 `not-authorized` に潰し、ログイン済みユーザーに「ログインしてください」と誤誘導していた（/rere RC-J）。診断ログは `logNotebookLm()` から `[WebViewingAssist] NotebookLM: ...` で出す（トークン等の秘密値は出さない）
- **全 fetch に `AbortSignal.timeout(NotebookLm.FETCH_TIMEOUT_MS)` 必須**: 無いと送信ボタンが「送信中…」で固着して再送不能になる（/rere RC-C）。`redirect: "manual"` も [patterns.md §外部 fetch allowlist 設計](patterns.md#外部-fetch-allowlist-設計-imagedownloaderallowed_hosts) の共通要件どおり適用する（未ログイン時は opaqueredirect → `res.ok === false` → `not-authorized` に落ちるので認証検出は成立する / rere RC-F）
- **部分失敗では `notebookId` を返す**: create 成功 + add 失敗のとき ID を返さないと、再試行のたびに空のノートブックが増える（/rere RC-E）。既存ノートブック選択時は content script が `existingSources` を渡し、background が残容量を差し引いてから受理数を決める（/rere RC-O）
- **sender 検証は `isFromYouTubeContentScript`**: `SenderCheck.isFromContentScript` だけだと「自拡張の content script か」しか見ず、本拡張は全 http(s) サイトに注入しているため YouTube 限定にならない。Google セッション Cookie を使う RPC の起点なので `sender.url` のオリジンまで確認する（/rere RC-P）
- **リクエスト形状は `NotebookLm.buildRpcRequest` に集約**（/rere B2-10）: `f.req` のネスト段数 `[[[rpcId, payload, null, "generic"]]]` と `bl` / `at` / `source-path` / `rt` / `authuser` の付与を純粋関数にし、`test/actions.test.js` で固定アサートする。fetch に直書きすると送信側の drift が CI を素通りする
- **マルチアカウント対応**（/rere D-5）: 送信先の Google アカウントは `authuser` インデックスで選ぶ（storage key `notebookLmAccountIndex`、content script → storage 直書き）。指定しないと常に既定アカウント（u/0）に解決され、Workspace 併用ユーザーは**意図しないアカウントに動画 URL が入る**。**セレクタにはメールアドレスを出す**（旧・番号だけの「アカウント N」表示は、どれが自分のどのアカウントか分からず選べない）。一覧は `NOTEBOOK_LM_ACCOUNTS` で background が `authuser=0,1,2,…` のトップページを順に取得し、HTML の `NotebookLm.ACCOUNT_EMAIL_KEY`（`oPEP7c`）からメールを抽出して作る。**存在しない `authuser` はエラーにならず既定アカウントの HTML が返る**ため、**「既出のメールが出たら打ち切り」が唯一の終了条件**。1 probe あたり数百 KB なので結果は SW メモリにキャッシュし、取得失敗時は番号表示にフォールバックして送信自体は止めない。選んだ結果は**一覧がそのアカウントのものに切り替わる**ので二重に自己検証できる。`buildHomeUrl` / `buildRpcRequest` / `buildNotebookUrl` の 3 か所すべてで `authuser` を保つこと（ノートブック URL で落とすと「作ったはずのノートブックが無い」状態になる）

**UI の配置（参考拡張に合わせた仕様）**: ボタンは **YouTube のページ内**に挿し込む。アンカーは `BUTTON_ANCHORS` に集約し、上から順に試して最初に見つかった要素の**直前**へ入れる。

| ページ | 第一アンカー | 寄せ |
|---|---|---|
| `/watch` | `[role="main"] yt-button-view-model.ytd-menu-renderer`（高評価 / 共有の行 = `#actions` 内） | right |
| `/results` | `[role="main"] ytd-button-renderer.ytd-search-header-renderer`（検索フィルタボタン） | left |
| `/playlist` | `[role="main"] yt-flexible-actions-view-model`（「すべて再生」の行）の**直後**に 1 行で | — |
| チャンネル | `[role="main"] yt-page-header-view-model yt-flexible-actions-view-model yt-subscribe-button-view-model`（チャンネル登録ボタン）の**直後** | — |

- **アンカーは「実際に描画されている」要素だけを選ぶ**（`getClientRects().length` で判定 / 実機で確定）。YouTube はレイアウト variant 用の非表示要素を同じクラス名で先に置くことがあり、素朴な `querySelector` は `display:none` 側を掴む。プレイリストの `.dynamicTextViewModelH1` は 1 つ目が `div#header{display:none}` の中にあり、そこへ挿すとボタンが 0×0 になる（search-fixer.js の `pickVisibleChannelName` と同じ罠）。`offsetParent` は `position:fixed` の要素で可視でも null になるため使わない
- **「描画されている」と「見つけられる」は別問題**（実機で確定 / 2026-07-27）。チャンネルのタイトル見出しにアンカーすると、`float: right` の効いたヘッダー幅いっぱい（実測 1403px）の右端に飛び、チャンネル名から 1000px 以上離れて**存在しても気づけない**。ページ内アンカーは「幅の広い行の端」ではなく、ユーザーが操作する既存ボタンの並び（チャンネル登録・すべて再生・高評価/共有）に寄せる
- **送信対象が 0 件でもボタンは出す**（実機で確定）。一括系ページは `document_idle` 時点でカードが未描画なので必ず 0 件になり、「0 件なら出さない」にすると再走査が届かない限り永久に出ない。`/watch` だけ動いていたのは件数を 1 と決め打ちしていたため
- **アンカー未描画なら挿さずに待つ**（MutationObserver の次の走査で再試行）。参考拡張は「1 秒待って 1 回だけ再取得」の一発勝負だが、こちらは observer 駆動なので SPA の遅延描画に強い。ただし **rAF はバックグラウンドタブで発火しない**ので、`RESCAN_FALLBACK_MS` のタイマーを併用して走査を保証する（別タブで開いた YouTube でボタンが出ない実害があった）
- **配色は自前のテーマ変数を持つ**（実機で確定）。`--yt-spec-text-primary` 等の YouTube 側トークンは content script のスコープでは**未定義**で、フォールバックにライトテーマ色を書くとダークテーマで黒文字になり背景に溶ける。`html[dark]` を見て自前変数を切り替え、YouTube 側トークンがあればそちらを優先する
- 既に正しい位置にあるときは DOM を触らない（`anchor.previousElementSibling !== rootEl` を確認してから挿入。Polymer の再描画を誘発しないため）
- **見た目は YouTube の CSS 変数 (`--yt-spec-*`) だけ借りて自前クラスで作る**。純正クラス名（`yt-spec-button-shape-next--tonal` 等）に依存すると YouTube の内部変更で崩れるため、変数のみ利用しフォールバック値を併記する
- **ポップオーバーは body 直下の `position: fixed`**。ボタンがページ内の flex 行 / 見出し行に入るため、子要素にすると祖先の `overflow` でクリップされる。座標は `positionPanel()` がボタンの `getBoundingClientRect()` から計算し、viewport 外へはみ出さないよう clamp する。スクロール / リサイズでは追従させず閉じる（YouTube 純正メニューと同じ挙動）
- ※ 初期実装は viewport 右下の固定ボタンだったが、**参考拡張と配置を揃える指示で 2026-07-26 に変更**した。「ページ内 DOM にアンカーしない」は現行の不変条件ではない

- **送信先候補は先読みし、送信先タブは background が開く**: (1) ボタンを置けた時点で `prefetchDestinations()` がアカウント一覧とノートブック一覧を 1 回だけ取りに行く（初回クリックでセレクタが番号表示のまま待たされるのを消す）。アカウント probe は**並列 + メールが見つかった時点でストリームを abort**（キーは HTML 先頭 10% にあるので転送量が 1 桁減る）+ `NOTEBOOK_LM_ACCOUNTS_CACHE` に 12 時間キャッシュ。(2) 送信完了後のタブは **background の `chrome.tabs.create`** で開く。content script の `window.open` は送信の await を跨ぐと transient user activation 切れで popup blocker に弾かれ、退避用の「開く」リンクが常態化していた（/rere RC-L）。(3) パネルの `<a>` 要素には `box-sizing: border-box` を明示する（UA 既定が content-box なので padding のぶん横スクロールバーが出る）

**その他の不変条件**: 対象ページは `/watch`（単一）/ `/results` / `/playlist` / チャンネルの `/videos` `/streams`（一括）。一括系は**描画済みカードのみ**が対象で、件数をボタンに出すので「全部入っていない」誤解を防ぐ。URL は `NotebookLm.normalizeWatchUrl` で `watch?v=<id>` に正規化（`&list=` 等が残ると Gemini Notebook 側で重複ソース化する）。上限超過分は黙って捨てず件数を表示する。`createElement` ベースで Trusted Types 安全、`applyInFlight`/`applyQueued` 直列化、context invalidation guard、`pagehide(persisted=false)` teardown、`__cpa-nlm-` プレフィックス。

### 配信時刻オーバーレイ (`src/content/youtube-broadcast-clock.{js,css}`)
`*://*.youtube.com/*` の top frame に注入（`document_idle`、**接続モニターと同じ content_scripts エントリに相乗り**で actions.js 二重ロードを回避）。**YouTube 機能拡張のサブ機能** `searchFixerFeatures.broadcastClock`（master `searchFixerEnabled` AND で制御。独立 storage key は持たず、`APPLY_SEARCH_FIXER_CS` を search-fixer.js / youtube-shorts.js / youtube-connection-monitor.js と共に購読し `computeActive()` で判定。接続モニター / Shorts 5 サブ機能と同じ統合方式）。**ライブ配信のアーカイブ（過去ライブの VOD）再生中に、その瞬間が実際に配信されていた時刻を `yyyy/MM/dd　hh:mm:ss`（全角スペース区切り・全桁ゼロ埋め・24 時間制・ローカルタイム）で HUD 表示する（body 直下 `position:fixed`、初期位置はプレーヤー左上付近、ドラッグで動画の外側を含む viewport 上の任意位置へ移動可）**。純粋ロジックは `actions.js` の `BroadcastClock` namespace、DOM / fetch / lifecycle のみ本 cs が担当。

**配信時刻の算出**: `配信時刻 = liveBroadcastDetails.startTimestamp + video.currentTime`。`BroadcastClock.computeBroadcastEpochMs(startMs, currentTimeSec)` で epoch を出し `BroadcastClock.formatTimestamp(epochMs)` で整形する（両純粋関数とも `test/actions.test.js` で境界値テスト。全角スペース・ゼロ埋め・24 時間制を固定アサート）。

**データ取得（同一オリジン fetch、外部送信ゼロを維持）**: content script（isolated world）からは MAIN world の `ytInitialPlayerResponse` を直接読めないため、`/watch?v=<id>` を **same-origin 認証 fetch（`credentials:"same-origin"` + `redirect:"manual"`、search-fixer.js の `/feed/channels` 取得と同型。外部 CDN 向け fetch 4 原則とは別パターン）** して HTML 内の `liveBroadcastDetails` を `BroadcastClock.parseLiveBroadcastDetails` で正規表現抽出する（**自オリジンへの取得のみ＝接続モニターと違い外部送信はゼロ**）。結果は **videoId 単位で sessionStorage cache**（`__cpa_bc_info_v1::` prefix、負例＝通常動画も cache して再 fetch を防ぐ）、`fetchInFlightVideoId` で同一動画への重複 fetch を防止。

**対象判定**: `liveBroadcastDetails` を持ち、かつ配信終了済み（`isLiveNow !== true`）のアーカイブのみ表示。通常動画（liveBroadcastDetails なし）・配信中ライブ・プレミア公開待ちには出さない。videoId は `BroadcastClock.extractVideoId`（`/watch?v=` と `/live/<id>` 両対応、11 文字厳密マッチ）で取得。

**精度の限界**: `currentTime=0` が配信開始ちょうどに対応する線形マッピング前提のため、配信途中の回線断・再接続や編集カットがあるアーカイブでは、その地点以降に実時刻がずれる（原理的限界でどんな実装でも避けられない。messages.json の機能説明にも明記）。

**HUD UI / 実装上の不変条件（youtube-connection-monitor.js PATTERN SYNC）**:
- **body 直下の `position:fixed`** な ROG クリムゾン HUD。初期位置はプレーヤー左上付近（接続モニターは右上なのでデフォルト位置を分けて衝突回避）、ドラッグで**動画の外側を含む viewport 上の任意位置**へ移動可。位置は `localStorage`（`__cpa_bc_overlay_pos`、viewport 座標）に永続化し、resize / フルスクリーン切替で viewport 内へ clamp。フルスクリーン中は `fullscreenchange` で `document.fullscreenElement` へ reparent（top layer 配下でないと描画されないため）。`#movie_player` への attach に依存しないので、機能 ON 直後やプレーヤー再構築中でもリロード不要で表示できる
- 時刻更新は video の `timeupdate` / `seeked` イベント駆動 + `RENDER_THROTTLE_MS`（250ms）throttle の rAF coalesce（一時停止中は currentTime 固定なので最後の値で静止）
- `createElement` ベースで Trusted Types 安全、`__cpa-bc-` クラスプレフィックスで名前空間化
- `applyInFlight`/`applyQueued` で設定購読を直列化、SPA 追跡は MutationObserver + `yt-navigate-finish`、`pagehide(persisted=false)` で teardown（bfcache 凍結は温存）
- context invalidation guard（`chrome.runtime?.id`）で orphan 化時に observer / listener / overlay を撤去
- top frame 限定（`window === window.top`）、`window.__cpaBroadcastClockRunning` で二重実行防止
