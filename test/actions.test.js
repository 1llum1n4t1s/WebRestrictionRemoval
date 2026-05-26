"use strict";

/**
 * actions.js の純粋関数群に対する境界値テスト (#26)。
 *
 * 実行: `node --test test/actions.test.js`
 *
 * 対象:
 *   - VolumeBooster: clampValue / percentToGain / gainToPercent / sliderPositionToPercent / percentToSliderPosition
 *   - KeepAlive: clampIntervalMs
 *   - SearchFixer: clampGridItems / mergeFeatures
 *   - InstagramCleaner: mergeFeatures
 *   - ColorPicker: isValidFormat / normalizeFormat
 *   - PopupTabs: isValid / normalize / migrate
 *
 * これらは外部依存ゼロの pure function なのでテスト容易性が高く、ドリフト検知に費用対効果が大きい。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("./_load-actions");

// ---------- VolumeBooster ----------

test("VolumeBooster.clampValue: 範囲内の値はそのまま、範囲外は clamp、不正値は DEFAULT", () => {
  assert.equal(G.VolumeBooster.clampValue(150), 150);
  assert.equal(G.VolumeBooster.clampValue(0), G.VolumeBooster.MIN);
  assert.equal(G.VolumeBooster.clampValue(-100), G.VolumeBooster.MIN);
  assert.equal(G.VolumeBooster.clampValue(9999), G.VolumeBooster.MAX);
  assert.equal(G.VolumeBooster.clampValue(NaN), G.VolumeBooster.DEFAULT);
  assert.equal(G.VolumeBooster.clampValue("abc"), G.VolumeBooster.DEFAULT);
  assert.equal(G.VolumeBooster.clampValue(undefined), G.VolumeBooster.DEFAULT);
});

test("VolumeBooster.percentToGain: 0/100/MAX のアンカー値が正しい", () => {
  assert.equal(G.VolumeBooster.percentToGain(0), 0);
  assert.equal(G.VolumeBooster.percentToGain(50), 0.5);
  assert.equal(G.VolumeBooster.percentToGain(100), 1);
  assert.equal(G.VolumeBooster.percentToGain(G.VolumeBooster.MAX), G.VolumeBooster.MAX / 100);
});

test("VolumeBooster.percentToGain → gainToPercent round-trip (整数 0..MAX)", () => {
  for (const pct of [0, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300]) {
    const gain = G.VolumeBooster.percentToGain(pct);
    const back = G.VolumeBooster.gainToPercent(gain);
    assert.equal(back, pct, `pct=${pct} round-trip got ${back} (gain=${gain})`);
  }
});

test("VolumeBooster.gainToPercent: 不正値は MIN", () => {
  assert.equal(G.VolumeBooster.gainToPercent(NaN), G.VolumeBooster.MIN);
  assert.equal(G.VolumeBooster.gainToPercent(-1), G.VolumeBooster.MIN);
  assert.equal(G.VolumeBooster.gainToPercent(0), G.VolumeBooster.MIN);
  assert.equal(G.VolumeBooster.gainToPercent("abc"), G.VolumeBooster.MIN);
});

test("VolumeBooster slider ↔ percent round-trip (整数 0..MAX)", () => {
  for (const pct of [0, 25, 50, 75, 100, 150, 200, 250, 300]) {
    const pos = G.VolumeBooster.percentToSliderPosition(pct);
    const back = G.VolumeBooster.sliderPositionToPercent(pos);
    // 100..300 区間は線形 100..200 にマップされるので 1〜2 単位の round 誤差を許容
    assert.ok(Math.abs(back - pct) <= 2, `pct=${pct} round-trip got ${back} via pos=${pos}`);
  }
});

test("VolumeBooster.sliderPositionToPercent: SLIDER_UNITY で UNITY", () => {
  assert.equal(
    G.VolumeBooster.sliderPositionToPercent(G.VolumeBooster.SLIDER_UNITY),
    G.VolumeBooster.UNITY
  );
});

// ---------- VolumeBooster.isEmeHost / isEmeUrl: EME 多用サイト判定 ----------

test("VolumeBooster.isEmeHost: 主要 EME サイトを true 判定", () => {
  // ベース hostname
  assert.equal(G.VolumeBooster.isEmeHost("netflix.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("www.netflix.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("primevideo.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("www.primevideo.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("amazon.co.jp"), true);
  assert.equal(G.VolumeBooster.isEmeHost("www.amazon.co.jp"), true);
  assert.equal(G.VolumeBooster.isEmeHost("amazon.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("dazn.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("disneyplus.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("www.disneyplus.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("hulu.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("hulu.jp"), true);
  assert.equal(G.VolumeBooster.isEmeHost("tv.apple.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("abema.tv"), true);
  assert.equal(G.VolumeBooster.isEmeHost("unext.jp"), true);
  assert.equal(G.VolumeBooster.isEmeHost("tver.jp"), true);
  assert.equal(G.VolumeBooster.isEmeHost("nhk-ondemand.jp"), true);
  assert.equal(G.VolumeBooster.isEmeHost("spotify.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("open.spotify.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("fod.fujitv.co.jp"), true);
  assert.equal(G.VolumeBooster.isEmeHost("spoox.jp"), true);
});

test("VolumeBooster.isEmeHost: 非 EME サイトを false 判定", () => {
  assert.equal(G.VolumeBooster.isEmeHost("youtube.com"), false);
  assert.equal(G.VolumeBooster.isEmeHost("www.youtube.com"), false);
  assert.equal(G.VolumeBooster.isEmeHost("twitch.tv"), false);
  assert.equal(G.VolumeBooster.isEmeHost("nicovideo.jp"), false);
  assert.equal(G.VolumeBooster.isEmeHost("x.com"), false);
  assert.equal(G.VolumeBooster.isEmeHost("instagram.com"), false);
  assert.equal(G.VolumeBooster.isEmeHost("tiktok.com"), false);
  assert.equal(G.VolumeBooster.isEmeHost("example.com"), false);
});

test("VolumeBooster.isEmeHost: 紛らわしい hostname に騙されない (suffix attack 防御)", () => {
  // `evil-netflix.com` は netflix.com にエスケープシーケンスで一致しちゃダメ
  assert.equal(G.VolumeBooster.isEmeHost("evil-netflix.com"), false);
  assert.equal(G.VolumeBooster.isEmeHost("notnetflix.com"), false);
  // `netflix.com.evil.com` 系も false
  assert.equal(G.VolumeBooster.isEmeHost("netflix.com.evil.com"), false);
  assert.equal(G.VolumeBooster.isEmeHost("netflixcom"), false);
});

test("VolumeBooster.isEmeHost: 大文字混じり / 不正値", () => {
  assert.equal(G.VolumeBooster.isEmeHost("NETFLIX.COM"), true);
  assert.equal(G.VolumeBooster.isEmeHost("Www.Netflix.Com"), true);
  assert.equal(G.VolumeBooster.isEmeHost(""), false);
  assert.equal(G.VolumeBooster.isEmeHost(null), false);
  assert.equal(G.VolumeBooster.isEmeHost(undefined), false);
  assert.equal(G.VolumeBooster.isEmeHost(123), false);
});

test("VolumeBooster.isEmeUrl: URL から hostname を抽出して判定", () => {
  assert.equal(G.VolumeBooster.isEmeUrl("https://www.netflix.com/watch/12345"), true);
  assert.equal(G.VolumeBooster.isEmeUrl("https://www.amazon.co.jp/gp/video/detail/B0XXX"), true);
  assert.equal(G.VolumeBooster.isEmeUrl("https://spoox.jp/play/foo"), true);
  assert.equal(G.VolumeBooster.isEmeUrl("https://www.youtube.com/watch?v=abc"), false);
  // 不正 URL は false
  assert.equal(G.VolumeBooster.isEmeUrl("not a url"), false);
  assert.equal(G.VolumeBooster.isEmeUrl(""), false);
  assert.equal(G.VolumeBooster.isEmeUrl(null), false);
});

// ---------- StorageKeys: 音量ブースター系の鍵が揃っているか ----------

test("StorageKeys.VOLUME_BOOSTER_* が 6 キー揃っている（master + lastGain + 3 サブトグル + muted）", () => {
  // 6 キーいずれかを追加・削除する場合は次を必ず同時更新:
  //   - background.js の cachedVolumeSettings 監視リストと onInstalled 初期化
  //   - popup.js の storage.local.get / event handler
  //   - _locales/{en,ja}/messages.json (UI 露出する場合)
  //   - CLAUDE.md "5 storage key" / "6 storage key" の数値整合
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_ENABLED, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_LAST_GAIN, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED, "string");
  // 旧仕様の混入チェック (snake_case や大文字小文字違いの誤キー混入を防ぐ)
  assert.equal(G.StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED, "volumeBoosterMutedEnabled");
});

// ---------- VideoGamma ----------

test("VideoGamma.clampValue: 範囲内の値はそのまま、範囲外は clamp、不正値は DEFAULT", () => {
  assert.equal(G.VideoGamma.clampValue(1.0), 1.0);
  assert.equal(G.VideoGamma.clampValue(0.5), 0.5);
  assert.equal(G.VideoGamma.clampValue(2.5), 2.5);
  assert.equal(G.VideoGamma.clampValue(-1), G.VideoGamma.MIN);
  assert.equal(G.VideoGamma.clampValue(0.1), G.VideoGamma.MIN);
  assert.equal(G.VideoGamma.clampValue(99), G.VideoGamma.MAX);
  assert.equal(G.VideoGamma.clampValue(NaN), G.VideoGamma.DEFAULT);
  assert.equal(G.VideoGamma.clampValue("abc"), G.VideoGamma.DEFAULT);
  assert.equal(G.VideoGamma.clampValue(undefined), G.VideoGamma.DEFAULT);
});

test("VideoGamma slider ↔ value round-trip (SLIDER_MIN..SLIDER_MAX)", () => {
  // 内部 clampValue が 0.01 単位に丸めるため、端数の slider 整数で 1 step ずれる箇所がある。
  // VolumeBooster の round-trip テストと同じく、誤差 1 単位以内を許容する。
  for (let s = G.VideoGamma.SLIDER_MIN; s <= G.VideoGamma.SLIDER_MAX; s += G.VideoGamma.SLIDER_STEP) {
    const v = G.VideoGamma.sliderToValue(s);
    const back = G.VideoGamma.valueToSlider(v);
    assert.ok(Math.abs(back - s) <= 1, `slider=${s} round-trip got ${back} via value=${v}`);
  }
});

test("VideoGamma.sliderToValue: SLIDER_DEFAULT で DEFAULT (1.0)", () => {
  assert.equal(G.VideoGamma.sliderToValue(G.VideoGamma.SLIDER_DEFAULT), G.VideoGamma.DEFAULT);
});

test("VideoGamma.sliderToValue: 反転マッピング (右端=明るい / 左端=暗い)", () => {
  // 右端: ガンマ MIN (0.3, 暗部持ち上げで明るく見える)
  assert.equal(G.VideoGamma.sliderToValue(G.VideoGamma.SLIDER_MAX), G.VideoGamma.MIN);
  // 左端: ガンマ MAX (3.0, 暗部潰しで暗く見える)
  assert.equal(G.VideoGamma.sliderToValue(G.VideoGamma.SLIDER_MIN), G.VideoGamma.MAX);
});

test("VideoGamma.isUnity: DEFAULT 近傍で true、それ以外で false", () => {
  assert.equal(G.VideoGamma.isUnity(1.0), true);
  assert.equal(G.VideoGamma.isUnity(1.001), true); // 0.005 未満は unity 扱い
  assert.equal(G.VideoGamma.isUnity(1.01), false);
  assert.equal(G.VideoGamma.isUnity(0.5), false);
  assert.equal(G.VideoGamma.isUnity(2.0), false);
});

// ---------- VideoFill (動画黒帯除去) ----------

test("VideoFill.normalizeMode: stretch のみ stretch、それ以外は zoom にフォールバック", () => {
  assert.equal(G.VideoFill.normalizeMode("stretch"), "stretch");
  assert.equal(G.VideoFill.normalizeMode("zoom"), "zoom");
  assert.equal(G.VideoFill.normalizeMode("bogus"), "zoom");
  assert.equal(G.VideoFill.normalizeMode(undefined), "zoom");
  assert.equal(G.VideoFill.normalizeMode(null), "zoom");
});

test("VideoFill.normalizeTarget: 既知 id はそのまま、未知は DEFAULT_TARGET", () => {
  assert.equal(G.VideoFill.normalizeTarget("21:9"), "21:9");
  assert.equal(G.VideoFill.normalizeTarget("3440x1440"), "3440x1440");
  assert.equal(G.VideoFill.normalizeTarget("bogus"), G.VideoFill.DEFAULT_TARGET);
  assert.equal(G.VideoFill.normalizeTarget(undefined), G.VideoFill.DEFAULT_TARGET);
  // DEFAULT_TARGET は実在するプリセット
  assert.ok(G.VideoFill.PRESETS.some((p) => p.id === G.VideoFill.DEFAULT_TARGET));
});

test("VideoFill.targetAspect: プリセットの縦横比を返す（解像度 id も実ピクセル比）", () => {
  assert.ok(Math.abs(G.VideoFill.targetAspect("16:9") - 16 / 9) < 1e-9);
  assert.ok(Math.abs(G.VideoFill.targetAspect("32:9") - 32 / 9) < 1e-9);
  assert.ok(Math.abs(G.VideoFill.targetAspect("3440x1440") - 3440 / 1440) < 1e-9);
  // 未知 id は DEFAULT_TARGET の縦横比
  assert.equal(G.VideoFill.targetAspect("bogus"), G.VideoFill.targetAspect(G.VideoFill.DEFAULT_TARGET));
});

test("VideoFill.computeTransform[zoom]: 16:9 動画を 21:9 モニターに → 一様 scale でクロップ", () => {
  // target 21:9 (2560/1080 ≈ 2.370), video 16:9 (1.778) → scale = 2.370/1.778 ≈ 1.333
  const t = G.VideoFill.computeTransform(2560 / 1080, 1920, 1080, "zoom");
  assert.match(t, /^scale\(1\.33\d*\)$/, t);
});

test("VideoFill.computeTransform[zoom]: ワイド動画 (21:9) を 16:9 モニターに → video/target で拡大", () => {
  // 動画の方がワイドなケース（ゆろさん指摘）。target 16:9 < video 21:9 なので scale = va/ta
  const t = G.VideoFill.computeTransform(16 / 9, 2560, 1080, "zoom");
  // va=2.370, ta=1.778 → 1.333
  assert.match(t, /^scale\(1\.33\d*\)$/, t);
});

test("VideoFill.computeTransform[zoom]: 縦横比が一致したら補正不要（空文字）", () => {
  assert.equal(G.VideoFill.computeTransform(16 / 9, 1920, 1080, "zoom"), "");
});

test("VideoFill.computeTransform[stretch]: 不足軸だけを引き伸ばす（横不足→scaleX / 縦不足→scaleY）", () => {
  // target 21:9 > video 16:9 → 横不足 → scaleX
  assert.match(G.VideoFill.computeTransform(2560 / 1080, 1920, 1080, "stretch"), /^scaleX\(/);
  // target 16:9 < video 21:9 → 縦不足 → scaleY
  assert.match(G.VideoFill.computeTransform(16 / 9, 2560, 1080, "stretch"), /^scaleY\(/);
  // 一致なら空
  assert.equal(G.VideoFill.computeTransform(16 / 9, 1920, 1080, "stretch"), "");
});

test("VideoFill.computeTransform: 不正な寸法（0 / NaN / metadata 未確定）は空文字", () => {
  assert.equal(G.VideoFill.computeTransform(21 / 9, 0, 0, "zoom"), "");
  assert.equal(G.VideoFill.computeTransform(21 / 9, 1920, 0, "zoom"), "");
  assert.equal(G.VideoFill.computeTransform(NaN, 1920, 1080, "zoom"), "");
});

test("VideoFill.computeTransform: 極端な組み合わせは MAX_SCALE で clamp", () => {
  // 縦長 9:16 動画を 32:9 モニターに → 倍率 ≈ 6.3 → MAX_SCALE (4.0) で頭打ち
  const t = G.VideoFill.computeTransform(32 / 9, 900, 1600, "zoom");
  assert.equal(t, `scale(${G.VideoFill.MAX_SCALE})`);
});

// ---------- Loupe ----------

test("Loupe.validateZoom: ZOOM_LEVELS 内はそのまま、それ以外は DEFAULT_ZOOM", () => {
  // 有効値: ZOOM_LEVELS の全要素
  for (const z of G.Loupe.ZOOM_LEVELS) {
    assert.equal(G.Loupe.validateZoom(z), z, `valid zoom ${z}`);
  }
  // 無効値: DEFAULT_ZOOM にフォールバック
  assert.equal(G.Loupe.validateZoom(3.0), G.Loupe.DEFAULT_ZOOM);
  assert.equal(G.Loupe.validateZoom(0), G.Loupe.DEFAULT_ZOOM);
  assert.equal(G.Loupe.validateZoom(-1), G.Loupe.DEFAULT_ZOOM);
  assert.equal(G.Loupe.validateZoom(NaN), G.Loupe.DEFAULT_ZOOM);
  assert.equal(G.Loupe.validateZoom("abc"), G.Loupe.DEFAULT_ZOOM);
  assert.equal(G.Loupe.validateZoom(undefined), G.Loupe.DEFAULT_ZOOM);
  assert.equal(G.Loupe.validateZoom(null), G.Loupe.DEFAULT_ZOOM);
});

test("Loupe.clampSize: 範囲内は STEP 丸め、範囲外は clamp、不正値は DEFAULT", () => {
  // 境界値
  assert.equal(G.Loupe.clampSize(G.Loupe.SIZE_MIN), G.Loupe.SIZE_MIN);
  assert.equal(G.Loupe.clampSize(G.Loupe.SIZE_MAX), G.Loupe.SIZE_MAX);
  assert.equal(G.Loupe.clampSize(G.Loupe.SIZE_DEFAULT), G.Loupe.SIZE_DEFAULT);
  // 範囲外 clamp（下限・上限とも）
  assert.equal(G.Loupe.clampSize(100), G.Loupe.SIZE_MIN);
  assert.equal(G.Loupe.clampSize(0), G.Loupe.SIZE_MIN);
  // SIZE_MAX を超える値は SIZE_MAX に clamp（SIZE_MAX+1 以上で確実に clamp 経路に入る値で検証）
  assert.equal(G.Loupe.clampSize(G.Loupe.SIZE_MAX + 100), G.Loupe.SIZE_MAX);
  assert.equal(G.Loupe.clampSize(9999), G.Loupe.SIZE_MAX);
  // 範囲内の中間値は STEP 丸めで返る（500 は範囲内になったので clamp ではなく round パス）
  assert.equal(G.Loupe.clampSize(500), 500);
  // STEP 丸め（SIZE_STEP=10: 155→160, 154→150）
  assert.equal(G.Loupe.clampSize(155), 160);
  assert.equal(G.Loupe.clampSize(154), 150);
  assert.equal(G.Loupe.clampSize(225), 230);
  // 不正値
  assert.equal(G.Loupe.clampSize(NaN), G.Loupe.SIZE_DEFAULT);
  assert.equal(G.Loupe.clampSize(undefined), G.Loupe.SIZE_DEFAULT);
  assert.equal(G.Loupe.clampSize("abc"), G.Loupe.SIZE_DEFAULT);
  assert.equal(G.Loupe.clampSize(null), G.Loupe.SIZE_DEFAULT);
});

test("Loupe.ZOOM_LEVELS は DEFAULT_ZOOM を含む（不変条件）", () => {
  assert.ok(
    G.Loupe.ZOOM_LEVELS.includes(G.Loupe.DEFAULT_ZOOM),
    "DEFAULT_ZOOM が ZOOM_LEVELS に含まれていないと validateZoom(DEFAULT_ZOOM) が再帰的に DEFAULT を返す矛盾"
  );
});

test("Loupe.SIZE_DEFAULT は [SIZE_MIN, SIZE_MAX] の範囲内（不変条件）", () => {
  assert.ok(G.Loupe.SIZE_DEFAULT >= G.Loupe.SIZE_MIN);
  assert.ok(G.Loupe.SIZE_DEFAULT <= G.Loupe.SIZE_MAX);
});

test("Loupe.computeLensPosition: カーソルがレンズ中央に来る座標を返す", () => {
  // mouseX=500, mouseY=300, lensSize=200 → left=400, top=200
  const p = G.Loupe.computeLensPosition(500, 300, 200);
  assert.equal(p.left, 400);
  assert.equal(p.top, 200);
  // 端点: mouseX=0 で left=-lensSize/2 (画面外への食み出し許容)
  const p2 = G.Loupe.computeLensPosition(0, 0, 220);
  assert.equal(p2.left, -110);
  assert.equal(p2.top, -110);
});

test("Loupe.computeBackgroundPosition: zoom=2.5 でマウス位置の領域が中央に来る", () => {
  // mouseX=100, mouseY=100, zoom=2.5, lensRadius=110
  // bgX = 110 - 100*2.5 = 110 - 250 = -140
  // bgY = 110 - 100*2.5 = -140
  const bp = G.Loupe.computeBackgroundPosition(100, 100, 2.5, 110);
  assert.equal(bp.bgX, -140);
  assert.equal(bp.bgY, -140);
  // zoom=1.5 / mouseX=400, mouseY=300, lensRadius=110
  // bgX = 110 - 400*1.5 = 110 - 600 = -490
  // bgY = 110 - 300*1.5 = 110 - 450 = -340
  const bp2 = G.Loupe.computeBackgroundPosition(400, 300, 1.5, 110);
  assert.equal(bp2.bgX, -490);
  assert.equal(bp2.bgY, -340);
});

test("Loupe.formatLoupeError: 想定 code は対応キー、想定外は loupeErrorUnknown", () => {
  assert.equal(G.Loupe.formatLoupeError("no tab"), "loupeErrorInvalidTab");
  assert.equal(G.Loupe.formatLoupeError("invalid-tab-id"), "loupeErrorInvalidTab");
  assert.equal(
    G.Loupe.formatLoupeError("Cannot access contents of url chrome://newtab"),
    "loupeErrorUnsupportedPage"
  );
  assert.equal(G.Loupe.formatLoupeError("Cannot capture this page"), "loupeErrorUnsupportedPage");
  assert.equal(G.Loupe.formatLoupeError("permission denied"), "loupeErrorPermission");
  assert.equal(
    G.Loupe.formatLoupeError("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND exceeded"),
    "loupeErrorQuota"
  );
  // 未知の code
  assert.equal(G.Loupe.formatLoupeError(""), "loupeErrorUnknown");
  assert.equal(G.Loupe.formatLoupeError(null), "loupeErrorUnknown");
  assert.equal(G.Loupe.formatLoupeError(undefined), "loupeErrorUnknown");
  assert.equal(G.Loupe.formatLoupeError("something random"), "loupeErrorUnknown");
});

test("StorageKeys.LOUPE_* が 3 キー揃っている", () => {
  assert.equal(G.StorageKeys.LOUPE_ENABLED, "loupeEnabled");
  assert.equal(G.StorageKeys.LOUPE_ZOOM, "loupeZoom");
  assert.equal(G.StorageKeys.LOUPE_SIZE, "loupeSize");
});

// ---------- KeepAlive ----------

test("KeepAlive.clampIntervalMs: 範囲内・範囲外・不正値の正規化", () => {
  const mid = (G.KeepAlive.MIN_INTERVAL_MS + G.KeepAlive.MAX_INTERVAL_MS) / 2;
  assert.equal(G.KeepAlive.clampIntervalMs(mid), mid);
  assert.equal(G.KeepAlive.clampIntervalMs(0), G.KeepAlive.MIN_INTERVAL_MS);
  assert.equal(G.KeepAlive.clampIntervalMs(-100), G.KeepAlive.MIN_INTERVAL_MS);
  assert.equal(
    G.KeepAlive.clampIntervalMs(G.KeepAlive.MAX_INTERVAL_MS * 10),
    G.KeepAlive.MAX_INTERVAL_MS
  );
  assert.equal(G.KeepAlive.clampIntervalMs(NaN), G.KeepAlive.DEFAULT_INTERVAL_MS);
  assert.equal(G.KeepAlive.clampIntervalMs("abc"), G.KeepAlive.DEFAULT_INTERVAL_MS);
  assert.equal(G.KeepAlive.clampIntervalMs(undefined), G.KeepAlive.DEFAULT_INTERVAL_MS);
});


// ---------- SearchFixer ----------

test("SearchFixer.clampGridItems: 0/4/5/6 のみ受理", () => {
  assert.equal(G.SearchFixer.clampGridItems(0), 0);
  assert.equal(G.SearchFixer.clampGridItems(4), 4);
  assert.equal(G.SearchFixer.clampGridItems(5), 5);
  assert.equal(G.SearchFixer.clampGridItems(6), 6);
  assert.equal(G.SearchFixer.clampGridItems(3), 0);
  assert.equal(G.SearchFixer.clampGridItems(7), 0);
  assert.equal(G.SearchFixer.clampGridItems(NaN), 0);
  assert.equal(G.SearchFixer.clampGridItems("4"), 4);
  assert.equal(G.SearchFixer.clampGridItems(null), 0);
});

test("SearchFixer.mergeFeatures: undefined / null / 不正型は DEFAULT_FEATURES と同等", () => {
  const fromUndef = G.SearchFixer.mergeFeatures(undefined);
  const fromNull = G.SearchFixer.mergeFeatures(null);
  const fromString = G.SearchFixer.mergeFeatures("invalid");
  assert.deepEqual(fromUndef, fromNull);
  assert.deepEqual(fromUndef, fromString);
  // 全機能定義のキーが揃っている（mergeFeatures が DEFAULT_FEATURES を被せて全キー揃う）
  for (const feature of G.SearchFixer.FEATURES) {
    assert.ok(feature.key in fromUndef, `feature ${feature.key} missing in merged result`);
  }
});

test("SearchFixer.mergeFeatures: partial オブジェクトは欠損キーを default で埋める", () => {
  const merged = G.SearchFixer.mergeFeatures({ removeShortsShelf: true });
  assert.equal(merged.removeShortsShelf, true);
  // 他のキーは default (false) が補完される
  for (const feature of G.SearchFixer.FEATURES) {
    if (feature.key !== "removeShortsShelf") {
      assert.equal(typeof merged[feature.key], "boolean");
    }
  }
});

test("SearchFixer.isFeedPath: ホーム / 登録 / 急上昇 等は true、それ以外は false", () => {
  // フィードページ
  assert.equal(G.SearchFixer.isFeedPath("/"), true);
  assert.equal(G.SearchFixer.isFeedPath("/feed/subscriptions"), true);
  assert.equal(G.SearchFixer.isFeedPath("/feed/trending"), true);
  assert.equal(G.SearchFixer.isFeedPath("/feed/explore"), true);
  assert.equal(G.SearchFixer.isFeedPath("/feed/history"), true);
  assert.equal(G.SearchFixer.isFeedPath("/feed/library"), true);
  assert.equal(G.SearchFixer.isFeedPath("/feed/subscriptions?u=1"), true);
  // フィードではない
  assert.equal(G.SearchFixer.isFeedPath("/results"), false);
  assert.equal(G.SearchFixer.isFeedPath("/watch"), false);
  assert.equal(G.SearchFixer.isFeedPath("/shorts/abc"), false);
  assert.equal(G.SearchFixer.isFeedPath("/@channel"), false);
  // 不正型
  assert.equal(G.SearchFixer.isFeedPath(undefined), false);
  assert.equal(G.SearchFixer.isFeedPath(null), false);
  assert.equal(G.SearchFixer.isFeedPath(123), false);
});

test("SearchFixer.extractHandleFromHref: ASCII / Unicode / URL encoded / 不正値", () => {
  // ASCII handle (既存動作の維持)
  assert.equal(G.SearchFixer.extractHandleFromHref("/@shachikuolrisa"), "@shachikuolrisa");
  assert.equal(G.SearchFixer.extractHandleFromHref("/@nagumorui/featured"), "@nagumorui");
  assert.equal(G.SearchFixer.extractHandleFromHref("/@Im10cm?si=xxx"), "@Im10cm");
  assert.equal(G.SearchFixer.extractHandleFromHref("/@HoriKChannel#anchor"), "@HoriKChannel");

  // 日本語ハンドル (生 Unicode、テスト用に href にそのまま入るケース)
  assert.equal(G.SearchFixer.extractHandleFromHref("/@むめいの有名になりたい"), "@むめいの有名になりたい");
  assert.equal(G.SearchFixer.extractHandleFromHref("/@あゆむさんぽ"), "@あゆむさんぽ");

  // URL エンコード形式 (DOM の getAttribute("href") が実機で返す形)
  assert.equal(
    G.SearchFixer.extractHandleFromHref(
      "/@%E3%82%80%E3%82%81%E3%81%84%E3%81%AE%E6%9C%89%E5%90%8D%E3%81%AB%E3%81%AA%E3%82%8A%E3%81%9F%E3%81%84"
    ),
    "@むめいの有名になりたい"
  );
  assert.equal(
    G.SearchFixer.extractHandleFromHref("/@%E3%81%82%E3%82%86%E3%82%80%E3%81%95%E3%82%93%E3%81%BD"),
    "@あゆむさんぽ"
  );

  // ASCII + Unicode 混在 (Aila's 足脚の世界 = `@Ailas` + 日本語、旧実装で完全失敗していたケース)
  assert.equal(
    G.SearchFixer.extractHandleFromHref("/@Ailas%E8%B6%B3%E8%84%9A%E3%81%AE%E4%B8%96%E7%95%8C"),
    "@Ailas足脚の世界"
  );

  // 韓国語 / 中国語 (将来の登録ケース)
  assert.equal(G.SearchFixer.extractHandleFromHref("/@한국어"), "@한국어");
  assert.equal(G.SearchFixer.extractHandleFromHref("/@中文ch"), "@中文ch");

  // 不正値・非 @ 形式
  assert.equal(G.SearchFixer.extractHandleFromHref(null), null);
  assert.equal(G.SearchFixer.extractHandleFromHref(undefined), null);
  assert.equal(G.SearchFixer.extractHandleFromHref(""), null);
  assert.equal(G.SearchFixer.extractHandleFromHref("/channel/UCxxxxx"), null);
  assert.equal(G.SearchFixer.extractHandleFromHref("/watch?v=abc"), null);

  // 不正な % シーケンス（decodeURIComponent が throw）→ 素の href にフォールバック
  // `@bad` までは ASCII でマッチ可能だが、直後が `%` なので終端マッチに失敗 → null
  assert.equal(G.SearchFixer.extractHandleFromHref("/@bad%ZZ%fail"), null);
});

test("SearchFixer.FEATURES: 旧 removeShorts は 4 機能に解体され Shorts カテゴリは廃止", () => {
  // 旧キー removeShorts は存在せず、4 機能に分離されている
  const removeShorts = G.SearchFixer.FEATURES.find((f) => f.key === "removeShorts");
  assert.equal(removeShorts, undefined, "旧 removeShorts キーは廃止");

  const removeShortsShelf = G.SearchFixer.FEATURES.find((f) => f.key === "removeShortsShelf");
  const removeShortsChip = G.SearchFixer.FEATURES.find((f) => f.key === "removeShortsChip");
  const removeShortsSidebar = G.SearchFixer.FEATURES.find((f) => f.key === "removeShortsSidebar");
  const redirectShortsUrl = G.SearchFixer.FEATURES.find((f) => f.key === "redirectShortsUrl");
  assert.ok(removeShortsShelf);
  assert.ok(removeShortsChip);
  assert.ok(removeShortsSidebar);
  assert.ok(redirectShortsUrl);

  // それぞれの分離先カテゴリ
  assert.equal(removeShortsShelf.category, "video_filter");
  assert.equal(removeShortsChip.category, "search_only");
  assert.equal(removeShortsSidebar.category, "menu_ui");
  assert.equal(redirectShortsUrl.category, "watch_page");
});

test("SearchFixer.CATEGORIES: menu_ui / video_filter / watch_page / search_only の 4 個", () => {
  const ids = G.SearchFixer.CATEGORIES.map((c) => c.id);
  assert.deepEqual(ids, ["menu_ui", "video_filter", "watch_page", "search_only"]);
});

test("SearchFixer.FEATURES: 動画フィルタは playlist/mix/shortsBtn/live/membersOnly/watched + removeShortsShelf + removeTopicsSection + removeBreakingNewsSection", () => {
  const expectedVideoFilterKeys = [
    "playlist", "mix", "shortsBtn", "live", "membersOnly", "watched",
    "removeShortsShelf", "removeTopicsSection", "removeBreakingNewsSection",
  ];
  for (const key of expectedVideoFilterKeys) {
    const feature = G.SearchFixer.FEATURES.find((f) => f.key === key);
    assert.ok(feature, `feature ${key} exists`);
    assert.equal(feature.category, "video_filter", `${key} is in video_filter`);
  }
});

test("SearchFixer.FEATURES: 検索結果ページ専用機能は search_only にまとめられている", () => {
  const expectedSearchOnlyKeys = [
    "shelf", "cardList", "course", "channel", "reel", "secondary", "chapter",
    "verified", "artist",
    "demoteUnmatched", "highlightThumb",
    "searchGrid",
    "removeShortsChip",
  ];
  for (const key of expectedSearchOnlyKeys) {
    const feature = G.SearchFixer.FEATURES.find((f) => f.key === key);
    assert.ok(feature, `feature ${key} exists`);
    assert.equal(feature.category, "search_only", `${key} is in search_only`);
  }
});

test("SearchFixer.FEATURES: 動画ページ系 + redirectShortsUrl が watch_page に集約", () => {
  const expectedWatchPageKeys = [
    "hideComments", "hideLiveChat", "redirectShortsUrl",
  ];
  for (const key of expectedWatchPageKeys) {
    const feature = G.SearchFixer.FEATURES.find((f) => f.key === key);
    assert.ok(feature, `feature ${key} exists`);
    assert.equal(feature.category, "watch_page", `${key} is in watch_page`);
  }
});

test("SearchFixer.FEATURES: メニュー/UI カテゴリは removeShortsSidebar を含む", () => {
  const removeShortsSidebar = G.SearchFixer.FEATURES.find((f) => f.key === "removeShortsSidebar");
  assert.ok(removeShortsSidebar);
  assert.equal(removeShortsSidebar.category, "menu_ui");
});

test("YouTubeShorts: SELECTORS が 3 分割されている (SHELF / CHIP / SIDEBAR)", () => {
  assert.ok(Array.isArray(G.YouTubeShorts.SELECTORS_SHELF));
  assert.ok(Array.isArray(G.YouTubeShorts.SELECTORS_CHIP));
  assert.ok(Array.isArray(G.YouTubeShorts.SELECTORS_SIDEBAR));
  // 旧 SELECTORS_REMOVE は廃止
  assert.equal(G.YouTubeShorts.SELECTORS_REMOVE, undefined);
  // SHELF: 棚系
  assert.ok(G.YouTubeShorts.SELECTORS_SHELF.includes("ytd-reel-shelf-renderer"));
  assert.ok(G.YouTubeShorts.SELECTORS_SHELF.includes("ytd-rich-shelf-renderer[is-shorts]"));
  // CHIP: チップ系
  assert.ok(G.YouTubeShorts.SELECTORS_CHIP.some((s) => s.includes("yt-chip-cloud-chip-renderer")));
  // SIDEBAR: サイドバーメニュー
  assert.ok(G.YouTubeShorts.SELECTORS_SIDEBAR.some((s) => s.includes("ytd-guide-entry-renderer")));
  assert.ok(G.YouTubeShorts.SELECTORS_SIDEBAR.some((s) => s.includes("ytd-mini-guide-entry-renderer")));
});

// ---------- InstagramCleaner ----------

test("InstagramCleaner.mergeFeatures: undefined / null / 不正型は default", () => {
  const fromUndef = G.InstagramCleaner.mergeFeatures(undefined);
  const fromNull = G.InstagramCleaner.mergeFeatures(null);
  const fromArray = G.InstagramCleaner.mergeFeatures([]);
  assert.deepEqual(fromUndef, fromNull);
  assert.deepEqual(fromUndef, fromArray);
  for (const feature of G.InstagramCleaner.FEATURES) {
    assert.ok(feature.key in fromUndef);
  }
});

test("InstagramCleaner.mergeFeatures: partial は欠損 default 補完", () => {
  const merged = G.InstagramCleaner.mergeFeatures({ reels: true });
  assert.equal(merged.reels, true);
  for (const feature of G.InstagramCleaner.FEATURES) {
    if (feature.key !== "reels") {
      assert.equal(typeof merged[feature.key], "boolean");
    }
  }
});

// ---------- ColorPicker ----------

test("ColorPicker.isValidFormat / normalizeFormat", () => {
  assert.equal(G.ColorPicker.isValidFormat("hex"), true);
  assert.equal(G.ColorPicker.isValidFormat("rgb"), true);
  assert.equal(G.ColorPicker.isValidFormat("hsl"), true);
  assert.equal(G.ColorPicker.isValidFormat("xyz"), false);
  assert.equal(G.ColorPicker.isValidFormat(undefined), false);
  assert.equal(G.ColorPicker.normalizeFormat("hex"), "hex");
  assert.equal(G.ColorPicker.normalizeFormat("invalid"), G.ColorPicker.DEFAULT_FORMAT);
});

// ---------- PopupTabs ----------

test("PopupTabs.isValid / normalize: 5 タブ識別子のみ受理、不正値は TUNE", () => {
  for (const id of G.PopupTabs.ALL) {
    assert.equal(G.PopupTabs.isValid(id), true, `${id} should be valid`);
  }
  assert.equal(G.PopupTabs.isValid("assist"), false); // 旧値は invalid 扱い
  assert.equal(G.PopupTabs.isValid("xyz"), false);
  assert.equal(G.PopupTabs.isValid(undefined), false);
  assert.equal(G.PopupTabs.normalize("youtube"), "youtube");
  assert.equal(G.PopupTabs.normalize("invalid"), G.PopupTabs.TUNE);
  assert.equal(G.PopupTabs.normalize(undefined), G.PopupTabs.TUNE);
});

test("PopupTabs.migrate: 旧 \"assist\" は \"tune\" に変換、それ以外は normalize と同じ", () => {
  assert.equal(G.PopupTabs.migrate("assist"), G.PopupTabs.TUNE);
  assert.equal(G.PopupTabs.migrate("picker"), "picker");
  assert.equal(G.PopupTabs.migrate("invalid"), G.PopupTabs.TUNE);
  assert.equal(G.PopupTabs.migrate(undefined), G.PopupTabs.TUNE);
});

// ---------- 再評価ガードのテスト ----------

test("actions.js の再評価は __cpaActionsLoaded ガードで早期 return", () => {
  // _load-actions.js が既に評価済み。同じコードを別 sandbox で評価して動作確認
  const fs = require("node:fs");
  const vm = require("node:vm");
  const path = require("node:path");
  const code = fs.readFileSync(
    path.join(__dirname, "..", "src", "lib", "actions.js"),
    "utf8"
  );
  const ctx = { globalThis: { __cpaActionsLoaded: true }, console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  // ガードが効いていれば globalThis.Actions は **書き込まれない**
  assert.equal(ctx.globalThis.Actions, undefined, "再評価ガードが効いていない");
});

test("actions.js は globalThis に 21 個の定数を公開する", () => {
  const required = [
    "SettingsSchema",
    "Actions",
    "ExtensionPaths",
    "SenderCheck",
    "Offscreen",
    "StorageKeys",
    "KeepAlive",
    "YouTubeShorts",
    "SearchFixer",
    "AmazonDeliveryTotal",
    "AmazonRankingJump",
    "AmazonReleaseDate",
    "InstagramCleaner",
    "TikTokCleaner",
    "ImageDownloader",
    "VolumeBooster",
    "VideoGamma",
    "VideoFill",
    "Loupe",
    "ColorPicker",
    "PopupTabs",
  ];
  for (const k of required) {
    assert.ok(G[k] && typeof G[k] === "object", `missing globalThis.${k}`);
  }
});

test("TikTokCleaner.mergeFeatures: undefined / null / 不正型は default", () => {
  for (const value of [undefined, null, 0, "x", []]) {
    const merged = G.TikTokCleaner.mergeFeatures(value);
    assert.deepEqual(merged, G.TikTokCleaner.DEFAULT_FEATURES);
  }
});

test("TikTokCleaner.mergeFeatures: partial は欠損 default 補完", () => {
  const partial = { hideComments: true };
  const merged = G.TikTokCleaner.mergeFeatures(partial);
  assert.equal(merged.hideComments, true);
  assert.equal(merged.hideSuggested, false);
});

// ---------- ImageDownloader ----------

test("ImageDownloader.detectHost: instagram / tiktok のサブドメインも認識", () => {
  assert.equal(G.ImageDownloader.detectHost({ hostname: "instagram.com" }), "instagram");
  assert.equal(G.ImageDownloader.detectHost({ hostname: "www.instagram.com" }), "instagram");
  assert.equal(G.ImageDownloader.detectHost({ hostname: "tiktok.com" }), "tiktok");
  assert.equal(G.ImageDownloader.detectHost({ hostname: "www.tiktok.com" }), "tiktok");
});

test("ImageDownloader.detectHost: 大文字混じり / null / undefined / 非対応ホストは null", () => {
  assert.equal(G.ImageDownloader.detectHost({ hostname: "Instagram.COM" }), "instagram");
  assert.equal(G.ImageDownloader.detectHost({ hostname: "youtube.com" }), null);
  assert.equal(G.ImageDownloader.detectHost({ hostname: "example.com" }), null);
  assert.equal(G.ImageDownloader.detectHost({ hostname: "fake-instagram.com" }), null);
  assert.equal(G.ImageDownloader.detectHost({ hostname: "instagram.com.evil.com" }), null);
  assert.equal(G.ImageDownloader.detectHost(null), null);
  assert.equal(G.ImageDownloader.detectHost(undefined), null);
  assert.equal(G.ImageDownloader.detectHost({}), null);
  assert.equal(G.ImageDownloader.detectHost({ hostname: 123 }), null);
});

test("ImageDownloader.buildFilename: 形式 `{host}_{YYYYMMDD_HHMMSS}.{ext}` で生成", () => {
  const filename = G.ImageDownloader.buildFilename("instagram", "image/jpeg");
  assert.match(filename, /^instagram_\d{8}_\d{6}\.jpg$/);

  const png = G.ImageDownloader.buildFilename("instagram", "image/png");
  assert.match(png, /^instagram_\d{8}_\d{6}\.png$/);

  const webp = G.ImageDownloader.buildFilename("tiktok", "image/webp");
  assert.match(webp, /^tiktok_\d{8}_\d{6}\.webp$/);
});

test("ImageDownloader.buildFilename: 不明な MIME は jpg にフォールバック", () => {
  const filename = G.ImageDownloader.buildFilename("instagram", "application/octet-stream");
  assert.match(filename, /^instagram_\d{8}_\d{6}\.jpg$/);

  const empty = G.ImageDownloader.buildFilename("instagram", "");
  assert.match(empty, /^instagram_\d{8}_\d{6}\.jpg$/);

  const undef = G.ImageDownloader.buildFilename("instagram", undefined);
  assert.match(undef, /^instagram_\d{8}_\d{6}\.jpg$/);
});

test("ImageDownloader.buildFilename: 不正 host は image にフォールバック", () => {
  const filename = G.ImageDownloader.buildFilename("evil_site", "image/jpeg");
  assert.match(filename, /^image_\d{8}_\d{6}\.jpg$/);

  const noHost = G.ImageDownloader.buildFilename(null, "image/jpeg");
  assert.match(noHost, /^image_\d{8}_\d{6}\.jpg$/);
});

test("ImageDownloader: 必要な定数キーが揃っている", () => {
  assert.ok(G.ImageDownloader.HOSTS);
  assert.equal(G.ImageDownloader.HOSTS.INSTAGRAM, "instagram");
  assert.equal(G.ImageDownloader.HOSTS.TIKTOK, "tiktok");
  assert.equal(typeof G.ImageDownloader.MIN_SIZE_PX, "number");
  assert.ok(G.ImageDownloader.MIN_SIZE_PX > 0);
  assert.equal(typeof G.ImageDownloader.BUTTON_CLASS, "string");
  assert.equal(typeof G.ImageDownloader.HOST_CLASS, "string");
  assert.equal(typeof G.ImageDownloader.HOST_POSITIONED_CLASS, "string");
  assert.equal(typeof G.ImageDownloader.BUSY_CLASS, "string");
  assert.equal(typeof G.ImageDownloader.SCANNED_SRC_DATASET_KEY, "string");
  assert.equal(typeof G.ImageDownloader.SCANNED_SRC_ATTR_SELECTOR, "string");
  assert.equal(typeof G.ImageDownloader.SKIP_MARKER, "string");
  // dataset key と attribute selector の整合性: cpaImgDlSrc → data-cpa-img-dl-src
  assert.match(
    G.ImageDownloader.SCANNED_SRC_ATTR_SELECTOR,
    /^img\[data-cpa-img-dl-src\]$/,
    "SCANNED_SRC_ATTR_SELECTOR と SCANNED_SRC_DATASET_KEY の lower-kebab 変換が一致すること"
  );
  assert.ok(G.ImageDownloader.ALLOWED_HOSTS);
  assert.ok(Array.isArray(G.ImageDownloader.ALLOWED_HOSTS.instagram));
  assert.ok(Array.isArray(G.ImageDownloader.ALLOWED_HOSTS.tiktok));
});

// ---------- ImageDownloader.isAllowedFetchUrl ----------

test("ImageDownloader.isAllowedFetchUrl: Instagram CDN ホストのみ許可（regex マッチ）", () => {
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://scontent-nrt1-1.cdninstagram.com/v/foo.jpg"), true);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://scontent.cdninstagram.com/v/foo.jpg"), true);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://scontent-nrt1-1.fna.fbcdn.net/v/foo.jpg"), true);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://scontent.xx1-2.fna.fbcdn.net/v/foo.jpg"), true);
  // 非許可
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://i.ytimg.com/foo.jpg"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://attacker.com/log"), false);
});

test("ImageDownloader.isAllowedFetchUrl: 多段サブドメインは fbcdn.net でも拒否（SSRF 緩和）", () => {
  // ドット文字クラス除去後は 1 段サブドメインのみ許可。多段は拒否されるべき
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://evil.attacker.fbcdn.net/x.jpg"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://a.b.c.fbcdn.net/x.jpg"), false);
  // scontent- 系の正規 fna 2 段は明示許可（合法）
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://scontent-iad3-2.fna.fbcdn.net/x.jpg"), true);
  // scontent. 系も明示許可
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://scontent.iad3-2.fna.fbcdn.net/x.jpg"), true);
  // しかし scontent 以外の 2 段 fna は拒否
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://evil.fna.fbcdn.net/x.jpg"), false);
});

test("ImageDownloader.isAllowedFetchUrl: TikTok CDN ホストのみ許可（regex マッチ）", () => {
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("tiktok", "https://p16-sign-sg.tiktokcdn.com/foo.jpg"), true);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("tiktok", "https://p19-pu-sign-useast.tiktokcdn-us.com/foo.jpg"), true);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("tiktok", "https://p77.tiktokcdn.com/foo.jpg"), true);
  // 非許可
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("tiktok", "https://attacker-tiktokcdn.com/foo.jpg"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("tiktok", "https://i.ytimg.com/foo.jpg"), false);
  // /rere レビュー A2-SC-1 防御: 旧パターン `[a-z0-9-]+\.tiktokcdn\.com$` で通過していた
  // 任意サブドメインを `p<数字>` プレフィックス必須化で拒否することを保証する。
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("tiktok", "https://evil.tiktokcdn.com/foo.jpg"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("tiktok", "https://tracking.tiktokcdn-us.com/foo.jpg"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("tiktok", "https://static.tiktokcdn.com/foo.jpg"), false);
});

test("ImageDownloader.isAllowedFetchUrl: 不正 host / 不正 URL は false", () => {
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("evil_site", "https://scontent.cdninstagram.com/foo.jpg"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl(null, "https://scontent.cdninstagram.com/foo.jpg"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", null), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", ""), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "not a url"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", undefined), false);
  // youtube context は廃止された（YouTube 画像 DL 機能削除）
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("youtube", "https://i.ytimg.com/vi/abc/maxresdefault.jpg"), false);
});

test("各クリーナー FEATURES に imageDownload エントリが含まれる（Instagram / TikTok）", () => {
  // YouTube からは imageDownload を削除済み
  const yt = G.SearchFixer.FEATURES.find((f) => f.key === "imageDownload");
  assert.equal(yt, undefined, "SearchFixer.FEATURES から imageDownload は削除されている");
  const ig = G.InstagramCleaner.FEATURES.find((f) => f.key === "imageDownload");
  assert.ok(ig, "InstagramCleaner.FEATURES に imageDownload が存在");
  const tt = G.TikTokCleaner.FEATURES.find((f) => f.key === "imageDownload");
  assert.ok(tt, "TikTokCleaner.FEATURES に imageDownload が存在");
});

test("各クリーナーの DEFAULT_FEATURES に imageDownload: false が含まれる", () => {
  // YouTube は廃止
  assert.equal(G.SearchFixer.DEFAULT_FEATURES.imageDownload, undefined);
  assert.equal(G.InstagramCleaner.DEFAULT_FEATURES.imageDownload, false);
  assert.equal(G.TikTokCleaner.DEFAULT_FEATURES.imageDownload, false);
});

test("各クリーナー mergeFeatures: imageDownload:true 単体指定で他キー欠損を default false 補完", () => {
  // InstagramCleaner
  const ig = G.InstagramCleaner.mergeFeatures({ imageDownload: true });
  assert.equal(ig.imageDownload, true);
  assert.equal(ig.reels, false);
  // TikTokCleaner
  const tt = G.TikTokCleaner.mergeFeatures({ imageDownload: true });
  assert.equal(tt.imageDownload, true);
  assert.equal(tt.hideComments, false);
});

// 各クリーナー FEATURES 件数を固定値でアサートして、ドキュメント数値との
// drift を再発防止する。件数を増減した場合はこことドキュメントを同時更新する。
test("FEATURES 件数の固定アサート（ドキュメント整合性の再発防止）", () => {
  assert.equal(G.SearchFixer.FEATURES.length, 30, "SearchFixer.FEATURES は 30 件");
  assert.equal(G.InstagramCleaner.FEATURES.length, 11, "InstagramCleaner.FEATURES は 11 件");
  assert.equal(G.TikTokCleaner.FEATURES.length, 3, "TikTokCleaner.FEATURES は 3 件");
});

// /rere レビュー B3-006 修正: RTX_ENHANCER_ENABLED storage key と APPLY_RTX_ENHANCER_CS
// アクションの drift 検知。actions.js への追加漏れ + popup / background / content script の
// 配線漏れ（A2-001 で発覚した normalizeSettings 漏れと同型）を CI で検知できる単一情報源。
// /rere レビュー B1-002 修正: SettingsSchema が StorageKeys / Actions と整合していることを検証。
// 新機能追加時に SettingsSchema への追加忘れ / storageKey 不一致 / applyAction 不一致を CI 検知する。
// A2-001 (RTX 機能完全破壊バグ) と同型の drift を再発防止するための単一情報源。
test("SettingsSchema: 全 storageKey が StorageKeys に / 全 applyAction が Actions に存在 (B1-002)", () => {
  const validStorageValues = new Set(Object.values(G.StorageKeys));
  const validActionValues = new Set(Object.values(G.Actions));
  for (const entry of G.SettingsSchema) {
    assert.ok(
      validStorageValues.has(entry.storageKey),
      `SettingsSchema field "${entry.field}": storageKey "${entry.storageKey}" が StorageKeys に存在しない`
    );
    assert.ok(
      validActionValues.has(entry.applyAction),
      `SettingsSchema field "${entry.field}": applyAction "${entry.applyAction}" が Actions に存在しない`
    );
  }
  // 件数 drift 検知: 主要機能の field が SettingsSchema に揃っていることを確認
  const fields = new Set(G.SettingsSchema.map((e) => e.field));
  for (const required of [
    "keepAliveEnabled",
    "searchFixerEnabled",
    "amazonDeliveryTotalEnabled",
    "amazonRankingJumpEnabled",
    "instagramCleanerEnabled",
    "tiktokCleanerEnabled",
    "videoGammaEnabled",
    "videoFillEnabled",
    "loupeEnabled",
    "rtxEnhancerEnabled",
  ]) {
    assert.ok(fields.has(required), `SettingsSchema に "${required}" field が存在する必要がある`);
  }
});

// /rere レビュー A2-002 修正: cdninstagram.com の 1 段サブドメインを `scontent-` prefix 限定に
// 絞り込んだことを検証する。`tracking.cdninstagram.com` / `auth.cdninstagram.com` 等の
// 任意サブドメインへの代理 fetch が遮断されることを保証する（fbcdn / tiktok と対称防御）。
test("ImageDownloader.isAllowedFetchUrl: cdninstagram.com は scontent- prefix 限定 (A2-002)", () => {
  // 許可される（Instagram コンテンツ画像の正規 CDN）
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://scontent-iad3-1.cdninstagram.com/foo.jpg"), true);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://scontent-foo-bar.cdninstagram.com/foo.jpg"), true);
  // 拒否される（過剰許可だった経路）
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://tracker.cdninstagram.com/log"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://auth.cdninstagram.com/oauth"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://attacker.cdninstagram.com/exfil"), false);
});

test("StorageKeys.RTX_ENHANCER_ENABLED + Actions.APPLY_RTX_ENHANCER_CS が定義されている", () => {
  // storage key のキー名は popup / background / content script 全てから参照されるため
  // 文字列値も固定する（drift = 機能死活）。
  assert.equal(typeof G.StorageKeys.RTX_ENHANCER_ENABLED, "string");
  assert.equal(G.StorageKeys.RTX_ENHANCER_ENABLED, "rtxEnhancerEnabled");
  // background → content script の配信 message も固定。
  assert.equal(typeof G.Actions.APPLY_RTX_ENHANCER_CS, "string");
  assert.ok(
    G.Actions.APPLY_RTX_ENHANCER_CS.length > 0,
    "Actions.APPLY_RTX_ENHANCER_CS は空文字列であってはならない"
  );
});

// Amazon ランキング移動ボタンの storage key / action の drift 検知（機能死活の単一情報源）。
test("StorageKeys.AMAZON_RANKING_JUMP_ENABLED + Actions.APPLY_AMAZON_RANKING_JUMP_CS が定義されている", () => {
  assert.equal(typeof G.StorageKeys.AMAZON_RANKING_JUMP_ENABLED, "string");
  assert.equal(G.StorageKeys.AMAZON_RANKING_JUMP_ENABLED, "amazonRankingJumpEnabled");
  assert.equal(typeof G.Actions.APPLY_AMAZON_RANKING_JUMP_CS, "string");
  assert.ok(
    G.Actions.APPLY_AMAZON_RANKING_JUMP_CS.length > 0,
    "Actions.APPLY_AMAZON_RANKING_JUMP_CS は空文字列であってはならない"
  );
});

// AmazonRankingJump.isSubcategoryHref: ノード id を持つサブカテゴリリンクだけを true 判定する。
test("AmazonRankingJump.isSubcategoryHref: サブカテゴリ（ノード id あり）のみ true", () => {
  // 細かいサブカテゴリ（カテゴリ slug の後ろに数値ノード id）
  assert.equal(
    G.AmazonRankingJump.isSubcategoryHref("https://www.amazon.co.jp/gp/bestsellers/electronics/19349884051/ref=pd_zg_hrsr_electronics"),
    true
  );
  // 相対 href でも判定できる
  assert.equal(
    G.AmazonRankingJump.isSubcategoryHref("/gp/bestsellers/electronics/19349884051/"),
    true
  );
  // 広いカテゴリの「○○の売れ筋ランキングを見る」リンク（ノード id なし）は false
  assert.equal(
    G.AmazonRankingJump.isSubcategoryHref("https://www.amazon.co.jp/gp/bestsellers/electronics/ref=pd_zg_ts_electronics"),
    false
  );
  // ベストセラートップ（カテゴリ slug のみ）も false
  assert.equal(G.AmazonRankingJump.isSubcategoryHref("/gp/bestsellers/electronics"), false);
  // 無効入力
  assert.equal(G.AmazonRankingJump.isSubcategoryHref(""), false);
  assert.equal(G.AmazonRankingJump.isSubcategoryHref(null), false);
});

// AmazonRankingJump.selectTargetHref: サブカテゴリ優先で DOM 上の最後（一番細かい）を選ぶ。
test("AmazonRankingJump.selectTargetHref: 細かいサブカテゴリ優先で最後を選ぶ", () => {
  const broad = "/gp/bestsellers/electronics/ref=pd_zg_ts_electronics";
  const sub1 = "/gp/bestsellers/electronics/19349884051/ref=pd_zg_hrsr";
  const sub2 = "/gp/bestsellers/electronics/2151981051/ref=pd_zg_hrsr";
  // 広い + サブ 2 件 → サブの最後（より細かい）を選ぶ
  assert.equal(G.AmazonRankingJump.selectTargetHref([broad, sub1, sub2]), sub2);
  // サブが無ければ最後のリンク（広いカテゴリ）にフォールバック
  assert.equal(G.AmazonRankingJump.selectTargetHref([broad]), broad);
  // 空 / 非配列は null
  assert.equal(G.AmazonRankingJump.selectTargetHref([]), null);
  assert.equal(G.AmazonRankingJump.selectTargetHref(null), null);
});

// AmazonReleaseDate.parseReleaseDateText: 各種日付フォーマットと bidi 制御文字混入に耐える。
test("AmazonReleaseDate.parseReleaseDateText: 日付フォーマット境界値", () => {
  const P = G.AmazonReleaseDate.parseReleaseDateText;

  // 標準形式 "YYYY/M/D" / "YYYY/MM/DD"
  const d1 = P("2023/1/15");
  assert.equal(d1.getFullYear(), 2023);
  assert.equal(d1.getMonth(), 0);
  assert.equal(d1.getDate(), 15);
  const d2 = P("2024/12/31");
  assert.equal(d2.getMonth(), 11);
  assert.equal(d2.getDate(), 31);

  // 日本語形式 "YYYY年M月D日"
  const d3 = P("2020年3月5日");
  assert.equal(d3.getFullYear(), 2020);
  assert.equal(d3.getMonth(), 2);
  assert.equal(d3.getDate(), 5);

  // bidi 制御文字 (U+200E / U+200F) を含むテキストも受理
  const d4 = P("取り扱い開始日 ‏ : ‎ 2023/5/10");
  assert.equal(d4.getFullYear(), 2023);
  assert.equal(d4.getMonth(), 4);
  assert.equal(d4.getDate(), 10);

  // ハイフン区切り "YYYY-M-D"
  const d5 = P("2021-7-4");
  assert.equal(d5.getFullYear(), 2021);

  // 無効日付 (2024/2/30) は null
  assert.equal(P("2024/2/30"), null);
  // 範囲外 (年 / 月 / 日)
  assert.equal(P("1800/1/1"), null);
  assert.equal(P("2023/13/1"), null);
  assert.equal(P("2023/1/32"), null);
  // 不正型
  assert.equal(P(null), null);
  assert.equal(P(undefined), null);
  assert.equal(P(""), null);
  assert.equal(P(12345), null);
  // 日付を含まないテキスト
  assert.equal(P("発売前"), null);
});

// AmazonReleaseDate.formatReleaseDate: シンプルな YYYY/M/D 出力。
test("AmazonReleaseDate.formatReleaseDate: ゼロ詰めなしの YYYY/M/D", () => {
  const F = G.AmazonReleaseDate.formatReleaseDate;
  assert.equal(F(new Date(2023, 0, 15)), "2023/1/15");
  assert.equal(F(new Date(2024, 11, 31)), "2024/12/31");
  // 不正引数は空文字
  assert.equal(F(null), "");
  assert.equal(F(new Date(NaN)), "");
  assert.equal(F("2023/1/15"), "");
});

// AmazonReleaseDate.diffRelative: 各 kind の閾値を境界値でテストする。
test("AmazonReleaseDate.diffRelative: 5 kind の境界判定", () => {
  const D = G.AmazonReleaseDate.diffRelative;
  // future
  const fut = D(new Date(2030, 0, 1), new Date(2025, 0, 1));
  assert.equal(fut.kind, "future");
  // today
  const same = new Date(2025, 5, 15);
  assert.equal(D(same, same).kind, "today");
  // days (1 日後)
  const days = D(new Date(2025, 5, 10), new Date(2025, 5, 15));
  assert.equal(days.kind, "days");
  assert.equal(days.days, 5);
  // months (1 ヶ月以上 1 年未満)
  const months = D(new Date(2024, 9, 15), new Date(2025, 5, 15));
  assert.equal(months.kind, "months");
  assert.equal(months.months, 8);
  // years (ちょうど N 年、月 0)
  const years = D(new Date(2022, 5, 15), new Date(2025, 5, 15));
  assert.equal(years.kind, "years");
  assert.equal(years.years, 3);
  // yearsMonths (N 年 M ヶ月)
  const ym = D(new Date(2022, 1, 15), new Date(2025, 5, 20));
  assert.equal(ym.kind, "yearsMonths");
  assert.equal(ym.years, 3);
  assert.equal(ym.months, 4);
  // 不正型は null
  assert.equal(D(null, new Date()), null);
  assert.equal(D(new Date(), null), null);
  assert.equal(D(new Date(NaN), new Date()), null);
});

// ALLOWED_HOSTS の fbcdn.net パターンが scontent- prefix 限定であることを検証する。
// `tracking.fbcdn.net` / `video.fbcdn.net` 等の Meta 傘下非画像 CDN への代理
// fetch が遮断されることを保証する（/rere レビュー A1+A2 指摘修正）。
test("ImageDownloader.isAllowedFetchUrl: fbcdn.net は scontent- prefix 限定", () => {
  // 許可される（Instagram 投稿画像の正規 CDN）
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://scontent-iad3-1.fbcdn.net/x.jpg"), true);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://scontent-foo-bar.fbcdn.net/x.jpg"), true);
  // 拒否される（過剰許可だった経路）
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://tracking.fbcdn.net/pixel.png"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://video.fbcdn.net/clip.mp4"), false);
  assert.equal(G.ImageDownloader.isAllowedFetchUrl("instagram", "https://analytics.fbcdn.net/x.png"), false);
});
