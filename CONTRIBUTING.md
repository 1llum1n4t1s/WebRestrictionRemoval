# 開発者向けガイド (Contributing)

このドキュメントは **Vuora** に手を入れる開発者向けです。
利用者向けのインストール手順や機能説明は [README.md](README.md) を参照してください。

LLM (Claude / Codex 等) 向けの詳細な実装規約は [AGENTS.md](AGENTS.md) にあります。
本ファイルは「人間の開発者がコードを触るときに必要な最小限の情報」に絞っています。

---

## 開発環境

- **Node.js**: 22+ (Volta 管理を推奨)
- **pnpm**: 11+
- **対象ブラウザ**: Chrome 140+ / Firefox 142+

## セットアップ

```bash
git clone https://github.com/1llum1n4t1s/WebRestrictionRemoval.git
cd WebRestrictionRemoval
pnpm install
```

## 主要コマンド

### ビルド

```bash
pnpm run build                # アイコン + スクリーンショット一括生成
pnpm run generate-icons       # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
pnpm run generate-screenshots # webstore/*.html → webstore/images/*.png (Puppeteer)
```

### テスト・lint

```bash
pnpm test          # Node.js 標準 test runner、77 件
pnpm run lint      # ESLint v10 flat config
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
- `web-viewing-assist-chrome.zip` — Chrome Web Store 用 (11 機能フル対応、音量ブースターは tabCapture 経路)
- `web-viewing-assist-firefox.xpi` — Firefox AMO 用 (11 機能フル対応。音量ブースターは Firefox 専用 MES 経路 `volume-booster-mes.js` = manifest.firefox.json のみに登録される content script で提供、DRM サイトでは無効。background の tabCapture 経路は `HAS_VOLUME_BOOSTER` guard で Firefox では全 skip)

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
2. **Firefox AMO** へ submission API で submit (`web-ext sign --channel=listed`)

### 必要な GitHub Secrets
- Chrome: `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` / `CWS_EXTENSION_ID`
- Firefox: `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` ([発行ページ](https://addons.mozilla.org/ja/developers/addon/api/key/))

Chrome publish が失敗しても Firefox AMO step は `if: success() || failure()` で独立実行されます。Chrome は **同 version pre-flight check** で upload 済みなら再 upload だけを skip し、Publish API は毎回実行します（upload 成功後に Submit for review が失敗した run を同 version で再試行可能）。Firefox は既存 version の submission を pre-flight で skip します。

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
    │ <video>/<audio> ごとに MediaElementSource + 18 処理ノード
    │ (dryGain + 16 DSP ノード + wetGain、メッセージレス・user gesture 不要)
    │ 拡張リロード後の旧 graph は 20 秒 lease 失効で dry bypass へ戻る
    │ DRM サイト (EME_HOSTS) では無効。Chrome には一切ロードされない

[ルーペ]
  Content Script ──LOUPE_REQUEST_CAPTURE──▶ Background
    │ chrome.tabs.captureVisibleTab で JPEG 静止画を取得
```

### 主要ディレクトリ

| パス | 役割 |
|------|------|
| `src/lib/actions.js` | 単一情報源 (Actions / StorageKeys / SettingsSchema 等を `globalThis` に公開) |
| `src/lib/scan-runner.js` | rAF + MutationObserver + context invalidation guard の共通ランタイム |
| `src/lib/audio-pipeline.js` | 音量ブースター DSP コア 7 関数 (`dbToGain` / `applyCompressorPreset` / `applyFilterPreset` / `createBassCutChain` / `applyEqualizer` / `createEqChain` / `connectAudioGraph`。caller は offscreen.js = Chrome と volume-booster-mes.js = Firefox の 2 つ) |
| `src/background/background.js` | Service Worker (settings 集約 / offscreen 管理 / 音量ブースター制御) |
| `src/content/*.js` | 各機能の content script |
| `src/offscreen/` | 音量ブースター用 offscreen document (tabCapture 経路の AudioContext 実体・Chrome の唯一の経路) |
| `src/popup/` | popup UI |
| `_locales/{en,ja}/` | i18n (Chrome i18n API) |
| `test/actions.test.js` | 純粋関数テスト (77 件、件数 drift 検知 + CI 整合性チェック含む) |
| `webstore/` | ストア申請用 HTML テンプレート / 画像生成 / store-listing テキスト |
| `vava.config.json` | `/vava` スキル (ストア listing 同期スクリプト) 用のプロジェクト固有設定 |

## コーディング規約

詳細は [AGENTS.md](AGENTS.md) を参照。要点だけ抜粋:

- **新機能追加は `src/lib/actions.js` から手をつける** (FEATURES 配列 / StorageKeys / Actions が単一情報源)
- **デフォルト OFF 方針徹底** — 9 マスタートグルすべて初期 OFF
- **`SenderCheck` で sender 検証必須** — background の各 message handler 冒頭
- **MutationObserver で DOM 書き戻すときは `ScanRunner.create()` を使う** (rAF coalesce + disconnect→render→takeRecords→observe ガード)
- **Extension context invalidation guard** — `chrome.runtime?.id` 検知 + observer/timer 停止 + cleanup (PATTERN SYNC は 14 ファイル実装済み)
- **音量ブースター DSP は `AudioPipeline` 経由** で実装 (caller は offscreen.js = Chrome tabCapture 経路 と volume-booster-mes.js = Firefox 専用 MES 経路 の 2 つ)

## プライバシー方針

- 外部送信ゼロ (本拡張機能側からは)
- 個人情報の収集ゼロ
- すべての処理はユーザーの端末内で完結
- 詳細は [プライバシーポリシー](docs/privacy-policy.md)

## ライセンス

[MIT License](LICENSE)
