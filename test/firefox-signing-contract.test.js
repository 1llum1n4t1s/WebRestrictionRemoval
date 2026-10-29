"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.resolve(__dirname, "../scripts/sign-verified-firefox.mjs");
const packageDir = path.dirname(fs.realpathSync(require.resolve("web-ext")));

const runCheck = (simulatedChange) => {
  const env = { ...process.env };
  delete env.WEB_EXT_API_KEY;
  delete env.WEB_EXT_API_SECRET;
  const args = [];
  if (simulatedChange) {
    const target = path.join(packageDir, simulatedChange === "version" ? "package.json" : "lib/cmd/sign.js");
    // ディスクの依存物は変更せず、子プロセスが読む値だけを差し替えて CLI の失敗を検証する。
    const preload = `
      import fs from "node:fs/promises";
      const read = fs.readFile.bind(fs);
      fs.readFile = async (file, ...args) => {
        const contents = await read(file, ...args);
        if (file !== ${JSON.stringify(target)}) return contents;
        ${simulatedChange === "version"
    ? 'const pkg = JSON.parse(contents); return JSON.stringify({ ...pkg, version: `${pkg.version}-unverified` });'
    : 'return Buffer.concat([contents, Buffer.from("\\n")]);'}
      };
    `;
    args.push("--import", `data:text/javascript,${encodeURIComponent(preload)}`);
  }
  return spawnSync(process.execPath, [...args, script, "check"], { env, encoding: "utf8" });
};

test("Firefox 提出契約の check はインストール済み web-ext を送信せず検証する", () => {
  const result = runCheck();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /web-ext signing contract verified/);
});

test("Firefox 提出契約の check は未確認の web-ext バージョンで失敗する", () => {
  const result = runCheck("version");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported web-ext version: .*unverified/);
});

test("Firefox 提出契約の check は同じバージョンでも内部ファイルの変更で失敗する", () => {
  const result = runCheck("hash");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported web-ext injection contract: lib\/cmd\/sign\.js/);
});
