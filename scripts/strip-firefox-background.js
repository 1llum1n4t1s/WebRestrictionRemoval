"use strict";

// Windows・Unix・CI で同じ Firefox 向け除外処理を使う。
const fs = require("node:fs");
const path = require("node:path");

const target = process.argv[2];
if (!target) {
  console.error("使用方法: node scripts/strip-firefox-background.js <background.js>");
  process.exitCode = 1;
} else {
  const file = path.resolve(target);
  const content = fs.readFileSync(file, "utf8");
  const stripped = content.replace(
    /\s*\/\/\s*__FIREFOX_STRIP_BEGIN__.*?\/\/\s*__FIREFOX_STRIP_END__\s*\r?\n/gs,
    "\n"
  );
  fs.writeFileSync(file, stripped, "utf8");
}
