"use strict";

/**
 * syntax-check.test.js — `src/` 配下全 JS ファイルの構文 check を自動列挙する。
 *
 * 過去は CLAUDE.md に `node --check src/lib/actions.js && node --check ...` の
 * 23 ファイル列挙コマンドをハードコードしていたが、content_scripts 追加・削除のたびに
 * 手動更新で drift する問題があった。本テストは `src/**\/*.js` を glob で動的列挙し、
 * classic script は `vm.Script`、HTML で module と宣言されたファイルは
 * `vm.SourceTextModule` で構文 check (実行はしない) する。
 *
 * 使い方: `bun --bun run test`（actions.test.js 等と一括実行）。
 *
 * classic script に `vm.Script` を使う理由:
 *   - Bun の node:test 互換実行 と統合して 1 コマンドで回せる
 *   - 各ファイルに対する subtest として失敗ファイル名が即特定できる
 *   - 子プロセス起動オーバーヘッドが無い (23 ファイル × spawn = 数秒 → 数 ms)
 *
 * 構文 check のみで実行はしないので、`chrome` グローバルの未定義等は検知しない。
 * 実行時エラーの検知は actions.test.js + 手動の chrome://extensions リロードで担う。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_ROOT = path.join(__dirname, "..", "src");

// ブラウザが読む HTML の宣言から種別を決め、ファイル名で module を固定しない。
const moduleFiles = new Set();
for (const entry of fs.readdirSync(SRC_ROOT, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
  const htmlPath = path.join(entry.parentPath || entry.path, entry.name);
  for (const [tag] of fs.readFileSync(htmlPath, "utf8").matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (src) moduleFiles.add(path.resolve(path.dirname(htmlPath), src));
  }
}

const checkSyntax = (code, filename, isModule = false) => {
  if (!isModule) return new vm.Script(code, { filename });
  // link/evaluate を呼ばず、未解決 import を許容したまま module 文法だけを検査する。
  return new vm.SourceTextModule(code, { identifier: filename });
};

test("構文検査は script のトップレベル制約と module 構文を非実行で検証する", () => {
  for (const code of ["return;", "new.target;"]) {
    assert.throws(() => checkSyntax(code, "classic.js"), SyntaxError);
  }
  checkSyntax('throw new Error("実行禁止");', "classic.js");
  checkSyntax('import "./missing.js"; export const value = await Promise.resolve(1); throw new Error("実行禁止");', "module.js", true);
  for (const code of ["export const = ;", "return 5;", "export const a=010;"]) {
    assert.throws(() => checkSyntax(code, "module.js", true), SyntaxError);
  }
});

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
  // 25 ファイル前後を期待。極端な減少 (例: glob 設定ミスで 0 件) を検知。
  if (files.length < 20) {
    throw new Error(
      `src/ 配下の JS ファイル数が想定より少ない: ${files.length} 件 (期待 20+)`
    );
  }

  for (const file of files) {
    const relative = path.relative(SRC_ROOT, file);
    await t.test(relative, () => {
      const code = fs.readFileSync(file, "utf8");
      // `chrome` 等のグローバル未定義はここでは検知しない設計。
      checkSyntax(code, file, moduleFiles.has(file));
    });
  }
});
