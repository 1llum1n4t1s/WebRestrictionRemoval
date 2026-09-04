# Vuora 設計

この文書は、現在のコード・manifest・テスト・運用設定から確認できる Vuora のシステム設計をまとめた正本です。利用方法は [README.md](README.md)、エージェント向けの作業・検証規約は [AGENTS.md](AGENTS.md)、機能別の実装詳細は [references/architecture.md](references/architecture.md) を参照してください。

## 目的と範囲

Vuora は Manifest V3 の Chrome / Firefox 拡張機能です。YouTube、Amazon、Instagram、TikTok、X と汎用動画ページに対する閲覧支援、音量処理、ルーペ、カラーピッカーを1つのポップアップに統合します。

12機能カテゴリのうちカラーピッカー以外の11機能は独立したマスタートグルを持ち、初期値はすべて OFF です。利用者が選んだ機能だけが対象ページへ作用します。`web/` は製品紹介とプライバシーポリシーを配信する独立した静的ランディングページであり、拡張機能の実行処理や配布は担いません。

## 主要コンポーネントと責務

| コンポーネント | 責務 | 境界 |
|---|---|---|
| `src/popup/` | 6タブの設定 UI、設定の復元・保存、即時適用、カラーピッカー、問い合わせ導線 | サイト DOM は直接操作せず、設定と操作要求を storage または background へ渡す |
| `src/lib/actions.js` | Actions、StorageKeys、SettingsSchema、機能定義、純粋関数の単一情報源 | DOM・ブラウザ固有ライフサイクルを持たない |
| `src/background/background.js` | popup / content script の sender 検証、設定配布、ルーペ撮影、Chrome 音量処理の調停、Gemini Notebook RPC、設定移行 | UI とサイト DOM を持たず、権限が必要な処理を集約する |
| `src/content/` | サイト別 DOM / CSS 適用、動画要素処理、HUD、画像ダウンロード | 対象 URL とフレームを manifest で限定し、機能 OFF または context 失効時に状態を戻す |
| `src/offscreen/` | Chrome の tabCapture 音声ストリームと AudioContext / DSP graph の維持 | Chrome 専用。Firefox manifest からは offscreen / tabCapture を除外する |
| `src/lib/audio-pipeline.js` | Chrome / Firefox で共有する DSP graph 構築と設定適用 | キャプチャ方法とメディア要素検出は呼び出し側が担当する |
| `src/lib/scan-runner.js` / `src/lib/cleaner-core.js` / `src/content/early-framework.js` | DOM 監視、設定購読、document_start の先制非表示に共通するライフサイクル | サイト固有セレクタと表示内容は各 content script に残す |
| `src/shared/kagayoi-support-*` | 問い合わせフォームと評価導線 | `kagayoi-support-extension` の exact 固定版から同梱するコピー。製品固有の配置・配色だけを popup 側で与える |
| `_locales/{en,ja}/` | popup と注入 UI の利用者向け文言 | `chrome.i18n` を経由し、未対応言語は英語へフォールバックする |
| `test/` | 純粋関数、公開定数、機能件数、構文、manifest 差分、DSP、問い合わせ契約の drift 検知 | 実サイト DOM の時点依存挙動は手動・実ブラウザ確認で補う |
| `web/` | `vuora.kagayoi.com` の静的 LP とプライバシーページ | Cloudflare Worker は静的素材だけを返し、拡張の API backend にはならない |

## データフロー

### 設定と DOM 機能

```text
利用者
  → Popup
  → Background の APPLY_SETTINGS（同期世代の検証・部分更新）
  → chrome.storage.local
  → APPLY_*_CS 通知 / Content Script の storage.onChanged
  → DOM / CSS / video 要素へ適用
```

音量の詳細設定やルーペの倍率・サイズなどは popup から `storage.local` へ直接保存し、各設定の購読先へ反映します。

設定名・既定値・storage 変換は `SettingsSchema`、メッセージ名は `Actions`、機能一覧は各 `FEATURES` 配列を正本にします。background は既存 storage と partial payload をマージして正規化し、content script は初期取得・メッセージ・`storage.onChanged` のいずれから更新されても同じ状態へ収束します。

### 任意のPC間同期

`src/background/settings-sync.js` が明示した設定キーだけを `storage.local` と `storage.sync` の間で照合します。同期キーは `vuora.settings.v2.` 接頭辞を持ち、既存のサイト適用リスナーへ直接漏れません。同期スイッチはPC単位で既定 OFF、初参加は同期先優先です。

- 通常設定は項目単位、4クリーナーはサブ機能単位、除外リストはチャンネル単位の LWW register とします。EQ の有効状態・全バンド・プリアンプ・プリセットは1レコードです。
- 更新情報は `[時刻, 論理カウンター, ランダム端末ID]` の辞書順で比較します。端末の時計が戻った場合はカウンターを進め、受信済みの時刻も引き継ぎます。設定の local 変更通知時に時刻を取得し、5秒の送信待ちより先に更新情報を保存します。受信・再送では刻印し直しません。
- `_settingsSyncState` に勝者・画面へ適用済みの値・時計を保持し、ネットワーク待ちと独立したキューで編集を記録します。ブラウザ側が古い値へ戻した場合も最大の更新情報を再送します。受信反映の自己通知はマーカーで除外し、設定と適用済み状態を同じ local 書込で更新します。
- 削除は tombstone を残します。チャンネルの保存先は固定32分割で、sync のキー数を抑えます。長期間オフラインの端末からの復活を防ぐため、削除記録を期限だけで消しません。容量超過時も記録を切り捨てずエラーを表示します。
- 未リリースの旧試作 v1 は初参加時だけ読み替え、v2 保存成功後に既知の旧同期キーを撤去します。旧 baseline は初期化時に除去します。バージョン不明のデータは読み込みません。
- 初参加時の既存値は編集時刻不明として時刻0を使います。設定保存から変更通知の永続化までの間にプロセスが終了した場合は、再起動時の差分検出時刻で回復します。時計がずれた未通信の端末同士で実際の操作順を完全には判定できませんが、受信済みのレコードは同じ順序で比較します。

popup の `APPLY_SETTINGS` 経路は操作した項目（サブ機能は1項目）と読込時の同期世代だけを送信します。background は同期反映と同じ書込キュー内で世代を照合し、古い画面からの遅延要求を破棄します。保存も変更キーだけに限定します。受信反映時は popup を再読込し、内部状態と表示を一緒に復元します。認証・アカウント情報・採色履歴・表示位置は同期対象外です。ブラウザの同期と容量制限は [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage) と [Firefox storage.sync](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/sync) を参照してください。

### 音量ブースター

Chrome では popup の user gesture を起点に background が `chrome.tabCapture.getMediaStreamId` を取得し、offscreen document が `AudioContext` と共有 DSP pipeline を維持します。タブを閉じたとき、マスターを OFF にしたとき、または中立設定へ戻したときは stream と graph を解放します。

Chrome の音量設定変更はブースト中の全タブへ即時反映します。自動反映中に stream が終了しても新規キャプチャへ進みません。

Firefox では `manifest.firefox.json` だけが `volume-booster-mes.js` を読み込み、各 `<video>` / `<audio>` を `MediaElementSource` と共有 DSP pipeline へ接続します。Firefox では graph を閉じても直接出力へ戻せないため、OFF 時は dry bypass を維持します。EME / DRM サイトでは attach せず、通常再生を優先します。

### 権限を伴う機能

- ルーペは content script から background へ撮影を要求し、`captureVisibleTab` の JPEG を Blob URL に変換してレンズへ表示します。撤去時に Blob URL を解放します。
- Gemini Notebook 送信は content script が対象 URL を組み立て、background が NotebookLM との cross-origin RPC と送信後タブの生成を担当します。
- 問い合わせは popup の同梱 Web Component から `support.kagayoi.com` へ送信します。認証セッションは拡張オリジンの `localStorage` に保持し、Firefox では本文送信前に optional の `personalCommunications` 許可を要求します。

## 重要な不変条件

1. 11個のマスタートグルは未設定時を含めて OFF とし、カラーピッカー以外のサイト変更を自動有効化しません。
2. `manifest.json` と `manifest.firefox.json` の共通 content scripts は drift テストで一致させ、ブラウザ差は音量処理・Firefox 固有権限・background 定義に限定します。
3. background の message handler は `SenderCheck` で popup または content script の由来を検証します。
4. DOM 監視は rAF coalesce と observer の再入防止を行い、extension context 失効時は observer、timer、listener、注入 DOM、inline style、Blob URL を片付けます。
5. popup と content script の利用者向け文言は `_locales/{en,ja}/messages.json` と `chrome.i18n` を経由します。
6. Manifest V3 の CSP に従い、実行 JavaScript はすべて拡張へ同梱します。問い合わせ共通部品もリモート実行せず、npm package から同期したファイルを配布物へ含めます。
7. 外部通信はプライバシーポリシーの5例外だけです。画像取得、接続モニター、Gemini Notebook、問い合わせ、設定同期で扱うデータと発火条件を、実装・manifest・ストア掲載・プライバシーポリシー間で一致させます。
8. バージョンは Chrome / Firefox manifest、package metadata、lockfile 間で同期し、release ブランチから生成した成果物を同一バージョンとして公開します。

## 採用済みの設計判断

### 定数と純粋ロジックを集中する

機能定義、設定 schema、メッセージ ID、境界計算を `actions.js` に集め、popup・background・content scripts 間の重複を避けています。IIFE と `globalThis` 公開は bundler なしで manifest の読み込み順を利用できる一方、公開名の drift が起きやすいため `test/actions.test.js` で名前と件数を固定します。

### サイト適用を content script に分離する

権限処理を background、UI を popup、DOM 変更を content script に分けています。サイトごとの変化を局所化できる反面、SPA navigation と非同期 DOM の追跡が必要になるため、MutationObserver、設定再配信、context invalidation cleanup を共通パターンにしています。

### 音量処理はブラウザ別入口と共有 DSP にする

Chrome は tabCapture により EME を含むタブ出力を処理できますが user gesture と共有表示が必要です。Firefox は MediaElementSource で自動適用できますが DRM と graph 解放に制約があります。この差を入口で分け、EQ・圧縮・低音カット等の DSP 定義だけを `audio-pipeline.js` で共有します。

### 問い合わせ部品は正本からローカル同梱する

共通 UI と API 契約は `kagayoi-support-extension` に集約し、このリポジトリでは exact version と同期結果を保持します。これにより複数拡張の挙動を揃えつつ、MV3 のリモートコード禁止を満たします。代わりに package 更新時の同期漏れが生じうるため、専用 check と契約テストを置きます。

### リリース成果物を manifest 差し替えで分ける

Chrome は `manifest.json`、Firefox は `manifest.firefox.json` を `manifest.json` として梱包し、Firefox 成果物から未対応の offscreen / tabCapture 呼び出しを strip します。単一ソースを共有できる一方、variant drift の危険があるため、両 manifest の content scripts と生成成果物をテストします。`release/**` の push は GitHub Actions で Chrome Web Store と Firefox AMO を独立に提出し、一方の失敗で他方を連鎖停止させません。

## 検証と正本

- 通常のコード検証は `pnpm test` と `pnpm run lint` です。
- 共通問い合わせ部品の正本一致は `pnpm exec kagayoi-support-sync --check` です。
- ストア成果物は `pwsh -NoProfile -File zip.ps1` または `./zip.sh` で Chrome / Firefox の両 variant を生成します。
- version、公開名、機能件数、設定 schema などの可変値は文書へ固定値を増やさず、`AGENTS.md` が示す単一情報源とテスト結果を優先します。
