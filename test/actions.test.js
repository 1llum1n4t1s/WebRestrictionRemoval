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
  const merged = G.SearchFixer.mergeFeatures({ removeShorts: true });
  assert.equal(merged.removeShorts, true);
  // 他のキーは default (false) が補完される
  for (const feature of G.SearchFixer.FEATURES) {
    if (feature.key !== "removeShorts") {
      assert.equal(typeof merged[feature.key], "boolean");
    }
  }
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

test("ColorPicker.isValidTab / normalizeTab", () => {
  assert.equal(G.ColorPicker.isValidTab("assist"), true);
  assert.equal(G.ColorPicker.isValidTab("picker"), true);
  assert.equal(G.ColorPicker.isValidTab("xyz"), false);
  assert.equal(G.ColorPicker.normalizeTab("picker"), "picker");
  assert.equal(G.ColorPicker.normalizeTab("invalid"), G.ColorPicker.TAB_ASSIST);
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

test("actions.js は globalThis に 12 個の定数を公開する", () => {
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
    "ColorPicker",
  ];
  for (const k of required) {
    assert.ok(G[k] && typeof G[k] === "object", `missing globalThis.${k}`);
  }
});
