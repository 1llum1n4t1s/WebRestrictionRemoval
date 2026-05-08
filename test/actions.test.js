"use strict";

/**
 * actions.js の純粋関数群に対する境界値テスト (#26)。
 *
 * 実行: `node --test test/actions.test.js`
 *
 * 対象:
 *   - VolumeBooster: clampValue / percentToGain / gainToPercent / sliderPositionToPercent / percentToSliderPosition
 *   - KeepAlive: clampIntervalMs / normalizeOrigins / isOriginAllowed
 *   - SearchFixer: clampGridItems / mergeFeatures
 *   - InstagramCleaner: mergeFeatures
 *   - ColorPicker: isValidFormat / normalizeFormat / isValidTab / normalizeTab
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

test("KeepAlive origin helpers: http(s) origin のみ正規化して重複排除", () => {
  const origins = G.KeepAlive.normalizeOrigins([
    "https://example.com/path?q=1",
    "https://example.com/other",
    "http://example.com",
    "chrome://extensions",
    "not a url",
  ]);

  assert.deepEqual(origins, ["https://example.com", "http://example.com"]);
  assert.equal(G.KeepAlive.isOriginAllowed(origins, "https://example.com/foo"), true);
  assert.equal(G.KeepAlive.isOriginAllowed(origins, "https://other.example/foo"), false);
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

test("SearchFixer.FEATURES: 動画フィルタは playlist/mix/shortsBtn/live/watched + removeShortsShelf + removeTopicsSection", () => {
  const expectedVideoFilterKeys = [
    "playlist", "mix", "shortsBtn", "live", "watched",
    "removeShortsShelf", "removeTopicsSection",
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
    "centerTitle", "fullWidthDesc", "hideComments", "hideLiveChat", "redirectShortsUrl",
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

test("PopupTabs.isValid / normalize: 4 タブ識別子のみ受理、不正値は TUNE", () => {
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

test("actions.js は globalThis に 14 個の定数を公開する", () => {
  const required = [
    "Actions",
    "ExtensionPaths",
    "SenderCheck",
    "Offscreen",
    "StorageKeys",
    "KeepAlive",
    "YouTubeShorts",
    "SearchFixer",
    "AmazonDeliveryTotal",
    "InstagramCleaner",
    "VolumeBooster",
    "VideoGamma",
    "ColorPicker",
    "PopupTabs",
  ];
  for (const k of required) {
    assert.ok(G[k] && typeof G[k] === "object", `missing globalThis.${k}`);
  }
});
