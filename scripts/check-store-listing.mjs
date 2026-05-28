#!/usr/bin/env node
/**
 * check-store-listing.mjs
 * CWS (Chrome Web Store) と AMO (Firefox AMO) の公開 listing と
 * リポジトリの store-listing.*.txt を比較して drift を可視化する。
 *
 * CWS:
 *   - 公式 API は listing CRUD を持たない (Item upload/publish のみ提供) ため、
 *     公開ストアページ (chromewebstore.google.com/detail/{id}) を fetch して
 *     HTML の <meta> タグから name / description を抽出する。
 *   - 必要環境変数: CWS_EXTENSION_ID
 *
 * AMO:
 *   - 公式 API v5 で listing GET 可能 (PATCH は update-amo-listing.mjs と対称)
 *   - GET /addons/addon/{slug}/?lang=all は anonymous でも取得可能
 *   - 必要環境変数: AMO_SLUG (default "web-viewing-assist")
 *
 * 使い方:
 *   CWS_EXTENSION_ID=... node scripts/check-store-listing.mjs
 *   node scripts/check-store-listing.mjs --cws        # CWS のみ
 *   node scripts/check-store-listing.mjs --amo        # AMO のみ
 */

import fs from "node:fs";
import path from "node:path";

// CWS extension ID は env var > .cws-id ファイル (リポジトリルート) の優先順位で取得。
// .cws-id は公開ストア URL の一部に含まれる identifier (秘密情報ではない) なのでコミット対象。
function loadCwsId() {
  if (process.env.CWS_EXTENSION_ID) return process.env.CWS_EXTENSION_ID;
  const candidates = [".cws-id", path.join(process.cwd(), ".cws-id")];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const v = fs.readFileSync(p, "utf8").trim();
        if (v.length > 0) return v;
      }
    } catch {}
  }
  return null;
}

const CWS_ID = loadCwsId();
const AMO_SLUG = process.env.AMO_SLUG || "web-viewing-assist";
const args = process.argv.slice(2);
// 実行対象決定 (CodeRabbit #3317269094 指摘修正):
//   - フラグなし → 両方実行 (default)
//   - --cws のみ → CWS のみ
//   - --amo のみ → AMO のみ
//   - --cws --amo 両指定 → 両方実行 (= フラグなしと同じ、サイレント no-op を防ぐ)
// 旧設計: `if (!ONLY_AMO) await checkCws(); if (!ONLY_CWS) await checkAmo();` だと
// 両指定時に両方 skip される bug があった。
const ONLY_CWS = args.includes("--cws");
const ONLY_AMO = args.includes("--amo");
const RUN_CWS = ONLY_CWS || !ONLY_AMO;
const RUN_AMO = ONLY_AMO || !ONLY_CWS;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function decodeHtmlEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

async function fetchCwsPage(lang) {
  if (!CWS_ID) throw new Error("CWS_EXTENSION_ID 環境変数が必要");
  const url = `https://chromewebstore.google.com/detail/${CWS_ID}?hl=${lang}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": lang === "ja" ? "ja,en;q=0.8" : "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`CWS ${lang} fetch failed: HTTP ${res.status}`);
  return await res.text();
}

function extractCwsField(html, field) {
  // CWS の SSR HTML から取得可能な field 候補
  const patterns = {
    name: [
      /<meta[^>]+itemprop=["']name["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<title>([^<]+?)\s*-\s*Chrome Web Store/i,
    ],
    description: [
      /<meta[^>]+itemprop=["']description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    ],
    version: [
      /"version"\s*:\s*"([\d.]+)"/,
      /\bversion[\s:：]+v?([\d.]+)\b/i,
    ],
  };
  const candidates = patterns[field] || [];
  for (const re of candidates) {
    const m = html.match(re);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return null;
}

async function fetchAmoListing() {
  const url = `https://addons.mozilla.org/api/v5/addons/addon/${AMO_SLUG}/?lang=all`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`AMO fetch failed: HTTP ${res.status}`);
  return await res.json();
}

function pickLocale(field, locale) {
  if (field == null) return null;
  if (typeof field === "string") return field;
  return field[locale] ?? field["en-US"] ?? field["ja"] ?? null;
}

function checkKeywords(haystack, expected) {
  if (!haystack) return expected.map((kw) => ({ keyword: kw, present: false }));
  return expected.map((kw) => ({ keyword: kw, present: haystack.includes(kw) }));
}

function reportDrift(label, current, expectedKeywords) {
  const hits = checkKeywords(current, expectedKeywords);
  const missing = hits.filter((h) => !h.present);
  if (missing.length === 0) {
    console.log(`  ✅ ${label}: 主要新キーワード全て含まれる (drift なし)`);
  } else {
    console.log(
      `  ❌ ${label}: 不足キーワード ${missing.length}/${expectedKeywords.length} → ${missing.map((h) => `"${h.keyword}"`).join(" / ")}`
    );
  }
}

async function checkCws() {
  console.log("\n========================================");
  console.log("🌐 Chrome Web Store (CWS)");
  console.log("========================================");
  if (!CWS_ID) {
    console.log("⚠️  CWS_EXTENSION_ID 未設定 → CWS チェックをスキップ");
    console.log("    取得元の優先順位:");
    console.log("      1. env var CWS_EXTENSION_ID");
    console.log("      2. リポジトリルート .cws-id ファイル (単一行、commit 対象)");
    console.log("    例: $env:CWS_EXTENSION_ID = 'abc...' (pwsh) または echo 'abc...' > .cws-id");
    return;
  }
  console.log(`Extension ID: ${CWS_ID}`);
  console.log(`公開 URL    : https://chromewebstore.google.com/detail/${CWS_ID}`);

  for (const lang of ["ja", "en"]) {
    console.log(`\n## ${lang === "ja" ? "日本語 (?hl=ja)" : "英語 (?hl=en)"}`);
    let html;
    try {
      html = await fetchCwsPage(lang);
    } catch (e) {
      console.log(`  ✗ fetch 失敗: ${e.message}`);
      continue;
    }
    const name = extractCwsField(html, "name");
    const desc = extractCwsField(html, "description");
    const version = extractCwsField(html, "version");
    console.log(`  name (meta)        : ${name ?? "(取得失敗)"}`);
    console.log(`  description (meta) : ${desc ?? "(取得失敗)"}`);
    console.log(`  version (inline)   : ${version ?? "(取得失敗)"}`);

    // meta description は短い summary のみのため、必ずしも 13 機能等の長文キーワードは含まれない。
    // 名前 + 簡潔な summary レベルで drift チェック。
    const importantKeywords =
      lang === "ja"
        ? ["WEB閲覧アシスト", "ローカル"]
        : ["Web Viewing Assist", "local"];
    reportDrift("meta description", desc, importantKeywords);
  }
  console.log(`\n⚠️  CWS の Full Description / カテゴリ / スクリーンショット は API 経由で更新不可。`);
  console.log(`    Full Description は SPA レンダリングのため <meta> からは抽出不能。`);
  console.log(`    完全な現状確認 → Dashboard で目視: https://chrome.google.com/webstore/devconsole`);
  console.log(`    リリース時に webstore/store-listing.txt / store-listing.en.txt をコピペ更新が必要。`);
}

async function checkAmo() {
  console.log("\n========================================");
  console.log("🦊 Firefox AMO");
  console.log("========================================");
  console.log(`Slug    : ${AMO_SLUG}`);
  console.log(`公開 URL: https://addons.mozilla.org/en-US/firefox/addon/${AMO_SLUG}/`);

  let got;
  try {
    got = await fetchAmoListing();
  } catch (e) {
    console.log(`✗ AMO fetch 失敗: ${e.message}`);
    return;
  }

  for (const locale of ["ja", "en-US"]) {
    console.log(`\n## ${locale === "ja" ? "日本語 (ja)" : "英語 (en-US)"}`);
    const name = pickLocale(got.name, locale);
    const summary = pickLocale(got.summary, locale);
    const description = pickLocale(got.description, locale);
    console.log(`  name        : ${name ?? "(なし)"}`);
    console.log(`  summary     : ${summary ?? "(なし)"}`);
    console.log(`  description : ${description?.length ?? 0} chars`);
    if (description) {
      const head = description.replace(/\s+/g, " ").slice(0, 200);
      console.log(`    head 200  : ${head}…`);
    }

    const importantKeywords =
      locale === "ja"
        ? ["12 カテゴリ", "Amazon 販売元", "MediaElementSource", "Firefox 142"]
        : ["12 categories", "Amazon seller", "MediaElementSource", "Firefox 142"];
    reportDrift("summary", summary, importantKeywords);
    reportDrift("description", description, importantKeywords);
  }
  console.log(`\n  status              : ${got.status ?? "(取得失敗)"}`);
  console.log(`  current_version     : ${got.current_version?.version ?? "(なし)"}`);
  console.log(`  categories          : ${JSON.stringify(got.categories ?? {})}`);
  console.log(`  has_privacy_policy  : ${got.has_privacy_policy ?? false}`);
  console.log(`\n💡 AMO は scripts/update-amo-listing.mjs で listing を自動 push 可能 (PATCH /addons/addon/{slug}/)。`);
}

async function main() {
  console.log("🔍 ストア掲載 listing drift チェッカー");

  if (RUN_CWS) await checkCws();
  if (RUN_AMO) await checkAmo();

  console.log("\n✨ 完了");
}

main().catch((e) => {
  console.error("\n✗ エラー:", e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
