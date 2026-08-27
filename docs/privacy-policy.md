# プライバシーポリシー - Vuora

> [English version](privacy-policy.en.md) is also available.

最終更新日: 2026年8月27日

## はじめに

「Vuora」（旧称: WEB閲覧アシスト / WEB制限解除サポート、以下「本拡張機能」）は、ユーザーのプライバシーを尊重し、個人情報の保護に努めます。本プライバシーポリシーは、本拡張機能におけるデータの取り扱いについて説明します。

## 収集するデータ

本拡張機能は、利用者が自分でお問い合わせフォームを送信したときを除き、個人情報を一切収集しません。フォームを送信したときだけ、入力されたメールアドレスと問い合わせ内容が開発者（Kagayoi）のサポート窓口へ送信されます（下記「例外 4: お問い合わせフォーム」を参照）。

## ローカルに保存するデータ

本拡張機能は、以下の設定データをユーザーの端末内（`chrome.storage.local`）にのみ保存します。

- **`searchFixerEnabled`**（真偽値）: YouTube 機能拡張（Shorts 削除・コメント欄非表示・ライブチャット非表示・登録チャンネル拡張・接続モニターを含む 34 サブ機能の親）の有効/無効。
- **`searchFixerFeatures`**（オブジェクト）: YouTube 機能拡張の 34 個のサブ機能（Shorts 削除 / 検索結果ノイズ除去 / 動画属性削除 / ハイライト / 動画ページ整形〈コメント欄非表示・ライブチャット非表示〉/ レイアウト / 登録チャンネル拡張 / 接続モニター）の個別 ON/OFF 状態。
- **`searchFixerGridItems`**（数値）: YouTube ホームグリッドの列数指定（0=自動 / 4 / 5 / 6）。
- **`searchFixerBlockedChannels`**（配列）: チャンネルブロックリスト機能で登録したチャンネルの識別子（ハンドルまたはチャンネル ID）と表示名のリスト。登録は検索結果のチャンネル名横に表示されるボタンから行い、登録済みチャンネルの動画は検索結果に加えホーム・登録チャンネル・急上昇等の YouTube フィードページ全体から除去されます。端末内にのみ保存され、外部送信は行いません。
- **`amazonDeliveryTotalEnabled`**（真偽値）: Amazon 定期おトク便ページの月別合計表示機能の有効/無効。
- **`amazonRankingJumpEnabled`**（真偽値）: Amazon 商品ページの「この商品が所属するランキングへ移動」ボタンの有効/無効。デフォルト OFF。
- **`instagramCleanerEnabled`**（真偽値）: Instagram クリーナー機能の有効/無効。
- **`instagramCleanerFeatures`**（オブジェクト）: Instagram クリーナーの 11 個のサブ機能（Reels 削除 / Explore 削除 / ストーリー段非表示 / Stories URL ホーム遷移 / Threads 誘導非表示 / いいね数・フォロワー数非表示 / 投稿内動画ブロック / コメント欄非表示 / Notes 非表示 / 新規メッセージカウンター非表示 / 画像ダウンロードボタン）の個別 ON/OFF 状態。
- **`tiktokCleanerEnabled`**（真偽値）: TikTok クリーナー機能の有効/無効。
- **`tiktokCleanerFeatures`**（オブジェクト）: TikTok クリーナーの 3 個のサブ機能（コメント欄非表示 / おすすめのアカウント非表示 / 画像ダウンロードボタン）の個別 ON/OFF 状態。
- **`xCleanerEnabled`**（真偽値）: X（旧 Twitter）クリーナー機能の有効/無効。デフォルト OFF。
- **`xCleanerFeatures`**（オブジェクト）: X クリーナーの 9 個のサブ機能（右ペイン非表示 / トレンド非表示 / おすすめユーザー非表示 / メッセージドック非表示 / プロモーション投稿非表示 / プレミアム勧誘非表示 / Grok 非表示 / 反応数非表示 / ホームを「フォロー中」で開く）の個別 ON/OFF 状態。すべて端末内の CSS 表示制御とタブ選択のみで、外部送信は行いません。
- **`volumeBoosterEnabled`**（真偽値）: 音量ブースターのマスタートグル。デフォルト OFF。
- **`volumeBoosterLastGain`**（数値・0〜600）: 音量ブースターのスライダー位置（%）。デフォルト 100。
- **`volumeBoosterAntiClipEnabled`**（真偽値）: 音量ブースターのサブトグル「自動歪み防止」（高速リミッタとして動作する `DynamicsCompressor`）の有効/無効。デフォルト OFF。
- **`volumeBoosterNightModeEnabled`**（真偽値）: 音量ブースターのサブトグル「ナイトモード」（夜間視聴向けにダイナミックレンジを圧縮する `DynamicsCompressor`）の有効/無効。デフォルト OFF。
- **`volumeBoosterBassCutEnabled`**（真偽値）: 音量ブースターのサブトグル「壁ドン対策モード」（低音をカットし壁・床への振動伝達を抑える `BiquadFilterNode(type:"highpass")`）の有効/無効。デフォルト OFF。
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

なお、**Chrome 版**では音量ブースター機能の現在 gain 値（タブごと）はオフスクリーン ドキュメントのメモリ上にのみ保持され、永続化されません。タブを閉じる、スライダーを 100% に戻して全サブトグル・ミュートを OFF にする、または拡張機能を無効化すると即座に解放されます。**Firefox 版**では現在 gain 値はページ内音声処理パイプライン（後述「タブ音声へのアクセス」参照）のメモリ上にのみ保持され、同様に永続化されません。

## タブ音声へのアクセス

「音量ブースター」のスライダーが 100% 以外の値に設定されている場合、または 100% のままでも自動歪み防止 / ナイトモード / イコライザのいずれかを有効にした場合のみ、`chrome.tabCapture` API でアクティブタブの音声ストリームを取得し、オフスクリーン ドキュメント内の `AudioContext` で増幅・圧縮・周波数調整を行って再出力します。音声データは外部に送信されず、録音・保存も一切行いません。タブを閉じる、スライダーを 100% に戻して全サブトグルを OFF にする、または拡張機能を無効化すると即座にストリームは解放されます。

**Firefox 版**は `chrome.tabCapture` が利用できないため、代わりに**ページ内の Web Audio 処理（MediaElementSource）**を使用します。音量ブースターが有効なときのみ、ページ内の `<video>` / `<audio>` 要素の音声出力を同じページ内の `AudioContext` に接続して増幅・圧縮・周波数調整を行います。処理はすべて当該ページ内で完結し（オフスクリーン ドキュメントもタブ音声ストリームの取得も使いません）、音声データの録音・保存・外部送信は一切行いません。設定を等倍へ戻す・マスタートグルを OFF にすると、増幅・圧縮・周波数調整はすべて即座に停止します（音声はそのまま素通しになります）。Firefox 固有の技術的制約により、内部の音声パイプライン自体は無音の状態でページ内に残置される場合があり、動画/音声要素がページから取り除かれるか、ページを閉じるまで解放されないことがあります（Firefox では再生中の要素の接続を外すと音声出力自体が止まってしまうため、切断せず残置する設計です）。DRM 保護動画のサイトでは本処理は行いません。

## タブ画面（スクリーンキャプチャ）へのアクセス

「ルーペ」機能のマスタートグルを ON にしている間のみ、`chrome.tabs.captureVisibleTab` API で**アクティブタブの可視領域**を JPEG 静止画として取得し、円形レンズの拡大鏡として content script の DOM 上で表示します。取得した画像データは Blob URL に変換され、現在のタブの content script 内でのみ参照されます。拡張機能のメモリ外（外部サーバー / ローカルファイル / クリップボード等）には一切送信・保存しません。マスタートグルを OFF にする、画面を左クリックする、タブをバックグラウンドにする、または拡張機能を無効化した時点で、保持していた Blob URL は `URL.revokeObjectURL` で即座に解放されます。再キャプチャはユーザーがスクロールした際 / DOM 構造が大きく変化した際 / ウィンドウをリサイズした際に 500ms の debounce を経て自動的に発火し、Chrome 公式の 2fps レート上限の範囲内で実行されます。

## データの共有

本拡張機能は、いかなるデータも第三者と共有しません。お問い合わせフォームから送信された内容は、返信のために開発者（Kagayoi）のサポート窓口でのみ取り扱います。

## ネットワーク通信

本拡張機能は、以下に明示する 4 つの例外を除き、外部サーバーへの通信を一切行いません。

### 例外 1: 画像ダウンロード（Instagram / TikTok クリーナーのサブ機能）

Instagram / TikTok クリーナーのサブ機能「画像にダウンロードボタンを表示」（オプトイン・デフォルト OFF）を有効化した場合、ユーザーがダウンロードボタンをクリックした瞬間にのみ、各サイトの正規 CDN（Instagram: `scontent-*.cdninstagram.com` / `scontent-*.fna.fbcdn.net`、TikTok: `p<数字>.tiktokcdn.com` / `p<数字>.tiktokcdn-us.com`）に対して画像 GET を発行します。これは現にブラウザが `<img>` タグでロードしているドメインと同一であり、`credentials: "omit"` でクッキーは送信せず、`redirect: "manual"` で 302 経由の第三者ドメイン送信を遮断し、`referrerPolicy: "no-referrer"` でリファラ送信もゼロにします。それ以外のオリジンへの代理 fetch はホスト名ホワイトリストで遮断します（YouTube では本機能は提供されません）。ダウンロードした画像は Blob URL + `<a download>` 経由でローカルに保存されるのみで、外部送信は一切行いません。

### 例外 2: 接続モニター（YouTube 機能拡張のサブ機能）

YouTube 機能拡張のサブ機能「接続モニター」（`searchFixerFeatures.connectionMonitor`、オプトイン・デフォルト OFF）を有効化し、かつ YouTube のライブ配信を視聴している間のみ、ライブ配信視聴中のバッファリング原因（自分の回線 / 端末性能 / YouTube CDN / 国際線経路 / etc.）を切り分ける in-player HUD のために、以下 2 つの公開ヘルスチェック endpoint への RTT 計測 fetch を 5 秒周期で発行します。

- `https://www.gstatic.com/generate_204` — Google エッジへの到達時間計測
- `https://speed.cloudflare.com/__down?bytes=10` — Cloudflare（国際線ベースライン）への到達時間計測

これらの fetch は以下のプライバシー設定で実行されます。

- `mode: "no-cors"`: レスポンス本文は **読み取り不能** (opaque response) としてブラウザに渡され、本拡張機能は到達時間 (`performance.now()` の差分) しか測定しません
- `credentials: "omit"`: クッキーは送信しません
- `referrerPolicy: "no-referrer"`: リファラを送信しません
- `AbortSignal.timeout(4500)`: 4.5 秒で必ず abort されます

**送信される情報は「Vuora が ON であるという事実」と「視聴中のおおよその時刻」のみ**であり、ユーザー識別子・クッキー・YouTube 視聴履歴・チャンネル名・動画 ID・自分の IP アドレス以外の個人データは一切送信されません（IP アドレスは HTTP リクエスト送信時に通信プロトコル上必然的に対向サーバーへ届きますが、これは通常の Web ブラウジング全般と同等の性質です）。送信先 URL は `actions.js` の定数として固定されており、ユーザー操作や設定では変更できません（テストで値固定をアサート済み）。endpoint は Google と Cloudflare が一般公開している計測用エンドポイントであり、Vuora 専用に運用するサーバーは存在しません。

接続モニターサブ機能 OFF 時 / YouTube 機能拡張のマスタートグル OFF 時 / YouTube ライブ視聴中以外（VOD 動画視聴中 / 別ページ閲覧中）には、これらの fetch は **一切発行されません**。計測した RTT 値は content script スコープのメモリ ring buffer (最大 6 サンプル / 30 秒分) にのみ保持され、永続化されません。マスター OFF / サブ機能 OFF / overlay 撤去で即座に破棄されます。

### 例外 3: Gemini Notebook 送信（YouTube 機能拡張のサブ機能）

YouTube 機能拡張のサブ機能「Gemini Notebook 送信」（`searchFixerFeatures.notebookLmSend`、オプトイン・デフォルト OFF）を有効化しているとき、Google の Gemini Notebook（`https://notebooklm.google.com`）に対して以下の通信を行います。

**Gemini Notebook から読み取るだけの通信**（送信ボタンが表示される対象ページで、選択肢を先に用意するために行います。YouTube の視聴内容・動画 URL・ユーザー識別子は一切送信しません）:

- ログイン中の Google アカウント一覧の取得（表示名としてメールアドレスを取り出すため。結果は端末内に最大 12 時間キャッシュします）
- ノートブック一覧の取得（送信先の選択肢を表示するため）

**ユーザーが送信ボタンを押して送信先を選んだ瞬間にのみ行う通信**:

- ノートブックの新規作成（「新しいノートブックを作成」を選んだとき）
- ソースの追加（選択した YouTube 動画の URL を送信）

複数の Google アカウントにログインしている場合、送信先アカウントはポップオーバーの「Google アカウント」欄で選べます（選択内容は端末内の `notebookLmAccountIndex` に保存され、外部送信はしません）。既定では通常ログインしているアカウント（authuser=0）が使われます。

**送信される情報は、ユーザーがそのとき選んだ YouTube 動画の URL（`https://www.youtube.com/watch?v=...` 形式に正規化したもの）と、新規作成時のノートブック名（ページタイトルまたは検索語から生成）のみ**です。視聴履歴の収集、バックグラウンドでの自動送信、ユーザー識別子の付与は一切行いません。送信先は Gemini Notebook 以外に存在せず、Vuora 専用に運用するサーバーもありません。

認証にはブラウザに既に保存されている Google のログインセッション（クッキー）を利用します。本拡張機能は Google の認証情報を読み取らず、保存もせず、他のいかなる宛先にも送信しません。Gemini Notebook にログインしていない場合、送信は失敗し、ログインを促す表示のみを行います。

Gemini Notebook には公開 API が存在しないため、通信には Gemini Notebook の Web アプリ自身が使用する内部エンドポイントを利用します。この仕様は Google 側の都合で予告なく変更される場合があり、その際は本機能が一時的に動作しなくなることがあります。

本サブ機能 OFF 時 / YouTube 機能拡張のマスタートグル OFF 時には、送信ボタン自体が表示されず、これらの通信は **一切発行されません**。

### 例外 4: お問い合わせフォーム

設定ポップアップ下部の「お問い合わせ」ボタンからフォームを送信したときだけ、次の情報を Kagayoi Support（`https://support.kagayoi.com`）へ送信します。ボタンを押さない限り、この通信は発生しません。

- 入力されたメールアドレス、お名前（任意）、問い合わせ種別、件名、本文
- 製品ID、拡張機能のバージョン、ロケール

初回はメールで届く6桁の確認コードを Kagayoi Support へ送信して本人確認します。認証後の問い合わせと返信は、利用者本人とサポート担当者が確認できるよう Kagayoi Support に保存します。お問い合わせの認証セッション（アクセストークン、メールアドレス、有効期限）は拡張機能の `localStorage` に保存し、確認コードは保存しません。閲覧中のページの URL、ページの内容、キャプチャした画像、拡張機能の設定は送信しません。

## 権限の使用目的

- **activeTab**: ポップアップで設定を変更した際、現在のタブ情報（音量ブースターの対象タブ判定など）にアクセスするために使用します。
- **storage**: 上記「ローカルに保存するデータ」の各キーを端末内に保存・復元するために使用します。
- **offscreen**（Chrome 版のみ。Firefox 版の manifest には含まれません）: 音量ブースターの `AudioContext` を Service Worker のライフサイクル外で維持するために、オフスクリーン ドキュメント（extension コンテキスト）を利用します。
- **tabCapture**（Chrome 版のみ。Firefox 版の manifest には含まれません）: 音量ブースターのスライダーが 100% 以外の値に設定されている場合、または 100% のままでも自動歪み防止 / ナイトモード / ミュート / イコライザのいずれかが有効な場合に、アクティブタブの音声ストリームを取得して `AudioContext` で増幅・圧縮・周波数調整・消音を行うために使用します。録音・保存・外部送信は一切行いません。
- **`<all_urls>` ホスト権限**: ルーペ機能で `chrome.tabs.captureVisibleTab` によりアクティブタブの可視領域を JPEG 静止画として取得し、円形レンズに拡大表示するために使用します。`activeTab` 権限のみでは、ポップアップを閉じた後 / SPA ページで内部 navigation が発生した後に grant が早期失効してキャプチャがブロックされる事例があるため、ルーペ機能を確実に動作させる目的で追加しています。取得した静止画は端末内の Blob URL として保持され、レンズ DOM 撤去と同時に `URL.revokeObjectURL` で解放されます。外部送信・保存は一切行いません。なお本拡張機能は既に content_scripts として全 http(s) サイトに DOM/CSS 操作のスクリプトを注入しており、`<all_urls>` ホスト権限の追加でアクセス可能になる範囲は実質変わりません。お問い合わせフォームの送信先 `https://support.kagayoi.com` への通信もこの権限に含まれます。

## v1.0.18 までの主な変更点（適用済み）

v1.0.x の旧バージョンが提供していた「右クリック解除 / テキスト選択解除 / 強制ペースト / 強制コピー / カスタム右クリック許可リスト」を含む「制限解除」機能は全て削除されました。それに伴い、`enabled` / `contextMenuAllowDomains` / `volumeBoosterEnabled` のストレージキーおよび `clipboardRead` / `clipboardWrite` / `contextMenus` / `scripting` 権限も削除されています。これら旧キーは自動アップデート時に Chrome の `chrome.storage.local.remove` で取り除かれます。

Instagram クリーナー機能（`instagramCleanerEnabled` / `instagramCleanerFeatures`）も同時に追加されました。いずれもデフォルト OFF（オプトイン）であり、ユーザーが有効化しない限り Instagram の表示には一切影響しません。Instagram クリーナーの動作はクライアント側の DOM 操作・CSS 適用のみで、外部サーバーへの送信は一切行いません。

YouTube Shorts 削除機能は YouTube 機能拡張のサブ機能 `searchFixerFeatures.removeShorts` として統合されました。これに伴い旧 `ytShortsRemovalEnabled` ストレージキーも削除されています。アップデート時、旧キーが `true` だったユーザーは `searchFixerFeatures.removeShorts = true` および `searchFixerEnabled = true` に自動転写されてから旧キーが削除されるため、Shorts 削除動作は継続されます。

v1.0.18 以降、YouTube 機能拡張に「コメント欄非表示」サブ機能（`searchFixerFeatures.hideComments`）が追加され、音量ブースターには自動歪み防止 / ナイトモードの各サブトグル（`volumeBoosterAntiClipEnabled` / `volumeBoosterNightModeEnabled` キー）と、`EyeDropper` API ベースのカラーピッカー機能（`colorPickerHistory` / `colorPickerDefaultFormat` / `colorPickerHexHash` キー）も追加されています。これらの新規キーはすべてデフォルト OFF または安全側のデフォルト値で、ユーザーが操作するまでサイト挙動には一切影響しません。

## お問い合わせ

本プライバシーポリシーに関するご質問は、Chrome Web Storeのサポートページよりお問い合わせください。

## 変更について

本プライバシーポリシーは予告なく変更される場合があります。変更があった場合は、本ページを更新します。
