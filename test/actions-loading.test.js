"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const core = "src/lib/actions-core.js";
const all = [core, "src/lib/actions-video.js", "src/lib/actions-loupe.js", "src/lib/actions-volume.js", "src/lib/actions.js"];
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const create = () => vm.createContext({ URL });
const load = (context, files) => {
  for (const file of files) vm.runInContext(read(file), context, { filename: file });
};
const exposed = (context) => Object.fromEntries(Object.entries(context).filter(([key]) => !key.startsWith("__") && key !== "URL"));
const definitions = (entry) => entry.js.filter(file => all.includes(file) || file === "src/lib/audio-pipeline.js");
const independentScripts = new Set([
  "src/content/early-framework.js",
  "src/content/youtube-early.js",
  "src/content/instagram-early.js",
  "src/content/tiktok-early.js",
  "src/content/x-early.js",
  "src/content/youtube-player-controls-main.js",
]);
const dependentEntries = (manifest) => manifest.content_scripts.filter(entry =>
  !entry.js.every(file => independentScripts.has(file)));
const volumeConsumer = "src/content/volume-booster-mes.js";
const validateEntry = (entry) => {
  const files = definitions(entry);
  const expectedFiles = entry.js.includes("src/content/video-gamma.js") ? [core, "src/lib/actions-video.js"]
    : entry.js.includes("src/content/loupe.js") ? [core, "src/lib/actions-loupe.js"]
      : entry.js.includes(volumeConsumer) ? [core, "src/lib/actions-volume.js", "src/lib/audio-pipeline.js"]
        : [core, "src/lib/actions.js"];
  assert.deepEqual(files, expectedFiles, "必要な定義群が依存順に存在する");
  assert.deepEqual(entry.js.slice(0, files.length), files, "定義群は consumer より先に配列先頭へ置く");
  if (entry.js.includes(volumeConsumer)) {
    assert.deepEqual(entry.matches, ["http://*/*", "https://*/*"]);
    assert.equal(entry.all_frames, true);
    assert.equal(entry.run_at, "document_idle");
    assert.deepEqual(entry.js, [...expectedFiles, volumeConsumer]);
  }
  const context = create();
  load(context, files);
  if (entry.matches.includes("http://*/*")) {
    const expectedNames = entry.js.includes("src/content/video-gamma.js") ? ["VideoGamma", "VideoFill"]
      : entry.js.includes("src/content/loupe.js") ? ["Loupe"] : ["VolumeBooster", "AudioPipeline"];
    assert.deepEqual(Object.keys(exposed(context)).sort(), ["Actions", "ExtensionPaths", "SenderCheck", "StorageKeys", ...expectedNames].sort());
    if (expectedNames.includes("VolumeBooster")) {
      assert.equal(context.VolumeBooster.SETTINGS_KEYS.includes(context.StorageKeys.VOLUME_BOOSTER_ENABLED), true);
    }
  } else {
    assert.ok(context.SettingsSchema.every(item => Object.values(context.StorageKeys).includes(item.storageKey)));
  }
};
const validateManifest = (manifest, firefox) => {
  const entries = dependentEntries(manifest);
  assert.equal(entries.filter(entry => entry.js.includes(volumeConsumer)).length, firefox ? 1 : 0);
  for (const entry of entries) validateEntry(entry);
};

test("popup・offscreen・両 background の読み込み順は依存を満たす", () => {
  const htmlFiles = (file) => [...read(file).matchAll(/<script src="\.\.\/lib\/(actions[^"/]*)"><\/script>/g)]
    .map(match => `src/lib/${match[1]}`);
  const firefox = JSON.parse(read("manifest.firefox.json")).background.scripts.filter(file => all.includes(file));
  const chrome = [...read("src/background/background.js").matchAll(/"\/(src\/lib\/actions[^"/]*)"/g)].map(match => match[1]);
  for (const files of [htmlFiles("src/popup/popup.html"), firefox, chrome]) {
    assert.deepEqual(files, all);
    load(create(), files);
  }
  const offscreen = htmlFiles("src/offscreen/offscreen.html");
  assert.deepEqual(offscreen, [core, "src/lib/actions-volume.js", "src/lib/actions.js"]);
  load(create(), offscreen);
});

test("全分割定義の再評価は公開オブジェクトの参照を維持し、別フレームとは共有しない", () => {
  const first = create();
  load(first, all);
  const before = exposed(first);
  load(first, all);
  const second = create();
  load(second, all);
  assert.equal(vm.runInContext("globalThis === this", first), true);
  for (const [name, value] of Object.entries(before)) {
    assert.strictEqual(first[name], value, name);
    assert.notStrictEqual(second[name], value, name);
  }
});

for (const manifest of ["manifest.json", "manifest.firefox.json"]) {
  const parsed = JSON.parse(read(manifest));
  const entries = dependentEntries(parsed);
  test(`${manifest}: 各注入エントリの依存閉包と全サイトの定義限定`, () => {
    validateManifest(parsed, manifest === "manifest.firefox.json");
  });

  test(`${manifest}: サイトと全サイトの両評価順で参照同一性を維持`, () => {
    const site = entries.filter(entry => !entry.matches.includes("http://*/*"));
    const universal = entries.filter(entry => entry.matches.includes("http://*/*"));
    for (const specific of site) for (const generic of universal) {
      for (const pair of [[specific, generic], [generic, specific]]) {
        const context = create();
        load(context, definitions(pair[0]));
        const before = exposed(context);
        load(context, definitions(pair[1]));
        load(context, definitions(pair[0]));
        for (const [name, value] of Object.entries(before)) assert.strictEqual(context[name], value, name);
      }
    }
  });
}

test("Firefox 音量の core 欠落と consumer 先行を正常 manifest と同じ検証で拒否する", () => {
  const missingCore = JSON.parse(read("manifest.firefox.json"));
  const missingEntry = missingCore.content_scripts.find(entry => entry.js.includes(volumeConsumer));
  missingEntry.js = missingEntry.js.filter(file => file !== core);
  assert.throws(() => validateManifest(missingCore, true), /必要な定義群/);

  const consumerFirst = JSON.parse(read("manifest.firefox.json"));
  const reorderedEntry = consumerFirst.content_scripts.find(entry => entry.js.includes(volumeConsumer));
  reorderedEntry.js = [volumeConsumer, ...reorderedEntry.js.filter(file => file !== volumeConsumer)];
  assert.throws(() => validateManifest(consumerFirst, true), /定義群は consumer より先/);
});
