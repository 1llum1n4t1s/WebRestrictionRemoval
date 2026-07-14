"use strict";

/**
 * actions.js の純粋関数群に対する境界値テスト (#26)。
 *
 * 実行: `node --test test/actions.test.js`
 *
 * 対象:
 *   - VolumeBooster: clampValue / percentToGain / gainToPercent / sliderPositionToPercent / percentToSliderPosition
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

test("VolumeBooster.isUnityRelease: 100%+全OFF のみ true、いずれか ON なら false (/rere D-002 単一情報源)", () => {
  const U = G.VolumeBooster.UNITY;
  // gain UNITY + 全サブトグル OFF + ミュート OFF + EQ OFF → release 可
  assert.equal(
    G.VolumeBooster.isUnityRelease({ gain: U, antiClip: false, nightMode: false, bassCut: false, muted: false, eqEnabled: false }),
    true
  );
  // gain が UNITY 以外 → 維持
  assert.equal(
    G.VolumeBooster.isUnityRelease({ gain: U + 50, antiClip: false, nightMode: false, bassCut: false, muted: false, eqEnabled: false }),
    false
  );
  // 各サブトグル / ミュート / EQ が 1 つでも ON → 維持
  assert.equal(G.VolumeBooster.isUnityRelease({ gain: U, antiClip: true, nightMode: false, bassCut: false, muted: false, eqEnabled: false }), false);
  assert.equal(G.VolumeBooster.isUnityRelease({ gain: U, antiClip: false, nightMode: true, bassCut: false, muted: false, eqEnabled: false }), false);
  assert.equal(G.VolumeBooster.isUnityRelease({ gain: U, antiClip: false, nightMode: false, bassCut: true, muted: false, eqEnabled: false }), false);
  assert.equal(G.VolumeBooster.isUnityRelease({ gain: U, antiClip: false, nightMode: false, bassCut: false, muted: true, eqEnabled: false }), false);
  assert.equal(G.VolumeBooster.isUnityRelease({ gain: U, antiClip: false, nightMode: false, bassCut: false, muted: false, eqEnabled: true }), false);
});

test("VolumeBooster.BASS_CUT_PRESET / BASS_CUT_BYPASS: 壁ドン対策モードの highpass フィルタ値固定 (drift 検知)", () => {
  assert.equal(G.VolumeBooster.BASS_CUT_PRESET.frequency, 150);
  assert.equal(G.VolumeBooster.BASS_CUT_PRESET.Q, 0.7071);
  // BYPASS は frequency:0 で highpass を実質無効化（ノード抜き差しなしのバイパス方式）。
  assert.equal(G.VolumeBooster.BASS_CUT_BYPASS.frequency, 0);
});

test("VolumeBooster.percentToGain: 0/100/MAX のアンカー値が正しい", () => {
  assert.equal(G.VolumeBooster.percentToGain(0), 0);
  assert.equal(G.VolumeBooster.percentToGain(50), 0.5);
  assert.equal(G.VolumeBooster.percentToGain(100), 1);
  assert.equal(G.VolumeBooster.percentToGain(G.VolumeBooster.MAX), G.VolumeBooster.MAX / 100);
});

// 表示% = 実倍率 の線形一致（対数マッピング撤去の回帰防止、ゆろさん指摘 2026-06-27）。
// 旧実装は 150% で約 1.196 倍・200% で約 1.43 倍と乖離していた。
test("VolumeBooster.percentToGain: 表示% = 実倍率 で線形（150%=1.5x 等）", () => {
  assert.equal(G.VolumeBooster.percentToGain(125), 1.25);
  assert.equal(G.VolumeBooster.percentToGain(150), 1.5);
  assert.equal(G.VolumeBooster.percentToGain(200), 2.0);
  assert.equal(G.VolumeBooster.percentToGain(300), 3.0);
  assert.equal(G.VolumeBooster.percentToGain(250), 2.5);
  // 逆関数も 実倍率 → 表示% で線形一致
  assert.equal(G.VolumeBooster.gainToPercent(1.5), 150);
  assert.equal(G.VolumeBooster.gainToPercent(2.0), 200);
  assert.equal(G.VolumeBooster.gainToPercent(3.0), 300);
});

test("VolumeBooster.percentToGain → gainToPercent round-trip (整数 0..MAX)", () => {
  // MAX 追従ループ。逆関数なので整数 percent は厳密復元される。
  for (let pct = 0; pct <= G.VolumeBooster.MAX; pct += 25) {
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
  // 100..MAX 区間を slider 100..200 (100 段) にマップするので、percent 1 段あたりの
  // slider 解像度に応じて round 誤差を許容する (MAX 連動)。
  const sliderStep =
    (G.VolumeBooster.MAX - G.VolumeBooster.UNITY) /
    (G.VolumeBooster.SLIDER_MAX - G.VolumeBooster.SLIDER_UNITY);
  const tol = Math.ceil(sliderStep / 2) + 1;
  for (let pct = 0; pct <= G.VolumeBooster.MAX; pct += 25) {
    const pos = G.VolumeBooster.percentToSliderPosition(pct);
    const back = G.VolumeBooster.sliderPositionToPercent(pos);
    assert.ok(Math.abs(back - pct) <= tol, `pct=${pct} round-trip got ${back} via pos=${pos}`);
  }
});

test("VolumeBooster.sliderPositionToPercent: SLIDER_UNITY で UNITY", () => {
  assert.equal(
    G.VolumeBooster.sliderPositionToPercent(G.VolumeBooster.SLIDER_UNITY),
    G.VolumeBooster.UNITY
  );
});

// ---------- StorageKeys: 音量ブースター系の鍵が揃っているか ----------

test("StorageKeys.VOLUME_BOOSTER_* が 6 キー揃っている（master + lastGain + 3 サブトグル + muted）", () => {
  // 6 キーいずれかを追加・削除する場合は次を必ず同時更新:
  //   - background.js の cachedVolumeSettings 監視リストと onInstalled 初期化
  //   - popup.js の storage.local.get / event handler
  //   - _locales/{en,ja}/messages.json (UI 露出する場合)
  //   - CLAUDE.md "6 storage key" の数値整合
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_ENABLED, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_LAST_GAIN, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED, "string");
  // 旧仕様の混入チェック (snake_case や大文字小文字違いの誤キー混入を防ぐ)
  assert.equal(G.StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED, "volumeBoosterMutedEnabled");
  assert.equal(G.StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED, "volumeBoosterBassCutEnabled");
});

test("撤去済み: 自動音量正規化サブ機能の痕跡が actions.js から完全消去されている", () => {
  // 自動音量正規化 (volumeBoosterNormalize) は「現実的でない」ため撤去 (2026-06-19)。
  // 復活防止 + drift 検知: storage key / DSP 定数が actions.js に残っていないことを物理確認する。
  // CLAUDE.md「撤去済み機能と教訓」§ 参照。
  assert.equal(G.StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED, undefined);
  assert.ok(
    !("VOLUME_BOOSTER_NORMALIZE_ENABLED" in G.StorageKeys),
    "VOLUME_BOOSTER_NORMALIZE_ENABLED は StorageKeys から撤去済みのはず"
  );
  // NORMALIZE_* DSP 定数群 (NORMALIZE_TARGET_RMS_DB 等) も VolumeBooster から撤去済み。
  const leftoverNormalizeKeys = Object.keys(G.VolumeBooster).filter((k) =>
    k.startsWith("NORMALIZE_")
  );
  assert.deepEqual(
    leftoverNormalizeKeys,
    [],
    `VolumeBooster に NORMALIZE_* 定数が残存: ${leftoverNormalizeKeys.join(", ")}`
  );
  // 音量サブトグルは自動歪み防止 / ナイトモード / 壁ドン対策モードの 3 つ (正規化は撤去)。
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED, "string");
  assert.equal(typeof G.StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED, "string");
});

// ---------- VolumeBooster: グラフィックイコライザ ----------

test("VolumeBooster.EQ_BANDS: 10 バンド + 中心周波数が固定値", () => {
  assert.deepEqual(G.VolumeBooster.EQ_BANDS, [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  assert.equal(G.VolumeBooster.EQ_BAND_COUNT, 10);
  assert.equal(G.VolumeBooster.EQ_BANDS.length, G.VolumeBooster.EQ_BAND_COUNT);
});

test("VolumeBooster.clampEqGain: -12..12 に clamp + 整数化、不正値は 0", () => {
  assert.equal(G.VolumeBooster.clampEqGain(6), 6);
  assert.equal(G.VolumeBooster.clampEqGain(12), 12);
  assert.equal(G.VolumeBooster.clampEqGain(-12), -12);
  assert.equal(G.VolumeBooster.clampEqGain(20), 12);
  assert.equal(G.VolumeBooster.clampEqGain(-20), -12);
  assert.equal(G.VolumeBooster.clampEqGain(3.7), 4);
  assert.equal(G.VolumeBooster.clampEqGain(NaN), 0);
  assert.equal(G.VolumeBooster.clampEqGain("x"), 0);
  assert.equal(G.VolumeBooster.clampEqGain(undefined), 0);
});

test("VolumeBooster.clampEqPreamp: -12..12 に clamp + 整数化、不正値は 0", () => {
  assert.equal(G.VolumeBooster.clampEqPreamp(0), 0);
  assert.equal(G.VolumeBooster.clampEqPreamp(15), 12);
  assert.equal(G.VolumeBooster.clampEqPreamp(-15), -12);
  assert.equal(G.VolumeBooster.clampEqPreamp(undefined), 0);
});

test("VolumeBooster.clampEqGains: 10 要素に正規化 (不足補完 / 超過切り捨て / 各要素 clamp)", () => {
  assert.deepEqual(G.VolumeBooster.clampEqGains([]), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(G.VolumeBooster.clampEqGains(null).length, 10);
  assert.equal(G.VolumeBooster.clampEqGains("nope").length, 10);
  // 超過は 10 で切り捨て
  assert.deepEqual(
    G.VolumeBooster.clampEqGains([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  // 不足は 0 補完 + 各要素 clamp
  assert.deepEqual(G.VolumeBooster.clampEqGains([99, -99]), [12, -12, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("VolumeBooster.EQ_PRESETS: 各プリセットが 10 バンド分 + 全値が範囲内", () => {
  assert.ok("flat" in G.VolumeBooster.EQ_PRESETS, "flat プリセットは必須");
  for (const [id, gains] of Object.entries(G.VolumeBooster.EQ_PRESETS)) {
    assert.equal(gains.length, 10, `preset ${id} は 10 要素であるべき`);
    for (const g of gains) {
      assert.ok(
        g >= G.VolumeBooster.EQ_GAIN_MIN && g <= G.VolumeBooster.EQ_GAIN_MAX,
        `preset ${id} の値 ${g} が EQ_GAIN_MIN..MAX 内であるべき`,
      );
    }
  }
});

test("VolumeBooster.EQ_PRESETS: コミュニティ 4 プリセット (eargasm / eargasmKai / perfect / perfectKai) が同梱済み", () => {
  // deep-research (wnhg9pt91) で値確定。drift 検知用に値を固定。
  // 値変更時は出典 (CLAUDE.md / PR #27) と整合させること。
  assert.deepEqual(G.VolumeBooster.EQ_PRESETS.eargasm, [3, 6, 9, 7, 6, 5, 7, 4, 11, 8]);
  assert.deepEqual(G.VolumeBooster.EQ_PRESETS.eargasmKai, [10, 10, 10, 6, 5, 4, 6, 3, 9, 10]);
  assert.deepEqual(G.VolumeBooster.EQ_PRESETS.perfect, [3, 6, 9, 7, 6, 5, 7, 9, 11, 8]);
  assert.deepEqual(G.VolumeBooster.EQ_PRESETS.perfectKai, [-3, 0, 3, 1, 0, -1, 1, 3, 5, 2]);
  // perfect と eargasm は 4kHz バンドのみが異なる派生関係 (perfect: +9, eargasm: +4)。
  const perfectKai = G.VolumeBooster.EQ_PRESETS.perfectKai;
  const perfect = G.VolumeBooster.EQ_PRESETS.perfect;
  for (let i = 0; i < 10; i += 1) {
    assert.equal(perfectKai[i], perfect[i] - 6, `perfectKai[${i}] は perfect[${i}] - 6 のはず (全帯域 -6dB 派生)`);
  }
});

test("VolumeBooster.normalizeEqPreset: 既知/custom はそのまま、未知は default(flat)", () => {
  assert.equal(G.VolumeBooster.normalizeEqPreset("bassBoost"), "bassBoost");
  assert.equal(G.VolumeBooster.normalizeEqPreset(G.VolumeBooster.EQ_PRESET_CUSTOM), "custom");
  assert.equal(G.VolumeBooster.normalizeEqPreset("bogus"), G.VolumeBooster.EQ_PRESET_DEFAULT);
  assert.equal(G.VolumeBooster.normalizeEqPreset(undefined), G.VolumeBooster.EQ_PRESET_DEFAULT);
});

test("VolumeBooster.eqPresetGains: 既知はコピー配列 (元を破壊しない)、custom/未知は null", () => {
  const g = G.VolumeBooster.eqPresetGains("flat");
  assert.deepEqual(g, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  g[0] = 99; // 返り値はコピーなので元の EQ_PRESETS は不変
  assert.equal(G.VolumeBooster.EQ_PRESETS.flat[0], 0);
  assert.equal(G.VolumeBooster.eqPresetGains("custom"), null);
  assert.equal(G.VolumeBooster.eqPresetGains("bogus"), null);
});

test("StorageKeys.VOLUME_BOOSTER_EQ_*: イコライザ 4 キーが揃っている", () => {
  assert.equal(G.StorageKeys.VOLUME_BOOSTER_EQ_ENABLED, "volumeBoosterEqEnabled");
  assert.equal(G.StorageKeys.VOLUME_BOOSTER_EQ_GAINS, "volumeBoosterEqGains");
  assert.equal(G.StorageKeys.VOLUME_BOOSTER_EQ_PREAMP, "volumeBoosterEqPreamp");
  assert.equal(G.StorageKeys.VOLUME_BOOSTER_EQ_PRESET, "volumeBoosterEqPreset");
});

test("VolumeBooster.EQ_PRESET_I18N_KEYS: 全プリセット + custom を網羅 (popup の表示文言 drift 検知)", () => {
  // EQ_PRESETS の全 id + EQ_PRESET_CUSTOM に対して i18n キーが定義されているはず。
  // popup.js の buildEqUi が VolumeBooster.EQ_PRESET_I18N_KEYS[id] を参照するので、
  // 新しい preset を EQ_PRESETS に追加したら必ず本マップも更新する (drift 検知)。
  const expectedIds = [...Object.keys(G.VolumeBooster.EQ_PRESETS), G.VolumeBooster.EQ_PRESET_CUSTOM];
  for (const id of expectedIds) {
    const key = G.VolumeBooster.EQ_PRESET_I18N_KEYS[id];
    assert.ok(
      typeof key === "string" && key.startsWith("volumeEqPreset"),
      `EQ_PRESET_I18N_KEYS[${id}] が volumeEqPreset* で始まる文字列であるべき (got ${key})`,
    );
  }
  // 余計なキーが混入していないこと
  assert.equal(
    Object.keys(G.VolumeBooster.EQ_PRESET_I18N_KEYS).length,
    expectedIds.length,
    "EQ_PRESET_I18N_KEYS のキー数は EQ_PRESETS + custom と一致するはず",
  );
});

// ---------- VolumeBooster: Firefox 専用 MES 経路 ----------
// EME_HOSTS / isEmeHost / classifyMesSource は volume-booster-mes.js (manifest.firefox.json
// のみから注入される Firefox 専用 content script) が使う。Chrome の tabCapture 経路は
// これらを一切参照しない (Chrome 側への影響ゼロの単一情報源はこの制約)。

test("VolumeBooster.isEmeHost: EME 多用サイトの hostname 判定 (Firefox MES 経路)", () => {
  // 代表的な EME ホスト (サブドメイン込み) は true
  assert.equal(G.VolumeBooster.isEmeHost("netflix.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("www.netflix.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("WWW.NETFLIX.COM"), true, "大文字も小文字化して判定");
  assert.equal(G.VolumeBooster.isEmeHost("www.amazon.co.jp"), true);
  assert.equal(G.VolumeBooster.isEmeHost("tv.apple.com"), true);
  assert.equal(G.VolumeBooster.isEmeHost("abema.tv"), true);
  // 非 EME サイト / suffix を偽装したドメインは false (`(^|\.)` アンカーで防御)
  assert.equal(G.VolumeBooster.isEmeHost("example.com"), false);
  assert.equal(G.VolumeBooster.isEmeHost("evilnetflix.com"), false);
  assert.equal(G.VolumeBooster.isEmeHost("netflix.com.evil.example"), false);
  assert.equal(G.VolumeBooster.isEmeHost("apple.com"), false, "tv.apple.com のみが対象");
  // 不正入力は false
  assert.equal(G.VolumeBooster.isEmeHost(""), false);
  assert.equal(G.VolumeBooster.isEmeHost(null), false);
  assert.equal(G.VolumeBooster.isEmeHost(undefined), false);
  assert.equal(G.VolumeBooster.isEmeHost(123), false);
});

test("VolumeBooster.classifyMesSource: blob/data/crossorigin 属性付きは safe、same-origin は probe", () => {
  const page = "https://example.com/watch";
  // MSE (blob:) とインライン (data:) は taint しない → 即 attach 可
  assert.equal(G.VolumeBooster.classifyMesSource("blob:https://example.com/uuid-1234", null, page), "safe");
  assert.equal(G.VolumeBooster.classifyMesSource("data:audio/mp3;base64,AAAA", null, page), "safe");
  // same-origin http(s) は URL 上安全に見えるが、currentSrc はリダイレクト前 URL のため
  // same-origin → cross-origin redirect 配信の taint を probe で確認してから attach する
  assert.equal(G.VolumeBooster.classifyMesSource("https://example.com/media/a.mp4", null, page), "probe");
  assert.equal(G.VolumeBooster.classifyMesSource("/media/a.mp4", null, page), "probe", "相対 URL は pageHref 基準で解決");
  // crossorigin 属性付きは redirect 先も含め CORS 検証済みリソースしか再生されない → probe 不要で safe
  assert.equal(G.VolumeBooster.classifyMesSource("https://example.com/media/a.mp4", "anonymous", page), "safe");
});

test("VolumeBooster.classifyMesSource: cross-origin は crossorigin 属性の有無で分岐", () => {
  const page = "https://example.com/watch";
  // CORS 未検証の cross-origin は attach すると無音化するため unsafe
  assert.equal(G.VolumeBooster.classifyMesSource("https://cdn.other.example/a.mp4", null, page), "unsafe");
  // crossorigin 属性付きは CORS 検証済みリソースしか再生されないため safe
  assert.equal(G.VolumeBooster.classifyMesSource("https://cdn.other.example/a.mp4", "anonymous", page), "safe");
  assert.equal(G.VolumeBooster.classifyMesSource("https://cdn.other.example/a.mp4", "use-credentials", page), "safe");
  // crossorigin の未知値は unsafe 側に倒す
  assert.equal(G.VolumeBooster.classifyMesSource("https://cdn.other.example/a.mp4", "", page), "unsafe");
  // scheme 差 (http vs https) も cross-origin
  assert.equal(G.VolumeBooster.classifyMesSource("http://example.com/a.mp4", null, page), "unsafe");
  // サブドメイン差も cross-origin
  assert.equal(G.VolumeBooster.classifyMesSource("https://media.example.com/a.mp4", null, page), "unsafe");
});

test("VolumeBooster.classifyMesSource: 空 src は pending、不正 URL / 未知 scheme は unsafe", () => {
  const page = "https://example.com/watch";
  // ソース未確定 → attach 保留 (loadedmetadata / loadstart で再評価)
  assert.equal(G.VolumeBooster.classifyMesSource("", null, page), "pending");
  assert.equal(G.VolumeBooster.classifyMesSource(null, null, page), "pending");
  assert.equal(G.VolumeBooster.classifyMesSource(undefined, null, page), "pending");
  // URL として解決不能 / 未知 scheme は安全側で unsafe
  assert.equal(G.VolumeBooster.classifyMesSource("https://[invalid", null, page), "unsafe");
  assert.equal(G.VolumeBooster.classifyMesSource("ftp://example.com/a.mp4", null, page), "unsafe");
  assert.equal(G.VolumeBooster.classifyMesSource("javascript:void(0)", null, page), "unsafe");
  // pageHref が不正なときは throw せず安全側で unsafe に倒れる
  // (URL コンストラクタは base を先にパースするため絶対 URL でも失敗する。
  //  実運用では pageHref = location.href で常に valid なので到達しない防御枝)
  assert.equal(G.VolumeBooster.classifyMesSource("https://cdn.other.example/a.mp4", null, "not a url"), "unsafe");
  assert.equal(G.VolumeBooster.classifyMesSource("https://cdn.other.example/a.mp4", "anonymous", "not a url"), "unsafe");
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

test("SearchFixer.extractChannelKeyFromHref: @handle 小文字化 / UC チャンネル ID / 非チャンネル URL", () => {
  // @handle は小文字化して正規化（YouTube ハンドルは case-insensitive）
  assert.equal(G.SearchFixer.extractChannelKeyFromHref("/@SomeChannel"), "@somechannel");
  assert.equal(G.SearchFixer.extractChannelKeyFromHref("/@ABC/videos"), "@abc");
  // Unicode ハンドル（URL encoded 経由）も extractHandleFromHref 経由で取れる
  assert.equal(
    G.SearchFixer.extractChannelKeyFromHref("/%40%E3%82%80%E3%82%81%E3%81%84"),
    "@むめい"
  );
  // /channel/UC... はチャンネル ID をそのまま返す（case-sensitive）
  assert.equal(
    G.SearchFixer.extractChannelKeyFromHref("/channel/UCAbCdEfGhIjKlMnOpQrStUv"),
    "UCAbCdEfGhIjKlMnOpQrStUv"
  );
  assert.equal(
    G.SearchFixer.extractChannelKeyFromHref("/channel/UCAbCdEfGhIjKlMnOpQrStUv/videos?x=1"),
    "UCAbCdEfGhIjKlMnOpQrStUv"
  );
  // 非チャンネル URL / 空値は null
  assert.equal(G.SearchFixer.extractChannelKeyFromHref("/watch?v=abc"), null);
  assert.equal(G.SearchFixer.extractChannelKeyFromHref("/channel/XX123"), null);
  assert.equal(G.SearchFixer.extractChannelKeyFromHref(null), null);
  assert.equal(G.SearchFixer.extractChannelKeyFromHref(""), null);
});

test("SearchFixer.normalizeBlockedChannels: 壊れた値 / dedupe / 上限 / name フォールバック", () => {
  // 配列以外は []
  assert.deepEqual(G.SearchFixer.normalizeBlockedChannels(null), []);
  assert.deepEqual(G.SearchFixer.normalizeBlockedChannels("x"), []);
  assert.deepEqual(G.SearchFixer.normalizeBlockedChannels({ key: "@a" }), []);
  // 正常エントリ + name 欠落は key で代用
  assert.deepEqual(
    G.SearchFixer.normalizeBlockedChannels([
      { key: "@Abc", name: "Abc Channel" },
      { key: "UCAbCdEfGhIjKl", name: "" },
    ]),
    [
      { key: "@abc", name: "Abc Channel" }, // @handle は小文字化
      { key: "UCAbCdEfGhIjKl", name: "UCAbCdEfGhIjKl" }, // UC ID は保持 + name 代用
    ]
  );
  // key 重複（大文字小文字違い含む）は先勝ち dedupe、壊れたエントリは捨てる
  assert.deepEqual(
    G.SearchFixer.normalizeBlockedChannels([
      { key: "@abc", name: "first" },
      { key: "@ABC", name: "second" },
      { key: "", name: "empty" },
      { key: 123, name: "not string" },
      null,
      "garbage",
    ]),
    [{ key: "@abc", name: "first" }]
  );
  // name は 100 文字で切り詰め / key 128 文字超は捨てる
  const longName = "n".repeat(200);
  const normalized = G.SearchFixer.normalizeBlockedChannels([
    { key: "@long", name: longName },
    { key: "@" + "k".repeat(200), name: "too long key" },
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].name.length, 100);
  // BLOCKED_CHANNELS_MAX 件で打ち切り
  const many = Array.from({ length: G.SearchFixer.BLOCKED_CHANNELS_MAX + 50 }, (_, i) => ({
    key: `@ch${i}`,
    name: `ch${i}`,
  }));
  assert.equal(
    G.SearchFixer.normalizeBlockedChannels(many).length,
    G.SearchFixer.BLOCKED_CHANNELS_MAX
  );
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

test("SearchFixer.FEATURES: 動画フィルタは playlist/mix/shortsBtn/live/membersOnly/watched + removeShortsShelf + removeFeedSections", () => {
  const expectedVideoFilterKeys = [
    "playlist", "mix", "shortsBtn", "live", "membersOnly", "watched",
    "removeShortsShelf", "removeFeedSections",
  ];
  for (const key of expectedVideoFilterKeys) {
    const feature = G.SearchFixer.FEATURES.find((f) => f.key === key);
    assert.ok(feature, `feature ${key} exists`);
    assert.equal(feature.category, "video_filter", `${key} is in video_filter`);
  }
});

test("SearchFixer.FEATURES: 旧 removeTopicsSection / removeBreakingNewsSection は removeFeedSections に統合済み (drift 検知)", () => {
  assert.equal(G.SearchFixer.FEATURES.find((f) => f.key === "removeTopicsSection"), undefined);
  assert.equal(G.SearchFixer.FEATURES.find((f) => f.key === "removeBreakingNewsSection"), undefined);
  assert.equal(Object.hasOwn(G.SearchFixer.DEFAULT_FEATURES, "removeTopicsSection"), false);
  assert.equal(Object.hasOwn(G.SearchFixer.DEFAULT_FEATURES, "removeBreakingNewsSection"), false);
});

test("SearchFixer.FEATURES: 検索結果ページ専用機能は search_only にまとめられている", () => {
  const expectedSearchOnlyKeys = [
    "shelf", "cardList", "course", "channel", "reel", "secondary", "chapter",
    "verified", "artist",
    "demoteUnmatched", "highlightThumb",
    "searchGrid",
    "removeShortsChip",
    "channelBlocklist",
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

test("actions.js は globalThis に 22 個の定数を公開する", () => {
  const required = [
    "SettingsSchema",
    "Actions",
    "ExtensionPaths",
    "SenderCheck",
    "Offscreen",
    "StorageKeys",
    "YouTubeShorts",
    "SearchFixer",
    "AmazonDeliveryTotal",
    "AmazonRankingJump",
    "AmazonMerchantInfo",
    "InstagramCleaner",
    "TikTokCleaner",
    "ImageDownloader",
    "VolumeBooster",
    "VideoGamma",
    "VideoFill",
    "Loupe",
    "ConnectionMonitor",
    "BroadcastClock",
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
  assert.equal(G.SearchFixer.FEATURES.length, 32, "SearchFixer.FEATURES は 32 件");
  assert.equal(G.InstagramCleaner.FEATURES.length, 11, "InstagramCleaner.FEATURES は 11 件");
  assert.equal(G.TikTokCleaner.FEATURES.length, 3, "TikTokCleaner.FEATURES は 3 件");
});

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
    "searchFixerEnabled",
    "amazonDeliveryTotalEnabled",
    "amazonRankingJumpEnabled",
    "amazonMerchantInfoEnabled",
    "instagramCleanerEnabled",
    "tiktokCleanerEnabled",
    "videoGammaEnabled",
    "videoFillEnabled",
    "loupeEnabled",
  ]) {
    assert.ok(fields.has(required), `SettingsSchema に "${required}" field が存在する必要がある`);
  }
  // セッション維持と RTX 動画強化は v1.0.x で完全撤去されたため、SettingsSchema からも除去済み。
  for (const removed of ["keepAliveEnabled", "keepAliveIntervalMs", "keepAliveHttpPingEnabled", "rtxEnhancerEnabled"]) {
    assert.ok(!fields.has(removed), `SettingsSchema から "${removed}" field は撤去されているはず`);
  }
});

// /rere B2-I003/D-003 修正: background.js の APPLY_SETTINGS_KEYS と toStorageRecord が
// SettingsSchema から generate されていることを CI 検知する。
// 旧実装は手書き列挙 (3 関数 = SettingsSchema/APPLY_SETTINGS_KEYS/toStorageRecord) で
// 同じキー集合を 4 箇所同期する必要があり、drift = 永久 OFF バグの温床だった。
// generated 化により background.js 側のリストは SettingsSchema の単一情報源から導出され、
// 新 master トグル追加時の「3 関数同期忘れ」事故が構造的に消える。
// 本テストでは background.js を fs.readFileSync で読み、APPLY_SETTINGS_KEYS / toStorageRecord
// 定義に直接 StorageKeys.<XXX> 列挙が残っていないことを assert (= SettingsSchema 駆動化を保証)。
test("background.js の APPLY_SETTINGS_KEYS / toStorageRecord は SettingsSchema 駆動 (B2-I003/D-003)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const bgPath = path.resolve(__dirname, "..", "src", "background", "background.js");
  const bgSrc = fs.readFileSync(bgPath, "utf8");

  // APPLY_SETTINGS_KEYS 定義行を抽出。SettingsSchema.map() で derive されていることを確認。
  const applyKeysMatch = bgSrc.match(/const APPLY_SETTINGS_KEYS\s*=\s*([^;]+);/);
  assert.ok(applyKeysMatch, "background.js に APPLY_SETTINGS_KEYS の定義が見つからない");
  assert.ok(
    /SettingsSchema/.test(applyKeysMatch[1]),
    "APPLY_SETTINGS_KEYS は SettingsSchema 駆動 (例: SettingsSchema.map(e => e.storageKey)) で定義されている必要がある (手書き列挙は drift 温床)"
  );

  // toStorageRecord 定義を抽出。SettingsSchema.map() ベースであることを確認。
  const toStorageMatch = bgSrc.match(/function toStorageRecord\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(toStorageMatch, "background.js に toStorageRecord 関数定義が見つからない");
  assert.ok(
    /SettingsSchema/.test(toStorageMatch[1]),
    "toStorageRecord は SettingsSchema 駆動 (例: SettingsSchema.map(({field, storageKey}) => ...)) で実装されている必要がある (手書き列挙は drift 温床)"
  );
});

// /rere F-OPS-2 修正: popup.js の `stored = await chrome.storage.local.get([...])` リストに
// SettingsSchema の全 storageKey が含まれることを CI 検知する。経路 D (popup stored リスト欠落)
// は v1.0.29 で RTX_ENHANCER_ENABLED の追加忘れにより永久 OFF 化バグを引き起こした実例があり、
// 6 ポイントチェックリストの人間運用に依存していた最後の防御層を機械化する。
// 検証方法: popup.js を fs.readFileSync で読み、`StorageKeys.<XXX>` パターンを正規表現抽出して
// SettingsSchema の storageKey と field 名から導出した期待集合と比較する。
test("popup.js の chrome.storage.local.get リストに SettingsSchema の全 storageKey が含まれる (F-OPS-2)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const popupPath = path.resolve(__dirname, "..", "src", "popup", "popup.js");
  const popupSrc = fs.readFileSync(popupPath, "utf8");

  // popup.js の DOMContentLoaded 内で行われる `chrome.storage.local.get([...])` の
  // 引数配列を抽出する。複数 get があり得るが、master トグルの初期化を担う最大の
  // get 呼び出し (キー数 > 10) を対象に判定する (popup 内で 30+ キーを一括 get する設計)。
  const getCalls = [...popupSrc.matchAll(/chrome\.storage\.local\.get\(\s*\[([\s\S]*?)\]/g)];
  assert.ok(getCalls.length > 0, "popup.js に chrome.storage.local.get([...]) 呼び出しが見つからない");
  const mainGetCall = getCalls
    .map((m) => m[1])
    .filter((body) => (body.match(/StorageKeys\./g) || []).length >= 10)
    .sort((a, b) => (b.match(/StorageKeys\./g) || []).length - (a.match(/StorageKeys\./g) || []).length)[0];
  assert.ok(mainGetCall, "popup.js のメイン storage.local.get (10+ キー) が見つからない");

  // mainGetCall 内で参照されている StorageKeys.<XXX> の集合を抽出
  const referencedKeys = new Set();
  for (const m of mainGetCall.matchAll(/StorageKeys\.([A-Z_][A-Z0-9_]*)/g)) {
    referencedKeys.add(m[1]);
  }

  // SettingsSchema の各 entry の storageKey 値 → StorageKeys のキー名に逆引きする
  const storageKeyValueToName = new Map();
  for (const [name, value] of Object.entries(G.StorageKeys)) {
    storageKeyValueToName.set(value, name);
  }

  // SettingsSchema の各 storageKey に対応する StorageKeys 名が popup の get リストに含まれるか
  const missing = [];
  for (const entry of G.SettingsSchema) {
    const keyName = storageKeyValueToName.get(entry.storageKey);
    if (!keyName) continue; // 既存テストで storageKey 整合は別途検証済み
    if (!referencedKeys.has(keyName)) {
      missing.push(`StorageKeys.${keyName} (SettingsSchema field: ${entry.field})`);
    }
  }
  assert.equal(
    missing.length,
    0,
    `popup.js の chrome.storage.local.get リストに以下の StorageKeys が含まれていない (経路 D drift / v1.0.29 RTX バグ再発防止):\n  - ${missing.join("\n  - ")}`
  );
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

// 接続モニターは YouTube クリーナーのサブ機能 (searchFixerFeatures.connectionMonitor) に統合済み。
// 独立 storage key / action は持たず、SearchFixer.FEATURES の watch_page カテゴリに存在することと、
// 旧独立キーが完全に撤去されていることを drift 検知する（再導入の事故を CI で防ぐ）。
test("接続モニターは SearchFixer.FEATURES の connectionMonitor サブ機能に統合されている", () => {
  const cm = G.SearchFixer.FEATURES.find((f) => f.key === "connectionMonitor");
  assert.ok(cm, "SearchFixer.FEATURES に connectionMonitor が存在する必要がある");
  assert.equal(cm.category, "watch_page", "connectionMonitor は watch_page カテゴリ");
  // mergeFeatures が未設定時に false を埋めることを確認（オプトイン保証）
  assert.equal(G.SearchFixer.mergeFeatures({}).connectionMonitor, false);
  assert.equal(G.SearchFixer.mergeFeatures({ connectionMonitor: true }).connectionMonitor, true);
  // 旧独立 master トグルの痕跡が actions.js から完全撤去されていること
  assert.equal(G.StorageKeys.CONNECTION_MONITOR_ENABLED, undefined, "旧 storage key は撤去済みのはず");
  assert.equal(G.Actions.APPLY_CONNECTION_MONITOR_CS, undefined, "旧 action は撤去済みのはず");
  // ConnectionMonitor namespace（純粋ロジック）は引き続き公開されている
  assert.equal(typeof G.ConnectionMonitor.classify, "function");
});

// 配信時刻オーバーレイ（broadcastClock）は YouTube クリーナーの watch_page サブ機能。
test("配信時刻オーバーレイは SearchFixer.FEATURES の broadcastClock サブ機能に統合されている", () => {
  const bc = G.SearchFixer.FEATURES.find((f) => f.key === "broadcastClock");
  assert.ok(bc, "SearchFixer.FEATURES に broadcastClock が存在する必要がある");
  assert.equal(bc.category, "watch_page", "broadcastClock は watch_page カテゴリ");
  assert.equal(G.SearchFixer.mergeFeatures({}).broadcastClock, false, "未設定はオプトイン OFF");
  assert.equal(G.SearchFixer.mergeFeatures({ broadcastClock: true }).broadcastClock, true);
});

test("BroadcastClock.extractVideoId: /watch?v= と /live/ の両形式 + 境界", () => {
  const E = G.BroadcastClock.extractVideoId;
  assert.equal(E("?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(E("?v=dQw4w9WgXcQ&t=10s"), "dQw4w9WgXcQ", "後続パラメータがあっても 11 文字を抽出");
  assert.equal(E("/watch?list=PLxx&v=dQw4w9WgXcQ"), "dQw4w9WgXcQ", "v が先頭でなくても抽出");
  assert.equal(E("/live/dQw4w9WgXcQ"), "dQw4w9WgXcQ", "/live/ 直アクセス");
  assert.equal(E("/live/dQw4w9WgXcQ?feature=share"), "dQw4w9WgXcQ");
  assert.equal(E("/results?search_query=foo"), null, "videoId なしは null");
  assert.equal(E("?v=short"), null, "11 文字未満は null");
  assert.equal(E(""), null);
  assert.equal(E(null), null);
  assert.equal(E(undefined), null);
});

test("BroadcastClock.parseLiveBroadcastDetails: アーカイブ / ライブ中 / 通常動画", () => {
  const P = G.BroadcastClock.parseLiveBroadcastDetails;

  // アーカイブ（配信終了済み）
  const archive = P(
    'x{"liveBroadcastDetails":{"isLiveNow":false,"startTimestamp":"2024-01-05T09:00:00+09:00","endTimestamp":"2024-01-05T11:00:00+09:00"}}y'
  );
  assert.ok(archive, "アーカイブは抽出できる");
  assert.equal(archive.isLiveNow, false);
  assert.equal(archive.startMs, Date.parse("2024-01-05T09:00:00+09:00"));
  assert.equal(archive.endMs, Date.parse("2024-01-05T11:00:00+09:00"));

  // 配信中ライブ（endTimestamp なし）
  const live = P('{"liveBroadcastDetails":{"isLiveNow":true,"startTimestamp":"2024-01-05T09:00:00Z"}}');
  assert.ok(live);
  assert.equal(live.isLiveNow, true);
  assert.equal(live.endMs, null, "endTimestamp 無しは null");

  // 通常動画（liveBroadcastDetails なし）→ null
  assert.equal(P('{"videoDetails":{"videoId":"abc"}}'), null);
  // startTimestamp なし → null
  assert.equal(P('{"liveBroadcastDetails":{"isLiveNow":false}}'), null);
  // 異常入力
  assert.equal(P(""), null);
  assert.equal(P(null), null);
  assert.equal(P(undefined), null);
});

test("BroadcastClock.computeBroadcastEpochMs: start + currentTime、負値/非有限の扱い", () => {
  const C = G.BroadcastClock.computeBroadcastEpochMs;
  assert.equal(C(1000, 5), 6000, "5 秒で +5000ms");
  assert.equal(C(1000, 0), 1000);
  assert.equal(C(1000, -3), 1000, "負値は 0 扱い");
  assert.equal(C(1000, NaN), 1000, "非有限は 0 扱い");
  assert.equal(C(NaN, 5), null, "startMs 非有限は null");
  assert.equal(C(undefined, 5), null);
});

test("BroadcastClock.formatTimestamp: yyyy/MM/dd　hh:mm:ss（全桁ゼロ埋め・全角スペース・24 時間制）", () => {
  const F = G.BroadcastClock.formatTimestamp;
  // ローカルタイムで Date を組んで TZ 非依存にする（formatTimestamp は getFullYear 等を使う）
  // ゼロ埋め検証: 1 桁の月/日/時/分/秒がすべて 2 桁ゼロ埋めされる
  assert.equal(F(new Date(2024, 0, 5, 9, 3, 7).getTime()), "2024/01/05　09:03:07");
  // 24 時間制検証: 午後 11 時台が 23 になる（12 時間制 / AM・PM ではない）
  assert.equal(F(new Date(2024, 11, 31, 23, 59, 59).getTime()), "2024/12/31　23:59:59");
  // 正午 / 真夜中
  assert.equal(F(new Date(2025, 5, 27, 0, 0, 0).getTime()), "2025/06/27　00:00:00");
  assert.equal(F(new Date(2025, 5, 27, 12, 0, 0).getTime()), "2025/06/27　12:00:00");
  // 区切りは全角スペース（U+3000）
  assert.ok(F(new Date(2024, 0, 1, 1, 1, 1).getTime()).includes("　"));
  // 非有限値 / Invalid は空文字
  assert.equal(F(NaN), "");
  assert.equal(F(Infinity), "");
  assert.equal(F("x"), "");
});

// ConnectionMonitor.median: 集計の中央値計算が正しく動くこと（baseline 計算で使う純粋関数）。
test("ConnectionMonitor.median: 奇数 / 偶数 / 不正値混入 / 空配列の境界値", () => {
  const M = G.ConnectionMonitor.median;
  // 奇数個 → 中央値そのもの
  assert.equal(M([1, 2, 3]), 2);
  assert.equal(M([5]), 5);
  // 偶数個 → 中央 2 値の平均
  assert.equal(M([1, 2, 3, 4]), 2.5);
  // 順不同でもソートして計算
  assert.equal(M([10, 2, 7, 1]), 4.5);
  // 不正値（NaN / Infinity / null / string）は除外して計算
  assert.equal(M([1, NaN, 2, Infinity, "x", 3]), 2);
  // 全部不正値 → null
  assert.equal(M([NaN, undefined, null]), null);
  // 空配列 → null
  assert.equal(M([]), null);
  // 非配列 → null
  assert.equal(M(null), null);
  assert.equal(M(undefined), null);
  assert.equal(M("not array"), null);
});

// ConnectionMonitor.classify: ヒューリスティクス分岐の境界値テスト。
// ライブ視聴中のクルクル要因を切り分けるロジックそのものなので、回帰防止が最重要。
test("ConnectionMonitor.classify: バッファ 0 回 → STABLE", () => {
  const C = G.ConnectionMonitor;
  assert.equal(C.classify({ bufferingCountRecent: 0 }), C.VERDICT.STABLE);
  // 他フィールドが充実していても 0 回なら STABLE
  assert.equal(
    C.classify({
      bufferingCountRecent: 0,
      downlinkBaseline: 25,
      downlinkDuringBuffering: 1,
      droppedFramesRatio: 0.9,
      googleRttMedian: 500,
      cloudflareRttMedian: 500,
    }),
    C.VERDICT.STABLE
  );
});

test("ConnectionMonitor.classify: buffering 中の downlink が 50% 以下 → NETWORK", () => {
  const C = G.ConnectionMonitor;
  // baseline 25Mbps の 50% (12.5) 以下なら NETWORK
  assert.equal(
    C.classify({
      bufferingCountRecent: 3,
      downlinkBaseline: 25,
      downlinkDuringBuffering: 8,
    }),
    C.VERDICT.NETWORK
  );
  // ぴったり 50% 境界も NETWORK 判定
  assert.equal(
    C.classify({
      bufferingCountRecent: 1,
      downlinkBaseline: 20,
      downlinkDuringBuffering: 10,
    }),
    C.VERDICT.NETWORK
  );
  // 50% より少し上 → 経路診断 fallback で YOUTUBE_CDN (両 RTT 不明時)
  assert.equal(
    C.classify({
      bufferingCountRecent: 1,
      downlinkBaseline: 20,
      downlinkDuringBuffering: 11,
    }),
    C.VERDICT.YOUTUBE_CDN
  );
});

test("ConnectionMonitor.classify: dropped frames 比率 30% 以上 → DEVICE", () => {
  const C = G.ConnectionMonitor;
  // baseline 帯域が落ちていない + dropped 比率高 → DEVICE
  assert.equal(
    C.classify({
      bufferingCountRecent: 2,
      downlinkBaseline: 25,
      downlinkDuringBuffering: 24,
      droppedFramesRatio: 0.4,
    }),
    C.VERDICT.DEVICE
  );
  // ぴったり 30% 境界も DEVICE
  assert.equal(
    C.classify({
      bufferingCountRecent: 1,
      downlinkBaseline: 25,
      downlinkDuringBuffering: 25,
      droppedFramesRatio: 0.3,
    }),
    C.VERDICT.DEVICE
  );
});

test("ConnectionMonitor.classify: 経路診断による細分化（YOUTUBE_CDN / ROUTING / INTERNATIONAL）", () => {
  const C = G.ConnectionMonitor;
  // Google と CF どちらも快適 (< 100ms) → YouTube CDN 個別不調
  assert.equal(
    C.classify({
      bufferingCountRecent: 2,
      googleRttMedian: 80,
      cloudflareRttMedian: 60,
    }),
    C.VERDICT.YOUTUBE_CDN
  );
  // Google だけ異常 (> 200ms) かつ CF 快適 → Google エッジ / ルーティング
  assert.equal(
    C.classify({
      bufferingCountRecent: 2,
      googleRttMedian: 350,
      cloudflareRttMedian: 50,
    }),
    C.VERDICT.ROUTING
  );
  // 両方異常 → 国際線 / 中継 ISP 経路遅延
  assert.equal(
    C.classify({
      bufferingCountRecent: 2,
      googleRttMedian: 350,
      cloudflareRttMedian: 280,
    }),
    C.VERDICT.INTERNATIONAL
  );
  // RTT 情報がない場合 → YOUTUBE_CDN (fallback)
  assert.equal(
    C.classify({ bufferingCountRecent: 2 }),
    C.VERDICT.YOUTUBE_CDN
  );
});

test("ConnectionMonitor.classify: 不正入力は UNKNOWN", () => {
  const C = G.ConnectionMonitor;
  assert.equal(C.classify(null), C.VERDICT.UNKNOWN);
  assert.equal(C.classify(undefined), C.VERDICT.UNKNOWN);
  assert.equal(C.classify("garbage"), C.VERDICT.UNKNOWN);
});

test("ConnectionMonitor.VERDICT: 7 種類の識別子が全て string + 固定値", () => {
  const V = G.ConnectionMonitor.VERDICT;
  // メッセージキー対応 + i18n 側で固定文字列依存しているので値も固定する
  assert.equal(V.STABLE, "stable");
  assert.equal(V.NETWORK, "network");
  assert.equal(V.DEVICE, "device");
  assert.equal(V.YOUTUBE_CDN, "youtube_cdn");
  assert.equal(V.ROUTING, "routing");
  assert.equal(V.INTERNATIONAL, "international");
  assert.equal(V.UNKNOWN, "unknown");
});

test("ConnectionMonitor: 経路診断 endpoint は generate_204 / speed.cloudflare.com の HTTPS 固定", () => {
  // セキュリティ + プライバシー上のクリティカル設定。
  // ローカル endpoint や任意ドメインへの fetch に書き換わったら CI で気付ける。
  // Cloudflare は 1.1.1.1 直 IP がブロックされる環境があるため speed.cloudflare.com の公式 speedtest endpoint を使用
  assert.equal(G.ConnectionMonitor.ENDPOINT_GOOGLE, "https://www.gstatic.com/generate_204");
  assert.equal(G.ConnectionMonitor.ENDPOINT_CLOUDFLARE, "https://speed.cloudflare.com/__down?bytes=10");
});

test("ConnectionMonitor: 動画 chunk 実 throughput 計測の閾値定数が定義されている", () => {
  // navigator.connection.downlink (bucket 化された粗い見積もり) ではなく PerformanceObserver で
  // googlevideo.com の transferSize / download 時間から実測 throughput を取る仕様。
  // 小さい chunk は warmup overhead 支配で無意味なため VIDEO_CHUNK_MIN_BYTES で除外する。
  assert.equal(typeof G.ConnectionMonitor.VIDEO_CHUNK_MIN_BYTES, "number");
  assert.ok(G.ConnectionMonitor.VIDEO_CHUNK_MIN_BYTES > 0, "VIDEO_CHUNK_MIN_BYTES は正の数");
  assert.equal(typeof G.ConnectionMonitor.VIDEO_THROUGHPUT_WINDOW_MS, "number");
  assert.ok(G.ConnectionMonitor.VIDEO_THROUGHPUT_WINDOW_MS > 0, "VIDEO_THROUGHPUT_WINDOW_MS は正の数");
});

// セッション維持と RTX 動画強化は v1.0.x で完全撤去された。actions.js から関連定数・KeepAlive 名前空間が
// 完全に消えていることを drift 検知し、再導入の事故を CI で防ぐ（撤去残骸の文字列が紛れ込んでも assert で落ちる）。
test("セッション維持 / RTX 動画強化は actions.js から完全撤去されている", () => {
  assert.equal(G.StorageKeys.KEEP_ALIVE_ENABLED, undefined, "旧 keepAlive storage key は撤去済み");
  assert.equal(G.StorageKeys.KEEP_ALIVE_INTERVAL_MS, undefined, "旧 keepAlive 間隔キーは撤去済み");
  assert.equal(G.StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED, undefined, "旧 keepAlive HTTP ping キーは撤去済み");
  assert.equal(G.StorageKeys.RTX_ENHANCER_ENABLED, undefined, "旧 RTX storage key は撤去済み");
  assert.equal(G.Actions.APPLY_KEEP_ALIVE_CS, undefined, "旧 APPLY_KEEP_ALIVE_CS action は撤去済み");
  assert.equal(G.Actions.APPLY_RTX_ENHANCER_CS, undefined, "旧 APPLY_RTX_ENHANCER_CS action は撤去済み");
  assert.equal(G.KeepAlive, undefined, "KeepAlive 名前空間自体が globalThis から撤去済み");
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

// AmazonMerchantInfo.parseIsInternal: Amazon が出す JSON フラグから boolean を抽出する純粋関数。
// 信頼できる Amazon 直販判定の最優先 source なので、境界値で防御する。
test("AmazonMerchantInfo.parseIsInternal: 各種 JSON 入力で boolean を返す", () => {
  const P = G.AmazonMerchantInfo.parseIsInternal;
  // 直販 (isInternal: true)
  assert.equal(P('{"isInternal":true,"merchantId":"ATVPDKIKX0DER"}'), true);
  // マーケット (isInternal: false)
  assert.equal(P('{"marketplaceId":"A1VC38T7YXB528","isInternal":false,"isRobot":false,"merchantId":"AJ1V7VPA9HQOB","asin":"B0DV9BRV2P"}'), false);
  // 順序が違っても OK
  assert.equal(P('{"a":1,"isInternal":true}'), true);
  // 前後に空白
  assert.equal(P('  {"isInternal":false}  '), false);
  // isInternal が boolean でない (非対応) → null
  assert.equal(P('{"isInternal":"true"}'), null);
  assert.equal(P('{"isInternal":1}'), null);
  assert.equal(P('{"isInternal":null}'), null);
  // isInternal フィールドなし → null
  assert.equal(P('{"merchantId":"ATVPDKIKX0DER"}'), null);
  // 不正 JSON → null
  assert.equal(P('not json'), null);
  assert.equal(P('{broken'), null);
  // 先頭が { でない (script なし) → null (try/catch 前で早期 return)
  assert.equal(P('var x = {"isInternal":true}'), null);
  // 不正型 → null
  assert.equal(P(null), null);
  assert.equal(P(undefined), null);
  assert.equal(P(""), null);
  assert.equal(P(123), null);
  assert.equal(P({}), null);
});

// AmazonMerchantInfo.isAmazonOwnedName: 販売元名から Amazon 直販を推定する fallback 判定。
// isInternal フラグが取れないとき (script 欠落 / DOM 変化) の保険として使われる。
test("AmazonMerchantInfo.isAmazonOwnedName: Amazon 名で部分一致判定", () => {
  const N = G.AmazonMerchantInfo.isAmazonOwnedName;
  // 直販判定 true
  assert.equal(N("Amazon.co.jp"), true);
  assert.equal(N("Amazon.com"), true);
  assert.equal(N("Amazon"), true);
  // 前後に空白あり
  assert.equal(N("  Amazon.co.jp  "), true);
  // マーケット出品名 (false 判定)
  assert.equal(N("HOGXIA（ホグシア）公式ストア"), false);
  assert.equal(N("Logicool G 公式ストア"), false);
  assert.equal(N("Anker Direct"), false);
  // 偽陽性は許容範囲: 「Amazon」を含むマーケット名は true 化する（実害は extension の色分けが緑寄りになる程度）
  assert.equal(N("Amazon Renewed Hub"), true);
  // 空文字 / 不正型 → false
  assert.equal(N(""), false);
  assert.equal(N("   "), false);
  assert.equal(N(null), false);
  assert.equal(N(undefined), false);
  assert.equal(N(123), false);
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
