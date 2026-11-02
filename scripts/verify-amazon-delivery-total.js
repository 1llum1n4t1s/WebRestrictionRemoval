"use strict";
/* global chrome, document */
// 合成配送データだけを使用。未使用の絶対パス VUORA_BROWSER_TEST_DIR に専用プロファイルを作る。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer");

test("Amazon: 配送DOMの集計・ID境界・ノード再利用・OFF復元", async (t) => {
  const output = process.env.VUORA_BROWSER_TEST_DIR;
  assert.ok(output && path.isAbsolute(output), "専用の絶対出力パスを指定する");
  assert.ok(!fs.existsSync(output), "出力先は新規ディレクトリにする");
  for (let parent = path.dirname(output); ; parent = path.dirname(parent)) {
    assert.ok(!fs.lstatSync(parent).isSymbolicLink(), "リンク経由の出力を拒否する");
    if (parent === path.dirname(parent)) break;
  }
  fs.accessSync(path.dirname(output), fs.constants.W_OK);
  fs.mkdirSync(output);
  const browser = await puppeteer.launch({ headless: true, enableExtensions: [path.resolve(__dirname, "..")],
    userDataDir: path.join(output, "profile"), args: ["--no-first-run", "--disable-sync"] });
  t.after(() => browser.close());
  const target = await browser.waitForTarget((target) => target.type() === "service_worker");
  const worker = await target.worker();
  await worker.evaluate(() => chrome.storage.local.set({ amazonDeliveryTotalEnabled: true }));
  const page = await browser.newPage();
  const comment = (id) => `<!--k-injected k+b64 ${Buffer.from(JSON.stringify({ "k-data": { subscriptionId: id } })).toString("base64")}-->`;
  const tile = (id, price = "", quantity = "2個") => `<div data-testid="desktop-subscription-tile" id="${id}"><span data-testid="product-price">${price}</span><span data-testid="product-qty-frequency">${quantity}</span><span data-testid="product-savings">10%</span></div>`;
  const section = (id, body) => `<section data-testid="desktop-delivery-card-list-${id}"><div data-testid="desktop-delivery-card"></div>${body}</section>`;
  const manageUrl = "https://www.amazon.co.jp/auto-deliveries/?shipId=fixture&deliveryBundleId=fixture&deliveryDate=2026-12-01";
  let fixture = "", requests = [];
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    const url = new URL(request.url());
    if (request.isNavigationRequest()) return request.respond({ status: 200, contentType: "text/html", body: fixture });
    requests.push(request.url());
    if (url.origin === "https://www.amazon.co.jp" && url.pathname === "/auto-deliveries/ajax/subscription") {
      assert.equal(request.method(), "GET");
      return request.respond({ status: 200, contentType: "text/html", body: '<a href="/dp/B000000001">fixture</a>' });
    }
    if (url.origin === "https://www.amazon.co.jp" && url.pathname === "/dp/B000000001") {
      return request.respond({ status: 200, contentType: "text/html", body: '<input id="ASIN" value="B000000001"><input name="items[0.base][additionalParameters][recurringDelivery][discount]" value="10"><div id="sns-base-price"><span class="apex-pricetopay-value"><span class="a-offscreen">¥90</span></span></div>' });
    }
    return request.abort();
  });
  const root = ".__cpa-amzn-delivery-total";
  const waitTotals = async (totals) => {
    await page.waitForFunction((selector, expected) => {
      const actual = [...document.querySelectorAll(selector)].map((node) => JSON.parse(node.dataset.value)[1]);
      return JSON.stringify(actual) === JSON.stringify(expected);
    }, {}, root, totals);
  };
  const load = async (body, count) => {
    fixture = `<!doctype html><meta charset="utf-8"><div data-testid="delivery-item-count-desktop">${count}</div>${body}`;
    requests = [];
    await page.goto(manageUrl);
  };
  await load(section("a", tile("a", "¥100")) + section("b", tile("b", "¥250", "3個")), 2);
  await waitTotals([200, 750]);
  assert.equal(requests.filter((url) => url.includes("/ajax/subscription")).length, 0, "配送価格は取得結果より優先");
  await page.evaluate(() => { document.querySelector("#a [data-testid='product-price']").textContent = "¥120"; });
  await waitTotals([240, 750]);
  await page.evaluate(() => { document.querySelector("#b").outerHTML = '<div id="b" data-testid="desktop-subscription-tile"><span data-testid="product-price">¥50</span><span data-testid="product-qty-frequency">4個</span></div>'; });
  await waitTotals([240, 200]);

  // 同一IDの重複コメントは曖昧にせず、tile二段上のコメントも使う。
  await load(section("a", `<div>${comment("same")}<div>${comment("same")}${tile("a")}</div></div>`), 1);
  await waitTotals([180]);
  assert.ok(requests.some((url) => new URL(url).searchParams.get("subscriptionId") === "same"));
  await load(section("a", `<div>${comment("depth-five")}${"<div>".repeat(4)}${tile("a")}${"</div>".repeat(5)}`), 1);
  await waitTotals([180]);
  assert.ok(requests.some((url) => new URL(url).searchParams.get("subscriptionId") === "depth-five"));
  for (const [name, body, count] of [
    ["異なるID", `<div>${comment("other")}<div>${comment("same")}${tile("a")}</div></div>`, 1],
    ["2商品共通祖先", `<div>${comment("shared")}${tile("a")}${tile("b")}</div>`, 2],
    ["section境界", comment("section-only") + tile("a"), 1],
    ["祖先5段の境界", `<div>${comment("too-far")}${"<div>".repeat(5)}${tile("a")}${"</div>".repeat(6)}`, 1],
    ["数量欠損", tile("a", "¥100", ""), 1],
    ["読込未完了", tile("a", "¥100"), 2],
  ]) {
    await load(section("a", body), count);
    await page.waitForFunction((selector) => [...document.querySelectorAll(selector)].some((node) => {
      const value = JSON.parse(node.dataset.value);
      return value[1] === null && !/取得中|Loading|Fetching/i.test(value[0]);
    }), {}, root);
    await waitTotals([null]);
    assert.equal(requests.filter((url) => url.includes("/ajax/subscription")).length, 0, name);
  }
  await worker.evaluate(() => chrome.storage.local.set({ amazonDeliveryTotalEnabled: false }));
  await page.waitForSelector(root, { hidden: true });
});
