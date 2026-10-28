"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const G = require("./_load-actions");

const code = fs.readFileSync(
  path.join(__dirname, "..", "src", "lib", "audio-pipeline.js"),
  "utf8",
);
vm.runInThisContext(code);

/** @typedef {{type: string, frequency: {value: number}, Q: {value: number}, connectedTo: MockFilterNode | null, connect: (target: MockFilterNode) => void}} MockFilterNode */

/** @returns {MockFilterNode} */
const createFilterNode = () => {
  return {
    type: "lowpass",
    frequency: { value: 350 },
    Q: { value: 1 },
    connectedTo: null,
    connect(target) {
      this.connectedTo = target;
    },
  };
};

test("createBassCutChain: 2次 highpass を2段直列化し、初期状態はバイパス", () => {
  const created = [createFilterNode(), createFilterNode()];
  let nextNodeIndex = 0;
  const ctx = {
    createBiquadFilter() {
      const node = created[nextNodeIndex];
      nextNodeIndex += 1;
      return node;
    },
  };

  const chain = globalThis.AudioPipeline.createBassCutChain(ctx);

  assert.equal(created.length, G.VolumeBooster.BASS_CUT_STAGES);
  assert.equal(chain.head, created[0]);
  assert.equal(chain.tail, created[1]);
  assert.equal(created[0].connectedTo, created[1]);
  for (const node of created) {
    assert.equal(node.type, "highpass");
    assert.equal(node.frequency.value, G.VolumeBooster.BASS_CUT_BYPASS.frequency);
    assert.equal(node.Q.value, G.VolumeBooster.BASS_CUT_BYPASS.Q);
  }
});

test("applyFilterPreset: bass cut の全段へ同じ preset を適用", () => {
  const nodes = [createFilterNode(), createFilterNode()];

  globalThis.AudioPipeline.applyFilterPreset(nodes, G.VolumeBooster.BASS_CUT_PRESET);

  for (const node of nodes) {
    assert.equal(node.frequency.value, 150);
    // highpass の Q は dB 指定（Butterworth = -3.0103dB）。値の正は actions.js の BASS_CUT_PRESET。
    assert.equal(node.Q.value, -3.0103);
  }
});

test("connectAudioGraph: 最上位DSPグラフを固定順序で接続", () => {
  const connections = [];
  const node = (name) => ({
    name,
    connect(target) {
      connections.push(`${name}->${target.name}`);
    },
  });
  const graph = {
    source: node("source"),
    eqChain: { head: node("eq-head"), tail: node("eq-tail") },
    nightModeNode: node("night-mode"),
    gainNode: node("gain"),
    bassCutChain: { head: node("bass-cut-head"), tail: node("bass-cut-tail") },
    antiClipNode: node("anti-clip"),
    ceilingNode: node("ceiling"),
    destination: node("destination"),
  };

  globalThis.AudioPipeline.connectAudioGraph(graph);

  assert.deepEqual(connections, [
    "source->eq-head",
    "eq-tail->night-mode",
    "night-mode->gain",
    "gain->bass-cut-head",
    "bass-cut-tail->anti-clip",
    "anti-clip->ceiling",
    "ceiling->destination",
  ]);
});

test("createOutputCeiling / applyOutputCeiling: OFF は素通し、同じ状態は再代入しない", () => {
  let curve = null;
  let writes = 0;
  const node = {
    oversample: "",
    get curve() {
      return curve;
    },
    set curve(value) {
      curve = value;
      writes += 1;
    },
  };
  const created = globalThis.AudioPipeline.createOutputCeiling({
    createWaveShaper: () => node,
  });

  assert.equal(created, node);
  assert.equal(created.oversample, "none");
  assert.equal(writes, 1);
  assert.equal(curve, null);

  globalThis.AudioPipeline.applyOutputCeiling(created, false);
  assert.equal(writes, 1);

  globalThis.AudioPipeline.applyOutputCeiling(created, true);
  assert.equal(writes, 2);
  assert.ok(curve instanceof Float32Array);
  assert.equal(curve.length, 2);
  assert.equal(curve[0], -1);
  assert.equal(curve[1], 1);
  const enabledCurve = curve;

  globalThis.AudioPipeline.applyOutputCeiling(created, true);
  assert.equal(writes, 2);
  assert.equal(curve, enabledCurve);

  globalThis.AudioPipeline.applyOutputCeiling(created, false);
  assert.equal(writes, 3);
  assert.equal(curve, null);

  globalThis.AudioPipeline.applyOutputCeiling(created, false);
  assert.equal(writes, 3);
});
