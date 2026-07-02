# プライバシーポリシー - Vuora

> [English version](privacy-policy.en.md) is also available.

最終更新日: 2026年6月6日

## はじめに

「Vuora」（旧称: WEB閲覧アシスト / WEB制限解除サポート、以下「本拡張機能」）は、ユーザーのプライバシーを尊重し、個人情報の保護に努めます。本プライバシーポリシーは、本拡張機能におけるデータの取り扱いについて説明します。

## 収集するデータ

本拡張機能は、個人情報を一切収集しません。

## ローカルに保存するデータ

本拡張機能は、以下の設定データをユーザーの端末内（`chrome.storage.local`）にのみ保存します。

- **`searchFixerEnabled`**（真偽値）: YouTube クリーナー（Shorts 削除・コメント欄非表示・ライブチャット非表示・登録チャンネル拡張・接続モニターを含む 32 サブ機能の親）の有効/無効。
- **`searchFixerFeatures`**（オブジェクト）: YouTube クリーナーの 31 個のサブ機能（Shorts 削除 / 検索結果ノイズ除去 / 動画属性削除 / ハイライト / 動画ページ整形〈コメント欄非表示・ライブチャット非表示〉/ レイアウト / 登録チャンネル拡張 / 接続モニター）の個別 ON/OFF 状態。
- **`searchFixerGridItems`**（数値）: YouTube ホームグリッドの列数指定（0=自動 / 4 / 5 / 6）。
- **`amazonDeliveryTotalEnabled`**（真偽値）: Amazon 定期おトク便ページの月別合計表示機能の有効/無効。
- **`amazonRankingJumpEnabled`**（真偽値）: Amazon 商品ページの「この商品が所属するランキングへ移動」ボタンの有効/無効。デフォルト OFF。
- **`instagramCleanerEnabled`**（真偽値）: Instagram クリーナー機能の有効/無効。
- **`instagramCleanerFeatures`**（オブジェクト）: Instagram クリーナーの 11 個のサブ機能（Reels 削除 / Explore 削除 / ストーリー段非表示 / Stories URL ホーム遷移 / Threads 誘導非表示 / いいね数・フォロワー数非表示 / 投稿内動画ブロック / コメント欄非表示 / Notes 非表示 / 新規メッセージカウンター非表示 / 画像ダウンロードボタン）の個別 ON/OFF 状態。
- **`tiktokCleanerEnabled`**（真偽値）: TikTok クリーナー機能の有効/無効。
- **`tiktokCleanerFeatures`**（オブジェクト）: TikTok クリーナーの 3 個のサブ機能（コメント欄非表示 / おすすめのアカウント非表示 / 画像ダウンロードボタン）の個別 ON/OFF 状態。
- **`volumeBoosterEnabled`**（真偽値）: 音量ブースターのマスタートグル。デフォルト OFF。
- **`volumeBoosterLastGain`**（数値・0〜600）: 音量ブースターのスライダー位置（%）。デフォルト 100。
- **`volumeBoosterAntiClipEnabled`**（真偽値）: 音量ブースターのサブトグル「自動歪み防止」（高速リミッタとして動作する `DynamicsCompressor`）の有効/無効。デフォルト OFF。
- **`volumeBoosterNightModeEnabled`**（真偽値）: 音量ブースターのサブトグル「ナイトモード」（夜間視聴向けにダイナミックレンジを圧縮する `DynamicsCompressor`）の有効/無効。デフォルト OFF。
- **`volumeBoosterMutedEnabled`**（真偽値）: 音量ブースターのミュートトグル。ON のときスライダー値・サブトグル設定を保持したまま `GainNode` を 0 にランプして消音します（AudioContext は維持され、解除時に高速復帰）。デフォルト OFF。
- **`volumeBoosterEqEnabled`**（真偽値）: 音量ブースターのサブ機能「10 バンドグラフィックイコライザ」（`BiquadFilterNode(type:"peaking")` × 10 + プリアンプ `GainNode`）の有効/無効。デフォルト OFF。
- **`volumeBoosterEqGains`**（数値配列・10 要素・各 -12〜+12 dB）: イコライザ各バンドの gain。バンド中心周波数は 32 / 64 / 125 / 250 / 500 / 1K / 2K / 4K / 8K / 16K Hz。デフォルトは全 0 dB（フラット）。
- **`volumeBoosterEqPreamp`**（数値・-12〜+12 dB）: イコライザのプリアンプ（全体ゲイン補正）。デフォルト 0 dB。
- **`volumeBoosterEqPreset`**（文字列）: 選択中のプリセット id（`flat` / `bassBoost` / `trebleBoost` / `vocal` / `loudness` / `custom`）。デフォルト `flat`。スライダーを手動操作すると自動で `custom` に切り替わります。
- **`loupeEnabled`**（真偽値）: ルーペ機能のマスタートグル。デフォルト OFF。
- **`loupeZoom`**（数値）: ルーペの倍率。1.5 / 2.5 / 4.0 のいずれか。デフォルト 2.5。
- **`loupeSize`**（数値・150〜1000 / 10px step）: ルーペのレンズ直径 (px)。デフォルト 220。
- **`videoGammaEnabled`**（真偽値）: 動画ガンマ補正のマスタートグル。デフォルト OFF。
- **`videoGammaValue`**（数値・0.3〜3.0）: 動画ガンマ補正のガンマ値。デフォルト 1.0（補正なし）。
- **`videoFillEnabled`**（真偽値）: 動画の黒帯除去のマスタートグル。デフォルト OFF。
- **`videoFillMode`**（文字列・`"zoom"` / `"stretch"`）: 動画の黒帯除去の表示モード（ズーム / 引き伸ばし）。
- **`videoFillTarget`**（文字列）: 動画の黒帯除去の目標モニター縦横比プリセット id。
- **`colorPickerHistory`**（配列・最大 20 件）: カラーピッカーで採取した色の履歴。各要素は `{ hex, ts }` の形式で、`hex` は `#RRGGBB`、`ts` は採取時刻のタイムスタンプ。
- **`colorPickerDefaultFormat`**（文字列・`"hex"` / `"rgb"` / `"hsl"` のいずれか）: カラーピッカーで採取した色のクリップボード既定形式。
- **`colorPickerHexHash`**（真偽値・デフォルト true）: HEX 形式でコピーする際に先頭の `#` を含めるかどうか。
- **`popupLastTab`**（文字列・`"tune"` / `"youtube"` / `"instagram"` / `"tiktok"` / `"picker"` のいずれか）: ポップアップで最後に開いていたタブ。次回起動時の表示状態復元に使用。旧値 `"assist"` は `"tune"` に自動変換されます。

これらの値は端末内にのみ保存され、外部サーバーへの送信は一切行いません。

なお、音量ブースター機能の現在 gain 値（タブごと）はオフスクリーン ドキュメントのメモリ上にのみ保持され、永続化されません。タブを閉じる、スライダーを 100% に戻して全サブトグル・ミュートを OFF にする、または拡張機能を無効化すると即座に解放されます。

## タブ音声へのアクセス

「音量ブースター」のスライダーが 100% 以外の値に設定されている場合、または 100% のままでも自動歪み防止 / ナイトモード / イコライザのいずれかを有効にした場合のみ、`chrome.tabCapture` API でアクティブタブの音声ストリームを取得し、オフスクリーン ドキュメント内の `AudioContext` で増幅・圧縮・周波数調整を行って再出力します。音声データは外部に送信されず、録音・保存も一切行いません。タブを閉じる、スライダーを 100% に戻して全サブトグルを OFF にする、または拡張機能を無効化すると即座にストリームは解放されます。

**Firefox 版**は `chrome.tabCapture` が利用できないため、代わりに**ページ内の Web Audio 処理（MediaElementSource）**を使用します。音量ブースターが有効なときのみ、ページ内の `<video>` / `<audio>` 要素の音声出力を同じページ内の `AudioContext` に接続して増幅・圧縮・周波数調整を行います。処理はすべて当該ページ内で完結し（オフスクリーン ドキュメントもタブ音声ストリームの取得も使いません）、音声データの録音・保存・外部送信は一切行いません。設定を等倍へ戻す・マスタートグルを OFF にする・ページを閉じると処理は即座に無効化されます。DRM 保護動画のサイトでは本処理は行いません。

## タブ画面（スクリーンキャプチャ）へのアクセス

「ルーペ」機能のマスタートグルを ON にしている間のみ、`chrome.tabs.captureVisibleTab` API で**アクティブタブの可視領域**を JPEG 静止画として取得し、円形レンズの拡大鏡として content script の DOM 上で表示します。取得した画像データは Blob URL に変換され、現在のタブの content script 内でのみ参照されます。拡張機能のメモリ外（外部サーバー / ローカルファイル / クリップボード等）には一切送信・保存しません。マスタートグルを OFF にする、画面を左クリックする、タブをバックグラウンドにする、または拡張機能を無効化した時点で、保持していた Blob URL は `URL.revokeObjectURL` で即座に解放されます。再キャプチャはユーザーがスクロールした際 / DOM 構造が大きく変化した際 / ウィンドウをリサイズした際に 500ms の debounce を経て自動的に発火し、Chrome 公式の 2fps レート上限の範囲内で実行されます。

## データの共有

本拡張機能は、いかなるデータも第三者と共有しません。

## ネットワーク通信

本拡張機能は、以下に明示する 2 つの例外を除き、第三者の外部サーバーへの通信を一切行いません。

### 例外 1: 画像ダウンロード（Instagram / TikTok クリーナーのサブ機能）

Instagram / TikTok クリーナーのサブ機能「画像にダウンロードボタンを表示」（オプトイン・デフォルト OFF）を有効化した場合、ユーザーがダウンロードボタンをクリックした瞬間にのみ、各サイトの正規 CDN（Instagram: `scontent-*.cdninstagram.com` / `scontent-*.fna.fbcdn.net`、TikTok: `p<数字>.tiktokcdn.com` / `p<数字>.tiktokcdn-us.com`）に対して画像 GET を発行します。これは現にブラウザが `<img>` タグでロードしているドメインと同一であり、`credentials: "omit"` でクッキーは送信せず、`redirect: "manual"` で 302 経由の第三者ドメイン送信を遮断し、`referrerPolicy: "no-referrer"` でリファラ送信もゼロにします。それ以外のオリジンへの代理 fetch はホスト名ホワイトリストで遮断します（YouTube では本機能は提供されません）。ダウンロードした画像は Blob URL + `<a download>` 経由でローカルに保存されるのみで、外部送信は一切行いません。

### 例外 2: 接続モニター（YouTube クリーナーのサブ機能）

YouTube クリーナーのサブ機能「接続モニター」（`searchFixerFeatures.connectionMonitor`、オプトイン・デフォルト OFF）を有効化し、かつ YouTube のライブ配信を視聴している間のみ、ライブ配信視聴中のバッファリング原因（自分の回線 / 端末性能 / YouTube CDN / 国際線経路 / etc.）を切り分ける in-player HUD のために、以下 2 つの公開ヘルスチェック endpoint への RTT 計測 fetch を 5 秒周期で発行します。

- `https://www.gstatic.com/generate_204` — Google エッジへの到達時間計測
- `https://speed.cloudflare.com/__down?bytes=10` — Cloudflare（国際線ベースライン）への到達時間計測

これらの fetch は以下のプライバシー設定で実行されます。

- `mode: "no-cors"`: レスポンス本文は **読み取り不能** (opaque response) としてブラウザに渡され、本拡張機能は到達時間 (`performance.now()` の差分) しか測定しません
- `credentials: "omit"`: クッキーは送信しません
- `referrerPolicy: "no-referrer"`: リファラを送信しません
- `AbortSignal.timeout(4500)`: 4.5 秒で必ず abort されます

**送信される情報は「Vuora が ON であるという事実」と「視聴中のおおよその時刻」のみ**であり、ユーザー識別子・クッキー・YouTube 視聴履歴・チャンネル名・動画 ID・自分の IP アドレス以外の個人データは一切送信されません（IP アドレスは HTTP リクエスト送信時に通信プロトコル上必然的に対向サーバーへ届きますが、これは通常の Web ブラウジング全般と同等の性質です）。送信先 URL は `actions.js` の定数として固定されており、ユーザー操作や設定では変更できません（テストで値固定をアサート済み）。endpoint は Google と Cloudflare が一般公開している計測用エンドポイントであり、Vuora 専用に運用するサーバーは存在しません。

接続モニターサブ機能 OFF 時 / YouTube クリーナーのマスタートグル OFF 時 / YouTube ライブ視聴中以外（VOD 動画視聴中 / 別ページ閲覧中）には、これらの fetch は **一切発行されません**。計測した RTT 値は content script スコープのメモリ ring buffer (最大 6 サンプル / 30 秒分) にのみ保持され、永続化されません。マスター OFF / サブ機能 OFF / overlay 撤去で即座に破棄されます。

## 権限の使用目的

- **activeTab**: ポップアップで設定を変更した際、現在のタブ情報（音量ブースターの対象タブ判定など）にアクセスするために使用します。
- **storage**: 上記「ローカルに保存するデータ」の各キーを端末内に保存・復元するために使用します。
- **offscreen**（Chrome 版のみ。Firefox 版の manifest には含まれません）: 音量ブースターの `AudioContext` を Service Worker のライフサイクル外で維持するために、オフスクリーン ドキュメント（extension コンテキスト）を利用します。
- **tabCapture**（Chrome 版のみ。Firefox 版の manifest には含まれません）: 音量ブースターのスライダーが 100% 以外の値に設定されている場合、または 100% のままでも自動歪み防止 / ナイトモード / ミュート / イコライザのいずれかが有効な場合に、アクティブタブの音声ストリームを取得して `AudioContext` で増幅・圧縮・周波数調整・消音を行うために使用します。録音・保存・外部送信は一切行いません。
- **`<all_urls>` ホスト権限**: ルーペ機能で `chrome.tabs.captureVisibleTab` によりアクティブタブの可視領域を JPEG 静止画として取得し、円形レンズに拡大表示するために使用します。`activeTab` 権限のみでは、ポップアップを閉じた後 / SPA ページで内部 navigation が発生した後に grant が早期失効してキャプチャがブロックされる事例があるため、ルーペ機能を確実に動作させる目的で追加しています。取得した静止画は端末内の Blob URL として保持され、レンズ DOM 撤去と同時に `URL.revokeObjectURL` で解放されます。外部送信・保存は一切行いません。なお本拡張機能は既に content_scripts として全 http(s) サイトに DOM/CSS 操作のスクリプトを注入しており、`<all_urls>` ホスト権限の追加でアクセス可能になる範囲は実質変わりません。

## v1.0.18 までの主な変更点（適用済み）

v1.0.x の旧バージョンが提供していた「右クリック解除 / テキスト選択解除 / 強制ペースト / 強制コピー / カスタム右クリック許可リスト」を含む「制限解除」機能は全て削除されました。それに伴い、`enabled` / `contextMenuAllowDomains` / `volumeBoosterEnabled` のストレージキーおよび `clipboardRead` / `clipboardWrite` / `contextMenus` / `scripting` 権限も削除されています。これら旧キーは自動アップデート時に Chrome の `chrome.storage.local.remove` で取り除かれます。

Instagram クリーナー機能（`instagramCleanerEnabled` / `instagramCleanerFeatures`）も同時に追加されました。いずれもデフォルト OFF（オプトイン）であり、ユーザーが有効化しない限り Instagram の表示には一切影響しません。Instagram クリーナーの動作はクライアント側の DOM 操作・CSS 適用のみで、外部サーバーへの送信は一切行いません。

YouTube Shorts 削除機能は YouTube クリーナーのサブ機能 `searchFixerFeatures.removeShorts` として統合されました。これに伴い旧 `ytShortsRemovalEnabled` ストレージキーも削除されています。アップデート時、旧キーが `true` だったユーザーは `searchFixerFeatures.removeShorts = true` および `searchFixerEnabled = true` に自動転写されてから旧キーが削除されるため、Shorts 削除動作は継続されます。

v1.0.18 以降、YouTube クリーナーに「コメント欄非表示」サブ機能（`searchFixerFeatures.hideComments`）が追加され、音量ブースターには自動歪み防止 / ナイトモードの各サブトグル（`volumeBoosterAntiClipEnabled` / `volumeBoosterNightModeEnabled` キー）と、`EyeDropper` API ベースのカラーピッカー機能（`colorPickerHistory` / `colorPickerDefaultFormat` / `colorPickerHexHash` キー）も追加されています。これらの新規キーはすべてデフォルト OFF または安全側のデフォルト値で、ユーザーが操作するまでサイト挙動には一切影響しません。

## お問い合わせ

本プライバシーポリシーに関するご質問は、Chrome Web Storeのサポートページよりお問い合わせください。

## 変更について

本プライバシーポリシーは予告なく変更される場合があります。変更があった場合は、本ページを更新します。
