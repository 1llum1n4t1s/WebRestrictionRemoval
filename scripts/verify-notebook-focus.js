"use strict";
/* global window, document */
// 通信を遮断した fixture と mock 応答だけで非同期再描画のフォーカスを確認する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer");
const output = process.env.VUORA_BROWSER_TEST_DIR;
assert.ok(output && path.isAbsolute(output) && !fs.existsSync(output));
for (let parent = path.dirname(output);;) {
  assert.equal(fs.lstatSync(parent).isSymbolicLink(), false);
  const next = path.dirname(parent); if (next === parent) break; parent = next;
}
fs.accessSync(path.dirname(output), fs.constants.W_OK);
fs.mkdirSync(output);
process.env.TEMP = output; process.env.TMP = output;
(async () => {
  const browser = await puppeteer.launch({headless: true, userDataDir: path.join(output, "profile"), args: ["--no-first-run", "--disable-sync", "--disable-background-networking"]});
  try {
    for (const scenario of ["account-error", "new-error", "outside-error", "missing-key"]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setRequestInterception(true);
      const fixtureUrl = "https://www.youtube.com/watch?v=fixture1234";
      page.on("request", req => req.url() === fixtureUrl ? req.respond({contentType: "text/html", body: '<main role="main"><yt-button-view-model class="ytd-menu-renderer" style="display:block;width:120px;height:30px">fixture</yt-button-view-model></main><button id="outside">Outside</button>'}) : req.abort());
      await page.goto(fixtureUrl);
      await page.evaluate(() => {
        window.pending = [];
        window.saved = {searchFixerEnabled: true, searchFixerFeatures: {notebookLmSend: true}};
        window.listeners = [];
        window.chrome = {
          runtime: {id: "fixture", onMessage: {addListener() {}, removeListener() {}}, sendMessage: async msg => {
            if (msg.action === "notebookLmAccounts") return {ok: true, accounts: [{index: 0, email: "fixture@example.invalid"}], at: Date.now()};
            if (msg.action === "notebookLmList") return new Promise(resolve => window.pending.push(resolve));
            throw new Error(`Unexpected action: ${msg.action}`);
          }},
          storage: {local: {get: async () => window.saved}, onChanged: {addListener: fn => window.listeners.push(fn), removeListener() {}}},
          i18n: {getMessage: () => ""}
        };
      });
      for (const file of ["actions-core.js", "actions-video.js", "actions-loupe.js", "actions-volume.js", "actions.js", "cleaner-core.js"]) await page.addScriptTag({path: path.resolve(__dirname, "../src/lib", file)});
      await page.addScriptTag({path: path.resolve(__dirname, "../src/content/youtube-notebooklm.js")});
      await page.waitForSelector(".__cpa-nlm-btn");
      await page.waitForFunction(() => window.pending.length >= 1);
      await page.click(".__cpa-nlm-btn");
      await page.waitForFunction(() => window.pending.length >= 2);
      if (scenario === "missing-key") {
        await page.evaluate(() => window.pending.at(-1)({ok: true, notebooks: [{id: "n1", name: "Fixture", sources: 0}]}));
        await page.waitForSelector('[data-nlm-focus-key="notebook:n1"]');
        await page.focus('[data-nlm-focus-key="notebook:n1"]');
        await page.evaluate(() => {
          window.saved.notebookLmAccountIndex = 1;
          for (const fn of window.listeners) fn({notebookLmAccountIndex: {newValue: 1}}, "local");
        });
        await page.waitForFunction(() => window.pending.length >= 3);
        assert.equal(await page.evaluate(() => document.activeElement.dataset.nlmFocusKey), "new");
        await page.evaluate(() => window.pending.at(-1)({ok: true, notebooks: [{id: "n2", name: "Other", sources: 0}]}));
        await page.waitForSelector('[data-nlm-focus-key="notebook:n2"]');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.nlmFocusKey), "new");
      } else {
        await page.focus(scenario === "account-error" ? "select" : scenario === "new-error" ? '[data-nlm-focus-key="new"]' : "#outside");
        await page.evaluate(() => window.pending.at(-1)({ok: false, error: "network-failed"}));
        await page.waitForSelector(".__cpa-nlm-msg--error");
        assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#outside") ? "outside" : document.activeElement.textContent), scenario === "outside-error" ? "outside" : "NotebookLM を開く");
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${scenario}`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
