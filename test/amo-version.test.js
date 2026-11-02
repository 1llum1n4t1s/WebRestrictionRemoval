"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// 架空の資格情報を使い、認証ヘッダーを含む通信は fixture の外へ出さない。
const lookup = async (pages) => {
  const { findAmoVersion } = await import("../scripts/check-amo-version.mjs");
  let calls = 0;
  const result = await findAmoVersion({
    id: "fixture@example.invalid", version: "2.0", apiKey: "fixture", apiSecret: "fixture",
    fetchPage: async (url) => {
      const page = pages[calls++];
      assert.ok(page, "予定外のリクエストは失敗する");
      const next = new URL(url);
      next.searchParams.set("page", String(calls + 1));
      return {
        ok: !page.status, status: page.status ?? 200,
        json: async () => ({ count: page.count, results: page.results, next: page.next === true ? next.href : page.next ?? null }),
      };
    },
  });
  assert.equal(calls, pages.length, "全ページを取得する");
  return result;
};

const entry = (id, version) => ({ id, version, channel: "listed" });

test("AMO の対象版が2ページ目にあっても既存版を返す", async () => {
  const target = entry(2, "2.0");
  assert.deepEqual(await lookup([
    { count: 3, results: [entry(1, "1.0")], next: true },
    { count: 3, results: [target], next: true },
    { count: 3, results: [entry(3, "1.1")] },
  ]), target);
});

test("AMO の全ページに対象版がなければ未登録と判断する", async () => {
  assert.equal(await lookup([
    { count: 2, results: [entry(1, "1.0")], next: true },
    { count: 2, results: [entry(2, "1.1")] },
  ]), undefined);
});

test("AMO の途中ページの HTTP 失敗は未登録として通さない", async () => {
  await assert.rejects(lookup([
    { count: 2, results: [entry(1, "1.0")], next: true },
    { status: 503 },
  ]), /HTTP 503/);
});

test("AMO のページ反復は停止する", async () => {
  await assert.rejects(lookup([
    { count: 1, results: [entry(1, "1.0")], next: "?filter=all_without_unlisted&page_size=50" },
  ]), /repeated AMO pagination URL/);
});

test("AMO の件数不整合は対象版発見後も停止する", async () => {
  await assert.rejects(lookup([{ count: 2, results: [entry(1, "2.0")] }]), /count does not match/);
  await assert.rejects(lookup([
    { count: 2, results: [entry(1, "2.0")], next: true },
    { count: 3, results: [entry(2, "1.0")] },
  ]), /count changed/);
});
