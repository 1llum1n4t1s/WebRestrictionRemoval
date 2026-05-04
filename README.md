# 📖 WEB閲覧アシスト

Web ブラウジングを快適にする 6 機能（**セッション維持** / **YouTube クリーナー（Shorts 削除・コメント欄非表示・ライブチャット非表示を含む 22 サブ機能）** / **Amazon 定期おトク便 月別合計** / **Instagram クリーナー** / **音量ブースター** / **カラーピッカー**）を 1 つのポップアップに統合した Chrome 拡張機能です。

> **v1.0.18 までの主な変更点**: 「制限解除（右クリック / 選択 / 強制ペースト・コピー）」機能を全面廃止し、Web 閲覧支援機能のみに特化しました。あわせて拡張機能名を「**WEB制限解除サポート**」から「**WEB閲覧アシスト**」に変更しています。バージョン番号は `/vava` スキル経由でリリース時に確定します。

## 機能

### 🔄 セッション維持（オプトイン、デフォルト OFF）

企業の SharePoint / Box 等で頻繁に起こるセッションタイムアウトを緩和します。

| 動作 | 説明 |
|------|------|
| 合成アクティビティ（デフォルト） | 全サイトで定期的に `mousemove` / `pointermove` / `scroll` / `focus` を安全寄りに dispatch して JS 側のアイドル検知をリセット。ネットワーク通信は発生しない |
| 同一オリジン ping（オプトイン・デフォルト OFF） | サブトグル「サーバーへの軽量 ping を併発」を ON にした場合のみ、SharePoint (`*.sharepoint.{com,cn,de,us}`) では `/_api/web` に GET、その他サイトでは現在 URL / origin root に軽量 `HEAD` を試してサーバー側セッション維持を補助 |
| 間隔設定 | ポップアップのスライダーで 1〜15 分の範囲で調整可能（デフォルト 4 分） |

外部（第三者）サーバーへの通信は発生せず、HTTP ping をオンにした場合でもアクセス中のサイト自身への同一オリジン `HEAD` / `GET` のみです。

**HTTP ping をデフォルト OFF にしている理由**: 認証プロキシ環境（Zscaler 等）では `/_api/web` への自動アクセスが 401/302 ループを誘発したり、企業の SIEM/WAF ログにアラートを残すことがあるため、副作用を理解したユーザーのみが有効化する設計にしています。

**制限事項**: サーバー側セッション維持は同一オリジン ping が実際に認証基盤まで届くサイトでのみ有効です。`HEAD` を受け付けないサイト、Service Worker でローカル応答されるサイト、認証プロキシが別レイヤーで idle timeout を持つ環境、あるいはタブが Memory Saver で freeze されるケースでは、本機能を有効にしていても再ログインが発生することがあります。

### 🧹 YouTube クリーナー（オプトイン、デフォルト OFF）

YouTube の検索結果・動画ページ・ホームグリッドのクリーンアップを行う **22 個のサブ機能** + **ホームグリッド列数** を細かく設定できます。各サブ機能は 1 行 1 トグル + 詳細説明文の縦積みレイアウトで表示され、何が起きるかが事前にわかります。

- 📺 **サイト全体**: Shorts 削除（サイドバー / 棚 / チップ削除 + `/shorts/<id>` → `/watch?v=<id>` リダイレクト）
- 🗑️ **検索結果ノイズ**: 動画棚 / カードリスト / プレイリスト / ミックス / コース / チャンネル / Shorts 棚 / Shorts 動画 / ライブ / 関連検索ブロック
- 🚫 **動画属性で削除**: 認証 / アーティスト / 視聴済み / チャプター付き
- ✨ **ハイライト**: キーワード非マッチをグレー化 / サムネ枠装飾
- 🎬 **動画ページ**: タイトル中央配置 / 説明文フル幅 / コメント欄非表示 / ライブチャット欄非表示
- 📐 **レイアウト**: 検索結果グリッド表示 + ホーム列数（自動 / 4 / 5 / 6 列）

### 📦 Amazon 定期おトク便 月別合計（オプトイン、デフォルト OFF）

`https://www.amazon.co.jp/auto-deliveries` ページで配送月ごとの合計金額を表示します。MutationObserver は disconnect → 書き込み → 再接続パターンで動作し、自身の DOM 書き込みによる再発火を防止しています。

### 📷 Instagram クリーナー（オプトイン、デフォルト OFF）

Instagram の冗長 UI を一括非表示にする **10 個のサブ機能** を提供します（独自実装）。`aria-label` / `href` / `role` / `data-pagelet` / SVG path data などの意味論的属性ベースのセレクタで構成し、難読化 class 名（build ごとに変わる）への依存を避けています。

- 🚫 **主要機能**: Reels 削除（URL リダイレクト含む）/ Explore 削除 / ストーリー段非表示 / Stories URL ホーム遷移 / Threads 誘導非表示
- ✂️ **追加機能**: いいね数・フォロワー数非表示 / 投稿内動画ブロック / コメント欄非表示 / Notes 非表示 / 新規メッセージカウンター非表示

### 🔊 音量ブースター（常時オン、デフォルト 100%）

アクティブタブの音量を **0〜600%** で増幅します。**マスタートグルなし**でスライダーのみの構成で、100% のときは AudioContext を解放してリソースを返却し、それ以外の値で増幅処理を起動します。サブトグル「自動歪み防止」「自動音量正規化」（いずれもデフォルト OFF）で 2 段の `DynamicsCompressor` が個別に有効化されます。

| 動作 | 説明 |
|------|------|
| 取得 | `chrome.tabCapture.getMediaStreamId` で active tab の音声 stream を取得 |
| 処理 | offscreen ドキュメント内の `AudioContext` + `GainNode` + 2 段 `DynamicsCompressor`（normalize / anti-clip）で増幅・圧縮して `destination` に再出力 |
| 解放 | スライダーを 100% に戻す / タブを閉じる / 拡張機能を無効化 で即時 release |

### 🎨 カラーピッカー（常時利用可）

ポップアップの「カラーピッカー」タブから `EyeDropper` API で画面上の色を採取し、HEX / RGB / HSL の 3 形式でクリップボードにコピーできます。HEX に `#` を含めるかどうかも個別に切替可能。採取した色は最大 20 件の標本箱（履歴）として `chrome.storage.local` 内にのみ保存され、外部送信は一切行いません。

## 使い方

1. 拡張機能アイコンをクリックしてポップアップを開く
2. 各機能のトグルで ON/OFF を切替（即時適用）
3. 音量ブースターはスライダーで増幅率を直接調整
4. カラーピッカーは「カラーピッカー」タブで `EyeDropper` を起動

設定は `chrome.storage.local` に保存され、次回以降も維持されます。保存対象は計 15 のキー（セッション維持 3 種 / YouTube クリーナー 3 種 / Amazon 合計 1 種 / Instagram クリーナー 2 種 / 音量ブースターサブトグル 2 種 / カラーピッカー 3 種 / 最後に開いていたタブ 1 種）。**初回インストール時のデフォルトはマスタートグル全て OFF**（セッション維持 OFF / YouTube クリーナー OFF / Amazon 合計 OFF / Instagram クリーナー OFF）。インストール直後にサイト挙動を勝手に書き換えないオプトイン方針です。音量ブースターはスライダーが 100% の時点でリソース解放されるため「ON/OFF」概念がありません。

## インストール

### Chrome Web Store から

[Chrome Web Store](https://chrome.google.com/webstore) で「WEB閲覧アシスト」を検索してインストール。

### 開発版を手動インストール

1. このリポジトリをクローン
2. `chrome://extensions/` を開く
3. 「デベロッパー モード」をON
4. 「パッケージ化されていない拡張機能を読み込む」でプロジェクトフォルダを選択

## ビルド

```bash
npm install
npm run build                # アイコン + スクリーンショット一括生成
npm run generate-icons       # アイコンのみ生成
npm run generate-screenshots # スクリーンショットのみ生成
```

### ストア申請用パッケージ生成

```bash
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File zip.ps1

# Unix
bash ./zip.sh
```

`web-viewing-assist.zip` が生成されます。

## 技術詳細

- **Manifest V3** 対応（Chrome 140 以上）
- **権限**: `activeTab`, `storage`, `offscreen`, `tabCapture`（音量ブースター機能のため）
- 外部サーバーとの通信なし
- 個人情報の収集なし

### アーキテクチャ

```
Popup (src/popup/popup.{html,js,css})
  ──APPLY_SETTINGS──▶ Background (src/background/background.js)
                        │ storage 更新 +
                        ──APPLY_KEEP_ALIVE_CS / APPLY_SEARCH_FIXER_CS / APPLY_AMAZON_DELIVERY_TOTAL_CS / APPLY_INSTAGRAM_CLEANER_CS──▶
                          各 Content Script

[音量ブースター]
  Popup ──VOLUME_BOOSTER_SET_GAIN──▶ Background
                                    │ chrome.tabCapture.getMediaStreamId
                                    ──ACTION_VOLUME_SET_GAIN──▶ Offscreen Document
                                                                  │ getUserMedia + AudioContext
                                                                  │ source → GainNode → normalizerNode (DynamicsCompressor) → antiClipNode (DynamicsCompressor) → destination
                                                                  └ 増幅 + 圧縮して再出力
```

### セッション維持の仕組み

- `setInterval` ベースのポーラーで合成アクティビティ束（`mousemove` / `pointermove` / `scroll` / `focus`）を dispatch し、同一オリジン HTTP ping を補助的に発射
- SharePoint は専用 GET、その他サイトは軽量 `HEAD` fallback を使う
- 同一オリジン iframe での多重発射はクロスオリジン判定で回避
- Memory Saver で freeze されたタブでは自然停止

### 音量ブースターの仕組み

- Chrome は 1 拡張あたり 1 つの offscreen document しか開けないため、`tabCapture` (USER_MEDIA) と AudioContext 出力 (AUDIO_PLAYBACK) を同居させる
- スライダーが UNITY (100%) の値の場合、`getMediaStreamId` を呼ばず AudioContext を release してリソース返却
- タブを閉じると `chrome.tabs.onRemoved` で即座に release（永続的に発火する API のため Service Worker 再起動の影響を受けない）
- 音量ブースト中は offscreen のアイドル close を抑止し、AudioContext を保持し続ける

## プライバシー

- 個人情報の収集は一切行いません
- すべての処理はユーザーの端末内で完結します
- 詳細は [プライバシーポリシー](docs/privacy-policy.md) を参照

## ライセンス

[MIT License](LICENSE)
