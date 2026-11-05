# 開発者向けガイド (Contributing)

このドキュメントは **Vuora** に手を入れる開発者向けです。
利用者向けのインストール手順や機能説明は [README.md](README.md) を参照してください。

LLM (Claude / Codex 等) 向けの詳細な実装規約は [AGENTS.md](AGENTS.md) にあります。
本ファイルは「人間の開発者がコードを触るときに必要な最小限の情報」に絞っています。

---

## 開発環境

- **Bun**: 1.4.4（package.json の packageManager と CI で固定）
- **対象ブラウザ**: Chrome 140+ / Firefox 142+

## セットアップ

```bash
git clone https://github.com/1llum1n4t1s/WebRestrictionRemoval.git
cd WebRestrictionRemoval
bun run deps
```

## 主要コマンド

### ビルド

```bash
bun --bun run build                # アイコン + スクリーンショット一括生成
bun --bun run generate-icons       # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
bun --bun run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer)
```

### テスト・lint

```bash
bun --bun run test          # Bun の node:test 互換テスト（件数は出力サマリを参照）
bun --bun run lint      # ESLint v10 flat config
```

### ストア申請用パッケージ生成

```bash
# Chrome + Firefox 両方
pwsh -NoProfile -File zip.ps1                                     # Windows
bash ./zip.sh                                                      # Unix

# Chrome のみ
pwsh -NoProfile -File zip.ps1 -Target chrome
bash ./zip.sh chrome

# Firefox のみ (xpi 出力)
pwsh -NoProfile -File zip.ps1 -Target firefox
bash ./zip.sh firefox
```

生成物:
- `web-viewing-assist-chrome.zip` — Chrome Web Store 用 (13 カテゴリ対応、音量ブースターは tabCapture 経路)
- `web-viewing-assist-firefox.xpi` — Firefox AMO 用 (13 カテゴリ対応。音量ブースターは Firefox 専用 MES 経路 `volume-booster-mes.js` = manifest.firefox.json のみに登録される content script で提供、DRM サイトでは無効。background の tabCapture 経路は `HAS_VOLUME_BOOSTER` guard で Firefox では全 skip)

## ローカル動作確認

### Chrome に未パッケージ拡張機能を読み込む
1. `chrome://extensions` を開く → デベロッパーモード ON
2. 「パッケージ化されていない拡張機能を読み込む」→ プロジェクトルートを選択
3. コード変更後は拡張機能カードの 🔄 リロードボタン
4. content script 変更時は対象タブを再読込、background SW 変更時は SW 再起動が必要

### Firefox 一時アドオン
1. `bash ./zip.sh firefox` で `web-viewing-assist-firefox.xpi` を生成
2. `about:debugging#/runtime/this-firefox` → 「一時的なアドオンを読み込む」で xpi を選択 (再起動でアンロード)

### デバッグ
- popup: ポップアップ右クリック →「検証」で DevTools
- background SW: `chrome://extensions` の「Service Worker」リンク
- offscreen: `chrome://inspect/#other` で `chrome-extension://<id>/src/offscreen/offscreen.html` を開く
- content script: 対象タブの DevTools Console (ログ prefix `[WebViewingAssist]`)

## CI 自動公開

`release/<X.Y.Z>` ブランチを push すると、GitHub Actions が以下を並列実行します:

1. **Chrome Web Store** へ Submit for review (`web-viewing-assist.zip`)
2. **Firefox AMO** へ submission API で submit (`scripts/Publish-Amo.ps1`、受付確認まで)

### 必要な GitHub Secrets
- Chrome: `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` / `CWS_EXTENSION_ID`。publisher IDは `vars.CWS_PUBLISHER_ID` または同名secret。
- Firefox: `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` ([発行ページ](https://addons.mozilla.org/ja/developers/addon/api/key/))

Chrome / Firefox の publish は `package` だけに依存する別 job で、Chrome publish が失敗しても Firefox AMO submit は独立して実行されます。Chrome は pre-flight で同 version や状態不明を検出すると停止し、Firefox も認証付きの全ページ照会で既存 version を検出すると非ゼロ終了します。自動の同 version 再提出は行わず、workflow の再実行では package job も実行されません。提出失敗時は各ストアの登録版・審査状態とログを確認してください（[RUNBOOK](docs/RUNBOOK.md#2-c-リリース失敗publishyml)）。

### バージョンアップ手順

`/vava` スキル経由で行います。手動で `manifest.json` / `package.json` の version を書き換えないでください (リリースブランチ作成・タグ打ち・関連ファイル一括更新を /vava が担当)。

## アーキテクチャ概要

3 つのレイヤが `chrome.runtime` メッセージパッシングで連携します。詳細・各 content script の責務・全データフロー図は [AGENTS.md](AGENTS.md) を参照。

```text
Popup (src/popup/popup.{html,js,css})
  ──APPLY_SETTINGS──▶ Background (src/background/background.js)
                        │ storage 更新 +
                        ──APPLY_*_CS──▶ 各 Content Script (src/content/*.js)

[音量ブースター・tabCapture 経路 (全サイト一律・Chrome の唯一の経路)]
  Popup ──VOLUME_BOOSTER_SET_GAIN──▶ Background ──▶ Offscreen Document
    │ chrome.tabCapture.getMediaStreamId (popup open = user gesture が必須)
    │ 全サイト一律で boost (Netflix / Prime Video 等 EME 動画も含む)。boost 中タブには
    │ Chrome の「このタブのコンテンツは共有されています」バナーが出る (tabCapture 仕様、抑止不可)

[音量ブースター・MES 経路 (Firefox 専用。manifest.firefox.json のみに登録)]
  Popup ──音量関連キーを storage 直書き──▶ 全タブの volume-booster-mes.js (storage.onChanged 購読)
    │ <video>/<audio> ごとに MediaElementSource + 19 処理ノード
    │ (dryGain + 17 DSP ノード + wetGain、メッセージレス・user gesture 不要)
    │ 拡張リロード後の旧 graph は 20 秒 lease 失効で dry bypass へ戻る
    │ DRM サイト (EME_HOSTS) では無効。Chrome には一切ロードされない

[ルーペ]
  Content Script ──LOUPE_REQUEST_CAPTURE──▶ Background
    │ chrome.tabs.captureVisibleTab で JPEG 静止画を取得
```

### 主要ディレクトリ

| パス | 役割 |
|------|------|
| `src/lib/actions-core.js` / `actions-video.js` / `actions-loupe.js` / `actions-volume.js` / `actions.js` | 用途別の単一情報源（共通 / 映像 / ルーペ / 音量 / サイト定義・SettingsSchema を `globalThis` に公開） |
| `src/lib/scan-runner.js` | rAF + MutationObserver + context invalidation guard の共通ランタイム |
| `src/lib/audio-pipeline.js` | 音量ブースター DSP コア 9 関数 (`dbToGain` / `applyCompressorPreset` / `applyFilterPreset` / `createBassCutChain` / `applyEqualizer` / `createEqChain` / `createOutputCeiling` / `applyOutputCeiling` / `connectAudioGraph`。caller は offscreen.js = Chrome と volume-booster-mes.js = Firefox の 2 つ) |
| `src/background/background.js` | Service Worker (settings 集約 / offscreen 管理 / 音量ブースター制御) |
| `src/content/*.js` | 各機能の content script |
| `src/offscreen/` | 音量ブースター用 offscreen document (tabCapture 経路の AudioContext 実体・Chrome の唯一の経路) |
| `src/popup/` | popup UI |
| `_locales/{en,ja}/` | i18n (Chrome i18n API) |
| `test/actions.test.js` | 純粋関数テスト（FEATURES / 公開定数の drift 検知を含む。件数は実行結果を参照） |
| `webstore/` | ストア申請用 HTML テンプレート / 画像生成 / store-listing テキスト |
| `AGENTS.md` | ストア掲載情報の同期・確認コマンド |

## コーディング規約

詳細は [AGENTS.md](AGENTS.md) を参照。要点だけ抜粋:

- **新機能追加は対象の定義元から手をつける** — Actions / StorageKeys は `src/lib/actions-core.js`、映像・ルーペ・音量は対応する `actions-video.js` / `actions-loupe.js` / `actions-volume.js`、サイト FEATURES / SettingsSchema は `actions.js`。各 consumer の読み込み元に共通→必要定義を先に列挙し、他エントリの実行順に依存させない。
- **デフォルト OFF 方針徹底** — 全マスタートグルが初期 OFF（件数の正本は AGENTS.md の早見表）
- **`SenderCheck` で sender 検証必須** — background の各 message handler 冒頭
- **MutationObserver で DOM 書き戻すときは `ScanRunner.create()` を使う** (rAF coalesce + disconnect→render→takeRecords→observe ガード)
- **Extension context invalidation guard** — `chrome.runtime?.id` 検知 + observer/timer 停止 + cleanup (PATTERN SYNC は 14 ファイル実装済み)
- **音量ブースター DSP は `AudioPipeline` 経由** で実装 (caller は offscreen.js = Chrome tabCapture 経路 と volume-booster-mes.js = Firefox 専用 MES 経路 の 2 つ)

## プライバシー方針

- 通常処理は端末内で完結。外部通信はプライバシーポリシーの6例外に限定
- 問い合わせ時に入力したメールアドレス・本文だけをサポート窓口へ送信
- 詳細は [プライバシーポリシー](docs/privacy-policy.md)

## ライセンス

[MIT License](LICENSE)
