"use strict";
// ゲーム画面拡大の純粋な計算（SearchFixer.GAME_CROP）。DOM を使う描画は実ブラウザで確認する。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = vm.createContext({ URL });
for (const file of ["src/lib/actions-core.js", "src/lib/actions.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });
}
const Crop = context.SearchFixer.GAME_CROP;
// vm 内で作られたオブジェクトはプロトタイプが別物なので、比較は JSON 経由にする。
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 0.1, `${message ?? ""} ${a} ≈ ${b}`);

test("範囲は 0〜1 に収め、最小サイズ未満・不正値は採用しない", () => {
  assert.deepEqual(plain(Crop.normalizeRegion({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 })), { x: 0.1, y: 0.2, w: 0.5, h: 0.4, on: true });
  // はみ出しは動画の端で切る
  assert.deepEqual(plain(Crop.normalizeRegion({ x: 0.8, y: -0.5, w: 0.5, h: 0.5, on: false })), { x: 0.8, y: 0, w: 0.2, h: 0.5, on: false });
  assert.equal(Crop.normalizeRegion({ x: 0, y: 0, w: 0.05, h: 0.5 }), null, "小さすぎる");
  assert.equal(Crop.normalizeRegion({ x: 0.95, y: 0, w: 0.5, h: 0.5 }), null, "端で切ると小さすぎる");
  for (const bad of [null, undefined, "x", 1, [], { x: "0", y: 0, w: 1, h: 1 }, { x: NaN, y: 0, w: 1, h: 1 }]) {
    assert.equal(Crop.normalizeRegion(bad), null);
  }
});

test("ドラッグの 2 点から範囲を作る（向きは問わない）", () => {
  const forward = Crop.regionFromPoints({ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.7 });
  const backward = Crop.regionFromPoints({ x: 0.6, y: 0.7 }, { x: 0.1, y: 0.1 });
  assert.deepEqual(plain(forward), { x: 0.1, y: 0.1, w: 0.5, h: 0.6, on: true });
  assert.deepEqual(plain(backward), plain(forward));
  assert.equal(Crop.regionFromPoints({ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 }), null, "クリックだけは範囲にしない");
});

test("保存データは正規化し、不正な項目を捨て、上限を超えた古いものから捨てる", () => {
  const raw = { "@a": { x: 0, y: 0, w: 0.5, h: 0.5 }, "@bad": { x: 0 }, "": { x: 0, y: 0, w: 1, h: 1 } };
  assert.deepEqual(Object.keys(Crop.normalizeStore(raw)), ["@a"]);
  assert.deepEqual(plain(Crop.normalizeStore(null)), {});
  assert.deepEqual(plain(Crop.normalizeStore([1, 2])), {});
  const many = {};
  for (let i = 0; i < Crop.MAX_ENTRIES + 5; i++) many[`@c${i}`] = { x: 0, y: 0, w: 0.5, h: 0.5 };
  const kept = Object.keys(Crop.normalizeStore(many));
  assert.equal(kept.length, Crop.MAX_ENTRIES);
  assert.equal(kept[0], "@c5", "古いものから捨てる");
});

test("チャンネルの識別子は /@handle と /channel/UC… だけ（小文字化）", () => {
  assert.equal(Crop.channelKey("/@Patra"), "@patra");
  assert.equal(Crop.channelKey("https://www.youtube.com/@Patra/videos"), "@patra");
  assert.equal(Crop.channelKey("/channel/UCabcdefghijklmnopqrstuv"), "channel/ucabcdefghijklmnopqrstuv");
  assert.equal(Crop.channelKey("/watch?v=abc"), null);
  assert.equal(Crop.channelKey("/user/foo"), null);
  assert.equal(Crop.channelKey(null), null);
});

test("拡大は範囲の縦横比を保ち、範囲の中心がプレーヤーの中心に来る", () => {
  // 1920x1080 の映像が 1280x720 のプレーヤーにぴったり収まっている。範囲は左 5%・上 8%・幅 70%・高さ 70%。
  const content = { left: 0, top: 0, width: 1280, height: 720 };
  const player = { width: 1280, height: 720 };
  const region = { x: 0.05, y: 0.08, w: 0.7, h: 0.7 };
  const view = Crop.computeView(region, content, player);
  // 範囲は 896x504（16:9 とほぼ同じ縦横比ではない）。倍率は小さい方の軸に合わせる。
  close(view.scale, Math.min(1280 / 896, 720 / 504));
  // 範囲の中心が変換後にプレーヤーの中心へ来ることを、変換を適用して確かめる。
  const cx = (0.05 + 0.35) * 1280;
  const cy = (0.08 + 0.35) * 720;
  close(view.translateX + view.scale * cx, 640, "x");
  close(view.translateY + view.scale * cy, 360, "y");
  assert.match(view.clip, /^inset\(/);
});

test("映像がプレーヤー内で位置をずらして置かれていても、中心をプレーヤー中心へ合わせる", () => {
  // 縦長のプレーヤー（800x900）に 16:9 の映像（800x450）が上下中央（top=225）に置かれている。
  const box = { left: 0, top: 225, width: 800, height: 450 };
  const player = { width: 800, height: 900 };
  const region = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const view = Crop.computeView(region, box, player);
  close(view.scale, 2, "幅 400 の範囲を幅 800 へ");
  // 範囲の中心（プレーヤー座標）: x=400, y=225+225=450。変換後は (400, 450) のまま中心に来る。
  close(box.left + view.translateX + view.scale * (400 - box.left), 400);
  close(box.top + view.translateY + view.scale * (450 - box.top), 450);
});

test("レターボックスの映像では、clip を要素座標で出す（要素の外側の余白は含めない）", () => {
  // 要素は 1000x600、映像は 1000x562.5 で上下に黒帯（top 方向 18.75px）。
  const box = { left: 0, top: 0, width: 1000, height: 600 };
  const content = { left: 0, top: 18.75, width: 1000, height: 562.5 };
  const view = Crop.computeView({ x: 0, y: 0, w: 1, h: 1 }, content, { width: 1000, height: 600 }, box);
  // 映像全体の範囲なので、clip は映像部分（上 18.75px・下 18.75px）だけを残す。
  assert.equal(view.clip, "inset(18.75px 0px 18.75px 0px)");
});

test("寸法が不正な入力は null を返し、描画しない", () => {
  const ok = { left: 0, top: 0, width: 100, height: 100 };
  const region = { x: 0, y: 0, w: 0.5, h: 0.5 };
  assert.equal(Crop.computeView(region, { ...ok, width: 0 }, { width: 100, height: 100 }), null);
  assert.equal(Crop.computeView(region, ok, { width: 100, height: 0 }), null);
  assert.equal(Crop.computeView({ x: 0 }, ok, { width: 100, height: 100 }), null);
  assert.equal(Crop.computeView(region, undefined, { width: 100, height: 100 }), null);
});
