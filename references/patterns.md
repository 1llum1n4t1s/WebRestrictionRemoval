# WebRestrictionRemoval 実装パターンと過去の罠

このファイルは `AGENTS.md` から Important Patterns の詳細を分離したもの。目次は `AGENTS.md` 側にあるので、そこで当たりを付けてから該当節を読む。

---

---

### Firefox AMO 対応 (2026-05-16 確立、ReplaceFontSelect の知見ベース)

WebRestrictionRemoval は Chrome + Firefox 両対応。**音量ブースターは per-browser 2 実装** — Chrome は tabCapture → offscreen 経路 (Firefox MV3 は `chrome.tabCapture` / `chrome.offscreen` 未対応)、Firefox は専用 MES パイプライン (`volume-booster-mes.js`、manifest.firefox.json のみに登録、2026-07-02 追加) で、Firefox でも全 12 機能が動作する (DRM サイトでは音量ブースターのみ無効)。background の音量関連処理は `HAS_VOLUME_BOOSTER` guard で Firefox では全 skip。Firefox 版ビルドの不変条件:

1. **専用 manifest 分割** — `manifest.firefox.json` を別ファイルで持ち、zip スクリプトが Firefox xpi 生成時に `manifest.json` として同梱する。Chrome 版とは以下が違う:
   - `offscreen` / `tabCapture` permission を **除外** (Firefox MV3 未対応)
   - `browser_specific_settings.gecko` に gecko id + `strict_min_version: "142.0"` + `data_collection_permissions: {required: ["none"]}` を追加 (v1.0.33 で 140 → 142 化。`data_collection_permissions` は Firefox Android 142+ で導入されたため strict_min_version 140 だと矛盾警告が出る)
   - **`background.scripts` 単独**（`service_worker` は記載しない / v1.0.33 で削除）。Firefox MV3 は `service_worker` を ignored 警告対象とするため。Chrome 版は manifest.json 側で従来どおり `service_worker` のみ
   - `minimum_chrome_version` 削除
   - `host_permissions: ["<all_urls>"]` を追加 (Firefox AMO 推奨)

2. **`importScripts` ガード** — `background.js` 冒頭は `if (typeof importScripts === "function") importScripts("/src/lib/actions.js");` でガードする。Firefox event page では importScripts は worker 限定 API のため呼べないが、manifest の `background.scripts` で actions.js を先に評価しているので skip して OK。

3. **`HAS_VOLUME_BOOSTER` ランタイム検知** — `const HAS_VOLUME_BOOSTER = typeof chrome.offscreen !== "undefined" && typeof chrome.tabCapture !== "undefined";` を background.js で定義し、`VOLUME_BOOSTER_SET_GAIN` / `VOLUME_BOOSTER_RELEASE_TAB` メッセージ handler、`chrome.tabs.onActivated` / `chrome.tabs.onRemoved` / `chrome.storage.onChanged` の音量関連経路で早期 return する。

4. **popup の MES 分岐** — `popup.js` の `VOLUME_BOOSTER_VIA_MES = !HAS_VOLUME_BOOSTER` で Firefox を検知し、(a) audio section は Firefox でも**表示したまま** `#volumeMesNote`（DRM サイト非対応の注記、i18n キー `volumeMesFirefoxNote`）の hidden を外す、(b) `pushVolumeNow` は storage 書き込み（MES では EQ 3 キーも同梱して live 反映）だけで early return し `VOLUME_BOOSTER_SET_GAIN` メッセージを送らない。旧「audio section 全体を display:none」方式は 2026-07-02 の MES 経路追加で廃止。

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
- **デフォルト OFF 方針徹底** — 10 マスタートグル（YouTube 機能拡張 / Amazon 合計 / Amazon ランキング / Amazon バッジ / Instagram クリーナー / TikTok クリーナー / 動画ガンマ補正 / 動画黒帯除去 / ルーペ / 音量ブースター）が `onInstalled` で false 初期化、復元は `=== true` で防御的に判定。音量ブースターはマスター OFF に加え、ON でも「スライダー 100% かつ全サブトグル OFF かつミュート OFF」のときリソース解放される（インストール直後はマスター OFF かつ全サブトグル OFF = 完全に無処理）。ルーペもマスター OFF で content script 内の DOM / リスナーがすべて撤去される（Blob URL も revoke）。接続モニターは YouTube 機能拡張のサブ機能（`searchFixerFeatures.connectionMonitor`、デフォルト OFF）で、master `searchFixerEnabled` OFF またはサブ機能 OFF で 1s サンプル timer / 5s 診断 timer / video イベントリスナー / MutationObserver / overlay DOM / drag listener をすべて撤去（外部 fetch も停止し、ライブ視聴中以外は overlay 非表示）。

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
hideLiveChat は **iframe 内 close button の公式 click 1 つ** に責務を集約した最小設計に到達している (詳細フローは Architecture 章「YouTube 機能拡張」の `hideLiveChat 体感ラグ消滅の先制非表示パターン」7 ステップ参照)。新機能を足すときに **絶対に復活させてはいけない過去の失敗経路** が複数あるため、ここで明文化しておく。

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

Chrome の音量ブースターは tabCapture → offscreen の AudioContext 一本（自動音量正規化は撤去済み、全サイト一律で EME 動画も含む）。以下の不変条件はこの Chrome 経路に適用される。Firefox は専用 MES パイプライン（次セクション参照）が別実装で担い、本セクションのコードには触れない。

**オーディオ路の不変条件**:
- **ノード順序は `source → preampNode → eqFilters[0..9] → nightModeNode → gainNode → bassCutNodes[0..1] → antiClipNode → destination` に固定** — EQ プリアンプ → 10 バンド peaking フィルタ → ナイトモードでダイナミックレンジを狭め、手動 gain でブーストし、壁ドン対策 (highpass 2段) でブースト後の低音を削り、後段に limiter (anti-clip) を置く。gain を先頭に置かず compressor の後段に置くことで「EQ → 圧縮 → 増幅 → 低音カット → リミット」のマスタリング順を保つ。bassCut を gain の後段に置くのは、boost 率に関わらず最終出力の低音を確実にカットするため（先に置くと gain が残留低音を再ブーストしてしまう）。
- **gain は線形マッピング + `setTargetAtTime` ramp** — UI スライダーは内部値 0..200、実音量は左端 0% / 中央 100% / 右端 300%。実 gain は `VolumeBooster.percentToGain()` で `percent / 100` に線形変換する（**表示 % = 実音量倍率**: 150% = 1.5x / 200% = 2.0x / 300% = 3.0x）。旧実装は 100..MAX を対数で等 dB 配分していたが「150% なのに約 1.2 倍」と表示が実倍率と乖離する問題があり線形化した（ゆろさん指摘 2026-06-27）。スライダー位置 → 表示 % の変換（`sliderPositionToPercent`）は中央 = 等倍を保つため従来どおり。`gainNode.gain` への直接 `.value =` 代入はサンプル境界の不連続でクリック発生 → 必ず `cancelScheduledValues` → `setValueAtTime(現在値, now)` → `setTargetAtTime(target, now, RAMP_TIME_CONSTANT)` の三点セットで ramp 経由（`RAMP_TIME_CONSTANT = 0.015` で 3τ ≈ 45ms 95% 到達、popup の 120ms debounce より十分短い）。
- **DynamicsCompressor は disconnect ではなく BYPASS preset で OFF** — ナイトモード / 自動歪み防止のサブトグル OFF 時にノードを disconnect/reconnect すると AudioContext のグラフが切れて一瞬無音になりプチノイズが乗る。`COMPRESSOR_BYPASS`（`ratio:1`、threshold/knee 中立）を `applyCompressorPreset` で当てれば素通り化が無音ゼロで実現（切替頻度が低くアタックが速い 1〜50ms ため `setTargetAtTime` 不要、`.value =` 直接代入で十分）。
- **イコライザも disconnect ではなく 0dB / unity gain で OFF** — EQ OFF 時に BiquadFilterNode 群を disconnect/reconnect すると compressor と同様に音切れが起きる。`applyEqualizer(state, false, ...)` で preampNode.gain = unity (1.0)、eqFilters[i].gain = 0dB (素通り) に ramp で戻すことで、チェーン上は常時接続のままバイパス。手動操作中のスライダーでも周波数特性の連続変化が ramp で段差なし。**固定フィルタでフィードバック無し**（撤去した自動音量正規化と違って測定 → 補正ループがない）ため決定論的に安定。
- **壁ドン対策 (highpass) も disconnect ではなく frequency:0 で OFF** — `bassCutNodes` (BiquadFilterNode type:"highpass" × 2) は compressor / EQ と同じ思想で常時接続を維持し、OFF 時は `applyFilterPreset` で全段へ `BASS_CUT_BYPASS`（frequency:0）を当てて可聴域全体を素通しする。ON 時は全段へ `BASS_CUT_PRESET`（frequency:150Hz, Q:-3.0103 の Butterworth）を適用し、Linkwitz-Riley 4次相当の 24dB/oct を得る。切替頻度が低いため ramp 不要で `.value =` 直接代入で十分。**Web Audio の `lowpass` / `highpass` の Q は「共振量を dB 指定」する例外仕様**（`peaking` の Q とは別物）なので、Butterworth は線形 Q の `0.7071` ではなく `20*log10(0.7071) = -3.0103` を入れる（**復活禁止: `Q: 0.7071`**）。
- **volumeGetGain は `state.lastSetPercent` を返す** — `gain.value` はランプ中で目標値と一致しないため、ユーザーが最後に指定した整数 percent を保持して round-trip 誤差ゼロを担保。`gainToPercent(gain.value)` 経由だと使えない。

**ライフサイクルの不変条件**:
- **マスター OFF = パイプライン解放、設定は保持** — `volumeBoosterEnabled` が `false` になったら `releaseAllVolumeBoosterTabs()` で全 AudioContext を解放するが、`volumeBoosterLastGain` / サブトグルの storage 値は一切触らない。次回 ON 時に保存済み値を復元する。
- **UNITY release 条件は「100% かつ全サブトグル OFF かつミュート OFF かつ EQ OFF」** — `setVolumeBoosterGain` で UNITY 早期 return するのは `clamped === UNITY && !antiClipFlag && !nightModeFlag && !bassCutFlag && !mutedFlag && !eqActiveFlag` のときだけ。100% でもサブトグル / EQ ON なら AudioContext 維持で compressor / filter / EQ を効かせる。「突発音だけ抑える」「ナイトモードだけ使う」「壁ドン対策だけ使う」「100% で完全消音」「100% で EQ だけかける」ユースケースを維持する。
- **`releaseAllVolumeBoosterTabs` の SW 再起動フォールバック** — SW 再起動後は `boostedTabIds` が空だが offscreen に生きた AudioContext がある可能性あり。`boostedTabIds` が空かつ `offscreenState !== "CLOSED"` のとき `ACTION_VOLUME_RELEASE_ALL` を offscreen に直接送信する。
- **`autoApplyVolumeBooster` は既 boost タブ限定** — `boostedTabIds.has(tabId)` ガードにより、`tabs.onActivated` では既存 AudioContext の gain ramp だけが走る。新規タブへの初回適用は popup open（= user gesture）が必要（`tabCapture.getMediaStreamId` の user gesture 要件）。
- **アイドル close 抑止** — `isVolumeBoosterActive` で boost 中タブを query。先頭で `offscreenState === "CLOSED"` を見て早期 false return すること（query 不要 + receiver 不在経路の誤判定回避）。SW 再起動直後など sendMessage が一時失敗した場合のみ安全側（active 扱い）に倒す。
- **タブクローズで自動 release** — `chrome.tabs.onRemoved` は permission 不要 + SW 再起動でも永続発火するため、AudioContext の取り残しを防げる。

**API / 制約**:
- **Offscreen Document の 1 拡張 1 文書制約** — `reasons` は `["USER_MEDIA", "AUDIO_PLAYBACK"]`。新しい用途を追加するときは既存ドキュメントに同居させること。
- **`minimum_chrome_version: "140"` 固定** — `chrome.runtime.getContexts`（116+）等の new API は **typeof チェックなしで直接呼んで良い**。legacy fallback の `if (typeof chrome.runtime.getContexts !== "function")` 分岐はバグ温床（receiver 不在エラーを active 扱いして 30 秒 cycle 無限再 schedule した Claude Code P2 指摘あり）なので追加しないこと。

**DSP preset チューニング履歴** (新規に DSP に触る前に必ず読む。値定数の正は `src/lib/actions.js` `VolumeBooster`、フロー制御の正は `src/lib/audio-pipeline.js`。ナイトモード / 自動歪み防止 preset の調整履歴は actions.js の `NIGHT_MODE_PRESET` / `ANTI_CLIP_PRESET` コメント、壁ドン対策は `BASS_CUT_PRESET` / `BASS_CUT_BYPASS` コメントを参照):

| Version | 変更内容 | 動機 / 棄却された alternative |
|---|---|---|
| v1.0.x | DynamicsCompressor のサブトグル OFF で `disconnect/reconnect` 経路 | **棄却**: 一瞬無音化 + プチノイズ。`COMPRESSOR_BYPASS` preset (`ratio:1`、threshold/knee 中立) で素通り化に置換 → 切替頻度低 + アタック速 (1-50ms) のため `.value =` 直接代入で十分 |
| (基盤) | gain ramp は `setTargetAtTime` 3 点セット | `gainNode.gain.value = X` 直接代入はサンプル境界の不連続でクリック音発生 → 必ず `cancelScheduledValues` → `setValueAtTime(現在値)` → `setTargetAtTime(target, now, τ)` の三点セット。`RAMP_TIME_CONSTANT = 0.015` で 3τ ≈ 45ms 95% 到達 (popup の 120ms debounce より短い) |
| 2026-06-27 | `percentToGain` を対数 → 線形化 (`percent / 100`) | **棄却した対数**: 100..MAX を等 dB 配分し「等距離スライダー = 等 dB」でドラッグ体感を均一化していたが、表示 % と実倍率が乖離し「150% なのに約 1.2 倍」とユーザー誤読 (ゆろさん指摘)。**表示 % = 実倍率 (150%=1.5x) の直感性を優先**して線形化。スライダー位置 → 表示 % (`sliderPositionToPercent`) は中央 = 等倍を維持するので操作感は不変。逆関数 `gainToPercent` も `gain × 100` に線形化 |
| 2026-06-27 | 最大ブーストを 600% → 300% (3.0x) に変更 | ゆろさん指示。線形化後の最大値調整。`VolumeBooster.MAX` 定数のみ変更で clampValue / percentToGain / スライダーマッピング (`sliderPositionToPercent`) が追従。スライダー右端 = 300% = 3.0x |
| 2026-07-14 | 壁ドン対策モードの初版（当時は `bassCutNode`、highpass 150Hz / Q:0.7071 × 1段）を gain の後段・anti-clip の前段に追加 | ナイトモード（別トグル）とは別軸の要望: 「低音を物理的にカットして壁・床への振動伝達を抑えたい」。compressor (dynamics) では周波数を削れないため BiquadFilterNode を新設。`applyFilterPreset` を compressor 用 `applyCompressorPreset` と対の汎用関数として追加し、disconnect レスの BYPASS (frequency:0) 方式を踏襲。翌日に2段へ強化 |
| 2026-08-04 | 壁ドン対策の Q を `0.7071` → `-3.0103` に修正（単位が dB だった） | 「壁ドン対策が全く効かない」報告の実原因。Web Audio の highpass の Q は共振量の **dB 指定**で、線形 Q の 0.7071 は「+0.71dB 共振」の意味になっていた。2 段合成の実測で 150Hz **+1.4dB** / 200Hz **+3.5dB** / 250Hz **+2.9dB** と、壁を伝うドスドス感の主帯域を逆にブーストしていた（50Hz は -37dB で落ちるため「下は効くが体感が相殺される」形の不具合）。修正後は 150Hz -6.0dB / 200Hz -2.4dB。**棄却案**: カットオフを 200Hz 等へ上げる案は、共振ピークが残ったまま声の芯まで削るので不採用（原因は周波数ではなく Q の単位） |
| 2026-07-15 | 壁ドン対策を highpass 1段 (12dB/oct) → 同一 Butterworth 2段 (24dB/oct) へ強化 | 150Hz 直下の低音が緩やかにしか落ちず体感上残っていた。カットオフを上げて声の芯まで削る案は採らず、150Hz を維持したまま傾斜を倍化。Chrome / Firefox の両経路を共有 `createBassCutChain` で同一構成に固定 |

> 自動音量正規化 (EMA / silence gate 二重判定 / dead zone / 非対称 ramp 等の AGC チューニング) は v1.0.38 / v1.0.39 / 2026-06-07 と何度も調整したが、リアルタイム AGC として実用水準に届かず機能ごと撤去した (2026-06-19)。詳細な経緯と棄却した alternative は §撤去済み機能と教訓「自動音量正規化」を参照。

### 音量ブースター・Firefox 専用 MES パイプライン (volume-booster-mes.js、2026-07-02 追加)

Firefox MV3 は tabCapture / offscreen 未対応のため、Firefox 版の音量ブースターは content script の MediaElementSource (MES) 経路で提供する。**Chrome への影響ゼロが最優先の不変条件**。

**⚠️ 最重要の前提 (敵対的レビュー 3/3 で確定)**: **Firefox では一度 MES で capture した要素は `ctx.close()` しても直接出力に復帰しない**（要素は captured のまま = 無音）。「detach して音を元に戻す」という回復手段は存在しないため、設計は **誤 attach の予防** と **graph を生かしたままの bypass** に全振りする。`ctx.close()` は音がもう不要な場面の資源解放専用。

**Chrome 影響ゼロの担保 (3 層)**:
1. content_scripts エントリは **manifest.firefox.json のみ** に置く (Chrome 用 manifest.json には追加しない。Chrome zip にファイル自体は同梱されるが参照されないため不活性)
2. スクリプト冒頭の `chrome.runtime.getURL("")` スキーム検査（`moz-extension://` = Gecko）で、万一 Chrome 系にロードされても即 return する（`typeof browser` 判定は Chrome 137+ が extension context に browser namespace を露出するため判別子にならない。`chrome.tabCapture` の typeof 検査も「content script には Chrome でも露出しない」「AMO linter の UNSUPPORTED_API 警告対象」の 2 理由で使えない）
3. Chrome の tabCapture 経路コード (background / offscreen / popup の送信部) には手を入れない。popup の分岐は `VOLUME_BOOSTER_VIA_MES = IS_GECKO_EXTENSION && !HAS_VOLUME_BOOSTER` の early return のみ（IS_GECKO_EXTENSION も同じスキーム検査。generate-screenshots の popup-shim 環境で Firefox 注記が Chrome ストア素材に写り込まない防御を兼ねる）

**storage 駆動・メッセージレス**: popup が音量関連キーを storage 直書き → 全タブの volume-booster-mes.js が `storage.onChanged`（9 キー監視。`EQ_PRESET` は popup 表示専用のため対象外）で `loadAndApply()`。v1.0.33 の旧 MES 実装と同じ配線で、**user gesture 不要・popup 不要・全タブ自動適用・タブ共有バナーなし**。MES 経路では popup の `pushVolumeNow` が EQ 3 キー (ENABLED / GAINS / PREAMP) も storage 書き込みに同梱する（メッセージが無いため。EQ スライダードラッグ中の live 反映もこれで届く。popup 自身は EQ_GAINS / EQ_PREAMP の onChanged 同期をしないので self-write feedback は起きない）。

**必須の不変条件 / 復活禁止の失敗パターン**:
- **`ctx.close()` は資源解放専用** — 呼んでよいのは「DOM から除去され 30 秒再挿入されなかった要素」（即 close すると remove → reinsert するプレーヤーで再挿入後が無音のままになるため猶予を置く）と「pagehide(persisted=false)」のみ。OFF / UNITY release / orphan 化はすべて **dry=1 / wet=0 へ crossfade して bypass 維持**（close すると再生中の音が死んで戻せない）
- **旧 sandbox 消滅に備える dry/wet lease** — active 中は 5 秒 heartbeat の storage 生存確認に成功したときだけ、dry=0 / wet=1 の 20 秒 lease を更新する。拡張リロード・無効化で callback が走らなくても、最後に予約済みの AudioParam automation が AudioContext timeline 上で dry=1 / wet=0 へ戻す。新 realm は既存 MES に再 attach できないため、再ブーストにはページ再読み込みが必要
- **attach 判定は三段の予防** — ① EME: `EME_HOSTS` 起動 skip + `mediaKeys != null` + `encrypted` event の**事前検出**（encrypted は metadata 確定までに発火するので、② の readyState gate と合わせて attach 前に確実に捕まえる。attach 後に発火しても detach しない = close では復帰しないため無意味で、graph 維持なら非 DRM ソース切替で自然回復する）② `readyState >= HAVE_METADATA` 待ち ③ `VolumeBooster.classifyMesSource`（純粋関数・境界値テスト済み・4 値）: `safe`（blob:/data:/crossorigin 属性付き）= 即 attach / `probe`（same-origin http(s)）= **`redirect:"manual"` の same-origin 1 バイト Range GET probe** で opaqueredirect でないことを確認してから attach（currentSrc はリダイレクト前 URL を返すため、same-origin → cross-origin redirect 配信の opaque taint 無音化はこの probe でしか防げない。probe 失敗時は attach しない fail-safe。same-origin への 1 バイト Range GET のみで外部送信ゼロ維持）/ `pending` = loadedmetadata / loadstart / play で再評価 / `unsafe` = skip
- **設定の適用 / bypass は ATTACHED レジストリ（Set<WeakRef>）を反復** — `document.querySelectorAll` 依存だと shadow DOM へ移動した要素や detached 再生中の要素に設定変更が届かず boost / mute が固着する。querySelectorAll は新規要素の発見のみに使う
- **MutationObserver は attach 済み要素が残る限り master OFF でも切断しない** — 切断すると bypass 維持中の AudioContext が DOM 除去後に解放されず pagehide までリークする（attach 側は callback 内 `isActive()` gate 済みなので新規 attach は起きない）
- **suspended AudioContext 対策** — attach 直後 + play / volumechange + document の pointerdown / keydown（user activation 発生点）で `ctx.resume()`。suspended のまま放置すると attach 済み要素が無音になる
- per-element listener は `listenerCtrl` (AbortController) + `watchedMedia` (WeakSet) の一括解除パターン（video-fill.js と同型）
- **既知の制約**: Firefox で拡張リロード / 無効化後に旧 sandbox が破棄されると、旧 graph は最大約 20 秒で dry bypass へ戻るが、新 realm から既存 MES を再制御できないため再ブーストにはページ再読み込みが必要。DRM 区間・taint 区間の無音は Web Audio 仕様であり回避不能（予防のみ）

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
5. **`metaAttached` (WeakSet)** で二重登録防止、revertAll で `new WeakSet()` に差し替え (detach 済み video も含めた追跡を O(1) 一括リセット、DOM プロパティマーカーだと取り残し発生する Claude Code 4 巡目 P2 対策)
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
- DOM プロパティマーカー (`v.__cpaAttached = true`) で listener 二重登録防止: detach 済み video のマーカーが取り残されて reinsert+再 ON 時に listener 再 attach 不能 (= Claude Code 4 巡目 P2 で実例化)

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
- **`onInstalled` で旧キー削除 + 値転写** — 廃止 storage key（過去例: `copyPasteSettings` / `enabled` / `contextMenuAllowDomains` / `ytShortsRemovalEnabled` / `keepAliveOrigins` / `keepAliveEnabled` / `keepAliveIntervalMs` / `keepAliveHttpPingEnabled` / `rtxEnhancerEnabled` / `volumeBoosterNormalizeEnabled`）は `chrome.storage.local.remove` で取り除く。値の意味が新キーに引き継がれるなら、削除前に転写する（v1.0.18 で `ytShortsRemovalEnabled === true` → `searchFixerFeatures.removeShorts = true` + `searchFixerEnabled = true` を実施）。**動作継続を最優先**で設計する。`searchFixerFeatures` オブジェクト内のサブキー統合も同パターン: 旧 `removeTopicsSection` / `removeBreakingNewsSection` → `removeFeedSections` 統合では、storage 生値に旧キーが存在する場合のみ `SearchFixer.mergeFeatures` で書き戻して旧キーを strip し、どちらかが `=== true` かつ新キーが storage 生値で未設定なら新キーへ ON を転写する（新キー明示設定は尊重。判定は必ず storage 生値ベース — merged 側を見ると default seed の false を「ユーザー明示 false」と誤認する Claude Code P2 の罠）。注: `volumeBoosterEnabled` は過去に廃止→再導入されたキー。legacy 削除リストに含めないこと。`keepAliveOrigins` は v1.0.34 でサイト単位設計→全タブ共通設計に変更時に削除、同時に `keepAliveEnabled` を強制 `false` リセット (UX 把握困難性の解消が目的のクリーンスタート方針、ゆろさん指示)。**「セッション維持」機能と「RTX 動画強化」機能自体は v1.0.39 で完全撤去**、関連 4 キーは `onInstalled` の legacy 削除リストに集約。
- **新規 storage key は `onInstalled` で必ず初期化** — `volumeBoosterEnabled` / `volumeBoosterLastGain` / `volumeBoosterAntiClipEnabled` / `volumeBoosterNightModeEnabled` / `volumeBoosterBassCutEnabled` / `searchFixerFeatures.hideComments` のような後追いキーは未設定時 `undefined` で UI 側に出るとトグルが表示されない・無効状態になるため、必ず `onInstalled` で `false` (boolean) / `VolumeBooster.DEFAULT` (数値) 初期化する。`normalizeSettings()` 側でも `=== true` 防御的判定を入れる（`!!value` だと storage の落ちた object 値で誤判定が出るため）。

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
**音量ブースター 10 キー** (`volumeBoosterEnabled` / `volumeBoosterLastGain` / `volumeBoosterAntiClipEnabled` / `volumeBoosterNightModeEnabled` / `volumeBoosterBassCutEnabled` / `volumeBoosterMutedEnabled` + EQ 4 キー `volumeBoosterEqEnabled` / `volumeBoosterEqGains` / `volumeBoosterEqPreamp` / `volumeBoosterEqPreset`) のみ popup から直接 `chrome.storage.local.set` する設計で、background の `normalizeSettings` を経由しない。
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
- 件数を増減する場合は **同時に**: (1) FEATURES 配列に追加、(2) アサート値更新、(3) AGENTS.md / README / docs/privacy-policy.md / webstore/store-listing.txt / popup.html コメント / actions.js 内コメント の数値を全部更新
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
- 状態: AGENTS.md で「動画一時停止用途」と明示的設計選択
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
- **教訓 2 (DSP コア共有モジュール構造は維持)**: `src/lib/audio-pipeline.js` は MES + tabCapture 両 caller の drift 解消が当初動機だったが、撤去後は caller が offscreen.js 単独になった。それでも Firefox 向け再利用に備えて共有モジュール構造を残す判断をした。
- **後日談 (2026-07-02、Firefox 専用で部分復活)**: 撤去理由 (①タブ共有バナーが無関係ページに出る ②URL 分岐で挙動が不透明) は **すべて Chrome 固有** だったため、MES を `volume-booster-mes.js` として **Firefox 専用パイプライン** で復活させた (Firefox にはバナーも 2 経路分岐も存在せず、per-browser uniform が保てる)。EME_HOSTS / isEmeHost は actions.js に再導入 (isEmeUrl は popup 分岐が無いため不再導入)。audio-pipeline.js の共有モジュール構造維持の判断がここで活きた。詳細は §音量ブースター・Firefox 専用 MES パイプライン。

#### 自動音量正規化 (撤去: 2026-06-19、当初導入: v1.0.20 系)
- **何だったか**: 音量ブースターのサブ機能 (`volumeBoosterNormalizeEnabled`)。`AnalyserNode.getFloatTimeDomainData()` で短時間 RMS を測り、timer 駆動の自動 GainNode で「動画 / 配信ごとの平均音量」を目標 RMS (`NORMALIZE_TARGET_RMS_DB`) に寄せるラウドネス補正 (リアルタイム AGC)。offscreen のノードチェーン前段 (`normalizerAnalyzer → normalizerGainNode`) + `NORMALIZE_*` DSP 定数群 + audio-pipeline.js の normalizer 6 関数 (clampNormalizerGain / scheduleNormalizerGain / tickLoudnessNormalizer / startLoudnessNormalizer / stopLoudnessNormalizer / updateLoudnessNormalizer) で構成。
- **撤去理由**: ゆろさん判断「現実的でない」。EMA 平滑化 / silence gate 二重判定 / dead zone / 非対称 ramp 等を v1.0.38 / v1.0.39 / 2026-06-07 と何度もチューニングしたが、BGM の verse↔chorus・喋りの息継ぎ・シーン切替での「効き」と「ポンピング抑制」の両立が安定せず、リアルタイム AGC として実用水準に達しなかった。
- **撤去内容**: `volumeBoosterNormalizeEnabled` storage key を `onInstalled` legacy 削除リストに集約。actions.js の `VOLUME_BOOSTER_NORMALIZE_ENABLED` + `NORMALIZE_*` 10 定数、audio-pipeline.js の normalizer 6 関数 + `dbToGain` (normalizer 専用だったため)、offscreen のノードチェーン前段 + normalizer state フィールド、background / popup の normalize 配線、messages.json の volumeNormalize ラベル/説明を完全削除。test/actions.test.js に撤去 drift 検知アサート追加。音量サブトグルは自動歪み防止 / ナイトモードの 2 つ、storage key は 6 → 5、popup 直書きキーは 5 → 4 に減少。
- **教訓 1 (リアルタイム AGC は難物)**: 「動画ごとの平均音量を自動で揃える」は ReplayGain のような事前解析方式なら容易だが、リアルタイムでは測定窓・追従速度・無音判定の三つ巴チューニングが必要で、どれかを立てると別が崩れる。同種の「連続測定 → 連続補正」機能を再導入するときは、まず実用水準に届くかを小さく検証してから本実装する。
- **教訓 2 (audio-pipeline.js の構造は維持)**: normalizer 6 関数の撤去で一時 applyCompressorPreset のみになったが、後に 10 バンド EQ を追加した際に dbToGain (プリアンプの dB→倍率変換) / applyEqualizer (preamp + 10 バンド peaking gain 適用) / createEqChain (EQ チェーン構築) を再導入し、さらに壁ドン対策モードで applyFilterPreset (BiquadFilterNode の frequency/Q 一括設定) と createBassCutChain (highpass 2 段の構築)、Chrome / Firefox の最上位配線を固定する connectAudioGraph を追加、現在は **dbToGain / applyCompressorPreset / applyFilterPreset / createBassCutChain / applyEqualizer / createEqChain / connectAudioGraph の 7 関数構成** (Key Files 表 §audio-pipeline.js と整合)。当初の機能撤去 → 共有モジュール構造維持 → EQ 追加 → 壁ドン対策追加で再活用、という流れで「globalThis.AudioPipeline 公開定数 + Firefox catch-up 時の再利用枠を残す」判断が結果的に活きた事例。

#### 撤去パターン共通の不変条件
- **`onInstalled` で legacy storage key を必ず削除**: 廃止キーを残すと storage に dead value が永遠に残る + 将来 同名キーを再利用する場合に「OFF 化したつもりが ON で復元される」事故源。撤去時は必ず `onInstalled` の legacy 削除リストに追加。
- **`test/actions.test.js` に drift 検知アサート追加**: 撤去機能の定数・アクション・FEATURES エントリが actions.js から完全消去されていることをテストで物理確認。CI で再発防止。
- **AGENTS.md からの参照削除は本セクション 1 箇所に集約**: 本文の他箇所 (Project Overview / Key Files / Important Patterns) は撤去機能に言及しない。教訓だけは「→ §撤去済み機能と教訓」リンクで本セクションを参照する。
