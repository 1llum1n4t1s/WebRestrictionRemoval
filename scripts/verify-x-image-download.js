"use strict";
/* global chrome, document, location */
// 未使用の絶対パス VUORA_BROWSER_TEST_DIR に専用プロファイルと保存画像を作る。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer");
const sharp = require("sharp");

test("X: popup設定・画像別ボタン・orig取得・OFF復元", { timeout: 90000 }, async t => {
  const output = process.env.VUORA_BROWSER_TEST_DIR;
  assert.ok(output && path.isAbsolute(output) && !fs.existsSync(output));
  for (let p = path.dirname(output);;) {
    assert.equal(fs.lstatSync(p).isSymbolicLink(), false);
    const next = path.dirname(p); if (next === p) break; p = next;
  }
  fs.accessSync(path.dirname(output), fs.constants.W_OK); fs.mkdirSync(output);
  const downloadsDir = path.join(output, "downloads"); fs.mkdirSync(downloadsDir);
  const browser = await puppeteer.launch({ headless: true, enableExtensions: [path.resolve(__dirname, "..")],
    userDataDir: path.join(output, "profile"), args: ["--no-first-run", "--disable-sync"] });
  t.after(() => browser.close());
  const target = await browser.waitForTarget(target => target.type() === "service_worker");
  const worker = await target.worker();
  const origin = target.url().split("/").slice(0, 3).join("/");
  const session = await browser.target().createCDPSession();
  await session.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloadsDir, eventsEnabled: true });
  const downloads = [], completed = [];
  session.on("Browser.downloadWillBegin", event => downloads.push(event));
  session.on("Browser.downloadProgress", event => { if (event.state === "completed") completed.push(event.guid); });
  await browser.setCookie({ name: "test-only-cookie", value: "not-to-send", domain: "pbs.twimg.com", path: "/", secure: true, sameSite: "None" });
  const preview = await sharp({ create: { width: 400, height: 260, channels: 3, background: "#53677f" } }).png().toBuffer();
  const original = await sharp({ create: { width: 2000, height: 1200, channels: 3, background: "#354f74" } }).png().toBuffer();
  const livePhotoId = "Gfj7jxOWQAAPaPR"; // 公開投稿で観測した画像。外部CDN確認の明示時だけ取得する。
  const src = id => `https://pbs.twimg.com/media/${id}?format=webp&name=small`;
  const fixture = `<!doctype html><meta charset="utf-8"><title>X download test</title>
    <style>body{margin:40px;background:#15202b;color:#eee;font:16px system-ui}.photos{display:flex;gap:16px}.photo{width:300px;height:195px;position:relative}.photo img{width:100%;height:100%;object-fit:cover}.cover{position:absolute;inset:0;z-index:10}img.avatar{width:48px;height:48px}button{font:inherit}</style>
    <article data-testid="tweet"><div class="photos">
    <div id="legacy" class="photo"><a href="/test/status/1234567890/photo/1" style="display:block;width:100%;height:100%"><div style="position:relative;height:100%"><div style="position:absolute;inset:0"><div data-testid="tweetPhoto" style="position:absolute;inset:0"><div id="photo-background" style="position:absolute;inset:0;background:center/cover url('${src("Image_A")}')"></div><img id="a" style="position:absolute;inset:0;opacity:0" src="${src("Image_A")}"></div></div></div></a></div>
    <div id="modern" class="photo"><div inert><div data-slot="xds-context-menu-trigger"><img id="b" src="${src("Image_B")}"></div></div><a class="cover" href="/test/status/1234567890/photo/2" aria-label="View media"></a></div>
    <div id="grid" class="photo"><a href="/test/status/1234567890/photo/3"><img id="c" src="${src("Image_C")}"></a></div></div>
    <img class="avatar" src="https://pbs.twimg.com/profile_images/1/avatar.jpg">
    <div data-testid="tweetPhoto"><img width="300" height="195" src="https://pbs.twimg.com/ext_tw_video_thumb/1/poster.jpg"></div>
    <div data-testid="card.wrapper"><img width="300" height="195" src="${src("Link_Card")}"></div></article>`;
  const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 850 });
  const errors = [], requests = [], held = []; let mode = "fallback";
  page.on("pageerror", error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on("request", async request => {
    const url = new URL(request.url());
    try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) return await request.respond({ status: 200, contentType: "text/html", body: fixture });
      if (url.hostname !== "pbs.twimg.com") return await request.respond({ status: 404, body: "" });
      if (process.env.VUORA_LIVE_CDN === "1" && url.pathname === "/media/" + livePhotoId) {
        if (url.searchParams.get("name") === "orig") requests.push({ url: request.url(), headers: request.headers() });
        return await request.continue();
      }
      if (url.searchParams.get("name") !== "orig") return await request.respond({ status: 200, contentType: "image/png", body: preview });
      requests.push({ url: request.url(), headers: request.headers() });
      if (mode === "hold") { held.push(request); return; }
      if (mode === "fail" || (mode === "fallback" && url.searchParams.get("format") !== "png")) return await request.respond({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" });
      await request.respond({ status: 200, headers: { "access-control-allow-origin": "*" }, contentType: mode === "html" ? "text/html" : "image/png", body: mode === "html" ? "not an image" : original });
    } catch (error) { if (!/interception|closed|Invalid/i.test(error.message)) throw error; }
  });
  await page.goto("https://x.com/test/status/1234567890", { waitUntil: "load" });
  await page.bringToFront();
  const popupTarget = browser.waitForTarget(target => target.url() === origin + "/src/popup/popup.html");
  await worker.evaluate(() => chrome.action.openPopup());
  const popup = await (await popupTarget).asPage();
  await popup.waitForSelector("#categoryTrigger:not([disabled])");
  await popup.click("#categoryTrigger"); await popup.click("#tabX");
  await popup.waitForSelector("#x-feature-imageDownload");
  const button = ".__cpa-img-dl-button";
  const update = async patch => worker.evaluate(patch => chrome.storage.local.set(patch), patch);
  const click = async selector => { await page.hover(selector); await page.click(selector + " " + button); };
  const waitDone = async () => page.waitForFunction(() => !document.querySelector(".__cpa-img-dl-busy"));
  const settle = () => new Promise(resolve => setTimeout(resolve, 350)); // 走査の200ms debounce後の非出現も確認する。
  const download = async selector => {
    const count = completed.length; await click(selector);
    const deadline = Date.now() + 10000;
    while (completed.length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(completed.length, count + 1);
    const guid = completed.at(-1), record = downloads.find(item => item.guid === guid);
    assert.match(record.suggestedFilename, /^x_\d{8}_\d{6}\.png$/);
    assert.deepEqual(fs.readFileSync(path.join(downloadsDir, guid)), original);
  };
  await t.test("既定OFFとマスター/サブ機能の条件", async () => {
    assert.equal(await popup.$eval("#xCleanerToggle", el => el.checked), false);
    assert.equal(await popup.$eval("#x-feature-imageDownload", el => el.checked), false);
    assert.equal(await page.$(button), null);
    await update({ xCleanerFeatures: { imageDownload: true } }); await settle();
    assert.equal(await page.$(button), null);
    await update({ xCleanerFeatures: { imageDownload: false } });
    await popup.reload(); await popup.waitForSelector("#categoryTrigger:not([disabled])");
    await popup.click("#xCleanerToggle"); await settle(); assert.equal(await page.$(button), null);
    await popup.click("#x-feature-imageDownload");
    await page.waitForFunction(() => document.querySelectorAll(".__cpa-img-dl-button").length === 3);
    await popup.screenshot({ path: path.join(output, "x-popup.png") });
  });
  await t.test("新旧DOMと複数画像に安全にボタンを付け、原寸PNGを保存", async () => {
    assert.equal(await page.$$eval("a .__cpa-img-dl-button, [inert] .__cpa-img-dl-button", els => els.length), 0);
    await download("#modern");
    assert.deepEqual(requests.map(request => new URL(request.url).searchParams.get("format")), ["webp", "jpg", "png"]);
    for (const request of requests) { assert.ok(!request.headers.cookie); assert.ok(!request.headers.referer); }
    assert.equal(page.url(), "https://x.com/test/status/1234567890");
    const metadata = await sharp(fs.readFileSync(path.join(downloadsDir, completed.at(-1)))).metadata();
    assert.equal(metadata.width, 2000); assert.equal(metadata.height, 1200);
    mode = "ok"; const count = requests.length; await download("#legacy");
    assert.equal(requests.length, count + 1, "成功したら別形式を余分に取得しない");
    await page.hover("#modern"); await page.screenshot({ path: path.join(output, "x-buttons.png") });
  });
  await t.test("orig取得失敗や非画像レスポンスで縮小画像を保存しない", async () => {
    const count = completed.length; mode = "fail"; await click("#grid"); await waitDone();
    assert.equal(completed.length, count);
    assert.ok(requests.every(request => new URL(request.url).searchParams.get("name") === "orig"));
    mode = "html"; await click("#grid"); await waitDone(); assert.equal(completed.length, count);
    mode = "ok";
  });
  await t.test("透明imgの背景写真は対象にし、本当に隠れた画像は除外する", async () => {
    for (const [selector, property, value] of [
      ["#photo-background", "display", "none"], ["#photo-background", "opacity", "0"],
      ["#photo-background", "width", "0px"], ["#photo-background", "height", "0px"],
      ["#photo-background", "visibility", "hidden"],
      ["#legacy", "visibility", "hidden"], ["#legacy", "opacity", "0"],
    ]) {
      await page.$eval(selector, (el, { property, value }) => el.style.setProperty(property, value), { property, value });
      await page.waitForFunction(() => !document.querySelector("#legacy .__cpa-img-dl-button"));
      await page.$eval(selector, (el, property) => el.style.removeProperty(property), property);
      await page.waitForSelector("#legacy " + button);
    }
    await page.$eval("#photo-background", (el, url) => el.style.backgroundImage = `url("${url}")`, src("Other_Image"));
    await page.waitForFunction(() => !document.querySelector("#legacy .__cpa-img-dl-button"));
    await page.$eval("#photo-background", (el, url) => el.style.backgroundImage = `url("${url}")`, src("Image_A"));
    await page.waitForSelector("#legacy " + button); await download("#legacy");
  });
  await t.test("サイトが管理属性を消して再描画してもボタンを重複させない", async () => {
    for (let i = 0; i < 3; i++) {
      await page.$eval("#a", img => {
        img.closest(".__cpa-img-dl-host, .__cpa-img-dl-host-positioned")?.classList.remove("__cpa-img-dl-host", "__cpa-img-dl-host-positioned");
        img.removeAttribute("data-cpa-img-dl-src");
        img.classList.toggle("site-rerender");
      });
      await settle();
      assert.equal(await page.$$eval("#legacy " + button, els => els.length), 1);
      assert.ok(await page.$eval("#legacy", el => el.classList.contains("__cpa-img-dl-host-positioned")));
    }
    await download("#legacy");
  });
  await t.test("画像ビューアーでも保存でき、閉じるとボタンを片付ける", async () => {
    await page.evaluate(url => {
      const dialog = document.createElement("div"); dialog.id = "viewer";
      dialog.setAttribute("role", "dialog"); dialog.dataset.testid = "swipe-to-dismiss";
      dialog.innerHTML = '<div class="photo"><img alt="Full size photo"></div>';
      dialog.querySelector("img").src = url; document.body.append(dialog);
    }, src("Image_Viewer"));
    await page.waitForSelector("#viewer " + button);
    await download("#viewer");
    assert.equal(await page.$$eval("a .__cpa-img-dl-button, [inert] .__cpa-img-dl-button", els => els.length), 0);
    await page.$eval("#viewer", el => el.remove()); await settle();
    assert.equal(await page.$$eval(button, els => els.length), 3);
  });
  if (process.env.VUORA_LIVE_CDN === "1") await t.test("実CDN: Xオリジンのボタンから原寸画像を保存", async () => {
    await page.evaluate(id => {
      const host = document.createElement("div"); host.id = "cdn"; host.className = "photo";
      host.innerHTML = '<a href="/Wikipedia/status/1871522274555404722/photo/1"><img alt="Public post photo"></a>';
      host.querySelector("img").src = `https://pbs.twimg.com/media/${id}?format=webp&name=large`;
      document.body.append(host);
    }, livePhotoId);
    await page.waitForSelector("#cdn " + button);
    const previewWidth = await page.$eval("#cdn img", img => img.naturalWidth);
    const count = completed.length, before = requests.length; await click("#cdn");
    const deadline = Date.now() + 15000;
    while (completed.length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(completed.length, count + 1);
    const actual = await sharp(fs.readFileSync(path.join(downloadsDir, completed.at(-1)))).metadata();
    assert.ok(actual.width >= previewWidth && actual.width > 0);
    assert.ok(requests.length > before);
    for (const request of requests.slice(before)) {
      assert.equal(new URL(request.url).searchParams.get("name"), "orig");
      assert.ok(!request.headers.cookie); assert.ok(!request.headers.referer);
    }
    console.log(`実CDN原寸保存: ${actual.width}×${actual.height} / ${actual.format}`);
    await page.$eval("#cdn", el => el.remove()); await settle();
  });
  await t.test("画像差し替え・inert変更・DOM削除へ追従", async () => {
    await page.$eval("#b", (img, url) => { img.src = url; }, src("Image_New"));
    await page.waitForFunction(() => document.querySelector("#b").dataset.cpaImgDlSrc?.includes("Image_New"));
    const count = requests.length; await download("#modern"); assert.ok(requests[count].url.includes("Image_New"));
    await page.$eval("#grid", el => el.setAttribute("inert", ""));
    await page.waitForFunction(() => !document.querySelector("#grid .__cpa-img-dl-button"));
    await page.$eval("#grid", el => el.removeAttribute("inert")); await page.waitForSelector("#grid " + button);
    await page.$eval("#legacy", el => el.remove());
    await page.waitForFunction(() => document.querySelectorAll(".__cpa-img-dl-button").length === 2);
  });
  await t.test("取得中のOFFで中止し、マスター/サブOFFで全撤去", async () => {
    mode = "hold"; const count = completed.length; await click("#modern");
    await page.waitForSelector(".__cpa-img-dl-busy");
    await update({ xCleanerFeatures: { imageDownload: false } }); await page.waitForSelector(button, { hidden: true });
    for (const request of held) { try { await request.respond({ status: 200, contentType: "image/png", body: original }); } catch { /* 中止済み */ } }
    await settle(); assert.equal(completed.length, count);
    mode = "ok"; await update({ xCleanerFeatures: { imageDownload: true } }); await page.waitForSelector(button);
    await update({ xCleanerEnabled: false }); await page.waitForSelector(button, { hidden: true });
    assert.equal(await page.$('[class*="__cpa-img-dl-host"]'), null);
    await page.reload(); await settle(); assert.equal(await page.$(button), null);
    assert.deepEqual(errors, []);
  });
  if (process.env.VUORA_LIVE_X === "1") await t.test("実X: 公開投稿のボタンからCDN原寸画像を保存", async () => {
    await update({ xCleanerEnabled: true, xCleanerFeatures: { imageDownload: true } });
    const live = await browser.newPage(); await live.setViewport({ width: 1280, height: 900 });
    t.after(() => { if (!live.isClosed()) return live.close(); });
    const liveRequests = [];
    live.on("request", request => { if (request.resourceType() === "fetch" && request.url().startsWith("https://pbs.twimg.com/media/")) liveRequests.push(request.url()); });
    await live.goto("https://x.com/Wikipedia", { waitUntil: "domcontentloaded", timeout: 30000 });
    try {
      await live.waitForSelector(button, { timeout: 20000 });
    } catch (error) {
      await live.screenshot({ path: path.join(output, "x-live-unavailable.png") });
      console.log("実Xの表示状態:", await live.evaluate(() => ({
        title: document.title, url: location.href, text: document.body.innerText.slice(0, 400),
        photos: [...document.images].filter(img => img.currentSrc.startsWith("https://pbs.twimg.com/media/")).length,
      })));
      throw error;
    }
    assert.equal(await live.$$eval("a .__cpa-img-dl-button, [inert] .__cpa-img-dl-button", els => els.length), 0);
    const item = await live.$(button); await item.evaluate(el => el.focus());
    await live.screenshot({ path: path.join(output, "x-live-button.png") });
    const count = completed.length; await item.click();
    const deadline = Date.now() + 15000;
    while (completed.length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(completed.length, count + 1);
    assert.ok(liveRequests.length > 0 && liveRequests.every(url => new URL(url).searchParams.get("name") === "orig"));
    const image = await sharp(fs.readFileSync(path.join(downloadsDir, completed.at(-1)))).metadata();
    assert.ok(image.width >= 1000 || image.height >= 1000);
    console.log(`実Xの原寸保存: ${image.width}×${image.height} / ${image.format}`);
    await update({ xCleanerEnabled: false }); await live.waitForSelector(button, { hidden: true });
    await live.close();
  });
});
