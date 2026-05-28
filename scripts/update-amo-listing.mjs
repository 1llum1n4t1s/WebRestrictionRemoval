#!/usr/bin/env node
/**
 * update-amo-listing.mjs
 * AMO API v5 で listing メタデータを PATCH する。
 *
 * 更新する項目:
 *   - name (ja + en-US)
 *   - summary (ja + en-US)
 *   - description (ja + en-US) — plain text、HTML は escape される
 *   - homepage URL (GitHub repo)
 *   - support_url (GitHub Issues)
 *   - support_email (任意、ENV で渡せば設定)
 *   - privacy_policy (ja + en-US) — plain text、docs/privacy-policy.{md,en.md} の中身
 *   - categories (firefox: ["other"])
 *
 * 更新できない項目 (AMO API 不対応):
 *   - screenshots — AMO Developer Hub から手動 upload (`webstore/images/*.png`)
 *
 * 使い方:
 *   AMO_JWT_ISSUER=... AMO_JWT_SECRET=... node scripts/update-amo-listing.mjs
 *   AMO_JWT_ISSUER=... AMO_JWT_SECRET=... node scripts/update-amo-listing.mjs --dry-run
 *
 * 認証: JWT HS256 (ReplaceFontSelect 流派)。
 *   - header: {alg: HS256, typ: JWT}
 *   - payload: {iss, jti, iat, exp (60 秒短命)}
 *   - signature: HMAC-SHA256(secret, base64url(header).base64url(payload))
 *
 * ReplaceFontSelect Memory Bank の知見:
 *   - description / summary / privacy_policy は plain text 扱い (HTML タグはエスケープ保存)
 *   - locale コードは BCP 47 厳密 (`en-US` で、ハイフン必須)
 *   - privacy_policy は GET 本文に含まれず `has_privacy_policy: true` boolean のみ
 *   - `?lang=all` は一部 locale 省略されることがある
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";

const ISSUER = process.env.AMO_JWT_ISSUER;
const SECRET = process.env.AMO_JWT_SECRET;
const SLUG = process.env.AMO_SLUG || "web-viewing-assist";
const API_BASE = "https://addons.mozilla.org/api/v5";
const DRY_RUN = process.argv.includes("--dry-run");

const HOMEPAGE = "https://github.com/1llum1n4t1s/WebRestrictionRemoval";
const SUPPORT_URL = "https://github.com/1llum1n4t1s/WebRestrictionRemoval/issues";

if (!ISSUER || !SECRET) {
  console.error("✗ AMO_JWT_ISSUER / AMO_JWT_SECRET 環境変数が必要です");
  console.error("  発行: https://addons.mozilla.org/ja/developers/addon/api/key/");
  process.exit(1);
}

function makeJwt() {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    iss: ISSUER,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 60, // AMO 推奨: 60 秒短命トークン
  }));
  const signing = `${header}.${payload}`;
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(signing)
    .digest("base64url");
  return `${signing}.${sig}`;
}

function base64url(s) {
  return Buffer.from(s).toString("base64url");
}

async function request(method, path, body, retries = 3) {
  const url = `${API_BASE}${path}`;
  if (DRY_RUN && method !== "GET") {
    console.log(`  [dry-run] ${method} ${path} (skipped)`);
    if (body) console.log(`            body keys: ${Object.keys(body).join(", ")}`);
    return { dryRun: true };
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `JWT ${makeJwt()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // AMO API は throttle (HTTP 429) を返すことがある。レスポンス本文の "available in N seconds" を読んで wait + 1 回再試行。
  // CLAUDE.md ルール「sleep + retry の無限ループは禁止」を守るため、retries 上限 (デフォルト 3) で確実に終わるようにする。
  if (res.status === 429 && retries > 0) {
    const m = text.match(/available in (\d+) seconds/i);
    const waitMs = (m ? parseInt(m[1], 10) : 30) * 1000 + 2000; // +2s 余裕
    console.log(`  ⏳ throttled (HTTP 429), wait ${waitMs}ms → retry (${retries - 1} 回残り)`);
    await new Promise((r) => setTimeout(r, waitMs));
    return request(method, path, body, retries - 1);
  }
  if (!res.ok) {
    // /rere レビュー A3-003 修正: AMO API の 5xx で nginx / cloudflare のエラーページが
    // 返ることがあり、稀に Authorization ヘッダや trace ID 等のリクエストメタデータが含まれて
    // ローカル shell history に残る経路がある。truncate して防御深層を確保 (実害低・防御深層)
    const truncated = text && text.length > 500 ? `${text.slice(0, 500)}…[truncated]` : text;
    throw new Error(`${method} ${path} → HTTP ${res.status}\n${truncated}`);
  }
  return text ? JSON.parse(text) : null;
}

// store-listing.firefox.{ja,en}.txt から name / summary / description を抽出。
// 既存ファイル形式:
//   ■ 名前
//   <name>
//   ■ 概要 (250 文字以内)
//   <summary>
//   ■ 説明 (16,000 文字以内)
//   <description body>
//   ■ ...続く section も description に含める
function parseListing(text, sectionMarker, labels) {
  const lines = text.split(/\r?\n/);
  const result = {};
  let currentLabel = null;
  let buf = [];
  for (const line of lines) {
    const m = line.match(new RegExp(`^${sectionMarker}\\s+(.+)$`));
    if (m) {
      if (currentLabel) result[currentLabel] = buf.join("\n").trim();
      currentLabel = m[1].trim();
      buf = [];
    } else if (currentLabel) {
      buf.push(line);
    }
  }
  if (currentLabel) result[currentLabel] = buf.join("\n").trim();

  // labels の各 key を緩く取得 (前方一致)
  const out = {};
  for (const [k, prefix] of Object.entries(labels)) {
    out[k] = null;
    for (const [label, body] of Object.entries(result)) {
      if (label.startsWith(prefix)) {
        // 説明 section は説明 + 以降の全 section を結合 (本体は section 区切りでもユーザーに見せたい)
        if (k === "description") {
          const idx = Object.keys(result).indexOf(label);
          const rest = Object.entries(result).slice(idx);
          out[k] = rest
            .map(([l, b]) => (l === label ? b : `■ ${l}\n${b}`))
            .join("\n\n")
            .trim();
        } else {
          out[k] = body;
        }
        break;
      }
    }
  }
  return out;
}

async function main() {
  console.log(`🦊 AMO listing 更新スクリプト (slug: ${SLUG}, dry-run: ${DRY_RUN})\n`);

  // 1. listing テキスト読み込み
  const jaRaw = await fs.readFile("webstore/store-listing.firefox.ja.txt", "utf8");
  const enRaw = await fs.readFile("webstore/store-listing.firefox.en.txt", "utf8");
  const privacyJa = await fs.readFile("docs/privacy-policy.md", "utf8");
  const privacyEn = await fs.readFile("docs/privacy-policy.en.md", "utf8");

  // 2. parse
  const ja = parseListing(jaRaw, "■", {
    name: "名前",
    summary: "概要",
    description: "説明",
  });
  const en = parseListing(enRaw, "■", {
    name: "Name",
    summary: "Summary",
    description: "Description",
  });

  // name の長さチェック (AMO 上限 50 chars)
  // 「WEB閲覧アシスト (Firefox 版)」「Web Viewing Assist (Firefox)」のような suffix は付けず、本体名のみ
  const cleanName = (s) => (s || "").replace(/\s*\((Firefox\s*版?|Firefox)\)\s*$/i, "").trim();
  const nameJa = cleanName(ja.name) || "WEB閲覧アシスト";
  const nameEn = cleanName(en.name) || "Web Viewing Assist";

  // summary は AMO 上限 250 chars。実機で 250 ぴったりだと HTTP 400
  // "Ensure this field has no more than 250 characters." が出るため、安全側に 249 で truncate する。
  // (AMO validation は厳密 max=250 を「以下 OR 未満」のどちらで解釈するかバージョン揺れがあった経緯)
  const truncate = (s, max) => {
    if (!s) return s;
    return s.length <= max ? s : s.slice(0, max - 1) + "…";
  };
  const summaryJa = truncate(ja.summary, 249);
  const summaryEn = truncate(en.summary, 249);

  // description / privacy_policy 内の HTML タグ風文字列 (<video> / <feComponentTransfer> 等の技術ラベル)
  // を AMO の HTML allowlist が拒否して HTTP 406 を返すため、< > を HTML entity に pre-escape する。
  // AMO は plain text 扱いで保存し、Dashboard 表示時に再デコードして見せるので、最終的な見た目は元通り。
  const escapeHtmlTagLike = (s) => {
    if (!s) return s;
    return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };
  const descJa = escapeHtmlTagLike(ja.description);
  const descEn = escapeHtmlTagLike(en.description);
  const privacyJaEsc = escapeHtmlTagLike(privacyJa);
  const privacyEnEsc = escapeHtmlTagLike(privacyEn);

  console.log("📝 抽出した metadata:");
  console.log(`   name.ja      : ${nameJa} (${nameJa.length} chars)`);
  console.log(`   name.en-US   : ${nameEn} (${nameEn.length} chars)`);
  console.log(`   summary.ja   : ${summaryJa?.length || 0} chars`);
  console.log(`   summary.en-US: ${summaryEn?.length || 0} chars`);
  console.log(`   desc.ja      : ${ja.description?.length || 0} chars`);
  console.log(`   desc.en-US   : ${en.description?.length || 0} chars`);
  console.log(`   privacy.ja   : ${privacyJa.length} chars`);
  console.log(`   privacy.en-US: ${privacyEn.length} chars`);
  console.log(`   homepage     : ${HOMEPAGE}`);
  console.log(`   support_url  : ${SUPPORT_URL}`);
  console.log("");

  // 3. PATCH listing (name / summary / description / homepage / support_url / categories)
  console.log("📤 PATCH listing fields...");
  const listingBody = {
    name: { ja: nameJa, "en-US": nameEn },
    summary: { ja: summaryJa, "en-US": summaryEn },
    description: { ja: descJa, "en-US": descEn },
    homepage: { ja: HOMEPAGE, "en-US": HOMEPAGE },
    support_url: { ja: SUPPORT_URL, "en-US": SUPPORT_URL },
    categories: { firefox: ["other"] },
    is_experimental: false,
    requires_payment: false,
  };
  await request("PATCH", `/addons/addon/${SLUG}/`, listingBody);
  console.log("  ✅ listing fields updated\n");

  // 4. PATCH privacy_policy (別 PATCH で送ったほうが confilict 発生時に切り分けやすい)
  console.log("📤 PATCH privacy_policy...");
  const privacyBody = {
    privacy_policy: { ja: privacyJaEsc, "en-US": privacyEnEsc },
  };
  await request("PATCH", `/addons/addon/${SLUG}/`, privacyBody);
  console.log("  ✅ privacy_policy updated\n");

  // 5. 確認 GET (`?lang=all` で 各 locale 取得)
  console.log("🔍 確認 GET...");
  const got = await request("GET", `/addons/addon/${SLUG}/?lang=all`);
  console.log("  現在の AMO listing 状態:");
  console.log(`    name.ja:           ${pickLocale(got.name, "ja")}`);
  console.log(`    name.en-US:        ${pickLocale(got.name, "en-US")}`);
  console.log(`    summary.ja:        ${pickLocale(got.summary, "ja")?.slice(0, 60)}…`);
  console.log(`    summary.en-US:     ${pickLocale(got.summary, "en-US")?.slice(0, 60)}…`);
  console.log(`    description.ja:    ${pickLocale(got.description, "ja")?.length || 0} chars`);
  console.log(`    description.en-US: ${pickLocale(got.description, "en-US")?.length || 0} chars`);
  console.log(`    homepage:          ${pickLocale(got.homepage, "en-US") || got.homepage}`);
  console.log(`    support_url:       ${pickLocale(got.support_url, "en-US") || got.support_url}`);
  console.log(`    categories:        ${JSON.stringify(got.categories)}`);
  console.log(`    has_privacy_policy:${got.has_privacy_policy}`);
  console.log(`    status:            ${got.status}`);

  console.log("\n✨ 完了");
  console.log("  AMO Dashboard: https://addons.mozilla.org/en-US/developers/addon/" + SLUG + "/");
  console.log("");
  console.log("⚠️  以下は API 不対応のため手動アップロード必要:");
  console.log("    - screenshots (webstore/images/*.png を AMO Dashboard から upload)");
}

function pickLocale(field, locale) {
  if (field == null) return null;
  if (typeof field === "string") return field;
  return field[locale] ?? field["en-US"] ?? field["ja"] ?? null;
}

main().catch((e) => {
  console.error("\n✗ エラー:", e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
