"use strict";

/**
 * 分割定義を Node.js から評価して、定数を取得するヘルパー (#26)。
 *
 * actions-core.js / actions-video.js / actions-loupe.js / actions-volume.js / actions.js は IIFE wrap + globalThis 公開方式で書かれているため、Node 上で `vm` モジュールを
 * 使って評価し、`globalThis` から取り出す方式でテスト用にロードする。
 *
 * **注意 (#27)**: `vm.createContext` で sandbox を作って評価すると別 realm になり、
 * - sandbox 内では `URL` 等のグローバルが自動公開されず `new URL(...)` が ReferenceError で落ちる
 * - `Array.from` が返す配列の prototype が host の `Array.prototype` と別物になり、
 *   `assert.deepEqual` の prototype 一致チェックを silent に抜けられず空配列誤判定が起きる
 *
 * これらを避けるため、`vm.runInThisContext` で **host と同じ realm** で評価する。
 * 各定義ファイルの独立した再評価ガードがあるため、複数回 require されても再評価されない。
 */

const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

for (const file of ["src/lib/actions-core.js","src/lib/actions-video.js","src/lib/actions-loupe.js","src/lib/actions-volume.js","src/lib/actions.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
}

module.exports = globalThis;
