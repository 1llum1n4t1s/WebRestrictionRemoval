"use strict";
/* global chrome, document, getComputedStyle, innerWidth, window, WikipediaReader */

// VUORA_BROWSER_TEST_DIR に検証専用の絶対パスを指定して bun test ./scripts/verify-wikipedia.js を実行。
// 実際の拡張を専用 Chrome プロファイルへ読み込み、ネットワークを fixture に置換する。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer");
const sharp = require("sharp");

async function templateColors(page) {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.cssText = "background-color:var(--cpa-wiki-soft);color:var(--cpa-wiki-ink);border:1px solid var(--cpa-wiki-border)";
    document.body.append(probe);
    const read = el => { const css = getComputedStyle(el); return { background: css.backgroundColor, color: css.color, border: css.borderTopColor, borderStyle: css.borderTopStyle, accent: css.borderLeftColor }; };
    const result = { expected: read(probe), path: read(document.querySelector(".pathnavbox")), notice: read(document.querySelector(".ambox")) };
    result.navigation = [...document.querySelectorAll(".navbox-title, #catlinks")].map(read);
    result.navigationTitles = [...document.querySelectorAll(".navbox-title > div[id]")].map(el => {
      let surface = el;
      while (surface.parentElement && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)") surface = surface.parentElement;
      return { color: getComputedStyle(el).color, background: getComputedStyle(surface).backgroundColor,
        link: getComputedStyle(el.querySelector("a")).color };
    });
    result.link = getComputedStyle(document.querySelector(".pathnavbox a")).color;
    result.navigationBody = [...document.querySelectorAll(".navbox-list")].map(el => ({ actual: read(el).background, expected: el.classList.contains("navbox-even") ? read(probe).background : read(document.body).background }));
    const text = document.querySelector(".ambox .mbox-text-span");
    let surface = text;
    while (surface.parentElement && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)") surface = surface.parentElement;
    result.noticeText = { color: getComputedStyle(text).color, background: getComputedStyle(surface).backgroundColor };
    probe.remove();
    return result;
  });
}

test("Wikipedia: popup → background → storage → content の操作経路", { timeout: 90000 }, async (t) => {
  const output = process.env.VUORA_BROWSER_TEST_DIR;
  assert.ok(output && path.isAbsolute(output), "VUORA_BROWSER_TEST_DIR に検証専用の絶対パスが必要です");
  // 既存データの混在・リンク先への書込みを避ける。
  assert.ok(!fs.existsSync(output), "検証には未使用のディレクトリを指定してください");
  let parent = path.dirname(output);
  while (true) {
    assert.ok(!fs.lstatSync(parent).isSymbolicLink(), "リンクを経由する出力先は使用できません");
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  fs.accessSync(path.dirname(output), fs.constants.W_OK);
  fs.mkdirSync(output);
  const browser = await puppeteer.launch({
    headless: true,
    enableExtensions: [path.resolve(__dirname, "..")],
    userDataDir: path.join(output, "profile"),
    args: ["--no-first-run", "--disable-sync"],
  });
  t.after(() => browser.close());
  const target = await browser.waitForTarget((item) => item.type() === "service_worker" && item.url().startsWith("chrome-extension://"));
  const worker = await target.worker();
  const extensionOrigin = target.url().split("/").slice(0, 3).join("/");
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const image = await sharp({ create: { width: 240, height: 160, channels: 3, background: "#805160" } }).png().toBuffer();
  const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Vuora test - Wikipedia</title>
    <style>body{margin:0;background:white;color:#202122}.mw-page-container-inner{display:grid;grid-template-columns:200px 1fr 200px;grid-template-areas:'columnStart pageContent columnEnd'}#content{grid-area:pageContent}p{font-size:inherit}a{color:#36c}a.new{color:#d33}#mw-panel-toc{grid-area:columnStart}.wikitable{background:#f8f9fa}</style></head>
    <body class="ns-0 action-view skin-vector-2022"><div class="vector-header-container"><header class="mw-header">Wikipedia <form id="searchform" action="/w/index.php"><input id="searchInput" name="search" aria-label="Search Wikipedia"><button>Search</button></form><nav id="appearance-dropdown" class="vector-appearance-landmark">Appearance menu</nav></header></div>
    <div class="mw-page-container"><div class="mw-page-container-inner"><div class="vector-column-start"><aside id="mw-panel-toc">Original contents</aside><div id="vector-main-menu-pinned-container"></div></div><div class="mw-content-container"><main id="content"><header class="vector-page-titlebar"><h1 id="firstHeading">Vuora test</h1></header><div class="vector-page-toolbar"><a id="edit-article" href="/w/index.php?title=Vuora_test&action=edit">Edit</a><a href="/w/index.php?title=Vuora_test&action=history">History</a></div>
    <aside class="vector-column-end"><nav id="appearance-pinned" class="vector-appearance-landmark"><div id="vector-appearance">Appearance panel</div></nav><div id="vector-page-tools-pinned-container"><div id="page-tools">Page tools</div></div></aside><div id="bodyContent">
    <div id="mw-content-text"><div class="mw-parser-output"><p id="intro">日本語の本文と<b>太字</b>。 An article with <a id="article-link" href="/wiki/Cat">a related article</a>, a <a class="new" id="missing-link" href="/wiki/Missing">missing article</a>, an inline icon <img id="inline-icon" width="12" height="8" src="https://upload.wikimedia.org/wikipedia/test.png" alt="icon"> and a <sup class="reference"><a id="ref-link" href="#cite_note-1">[1]</a></sup>.</p>
    <figure id="article-photo"><a id="file-link" class="mw-file-description" href="/wiki/File:Test.png"><img width="240" height="160" src="https://upload.wikimedia.org/wikipedia/test.png" alt="Test image"></a><figcaption>Image caption</figcaption></figure>
    <div class="pathnavbox" style="background:#e8eeff;color:#202122;border:1px outset #eeefff"><a href="/wiki/Final_Fantasy">Final Fantasy</a> &gt; <b>Final Fantasy VIII</b></div>
    <div class="navbox" style="background:#fff"><table class="navbox-inner"><tbody><tr><th class="navbox-title" style="background:#a3a8fe;color:#000"><span class="navbar" style="background:#a3a8fe;color:#000"><a href="/wiki/Final_Fantasy"><span style="background:#a3a8fe;color:#002bb8">Series</span></a></span></th></tr><tr><td class="navbox-list" style="background:#fff">Related articles</td></tr></tbody></table></div>
    <div id="catlinks" style="background:#f8f9fa;color:#202122;border:1px solid #a2a9b1">Categories</div>
    <table class="ambox" style="background:#fbfbfb;color:#202122;border:1px solid #a2a9b1;border-left:10px solid #f28500"><tbody><tr><td class="mbox-text"><div class="mbox-text-span">Article notice</div></td></tr></tbody></table>
    <section data-mw-section-id="1"><h2 id="section-one">First section</h2><p>First section content stays editable.</p><h3>Subsection</h3><p>Subsection text.</p>
    <table id="data-table" class="wikitable"><tbody><tr><td>Table text</td></tr></tbody></table></section>
    <table id="article-infobox" class="infobox"><tbody><tr><td>Infobox</td></tr></tbody></table>
    <table id="collapsible-table" class="mw-collapsible"><tbody><tr><td>Collapsible content</td></tr></tbody></table><h2 id="references">References</h2>
    <ol><li id="cite_note-1"><span class="reference-text">Reference text &lt;img src=x onerror=alert(1)&gt;</span></li></ol></div></div>
    </div></main></div><div class="mw-footer-container"><footer id="footer">Text is available under CC BY-SA. <a href="/wiki/Copyright">License</a></footer></div></div></div></body></html>`;
  const requests = [];
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    requests.push(request.url());
    if (request.url().startsWith(extensionOrigin + "/src/fonts/wikipedia/")) {
      request.continue();
    } else if (request.url() === "https://upload.wikimedia.org/wikipedia/test.png") {
      request.respond({ status: 200, contentType: "image/png", headers: { "cache-control": "max-age=3600" }, body: image });
    } else if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      request.respond({ status: 200, contentType: "text/html", body: fixture });
    } else request.respond({ status: 404, body: "" });
  });
  await page.goto("https://en.wikipedia.org/wiki/Vuora_test", { waitUntil: "load" });
  await page.bringToFront();
  const popupTarget = browser.waitForTarget((item) => item.url() === extensionOrigin + "/src/popup/popup.html");
  await worker.evaluate(() => chrome.action.openPopup());
  let popup = await (await popupTarget).asPage();
  popup.on("pageerror", (error) => errors.push(error.message));
  const original = await page.$eval("#mw-content-text", (el) => el.innerHTML);
  await page.evaluate(() => {
    window.__wikiOriginalNodes = Object.fromEntries(["content", "firstHeading", "searchform", "article-infobox", "footer"].map(id => {
      const node = document.getElementById(id); return [id, { node, parent: node.parentNode }];
    }));
  });

  await t.test("カテゴリドロップダウンの選択・キャンセル・キーボード操作と保存", async (navTest) => {
    navTest.after(async () => {
      if (!popup.isClosed()) await popup.evaluate(() => {
        const menu = document.getElementById("categoryMenu");
        if (menu.matches(":popover-open")) menu.hidePopover();
      });
    });
    await popup.waitForSelector("#categoryTrigger:not([disabled])");
    assert.equal(await popup.$eval("#categoryName", el => el.textContent), "調整");
    await popup.click("#categoryTrigger");
    await popup.waitForFunction(() => document.activeElement.id === "tabTune");
    assert.equal(await popup.$$eval('#categoryMenu [role="option"]', els => els.length), 8);
    await popup.keyboard.press("End");
    assert.equal(await popup.evaluate(() => document.activeElement.id), "tabSettings");
    await popup.keyboard.press("Home");
    await popup.keyboard.press("ArrowDown");
    assert.equal(await popup.$eval("#categoryName", el => el.textContent), "調整");
    await popup.keyboard.press("Enter");
    await popup.waitForSelector("#panelYoutube:not([hidden])");
    assert.equal(await popup.$eval("#categoryTrigger", el => el.getAttribute("aria-expanded")), "false");
    await popup.keyboard.press("ArrowDown");
    await popup.keyboard.press("ArrowDown");
    await popup.keyboard.press("Escape");
    assert.equal(await popup.evaluate(() => document.activeElement.id), "categoryTrigger");
    assert.equal(await popup.$eval("#categoryName", el => el.textContent), "YouTube");
    await popup.click("#categoryTrigger");
    await popup.click(".hdr-title");
    await popup.waitForFunction(() => !document.querySelector("#categoryMenu").matches(":popover-open"));
    await popup.click("#categoryTrigger");
    await popup.click("#categoryTrigger");
    assert.equal(await popup.$eval("#categoryMenu", el => el.matches(":popover-open")), false);
    await popup.click("#categoryTrigger");
    await popup.keyboard.press("w");
    assert.equal(await popup.evaluate(() => document.activeElement.id), "tabWikipedia");
    await popup.keyboard.press("Escape");
    assert.equal(await popup.$eval("#categoryName", el => el.textContent), "YouTube");
    await popup.click("#categoryTrigger");
    await popup.keyboard.press("Tab");
    assert.equal(await popup.$eval("#categoryMenu", el => el.matches(":popover-open")), false);
    assert.equal(await popup.evaluate(() => document.activeElement.id === "categoryTrigger" || document.activeElement === document.body), false, "Tabで本文の操作へ進める");
    for (const id of ["Tune", "Youtube", "X", "Instagram", "TikTok", "Picker", "Settings", "Wikipedia"]) {
      await popup.click("#categoryTrigger");
      await popup.click("#tab" + id);
      await popup.waitForSelector("#panel" + id + ":not([hidden])");
      assert.equal(await popup.$$eval('.panel:not([hidden])', els => els.length), 1);
    }
    await popup.waitForFunction(async () => (await chrome.storage.local.get("popupLastTab")).popupLastTab === "wikipedia");
    await popup.evaluate(() => window.scrollTo(0, 0));
    for (const theme of ["dark", "light"]) {
      await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      await popup.click("#categoryTrigger");
      await popup.waitForFunction(() => document.activeElement.id === "tabWikipedia");
      await popup.evaluate(() => document.fonts.ready);
      await popup.screenshot({ path: path.join(output, "category-dropdown-" + theme + ".png") });
      const fits = await popup.$eval("#categoryMenu", el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= window.innerHeight; });
      assert.equal(fits, true, "一覧はポップアップ内に収まる");
      assert.equal(await popup.$eval("#categoryMenu", el => el.scrollHeight <= el.clientHeight), true, "8カテゴリを一覧できる");
      await popup.keyboard.press("Escape");
    }
    await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  });

  await t.test("未設定のマスターはOFFでページを変更しない", async () => {
    if (await popup.$eval("#panelWikipedia", el => el.hidden)) {
      await popup.click("#categoryTrigger");
      await popup.click("#tabWikipedia");
    }
    assert.equal(await popup.$eval("#wikipediaToggle", (el) => el.checked), false);
    assert.equal(await page.$("html.__cpa-wiki-active"), null);
    assert.equal(await popup.$eval("#wikipediaOptions", (el) => el.disabled), true);
    assert.equal(requests.filter(url => url.includes("/src/fonts/wikipedia/")).length, 0, "OFF時は同梱フォントも読まない");
  });
  await t.test("popupのONと外観変更が実際の記事へ届く", async () => {
    await popup.click("#wikipediaToggle");
    await page.waitForSelector("html.__cpa-wiki-active .__cpa-wiki-toc");
    await popup.select("#wikipedia-theme", "one-light");
    await popup.select("#wikipedia-font", "serif");
    await popup.focus("#wikipedia-fontSize");
    for (let i = 0; i < 3; i++) await popup.keyboard.press("ArrowRight");
    await popup.focus("#wikipedia-contentWidth");
    for (let i = 0; i < 4; i++) await popup.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("mw-content-text")).fontSize === "21px");
    const actual = await page.$eval("#mw-content-text", (el) => ({ size: getComputedStyle(el).fontSize, font: getComputedStyle(el).fontFamily }));
    assert.equal(actual.size, "21px");
    assert.match(actual.font, /serif/);
    assert.equal(await page.$$eval(".__cpa-wiki-toc a", (els) => els.length), 3);
    assert.equal(await page.$eval("#mw-panel-toc", (el) => getComputedStyle(el).display), "none");
    assert.equal(await page.$eval("#footer", (el) => getComputedStyle(el).display), "block");
    assert.equal(new URL(page.url()).pathname, "/wiki/Vuora_test");
    await page.screenshot({ path: path.join(output, "wikipedia-desktop.png") });
    await popup.evaluate(() => window.scrollTo(0, 0));
    await popup.screenshot({ path: path.join(output, "wikipedia-popup.png") });
  });
  await t.test("新しい記事構造に実ノードを組み込み、レイアウトOFFで元へ戻す", async () => {
    await page.waitForSelector("html.__cpa-wiki-modern .__cpa-wiki-shell #firstHeading");
    assert.equal(await page.$$eval(".__cpa-wiki-shell", els => els.length), 1);
    assert.equal(await page.evaluate(() => Object.entries(window.__wikiOriginalNodes).every(([id, { node }]) => document.getElementById(id) === node)), true);
    assert.equal(await page.$eval(".__cpa-wiki-rail", el => el.contains(document.querySelector(".__cpa-wiki-toc"))), true);
    assert.equal(await page.$eval(".__cpa-wiki-facts", el => el.open), false);
    assert.equal(await page.$eval(".__cpa-wiki-facts", el => el.nextElementSibling.querySelector("#section-one") !== null), true, "基本情報は冒頭の説明の後に置く");
    assert.ok(await page.$eval(".__cpa-wiki-facts", el => Math.abs(el.getBoundingClientRect().width - document.querySelector("#mw-content-text").getBoundingClientRect().width) < 2), "基本情報が本文の全幅を使う");
    await page.click(".__cpa-wiki-actions > summary");
    await page.focus("#edit-article");
    assert.equal(await page.evaluate(() => document.activeElement.id), "edit-article");
    await page.$eval("#searchInput", el => { el.value = "kept search"; });
    await page.evaluate(() => { document.querySelector(".__cpa-wiki-facts").open = false; window.location.hash = "article-infobox"; });
    await page.waitForFunction(() => document.querySelector(".__cpa-wiki-facts").open);
    await page.evaluate(() => { window.history.replaceState(null, "", window.location.pathname); document.querySelector(".__cpa-wiki-facts").open = false; window.dispatchEvent(new Event("beforeprint")); });
    assert.equal(await page.$eval(".__cpa-wiki-facts", el => el.open), true);
    await page.emulateMediaType("print");
    assert.ok(await page.$eval("#article-infobox", el => el.getClientRects().length > 0));
    assert.ok(await page.$eval("#footer", el => el.getClientRects().length > 0));
    await page.emulateMediaType(null);
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    assert.equal(await page.$eval(".__cpa-wiki-facts", el => el.open), false);
    await popup.click("#wikipedia-feature-readableLayout");
    await page.waitForSelector(".__cpa-wiki-shell", { hidden: true });
    assert.equal(await page.evaluate(() => Object.values(window.__wikiOriginalNodes).every(({ node, parent }) => node.parentNode === parent)), true);
    assert.equal(await page.$eval("#searchInput", el => el.value), "kept search");
    await popup.click("#wikipedia-feature-readableLayout");
    await page.waitForSelector(".__cpa-wiki-shell");
    assert.equal(await page.$$eval("#firstHeading", els => els.length), 1);
  });
  await t.test("標準の表示パネルだけを隠し、再読込・OFFで正しく復元する", async () => {
    const feature = "#wikipedia-feature-hideAppearance";
    assert.equal(await popup.$eval(feature, el => el.checked), false, "既定では標準パネルを残す");
    await popup.click(feature);
    await page.waitForFunction(() => [...document.querySelectorAll("nav.vector-appearance-landmark")].every(el => getComputedStyle(el).display === "none"));
    assert.notEqual(await page.$eval("#page-tools", el => getComputedStyle(el).display), "none", "他のページツールは残す");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.documentElement.classList.contains("__cpa-wiki-hide-appearance"));
    await popup.reload();
    await popup.waitForSelector("#categoryTrigger:not([disabled])");
    assert.equal(await popup.$eval(feature, el => el.checked), true, "設定を保存する");
    await popup.click("#wikipediaToggle");
    await page.waitForFunction(() => !document.documentElement.classList.contains("__cpa-wiki-hide-appearance"));
    assert.notEqual(await page.$eval("#appearance-pinned", el => getComputedStyle(el).display), "none");
    await popup.click("#wikipediaToggle");
    await page.waitForFunction(() => document.documentElement.classList.contains("__cpa-wiki-hide-appearance"));
    await popup.click(feature);
    await page.waitForFunction(() => [...document.querySelectorAll("nav.vector-appearance-landmark")].every(el => getComputedStyle(el).display !== "none"));
  });
  await t.test("同梱7書体の通常・太字を読込し、選択書体だけを拡張内から取得する", async () => {
    const fonts = await popup.evaluate(() => WikipediaReader.FONTS);
    assert.equal(fonts.length, 7);
    for (const font of fonts) {
      const before = requests.length;
      await popup.select("#wikipedia-font", font.key);
      await page.waitForSelector(`html[data-cpa-wiki-font="${font.key}"]`);
      const result = await page.evaluate(async key => {
        const family = `__cpa-wiki-${key}`;
        const regular = await document.fonts.load(`400 21px "${family}"`, "日本語の本文");
        const bold = await document.fonts.load(`700 21px "${family}"`, "太字");
        return { regular: regular.length === 1 && regular[0].status === "loaded", bold: bold.length === 1 && bold[0].status === "loaded", family: getComputedStyle(document.getElementById("intro")).fontFamily };
      }, font.key);
      assert.equal(result.regular, true, font.key + " 通常");
      assert.equal(result.bold, true, font.key + " 太字");
      assert.ok(result.family.includes("__cpa-wiki-" + font.key));
      const allowed = [font.regular, font.bold].map(file => extensionOrigin + "/src/fonts/wikipedia/" + file);
      assert.ok(requests.slice(before).every(url => allowed.includes(url)), "選択した同梱ファイル以外へ通信しない");
    }
    await popup.click("#wikipediaToggle");
    await page.waitForSelector("html.__cpa-wiki-active", { hidden: true });
    assert.equal(await page.evaluate(() => [...document.fonts].filter(face => face.family.includes("__cpa-wiki-")).length), 0, "マスターOFFでフォント宣言も撤去する");
    await popup.click("#wikipediaToggle");
    await page.waitForSelector('html[data-cpa-wiki-font="line-seed-jp"]');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(output, "wikipedia-bundled-font.png") });
    await popup.$eval("#wikipedia-font", el => el.scrollIntoView({ block: "center" }));
    await popup.screenshot({ path: path.join(output, "wikipedia-font-options.png") });
    await popup.select("#wikipedia-font", "serif");
    await page.waitForSelector('html[data-cpa-wiki-font="serif"]');
    assert.equal(await page.evaluate(() => [...document.fonts].filter(face => face.family.includes("__cpa-wiki-")).length), 0, "システム書体に戻すと同梱フォントの宣言も撤去する");
  });
  await t.test("外観: 独立書体・配色・本文幅・リンク・記事表示", async custom => {
    const previous = (await worker.evaluate(() => chrome.storage.local.get("wikipediaAppearance"))).wikipediaAppearance;
    custom.after(async () => {
      await page.emulateMediaFeatures([]);
      await worker.evaluate(value => chrome.storage.local.set({ wikipediaAppearance: value }), previous);
      await page.waitForFunction(value => document.documentElement.getAttribute("data-cpa-wiki-theme") === value.theme
        && document.documentElement.getAttribute("data-cpa-wiki-article-style") === "full", {}, previous);
    });
    assert.equal(await popup.$$eval("#wikipediaAppearance select, #wikipediaAppearance input[type=range]", els => els.length), 6);
    assert.equal(await popup.$("#wikipedia-coverImage"), null, "カバー画像の設定は表示しない");
    assert.ok(await popup.$$eval("#wikipediaAppearance option", els => els.every(el => el.textContent.trim())));
    await popup.select("#wikipedia-font", "line-seed-jp");
    await popup.select("#wikipedia-headingFont", "noto-sans-jp");
    await page.waitForSelector('html[data-cpa-wiki-heading-font="noto-sans-jp"]');
    const fonts = await page.evaluate(async () => {
      await document.fonts.load('400 18px "__cpa-wiki-noto-sans-jp"', "見出し");
      await document.fonts.load('400 18px "__cpa-wiki-line-seed-jp"', "本文");
      return { heading: getComputedStyle(document.getElementById("firstHeading")).fontFamily, body: getComputedStyle(document.getElementById("intro")).fontFamily };
    });
    assert.ok(fonts.heading.includes("__cpa-wiki-noto-sans-jp"));
    assert.ok(fonts.body.includes("__cpa-wiki-line-seed-jp"));
    const themes = await popup.evaluate(() => WikipediaReader.AVAILABLE_THEMES);
    assert.equal(themes.length, 11);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    for (const theme of themes) {
      await popup.select("#wikipedia-theme", theme);
      await page.waitForSelector(`html[data-cpa-wiki-theme="${theme}"]`);
      if (theme === "original") continue;
      const colors = await templateColors(page);
      for (const component of colors.navigation) for (const key of ["background", "color"]) assert.equal(component[key], colors.expected[key], theme + " のナビゲーション配色");
      for (const row of colors.navigationBody) assert.equal(row.actual, row.expected);
      for (const component of [colors.path, colors.notice]) {
        for (const key of ["background", "color", "border", "borderStyle"]) assert.equal(component[key], colors.expected[key], theme + " の記事案内 " + key);
      }
      assert.equal(colors.notice.accent, "rgb(242, 133, 0)", "注意の種類を示す左線は保持する");
      for (const key of ["background", "color"]) assert.equal(colors.noticeText[key], colors.expected[key], theme + " の注意本文 " + key);
      const contrast = await page.evaluate(() => {
        const light = color => {
          const rgb = color.match(/[\d.]+/g).slice(0, 3).map(v => { const c = Number(v) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
          return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
        };
        const style = getComputedStyle(document.body), bg = light(style.backgroundColor);
        const ratio = color => { const value = light(color); return (Math.max(value, bg) + .05) / (Math.min(value, bg) + .05); };
        return { body: ratio(style.color), link: ratio(getComputedStyle(document.getElementById("article-link")).color),
          missing: ratio(getComputedStyle(document.getElementById("missing-link")).color),
          dark: document.documentElement.classList.contains("__cpa-wiki-dark") };
      });
      assert.ok(contrast.body >= 4.5, theme + " の本文コントラスト");
      assert.ok(contrast.link >= 4.5, theme + " のリンクコントラスト");
      if (contrast.dark) assert.ok(contrast.missing >= 4.5, theme + " の未作成リンクのコントラスト");
    }
    await popup.select("#wikipedia-theme", "original");
    await page.waitForSelector('html[data-cpa-wiki-theme="original"]');
    assert.equal((await templateColors(page)).path.background, "rgb(232, 238, 255)", "Wikipediaの元の配色へ戻せる");
    await popup.select("#wikipedia-theme", "auto");
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.waitForFunction(() => !document.documentElement.classList.contains("__cpa-wiki-dark"));
    const light = await page.$eval("body", el => getComputedStyle(el).backgroundColor);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await page.waitForFunction(() => document.documentElement.classList.contains("__cpa-wiki-dark"));
    assert.notEqual(await page.$eval("body", el => getComputedStyle(el).backgroundColor), light);
    await popup.select("#wikipedia-theme", "one-light");
    await popup.click('button[aria-label="S: 680 px"]');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--cpa-wiki-width").trim() === "680px");
    for (const [label, value] of [["S", 14], ["M", 16], ["L", 18]]) {
      await popup.click(`button[aria-label="${label}: ${value} px"]`);
      await page.waitForFunction(size => getComputedStyle(document.getElementById("mw-content-text")).fontSize === `${size}px`, {}, value);
    }
    await popup.$eval("#wikipedia-fontSize", el => {
      el.value = "22";
      el.dispatchEvent(new el.ownerDocument.defaultView.Event("input", { bubbles: true }));
      el.dispatchEvent(new el.ownerDocument.defaultView.Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => getComputedStyle(document.getElementById("mw-content-text")).fontSize === "22px");
    await popup.focus("#wikipedia-lineHeight");
    await popup.keyboard.press("Home");
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.getElementById("intro")).lineHeight) - 22 * 1.3) < .1);
    await popup.keyboard.press("End");
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.getElementById("intro")).lineHeight) - 22 * 2.4) < .1);
    for (let i = 0; i < 17; i++) await popup.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.getElementById("intro")).lineHeight) - 22 * 1.55) < .1);
    await popup.$eval("#wikipedia-contentWidth", el => {
      el.value = "973";
      el.dispatchEvent(new el.ownerDocument.defaultView.Event("input", { bubbles: true }));
      el.dispatchEvent(new el.ownerDocument.defaultView.Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--cpa-wiki-width").trim() === "973px");
    await page.mouse.move(1590, 990);
    const choose = async (key, value) => popup.click(`#wikipedia-${key} label:has(input[value="${value}"])`);
    await choose("linkStyle", "underline");
    await page.waitForFunction(() => {
      const link = getComputedStyle(document.getElementById("article-link"));
      return link.textDecorationLine.includes("underline") && link.color === getComputedStyle(document.getElementById("intro")).color;
    });
    await page.hover("#article-link");
    assert.notEqual(await page.$eval("#article-link", el => getComputedStyle(el).color), await page.$eval("#intro", el => getComputedStyle(el).color));
    await page.mouse.move(1590, 990);
    await choose("linkStyle", "color");
    await page.waitForFunction(() => {
      const link = getComputedStyle(document.getElementById("article-link"));
      return !link.textDecorationLine.includes("underline") && link.color !== getComputedStyle(document.getElementById("intro")).color;
    });
    const beforeMedia = requests.length;
    await worker.evaluate(async () => {
      const saved = await chrome.storage.local.get("wikipediaAppearance");
      await chrome.storage.local.set({ wikipediaAppearance: { ...saved.wikipediaAppearance, coverImage: "show" } });
    });
    assert.equal(await popup.$("#wikipedia-borderRadius"), null);
    await worker.evaluate(async () => {
      const saved = await chrome.storage.local.get("wikipediaAppearance");
      await chrome.storage.local.set({ wikipediaAppearance: { ...saved.wikipediaAppearance, borderRadius: "square" } });
    });
    await page.waitForFunction(() => getComputedStyle(document.getElementById("data-table")).borderRadius === "4px");
    assert.equal(await page.$eval("html", el => el.hasAttribute("data-cpa-wiki-radius")), false);
    await choose("articleStyle", "pictures");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("data-table")).display === "none");
    assert.notEqual(await page.$eval("#intro", el => getComputedStyle(el).display), "none");
    assert.notEqual(await page.$eval("#article-photo", el => getComputedStyle(el).display), "none");
    assert.notEqual(await page.$eval("#article-infobox", el => getComputedStyle(el).display), "none");
    assert.notEqual(await page.$eval("#collapsible-table", el => getComputedStyle(el).display), "none");
    assert.notEqual(await page.$eval(".__cpa-wiki-toc", el => getComputedStyle(el).display), "none");
    await page.screenshot({ path: path.join(output, "wikipedia-pictures.png") });
    await page.click("#file-link");
    await page.waitForSelector("dialog[open]");
    await choose("articleStyle", "text");
    await page.waitForFunction(() => !document.querySelector("dialog") && getComputedStyle(document.getElementById("article-photo")).display === "none");
    assert.notEqual(await page.$eval("#intro", el => getComputedStyle(el).display), "none");
    assert.notEqual(await page.$eval("#inline-icon", el => getComputedStyle(el).display), "none");
    assert.equal(await page.$eval("#article-infobox", el => el.getClientRects().length), 0);
    await choose("articleStyle", "full");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("data-table")).display !== "none");
    assert.notEqual(await page.$eval("#article-photo", el => getComputedStyle(el).display), "none");
    assert.equal(await page.$(".__cpa-wiki-cover, .__cpa-wiki-gallery"), null, "旧カバー設定があっても独自画像を作らない");
    assert.equal(requests.length, beforeMedia, "表示切替で画像を再取得しない");
    assert.equal((await worker.evaluate(() => chrome.storage.local.get("wikipediaAppearance"))).wikipediaAppearance.coverImage, "show", "旧設定を保持する");
    await page.screenshot({ path: path.join(output, "wikipedia-full.png") });
    for (const [index, group] of ["typography", "layout", "display"].entries()) {
      await popup.$eval(`#wikipediaAppearance .wikipedia-group:nth-child(${index + 1})`, el => el.scrollIntoView({ block: "start" }));
      await popup.screenshot({ path: path.join(output, "wikipedia-settings-" + group + ".png") });
    }
    await popup.reload();
    await popup.waitForSelector("#categoryTrigger:not([disabled])");
    assert.equal(await popup.$eval("#wikipedia-headingFont", el => el.value), "noto-sans-jp");
    assert.equal(await popup.$eval("#wikipedia-contentWidth", el => el.value), "973");
    assert.equal(await popup.$eval("#wikipedia-lineHeight", el => el.value), "1.55");
    assert.match(await popup.$eval("#wikipedia-lineHeight", el => el.getAttribute("aria-valuetext")), /1\.55/);
    assert.equal(await popup.$("#wikipedia-coverImage"), null);
    assert.equal(await popup.$eval('#wikipedia-articleStyle input[value="full"]', el => el.checked), true);
    await page.keyboard.press("Escape");
  });
  await t.test("旧テーマを保持し、新テーマへ切替後は通常候補だけを表示する", async legacy => {
    const previous = (await worker.evaluate(() => chrome.storage.local.get("wikipediaAppearance"))).wikipediaAppearance;
    legacy.after(async () => {
      await worker.evaluate(value => chrome.storage.local.set({ wikipediaAppearance: value }), previous);
      await page.waitForSelector(`html[data-cpa-wiki-theme="${previous.theme}"]`);
      await popup.reload();
      await popup.waitForSelector("#categoryTrigger:not([disabled])");
    });
    await worker.evaluate(async () => {
      const saved = await chrome.storage.local.get("wikipediaAppearance");
      await chrome.storage.local.set({ wikipediaAppearance: { ...saved.wikipediaAppearance, theme: "calmness" } });
    });
    await page.waitForSelector('html[data-cpa-wiki-theme="calmness"]');
    await popup.reload();
    await popup.waitForSelector("#categoryTrigger:not([disabled])");
    assert.equal(await popup.$eval("#wikipedia-theme", el => el.value), "calmness");
    assert.match(await popup.$eval('#wikipedia-theme option[value="calmness"]', el => el.textContent), /legacy theme|以前のテーマ/);
    assert.equal(await popup.$('#wikipedia-theme option[value="nature"]'), null);
    await popup.select("#wikipedia-theme", "one-dark");
    await page.waitForSelector('html[data-cpa-wiki-theme="one-dark"]');
    await popup.reload();
    await popup.waitForSelector("#categoryTrigger:not([disabled])");
    assert.equal(await popup.$eval("#wikipedia-theme", el => el.value), "one-dark");
    assert.equal(await popup.$('#wikipedia-theme option[value="calmness"]'), null);
  });
  await t.test("脚注はテキストで表示しEscapeで閉じ、記事リンクを新規取得しない", async () => {
    const before = requests.length;
    await page.focus("#ref-link");
    await page.waitForSelector(".__cpa-wiki-reference");
    assert.match(await page.$eval(".__cpa-wiki-reference", (el) => el.textContent), /<img src=x/);
    assert.equal(await page.$(".__cpa-wiki-reference img"), null);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".__cpa-wiki-reference", { hidden: true });
    await page.hover("#article-link");
    assert.equal(requests.length, before);
  });
  await t.test("脚注から通常リンクへ移動しても撤去し、再入場とカードへの移動は保持する", async () => {
    const dispatch = (selector, type) => page.$eval(selector, (el, type) => el.dispatchEvent(new Event(type, { bubbles: true })), type);
    await page.evaluate(() => {
      const other = document.getElementById("ref-link").cloneNode(true);
      other.id = "other-ref-link";
      document.getElementById("ref-link").after(other);
    });
    for (const [enter, leave] of [["pointerover", "pointerout"], ["focusin", "focusout"]]) {
      await dispatch("#ref-link", enter);
      await page.waitForSelector(".__cpa-wiki-reference");
      await dispatch("#ref-link", leave);
      await dispatch("#article-link", enter);
      await page.waitForSelector(".__cpa-wiki-reference", { hidden: true, timeout: 1000 });
      await dispatch("#ref-link", enter);
      await dispatch("#ref-link", leave);
      await dispatch("#ref-link", enter);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 220)));
      assert.ok(await page.$(".__cpa-wiki-reference"));
      await dispatch("#ref-link", leave);
      await dispatch(".__cpa-wiki-reference", "pointerenter");
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 220)));
      assert.ok(await page.$(".__cpa-wiki-reference"));
      await dispatch(".__cpa-wiki-reference", "pointerleave");
      await dispatch("#other-ref-link", enter);
      await dispatch("#other-ref-link", leave);
      await dispatch("#ref-link", enter);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 220)));
      assert.equal(await page.$$eval(".__cpa-wiki-reference", els => els.length), 1);
      await page.keyboard.press("Escape");
    }
    await page.$eval("#other-ref-link", el => el.remove());
  });
  await t.test("同じ目次の見出し置換と切断した自動IDを再利用・復元する", async () => {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const toc = document.querySelector(".__cpa-wiki-toc");
      toc.open = false;
      window.__wikiTocBefore = toc;
      const old = document.getElementById("section-one");
      const replacement = old.cloneNode(true);
      replacement.style.marginTop = "1200px";
      old.replaceWith(replacement);
      const tail = document.createElement("div"); tail.id = "wiki-test-tail"; tail.style.height = "1500px";
      document.querySelector(".mw-parser-output").append(tail);
      window.scrollTo(0, window.scrollY + replacement.getBoundingClientRect().top - 100);
    });
    await page.waitForFunction(() => document.querySelector('.__cpa-wiki-toc a[aria-current="location"]')?.hash === "#section-one", { timeout: 1000 });
    assert.equal(await page.evaluate(() => document.querySelector(".__cpa-wiki-toc") === window.__wikiTocBefore && !window.__wikiTocBefore.open), true);
    await page.evaluate(() => {
      const heading = document.querySelector(".mw-parser-output h3");
      window.__wikiDetachedHeading = heading;
      window.__wikiHeadingParent = heading.parentNode;
      heading.remove();
    });
    await page.waitForFunction(() => !window.__wikiDetachedHeading.hasAttribute("id"), { timeout: 1000 });
    await page.evaluate(() => window.__wikiHeadingParent.append(window.__wikiDetachedHeading));
    await page.waitForFunction(() => window.__wikiDetachedHeading.id.startsWith("__cpa-wiki-section-"));
    await page.evaluate(() => { window.__wikiDetachedHeading.id = "site-owned-heading"; window.__wikiDetachedHeading.remove(); });
    await page.waitForFunction(() => !document.querySelector('.__cpa-wiki-toc a[href="#site-owned-heading"]'));
    assert.equal(await page.evaluate(() => window.__wikiDetachedHeading.id), "site-owned-heading");
    await page.evaluate(() => {
      window.__wikiDetachedHeading.removeAttribute("id");
      window.__wikiHeadingParent.append(window.__wikiDetachedHeading);
      document.getElementById("section-one").removeAttribute("style");
      document.getElementById("wiki-test-tail").remove();
    });
    await page.waitForFunction(() => window.__wikiDetachedHeading.id.startsWith("__cpa-wiki-section-"));
    for (let cycle = 0; cycle < 2; cycle++) {
      await popup.click("#wikipediaToggle");
      await page.waitForSelector("html.__cpa-wiki-active", { hidden: true });
      assert.equal(await page.evaluate(() => window.__wikiDetachedHeading.hasAttribute("id")), false);
      await popup.click("#wikipediaToggle");
      await page.waitForSelector(".__cpa-wiki-toc");
    }
    // 後続の本文完全一致確認へ、元の兄弟順で戻す。
    await page.evaluate(() => window.__wikiHeadingParent.querySelector("p").after(window.__wikiDetachedHeading));
  });
  await t.test("目次の現在節は画面上の順序が前後しても最後の適合見出しを選び、適合なしなら解除する", async () => {
    for (const [tops, expected] of [[[50, 600, 100], "#references"], [[500, 600, 700], null]]) {
      await page.evaluate(tops => {
        window.scrollTo(0, 0);
        for (const [index, heading] of [...document.querySelectorAll(".mw-parser-output h2, .mw-parser-output h3")].entries()) {
          heading.style.transform = "none";
          heading.style.transform = `translateY(${tops[index] - heading.getBoundingClientRect().top}px)`;
        }
        window.dispatchEvent(new Event("scroll"));
      }, tops);
      await page.waitForFunction(expected => (document.querySelector('.__cpa-wiki-toc a[aria-current="location"]')?.hash ?? null) === expected, {}, expected);
    }
    await page.evaluate(() => {
      for (const heading of document.querySelectorAll(".mw-parser-output h2, .mw-parser-output h3")) heading.removeAttribute("style");
      window.dispatchEvent(new Event("scroll"));
    });
  });
  await t.test("読込済み画像を拡大し、EscapeとOFFで閉じる", async () => {
    const before = requests.length;
    await page.click("#file-link");
    await page.waitForSelector("dialog[open].__cpa-wiki-image-dialog");
    assert.deepEqual(await page.$eval("dialog canvas", (el) => [el.width, el.height, el.getAttribute("aria-label")]), [240, 160, "Test image"]);
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog", { hidden: true });
    assert.equal(requests.length, before);
    assert.equal(await page.evaluate(() => document.activeElement.id), "file-link");
    await page.keyboard.press("Enter");
    await page.waitForSelector("dialog[open]");
    await worker.evaluate(() => chrome.storage.local.set({ wikipediaFeatures: { imageViewer: false } }));
    await page.waitForSelector("dialog", { hidden: true });
  });
  await t.test("動的な見出しと狭い画面・RTLに対応する", async () => {
    await page.evaluate(() => { const h = document.createElement("h2"); h.id = "dynamic"; h.textContent = "Dynamic section"; document.querySelector(".mw-parser-output").append(h); });
    await page.waitForFunction(() => document.querySelectorAll(".__cpa-wiki-toc a").length === 4);
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.dir = "rtl"; document.querySelector(".__cpa-wiki-toc").open = false; });
    await page.click(".__cpa-wiki-toc summary");
    await page.click('.__cpa-wiki-toc a[href="#dynamic"]');
    assert.equal(await page.$eval(".__cpa-wiki-toc", (el) => el.open), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, "wikipedia-mobile.png") });
    await page.evaluate(() => { document.getElementById("dynamic").remove(); document.documentElement.removeAttribute("dir"); });
    await page.setViewport({ width: 1600, height: 1000 });
  });
  await t.test("編集モードでは無効化し、記事へ戻ると再適用する", async () => {
    await page.$eval("#edit-article", el => el.addEventListener("click", event => event.preventDefault()));
    await page.$eval(".__cpa-wiki-actions", el => { el.open = true; });
    await page.click("#edit-article");
    // 編集開始を遅らせた間の設定更新や、開始前のキャンセルで構造を失わない。
    await worker.evaluate(async () => {
      const saved = await chrome.storage.local.get("wikipediaAppearance");
      await chrome.storage.local.set({ wikipediaAppearance: { ...saved.wikipediaAppearance, lineHeight: 1.75 } });
    });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--cpa-wiki-line-height").trim() === "1.75");
    assert.ok(await page.$(".__cpa-wiki-shell"));
    await page.evaluate(() => document.documentElement.classList.add("ve-active"));
    await page.waitForSelector(".__cpa-wiki-shell", { hidden: true });
    await worker.evaluate(async () => {
      const saved = await chrome.storage.local.get("wikipediaAppearance");
      await chrome.storage.local.set({ wikipediaAppearance: { ...saved.wikipediaAppearance, lineHeight: 1.85 } });
    });
    await page.evaluate(() => document.documentElement.classList.remove("ve-active"));
    await page.waitForSelector(".__cpa-wiki-shell");
    await page.evaluate(() => document.body.classList.replace("action-view", "action-edit"));
    await page.waitForSelector("html.__cpa-wiki-active", { hidden: true });
    await page.evaluate(() => document.body.classList.replace("action-edit", "action-view"));
    await page.waitForSelector("html.__cpa-wiki-active");
  });
  await t.test("OFFで本文・見出しID・元の目次・スタイルを復元しリロード後もOFF", async () => {
    await popup.reload();
    await popup.waitForSelector("#categoryTrigger:not([disabled])");
    assert.equal(await popup.$eval("#categoryName", el => el.textContent), "Wikipedia");
    await popup.click("#wikipediaToggle");
    await page.waitForSelector("html.__cpa-wiki-active", { hidden: true });
    assert.equal(await page.$eval("#mw-content-text", (el) => el.innerHTML), original);
    assert.equal((await templateColors(page)).path.background, "rgb(232, 238, 255)");
    assert.equal((await templateColors(page)).notice.background, "rgb(251, 251, 251)");
    assert.notEqual(await page.$eval("#mw-panel-toc", (el) => getComputedStyle(el).display), "none");
    assert.equal(await page.$('[class^="__cpa-wiki-"]'), null);
    await page.reload();
    assert.equal(await page.$("html.__cpa-wiki-active"), null);
    assert.deepEqual(errors, []);
  });
  await t.test("標準目次・固定メニュー・置換ノード・初期ハッシュを保持する", async () => {
    await worker.evaluate(() => chrome.storage.local.set({ wikipediaEnabled: true, wikipediaFeatures: {}, wikipediaAppearance: { theme: "one-light" } }));
    const isolated = await browser.newPage();
    t.after(() => { if (!isolated.isClosed()) return isolated.close(); });
    await isolated.setViewport({ width: 390, height: 844 });
    await isolated.setRequestInterception(true);
    isolated.on("request", request => {
      if (request.isNavigationRequest() && request.frame() === isolated.mainFrame()) request.respond({ status: 200, contentType: "text/html", body: fixture });
      else request.respond({ status: 404, body: "" });
    });
    await isolated.goto("https://en.wikipedia.org/wiki/Vuora_test#article-infobox");
    await isolated.waitForFunction(() => document.querySelector(".__cpa-wiki-facts")?.open);
    // Wikipedia が ULS を無効にした場合の標準リスト。初期化タイミングに依存せず再現する。
    await isolated.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = ".vector-dropdown{position:relative}.vector-dropdown-content{position:absolute;inset-block-start:100%;inset-inline-end:0}.client-js .mw-portlet-lang .vector-dropdown-content{display:none}";
      document.head.append(style); document.documentElement.classList.add("client-js");
      document.body.classList.add("mw-interlanguage-selector-disabled");
      const menu = document.createElement("div"); menu.id = "p-lang-btn"; menu.className = "mw-portlet-lang vector-dropdown";
      menu.innerHTML = '<input id="p-lang-btn-checkbox" type="checkbox"><label for="p-lang-btn-checkbox">Languages</label><div class="vector-dropdown-content"><a class="interlanguage-link-target" hreflang="en" href="https://en.wikipedia.org/wiki/Cat">English</a></div>';
      document.querySelector(".vector-page-titlebar").append(menu);
      const sticky = document.createElement("button"); sticky.id = "p-lang-btn-sticky-header"; sticky.textContent = "Languages";
      document.body.append(sticky);
    });
    for (const readableLayout of [true, false, true]) {
      await worker.evaluate(value => chrome.storage.local.set({ wikipediaFeatures: { readableLayout: value } }), readableLayout);
      await isolated.waitForFunction(value => document.documentElement.classList.contains("__cpa-wiki-readable") === value, {}, readableLayout);
      await isolated.click('label[for="p-lang-btn-checkbox"]');
      assert.ok(await isolated.$eval('#p-lang-btn a', el => el.getClientRects().length > 0));
      await isolated.click('label[for="p-lang-btn-checkbox"]');
      assert.equal(await isolated.$eval('#p-lang-btn a', el => el.getClientRects().length), 0);
    }
    await isolated.click("#p-lang-btn-sticky-header");
    assert.ok(await isolated.$eval('#p-lang-btn a', el => el.getClientRects().length > 0), "固定ヘッダーからも同じ標準一覧を開く");
    await isolated.keyboard.press("Escape");
    assert.equal(await isolated.$eval("#p-lang-btn-checkbox", el => el.checked), false);
    assert.equal(await isolated.evaluate(() => document.activeElement.id), "p-lang-btn-checkbox");
    await isolated.setViewport({ width: 1280, height: 720 });
    await isolated.evaluate(() => {
      document.querySelector(".vector-page-titlebar").style.paddingTop = "800px";
      const list = document.querySelector("#p-lang-btn .vector-dropdown-content");
      for (let i = 0; i < 80; i++) {
        const row = document.createElement("div"); row.textContent = "Language " + i; list.append(row);
      }
    });
    await isolated.click("#p-lang-btn-sticky-header");
    const bounds = await isolated.$eval("#p-lang-btn .vector-dropdown-content", el => { el.scrollTop = el.scrollHeight; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, end: el.scrollTop + el.clientHeight >= el.scrollHeight - 1 }; });
    assert.ok(bounds.top >= 0 && bounds.bottom <= 720 && bounds.end, "長い見出しでも一覧の末尾まで表示・スクロールできる: " + JSON.stringify(bounds));
    await isolated.keyboard.press("Escape");
    await isolated.evaluate(() => { document.querySelector(".vector-page-titlebar").style.paddingTop = ""; });
    await isolated.evaluate(() => document.body.classList.remove("mw-interlanguage-selector-disabled"));
    await isolated.click("#p-lang-btn-sticky-header");
    assert.equal(await isolated.$eval("#p-lang-btn-checkbox", el => el.checked), false, "ULS有効時は固定ヘッダーも変更しない");
    await isolated.click('label[for="p-lang-btn-checkbox"]');
    assert.equal(await isolated.$eval('#p-lang-btn a', el => el.getClientRects().length), 0, "ULS有効時は標準リストを重ねない");
    await isolated.click('label[for="p-lang-btn-checkbox"]');
    await worker.evaluate(() => chrome.storage.local.set({ wikipediaFeatures: { stickyContents: false } }));
    await isolated.waitForFunction(() => !document.querySelector(".__cpa-wiki-toc") && document.querySelector(".__cpa-wiki-site-menu")?.open);
    assert.ok(await isolated.$eval("#mw-panel-toc", el => el.getClientRects().length > 0));
    await isolated.evaluate(() => {
      const menu = document.createElement("nav"); menu.id = "test-pinned-menu"; menu.textContent = "Pinned menu";
      document.querySelector("#vector-main-menu-pinned-container").append(menu);
    });
    await worker.evaluate(() => chrome.storage.local.set({ wikipediaFeatures: {} }));
    await isolated.waitForFunction(() => !!document.querySelector(".__cpa-wiki-toc") && document.querySelector(".__cpa-wiki-site-menu")?.open);
    assert.ok(await isolated.$eval("#test-pinned-menu", el => el.getClientRects().length > 0));
    await isolated.evaluate(html => {
      const fresh = new window.DOMParser().parseFromString(html, "text/html");
      const content = document.importNode(fresh.getElementById("content"), true);
      document.getElementById("content").replaceWith(content);
      const footer = document.getElementById("footer").cloneNode(true);
      footer.textContent = "Updated footer"; document.getElementById("footer").replaceWith(footer);
      window.__replacedContent = content; window.__replacedFooter = footer;
    }, fixture);
    await isolated.waitForFunction(() => document.querySelector(".__cpa-wiki-shell #content") === window.__replacedContent && !!document.querySelector(".__cpa-wiki-facts"));
    await isolated.evaluate(() => {
      const table = document.getElementById("article-infobox").cloneNode(true);
      table.id = "updated-infobox";
      table.querySelector("td").textContent = "Updated information";
      document.getElementById("article-infobox").replaceWith(table); window.__replacedTable = table;
    });
    await worker.evaluate(() => chrome.storage.local.set({ wikipediaFeatures: { readableLayout: false } }));
    await isolated.waitForSelector(".__cpa-wiki-shell", { hidden: true });
    assert.equal(await isolated.evaluate(() => [window.__replacedContent, window.__replacedFooter, window.__replacedTable].every(node => node.isConnected && document.getElementById(node.id) === node)), true);
    await isolated.evaluate(() => document.body.classList.replace("skin-vector-2022", "skin-vector"));
    await worker.evaluate(() => chrome.storage.local.set({ wikipediaFeatures: {} }));
    await isolated.waitForSelector("html.__cpa-wiki-active");
    assert.equal(await isolated.$(".__cpa-wiki-shell"), null, "旧Vectorでは元の構造を維持する");
    await isolated.close();
  });
  if (process.env.VUORA_LIVE_WIKIPEDIA === "1") {
    await t.test("実サイト: 日本語・英語記事とモバイル幅で表示と画像操作を確認", async () => {
      await worker.evaluate(() => chrome.storage.local.set({ wikipediaEnabled: true, wikipediaFeatures: { imageViewer: true }, wikipediaAppearance: {
        theme: "one-light", font: "line-seed-jp", headingFont: "serif", fontSize: 18, contentWidth: 860,
        coverImage: "show", borderRadius: "rounded", articleStyle: "full", linkStyle: "underline",
      } }));
      const live = await browser.newPage();
      live.on("pageerror", error => console.log("Wikipedia script: " + error.message));
      await live.setViewport({ width: 1920, height: 1080 });
      await live.goto("https://ja.wikipedia.org/wiki/ネコ", { waitUntil: "load", timeout: 30000 });
      await live.waitForSelector(".__cpa-wiki-toc a");
      const openArticleActions = async () => {
        const actions = await live.$(".__cpa-wiki-actions");
        if (actions && !await actions.evaluate(el => el.open)) await live.click(".__cpa-wiki-actions > summary");
      };
      assert.equal(await live.$eval("body", el => getComputedStyle(el).backgroundColor), "rgb(250, 250, 250)");
      await live.waitForFunction(() => [...document.querySelectorAll("nav.vector-appearance-landmark")].some(el => el.getClientRects().length > 0));
      const baseWidth = await live.$eval("#mw-content-text", el => el.getBoundingClientRect().width);
      const freedWidth = await live.$eval("#content", el => document.querySelector(".vector-column-end").getBoundingClientRect().width + parseFloat(getComputedStyle(el).columnGap));
      await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get("wikipediaFeatures");
        await chrome.storage.local.set({ wikipediaFeatures: { ...stored.wikipediaFeatures, hideAppearance: true } });
      });
      await live.waitForFunction(() => document.documentElement.classList.contains("__cpa-wiki-hide-appearance")
        && [...document.querySelectorAll("nav.vector-appearance-landmark")].every(el => getComputedStyle(el).display === "none"));
      const expandedWidth = await live.$eval("#mw-content-text", el => el.getBoundingClientRect().width);
      assert.ok(Math.abs(expandedWidth - baseWidth - freedWidth) < 2, "表示パネルと間隔の分を本文へ広げる");
      console.log(`本文幅: パネル表示 ${baseWidth}px → 非表示 ${expandedWidth}px（解放 ${freedWidth}px）`);
      const openLivePopup = async () => {
        for (const target of browser.targets().filter(item => item.url() === extensionOrigin + "/src/popup/popup.html")) {
          const opened = await target.asPage();
          if (opened && !opened.isClosed()) await opened.close();
        }
        await live.bringToFront();
        await worker.evaluate(() => chrome.action.openPopup());
        const opened = await browser.waitForTarget(item => item.url() === extensionOrigin + "/src/popup/popup.html");
        popup = await opened.asPage();
        await popup.waitForSelector("#categoryTrigger:not([disabled])");
      };
      await openLivePopup();
      await popup.click("#wikipedia-feature-narrowContent");
      await live.waitForFunction(() => document.documentElement.classList.contains("__cpa-wiki-narrow"));
      assert.ok(Math.abs(await live.$eval("#mw-content-text", el => el.getBoundingClientRect().width) - baseWidth) < 2, "本文を指定幅へ戻す");
      await popup.focus("#wikipedia-lineHeight");
      await popup.keyboard.press("Home");
      for (let i = 0; i < 4; i++) await popup.keyboard.press("ArrowRight");
      await live.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.querySelector("#mw-content-text p")).lineHeight) - 27) < .1);
      await live.screenshot({ path: path.join(output, "wikipedia-live-narrow.png") });
      await live.reload({ waitUntil: "load" });
      await live.waitForSelector("html.__cpa-wiki-narrow");
      assert.ok(Math.abs(await live.$eval("#mw-content-text", el => el.getBoundingClientRect().width) - baseWidth) < 2, "再読込しても細い本文幅を保持する");
      assert.ok(Math.abs(await live.$eval("#mw-content-text p", el => parseFloat(getComputedStyle(el).lineHeight)) - 27) < .1, "実記事の行間も復元する");
      await openLivePopup();
      await popup.click("#wikipedia-feature-narrowContent");
      await live.waitForFunction(() => !document.documentElement.classList.contains("__cpa-wiki-narrow"));
      assert.ok(Math.abs(await live.$eval("#mw-content-text", el => el.getBoundingClientRect().width) - expandedWidth) < 2);
      await openArticleActions();
      await live.click('label[for="vector-page-tools-dropdown-checkbox"]');
      await live.waitForSelector('button[data-event-name="pinnable-header.vector-page-tools.pin"]', { visible: true });
      await live.click('button[data-event-name="pinnable-header.vector-page-tools.pin"]');
      await live.waitForFunction(() => document.querySelector("#vector-page-tools-pinned-container")?.children.length > 0);
      assert.ok(await live.$eval("#vector-page-tools-pinned-container", el => el.getClientRects().length > 0), "ページツールを隠さない");
      assert.ok(Math.abs(await live.$eval("#mw-content-text", el => el.getBoundingClientRect().width) - baseWidth) < 2, "他のツールがある列を本文に重ねない");
      await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get("wikipediaFeatures");
        await chrome.storage.local.set({ wikipediaFeatures: { ...stored.wikipediaFeatures, readableLayout: false, narrowContent: true } });
      });
      await live.waitForFunction(() => !document.documentElement.classList.contains("__cpa-wiki-readable") && document.documentElement.classList.contains("__cpa-wiki-narrow"));
      for (const contentWidth of [680, 1200]) {
        await worker.evaluate(async value => {
          const stored = await chrome.storage.local.get("wikipediaAppearance");
          await chrome.storage.local.set({ wikipediaAppearance: { ...stored.wikipediaAppearance, contentWidth: value } });
        }, contentWidth);
        await live.waitForFunction(value => Math.abs(document.querySelector("#mw-content-text").getBoundingClientRect().width - value) < 2, {}, contentWidth);
      }
      await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get(["wikipediaFeatures", "wikipediaAppearance"]);
        await chrome.storage.local.set({ wikipediaFeatures: { ...stored.wikipediaFeatures, readableLayout: true, narrowContent: false },
          wikipediaAppearance: { ...stored.wikipediaAppearance, contentWidth: 860 } });
      });
      await live.waitForFunction(() => document.documentElement.classList.contains("__cpa-wiki-readable") && !document.documentElement.classList.contains("__cpa-wiki-narrow"));
      await live.click('button[data-event-name="pinnable-header.vector-page-tools.unpin"]');
      await live.waitForFunction(() => document.querySelector("#vector-page-tools-pinned-container")?.children.length === 0);
      await live.screenshot({ path: path.join(output, "wikipedia-live-panel-hidden.png") });
      await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get("wikipediaFeatures");
        await chrome.storage.local.set({ wikipediaFeatures: { ...stored.wikipediaFeatures, hideAppearance: false } });
      });
      await live.waitForFunction(() => !document.documentElement.classList.contains("__cpa-wiki-hide-appearance")
        && [...document.querySelectorAll("nav.vector-appearance-landmark")].some(el => el.getClientRects().length > 0));
      await openArticleActions();
      await live.click('button[data-event-name="pinnable-header.vector-appearance.unpin"]');
      await live.waitForFunction(() => document.querySelector("#vector-appearance-dropdown")?.getClientRects().length > 0);
      await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get("wikipediaFeatures");
        await chrome.storage.local.set({ wikipediaFeatures: { ...stored.wikipediaFeatures, hideAppearance: true } });
      });
      await live.waitForFunction(() => document.documentElement.classList.contains("__cpa-wiki-hide-appearance")
        && document.querySelector("#vector-appearance-dropdown").getClientRects().length === 0);
      await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get("wikipediaFeatures");
        await chrome.storage.local.set({ wikipediaFeatures: { ...stored.wikipediaFeatures, hideAppearance: false } });
      });
      await live.waitForFunction(() => document.querySelector("#vector-appearance-dropdown").getClientRects().length > 0);
      if (!await live.$eval("#vector-appearance-dropdown-checkbox", el => el.checked)) await live.click('label[for="vector-appearance-dropdown-checkbox"]');
      await live.waitForSelector('button[data-event-name="pinnable-header.vector-appearance.pin"]', { visible: true });
      await live.click('button[data-event-name="pinnable-header.vector-appearance.pin"]');
      await live.waitForFunction(() => document.querySelector("#vector-appearance-pinned-container #vector-appearance")?.getClientRects().length > 0);
      if (await live.$eval(".__cpa-wiki-actions", el => el.open)) await live.click(".__cpa-wiki-actions > summary");
      assert.ok(await live.$eval("#mw-content-text", (el) => el.textContent.length > 1000));
      assert.equal(await live.evaluate(async () => (await document.fonts.load('400 18px "__cpa-wiki-line-seed-jp"', "日本語の本文")).length), 1, "実 Wikipedia でも同梱フォントを読める");
      assert.equal(await live.$(".__cpa-wiki-cover, .__cpa-wiki-gallery"), null);
      await live.screenshot({ path: path.join(output, "wikipedia-live-ja.png") });
      await live.click(".__cpa-wiki-facts > summary");
      await live.click('#mw-content-text a.mw-file-description:has(img[src*="Cat_poster"])');
      await live.waitForSelector("dialog[open].__cpa-wiki-image-dialog");
      await live.keyboard.press("Escape");
      await worker.evaluate(async () => {
        const saved = await chrome.storage.local.get("wikipediaAppearance");
        await chrome.storage.local.set({ wikipediaAppearance: { ...saved.wikipediaAppearance, articleStyle: "pictures" } });
      });
      await live.waitForSelector('html[data-cpa-wiki-article-style="pictures"]');
      assert.notEqual(await live.$eval("#mw-content-text p", el => getComputedStyle(el).display), "none");
      assert.notEqual(await live.$eval("#mw-content-text figure", el => getComputedStyle(el).display), "none");
      assert.notEqual(await live.$eval(".__cpa-wiki-toc", el => getComputedStyle(el).display), "none");
      await live.screenshot({ path: path.join(output, "wikipedia-live-pictures.png") });
      await worker.evaluate(async () => {
        const saved = await chrome.storage.local.get("wikipediaAppearance");
        await chrome.storage.local.set({ wikipediaAppearance: { ...saved.wikipediaAppearance, articleStyle: "text" } });
      });
      await live.waitForFunction(() => document.documentElement.getAttribute("data-cpa-wiki-article-style") === "text"
        && getComputedStyle(document.querySelector("#mw-content-text figure")).display === "none");
      assert.ok(await live.$eval("#mw-content-text", el => el.textContent.length > 1000));
      await live.setViewport({ width: 1920, height: 1080 });
      for (const width of [680, 860, 1200]) {
        await worker.evaluate(async value => {
          const saved = await chrome.storage.local.get("wikipediaAppearance");
          await chrome.storage.local.set({ wikipediaAppearance: { ...saved.wikipediaAppearance, contentWidth: value } });
        }, width);
        await live.waitForFunction(value => getComputedStyle(document.documentElement).getPropertyValue("--cpa-wiki-width").trim() === `${value}px`, {}, width);
        const measured = await live.$eval("#mw-content-text", el => Math.round(el.getBoundingClientRect().width));
        assert.ok(Math.abs(measured - width) <= 2, `実記事の本文幅: ${width}px → ${measured}px`);
      }
      await worker.evaluate(() => chrome.storage.local.set({ wikipediaAppearance: { theme: "one-dark", font: "sans", fontSize: 18, contentWidth: 960 } }));
      await live.waitForSelector('html[data-cpa-wiki-theme="one-dark"]');
      assert.equal(await live.$eval("body", el => getComputedStyle(el).backgroundColor), "rgb(40, 44, 52)");
      assert.equal(await live.$eval("#vector-main-menu-dropdown .mw-ui-icon-menu", el => getComputedStyle(el).backgroundColor), "rgb(171, 178, 191)", "暗色テーマでもメニューアイコンが読める");
      const contrast = await live.$eval(".infobox th", (el) => {
        const luminance = (color) => {
          const rgb = color.match(/[\d.]+/g).slice(0, 3).map(v => { const c = Number(v) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const style = getComputedStyle(el);
        const a = luminance(style.color), b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      assert.ok(contrast >= 4.5, "暗色 infobox の見出し文字に必要なコントラストを保つ");
      await live.screenshot({ path: path.join(output, "wikipedia-live-dark.png") });
      await worker.evaluate(() => chrome.storage.local.set({ wikipediaAppearance: { theme: "one-light", font: "sans", fontSize: 18, contentWidth: 960 } }));
      await live.goto("https://en.wikipedia.org/wiki/Cat", { waitUntil: "load", timeout: 30000 });
      await live.waitForSelector(".__cpa-wiki-toc a");
      await live.setViewport({ width: 390, height: 844 });
      await live.waitForFunction(() => !document.querySelector(".__cpa-wiki-toc").open);
      await live.screenshot({ path: path.join(output, "wikipedia-live-en-mobile.png") });
      const overflow = await live.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, elements: [...document.querySelectorAll("body *")].filter(el => { const r = el.getBoundingClientRect(); return r.width > innerWidth && getComputedStyle(el).visibility !== "hidden"; }).slice(0,12).map(el => ({ tag: el.tagName, id: el.id, class: el.className, width: el.getBoundingClientRect().width })) }));
      if (overflow.scroll > overflow.width) console.log("横幅超過: " + JSON.stringify(overflow));
      assert.equal(overflow.scroll <= overflow.width, true);
      await live.bringToFront();
      await live.evaluate(async () => { await window.mw.loader.using("skins.vector.js"); await new Promise(resolve => window.jQuery(resolve)); });
      await live.click(".search-toggle");
      await live.waitForSelector('.vector-search-box input[role="combobox"]', { visible: true });
      await live.type('.vector-search-box input[role="combobox"]', "Dog");
      await live.waitForSelector(".cdx-menu-item", { visible: true });
      assert.ok(await live.$eval('.vector-search-box input[role="combobox"]', el => {
        const input = el.getBoundingClientRect(), button = document.querySelector(".cdx-search-input__end-button").getBoundingClientRect();
        return input.right <= button.left + 2 && button.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
      }), "スマホでも検索欄と送信ボタンが重ならず、候補を画面内で表示できる");
      await live.keyboard.press("Escape");
      for (const narrowContent of [false, true]) {
        await worker.evaluate(value => chrome.storage.local.set({ wikipediaFeatures: { hideAppearance: true, narrowContent: value } }), narrowContent);
        await live.waitForFunction(value => document.documentElement.classList.contains("__cpa-wiki-hide-appearance") && document.documentElement.classList.contains("__cpa-wiki-narrow") === value, {}, narrowContent);
        assert.equal(await live.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "狭い画面でも本文幅の切替ではみ出さない");
      }
      await live.setViewport({ width: 1600, height: 1000 });
      await live.bringToFront();
      await live.waitForFunction(() => document.visibilityState === "visible");
      await live.goto("https://ja.wikipedia.org/wiki/ネコ", { waitUntil: "networkidle2" });
      await live.waitForSelector(".__cpa-wiki-shell");
      // 実際のボタン初期化を待つ。entrypoints は登録用モジュールで準備完了を表さない。
      await live.evaluate(async () => { await window.mw.loader.using("ext.uls.interface"); await new Promise(resolve => window.jQuery(resolve)); });
      const visibleEnglish = () => [...document.querySelectorAll('#p-lang-btn a[hreflang="en"], .uls-rewrite__language-item a[hreflang="en"]')].find(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
      for (let round = 0; round < 8; round++) {
        await live.setViewport({ width: round < 4 ? 1600 : 390, height: round < 4 ? 1000 : 844 });
        if (round === 4) {
          await worker.evaluate(() => chrome.storage.local.set({ wikipediaEnabled: false }));
          await live.waitForSelector("html.__cpa-wiki-active", { hidden: true });
          await worker.evaluate(() => chrome.storage.local.set({ wikipediaEnabled: true }));
          // サイトの配信条件に依存させず、失敗時に観測した ULS 無効状態も実記事上で通す。
          await live.evaluate(() => {
            document.body.classList.add("mw-interlanguage-selector-disabled");
            document.querySelectorAll("#p-lang-btn-checkbox, #p-lang-btn-sticky-header").forEach(el => el.classList.remove("mw-interlanguage-selector"));
          });
        }
        const settings = { theme: round % 2 ? "nord" : "one-light", contentWidth: 680 + round * 40, lineHeight: 1.4 + round * .05 };
        await worker.evaluate(async ({ round, settings }) => {
          const stored = await chrome.storage.local.get("wikipediaAppearance");
          await chrome.storage.local.set({ wikipediaAppearance: { ...stored.wikipediaAppearance, ...settings }, wikipediaFeatures: {
            readableLayout: round % 2 === 0, stickyContents: round % 3 !== 0, hideAppearance: round % 2 === 0, narrowContent: round % 2 !== 0,
          } });
        }, { round, settings });
        await live.waitForFunction(({ round, settings }) => document.documentElement.getAttribute("data-cpa-wiki-theme") === settings.theme
          && document.documentElement.classList.contains("__cpa-wiki-readable") === (round % 2 === 0), {}, { round, settings });
        await live.click("#p-lang-btn .vector-dropdown-label");
        await live.waitForFunction(visibleEnglish);
        if (await live.$eval("body", el => el.classList.contains("mw-interlanguage-selector-disabled"))) {
          const menu = await live.$eval("#p-lang-btn .vector-dropdown-content", el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, viewport: innerWidth }));
          assert.ok(menu.left >= 0 && menu.right <= menu.viewport, "標準言語一覧の左右が画面内に収まる");
        }
        if ([0, 4].includes(round)) await live.screenshot({ path: path.join(output, `wikipedia-language-${round < 4 ? "desktop" : "mobile"}.png`) });
        assert.equal(await live.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "言語一覧が狭い画面からはみ出さない");
        await live.keyboard.press("Escape");
        await live.waitForFunction(() => ![...document.querySelectorAll('#p-lang-btn a[hreflang="en"], .uls-rewrite__language-item a[hreflang="en"]')].some(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden"));
      }
      console.log("同じ文書・タブで設定8回変更、言語メニュー8回開閉、マスターOFF/ONを確認");
      await live.setViewport({ width: 1600, height: 1000 });
      await worker.evaluate(() => chrome.storage.local.set({ wikipediaFeatures: {} }));
      await live.waitForSelector(".__cpa-wiki-shell");
      for (const key of ["Enter", "Space"]) {
        await live.focus("#p-lang-btn-checkbox");
        await live.keyboard.press(key);
        await live.waitForFunction(visibleEnglish);
        if (await live.$eval("body", el => el.classList.contains("mw-interlanguage-selector-disabled"))) {
          assert.equal(await live.$eval("#p-lang-btn-checkbox", el => el.getAttribute("aria-expanded")), "true");
          await live.keyboard.press("Tab");
          assert.equal(await live.evaluate(() => document.activeElement.matches("#p-lang-btn a")), true, "キーボードで一覧のリンクへ移動できる");
          await live.focus("#searchInput");
          await live.waitForFunction(() => document.querySelector("#p-lang-btn-checkbox").getAttribute("aria-expanded") === "false");
        } else await live.keyboard.press("Escape");
      }
      await live.click("#p-lang-btn .vector-dropdown-label");
      let english;
      try {
        english = await live.waitForFunction(visibleEnglish, { timeout: 6000 });
      } catch (error) {
        await live.screenshot({ path: path.join(output, "wikipedia-language-failure.png") });
        console.log("言語メニュー状態: " + JSON.stringify(await live.evaluate(() => ({ checked: document.querySelector("#p-lang-btn-checkbox")?.checked, menus: [...document.querySelectorAll('[class*="uls-rewrite"], .uls-menu')].filter(el => /menu|language-list/.test(el.className)).map(el => ({ class: el.className, display: getComputedStyle(el).display, width: el.getBoundingClientRect().width })), links: [...document.querySelectorAll('a[hreflang="en"]')].map(el => ({ html: el.outerHTML, width: el.getBoundingClientRect().width })) }))));
        throw error;
      }
      await Promise.all([live.waitForNavigation({ waitUntil: "load" }), english.asElement().click()]);
      await live.waitForSelector(".__cpa-wiki-shell");
      assert.match(live.url(), /en\.wikipedia\.org\/wiki\/Cat/);
      await live.click("#searchInput");
      await live.type("#searchInput", "Dog", { delay: 60 });
      await live.waitForFunction(() => document.querySelector(".cdx-menu-item")?.textContent.trim().startsWith("Dog"));
      await live.keyboard.press("ArrowDown");
      await Promise.all([live.waitForNavigation({ waitUntil: "load" }), live.keyboard.press("Enter")]);
      await live.waitForSelector(".__cpa-wiki-shell");
      assert.equal(await live.$eval("#firstHeading", el => el.textContent.trim()), "Dog", "検索候補から記事へ移動できる");
      await live.click('label[for="vector-main-menu-dropdown-checkbox"]');
      await live.waitForSelector('button[data-event-name="pinnable-header.vector-main-menu.pin"]', { visible: true });
      await live.click('button[data-event-name="pinnable-header.vector-main-menu.pin"]');
      await live.waitForFunction(() => document.querySelector("#vector-main-menu-pinned-container")?.children.length > 0 && document.querySelector(".__cpa-wiki-site-menu")?.open);
      assert.ok(await live.$eval("#vector-main-menu-pinned-container", el => el.getClientRects().length > 0));
      await live.click('button[data-event-name="pinnable-header.vector-main-menu.unpin"]');
      await live.waitForFunction(() => document.querySelector("#vector-main-menu-pinned-container")?.children.length === 0);
      await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get("wikipediaFeatures");
        await chrome.storage.local.set({ wikipediaFeatures: { ...stored.wikipediaFeatures, stickyContents: false } });
      });
      await live.waitForFunction(() => !document.querySelector(".__cpa-wiki-toc") && document.querySelector(".__cpa-wiki-site-menu")?.open);
      assert.ok(await live.$eval("#mw-panel-toc", el => el.getClientRects().length > 0), "独自目次OFFでも標準目次を利用できる");
      await openArticleActions();
      const editLink = await live.$("#ca-edit a, #ca-viewsource a");
      assert.ok(editLink, "標準の編集・ソース表示リンクを残す");
      await editLink.click();
      await live.waitForSelector("#wpTextbox1, .ve-init-mw-desktopArticleTarget", { visible: true });
      await live.waitForSelector(".__cpa-wiki-shell", { hidden: true });
      await live.goto("https://en.wikipedia.org/wiki/Dog", { waitUntil: "load" });
      await live.waitForSelector(".__cpa-wiki-shell");
      await live.goto("https://en.wikipedia.org/wiki/Cat?useskin=vector", { waitUntil: "load" });
      await live.waitForSelector("html.__cpa-wiki-active");
      assert.equal(await live.$(".__cpa-wiki-shell"), null);
      assert.ok(await live.$eval("#searchform", el => el.getClientRects().length > 0));
      await worker.evaluate(() => chrome.storage.local.set({ wikipediaEnabled: false }));
      await live.waitForSelector("html.__cpa-wiki-active", { hidden: true });
      await live.close();
    });
    await t.test("実サイト: FFVIII の記事案内と注意ボックスがテーマへ追従し、OFFで復元する", async () => {
      await worker.evaluate(() => chrome.storage.local.set({ wikipediaEnabled: false }));
      const article = await browser.newPage();
      t.after(() => { if (!article.isClosed()) return article.close(); });
      await article.setViewport({ width: 1706, height: 956 });
      await article.goto("https://ja.wikipedia.org/wiki/ファイナルファンタジーVIII", { waitUntil: "load" });
      await article.waitForSelector(".pathnavbox");
      const original = await templateColors(article);
      const href = await article.$eval(".pathnavbox a", el => el.href);
      for (const theme of ["one-dark", "one-light", "nord"]) {
        await worker.evaluate(theme => chrome.storage.local.set({ wikipediaEnabled: true, wikipediaFeatures: {}, wikipediaAppearance: { theme } }), theme);
        await article.waitForSelector(`html[data-cpa-wiki-theme="${theme}"]`);
        const layout = await article.evaluate(() => {
          const facts = document.querySelector(".__cpa-wiki-facts");
          return { open: facts.open, float: getComputedStyle(facts).float, width: facts.getBoundingClientRect().width,
            articleWidth: document.querySelector("#mw-content-text").getBoundingClientRect().width,
            introWidth: document.querySelector(".mw-parser-output p").getBoundingClientRect().width };
        });
        assert.equal(layout.open, false);
        assert.equal(layout.float, "none");
        assert.ok(Math.abs(layout.width - layout.articleWidth) < 2 && Math.abs(layout.introWidth - layout.articleWidth) < 2, "FFVIII の基本情報と本文は横並びにしない");
        await article.click(".__cpa-wiki-facts > summary");
        assert.ok(await article.$eval(".__cpa-wiki-facts > table", el => Math.abs(el.getBoundingClientRect().width - document.querySelector("#mw-content-text").getBoundingClientRect().width) < 3), "開いた基本情報も本文全幅を使う");
        assert.ok(await article.$eval(".__cpa-wiki-facts-compact > table > tbody > tr:has(> th)", el => el.getBoundingClientRect().width < document.querySelector(".__cpa-wiki-facts").getBoundingClientRect().width * .6), "項目は全幅に引き伸ばさず段組みで詰める");
        if (theme === "one-dark") {
          await article.$eval(".__cpa-wiki-facts", el => el.scrollIntoView({ block: "start" }));
          await article.screenshot({ path: path.join(output, "wikipedia-facts-compact.png") });
          await article.setViewport({ width: 390, height: 844 });
          assert.ok(await article.$eval(".__cpa-wiki-facts-compact > table > tbody > tr:has(> th)", el => el.getBoundingClientRect().width > document.querySelector(".__cpa-wiki-facts").getBoundingClientRect().width * .85), "スマホでは基本情報を一段にする");
          assert.ok(await article.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await article.screenshot({ path: path.join(output, "wikipedia-facts-compact-mobile.png") });
          await article.setViewport({ width: 1706, height: 956 });
        }
        await article.click(".__cpa-wiki-facts > summary");
        const colors = await templateColors(article);
        assert.ok(colors.navigation.length >= 3, "関連記事・典拠管理・カテゴリを実記事で確認する");
        assert.ok(colors.navigationTitles.length >= 2, "シリーズ名と典拠管理の内側のタイトルも確認する");
        for (const title of colors.navigationTitles) {
          assert.equal(title.background, colors.expected.background, theme + " タイトルの実効背景");
          assert.equal(title.color, colors.expected.color, theme + " タイトル文字");
          assert.equal(title.link, colors.link, theme + " タイトルリンク");
        }
        for (const component of colors.navigation) for (const key of ["background", "color"]) assert.equal(component[key], colors.expected[key], theme + " 実記事ナビゲーション配色");
        for (const row of colors.navigationBody) assert.equal(row.actual, row.expected);
        if (theme === "one-dark") {
          await article.click(".navbox .mw-collapsible-toggle");
          await article.waitForFunction(() => !document.querySelector(".navbox table").classList.contains("mw-collapsed"));
          for (const row of (await templateColors(article)).navigationBody) assert.equal(row.actual, row.expected, "展開後の項目背景もテーマに追従する");
          await article.$eval(".navbox-title", el => el.scrollIntoView({ block: "start" }));
          await article.screenshot({ path: path.join(output, "wikipedia-navigation-one-dark.png") });
          await article.click(".navbox .mw-collapsible-toggle");
        }
        for (const component of [colors.path, colors.notice]) {
          for (const key of ["background", "color", "border", "borderStyle"]) assert.equal(component[key], colors.expected[key], theme + " 実記事の案内 " + key);
        }
        assert.equal(colors.notice.accent, original.notice.accent, "注意の左線を保持する");
        for (const key of ["background", "color"]) assert.equal(colors.noticeText[key], colors.expected[key], theme + " 実記事の注意本文 " + key);
        console.log(theme + " 注意本文: " + JSON.stringify(colors.noticeText));
        assert.equal(await article.$eval(".pathnavbox a", el => el.href), href);
        if (theme === "one-dark") await article.screenshot({ path: path.join(output, "wikipedia-ff8-one-dark.png") });
      }
      await worker.evaluate(() => chrome.storage.local.set({ wikipediaEnabled: false }));
      await article.waitForSelector("html.__cpa-wiki-active", { hidden: true });
      const restored = await templateColors(article);
      assert.deepEqual(restored.path, original.path);
      assert.deepEqual(restored.notice, original.notice);
      assert.deepEqual(restored.noticeText, original.noticeText);
      assert.deepEqual(restored.navigation, original.navigation);
      assert.deepEqual(restored.navigationTitles, original.navigationTitles);
      await worker.evaluate(() => chrome.storage.local.set({ wikipediaEnabled: true, wikipediaFeatures: {}, wikipediaAppearance: { theme: "one-dark" } }));
      await article.waitForSelector(".__cpa-wiki-toc");
      for (const label of ["武器", "精製", "外部リンク", "武器"]) {
        const id = await article.evaluate(label => {
          const heading = [...document.querySelectorAll(".mw-parser-output h2, .mw-parser-output h3")].find(el => el.textContent.trim() === label);
          window.scrollTo({ top: window.scrollY + heading.getBoundingClientRect().top - 80, behavior: "instant" });
          return heading.id || heading.querySelector("[id]").id;
        }, label);
        await article.waitForFunction(id => {
          const link = document.querySelector('.__cpa-wiki-toc a[aria-current="location"]');
          return link && decodeURIComponent(new URL(link.href).hash.slice(1)) === id;
        }, {}, id);
        assert.equal(await article.$$eval('.__cpa-wiki-toc a[aria-current="location"]', els => els.length), 1);
        assert.ok(await article.$eval('.__cpa-wiki-toc a[aria-current="location"]', el => {
          const r = el.getBoundingClientRect(), rail = el.closest(".__cpa-wiki-rail").getBoundingClientRect();
          return r.top >= rail.top && r.bottom <= rail.bottom && getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)";
        }), "下方向・上方向とも現在の項目を目次内で見える位置に保つ");
      }
      await worker.evaluate(() => chrome.storage.local.set({ wikipediaFeatures: { stickyContents: false } }));
      await article.waitForSelector(".__cpa-wiki-toc", { hidden: true });
      await worker.evaluate(() => chrome.storage.local.set({ wikipediaFeatures: {} }));
      await article.waitForSelector('.__cpa-wiki-toc a[aria-current="location"]');
      await article.screenshot({ path: path.join(output, "wikipedia-current-section.png") });
      await article.close();
    });
  }
  console.log("検証画像と専用プロファイル: " + output);
});
