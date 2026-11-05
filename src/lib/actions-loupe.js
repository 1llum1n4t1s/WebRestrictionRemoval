"use strict";

// 定義を globalThis で共有し、同じフレームでの再評価時も参照を維持する。
(() => {
  if (globalThis.__cpaActionsLoupeLoaded === true) return;
  globalThis.__cpaActionsLoupeLoaded = true;

/**
 * @readonly ルーペ機能（独自実装）の定数。
 *
 * `chrome.tabs.captureVisibleTab` で active tab の静止画を JPEG quality:70 で取得し、
 * content script の `position: fixed` 円形レンズに `background-image` として貼り付ける。
 * マウス座標 (clientX/clientY) から `background-position` をリアルタイム計算 (60fps、rAF コアレス)
 * してレンズに「カーソル下を拡大した内容」を表示する仕組み。
 *
 * iframe / canvas / video の現在フレームも captureVisibleTab で「描画ピクセル」として取得できるため、
 * 動画を一時停止して細部を確認する用途に最適。テキストはビットマップ拡大で多少ぼやけるが、
 * 動画 / iframe を含む汎用拡大鏡として機能する。DOM clone 方式と異なり Trusted Types の影響を受けない。
 *
 * 設計上の不変条件:
 *   - 全 http(s) サイトの top frame に注入（all_frames: false）
 *   - 左クリックで OFF（master トグル OFF と同じ挙動 + storage の loupeEnabled も false に書き戻し）
 *   - 再キャプチャ trigger: 初回 / scroll 500ms debounced / MutationObserver(childList, subtree:false) / resize
 *   - メモリ管理: DataURL を Blob URL に変換して <img>/background-image で参照、cleanup 時に必ず revoke
 *   - z-index: 2147483646 (image-downloader と同値で前面確保)
 *   - tabs.onActivated での自動適用はしない（visibilitychange で旧タブ cleanup、新タブは OFF 開始）
 *
 * 関連 storage key:
 *   - LOUPE_ENABLED (boolean, default false): マスタートグル
 *   - LOUPE_ZOOM (number, default 2.5): 倍率（ZOOM_LEVELS のいずれか）
 *   - LOUPE_SIZE (number, default 220): レンズ直径 px（SIZE_MIN..MAX）
 */
const Loupe = Object.freeze({
  /** 選択可能な倍率の列挙（popup のセグメントコントロールの 3 ボタンに対応） */
  ZOOM_LEVELS: Object.freeze([1.5, 2.5, 4.0]),
  /** デフォルト倍率（必ず ZOOM_LEVELS に含まれる値であること） */
  DEFAULT_ZOOM: 2.5,
  /** レンズ直径の最小値 (px)。これより小さいと中央のクロスヘアと倍率バッジが視認困難 */
  SIZE_MIN: 150,
  /** レンズ直径の最大値 (px)。1000 までは「画面の大部分を覆う巨大ルーペ」用途（小さい表 / 細字法律文書を
   *  ほぼ全画面で読みたい等）を想定。一般的な viewport (1920×1080 / 1440×900) でも画面に収まり、
   *  4× 倍率なら 250×250 ピクセル分を 1000×1000 で見られる */
  SIZE_MAX: 1000,
  /** デフォルトレンズ直径 (px)。SIZE_MIN..SIZE_MAX の中央値より小さめで、初期表示で邪魔にならない位置 */
  SIZE_DEFAULT: 220,
  /** スライダーの step (px)。10px 単位で十分滑らかな調整感、storage の値が無駄に細かくなるのを防ぐ */
  SIZE_STEP: 10,
  /** captureVisibleTab の JPEG 品質 (0-100)。70 で payload 約 300-600KB、視認性とのバランス最適 */
  CAPTURE_QUALITY: 70,
  /**
   * スクロール / DOM 変化 / resize 後の再キャプチャ debounce (ms)。
   * captureVisibleTab の Chrome 公式レート上限は 2fps = 500ms ごと 1 回までなので、
   * これより短い debounce 値にすると quota エラーが発生する。500ms は最小安全値。
   */
  RECAPTURE_DEBOUNCE_MS: 500,
  /** 注入する DOM 要素の id 名 / class 名 */
  LENS_ID: "__cpa-loupe-lens",
  CLASS_LENS: "__cpa-loupe-lens",
  CLASS_CROSSHAIR: "__cpa-loupe-crosshair",
  CLASS_BADGE: "__cpa-loupe-badge",

  /**
   * 倍率値の正規化。ZOOM_LEVELS に含まれない値（不正な storage 値、古いバージョンからの移行値等）は
   * DEFAULT_ZOOM にフォールバック。文字列 / NaN / null / undefined も同様に DEFAULT_ZOOM。
   *
   * @param {unknown} v 検証する倍率値
   * @returns {number} ZOOM_LEVELS のいずれかの値
   */
  validateZoom(v) {
    const n = Number(v);
    if (Loupe.ZOOM_LEVELS.includes(n)) return n;
    return Loupe.DEFAULT_ZOOM;
  },

  /**
   * レンズ直径の正規化。SIZE_MIN..SIZE_MAX に clamp し、SIZE_STEP 単位に丸める。
   * 不正値（NaN / 文字列 / undefined）は SIZE_DEFAULT にフォールバック。
   *
   * @param {unknown} v 検証するサイズ値
   * @returns {number} SIZE_MIN..SIZE_MAX の整数（SIZE_STEP の倍数）
   */
  clampSize(v) {
    // null は Number(null) === 0 になるため、明示的に DEFAULT へ倒す。
    // storage 未設定時の `undefined` も DEFAULT 扱い（uninitialized 値を MIN に倒さない）。
    if (v === null || v === undefined) return Loupe.SIZE_DEFAULT;
    const n = Number(v);
    if (!Number.isFinite(n)) return Loupe.SIZE_DEFAULT;
    const clamped = Math.min(Loupe.SIZE_MAX, Math.max(Loupe.SIZE_MIN, n));
    return Math.round(clamped / Loupe.SIZE_STEP) * Loupe.SIZE_STEP;
  },

  /**
   * マウス座標からレンズ DOM の screen 上の left/top 座標を計算する pure function。
   * カーソルがレンズの中央に来るように配置する。viewport 端を超えても clamp はしない
   * (典型的なルーペ UX に合わせて、レンズの一部が画面外にはみ出すのを許容)。
   *
   * @param {number} mouseX clientX
   * @param {number} mouseY clientY
   * @param {number} lensSize レンズ直径 px
   * @returns {{left: number, top: number}}
   */
  computeLensPosition(mouseX, mouseY, lensSize) {
    const r = lensSize / 2;
    return {
      left: mouseX - r,
      top: mouseY - r,
    };
  },

  /**
   * マウス座標からレンズの `background-position` 値を計算する pure function。
   *
   * 設計:
   *   - background-size = viewport * zoom（キャプチャ画像を倍率で拡大した内部仮想サイズ）
   *   - background-position はその拡大画像を「レンズ div の左上を起点に」どこにオフセットするか
   *   - カーソル位置 (mouseX, mouseY) に対応する画像ピクセル (mouseX*zoom, mouseY*zoom) を
   *     レンズの中心 (r, r) に重ねるための shift = (r - mouseX*zoom, r - mouseY*zoom)
   *
   * @param {number} mouseX clientX
   * @param {number} mouseY clientY
   * @param {number} zoom 倍率（ZOOM_LEVELS のいずれか）
   * @param {number} lensRadius レンズ半径 px（lensSize / 2）
   * @returns {{bgX: number, bgY: number}}
   */
  computeBackgroundPosition(mouseX, mouseY, zoom, lensRadius) {
    return {
      bgX: lensRadius - mouseX * zoom,
      bgY: lensRadius - mouseY * zoom,
    };
  },

  /**
   * background から返ってくる error code を i18n キー文字列に変換する pure function。
   * 想定: 将来 popup に「ルーペが起動できなかった理由」を表示する hint 領域を追加する際の橋渡し
   * （音量ブースターの `formatVolumeError` と同型の設計）。
   *
   * **現状はまだ呼び出し元なし**: content script は console.warn でエラー詳細を残し、ユーザーへの
   * 通知は「レンズが表示されない」という暗黙的フィードバックに留めている。popup の hint 領域を
   * 整備するときに `chrome.i18n.getMessage(formatLoupeError(res.error))` として呼び出す予定。
   * テスト (test/actions.test.js) は事前に書いてあるので、将来導入時に追加検証は不要。
   *
   * @param {string|undefined|null} code background エラー code
   * @returns {string} i18n キー
   */
  formatLoupeError(code) {
    if (!code) return "loupeErrorUnknown";
    const s = String(code);
    if (/no tab|invalid-tab-id|tab not found|cannot find tab/i.test(s)) return "loupeErrorInvalidTab";
    if (/not allowed|cannot capture|chrome:|edge:|file:|about:/i.test(s)) {
      return "loupeErrorUnsupportedPage";
    }
    if (/permission/i.test(s)) return "loupeErrorPermission";
    if (/MAX_CAPTURE|quota/i.test(s)) return "loupeErrorQuota";
    return "loupeErrorUnknown";
  },
});

  globalThis.Loupe = Loupe;
})();
