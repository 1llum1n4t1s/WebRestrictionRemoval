# プライバシーポリシー - WEB閲覧アシスト

最終更新日: 2026年5月4日

## はじめに

「WEB閲覧アシスト」（旧称: WEB制限解除サポート、以下「本拡張機能」）は、ユーザーのプライバシーを尊重し、個人情報の保護に努めます。本プライバシーポリシーは、本拡張機能におけるデータの取り扱いについて説明します。

## 収集するデータ

本拡張機能は、個人情報を一切収集しません。

## ローカルに保存するデータ

本拡張機能は、以下の設定データをユーザーの端末内（`chrome.storage.local`）にのみ保存します。

- **`keepAliveEnabled`**（真偽値）: セッション維持機能の有効/無効。
- **`keepAliveIntervalMs`**（数値・ミリ秒）: セッション維持のポーリング間隔（1〜15 分の範囲）。
- **`keepAliveHttpPingEnabled`**（真偽値）: セッション維持の「軽量 HTTP ping」サブ機能の有効/無効（オプトイン・デフォルト OFF）。
- **`searchFixerEnabled`**（真偽値）: YouTube クリーナー（Shorts 削除・コメント欄非表示・ライブチャット非表示を含む 22 サブ機能の親）の有効/無効。
- **`searchFixerFeatures`**（オブジェクト）: YouTube クリーナーの 22 個のサブ機能（Shorts 削除 / 検索結果ノイズ除去 10 種 / 動画属性削除 4 種 / ハイライト 2 種 / 動画ページ整形 4 種〈タイトル中央配置・説明文フル幅・コメント欄非表示・ライブチャット非表示〉/ レイアウト 1 種）の個別 ON/OFF 状態。
- **`searchFixerGridItems`**（数値）: YouTube ホームグリッドの列数指定（0=自動 / 4 / 5 / 6）。
- **`amazonDeliveryTotalEnabled`**（真偽値）: Amazon 定期おトク便ページの月別合計表示機能の有効/無効。
- **`instagramCleanerEnabled`**（真偽値）: Instagram クリーナー機能の有効/無効。
- **`instagramCleanerFeatures`**（オブジェクト）: Instagram クリーナーの 10 個のサブ機能（Reels 削除 / Explore 削除 / ストーリー段非表示 / Stories URL ホーム遷移 / Threads 誘導非表示 / いいね数・フォロワー数非表示 / 投稿内動画ブロック / コメント欄非表示 / Notes 非表示 / 新規メッセージカウンター非表示）の個別 ON/OFF 状態。
- **`volumeBoosterAntiClipEnabled`**（真偽値）: 音量ブースターのサブトグル「自動歪み防止」（高速リミッタとして動作する `DynamicsCompressor`）の有効/無効。デフォルト OFF。
- **`volumeBoosterNormalizeEnabled`**（真偽値）: 音量ブースターのサブトグル「自動音量正規化」（緩い圧縮として動作する `DynamicsCompressor`）の有効/無効。デフォルト OFF。
- **`colorPickerHistory`**（配列・最大 20 件）: カラーピッカーで採取した色の履歴。各要素は `{ hex, ts }` の形式で、`hex` は `#RRGGBB`、`ts` は採取時刻のタイムスタンプ。
- **`colorPickerDefaultFormat`**（文字列・`"hex"` / `"rgb"` / `"hsl"` のいずれか）: カラーピッカーで採取した色のクリップボード既定形式。
- **`colorPickerHexHash`**（真偽値・デフォルト true）: HEX 形式でコピーする際に先頭の `#` を含めるかどうか。
- **`popupLastTab`**（文字列・`"assist"` / `"picker"` のいずれか）: ポップアップで最後に開いていたタブ。次回起動時の表示状態復元に使用。

これらの値は端末内にのみ保存され、外部サーバーへの送信は一切行いません。

なお、音量ブースター機能の現在 gain 値（タブごと）はオフスクリーン ドキュメントのメモリ上にのみ保持され、永続化されません。タブを閉じる、スライダーを 100% に戻す、または拡張機能を無効化すると即座に解放されます。

## タブ音声へのアクセス

「音量ブースター」のスライダーが 100% 以外の値に設定されている場合のみ、`chrome.tabCapture` API でアクティブタブの音声ストリームを取得し、オフスクリーン ドキュメント内の `AudioContext` で音量を増幅して再出力します。音声データは外部に送信されず、録音・保存も一切行いません。タブを閉じる、スライダーを 100% に戻す、または拡張機能を無効化すると即座にストリームは解放されます。

## データの共有

本拡張機能は、いかなるデータも第三者と共有しません。

## ネットワーク通信

本拡張機能は、第三者の外部サーバーへの通信を一切行いません。「セッション維持」機能を有効化している場合のデフォルト動作は、サイト側 JS のアイドル検知をリセットするための合成イベント（`mousemove` / `pointermove` / `scroll` / `focus`）を `document` / `window` に dispatch するクライアントサイド処理のみで、ネットワーク通信は発生しません。

サブ機能「サーバーへの軽量 ping を併発」（オプトイン・デフォルト OFF）を有効化した場合に限り、サーバー側のセッションタイムアウトを延長するため、アクセス中のサイト自身（同一オリジン）の軽量なエンドポイントへ `HEAD` または `GET` リクエストを発行します。例として、SharePoint（`*.sharepoint.{com,cn,de,us}`）では `/_api/web` に GET、その他の多くのサイトでは現在のページ URL または origin root に軽量 HEAD を試行します。これは現にログイン済みであるサイト自身への通信のみであり、第三者サーバーへの送信ではありません（`credentials: same-origin` で同一オリジン以外には Cookie が送信されません）。認証プロキシ環境（Zscaler 等）で 401/302 ループや SIEM ログアラートを誘発する可能性があるため、副作用を理解した上で有効化することを推奨します。

## 権限の使用目的

- **activeTab**: ポップアップで設定を変更した際、現在のタブ情報（音量ブースターの対象タブ判定など）にアクセスするために使用します。
- **storage**: 上記「ローカルに保存するデータ」の各キーを端末内に保存・復元するために使用します。
- **offscreen**: 音量ブースターの `AudioContext` を Service Worker のライフサイクル外で維持するために、オフスクリーン ドキュメント（extension コンテキスト）を利用します。
- **tabCapture**: 音量ブースターのスライダーが 100% 以外の値に設定されている場合に、アクティブタブの音声ストリームを取得して `AudioContext` の `GainNode` で増幅・再出力するために使用します。録音・保存・外部送信は一切行いません。

## v1.0.18 までの主な変更点（適用済み）

v1.0.x の旧バージョンが提供していた「右クリック解除 / テキスト選択解除 / 強制ペースト / 強制コピー / カスタム右クリック許可リスト」を含む「制限解除」機能は全て削除されました。それに伴い、`enabled` / `contextMenuAllowDomains` / `volumeBoosterEnabled` のストレージキーおよび `clipboardRead` / `clipboardWrite` / `contextMenus` / `scripting` 権限も削除されています。これら旧キーは自動アップデート時に Chrome の `chrome.storage.local.remove` で取り除かれます。

Instagram クリーナー機能（`instagramCleanerEnabled` / `instagramCleanerFeatures`）も同時に追加されました。いずれもデフォルト OFF（オプトイン）であり、ユーザーが有効化しない限り Instagram の表示には一切影響しません。Instagram クリーナーの動作はクライアント側の DOM 操作・CSS 適用のみで、外部サーバーへの送信は一切行いません。

YouTube Shorts 削除機能は YouTube クリーナーのサブ機能 `searchFixerFeatures.removeShorts` として統合されました。これに伴い旧 `ytShortsRemovalEnabled` ストレージキーも削除されています。アップデート時、旧キーが `true` だったユーザーは `searchFixerFeatures.removeShorts = true` および `searchFixerEnabled = true` に自動転写されてから旧キーが削除されるため、Shorts 削除動作は継続されます。

v1.0.18 では YouTube クリーナーに「コメント欄非表示」サブ機能（`searchFixerFeatures.hideComments`）が追加され、サブ機能数が 20 → 21 になりました。また音量ブースターに 2 段の `DynamicsCompressor` サブトグル（自動歪み防止 / 自動音量正規化、それぞれ `volumeBoosterAntiClipEnabled` / `volumeBoosterNormalizeEnabled` キー）と、`EyeDropper` API ベースのカラーピッカー機能（`colorPickerHistory` / `colorPickerDefaultFormat` / `colorPickerHexHash` キー）も追加されています。これらの新規キーはすべてデフォルト OFF または安全側のデフォルト値で、ユーザーが操作するまでサイト挙動には一切影響しません。

## お問い合わせ

本プライバシーポリシーに関するご質問は、Chrome Web Storeのサポートページよりお問い合わせください。

## 変更について

本プライバシーポリシーは予告なく変更される場合があります。変更があった場合は、本ページを更新します。
