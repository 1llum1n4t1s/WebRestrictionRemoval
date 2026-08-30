# AGENTS.md

This file provides guidance to Codex when working in this repository.

## Project Overview

Vuora は Chrome 拡張機能 (Manifest V3)。Web ブラウジングを快適にする 12 機能を提供する。

### 機能カウント早見表（単一情報源）

本文で出てくる「N 機能」「N サブ機能」「N マスタートグル」の数字はすべて以下の単一情報源を参照する。CI で drift 検知される値のみここに書く（AGENTS.md 内 drift 防止）。

| カウント名 | 値 | 単一情報源（drift 検知元） |
|---|---|---|
| 機能カテゴリ | 12 | `SettingsSchema` + `test/actions.test.js` |
| マスタートグル | 11 | popup.html の独立 toggle-row 数（`class="toggle-row"` の総数 − `toggle-row--sub` の数。内訳の実数は `rg -c` で数え直す）。カラーピッカー除く 11 機能すべてが独立マスタートグル（独自 storage key + 独立 checkbox + SettingsSchema 独立エントリを持つ）。Shorts のみ YouTube 機能拡張配下サブ機能で独立トグルを持たない |
| YouTube 機能拡張 サブ機能 | 34 | `SearchFixer.FEATURES`（内訳: 検索ノイズ除去 + Shorts 5 + 動画ページ整形 + 登録チャンネル拡張 3 + 接続モニター 1 + 配信時刻オーバーレイ 1 + 海外チャンネル除外 1 等） |
| Instagram クリーナー サブ機能 | 11 | `InstagramCleaner.FEATURES` |
| TikTok クリーナー サブ機能 | 3 | `TikTokCleaner.FEATURES` |
| X クリーナー サブ機能 | 9 | `XCleaner.FEATURES`（レイアウト 4 + ノイズ除去 4 + タイムライン 1） |
| Firefox 提供機能 | 12 | 全 12 機能（音量ブースターは Firefox 専用 MES 経路 `volume-booster-mes.js`。EME_HOSTS の DRM サイトでは無効） |
| `globalThis` 公開定数 | 27 | `actions.js` の 24 名前空間（`test/actions.test.js` の `required` 配列が単一情報源）+ ScanRunner + AudioPipeline + CleanerCore。※ `rg "globalThis\.\w+ = "` は二重ロード防止フラグ（`__cpaActionsLoaded` / `__cpaAudioPipelineLoaded`）も拾うので、素の grep 件数は名前空間数と一致しない |
| カラーピッカー履歴上限 | 20 件 | `ColorPicker.HISTORY_LIMIT` |
| popup タブ数 | 6 | `PopupTabs.ALL`（調整 / YouTube / X / Instagram / TikTok / カラーピッカー） |
| YouTube 機能拡張 カテゴリ数 | 5 | `SearchFixer.CATEGORIES`（menu_ui / video_filter / watch_page / search_only / integration） |

### 機能一覧

1. **YouTube 機能拡張** — Shorts 削除・コメント欄非表示・ライブチャット非表示・登録チャンネル拡張・接続モニター・配信時刻オーバーレイ（配信アーカイブに配信時刻を重ねる）・海外チャンネル除外・Gemini Notebook 送信を含む 34 サブ機能
2. **Amazon 定期おトク便 月別合計**
3. **Amazon ランキングへ移動ボタン** — 商品詳細欄の売れ筋リンクを商品情報最上部に集約、一番細かいサブカテゴリへ同タブ移動
4. **Amazon 販売元・出荷元バッジ** — 緑（Amazon 直販）/ オレンジ（マーケット出品）の視覚区別、判定は `isInternal` JSON フラグ最優先
5. **Instagram クリーナー** — 11 サブ機能
6. **TikTok クリーナー** — 3 サブ機能（コメント欄非表示 / おすすめアカウント非表示 / 画像ダウンロード）
7. **X クリーナー** — 9 サブ機能（右ペイン / トレンド / おすすめユーザー / メッセージドック / 広告投稿 / プレミアム勧誘 / Grok / 反応数を非表示 + ホームを「フォロー中」で開く）
8. **音量ブースター** — 自動歪み防止 / ナイトモード / 壁ドン対策モード（低音カット） / ミュートトグル + **10 バンドグラフィックイコライザ (プリアンプ + プリセット)**、設定グローバル永続化、タブ切替で自動適用。Chrome = tabCapture 経路 / Firefox = 専用 MES 経路（DRM サイト除く）の per-browser 2 実装
9. **動画ガンマ補正** — SVG `<feComponentTransfer type="gamma">` 独自実装、全タブ共通スライダー
10. **動画の黒帯除去** — ウルトラワイド画面で動画の上下/左右の黒帯をズーム/引き伸ばしで除去、動画縦横比は自動検出
11. **ルーペ** — `chrome.tabs.captureVisibleTab` で取得した JPEG 静止画を `background-position` で追従表示、倍率 3 段階 / サイズ可変
12. **カラーピッカー** — EyeDropper API ベース、popup 内完結。HEX / RGB / HSL の値欄は編集可能で、拾ってきたカラーコードを貼り付けると即プレビュー（Enter で履歴に確定）。貼り付けた色は「色を調整」（鮮やかさ×明るさの 2D エリア + 色あいスライダー）でそのまま微調整できる。UI 文言は比喩を使わず機能名で書く（旧「標本 / 標本箱 / 調色台」とアイコンのみの「写」ボタンは何をするか伝わらず撤去済み。**復活禁止**）

### 設計方針

- **デフォルト OFF オプトイン**: 12 機能のうち 11 機能がマスタートグル付き、**全てデフォルト OFF**（カラーピッカーは popup タブとして常時利用可）。サイト挙動を勝手に書き換えない方針。
- **独立機能ではないサブ統合**:
  - 接続モニター = YouTube 機能拡張のサブ機能 `connectionMonitor`（master `searchFixerEnabled` AND で制御）
  - 画像ダウンロード = Instagram / TikTok 各クリーナーのサブ機能として共通実装（YouTube では未提供）
- **外部通信ゼロ + 4 例外（番号は `docs/privacy-policy.{md,en.md}` の見出しと一致させる。独自番号を作らない）**: すべての機能はクライアントサイド DOM/CSS 操作と Chrome 標準 API のみによる独自実装で、既定では外部通信ゼロ。
  - **例外 1: 画像ダウンロード**（Instagram / TikTok クリーナーのサブ機能）— CDN からの**取得のみ**でユーザーデータの送信はゼロ。fetch 4 原則は §外部 fetch allowlist 設計。
  - **例外 2: 接続モニター** — ON 中の YouTube ライブ視聴時のみ 5 秒周期で `https://www.gstatic.com/generate_204` と `https://speed.cloudflare.com/__down?bytes=10` への RTT 計測 fetch（`mode: "no-cors"` + `credentials: "omit"` + `referrerPolicy: "no-referrer"`、レスポンス本文は破棄、識別子・cookie・ユーザーデータは送信せず）。
  - **例外 3: Gemini Notebook 送信** — ON 中の `https://notebooklm.google.com`（ユーザー自身の Google アカウント宛）との通信。**動画 URL とノートブック名を送るのはユーザーがボタンを押した瞬間のみ**で、対象ページで送信ボタンを出したときに行う**アカウント一覧 / ノートブック一覧の先読みは読み取りのみ**（視聴内容・動画 URL・識別子は送らない）。視聴履歴収集・バックグラウンド送信なし。詳細は §Gemini Notebook 送信。
  - **例外 4: お問い合わせフォーム** — popup 下部からユーザーが送信したときだけ `https://support.kagayoi.com` へ入力内容と製品 ID / バージョン / ロケールを送る。閲覧 URL・ページ内容・キャプチャ画像・拡張設定は送らない。初回のメール確認と認証セッションを含む詳細は `docs/privacy-policy.{md,en.md}` を正本とする。
- **バージョン管理**: バージョン番号は `/vava` スキル経由でのみ更新する（コード変更コミットで `manifest.json` / `package.json` / `pnpm-lock.yaml` の version フィールドには触らない）。
- **旧呼称 drift check**: Vuora 改名前の「WEB閲覧アシスト」「Web Viewing Assist」「Web Restriction Removal Helper」が、`docs/privacy-policy.en.md` の `formerly` 表記・`docs/privacy-policy.md` の「旧称:」表記（いずれも意図的な改名履歴の明記）以外で意図せず残ってないか定期確認:
  ```bash
  rg -i "WEB閲覧アシスト|Web Viewing Assist|Web Restriction Removal Helper" -g '!node_modules' -g '!*.lock'
  ```

popup は **6 タブ構成** (`調整 / YouTube / X / Instagram / TikTok / カラーピッカー`)。タブ順序は `PopupTabs.ALL` 配列で管理、`POPUP_LAST_TAB` storage key に最後のタブを永続化。**サブタブ（調整タブの オーディオ / 映像 / Amazon、YouTube / Instagram のカテゴリ）も `POPUP_LAST_SUBTAB`（親タブ id → サブタブ id のレコード）に永続化**する（`PopupTabs.normalizeSubTabs` で形だけ正規化し、保存済み id が現存しないときは先頭サブタブにフォールバック。1 キーに複数タブ分が相乗りするので書き戻し前に storage 現在値を再取得してマージする）。

設定は `chrome.storage.local` の各 boolean / 数値キーで保存。UI は **Chrome i18n API でローカライズ**（ブラウザ UI 言語が `ja` → 日本語 / それ以外 → 英語にフォールバック）。`manifest.json` の `default_locale: "en"` + `_locales/{en,ja}/messages.json` を単一情報源とし、popup 静的テキストは `data-i18n` 属性、popup の動的テキストと content script の DOM 注入テキストは `chrome.i18n.getMessage()` 経由で取得する。コードコメント / `console.log` メッセージは開発者向けで日本語のまま残す。**インストール直後は全マスタートグル OFF**（音量ブースターもマスター OFF かつ全サブトグル OFF = 完全に無処理）。サイト挙動を勝手に書き換えないオプトイン方針。バージョン番号は `/vava` スキル経由でのみ更新する。

## Build Commands

```bash
pnpm install                  # 初回 / 開発用
pnpm run ci:install           # CI 用 (pnpm install --frozen-lockfile。lockfile 厳守)
pnpm run build                # アイコン + スクリーンショット一括生成
pnpm run generate-icons       # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
pnpm run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer, concurrency=2)
pnpm run lint                 # ESLint v10 flat config + no-implicit-globals (warn) + globalThis 定数列挙 (/rere D-004 + /opop Phase 1 で導入、v1.0.31 で Dependabot 経由 v10 化)
pnpm test                     # Node.js 標準 test runner（件数は出力サマリ `# tests N` を正とする）
node --test test/actions.test.js                  # 単一テストファイルのみ実行 (さらに --test-name-pattern="FEATURES" で個別ケース絞り込み)
pwsh -NoProfile -File zip.ps1  # ストア申請用 ZIP (Windows、Unix は ./zip.sh)
```

テストファイルの担当範囲:

| ファイル | 担当 |
|---|---|
| `test/actions.test.js` | 純粋関数の境界値 + FEATURES 件数 + `globalThis` 公開名の drift 検知（詳細は Key Files 表） |
| `test/syntax-check.test.js` | `src/**/*.js` を動的列挙して `vm.compileFunction` で構文 check（content_scripts の追加・削除で手動更新が要らない） |
| `test/manifest-drift.test.js` | `manifest.json` と `manifest.firefox.json` の content_scripts 一致検証 |
| `test/audio-pipeline.test.js` | `src/lib/audio-pipeline.js` の DSP ヘルパー |
| `test/kagayoi-support.test.js` | 同梱した問い合わせ部品と popup / manifest / プライバシーポリシーの契約・正本一致検証 |
| `test/_load-actions.js` | 上記から共有する actions.js ロード用ヘルパー。Node.js の自動探索対象にもなるため、総件数は `pnpm test` の出力を正とする |

### 依存パッケージの運用

- **`pnpm-workspace.yaml` が overrides / allowBuilds の正本**（`package.json` の `pnpm.overrides` ではない）。transitive 脆弱性は「脆弱範囲だけに効く versioned selector」で固定し、blast radius を最小化する。
- `web-ext > addons-linter` 系の transitive 脆弱性は `pnpm-workspace.yaml` の versioned `overrides` で固定する。現時点の `pnpm audit` には、修正版が未公開の `image-size <=2.0.2` が同経路で 2 件残る。新規 advisory は `pnpm why <package>` で経路と修正版の有無を確認してから、互換性を保てる最小範囲だけ override する。
- **`minimumReleaseAgeExclude` は pnpm v11 が自動追記する**（公開直後の版を一定期間使わない供給網ガードの例外記録）。pnpm 11.7.0 では同一 package の複数 exact version を別行にすると除外が不安定なため、同一 package 分だけ `package@version1 || version2` の 1 selector に統合する（pnpm issue #12463 の回避形式）。
- `kagayoi-support-extension` は exact 固定し、`pnpm sync:support` で `src/shared/kagayoi-support-*` を正本から同期する。同梱コピーへ製品固有の変更を加えず、正本一致は `pnpm exec kagayoi-support-sync --check` で検証する。
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
pnpm test
```

内訳（担当範囲の一覧は §Build Commands のテスト表を参照）:
- `test/syntax-check.test.js` が `src/**/*.js` を**動的列挙**して構文 check する（ファイル数はハードコードしないので、content_scripts を増減しても更新不要）
- `test/actions.test.js` が `globalThis` 公開名 / FEATURES 件数 / Loupe 純粋関数 / extractHandleFromHref Unicode 境界値 / BroadcastClock 純粋関数（videoId 抽出 / liveBroadcastDetails パース / 配信時刻算出 / yyyy/MM/dd　hh:mm:ss 整形）境界値 / SettingsSchema 整合 / **撤去済み機能 drift 検知（自動音量正規化を含む）** / **EQ 定数・clamp 関数・プリセット境界値・コミュニティ 4 プリセット (eargasm/eargasmKai/perfect/perfectKai) 値固定** をアサート

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

システム全体の責務・境界・データフロー・不変条件は [DESIGN.md](DESIGN.md) を設計の正本とする。機能別の実装詳細は [references/architecture.md](references/architecture.md) にあるため、**下の機能を触る前に必ず該当節を読む**。

| 触る対象 | 読む節 |
| --- | --- |
| ポップアップ UI、設定トグル | Popup |
| Service Worker、メッセージング、設定配信 | Background |
| 音量ブースター（Chrome 経路） | Offscreen / 音量ブースター (tabCapture 経路) |
| YouTube Shorts 除去 | YouTube Shorts Removal |
| YouTube 検索・DOM 系の各種修正 | YouTube 機能拡張 |
| 動画のガンマ補正 / 黒帯除去 | 動画ガンマ補正 / 動画の黒帯除去 |
| ルーペ | ルーペ |
| Amazon 系（定期おトク便合計・ランキング移動・販売元バッジ） | Amazon 各節 |
| Instagram / TikTok / X のクリーナー | 各クリーナー節 |
| 接続モニター | 接続モニター |
| Gemini Notebook 送信 | Gemini Notebook 送信 |
| 配信時刻オーバーレイ | 配信時刻オーバーレイ |

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 設定; permissions: `activeTab`, `storage`, `offscreen`, `tabCapture` + host_permissions: `<all_urls>` (ルーペ `captureVisibleTab` を popup close 後 / SPA navigation 後でも確実に動作させるため、v1.0.34 で追加。content_scripts で既に全 http(s) に注入済みなので実質アクセス範囲は同じ) |
| `src/lib/actions.js` | `Object.freeze` された 24 個の定数を IIFE wrap + globalThis 公開: SettingsSchema / Actions / ExtensionPaths / SenderCheck / Offscreen / StorageKeys / YouTubeShorts / SearchFixer / AmazonDeliveryTotal / AmazonRankingJump / AmazonMerchantInfo / InstagramCleaner / TikTokCleaner / XCleaner / ImageDownloader / VolumeBooster / VideoGamma / VideoFill / Loupe / ConnectionMonitor / BroadcastClock / NotebookLm（Gemini Notebook 送信）/ ColorPicker / PopupTabs。件数と名前の単一情報源は `test/actions.test.js` の `required` 配列 |
| `src/lib/scan-runner.js` | content script 共通実行ランタイム (`/rere` B1-007/B2-I002/D-002 で抽出)。rAF coalesce + MutationObserver `disconnect → render → takeRecords → observe` ガード + Extension context invalidation guard を `ScanRunner.create({ render, cleanup })` に集約し `globalThis.ScanRunner` 公開。Amazon 3-cs (delivery-total / ranking-jump / merchant-info) が利用 (image-downloader / youtube-shorts は別バッチで移行予定)。cleanup は idempotent 必須。context invalidation 後でも throw しない i18n 取得 `ScanRunner.safeMsg(key, fallback)` も公開し Amazon 3-cs の重複ヘルパー (ranking-jump / merchant-info の同型コピー + delivery-total のインライン) を統合 (/opop) |
| `src/lib/audio-pipeline.js` | 音量ブースター DSP コア共有モジュール (`/rere` B1-004/B2-I001/D-001 で抽出)。`dbToGain` / `applyCompressorPreset` / `applyFilterPreset` / `createBassCutChain` / `applyEqualizer` / `createEqChain` / `connectAudioGraph` の 7 関数を `globalThis.AudioPipeline` 公開。`createBassCutChain(ctx)` は highpass BiquadFilterNode × 2 を直列接続した `{bassCutNodes, head, tail}`、`createEqChain(ctx)` は preampNode + 10 バンド peaking BiquadFilterNode を直列接続した `{head, tail, preampNode, eqFilters}` を返す。`connectAudioGraph` は Chrome / Firefox 共通の最上位 DSP 接続順を固定する。`applyEqualizer` は preampNode の dB→gain 倍率変換と eqFilters[10] の peaking gain を ramp 更新し、`applyFilterPreset` は壁ドン対策 highpass 2 段の frequency/Q を一括設定する。caller は offscreen.js (Chrome tabCapture 経路) + volume-booster-mes.js (Firefox 専用 MES 経路、2026-07-02 復活) の 2 つ。値定数は actions.js の VolumeBooster 経由 |
| `src/lib/cleaner-core.js` | body-class クリーナーの設定購読共通ランタイム (/opop で抽出)。master + features 2 キーの購読 3 経路 (初期 storage.get / runtime.onMessage gate / storage.onChanged 部分更新) を `CleanerCore.subscribe({ masterKey, featuresKey, applyAction, mergeFeatures, onUpdate })` に集約し `globalThis.CleanerCore` 公開。Instagram / TikTok クリーナーが利用。active/features 保持と applyBodyClasses/固有ロジック (Instagram の DOM スイープ・URL guard 等) は各 cs に残す最小責務分離 (early-framework.js / scan-runner.js と同じ思想で config 肥大化を回避)。onUpdate(patch) は変わったキーだけ通知し各 cs が部分適用 (片方キーのみ変化時の undefined 上書き罠を回避) |
| `src/background/background.js` | Service worker: sender 検証付きメッセージ転送、設定マイグレーション、offscreen document 管理、音量ブースター制御 (tabCapture 経路一本、全サイト一律) |
| `src/content/early-framework.js` | document_start early script 共通フレームワーク。`<style>` 注入 / pre クラス同期付与 / `storage.local.get` / `storage.onChanged` 購読を `window.__cpaEarlyFramework.setup(config)` に集約。各 early エントリで先頭ロード、actions.js には依存しない |
| `src/content/youtube-early.js` | YouTube watch ページ向け `document_start` 注入の最小スクリプト。hideLiveChat ON 時に `<html>` へ `__cpa-sfx-hide-live-chat-pre` クラスを最速付与し、ライブチャット枠の体感ラグを消す。early-framework.js 経由でボイラープレート共通化、サイト固有の MutationObserver / force-hide のみ独自実装 |
| `src/content/youtube-shorts.{js,css}` | YouTube 機能拡張の Shorts 5 サブ機能（Shelf / Chip / Sidebar / Redirect / Btn、top frame のみ）: MutationObserver + URL リダイレクト + 機能ごとの `__cpa-yt-shorts-hide-{shelf,chip,sidebar}` / `__cpa-yt-shorts-redirect-active` クラスで `display: none` |
| `src/content/search-fixer.{js,css}` | YouTube 機能拡張（34 機能 = 検索結果ノイズ除去・Shorts 5 サブ機能・動画ページ整形・グリッド列数・ホーム/フィードのグリッド整列・登録チャンネル拡張 3 機能・接続モニター 1 機能・配信時刻オーバーレイ 1 機能を含む）: master + features + gridItems で駆動、`/feed/channels` グリッド化 / leftnav 全件展開 / すべての登録チャンネルショートカットを含む。接続モニターの実装は専用 content script `youtube-connection-monitor.js`（search-fixer.js 自体は担当しない） |
| `src/content/amazon-delivery-total.{js,css}` | Amazon 定期おトク便ページ: 月別合計を rAF coalesce + observer guard 駆動で挿入 + `__cpa-amzn-delivery-total` 配色 |
| `src/content/instagram-early.js` | Instagram 向け `document_start` 注入の最小スクリプト。hideComments ON 時に `<html>` へ `__cpa-ig-comments-pre` クラスを最速付与し、`div:has(> ul._a9ym)`（各コメント UL の親 div）を CSS rule + MutationObserver inline force-hide で先制非表示にする。`_a9z6`（外側 UL）には post caption が同居しているので触らず、`_a9ym` 親 div だけを対象にして caption 巻き込み防止（actions.js は読み込まない） |
| `src/content/instagram-cleaner.{js,css}` | Instagram クリーナー: master + features で body クラス駆動、URL リダイレクト + DOM スイープ + 意味論的セレクタのみ（aria-label / href / role / data-pagelet / SVG path data） |
| `src/content/tiktok-early.js` | TikTok 用 `document_start` 注入の最小スクリプト。`tiktokCleanerEnabled` + `tiktokCleanerFeatures` を読んで `<html>` に `__cpa-tt-comments` / `__cpa-tt-suggested` 同期付与 + inline `<style>` で主要セレクタ焼き込み（FOUC 防止、actions.js 非依存） |
| `src/content/tiktok-cleaner.{js,css}` | TikTok クリーナー: master + features で body クラス駆動、CSS-only 実装（DOM スイープ / URL リダイレクト不要）。photo / video 用 `[class*="RightPanelContainer"]` + modal viewer 用 `[class*="DivCommentListContainer"]` の 2 系統セレクタ併用 |
| `src/content/x-early.js` | X 用 `document_start` 注入の最小スクリプト。`xCleanerEnabled` + `xCleanerFeatures` を読んで `<html>` に `__cpa-x-right-pane` / `__cpa-x-trends` / `__cpa-x-who-to-follow` を同期付与 + inline `<style>` で焼き込み（**レイアウトが動く 3 機能のみ**。FOUC 防止、actions.js 非依存） |
| `src/content/x-cleaner.{js,css}` | X（旧 Twitter）クリーナー: master + features で `<html>` クラス駆動、9 サブ機能（レイアウト 4 / ノイズ除去 4 / タイムライン 1）。**セレクタは `data-testid` + `:has()` の構造マッチのみで `aria-label` の文言に依存しない**（X の aria-label はロケールで変わる）。`followingTabDefault` だけ JS 実装で、ホームのタブを**位置**（index 0 = おすすめ / 1 = フォロー中）で特定し 1 ページ表示につき 1 回だけクリックする |
| `src/content/amazon-ranking-jump.{js,css}` | Amazon ランキングへ移動ボタン: `*://www.amazon.co.jp/*` の top frame に注入、商品詳細欄の売れ筋ランキングリンクから「一番細かいサブカテゴリ」を選んで商品情報最上部に集約ボタン (`<a href>`) を挿入、同じタブで移動。商品ページで自己ゲート、rAF coalesce + observer guard、外部送信ゼロ |
| `src/content/amazon-merchant-info.{js,css}` | Amazon 販売元・出荷元バッジ: `*://www.amazon.co.jp/*` の top frame に注入、隠し div (`#merchantInfoFeature_feature_div` / `#fulfillerInfoFeature_feature_div`) から販売元・出荷元を抽出し、「📦 販売: XXX / 出荷: YYY」を商品情報最上部 (ランキングボタンの隣) に **クリック不可の情報バッジ** (`<span>` ベース) で表示。**Amazon 直販 = 緑 / マーケット出品 = オレンジ警告** で視覚区別 (`data-variant` 属性で CSS 切替)。直販判定は `AmazonMerchantInfo.parseIsInternal` で script 埋め込み JSON の `isInternal` フラグを最優先、欠落時は `isAmazonOwnedName` の販売元名フォールバック (両純粋関数とも境界値テスト可能化)。商品ページで自己ゲート、rAF coalesce + observer guard + context invalidation guard、外部送信ゼロ |
| `src/content/video-gamma.js` | 動画ガンマ補正: 全 http(s) + iframe に注入、SVG `<feComponentTransfer type="gamma">` を `<body>` に inject。**v1.0.41 で video-fill と同型 lifecycle に統一**: 旧 CSS rule 一斉注入 → **per-video inline `style.setProperty("filter", "url(#...)", "important")` + `loadedmetadata` 待ち + WeakMap original + AbortController + MutationObserver で detach 即 revert**。動機: 旧設計が video element の readyState 関係なく filter 当てるため DRM player の session 取得中に attestation 干渉する理論的リスクを構造的に排除 |
| `src/content/video-fill.js` | 動画の黒帯除去 (ワイド表示): 全 http(s) + iframe に注入 (video-gamma と同 manifest エントリ)。`videoFillEnabled` (master) + `videoFillMode` (`zoom`/`stretch`) + `videoFillTarget` (モニター aspect preset) の 3 storage key。設定はモニター aspect のみ、動画側 aspect は `videoWidth`/`videoHeight` から要素ごとに自動検出して `VideoFill.computeTransform` で拡大率算出。`!important` inline transform で site stylesheet にも勝つ。`loadedmetadata` 待機 + MutationObserver(subtree) で遅延 video 追従 + Extension context invalidation guard で orphan 化対応。元 inline transform は WeakMap に退避し撤去時復元 |
| `src/content/loupe.{js,css}` | ルーペ機能: 全 http(s) の top frame に注入、`chrome.tabs.captureVisibleTab` で取得した JPEG 静止画を `position: fixed` 円形レンズに `background-image` で貼り、mousemove で `background-position` を rAF コアレス 60fps 更新。再キャプチャ trigger は初回 / scroll (500ms debounced) / MutationObserver(childList, subtree:false) / resize。Blob URL に変換して `<img>`/`background-image` で参照し cleanup 時に `URL.revokeObjectURL` で確実に解放 |
| `src/content/youtube-connection-monitor.{js,css}` | 接続モニター（**YouTube 機能拡張のサブ機能** `searchFixerFeatures.connectionMonitor`、master `searchFixerEnabled` AND で制御。独立 storage key なし・`APPLY_SEARCH_FIXER_CS` を search-fixer.js / youtube-shorts.js と共に購読・`computeActive()` 判定）: `*://*.youtube.com/*` の top frame に注入 (`document_idle`)。`isLiveVideo()` の DOM シグナル判定（`.ytp-time-display.ytp-live` クラス OR `.ytp-live-badge` 可視 OR `duration === Infinity`。DVR ライブは duration が有限で伸びるため duration 単独では不可・実機較正済み）+ `isLiveTrackedVideo` sticky フラグ（trackedVideo identity 同一中はライブ判定維持で「DOM 一瞬ブレで overlay 消滅」防止）でライブ配信のみ対象。**HUD は 2 段構成: コンパクト = verdict + metric 1 行常時、▼ 展開 = 経路 RTT 個別 + 直近バッファ履歴 + 帯域 60 秒統計（dropped frames は端末対処不能のため非表示）**。1s 周期で `navigator.connection.downlink/rtt` + `getVideoPlaybackQuality().droppedVideoFrames` を 30 サンプル ring buffer に蓄積、5s 周期で `https://www.gstatic.com/generate_204` + `https://speed.cloudflare.com/__down?bytes=10` への RTT 計測 (`mode:"no-cors"` + `credentials:"omit"` + `referrerPolicy:"no-referrer"` + `AbortSignal.any([cancel, AbortSignal.timeout(4500)])`)、純粋関数 `ConnectionMonitor.classify` で 7 分類 (stable / network / device / youtube_cdn / routing / international / unknown)。in-player 右上に ROG クリムゾン HUD、ドラッグ + 折りたたみ可能、`localStorage` に位置 / 折りたたみ状態永続化、`:fullscreen` 追従。`applyInFlight`/`applyQueued` で設定購読を直列化、context invalidation guard で orphan 化時に全 timer + observer + overlay 撤去。`createElement` ベースで Trusted Types 安全。endpoint URL は `actions.js` 定数 + `test/actions.test.js` で値固定アサート。**接続モニターのみ外部 fetch あり** (それ以外の機能はすべて外部送信ゼロ) |
| `src/content/youtube-notebooklm.{js,css}` | Gemini Notebook 送信（**YouTube 機能拡張のサブ機能** `searchFixerFeatures.notebookLmSend`、`integration` カテゴリ。master `searchFixerEnabled` AND で制御・`APPLY_SEARCH_FIXER_CS` を購読・**接続モニター / 配信時刻オーバーレイと同じ content_scripts エントリに相乗り**）: `*://*.youtube.com/*` の top frame に注入。**YouTube のページ内**（`/watch` は高評価・共有の行、`/results` は検索フィルタの隣、`/playlist` とチャンネルはタイトル見出しの行 — 参考拡張と同じ配置）にボタンを挿し込み、body 直下 fixed のノートブック選択ポップオーバーで、視聴中の動画 (`/watch`) / 検索結果 (`/results`) / プレイリスト (`/playlist`) / チャンネル (`/videos` `/streams`) の動画を Gemini Notebook にソース追加する。cross-origin RPC は background が担当（`NOTEBOOK_LM_LIST` / `NOTEBOOK_LM_SEND`、`host_permissions: <all_urls>` は既存のため権限追加なし）。プロトコル純粋関数は actions.js の `NotebookLm`（`extractToken` / `parseBatchPayload` / `parseNotebookList` / `extractNotebookId` / `buildSourcePayload` / `isYouTubeUrl` / `normalizeWatchUrl`、RPC ID 値固定を含め `test/actions.test.js` でアサート）。**外部送信の例外機能**（ユーザーのボタン操作時のみ、動画 URL とノートブック名を送信） |
| `src/content/youtube-broadcast-clock.{js,css}` | 配信時刻オーバーレイ（**YouTube 機能拡張のサブ機能** `searchFixerFeatures.broadcastClock`、master `searchFixerEnabled` AND で制御。独立 storage key なし・`APPLY_SEARCH_FIXER_CS` を search-fixer.js / youtube-shorts.js / youtube-connection-monitor.js と共に購読・`computeActive()` 判定。**接続モニターと同じ content_scripts エントリに相乗り**）: `*://*.youtube.com/*` の top frame に注入。ライブ配信アーカイブ（`liveBroadcastDetails` を持ち `isLiveNow !== true`）の再生中に、その瞬間の実配信時刻を `yyyy/MM/dd　hh:mm:ss`（全桁ゼロ埋め・全角スペース・24 時間制・ローカル）で HUD 表示する（body 直下 `position:fixed`、初期位置はプレーヤー左上付近、ドラッグで動画の外側を含む任意位置へ移動可）。配信開始時刻は `/watch?v=<id>` の **same-origin fetch**（`credentials:"same-origin"` + `redirect:"manual"`、search-fixer.js と同型・**外部送信ゼロ維持**）で HTML から `BroadcastClock.parseLiveBroadcastDetails` 抽出 → videoId 単位 sessionStorage cache。`配信時刻 = startTimestamp + currentTime` を `BroadcastClock.computeBroadcastEpochMs` / `formatTimestamp` で算出・整形（純粋関数、`test/actions.test.js` で境界値テスト）。`timeupdate`/`seeked` 駆動 + 250ms throttle、ドラッグ移動可（viewport 座標を localStorage 永続化 + resize/フルスクリーンで clamp）、フルスクリーンは `fullscreenchange` で `document.fullscreenElement` へ reparent 追従、context invalidation guard |
| `src/content/image-downloader.{js,css}` | 画像ダウンロード（Instagram / TikTok 共通、YouTube は未提供）: 各クリーナー features の `imageDownload` ON 時に動作。site adapter で各サイトのコンテンツ画像（投稿写真 / 動画サムネ）を判定 → hover で左上に DL ボタン overlay → クリックで `<a download>` + Blob URL 経由で保存。最大解像度 URL 取得 / URL ホワイトリスト ALLOWED_HOSTS / fetch セキュリティ 4 原則 / sibling overlay 検出による host 1 階層上昇 / SCANNED マーカー src 値ベース。`__cpa-img-dl-` クラスプレフィックス。 |
| `src/popup/popup.{html,js,css}` | ポップアップ UI: 6 タブ構成（調整 / YouTube / X / Instagram / TikTok / カラーピッカー）。調整タブは **11 マスタートグル** + 音量スライダー（左端 🔊/🔇 ミュートボタン）+ 音量サブトグル × 3（自動歪み防止 / ナイトモード / 壁ドン対策モード）+ **イコライザパネル（オン/オフ + プリセット + プリアンプ + 10 バンド縦スライダー、EQ_BANDS 駆動で動的生成）** + 動画ガンマスライダー + ルーペ master + 倍率セグメント + サイズスライダー、YouTube タブは 34 機能リスト（接続モニター・配信時刻オーバーレイは `watch_page` カテゴリのサブ機能として FEATURES 駆動で自動描画）、各クリーナータブは独立パネル（FEATURES 配列駆動の動的レンダリング、1 行 1 トグル + 説明文）、カラーピッカータブは上から **現在の色 → 色を調整 → 履歴 → コピーの設定** の 4 セクション（操作が上、設定が下）。EyeDropper 採取 + HEX/RGB/HSL の**編集可能な値欄**（貼り付けで即プレビュー・Enter で履歴保存、解釈は `ColorPicker.parseColorInput`、各行に文字ラベル付きコピーボタン）+ **色を調整**（鮮やかさ×明るさの 2D エリア + 色あいスライダー。座標変換は `ColorPicker.rgbToHsv` / `hsvToRgb` / `hexToPaletteHsv`、CSS グラデ 2 枚重ねで canvas 不使用）+ format chips + 履歴グリッド。設定保存・復元、適用フィードバック、ダーク/ライト追従、IBM Plex Sans JP サブセット (Regular 400 / SemiBold 600 / Bold 700) 同梱 + popup.html で 3 weight すべて preload |
| `src/shared/kagayoi-support-*` | popup 下部の問い合わせ・評価共通部品。`kagayoi-support-extension` の exact 固定版を `pnpm sync:support` で逐語同期し、MV3 のためリモート JavaScript は実行しない。製品固有の配置・配色は `popup.html` / `popup.css` 側だけで行う |
| `src/content/volume-booster-mes.js` | 音量ブースター Firefox 専用 MES 経路 (**manifest.firefox.json のみから注入、Chrome には一切ロードされない**): 全 http(s) の全フレームに `document_idle` 注入、`<video>`/`<audio>` 1 要素 = 1 AudioContext で MediaElementSource + 18 処理ノードを attach。`source → dryGain → destination` と、offscreen.js と同じ 16 ノード DSP の末尾に `wetGain` を置く wet 経路へ分岐する。popup → storage 直書きを `storage.onChanged` で購読する storage 駆動・メッセージレス (user gesture 不要、全タブ自動適用、タブ共有バナーなし)。**Firefox では ctx.close しても音声が直接出力に復帰しない前提**で、誤 attach の予防 (EME_HOSTS 起動 skip / mediaKeys / encrypted 事前検出 / readyState gate / `classifyMesSource` 4 値分類 + same-origin 1 バイト Range GET redirect probe) と bypass 維持 (OFF / UNITY / orphan は dry/wet crossfade、close は DOM 除去 30 秒猶予後 + pagehide のみ) に全振り。拡張リロードで旧 sandbox が消えても、5 秒 heartbeat で更新する 20 秒 lease の AudioParam automation が旧 graph を dry bypass へ戻す。設定適用は ATTACHED レジストリ (WeakRef Set) 反復で shadow DOM / detached 要素にも届く。冒頭 `chrome.runtime.getURL("")` の `moz-extension://` スキーム検査で Chrome 誤ロード時も即 return。DSP コアは audio-pipeline.js 共有 |
| `src/popup/fonts/IBMPlexSansJP-{Regular,SemiBold,Bold}.woff2` | popup タイポグラフィ用 woff2 サブセット。Regular / SemiBold は IBM 純正の subset 済み版 (約 77 / 81 KB)、Bold は `scripts/fetch-bold-woff2.mjs` で IBM/plex full CJK Bold (npm `@ibm/plex-sans-jp@3.0.0`) を Regular と同じ cmap (652 unicode) で subset 化した版 (約 200 KB、subset-font の woff2 encoder が IBM 純正より圧縮率低めのため大きい)。preload で並列 fetch するので popup 起動コストへの影響は小 |
| `scripts/fetch-bold-woff2.mjs` | Bold woff2 再生成スクリプト。`pnpm add fontkit subset-font @ibm/plex-sans-jp@3.0.0` 後に `node scripts/fetch-bold-woff2.mjs` を実行すると、既存 Regular の cmap を読んで同じ unicode 集合の Bold woff2 を `src/popup/fonts/IBMPlexSansJP-Bold.woff2` に書き出す。完了後は `pnpm install --frozen-lockfile` で node_modules を pnpm-lock.yaml 通りに復元し、`package.json` / lockfile に紛れ込んだ 3 パッケージを取り除くこと (75 MB の @ibm/plex-sans-jp パッケージは devDependencies には含めない方針) |
| `src/offscreen/offscreen.{html,js}` | 音量ブースター用 offscreen document (tabCapture 経路の AudioContext 実体、**Chrome の唯一の音量ブースター経路**。Firefox は volume-booster-mes.js が担当): AudioContext + プリアンプ GainNode + BiquadFilterNode × 10 (peaking EQ) + DynamicsCompressor (night mode) + 手動 GainNode + BiquadFilterNode × 2 (highpass、壁ドン対策) + DynamicsCompressor (anti-clip) の **16 ノードチェーン**で **EQ + 圧縮 + 増幅 + 低音カット + リミット**を構成。全サイト一律 (EME 動画含む) で popup 経由の tabCapture 経路から使われる。DSP コアは `src/lib/audio-pipeline.js` を共有 |
| `icons/icon.svg` | ソースアイコン (512×512); PNG は `icons/icon-{16,48,128}.png` に生成 |
| `webstore/` | ストア申請用: HTML テンプレート、生成画像、`store-listing.txt`。`generate-screenshots.js` が popup.html から `popup-render.html` + `popup-shim.js` を動的生成 → `01-popup-ui.html` が iframe で実 popup を埋め込んで撮影（drift ゼロ）。生成物 `popup-render.html` / `popup-shim.js` は .gitignore 対象 |
| `manifest.firefox.json` | Firefox AMO 申請用 manifest (Chrome 用 `manifest.json` から `offscreen` / `tabCapture` permission 除外 + `browser_specific_settings.gecko` + `background.scripts` 併記 + **Firefox 専用 MES 経路の content_scripts エントリ `volume-booster-mes.js` を追加**。Chrome 用 manifest.json はこのエントリを持たない)。zip スクリプトが Firefox xpi 生成時にこれを `manifest.json` として同梱する |
| `.amo-metadata.json` | `web-ext sign --amo-metadata=...` で AMO 初回登録時に渡すメタデータ (license: MIT, categories: ["other"])。CI からは新規 add-on 作成不可なため、初回のみローカル `web-ext sign` で使う |
| `zip.ps1` / `zip.sh` | ストア申請用 ZIP / xpi パッケージ生成 (Windows / Unix)。`-Target chrome\|firefox\|both` で対象切替 |
| `pnpm-workspace.yaml` | **overrides / allowBuilds の正本**（`package.json` の `pnpm.overrides` は使わない）。transitive 脆弱性は脆弱範囲だけに効く versioned selector で固定する。`minimumReleaseAgeExclude` の同一 package 複数版は pnpm 11.7.0 の既知問題を避けて `||` で 1 selector に統合する。詳細と保留中の既知脆弱性は §依存パッケージの運用 |
| `.github/dependabot.yml` | github-actions（SHA ピン維持）と npm の weekly 更新 PR 設定。取り込みの正規ルートは `/deps` スキル |
| `docs/privacy-policy.md` | プライバシーポリシー |
| `test/actions.test.js` | 純粋関数テスト: globalThis 公開名 24 件の列挙 (SettingsSchema 含む。**この `required` 配列が公開定数の単一情報源**) / **FEATURES 件数アサート (SearchFixer 34 / IG 11 / TT 3 / X 9)** / mergeFeatures / ImageDownloader.isAllowedFetchUrl (Instagram fbcdn / cdninstagram は scontent- prefix 限定 / TikTok p\\d+ 必須 / YouTube 廃止) / detectHost / buildFilename / **セッション維持 / RTX 動画強化 (v1.0.39 で撤去) の関連定数が actions.js から完全消去されている drift 検知** / **接続モニターが SearchFixer.FEATURES の connectionMonitor サブ機能 (watch_page) に統合・旧独立キー (CONNECTION_MONITOR_ENABLED / APPLY_CONNECTION_MONITOR_CS) 撤去済みの drift 検知 + ConnectionMonitor.classify 7 分類境界値 + median 境界値 + VERDICT 識別子固定 + endpoint URL 固定アサート (gstatic.com/generate_204 + speed.cloudflare.com/__down?bytes=10)** / **Loupe.validateZoom / clampSize / computeLensPosition / computeBackgroundPosition / formatLoupeError 境界値** / **SearchFixer.extractHandleFromHref の ASCII + Unicode + URL encoded 境界値** / **SettingsSchema 整合 + APPLY_SETTINGS_KEYS/toStorageRecord generated 検証 + popup get list drift 検知** 等。件数 drift を CI で検知できる単一情報源 |
| `test/syntax-check.test.js` / `test/manifest-drift.test.js` / `test/audio-pipeline.test.js` / `test/kagayoi-support.test.js` | 順に「`src/**/*.js` の動的列挙 + 構文 check」「`manifest.json` と `manifest.firefox.json` の content_scripts 一致検証」「`audio-pipeline.js` の DSP ヘルパー」「問い合わせ共通部品と組み込み契約の検証」。共有ローダーは `test/_load-actions.js` |
| `.github/workflows/publish.yml` | `push: branches: release/**` トリガーで **Chrome Web Store** に **アップロード + Submit for review まで自動化** + **Firefox AMO** に `web-ext sign --channel=listed` で並列 submit。Chrome step 失敗時も `if: success() \|\| failure()` で Firefox AMO step は独立実行する (ReplaceFontSelect 流派)。必要 Secrets: `CWS_*` (Chrome 4 件) + `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` (Firefox 2 件)。**xpi / zip 自体はこのワークフローで CI 自動公開、listing メタデータは `~/.Codex/skills/vava/scripts/update-amo-listing.mjs` (AMO は API 自動 push 可) / Dashboard 手動 (CWS は API 不対応) で別経路管理**。 |
| `.cws-id` | Chrome Web Store extension ID 単一行ファイル (現状 `lmkdjffdnkadifjjifameboongbngaep`)。`/vava` スキルの汎用 check-store-listing.mjs が env var `CWS_EXTENSION_ID` 未設定時にフォールバック読み込みする。**公開ストア URL の一部に含まれる identifier (秘密情報ではない) なのでコミット対象**、`.gitignore` 不要。`/vava` Step 8.7-B (CWS drift check) からも自動参照される |
| `vava.config.json` | `/vava` スキル (`~/.Codex/skills/vava/scripts/{check-store-listing,update-amo-listing}.mjs`) に渡すプロジェクト固有設定。AMO slug / homepage / supportUrl / 表示名 / listing ファイルパス / privacy ファイルパス / categories / CWS extension ID ファイル / drift 判定キーワードを集約。**スクリプト本体はスキル側に汎用化集約**しており、プロジェクトには本ファイルだけ置けば動く設計 (他 Chrome 拡張機能プロジェクトでも同じスキルを再利用できる) |
| `~/.Codex/skills/vava/scripts/check-store-listing.mjs` | ストア掲載 listing drift チェッカー (汎用版、スキル側集約)。CWS は公開ページ (`chromewebstore.google.com/detail/<id>`) を fetch して `<meta>` から name / description / version を抽出、AMO は API v5 `GET /addons/addon/{slug}/?lang=all` で取得。drift 判定キーワードは CWD の `vava.config.json` の `driftKeywords.{cws,amo}.{ja,en}` から取得 (未設定なら drift チェックをスキップ)。`--cws` / `--amo` で対象選択可。`/vava` Step 8.7-B から自動実行 |
| `~/.Codex/skills/vava/scripts/update-amo-listing.mjs` | Firefox AMO listing 自動 push (汎用版、スキル側集約、API v5 `PATCH /addons/addon/{slug}/`)。name / summary / description / homepage / support_url / categories / privacy_policy を CWD の `vava.config.json` で指定された listing / privacy ファイルから構築して送信。**summary は 250 chars 拒否されるため 249 に truncate / description と privacy_policy は `<` `>` を `&lt;` `&gt;` に pre-escape する (AMO の HTML allowlist に `<video>` `<feComponentTransfer>` 等の技術タグが無く HTTP 406 で silent reject されるため、ReplaceFontSelect 知見ベース)**。screenshots は API 不対応で Dashboard 手動。`~/.amo_token` 2 行構成 (ISSUER / SECRET) から JWT HS256 生成。`/vava` Step 8.7-A から自動実行 |
| `memory-bank/WebRestrictionRemoval/*.md` | プロジェクト横断の長期記憶（projectbrief / productContext / systemPatterns / techContext / activeContext / progress の 6 コアファイル）。activeContext と progress は頻繁更新、systemPatterns は設計パターン履歴。**ホスト側ファイルを直接 Read/Edit せず必ず memory-bank-mcp 経由で操作** |

## Important Patterns

新機能追加・既存機能の改修で踏むべき原則と、過去にハマった罠の対策。本文は [references/patterns.md](references/patterns.md) にある。下の目次で当たりを付けて、該当節だけを読む。

### 目次 (TOC)

**ビルド・配信**
- [Firefox AMO 対応](references/patterns.md#firefox-amo-対応-2026-05-16-確立reactivefontselect-の知見ベース) — manifest 分岐 / web-ext lint 0 件化 / strip マーカー方式

**設計の原則**
- [設計の起点](references/patterns.md#設計の起点) — actions.js 単一情報源 / バージョン番号運用 / デフォルト OFF 方針
- [メッセージング・content script](references/patterns.md#メッセージングcontent-script) — sender 検証 / 二重ロード許容 / early script 共通フレームワーク
- [マイグレーション](references/patterns.md#マイグレーション) — `onInstalled` で旧キー削除 + 新キー初期化

**観測・ガード**
- [MutationObserver 取り扱い](references/patterns.md#mutationobserver-取り扱い) — 書き戻し guard / cross-document な iframe 制約
- [Extension context invalidation guard PATTERN SYNC](references/patterns.md#extension-context-invalidation-guard-pattern-sync-rere-v1028-確立) — 拡張機能リロード後の orphan 化対策
- [Observer / async の罠](references/patterns.md#observer--async-の罠) — stale callback / post-await guard
- [Observer guard の 4 段防御 + finally 状態再取得](references/patterns.md#observer-guard-の-4-段防御--finally-状態再取得-rere-v1028-強化)

**機能別パターン**
- [hideLiveChat（YouTube ライブチャット非表示）](references/patterns.md#hidelivechatyoutube-ライブチャット非表示) — iframe click + CSS 先制非表示 + 復活禁止パターン
- [音量ブースター・Offscreen Document](references/patterns.md#音量ブースターoffscreen-document-tabcapture-経路の-audiocontext-実体唯一の経路) — DSP ノード順序 / compressor BYPASS preset / gain ramp 三点セット
- [音量ブースター・Firefox 専用 MES パイプライン](references/patterns.md#音量ブースターfirefox-専用-mes-パイプライン-volume-booster-mesjs2026-07-02-追加) — Chrome 影響ゼロ 3 層 / storage 駆動 / bypass 維持 / classifyMesSource / EME 三段防御
- [YouTube DOM の罠](references/patterns.md#youtube-dom-の罠v1027-で得た知見) — handle Unicode / Trusted Types / Polymer / thumbnail URL

**機能別パターン（追加）**
- [video-gamma / video-fill の lifecycle 統一](references/patterns.md#video-gamma--video-fill-の-lifecycle-統一-v1041-で確立) — per-video inline style + loadedmetadata 待ち + WeakMap original + AbortController + MutationObserver

**外部 fetch / セキュリティ**
- [外部 fetch allowlist 設計](references/patterns.md#外部-fetch-allowlist-設計-imagedownloaderallowed_hosts) — 4 原則 / scontent- prefix / same-origin との使い分け
- [image-downloader 並列化のセマンティクス維持](references/patterns.md#image-downloader-並列化のセマンティクス維持) — Promise.allSettled で「最大解像度優先」
- [外部 fetch の exponential backoff](references/patterns.md#外部-fetch-の-exponential-backoff-rere-v1028-確立)

**ロケール・UI**
- [多言語ロケール](references/patterns.md#多言語ロケール) — `aria-label` の ja/en 併記

**ストレージ・設定経路**
- [APPLY_SETTINGS 経路の partial payload 防御](references/patterns.md#apply_settings-経路の-partial-payload-防御-v1031-で確立いつの間にか-off4-経路対策) — 経路 A〜D + 6 ポイントチェックリスト
- [音量ブースター popup → storage 直書きの防御](references/patterns.md#音量ブースター-popup--storage-直書きの防御-rere-v1028-確立)
- [SW モジュールスコープのストレージキャッシュ](references/patterns.md#sw-モジュールスコープのストレージキャッシュ-rere-v1028-確立)

**テスト・観測性**
- [FEATURES 件数アサートテスト](references/patterns.md#features-件数アサートテスト-rere-v1028-確立) — ドキュメント整合性の単一情報源
- [`chrome.runtime.sendMessage` の expected error](references/patterns.md#chromeruntime sendmessage-の-expected-error-rere-v1028-確立)

**TODO 管理 / 履歴**
- [/rere レビュー TODO 集約](references/patterns.md#rere-レビュー-todo-集約-議題化のみ実装は次バッチ判断) — `[active]` / `[settled]` / `[resolved]` タグ運用
- [撤去済み機能と教訓](references/patterns.md#撤去済み機能と教訓) — セッション維持 / RTX 動画強化 / MES 経路 撤去履歴と教訓

