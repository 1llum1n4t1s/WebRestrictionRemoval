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
    assert.equal(node.Q.value, 0.7071);
  }
});

test("connectAudioGraph: 最上位DSPグラフを固定順序の6本で接続", () => {
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
    destination: node("destination"),
  };

  globalThis.AudioPipeline.connectAudioGraph(graph);

  assert.deepEqual(connections, [
    "source->eq-head",
    "eq-tail->night-mode",
    "night-mode->gain",
    "gain->bass-cut-head",
    "bass-cut-tail->anti-clip",
    "anti-clip->destination",
  ]);
});
