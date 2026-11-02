"use strict";
/* global chrome, document, getComputedStyle */

// VUORA_BROWSER_TEST_DIR=未使用の絶対パス、VUORA_REPLACE_FONT_DIR=ReplaceFontSelect の checkout。
// 実物の2拡張を同じ専用ブラウザへ読み込んで検証する。参照先の checkout は編集しない。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer");

test("Wikipedia のフォントを Vuora が優先し、OFF で ReplaceFontSelect に戻す", { timeout: 90000 }, async (t) => {
  const output = process.env.VUORA_BROWSER_TEST_DIR;
  const replacementRoot = process.env.VUORA_REPLACE_FONT_DIR;
  assert.ok(output && path.isAbsolute(output) && !fs.existsSync(output), "未使用の検証専用絶対パスが必要です");
  assert.ok(replacementRoot && path.isAbsolute(replacementRoot), "ReplaceFontSelect の絶対パスが必要です");
  for (let parent = path.dirname(output);;) {
    const stat = fs.lstatSync(parent);
    assert.equal(stat.isSymbolicLink(), false, "出力先はリンクを経由できません");
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  fs.accessSync(path.dirname(output), fs.constants.W_OK);
  fs.mkdirSync(output);
  const browser = await puppeteer.launch({
    headless: true,
    enableExtensions: [path.resolve(__dirname, ".."), replacementRoot],
    userDataDir: path.join(output, "profile"), args: ["--no-first-run", "--disable-sync"],
  });
  t.after(() => browser.close());
  async function findExtension(name) {
    const target = await browser.waitForTarget(async candidate => {
      if (candidate.type() !== "service_worker" || !candidate.url().startsWith("chrome-extension://")) return false;
      try { return await (await candidate.worker()).evaluate(expected => chrome.runtime.getManifest().name === expected, name); }
      catch { return false; }
    });
    return { origin: target.url().split("/").slice(0, 3).join("/"), worker: await target.worker() };
  }
  const vuora = await findExtension("Vuora");
  const rfs = await findExtension(JSON.parse(fs.readFileSync(path.join(replacementRoot, "manifest.json"), "utf8")).name);
  assert.notEqual(vuora.origin, rfs.origin);
  await rfs.worker.evaluate(() => chrome.storage.local.set({ fontSettings: { enabled: true, bodyFont: "noto-sans-jp", monoFont: "udev-gothic-jpdoc", bodyFontWeight: "400" } }));
  // バックグラウンドの設定処理が登録を終えた状態で文書を開く。
  await rfs.worker.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = async () => {
        const scripts = await chrome.scripting.getRegisteredContentScripts();
        if (scripts.some(script => script.js?.some(file => file.includes("preset-noto-sans-jp-udev-gothic-jpdoc-w400")))) return resolve();
        if (Date.now() > deadline) return reject(new Error("RFS のプリセット登録が完了しません"));
        setTimeout(check, 100);
      };
      check();
    });
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const fixture = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Wikipedia フォント併用確認</title>
    <style>body{margin:32px;line-height:1.8}#content{max-width:960px;margin:auto}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #aaa}.test-icon{font-family:serif!important}</style></head>
    <body class="ns-0 action-view"><header id="site-header">サイトの操作部分</header><main id="content"><h1 id="firstHeading">Wikipedia フォント併用確認</h1>
    <div id="mw-content-text"><div class="mw-parser-output"><p id="paragraph">日本語の本文と <b id="bold">太字</b>、<a id="link" href="#heading">リンク</a>。</p>
    <h2 id="heading">見出し</h2><ul><li id="item">箇条書き</li></ul><dl><dt id="term">用語</dt><dd id="definition">説明</dd></dl>
    <blockquote id="quote">引用文</blockquote><figure><figcaption id="caption">画像の説明</figcaption></figure>
    <table><caption id="table-caption">表の説明</caption><tbody><tr><th id="table-heading">見出しセル</th><td id="cell">表の本文</td></tr></tbody></table>
    <details><summary id="summary">詳細の見出し</summary>詳細の本文</details>
    <pre><code id="code">const value = 1;</code></pre><p><span id="icon" class="test-icon icon">★</span></p>
    <div contenteditable="true" style="font-family:serif"><p id="editable">編集できる入力欄</p></div>
    <div class="mwe-math-element" style="font-family:serif"><p id="math-text">数式の補助表示</p><math><mi id="math-glyph">x</mi><mo>=</mo><mn>1</mn></math></div>
    <div class="mw-editsection" style="font-family:serif"><p id="edit-tools">編集用の補助情報</p><a id="edit-link" href="#heading">編集</a></div>
    <div class="mw-ui-icon" style="font-family:serif"><p id="wiki-icon">ウィキペディアの操作アイコン</p></div>
    </div></div></main></body></html>`;
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (request.url().startsWith(vuora.origin + "/") || request.url().startsWith(rfs.origin + "/")) return request.continue();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) return request.respond({ status: 200, contentType: "text/html", body: fixture });
    return request.respond({ status: 404, body: "" });
  });
  await page.goto("https://ja.wikipedia.org/wiki/Vuora_font_test", { waitUntil: "load" });
  const reading = ["firstHeading", "paragraph", "bold", "link", "heading", "item", "term", "definition", "quote", "caption", "table-caption", "table-heading", "cell", "summary"];
  const protectedIds = ["site-header", "code", "icon", "editable", "math-text", "math-glyph", "edit-tools", "edit-link", "wiki-icon"];
  const families = ids => page.evaluate(list => Object.fromEntries(list.map(id => [id, getComputedStyle(document.getElementById(id)).fontFamily])), ids);
  await page.waitForFunction(() => getComputedStyle(document.getElementById("paragraph")).fontFamily.includes("Noto Sans JP"));
  const originalFamilies = await families([...reading, ...protectedIds]);
  assert.match(originalFamilies.code, /UDEV Gothic JPDOC/);
  const originalBody = await page.$eval("#mw-content-text", el => el.innerHTML);
  console.log("Vuora OFF: " + originalFamilies.paragraph);

  const popupTarget = browser.waitForTarget(target => target.url() === vuora.origin + "/src/popup/popup.html");
  await page.bringToFront();
  await vuora.worker.evaluate(() => chrome.action.openPopup());
  const popup = await (await popupTarget).asPage();
  await popup.waitForSelector("#categoryTrigger:not([disabled])");
  await popup.click("#categoryTrigger");
  await popup.click("#tabWikipedia");
  await popup.click("#wikipediaToggle");
  await popup.select("#wikipedia-font", "line-seed-jp");
  await page.waitForSelector('html[data-cpa-wiki-font="line-seed-jp"]');
  assert.equal(await page.evaluate(async () => (await document.fonts.load('400 18px "__cpa-wiki-line-seed-jp"', "日本語")).length), 1);
  let actual = await families(reading);
  console.log("両方 ON: " + JSON.stringify(actual));
  for (const [id, family] of Object.entries(actual)) assert.ok(family.includes("__cpa-wiki-line-seed-jp"), `${id}: ${family}`);
  assert.deepEqual(await families(protectedIds), Object.fromEntries(protectedIds.map(id => [id, originalFamilies[id]])), "操作部分・コード・アイコン・編集欄は維持する");
  await popup.select("#wikipedia-headingFont", "murecho");
  await page.waitForSelector('html[data-cpa-wiki-heading-font="murecho"]');
  assert.equal(await page.evaluate(async () => (await document.fonts.load('400 18px "__cpa-wiki-murecho"', "見出し")).length), 1);
  const independent = await families(reading);
  for (const [id, family] of Object.entries(independent)) assert.ok(family.includes(id === "firstHeading" || id === "heading" ? "__cpa-wiki-murecho" : "__cpa-wiki-line-seed-jp"), id + ": " + family);
  await popup.select("#wikipedia-headingFont", "serif");
  await page.waitForSelector('html[data-cpa-wiki-heading-font="serif"]');
  const headingCdp = await page.createCDPSession();
  await headingCdp.send("DOM.enable"); await headingCdp.send("CSS.enable");
  const headingDocument = await headingCdp.send("DOM.getDocument");
  const headingNode = await headingCdp.send("DOM.querySelector", { nodeId: headingDocument.root.nodeId, selector: "#firstHeading" });
  const headingFonts = await headingCdp.send("CSS.getPlatformFontsForNode", { nodeId: headingNode.nodeId });
  console.log("システム明朝の描画: " + JSON.stringify(headingFonts.fonts.map(font => ({ family: font.familyName, custom: font.isCustomFont }))));
  assert.ok(headingFonts.fonts.every(font => !font.familyName.includes("Noto Sans JP")), "システム明朝を RFS の別名フォントへ置換させない");
  await headingCdp.detach();
  await popup.select("#wikipedia-headingFont", "inherit");
  await page.waitForSelector('html[data-cpa-wiki-heading-font="inherit"]');

  // RFS のスタイルが後から末尾へ移動しても、専用の本文指定が優先される。
  await page.evaluate(() => {
    const styles = document.querySelectorAll("style[data-replace-font]");
    if (!styles.length) throw new Error("RFS の実スタイルが見つかりません");
    for (const style of styles) document.head.append(style);
    const paragraph = document.createElement("p"); paragraph.id = "dynamic"; paragraph.textContent = "あとから追加された本文";
    document.querySelector(".mw-parser-output").append(paragraph);
  });
  assert.ok((await families(["dynamic"])).dynamic.includes("__cpa-wiki-line-seed-jp"));
  for (const font of ["murecho", "sans", "serif", "line-seed-jp"]) {
    await popup.select("#wikipedia-font", font);
    await page.waitForSelector(`html[data-cpa-wiki-font="${font}"]`);
    actual = await families(reading);
    for (const [id, family] of Object.entries(actual)) {
      const expected = font === "sans" ? "system-ui" : font === "serif" ? "serif" : "__cpa-wiki-" + font;
      assert.ok(family.includes(expected), `${font} ${id}: ${family}`);
    }
  }
  await page.screenshot({ path: path.join(output, "both-enabled.png") });
  await popup.click("#wikipediaToggle");
  await page.waitForSelector("html.__cpa-wiki-active", { hidden: true });
  await page.evaluate(() => document.getElementById("dynamic").remove());
  assert.deepEqual(await families([...reading, ...protectedIds]), originalFamilies, "OFF で RFS の指定へ戻る");
  assert.equal(await page.$eval("#mw-content-text", el => el.innerHTML), originalBody);
  assert.ok((await rfs.worker.evaluate(() => chrome.storage.local.get("fontSettings"))).fontSettings.enabled);
  await page.screenshot({ path: path.join(output, "vuora-disabled.png") });
  assert.deepEqual(errors, []);
  console.log("確認済み: 2拡張同時ON・4書体切替・動的本文・RFS後挿入・OFF復元");

  if (process.env.VUORA_LIVE_WIKIPEDIA === "1") {
    const live = await browser.newPage();
    await live.setViewport({ width: 1600, height: 1000 });
    await vuora.worker.evaluate(() => chrome.storage.local.set({ wikipediaEnabled: true, wikipediaAppearance: { theme: "sepia", font: "line-seed-jp", fontSize: 18, contentWidth: 960 } }));
    await live.goto("https://ja.wikipedia.org/wiki/ネコ", { waitUntil: "load", timeout: 30000 });
    await live.waitForFunction(() => getComputedStyle(document.querySelector("#mw-content-text p")).fontFamily.includes("__cpa-wiki-line-seed-jp"));
    assert.equal(await live.evaluate(async () => (await document.fonts.load('400 18px "__cpa-wiki-line-seed-jp"', "日本語")).length), 1);
    const actualFamilies = await live.$$eval("#mw-content-text p", els => els.filter(el => el.textContent.length > 40).slice(0, 8).map(el => getComputedStyle(el).fontFamily));
    assert.equal(actualFamilies.length, 8);
    assert.ok(actualFamilies.every(family => family.includes("__cpa-wiki-line-seed-jp")));
    const cdp = await live.createCDPSession();
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#mw-content-text p" });
    const platform = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    assert.ok(platform.fonts.some(font => font.isCustomFont && font.glyphCount > 0), "描画に Web フォントが使用される");
    console.log("実Wikipediaの描画フォント: " + JSON.stringify(platform.fonts.map(font => ({ family: font.familyName, custom: font.isCustomFont }))));
    await live.screenshot({ path: path.join(output, "live-both-enabled.png") });
    await vuora.worker.evaluate(() => chrome.storage.local.set({ wikipediaEnabled: false }));
    await live.waitForFunction(() => getComputedStyle(document.querySelector("#mw-content-text p")).fontFamily.includes("Noto Sans JP"));
    await live.screenshot({ path: path.join(output, "live-vuora-disabled.png") });
    assert.equal((await rfs.worker.evaluate(() => chrome.storage.local.get("fontSettings"))).fontSettings.bodyFont, "noto-sans-jp");
    console.log("実Wikipedia: 両方ONでVuora、OFFでRFSへの復元を確認");
  }
});
