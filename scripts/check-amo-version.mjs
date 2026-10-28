import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JwtApiAuth} from 'web-ext/util/submit-addon';

export async function findAmoVersion({id, version, apiKey, apiSecret, fetchPage = fetch}) {
  if (![id, version, apiKey, apiSecret].every(value => typeof value === 'string' && value.length)) {
    throw new Error('AMO ID, version and credentials are required');
  }
  const origin = 'https://addons.mozilla.org';
  const pathname = `/api/v5/addons/addon/${encodeURIComponent(id)}/versions/`;
  let url = new URL(`${origin}${pathname}?filter=all_without_unlisted&page_size=50`);
  const seen = new Set();
  const ids = new Set();
  const versions = new Set();
  const auth = new JwtApiAuth({apiKey, apiSecret});
  let match;
  let count;
  while (url) {
    if (url.origin !== origin || url.pathname !== pathname || url.searchParams.get('filter') !== 'all_without_unlisted' || seen.has(url.href) || seen.size >= 200) {
      throw new Error('Unexpected or repeated AMO pagination URL');
    }
    seen.add(url.href);
    const response = await fetchPage(url, {headers: {Authorization: await auth.getAuthHeader(), Accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`AMO version lookup failed: HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !Number.isSafeInteger(data.count) || data.count < 0 || !Array.isArray(data.results) || !Object.hasOwn(data, 'next') || (data.next !== null && typeof data.next !== 'string')) {
      throw new Error('Invalid AMO version response');
    }
    if (count === undefined) count = data.count;
    else if (count !== data.count) throw new Error('AMO version count changed during pagination');
    for (const entry of data.results) {
      if (!entry || !Number.isSafeInteger(entry.id) || entry.id <= 0 || typeof entry.version !== 'string' || !entry.version || entry.channel !== 'listed') {
        throw new Error('Invalid AMO version entry');
      }
      if (ids.has(entry.id) || versions.has(entry.version)) throw new Error('Duplicate AMO version entry');
      ids.add(entry.id);
      versions.add(entry.version);
      if (ids.size > count) throw new Error('AMO version count exceeded');
      if (entry.version === version) {
        if (match) throw new Error('Multiple AMO versions match');
        match = entry;
      }
    }
    url = data.next === null ? null : new URL(data.next, origin);
  }
  if (ids.size !== count) throw new Error('AMO version count does not match retrieved entries');
  return match;
}

async function main() {
  const manifest = JSON.parse(await fs.readFile('manifest.firefox.json', 'utf8'));
  const match = await findAmoVersion({id: manifest.browser_specific_settings.gecko.id, version: process.env.MANIFEST_VERSION, apiKey: process.env.WEB_EXT_API_KEY, apiSecret: process.env.WEB_EXT_API_SECRET});
  if (match) {
    const status = typeof match.file?.status === 'string' && /^[a-z_]+$/.test(match.file.status) ? match.file.status : 'unknown';
    console.error(`AMO already has version ${match.version}, channel=${match.channel}, status=${status}; submitted bytes cannot be verified. Stop without resubmitting.`);
    process.exitCode = 1;
    return;
  }
  console.log(`AMO authenticated listed-version lookup: ${process.env.MANIFEST_VERSION} absent on all pages`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
