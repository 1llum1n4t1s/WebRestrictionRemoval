"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { SearchFixer } = require("./_load-actions");

test("登録フィードの関連が強い欄だけを隠し、OFF・遷移・見出し再利用で復元する", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/content/search-fixer.js"), "utf8");
  const start = source.indexOf("  function applySubscriptionsRelevant(");
  const fn = source.slice(start, source.indexOf("  function purgeFeedDistractions()", start));
  const section = (title) => ({ title, hidden: false,
    querySelector(selector) {
      assert.equal(selector, "ytd-rich-shelf-renderer #rich-shelf-header h2");
      return this.title == null ? null : { textContent: this.title };
    },
    get classList() { return { toggle: (name, value) => {
      assert.equal(name, "__cpa-sfx-hide-subs-relevant"); this.hidden = value;
    } }; },
  });
  const sections = [section("関連が強い"), section(" Most relevant "), section("ショート"),
    section("新しい順"), section(null), section("関連が強い動画について")];
  const context = vm.createContext({ active: true, features: SearchFixer.mergeFeatures({}),
    location: { pathname: "/feed/subscriptions" }, document: { querySelectorAll: () => sections } });
  vm.runInContext(fn, context);
  const apply = () => vm.runInContext("applySubscriptionsRelevant()", context);
  apply();
  assert.ok(sections.every((s) => !s.hidden), "既定OFF");
  context.features.hideSubscriptionsRelevant = true;
  apply();
  assert.deepEqual(sections.map((s) => s.hidden), [true, true, false, false, false, false]);
  context.active = false; apply();
  assert.ok(sections.every((s) => !s.hidden), "マスターOFFで復元");
  context.active = true; apply();
  context.features.hideSubscriptionsRelevant = false; apply();
  assert.ok(sections.every((s) => !s.hidden), "個別OFFで復元");
  context.features.hideSubscriptionsRelevant = true;
  for (const pathname of ["/", "/results", "/watch", "/feed/subscriptions/shorts"]) {
    context.location.pathname = pathname; apply();
    assert.ok(sections.every((s) => !s.hidden), pathname);
  }
  context.location.pathname = "/feed/subscriptions"; apply();
  sections[0].title = "新しい順"; apply();
  assert.equal(sections[0].hidden, false, "再利用されたセクションを再判定");
  sections.push(section("関連が強い")); apply();
  assert.equal(sections.at(-1).hidden, true, "遅延追加された欄も適用");
  vm.runInContext("applySubscriptionsRelevant(false)", context);
  assert.ok(sections.every((s) => !s.hidden), "終了時に復元");
});
