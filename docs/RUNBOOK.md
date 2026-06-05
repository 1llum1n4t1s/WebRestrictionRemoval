# Runbook — Vuora

本拡張機能のユーザー報告対応・リリースロールバック・Day-2 Ops 障害対応の初動ガイド。
詳細な実装パターンは [CLAUDE.md](../CLAUDE.md) の「Important Patterns」を参照。

> 本ドキュメントは /rere レビュー F-002 で初版作成。「障害が起きたとき気づける／切り分けられる／復旧できる」観点を集約。

---

## 1. 障害分類

| 種別 | 典型症状 | first 5 minutes |
|---|---|---|
| **音量ブースター無音化** | 「音量ブースター ON で 5 分後ぐらいから音が出ない」 | §2-A |
| **DOM 機能停止** | 「Amazon 月別合計が出ない」「Instagram から Reels が消えない」 | §2-B |
| **リリース失敗** | release/X.Y.Z push で publish.yml が fail | §2-C |
| **storage 破損** | popup を開くと全 OFF に戻る | §2-D |
| **拡張機能リロード後の挙動** | 「拡張機能の更新後、機能が動かなくなった」 | §2-E |

---

## 2. 症状別 first 5 minutes

### 2-A. 音量ブースター無音化

1. ユーザーに依頼する確認:
   - 対象タブ URL / Chrome / Edge / Firefox のバージョン
   - 音量ブースタートグル ON か / スライダー値 / サブトグルの状態
   - DevTools (background SW) の console ログ。`[WebViewingAssist]` で grep してもらう
   - chrome://extensions の「Service Worker」リンクから offscreen.html のログも取得（`[WebViewingAssist]` prefix）
2. 切り分けフロー:
   - `AudioContext.resume() failed` のログあり → autoplay policy / user gesture 経路喪失
   - `createAudioState failed` のログあり → getUserMedia / chromeMediaSourceId 失効
   - `getUserMedia mandatory failed` のログのみ → flat 形式 fallback 動作中（実害ゼロ）
   - ログ無し → storage の volumeBoosterEnabled が false に戻っている可能性 → §2-D
3. 即時対応案: 「popup を開く → スライダーを別の値に変えてから 100% に戻す」で AudioContext 再構築を促す
4. 既知の依存: Memory Saver でタブが freeze されると tabCapture stream が止まる

### 2-B. DOM 機能停止

各サイトの DOM 変更が原因の可能性。CLAUDE.md の各機能セクションで使用 selector を確認:
- YouTube: `ytd-channel-renderer` / `ytd-live-chat-frame` / `ytd-shelf-renderer` 等
- Instagram: aria-label / role / data-pagelet ベース（難読化 class 非依存）
- TikTok: `[class*="RightPanelContainer"]` / `[class*="DivCommentListContainer"]`
- Amazon: `[data-delivery-type]` / `.subscription-price`

確認手順:
1. ユーザーから「該当ページのスクリーンショット」 + 「DevTools Elements パネルの該当 selector のスクリーンショット」を取得
2. Instagram は `instagram-cleaner.js:117-125` の selector mismatch detector で `[WebViewingAssist] Instagram selector mismatch...` が出ているか確認
3. Amazon / TikTok / search-fixer は現状 selector mismatch detector 未実装（/rere レビュー F-003、将来横展開予定）
4. selector 修正は CLAUDE.md の各機能セクション + 過去のコミット履歴を参照

### 2-C. リリース失敗（publish.yml）

- Chrome publish が fail だが Firefox publish が success → Chrome 側のみ問題（`if: success() || failure()` で独立実行）
- Chrome 側エラー `ITEM_NOT_UPDATABLE` → 同 version の重複 upload。`/vava` で次の version へ bump して push 再実行
- Firefox 側エラー `Version * already exists` → 同様
- 同 version 重複検知は publish.yml では汎用 fail として扱っており、エラーメッセージから判別する（/rere F-005 余地）

#### ロールバック手順

**Chrome Web Store**:
- CWS Dashboard → アイテム選択 → 「以前の version を公開」（自動ロールバックは CI 未対応）
- 旧 ZIP の再 upload は手動。`web-viewing-assist-chrome.zip` の過去 build artifact が GitHub Actions に 90 日保持される

**Firefox AMO**:
- AMO Developer Hub → アドオン管理 → 「version 履歴」から旧 version を再公開
- AMO は version 取り下げが手動申請

**マイグレーション不可逆性に注意**: `background.js` の `onInstalled` (line 65-74) で legacy storage key を `chrome.storage.local.remove` するため、**新 version で削除された key は旧 version に戻しても復元されない**。例:
- v1.0.18 で `copyPasteSettings` / `enabled` / `contextMenuAllowDomains` を削除
- v1.0.27 で `ytShortsRemovalEnabled` を `searchFixerFeatures.removeShorts` に転写してから削除

ダウングレード時はユーザーが該当機能を再 ON する必要がある。

### 2-D. storage 破損

- popup 起動時の sentinel チェック（popup.js:236）で `INSTALL_SENTINEL` が消えていれば自動で console.warn + 再書き込み
- ユーザーから「設定が全部 OFF に戻っている」報告を受けたら sentinel チェックの console.warn を確認してもらう
- 復旧: ユーザーが該当トグルを再 ON する。`chrome.storage.local` 全体の破損は Chrome 側のバグでない限り起きない

### 2-E. 拡張機能リロード後の挙動

extension reload / 自動更新で content script が orphan 化する。`chrome.runtime?.id` が undefined になり、MutationObserver / setInterval が止まらず CPU を消費し続けるリスク → CLAUDE.md「PATTERN SYNC」記載の 10 ファイル + early 3 で対策済み。

ユーザー報告が来たら:
1. 該当タブを reload してもらう（content script を再注入）
2. それでも治らなければ拡張機能を一度 OFF/ON
3. それでも治らなければ Chrome / Firefox を再起動

---

## 3. 既知の依存サービス断と対処

| 依存先 | 失敗時の挙動 | mitigation |
|---|---|---|
| YouTube `/feed/channels` | subs グリッドのチャンネルリスト取得失敗 | exponential backoff 2s→60s（`subsListFetchBackoffMs`） |
| YouTube channel HTML (videoId 抽出) | 該当チャンネルのサムネが mqdefault.jpg にフォールバック → 全失敗で空 | sessionStorage 24h cache でヒット時はネット不要 |
| Amazon DOM 変更 | 月別合計が表示されない（silent fail） | F-003 余地（DOM mismatch 検知未実装） |
| Instagram DOM 変更 | 該当機能だけ silent fail | `instagram-cleaner.js:117-125` の detector で console.warn |
| TikTok DOM 変更 | 該当機能だけ silent fail | F-003 余地（DOM mismatch 検知未実装） |
| chrome.tabCapture user gesture 要件 | 新規タブで音量ブースター初回適用失敗 | popup を開く操作が user gesture になる |
| chrome.tabs.captureVisibleTab 2fps 上限 | Loupe で再キャプチャ間隔 500ms に強制 | 仕様内、ユーザー UX 影響軽微 |
| 認証プロキシ 401/302 ループ（Zscaler 等） | keepalive HTTP ping で再ループ消費 | デフォルト OFF（opt-in）、5s timeout |
| Memory Saver でタブ freeze | keepalive / 音量ブースターが停止 | 復帰でユーザーが popup 再操作 |

---

## 4. Firefox AMO 初回登録手順（引き継ぎメモ）

CI からは新規 add-on 作成不可。次のメンテナがゼロから再現する場合の手順:

1. `package.json` 直下に `.amo-metadata.json`（license: MIT, categories）を確認
2. AMO Developer Hub で API キーを発行（[発行ページ](https://addons.mozilla.org/ja/developers/addon/api/key/)）
3. ローカルで:
   ```bash
   WEB_EXT_API_KEY=<issuer> WEB_EXT_API_SECRET=<secret> \
     pnpm exec web-ext sign \
     --source-dir=firefox-build \
     --channel=listed \
     --amo-metadata=.amo-metadata.json
   ```
4. gecko id（`manifest.firefox.json` 内）で AMO 上に新規 add-on 自動作成
5. 初回完了後は CI の `publish-firefox` job が新 version 提出を担う

**注意**: `web-ext sign --channel=listed` は `Approval: timeout exceeded` で exit 1 だが submission 受理済みの挙動。CI でも考慮済み（`if: success() || failure()`）。

---

## 5. AMO listing 更新の注意

API 経由で送る `<ul>` 等の HTML は `&lt;ul&gt;` としてエスケープ保存される（plain text 化）。リッチ HTML 表示は AMO Dashboard のリッチテキストエディタ経由のみ可能。

`webstore/store-listing.firefox.{ja,en}.txt` は絵文字 + `・` 等で plain text 構造化済み。

---

## 6. テストの単一情報源

`test/actions.test.js` の「FEATURES 件数の固定アサート」テスト群が **ドキュメント整合性の単一情報源**。件数を増減する場合は以下を必ず同時更新する:

1. `src/lib/actions.js` の FEATURES 配列
2. `_locales/{en,ja}/messages.json` の label/desc
3. `test/actions.test.js` のアサート値
4. `CLAUDE.md` の Architecture / Important Patterns / Key Files 記述
5. `README.md` / `README.en.md` の機能列挙
6. `docs/privacy-policy.{md,en.md}` の storage 説明
7. `webstore/store-listing.{,en,firefox.ja,firefox.en}.txt` の機能リスト
8. `webstore/02-features.html` の件数（スクリーンショット生成で焼き込まれる）

`pnpm test` で件数 drift を CI 検知できる。

---

## 7. インシデント記録

過去のインシデントは `memory-bank/WebRestrictionRemoval/progress.md` と `activeContext.md` を参照。重大なものは本ファイルに追記。

### 既知の事故事例

- **v1.0.29 RTX 動画強化機能完全破壊** (2026-05-16, /rere レビュー A2-001): `background.js` の `normalizeSettings` 関数に `rtxEnhancerEnabled` フィールドが欠落していて、popup から ON しても storage に書かれず永久 OFF 固定。v1.0.30 で hotfix。再発防止: `test/actions.test.js` に `StorageKeys.RTX_ENHANCER_ENABLED` アサート追加 + 新機能追加時は `normalizeSettings` / `toStorageRecord` / `notifyContentScripts` の 3 関数を必ず同時更新する（CLAUDE.md「設計の起点」参照）。
