// IBM Plex Sans JP Bold (weight 700) woff2 を IBM 公式 full version から subset 化して生成。
//
// 使い方:
//   1. 必要な依存をワンタイム install (devDependencies には保存しない):
//        npm install --no-save fontkit subset-font @ibm/plex-sans-jp@3.0.0
//   2. このスクリプトを実行:
//        node scripts/fetch-bold-woff2.mjs
//   3. 完了後 node_modules を片付ける場合:
//        npm ci   # package.json の devDependencies に戻す
//
// 戦略:
//   - 既存 src/popup/fonts/IBMPlexSansJP-Regular.woff2 の cmap (約 652 文字) を fontkit で抽出
//   - @ibm/plex-sans-jp パッケージの complete/woff2/hinted/IBMPlexSansJP-Bold.woff2 (約 2.3 MB) を読み込み
//   - subset-font で同じ unicode 集合に絞った woff2 を書き出し → 約 200 KB
//
// 注: Regular/SemiBold は IBM 純正の subset 済み woff2 (約 77/81 KB) なので、本スクリプト生成の Bold は
// 圧縮率が IBM 純正より低い (200 KB)。preload で並列 fetch すれば実用上問題なし。

import { readFile, writeFile } from "node:fs/promises";
import * as fontkit from "fontkit";
import subsetFont from "subset-font";

const REGULAR_PATH = "src/popup/fonts/IBMPlexSansJP-Regular.woff2";
const FULL_BOLD_PATH =
  "node_modules/@ibm/plex-sans-jp/fonts/complete/woff2/hinted/IBMPlexSansJP-Bold.woff2";
const BOLD_OUT = "src/popup/fonts/IBMPlexSansJP-Bold.woff2";

console.log("1) 既存 Regular の cmap を抽出...");
const regularBuffer = await readFile(REGULAR_PATH);
const regularFont = fontkit.create(regularBuffer);
const codepoints = [];
for (const cp of regularFont.characterSet) {
  codepoints.push(cp);
}
console.log(`   Regular に含まれる unicode 数: ${codepoints.length}`);

console.log(`2) IBM/plex full Bold woff2 を node_modules から読み込み...`);
const fullBoldBuffer = await readFile(FULL_BOLD_PATH);
console.log(`   full Bold size: ${fullBoldBuffer.length} bytes`);

console.log("3) subset-font で同じ unicode 集合で subset 化...");
const text = codepoints.map((cp) => String.fromCodePoint(cp)).join("");
const subsetBuffer = await subsetFont(fullBoldBuffer, text, {
  targetFormat: "woff2",
});
console.log(`   subset Bold size: ${subsetBuffer.length} bytes`);

await writeFile(BOLD_OUT, subsetBuffer);
console.log(`   Saved: ${BOLD_OUT}`);
console.log("Done.");
