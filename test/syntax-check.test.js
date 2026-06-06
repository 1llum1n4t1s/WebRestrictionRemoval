"use strict";

/**
 * syntax-check.test.js — `src/` 配下全 JS ファイルの構文 check を自動列挙する。
 *
 * 過去は CLAUDE.md に `node --check src/lib/actions.js && node --check ...` の
 * 23 ファイル列挙コマンドをハードコードしていたが、content_scripts 追加・削除のたびに
 * 手動更新で drift する問題があった。本テストは `src/**\/*.js` を glob で動的列挙し、
 * Node.js `vm.compileFunction` で構文 check (実行はしない) を 1 ファイルずつ走らせる。
 *
 * 使い方: `pnpm test`（actions.test.js 等と一括実行）。
 *
 * `node --check <file>` の代替として `vm.compileFunction` を使う理由:
 *   - Node 標準 test runner と統合して 1 コマンドで回せる
 *   - 各ファイルに対する subtest として失敗ファイル名が即特定できる
 *   - 子プロセス起動オーバーヘッドが無い (23 ファイル × spawn = 数秒 → 数 ms)
 *
 * 構文 check のみで実行はしないので、`chrome` グローバルの未定義等は検知しない。
 * 実行時エラーの検知は actions.test.js + 手動の chrome://extensions リロードで担う。
 */

const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_ROOT = path.join(__dirname, "..", "src");

/**
 * `src/` 配下から `.js` ファイルを再帰列挙する (`fs.readdirSync` recursive)。
 * sort で順序固定 → 失敗報告の安定性確保。
 * arrow function で `no-implicit-globals` warning を回避する。
 */
const listSrcJsFiles = () => {
  const entries = fs.readdirSync(SRC_ROOT, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((ent) => ent.isFile() && ent.name.endsWith(".js"))
    .map((ent) => path.join(ent.parentPath || ent.path, ent.name))
    .sort();
};

test("src/**/*.js の全ファイルが構文エラーなくパースできる", async (t) => {
  const files = listSrcJsFiles();
  // 23 ファイル前後を期待。極端な減少 (例: glob 設定ミスで 0 件) を検知。
  if (files.length < 20) {
    throw new Error(
      `src/ 配下の JS ファイル数が想定より少ない: ${files.length} 件 (期待 20+)`
    );
  }

  for (const file of files) {
    const relative = path.relative(SRC_ROOT, file);
    await t.test(relative, () => {
      const code = fs.readFileSync(file, "utf8");
      // `vm.compileFunction` は構文 check だけ走り、実行はしない。
      // `chrome` 等のグローバル未定義はここでは検知しない設計。
      vm.compileFunction(code, [], { filename: file });
    });
  }
});
