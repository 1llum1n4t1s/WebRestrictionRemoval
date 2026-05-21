# 📖 WEB閲覧アシスト

> [English version](README.en.md) is also available.

Web ブラウジングを快適にする 12 機能（**セッション維持** / **YouTube クリーナー（Shorts 削除・コメント欄非表示・ライブチャット非表示・登録チャンネル拡張を含む 30 サブ機能）** / **Amazon 定期おトク便 月別合計** / **Amazon ランキングへ移動ボタン** / **Instagram クリーナー（11 サブ機能）** / **TikTok クリーナー（3 サブ機能）** / **音量ブースター** / **動画ガンマ補正** / **動画の黒帯除去** / **ルーペ** / **RTX 動画強化** / **カラーピッカー**）を 1 つのポップアップに統合した Chrome 拡張機能です。**画像ダウンロードボタン（Instagram / TikTok 共通）** も各クリーナーのサブ機能として利用できます。

> **v1.0.18 までの主な変更点**: 「制限解除（右クリック / 選択 / 強制ペースト・コピー）」機能を全面廃止し、Web 閲覧支援機能のみに特化しました。あわせて拡張機能名を「**WEB制限解除サポート**」から「**WEB閲覧アシスト**」に変更しています。バージョン番号は `/vava` スキル経由でリリース時に確定します。

## 機能

### 🔄 セッション維持（オプトイン、デフォルト OFF）

企業の SharePoint / Box 等で頻繁に起こるセッションタイムアウトを緩和します。

| 動作 | 説明 |
|------|------|
| 合成アクティビティ（デフォルト） | ポップアップで有効化した現在のサイト（origin）の top frame だけで、定期的に `mousemove` / `pointermove` / `scroll` / `focus` を安全寄りに dispatch して JS 側のアイドル検知をリセット。ネットワーク通信は発生しない |
| 同一オリジン ping（オプトイン・デフォルト OFF） | サブトグル「サーバーへの軽量 ping を併発」を ON にした場合のみ、有効化したサイトの top frame から、SharePoint (`*.sharepoint.{com,cn,de,us}`) では `/_api/web` に GET、その他サイトでは現在 URL / origin root に軽量 `HEAD` を試してサーバー側セッション維持を補助 |
| 間隔設定 | ポップアップのスライダーで 1〜15 分の範囲で調整可能（デフォルト 4 分） |

外部（第三者）サーバーへの通信は発生せず、HTTP ping をオンにした場合でもユーザーが有効化したサイト自身への同一オリジン `HEAD` / `GET` のみです。

**HTTP ping をデフォルト OFF にしている理由**: 認証プロキシ環境（Zscaler 等）では `/_api/web` への自動アクセスが 401/302 ループを誘発したり、企業の SIEM/WAF ログにアラートを残すことがあるため、副作用を理解したユーザーのみが有効化する設計にしています。

**制限事項**: サーバー側セッション維持は同一オリジン ping が実際に認証基盤まで届くサイトでのみ有効です。`HEAD` を受け付けないサイト、Service Worker でローカル応答されるサイト、認証プロキシが別レイヤーで idle timeout を持つ環境、あるいはタブが Memory Saver で freeze されるケースでは、本機能を有効にしていても再ログインが発生することがあります。

### 🧹 YouTube クリーナー（オプトイン、デフォルト OFF）

YouTube の検索結果・動画ページ・ホームグリッドのクリーンアップを行う **30 個のサブ機能**（うち登録チャンネル拡張 3 機能）+ **ホームグリッド列数** を細かく設定できます。各サブ機能は 1 行 1 トグル + 詳細説明文の縦積みレイアウトで表示され、何が起きるかが事前にわかります。

- 📺 **サイト全体**: Shorts 削除（サイドバー / 棚 / チップ削除 + `/shorts/<id>` → `/watch?v=<id>` リダイレクト）
- 🗑️ **検索結果ノイズ**: 動画棚 / カードリスト / プレイリスト / ミックス / コース / チャンネル / Shorts 棚 / Shorts 動画 / ライブ / 関連検索ブロック
- 🚫 **動画属性で削除**: 認証 / アーティスト / 視聴済み / チャプター付き
- ✨ **ハイライト**: キーワード非マッチをグレー化 / サムネ枠装飾
- 🎬 **動画ページ**: コメント欄非表示 / ライブチャット欄非表示
- 📐 **レイアウト**: 検索結果グリッド表示 + ホーム列数（自動 / 4 / 5 / 6 列）
- 📋 **登録チャンネル拡張**:
    - **左メニューに全件展開**: YouTube が表示上限で隠す登録チャンネルも全件 leftnav に inline 注入（/feed/channels から同一オリジン取得、`sessionStorage` に 24h キャッシュ）
    - **「すべての登録チャンネル」ショートカット**: 左サイドバー「登録チャンネル」セクション内、見出し直下にチャンネルリストの最上 entry として `/feed/channels` への 1 クリックエントリを公式メニュー風に追加
    - **/feed/channels グリッド化**: 縦長 1 列を動画 feed と同様のレスポンシブグリッドに変形 + 検索ボックスで絞り込み（並び順は YouTube ネイティブの sort dropdown を使用）。各カードは viewport 進入時に lazy fetch でチャンネルページ HTML 内の Featured 動画 `videoId` を抽出して `i.ytimg.com/vi/{videoId}/maxresdefault.jpg` (16:9, 1280x720) を表示、`mqdefault.jpg` フォールバック付き、24h キャッシュ

### 📦 Amazon 定期おトク便 月別合計（オプトイン、デフォルト OFF）

`https://www.amazon.co.jp/auto-deliveries` ページで配送月ごとの合計金額を表示します。MutationObserver は disconnect → 書き込み → 再接続パターンで動作し、自身の DOM 書き込みによる再発火を防止しています。

### 🏆 Amazon ランキングへ移動ボタン（オプトイン、デフォルト OFF）

Amazon 商品ページの商品詳細欄にある「Amazon 売れ筋ランキング」リンクは商品ごとに出現位置がバラバラで探しにくいので、商品情報の最上部に「この商品が所属するランキングへ移動」ボタンを集約表示します。クリックで**一番細かいサブカテゴリ**のランキングへ同じタブで移動します。商品詳細コンテナ内の `a[href*="bestsellers/"]` だけを走査して移動先（ノード id を持つサブカテゴリのうち DOM 上で最後のもの）を選ぶため、ランキングリンクを持つ商品ページでのみボタンが出ます。純粋 DOM 操作のみで価格・履歴の取得や外部送信は一切行いません。

### 📷 Instagram クリーナー（オプトイン、デフォルト OFF）

Instagram の冗長 UI を一括非表示にする **11 個のサブ機能** を提供します（独自実装）。`aria-label` / `href` / `role` / `data-pagelet` / SVG path data などの意味論的属性ベースのセレクタで構成し、難読化 class 名（build ごとに変わる）への依存を避けています。

- 🚫 **主要機能**: Reels 削除（URL リダイレクト含む）/ Explore 削除 / ストーリー段非表示 / Stories URL ホーム遷移 / Threads 誘導非表示
- ✂️ **追加機能**: いいね数・フォロワー数非表示 / 投稿内動画ブロック / コメント欄非表示 / Notes 非表示 / 新規メッセージカウンター非表示 / 画像ダウンロードボタン

### 🎵 TikTok クリーナー（オプトイン、デフォルト OFF）

TikTok の冗長 UI を一括非表示にする **3 個のサブ機能** を提供します（独自実装）。`data-e2e` / `[class*="DivBrowserModeContainer"]` などの意味論セレクタで構成し、難読化 class 名（build ごとに変わる）への依存を避けています。

- 🚫 **主要機能**: コメント欄非表示 / おすすめのアカウント非表示 / 画像ダウンロードボタン

photo / video の直接 URL アクセス時 (`/@user/photo/...`) は右パネル全体を非表示にする「シンプル方式」、modal viewer (Browser Mode) では `DivCommentListContainer` のみピンポイント非表示でプロフィール / キャプションを温存します。

### 📥 画像ダウンロード（Instagram / TikTok 共通サブ機能）

Instagram / TikTok クリーナーに含まれる `imageDownload` サブ機能を ON にすると、コンテンツ画像（投稿写真 / 動画サムネ）にホバー時、左上にダウンロードボタンが overlay 表示されます。クリックで Blob URL + `<a download>` 経由で `{サービス}_{YYYYMMDD_HHMMSS}.{ext}` 形式で保存します（`downloads` permission 追加なし）。YouTube では本機能は提供されません。

各サイトの正規 CDN（`*.cdninstagram.com` / `scontent-*.fna.fbcdn.net` / `*.tiktokcdn.com` / `*.tiktokcdn-us.com` 等）への fetch のみ許可し、それ以外のオリジンへの代理 fetch は遮断します。fetch は `credentials: "omit"` + `redirect: "manual"` + `referrerPolicy: "no-referrer"` の 3 点セットでクロスオリジン認証情報送信を回避します。

### 🔊 音量ブースター（オプトイン、デフォルト OFF）

アクティブタブの音量を **0〜300%** で増幅します。**マスタートグル付き**で、ON のときに 0〜300% スライダーが有効化され、設定（gain 値・サブトグル・ミュート）はグローバル永続化されます。スライダーが 100% かつ全サブトグル OFF かつミュート OFF のときは AudioContext を解放してリソースを返却し、それ以外の値で増幅処理を起動します。サブトグル「自動歪み防止」「自動音量正規化」「ナイトモード」（いずれもデフォルト OFF）で各音響ノードが個別に有効化されます。スライダーの左端の **ミュート 🔊/🔇 ボタン** はスライダー値・サブトグル設定を保持したまま gain だけ 0 にランプし、再クリックで元の音量に復帰します（Chrome 標準のタブミュートとは独立レイヤとして動作）。自動音量正規化は `AnalyserNode` による短時間 RMS 測定 + 自動 `GainNode` で実装し、自動歪み防止とナイトモードは `DynamicsCompressor` で実装します。

| 動作 | 説明 |
|------|------|
| 取得 | `chrome.tabCapture.getMediaStreamId` で active tab の音声 stream を取得 |
| 処理 | offscreen ドキュメント内の `AudioContext` で `source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination` の 6 ノードチェーンを構築し、ラウドネス補正・圧縮・ユーザー gain・リミッタを順に適用して `destination` に再出力 |
| ミュート | `gainNode.gain` を 0 にランプ（`lastSetPercent` は保持）。AudioContext は維持されたままで再クリック時に高速復帰 |
| 解放 | マスタートグル OFF / スライダー 100% かつ全サブトグル OFF かつミュート OFF / タブを閉じる / 拡張機能を無効化 で即時 release |

### 🎞️ 動画ガンマ補正（オプトイン、デフォルト OFF）

ページ上の `<video>` 要素にガンマ補正を適用します（SVG `<feComponentTransfer type="gamma">` ベースの独自実装）。マスタートグル + スライダー構成で、スライダーは中央 (1.0) が補正なし、左に動かすほど暗く（最大 3.0）、右に動かすほど明るく（最小 0.3）。全タブ共通設定で、iframe 内の `<video>`（YouTube 埋め込み等）にも `all_frames: true` で同じ補正が当たります。

### 🖥️ 動画の黒帯除去（オプトイン、デフォルト OFF）

ウルトラワイドモニターなどで動画の上下／左右に出る黒帯（レターボックス / ピラーボックス）を、**ズーム**（アスペクト維持で拡大クロップ）または**引き伸ばし**（不足軸のみ拡大）で除去して画面いっぱいに表示します。マスタートグル + 表示モード選択 + 目標モニターのプリセット構成で、動画側の縦横比は `videoWidth` / `videoHeight` から自動検出します。全タブ共通設定で、iframe 内の `<video>` にも `all_frames: true` で同じ処理が当たります。

### 🔍 ルーペ（オプトイン、デフォルト OFF）

マウスカーソルに追従する円形拡大鏡。ポップアップでマスタートグルを ON にすると、現在のタブの静止画 (JPEG) を `chrome.tabs.captureVisibleTab` で取得し、円形レンズの背景画像として表示します。`mousemove` で `background-position` をリアルタイム計算 (60fps、`requestAnimationFrame` コアレス) してカーソル下の領域を拡大します。動画 / iframe / canvas を含む描画ピクセルがそのまま映るため、**動画を一時停止して細部を確認** する用途に最適です。

| 動作 | 説明 |
|------|------|
| 倍率 | 1.5× / 2.5× / 4× の 3 段階。ポップアップのセグメントコントロールで選択 |
| レンズサイズ | 150〜1000px の範囲でスライダー可変（デフォルト 220px） |
| OFF 操作 | レンズ表示中に画面上で **左クリック** → 即座にレンズ撤去 + ポップアップのトグルも OFF 状態に書き戻し |
| 再キャプチャ | 初回 / スクロール (500ms debounced) / DOM 大幅変化 (`MutationObserver`) / ウィンドウリサイズで自動 |
| メモリ | 取得した JPEG は Blob URL に変換し、OFF 時に `URL.revokeObjectURL` で確実に解放 |

※ Chrome の `captureVisibleTab` は 2fps 上限があるため、スクロール / DOM 変化後の再キャプチャは最大 500ms 遅延します。これは仕様で、動画停止 → 確認 → 動かす、というワークフローでは違和感ありません。

### 🎨 カラーピッカー（常時利用可）

ポップアップの「カラーピッカー」タブから `EyeDropper` API で画面上の色を採取し、HEX / RGB / HSL の 3 形式でクリップボードにコピーできます。HEX に `#` を含めるかどうかも個別に切替可能。採取した色は最大 20 件の標本箱（履歴）として `chrome.storage.local` 内にのみ保存され、外部送信は一切行いません。

## 使い方

1. 拡張機能アイコンをクリックしてポップアップを開く
2. 各機能のトグルで ON/OFF を切替（即時適用）
3. 音量ブースターはスライダーで増幅率を直接調整
4. カラーピッカーは「カラーピッカー」タブで `EyeDropper` を起動

設定は `chrome.storage.local` に保存され、次回以降も維持されます。**初回インストール時のデフォルトはマスタートグル全て OFF**（セッション維持 OFF / YouTube クリーナー OFF / Amazon 合計 OFF / Instagram クリーナー OFF / TikTok クリーナー OFF / 音量ブースター OFF / 動画ガンマ補正 OFF / ルーペ OFF / RTX 動画強化 OFF）。インストール直後にサイト挙動を勝手に書き換えないオプトイン方針です。音量ブースターはマスター OFF または「マスター ON かつスライダー 100% かつ全サブトグル OFF かつミュート OFF」の状態で AudioContext を解放しリソースを返却します。

## インストール

### Chrome Web Store から

[Chrome Web Store](https://chrome.google.com/webstore) で「WEB閲覧アシスト」を検索してインストール。

### Firefox AMO から

[addons.mozilla.org](https://addons.mozilla.org/) で「Web Viewing Assist」を検索してインストール (Firefox 140 以降)。Firefox 版は音量ブースター機能を除く 11 機能を提供します。

### 開発版を手動インストール

**Chrome**:
1. このリポジトリをクローン
2. `chrome://extensions/` を開く
3. 「デベロッパー モード」を ON
4. 「パッケージ化されていない拡張機能を読み込む」でプロジェクトフォルダを選択

**Firefox**:
1. `powershell -ExecutionPolicy Bypass -File zip.ps1 -Target firefox` (Win) または `./zip.sh firefox` (Unix) で `web-viewing-assist-firefox.xpi` を生成
2. `about:debugging#/runtime/this-firefox` を開く → 「一時的なアドオンを読み込む」で xpi を選択 (Firefox 再起動でアンロードされる)
3. または `about:addons` → ⚙ → 「ファイルからアドオンをインストール」(署名済み xpi のみ、開発中は前者推奨)

## ビルド

```bash
npm install
npm run build                # アイコン + スクリーンショット一括生成
npm run generate-icons       # アイコンのみ生成
npm run generate-screenshots # スクリーンショットのみ生成
```

### ストア申請用パッケージ生成

```bash
# Chrome + Firefox 両方
powershell -ExecutionPolicy Bypass -File zip.ps1                  # Win
bash ./zip.sh                                                      # Unix

# Chrome のみ
powershell -ExecutionPolicy Bypass -File zip.ps1 -Target chrome
bash ./zip.sh chrome

# Firefox のみ (xpi 出力)
powershell -ExecutionPolicy Bypass -File zip.ps1 -Target firefox
bash ./zip.sh firefox
```

生成物:
- `web-viewing-assist-chrome.zip` — Chrome Web Store 用 (12 機能、音量ブースター込み)
- `web-viewing-assist-firefox.xpi` — Firefox AMO 用 (11 機能、音量ブースター除外)

旧名 `web-viewing-assist.zip` を期待する CI workflow (publish.yml) は本リポジトリでは別名を使ってるので影響なし。

### CI 自動公開

`release/<X.Y.Z>` ブランチを push すると、GitHub Actions が:
1. **Chrome Web Store** へ Submit for review (`web-viewing-assist.zip`)
2. **Firefox AMO** へ submission API で submit (`web-ext sign --channel=listed`)

を並列実行します。必要 GitHub Secrets:
- Chrome: `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` / `CWS_EXTENSION_ID`
- Firefox: `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` ([発行ページ](https://addons.mozilla.org/ja/developers/addon/api/key/))

Chrome publish が失敗 (同 version 重複 upload 等) しても Firefox AMO step は `if: success() || failure()` で独立実行されます。

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
                        ──APPLY_KEEP_ALIVE_CS / APPLY_SEARCH_FIXER_CS / APPLY_AMAZON_DELIVERY_TOTAL_CS / APPLY_INSTAGRAM_CLEANER_CS / APPLY_VIDEO_GAMMA_CS──▶
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

### セッション維持の仕組み

- `setInterval` ベースのポーラーで、有効化済み origin の top frame だけに合成アクティビティ束（`mousemove` / `pointermove` / `scroll` / `focus`）を dispatch し、同一オリジン HTTP ping を補助的に発射
- SharePoint は専用 GET、その他サイトは軽量 `HEAD` fallback を使う
- 同一オリジン iframe での多重発射はクロスオリジン判定で回避
- Memory Saver で freeze されたタブでは自然停止

### 音量ブースターの仕組み

- Chrome は 1 拡張あたり 1 つの offscreen document しか開けないため、`tabCapture` (USER_MEDIA) と AudioContext 出力 (AUDIO_PLAYBACK) を同居させる
- スライダーが UNITY (100%) かつ全サブトグル (自動歪み防止 / 自動音量正規化 / ナイトモード) が OFF かつミュート OFF の場合のみ、`getMediaStreamId` を呼ばず AudioContext を release してリソース返却。100% でもサブトグルまたはミュートが ON なら AudioContext を維持して自動補正・消音を効かせる
- タブを閉じると `chrome.tabs.onRemoved` で即座に release（永続的に発火する API のため Service Worker 再起動の影響を受けない）
- 音量ブースト中は offscreen のアイドル close を抑止し、AudioContext を保持し続ける

## プライバシー

- 個人情報の収集は一切行いません
- すべての処理はユーザーの端末内で完結します
- 詳細は [プライバシーポリシー](docs/privacy-policy.md) を参照

## ライセンス

[MIT License](LICENSE)
