# AGENTS.md

This file provides guidance to Codex when working in this repository.

## Project Overview

Vuora は Chrome / Firefox 拡張機能 (Manifest V3)。Web ブラウジングを快適にする 13 機能を提供する。

### 機能カウント早見表（単一情報源）

本文で出てくる「N 機能」「N サブ機能」「N マスタートグル」の数字はすべて以下の単一情報源を参照する。CI で drift 検知される値のみここに書く（AGENTS.md 内 drift 防止）。

| カウント名 | 値 | 単一情報源（drift 検知元） |
|---|---|---|
| 機能カテゴリ | 13 | `SettingsSchema` + `test/actions.test.js` |
| マスタートグル | 12 | popup.html の独立 toggle-row 数（`toggle-row` クラスを持つ要素数 − `toggle-row--sub` クラスを持つ要素数。内訳の実数は `rg -c` で数え直す）。カラーピッカー除く 12 機能すべてが独立マスタートグル（独自 storage key + 独立 checkbox + SettingsSchema 独立エントリを持つ）。Shorts のみ YouTube 機能拡張配下サブ機能で独立トグルを持たない |
| YouTube 機能拡張 サブ機能 | 38 | `SearchFixer.FEATURES`（内訳: 検索ノイズ除去 + Shorts 5 + 動画ページ整形 + 登録チャンネル拡張 3 + 配信時刻オーバーレイ 1 + 海外チャンネル除外 1 等） |
| Instagram クリーナー サブ機能 | 12 | `InstagramCleaner.FEATURES` |
| TikTok クリーナー サブ機能 | 3 | `TikTokCleaner.FEATURES` |
| X クリーナー サブ機能 | 10 | `XCleaner.FEATURES`（レイアウト 4 + ノイズ除去 4 + タイムライン 1 + 追加機能 1） |
| Firefox 提供機能 | 13 | 全 13 機能（音量ブースターは Firefox 専用 MES 経路 `volume-booster-mes.js`。EME_HOSTS の DRM サイトでは無効） |
| `globalThis` 公開定数 | 28 | `actions-core.js` / `actions-video.js` / `actions-loupe.js` / `actions-volume.js` / `actions.js` の合計 24 名前空間（`test/actions.test.js` の `required` 配列が単一情報源）+ ScanRunner + AudioPipeline + CleanerCore + SettingsBackup。※ `rg "globalThis\.\w+ = "` は二重ロード防止フラグ（`__cpaActionsLoaded` / `__cpaActionsCoreLoaded` / `__cpaActionsVideoLoaded` / `__cpaActionsLoupeLoaded` / `__cpaActionsVolumeLoaded` / `__cpaAudioPipelineLoaded`）も拾うので、素の grep 件数は名前空間数と一致しない |
| カラーピッカー履歴上限 | 20 件 | `ColorPicker.HISTORY_LIMIT` |
| popup タブ数 | 8 | `PopupTabs.ALL`（調整 / YouTube / X / Instagram / TikTok / Wikipedia / カラーピッカー / 設定） |
| YouTube 機能拡張 カテゴリ数 | 5 | `SearchFixer.CATEGORIES`（menu_ui / video_filter / watch_page / search_only / integration） |

### 機能一覧

利用者向けの機能一覧は [README.md](README.md)、機能別の内部構造は [references/architecture.md](references/architecture.md) を参照する。

カラーピッカーの UI を変更するときは、文言を比喩ではなく機能名で書く。旧「標本 / 標本箱 / 調色台」とアイコンのみの「写」ボタンは復活させない。

### 設計方針

- **デフォルト OFF オプトイン**: 13 機能のうち 12 機能がマスタートグル付き、**全てデフォルト OFF**（カラーピッカーは popup タブとして常時利用可）。サイト挙動を勝手に書き換えない方針。
- **独立機能ではないサブ統合**:
  - 画像ダウンロード = Instagram / TikTok / X 各クリーナーのサブ機能として共通実装（YouTube では未提供）
- **外部通信ゼロ + 6 例外（番号は `docs/privacy-policy.{md,en.md}` の見出しと一致させる。独自番号を作らない）**: すべての機能はクライアントサイド DOM/CSS 操作と Chrome 標準 API のみによる独自実装で、既定では外部通信ゼロ。
  - **例外 1: 画像ダウンロード**（Instagram / TikTok / X クリーナーのサブ機能）— クリック時のみ正規 CDN から画像を取得。X は HTTPS の `pbs.twimg.com/media/` に画像パスと `name=orig` 等の取得情報・IP アドレスが伝わる。Cookie・リファラは送信しない。fetch 4 原則は [外部 fetch allowlist 設計](references/patterns.md) を参照。
  - **例外 2: Gemini Notebook 送信** — ON 中の `https://notebooklm.google.com`（ユーザー自身の Google アカウント宛）との通信。**動画 URL とノートブック名を送るのはユーザーがボタンを押した瞬間のみ**で、対象ページで送信ボタンを出したときに行う**アカウント一覧 / ノートブック一覧の先読みは読み取りのみ**（視聴内容・動画 URL・識別子は送らない）。視聴履歴収集・バックグラウンド送信なし。詳細は [アーキテクチャ](references/architecture.md) の Gemini Notebook 送信を参照。
  - **例外 3: お問い合わせフォーム** — popup 下部からユーザーが送信したときだけ `https://support.kagayoi.com` へ入力内容と製品 ID / バージョン / ロケールを送る。閲覧 URL・ページ内容・キャプチャ画像・拡張設定は送らない。初回のメール確認と認証セッションを含む詳細は `docs/privacy-policy.{md,en.md}` を正本とする。
  - **例外 4: 設定同期** — 各PCで明示的に ON にした場合だけ、機能設定とチャンネル除外リストをブラウザ標準の `storage.sync` へ保存する。認証情報・アカウント選択・キャッシュ・採色履歴・表示位置は端末内に保持する。実装は `src/background/settings-sync.js`、仕様は `DESIGN.md` とプライバシーポリシーを参照。
  - **例外 5: YouTube の追加ページ・画像取得** — YouTube マスターと該当サブ機能が ON の場合だけ、海外チャンネル除外の `/about`、左ナビ全件表示の `/feed/channels`、登録一覧グリッドの `/@handle/videos` と必要時の `/@handle/streams` を同一オリジンの認証 Cookie 付き GET（`credentials: "same-origin"` + `redirect: "manual"`、参照元はブラウザ・ページの制御）で取得する。左ナビのアバターはページ由来の HTTP(S) URL から取得し、Cookie・参照元は通常の制御に従う。配信時刻オーバーレイはトップフレームの対象動画とプレーヤーがありキャッシュがない場合に `/watch?v=<動画ID>` を同じ GET 条件（15秒タイムアウト）で取得し、動画 ID・認証 Cookie・IP が YouTube に伝わる。配信情報または通常動画判定を動画 ID ごとに `sessionStorage` へ明示 TTL なしで保持し、配信中・失敗は保存しない。OFF でも既存保存は消さず、OFF・通常 pagehide・孤立検出・プレーヤーと新動画 ID の検出で旧取得を中止する（全 SPA 遷移での中止ではない）。グリッドの動画画像は `i.ytimg.com` へ HEAD（`credentials: "omit"` + `redirect: "manual"` + `referrerPolicy: "no-referrer"`）と通常の画像取得（`no-referrer`、Cookie はブラウザ制御）を行う。キャッシュは端末内のみ、設定同期なし。ON 条件・送信情報・キャッシュ期限・中止条件の詳細はプライバシーポリシーを参照。
  - **例外 6: Amazon 定期おトク便の金額取得** — マスター ON 時のみ、価格のない一覧内の管理 URL、登録情報、商品ページ、配送履歴・注文詳細へ同一 `https://www.amazon.co.jp` の認証 Cookie 付き読み取り GET を行う。配送・登録・履歴・注文の識別子、商品 URL と IP アドレスが Amazon に伝わる。他オリジン・リダイレクトを拒否、`no-referrer`、注文や配送の変更なし。配送価格優先、現在価格で補う場合は「参考合計（現在価格）」、現在価格も取得できない個別商品だけ配送履歴・注文詳細の当該 ASIN の前回実単価で補い「参考合計（前回価格を含む）」とする（請求額変動・クーポン未反映を注記）。将来明細の数量で計算し、注文全体・他商品価格は使わない。全明細が揃わなければ部分合計・代わりの0円は出さない。最大2同時・重複共有、ページ内メモリのみ、OFF・遷移時に中止・破棄、再読み込みで再取得。住所・支払情報は保存・ログ化・描画せず、開発者サーバーへ送信しない。
- **バージョン管理**: バージョン番号は `/vava` スキル経由でのみ更新する（コード変更コミットで `manifest.json` / `manifest.firefox.json` / `package.json` の `version` フィールドには触らない）。
- **旧呼称 drift check**: Vuora 改名前の「WEB閲覧アシスト」「Web Viewing Assist」「Web Restriction Removal Helper」が、`docs/privacy-policy.en.md` の `formerly` 表記・`docs/privacy-policy.md` の「旧称:」表記（いずれも意図的な改名履歴の明記）以外で意図せず残ってないか定期確認:
  ```bash
  rg -i "WEB閲覧アシスト|Web Viewing Assist|Web Restriction Removal Helper" -g '!node_modules' -g '!*.lock'
  ```

popup は **8 カテゴリをカスタムドロップダウンで切り替える構成** (`調整 / YouTube / X / Instagram / TikTok / Wikipedia / カラーピッカー / 設定`)。タブ順序は `PopupTabs.ALL` 配列で管理、`POPUP_LAST_TAB` storage key に最後のタブを永続化。**サブタブ（調整タブの オーディオ / 映像 / Amazon、YouTube / Instagram のカテゴリ）も `POPUP_LAST_SUBTAB`（親タブ id → サブタブ id のレコード）に永続化**する（`PopupTabs.normalizeSubTabs` で形だけ正規化し、保存済み id が現存しないときは先頭サブタブにフォールバック。1 キーに複数タブ分が相乗りするので書き戻し前に storage 現在値を再取得してマージする）。

設定は `chrome.storage.local` の各 boolean / 数値キーで保存。UI は **Chrome i18n API でローカライズ**（ブラウザ UI 言語が `ja` → 日本語 / それ以外 → 英語にフォールバック）。`manifest.json` の `default_locale: "en"` + `_locales/{en,ja}/messages.json` を単一情報源とし、popup 静的テキストは `data-i18n` 属性、popup の動的テキストと content script の DOM 注入テキストは `chrome.i18n.getMessage()` 経由で取得する。コードコメント / `console.log` メッセージは開発者向けで日本語のまま残す。**インストール直後は全マスタートグル OFF**（音量ブースターもマスター OFF かつ全サブトグル OFF = 完全に無処理）。サイト挙動を勝手に書き換えないオプトイン方針。

## Build Commands

```bash
bun run deps                     # 初回 / 開発 / CI 共通（Bun版・lock検証付き固定復元）
bun --bun run ci:install           # 同じ固定復元入口の互換名
bun --bun run build                # アイコン + スクリーンショット一括生成
bun --bun run generate-icons       # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
bun --bun run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer, concurrency=2)
bun --bun run lint                 # ESLint v10 flat config + no-implicit-globals (warn) + globalThis 定数列挙 (/rere D-004 + /opop Phase 1 で導入、v1.0.31 で Dependabot 経由 v10 化)
bun --bun run test                     # Bun の node:test 互換テスト（件数は出力サマリ `tests N` を正とする）
bun test ./test/actions.test.js                  # 単一テストファイルのみ実行 (さらに --test-name-pattern="FEATURES" で個別ケース絞り込み)
pwsh -NoProfile -File zip.ps1  # ストア申請用 ZIP (Windows、Unix は ./zip.sh)
```

Firefox 用 background の Chrome 専用ブロック除去は `scripts/strip-firefox-background.js` を正本とし、`zip.ps1` / `zip.sh` / 配布 CI で共用する。

テストファイルの担当範囲:

| ファイル | 担当 |
|---|---|
| `test/actions.test.js` | 純粋関数の境界値 + FEATURES 件数 + `globalThis` 公開名の drift 検知（詳細は Key Files 表） |
| `test/syntax-check.test.js` | `src/**/*.js` を動的列挙して classic script は `vm.Script`、HTML の module 宣言対象は Bun の `SourceTextModule()` で構文 check（content_scripts の追加・削除で手動更新が要らない） |
| `test/manifest-drift.test.js` | `manifest.json` と `manifest.firefox.json` の content_scripts 一致検証 |
| `test/audio-pipeline.test.js` | `src/lib/audio-pipeline.js` の DSP ヘルパー |
| `test/kagayoi-support.test.js` | 同梱した問い合わせ部品と popup / manifest / プライバシーポリシーの契約・正本一致検証 |
| `test/settings-backup.test.js` | 設定JSONの往復・許可リスト・型と容量の検証 |
| `test/settings-sync.test.js` | 設定同期のオプトイン・競合解決・削除伝播・再起動回復・容量超過時の保持 |
| `test/subscriptions-relevant.test.js` | 登録フィードの「関連が強い」欄だけの非表示と、OFF・SPA 遷移・DOM 再利用時の復元 |
| `test/settings-application.test.js` | popup の部分更新・同期世代と保存キュー・Chrome 音量設定の全ブーストタブ反映 |
| `test/instagram-cleaner.test.js` | コメントと本文の分離、投稿動画の再生抑止、OFF・context 失効時の復元 |
| `test/image-downloader.test.js` | TikTok の安全な挿入先、共有コンテナ内の画像別ボタン所有・URL・位置・撤去 |
| `test/instagram-video-controls.test.js` | Instagram 動画コントロールの Space 抑止・再生切替・入力除外・repeat・OFF cleanup |
| `test/actions-loading.test.js` | popup / offscreen / 両 background と各注入エントリの分割定義の読み込み順・依存閉包・再評価時の参照同一性 |
| `test/broadcast-clock-render.test.js` | 配信時刻オーバーレイの描画間引き中の最終位置の追従描画（一時停止直前の時刻を残さない）と撤去時の予約取消 |
| `test/live-chat-collapse.test.js` | ライブチャット折りたたみの再生リスト遷移後の再適用と手動再表示の維持、遷移中 OFF・失効時の解除と遅延通知の扱い |
| `test/search-fixer-blocked-channels.test.js` | チャンネル除外リストの storage 通知反映・500件上限・初期取得より新しい通知の優先 |
| `test/video-adjustments.test.js` | ガンマ補正 / 黒帯除去の OFF 時非接触・元の inline style 復元・metadata 待機の解除 |
| `scripts/Install-Dependencies.test.mjs` | `bun run deps` の固定復元入口が版不一致・lock 欠落・不正を拒否すること |
| `scripts/dependency-security.test.cjs` | deepmerge patch の prototype 汚染防止と通常 API の維持、minimatch / multimatch override・ESLint 設定経路の import patch・web-ext FileFilter の除外維持（`bun run test:dependencies` でも単独実行） |
| `test/_load-actions.js` | 上記から共有する分割定義ロード用ヘルパー。Bun の探索規則に従うため、総件数は `bun --bun run test` の出力を正とする |

### 依存パッケージの運用

- **`package.json` の overrides / trustedDependencies が依存制約とビルド許可の正本**。公開後24時間の待機と検証済み版の例外は `bunfig.toml` に置く。
- `web-ext` 配下の推移依存のセキュリティ修正は `package.json` の overrides で維持する。新規 advisory は `bun why <package>` で経路と修正版を確認する。
- `bunfig.toml` の `minimumReleaseAge = 86400` で公開後24時間の待機を維持する。検証済みの正確な版だけ `minimumReleaseAgeExcludes` に追加する。
- `@kagayoi/support-extension` は exact 固定し、`bun --bun run sync:support` で `src/shared/kagayoi-support-*` を正本から同期する。同梱コピーへ製品固有の変更を加えず、正本一致は `bun --bun run kagayoi-support-sync --check` で検証する。
- **GitHub Actions は SHA ピン + タグコメント運用**。Dependabot は SHA だけ更新して**コメントの version 表記は直さない**ので、bump PR を取り込んだら `gh api repos/<owner>/<repo>/git/matching-refs/tags` で SHA → タグを引き直してコメントを合わせる（実例: v6.0.0 表記のまま v7.0.1 へ上がっていた）。
- 依存更新の正規ルートは `/deps` スキル。バージョン番号（`manifest.json` / `package.json`）には触れない。

## Development Workflow

### Chrome に未パッケージ拡張機能をロード
1. `chrome://extensions` を開く → デベロッパーモード ON
2. 「パッケージ化されていない拡張機能を読み込む」→ プロジェクトルートを選択
3. コード変更後は拡張機能カードの 🔄 リロードボタン
4. content script 変更時は対象タブを再読込、background SW 変更時は SW 再起動が必要

### JS 構文チェック / テスト
コード変更後は以下 1 コマンドを実行（構文 check + 純粋関数テスト + drift 検知をすべて含む）:

```bash
bun --bun run test
```

内訳（担当範囲の一覧は §Build Commands のテスト表を参照）:
- `test/syntax-check.test.js` が `src/**/*.js` を**動的列挙**して構文 check する（ファイル数はハードコードしないので、content_scripts を増減しても更新不要）
- `test/actions.test.js` が `globalThis` 公開名 / FEATURES 件数 / Loupe 純粋関数 / extractHandleFromHref Unicode 境界値 / BroadcastClock 純粋関数（videoId 抽出 / liveBroadcastDetails パース / 配信時刻算出 / yyyy/MM/dd　hh:mm:ss 整形）境界値 / SettingsSchema 整合 / **EQ 定数・clamp 関数・プリセット境界値・コミュニティ 4 プリセット (eargasm/eargasmKai/perfect/perfectKai) 値固定** をアサート

Lint は ESLint v10 flat config:

```bash
bun --bun run lint
```

### デバッグ
- popup: ポップアップ右クリック →「検証」で DevTools
- background SW: `chrome://extensions` の「Service Worker」リンク
- offscreen: `chrome://inspect/#other` で `chrome-extension://<id>/src/offscreen/offscreen.html` を開く
- content script: 対象タブの DevTools Console（ログ prefix `[WebViewingAssist]`）

## Architecture

システム全体の責務・境界・データフロー・不変条件は [DESIGN.md](DESIGN.md) を設計の正本とする。機能別の実装詳細は [references/architecture.md](references/architecture.md) にあるため、**下の機能を触る前に必ず該当節を読む**。

設定キーや保存経路を変更するときは、DESIGN.md の[任意のPC間同期](DESIGN.md#任意のpc間同期)と[手動の設定バックアップ](DESIGN.md#手動の設定バックアップ)を読み、`src/background/settings-sync.js` の同期対象・競合解決単位と `src/lib/settings-backup.js` の許可リスト・既定値・検証規則を確認する。共有スクリプトの追加時は Chrome の `importScripts` と Firefox manifest の `background.scripts` の読み込み順を照合する。検証は `test/settings-sync.test.js`、`test/settings-application.test.js`、`test/settings-backup.test.js` を含む `bun --bun run test` で行う。

| 触る対象 | 読む節 |
| --- | --- |
| ポップアップ UI、設定トグル | Popup |
| Wikipedia 閲覧調整 | Wikipedia 閲覧調整 |
| Service Worker、メッセージング、設定配信 | Background |
| 音量ブースター（Chrome 経路） | Offscreen / 音量ブースター (tabCapture 経路) |
| YouTube Shorts 除去 | YouTube Shorts Removal |
| YouTube 検索・DOM 系の各種修正 | YouTube 機能拡張 |
| 動画のガンマ補正 / 黒帯除去 | 動画ガンマ補正 / 動画の黒帯除去 |
| ルーペ | ルーペ |
| Amazon 系（定期おトク便合計・ランキング移動・販売元バッジ） | Amazon 各節 |
| Instagram / TikTok / X のクリーナー | 各クリーナー節 |
| Gemini Notebook 送信 | Gemini Notebook 送信 |
| 配信時刻オーバーレイ | 配信時刻オーバーレイ |

Instagram の非表示・動画操作・画像保存を変更するときは、[DESIGN.md のサイト内 DOM と操作 UI の所有境界](DESIGN.md#サイト内-dom-と操作-ui-の所有境界)を確認する。`bun --bun run test` に加え、実ブラウザで投稿詳細・モーダル・SPA 遷移、入力中の Space、機能 OFF 時の復元を確認する。DOM fixture の成功だけで実サイトの操作性を検証済みとしない。

## Key Files

機能別のファイルと実装は [references/architecture.md](references/architecture.md)、変更時の落とし穴は [references/patterns.md](references/patterns.md) を読む。以下は横断的な入口と特に維持する境界。

- `manifest.json` / `manifest.firefox.json`: Chrome / Firefox の MV3 設定。Firefox は `offscreen` / `tabCapture` を除き、専用の `volume-booster-mes.js` を追加する。両 manifest の script 読込順を保つ。
- `src/lib/actions-core.js` / `actions-video.js` / `actions-loupe.js` / `actions-volume.js` / `actions.js`: 依存順に分割した設定・公開定数の正本。各注入エントリで共通→必要な定義を読み込み、全サイトにはサイト用定義を載せない。公開名は `test/actions.test.js` の `required` 配列で検証する。`scan-runner.js`、`cleaner-core.js`、`audio-pipeline.js` はそれぞれ走査、設定購読、音声処理を共有する。
- `src/content/early-framework.js` と各サイトの early script は、master と対象機能が明示的に ON と確認されるまで表示を変更しない。X のセレクタはロケールで変わる aria-label の文言に依存しない。
- `src/background/background.js` は送信元検証、設定配信と音量制御を担う。Chrome の音量処理は `src/offscreen/`、Firefox は `src/content/volume-booster-mes.js` を使い、DSP は共有する。Firefox の DRM 保護メディアと bypass の注意点は [音量ブースターのパターン](references/patterns.md) を読む。
- `src/shared/kagayoi-support-*` は `@kagayoi/support-extension` の exact 固定版を `bun --bun run sync:support` で逐語同期する。MV3 のためリモート JavaScript は実行せず、製品固有の配置・配色は popup 側で行う。
- `scripts/fetch-bold-woff2.mjs` は popup の Bold フォント生成用。必要時のみ `fontkit`、`subset-font`、`@ibm/plex-sans-jp@3.0.0` を導入して実行し、完了後は `bun run deps` で復元し、追加した依存を manifest と lockfile に残さない。
- `webstore/` は掲載情報と画像の生成元。popup 撮影用の生成物は Git 管理しない。`zip.ps1` / `zip.sh` はストア提出用 ZIP / XPI を生成する。
- `.amo-metadata.json` は登録済み GUID の version 提出用。未登録 GUID は Developer Hub で初回登録する。`.cws-id` は公開ストア ID でありコミット対象。
- `bunfig.toml` は依存公開後の待機と例外、`package.json` は overrides / trustedDependencies の正本。依存更新は `/deps` を使う。
- `.github/workflows/publish.yml` は検証済み成果物を CWS / AMO に提出する。公開は明示依頼時に限る。
- `memory-bank/WebRestrictionRemoval/*.md` はホスト側ファイルを直接操作せず memory-bank-mcp 経由で扱う。

## Important Patterns

新機能追加・既存機能の改修で踏むべき原則と、過去にハマった罠の対策。本文は [references/patterns.md](references/patterns.md) にある。下の目次で当たりを付けて、該当節だけを読む。

### 目次

[実装パターン](references/patterns.md) は Firefox 対応、設定配信、メッセージング、Observer、機能別の実装、外部 fetch、ロケール、テストと既知の課題を扱う。変更対象の節を読む。

### ストア掲載情報

リポジトリルートで実行する。AMO 更新は公開依頼時のみ実行し、事前に同じコマンドへ `--dry-run` を付けて入力を確認する。

```powershell
bun "$HOME/.agents/skills/vava/scripts/update-amo-listing.mjs" --slug 'web-viewing-assist' --listing 'ja=webstore/store-listing.firefox.ja.txt' --listing 'en-US=webstore/store-listing.firefox.en.txt' --privacy 'ja=docs/privacy-policy.md' --privacy 'en-US=docs/privacy-policy.en.md' --name 'ja=Vuora' --name 'en-US=Vuora' --homepage 'https://github.com/1llum1n4t1s/WebRestrictionRemoval' --support-url 'https://github.com/1llum1n4t1s/WebRestrictionRemoval/issues' --category 'other'
```

### AMO 公開のHTTP境界

公開workflowは生成した最終XPIを既存の配布物検証へ通し、SHA-256・GUID・versionを `scripts/Publish-Amo.ps1`（PowerShell 7.2 以上）へ渡す。旧web-ext sign/承認タイムアウトを成功化する手順に代えて、JWT認証・全ページの非公開listed版検査・upload検証・GUIDに対するPUT提出の受付応答まで確認する。XPIの同一snapshotをhash検証と送信に使い、保存UUIDの再利用・重複・不明な受付結果は停止する。CI成功は審査完了・ストア公開を意味しない。

### CI中間成果物

job間の検証済み成果物はprivate R2へSigV4で保存し、repository・commit・run・producer attemptのidentityと各ファイルのSHA-256/サイズを検証して復元する。設定は `vars.CLOUDFLARE_ACCOUNT_ID` / `vars.R2_ARTIFACT_BUCKET` と `secrets.R2_ARTIFACT_ACCESS_KEY_ID` / `secrets.R2_ARTIFACT_SECRET_ACCESS_KEY`。キーは当該bucket限定。`ci-artifacts/` は30日保持後にlifecycleで削除され、恒久配布とは区別する。

CWSは `scripts/Publish-Cws.ps1`（PowerShell 7、API v2）を使う。既存OAuth secretsとpublisher/item IDを維持し、同期upload成功・応答ID・manifest版の一致を確認してpublishする。非同期uploadは版を確定できないため自動publishせず停止する。公開workflowはrepository単位の `queue: max` で最大100件まで直列化し、Dashboardや他の手動公開と並行しない。

## Bun依存の脆弱性検出

依存の固定復元は `bun run deps` を使う。lock欠落・破損を拒否し、`[run] bun=true` 経由で依存のpostinstallまでBunで実行する。Node.jsがあるPCでも通常の `bun install` を直接使う経路へ戻さない。

依存更新は通常のDependabot PRで受け、Dependency validationで検証する。ローカルの `bun audit` でlock全体を監査できる。依存の自動修正・自動マージは行わない。


### 依存の暫定セキュリティ修正

minimatch は 11.0.4 以降、multimatch は named import 対応の 8 系へ override する。node-forge は web-ext → @devicefarmer/adbkit@3 の指定（`^1.3.1`）では 1.4.3 を許容するが、bun.lock の adbkit 依存記録が 1.4.2 のままで `bun audit fix` でも上がらないため、Forge の TLS・Ed25519・ReDoS 修正を含む 1.4.3 を下限として override する（override なしで lock が 1.4.3 以上へ解決されるようになった時点で撤去する）。ESLint 設定の ESM 経路は @eslint/eslintrc@3.3.7 と @eslint/config-array@0.21.2 の最小 import patch で互換性を保つ。web-ext@10.8.0 の FileFilter は Windows で windowsPathsNoEscape を明示し、開発用ファイルやアーカイブの除外を維持する。

CVE-2026-93753（GHSA-gcqx-w48m-w2h4）の deepmerge 4.3.1 は公式修正版が未公開のため、patches/deepmerge@4.3.1.patch で戻り値への書込みを own データ属性にし、__proto__ 経由の prototype 汚染を防ぐ。bun run test:dependencies で web-ext → addons-linter の実解決先の攻撃入力と通常 API を検証する。Bun 標準の patchedDependencies で適用し、公式修正版の採用時に patch の要否を再確認する。バージョンベースの bun audit 警告は残るため、警告を除外したり成功扱いにしない。
