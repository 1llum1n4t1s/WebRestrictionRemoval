"use strict";

// 定義を globalThis で共有し、同じフレームでの再評価時も参照を維持する。
(() => {
  if (globalThis.__cpaActionsVideoLoaded === true) return;
  globalThis.__cpaActionsVideoLoaded = true;

/**
 * @readonly 動画ガンマ補正（独自実装）の定数。
 *
 * `<video>` 要素に対して SVG `<feComponentTransfer type="gamma">` フィルタを適用し、
 * 暗い動画を明るくしたり、明るすぎる動画のコントラストを抑えたりする画質補正。
 *
 * 全タブ共通の単一値（タブごと独立ではない）。マスタートグル ON 時のみ content script が
 * SVG filter と style 要素を `<body>` に注入し、`video { filter: url(#__cpa-video-gamma) }`
 * で適用する。マスタートグル OFF / ガンマ値 1.0 のいずれかで filter を解除（DOM クリーンアップ）。
 *
 * SVG ガンマ式: C' = amplitude * pow(C, exponent) + offset。amplitude=1, offset=0, exponent=N
 * のとき純粋なガンマ補正。N < 1 で暗部を持ち上げて全体的に明るく、N > 1 で暗部を潰して暗く。
 */
const VideoGamma = Object.freeze({
  MIN: 0.3,
  MAX: 3.0,
  /** 補正なし（filter 不適用と等価）。スライダー中央位置。 */
  DEFAULT: 1.0,
  /**
   * スライダー UI の整数表現。中央 (SLIDER_DEFAULT) = ガンマ 1.0、
   * 右端 (SLIDER_MAX) = ガンマ MIN (明るい)、左端 (SLIDER_MIN) = ガンマ MAX (暗い) という
   * 対称配置。`<input type="range">` の `min/max/step` と直結し、左右半分で線形マッピングする。
   */
  SLIDER_MIN: 0,
  SLIDER_MAX: 200,
  SLIDER_DEFAULT: 100,
  SLIDER_STEP: 1,
  /** SVG filter の id（ページ側 CSS と衝突しないよう __cpa- 接頭辞）。 */
  FILTER_ID: "__cpa-video-gamma",
  /** 注入する SVG 要素の id（同上）。 */
  SVG_ID: "__cpa-video-gamma-svg",
  clampValue(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return VideoGamma.DEFAULT;
    if (n < VideoGamma.MIN) return VideoGamma.MIN;
    if (n > VideoGamma.MAX) return VideoGamma.MAX;
    // 0.01 単位に丸めて round-trip 誤差を抑える。
    return Math.round(n * 100) / 100;
  },
  /**
   * スライダー整数 (SLIDER_MIN..SLIDER_MAX) → 実ガンマ値 (MIN..MAX)。
   *
   * 中央 (SLIDER_DEFAULT) = DEFAULT (1.0) を境に左右半分で別の線形マッピングを行う:
   *   - 左半分 [SLIDER_MIN..SLIDER_DEFAULT] → ガンマ [MAX..DEFAULT] (3.0..1.0、暗い側)
   *   - 右半分 [SLIDER_DEFAULT..SLIDER_MAX] → ガンマ [DEFAULT..MIN] (1.0..0.3、明るい側)
   *
   * 「右が明るい」UX を保ちつつ、SVG filter の exponent は素直に渡せるよう
   * UI 値 ↔ ガンマ値の変換だけここで反転させる。
   */
  sliderToValue(sliderInt) {
    const n = Number(sliderInt);
    if (!Number.isFinite(n)) return VideoGamma.DEFAULT;
    const s = Math.min(VideoGamma.SLIDER_MAX, Math.max(VideoGamma.SLIDER_MIN, n));
    if (s <= VideoGamma.SLIDER_DEFAULT) {
      const t = (VideoGamma.SLIDER_DEFAULT - s) / (VideoGamma.SLIDER_DEFAULT - VideoGamma.SLIDER_MIN);
      return VideoGamma.clampValue(VideoGamma.DEFAULT + t * (VideoGamma.MAX - VideoGamma.DEFAULT));
    }
    const t = (s - VideoGamma.SLIDER_DEFAULT) / (VideoGamma.SLIDER_MAX - VideoGamma.SLIDER_DEFAULT);
    return VideoGamma.clampValue(VideoGamma.DEFAULT - t * (VideoGamma.DEFAULT - VideoGamma.MIN));
  },
  /** sliderToValue の逆関数。実ガンマ値 → スライダー整数。 */
  valueToSlider(value) {
    const v = VideoGamma.clampValue(value);
    if (v >= VideoGamma.DEFAULT) {
      const t = (v - VideoGamma.DEFAULT) / (VideoGamma.MAX - VideoGamma.DEFAULT);
      return Math.round(VideoGamma.SLIDER_DEFAULT - t * (VideoGamma.SLIDER_DEFAULT - VideoGamma.SLIDER_MIN));
    }
    const t = (VideoGamma.DEFAULT - v) / (VideoGamma.DEFAULT - VideoGamma.MIN);
    return Math.round(VideoGamma.SLIDER_DEFAULT + t * (VideoGamma.SLIDER_MAX - VideoGamma.SLIDER_DEFAULT));
  },
  /** ガンマ値が DEFAULT (1.0) と十分近いか。content script が DOM 注入をスキップする判定用。 */
  isUnity(value) {
    const v = VideoGamma.clampValue(value);
    return Math.abs(v - VideoGamma.DEFAULT) < 0.005;
  },
});

/**
 * @readonly 動画黒帯除去（ワイド表示）の定数。
 *
 * ウルトラワイド画面（21:9 / 32:9 等）で動画の上下/左右に出るレターボックス黒帯を、
 * `<video>` 要素への CSS `transform` で除去する独自実装。考え方は "UltraWide Video" 系
 * 拡張機能を参考にしているが、コードは流用せず、動画メタの外部送信等は一切行わない
 * （本プロジェクトの「外部送信ゼロ」方針を堅持）。
 *
 * **方式: 「モニターの縦横比だけユーザーが選び、動画側の縦横比は自動検出」**
 *   - ユーザーは popup のドロップダウンで「お使いのモニターの縦横比 / 解像度」(= targetAspect) を選ぶ。
 *   - content script は各 `<video>` の intrinsic 縦横比 (videoWidth/videoHeight) を読み、
 *     targetAspect いっぱいに収まる拡大率を **動画ごとに** 計算して transform を当てる。
 *   - これにより 16:9 動画でも 21:9 シネマ動画でも 4:3 動画でも、それぞれ正しく黒帯を除去できる
 *     （「動画は 16:9 固定」と決め打ちしないので、動画がワイドなケースでも破綻しない）。
 *
 * 2 モード:
 *   - zoom    : `scale(s)` でアスペクト比を保ったまま拡大（はみ出した辺はクロップ）
 *   - stretch : `scaleX(s)` / `scaleY(s)` で不足軸のみ引き伸ばし（比率は変わるがクロップなし）
 *
 * content script は per-video で `el.style.transform` を `!important` で当て/外しする
 * （MutationObserver で新規 video を追従、loadedmetadata で intrinsic サイズ確定を待つ）。
 * マスター OFF、または「動画とモニターの縦横比が一致して補正不要」のときは transform を外す。
 */
const VideoFill = Object.freeze({
  MODE_ZOOM: "zoom",
  MODE_STRETCH: "stretch",
  DEFAULT_MODE: "zoom",
  /** 計算結果の拡大率の上限（4:3 動画 → 32:9 等の極端な組み合わせの暴走を防ぐ）。 */
  MAX_SCALE: 4.0,
  /** ON 直後の既定ターゲット（最も普及しているウルトラワイド）。 */
  DEFAULT_TARGET: "21:9",
  /**
   * モニターのプリセット一覧（popup のドロップダウンの単一情報源）。
   *   - id     : storage に保存する識別子
   *   - group  : "aspect"（縦横比）/ "resolution"（解像度）。optgroup 振り分け用
   *   - label  : 表示文字列（数値のみなのでロケール非依存、i18n 不要）
   *   - aspect : 目標縦横比（W/H）。解像度は実ピクセルから算出した値を直接持つ
   */
  PRESETS: Object.freeze([
    Object.freeze({ id: "16:9", group: "aspect", label: "16:9", aspect: 16 / 9 }),
    Object.freeze({ id: "16:10", group: "aspect", label: "16:10", aspect: 16 / 10 }),
    Object.freeze({ id: "21:9", group: "aspect", label: "21:9", aspect: 2560 / 1080 }),
    Object.freeze({ id: "24:10", group: "aspect", label: "24:10", aspect: 24 / 10 }),
    Object.freeze({ id: "32:9", group: "aspect", label: "32:9", aspect: 32 / 9 }),
    Object.freeze({ id: "1920x1080", group: "resolution", label: "1920×1080 (16:9)", aspect: 1920 / 1080 }),
    Object.freeze({ id: "2560x1080", group: "resolution", label: "2560×1080 (21:9)", aspect: 2560 / 1080 }),
    Object.freeze({ id: "3440x1440", group: "resolution", label: "3440×1440 (21:9)", aspect: 3440 / 1440 }),
    Object.freeze({ id: "3840x1600", group: "resolution", label: "3840×1600 (24:10)", aspect: 3840 / 1600 }),
    Object.freeze({ id: "5120x1440", group: "resolution", label: "5120×1440 (32:9)", aspect: 5120 / 1440 }),
  ]),
  /** optgroup の並び順とラベル i18n キー。 */
  GROUPS: Object.freeze([
    Object.freeze({ id: "aspect", messageKey: "videoFillGroupAspect" }),
    Object.freeze({ id: "resolution", messageKey: "videoFillGroupResolution" }),
  ]),
  normalizeMode(mode) {
    return mode === VideoFill.MODE_STRETCH ? VideoFill.MODE_STRETCH : VideoFill.MODE_ZOOM;
  },
  /** ターゲット id を検証。未知の値は DEFAULT_TARGET にフォールバック。 */
  normalizeTarget(id) {
    for (const p of VideoFill.PRESETS) if (p.id === id) return id;
    return VideoFill.DEFAULT_TARGET;
  },
  /** ターゲット id → 目標縦横比（W/H）。未知なら DEFAULT_TARGET の縦横比。 */
  targetAspect(id) {
    for (const p of VideoFill.PRESETS) if (p.id === id) return p.aspect;
    for (const p of VideoFill.PRESETS) if (p.id === VideoFill.DEFAULT_TARGET) return p.aspect;
    return 16 / 9;
  },
  /**
   * 目標縦横比 (targetAspect) と動画の実寸 (videoW × videoH) から、その動画を
   * モニターいっぱいに収めるための CSS transform 文字列を組み立てる pure function。
   *
   * - zoom    : アスペクト比を保ったまま、収まっている側の辺を埋めるよう一様 `scale(s)`。
   *             s = (target >= video) ? target/video : video/target （常に 1 以上、はみ出しはクロップ）。
   * - stretch : 不足している軸だけを引き伸ばす（`scaleX` または `scaleY`）。クロップは発生しない。
   *
   * 補正不要（動画とモニターの縦横比がほぼ一致）なら空文字を返し、呼び出し側は transform を外す。
   * 値は数値のみを埋め込む（ユーザー入力経路なし）ため XSS リスクゼロ。MAX_SCALE で clamp。
   *
   * @returns {string} "scale(1.33)" / "scaleX(1.33)" / "scaleY(1.2)" / "" のいずれか
   */
  computeTransform(targetAspect, videoW, videoH, mode) {
    const ta = Number(targetAspect);
    const va = Number(videoW) / Number(videoH);
    if (!Number.isFinite(ta) || ta <= 0) return "";
    if (!Number.isFinite(va) || va <= 0) return "";
    const clamp = (s) => Math.round(Math.min(VideoFill.MAX_SCALE, Math.max(1, s)) * 1000) / 1000;
    const EPS = 0.01;
    if (VideoFill.normalizeMode(mode) === VideoFill.MODE_STRETCH) {
      if (ta > va + EPS) return `scaleX(${clamp(ta / va)})`;
      if (va > ta + EPS) return `scaleY(${clamp(va / ta)})`;
      return "";
    }
    const s = ta >= va ? ta / va : va / ta;
    if (s <= 1 + 0.005) return "";
    return `scale(${clamp(s)})`;
  },
});

  globalThis.VideoGamma = VideoGamma;
  globalThis.VideoFill = VideoFill;
})();
