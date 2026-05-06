"use strict";

/**
 * actions.js を Node.js から評価して、定数を取得するヘルパー (#26)。
 *
 * actions.js は IIFE wrap + globalThis 公開方式で書かれているため、Node 上で `vm` モジュールを
 * 使ってサンドボックス評価し、`globalThis` から取り出す方式でテスト用にロードする。
 * Node.js の require では globalThis のプロパティとしてアサインされた値しか復元できないため、
 * `vm.createContext` で隔離コンテキストを作るのが正しい。
 */

const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const code = fs.readFileSync(
  path.join(__dirname, "..", "src", "lib", "actions.js"),
  "utf8"
);
const sandbox = { globalThis: {}, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

module.exports = sandbox.globalThis;
