// Chrome Web Store用のスクリーンショット画像を自動生成するスクリプト
// HTMLテンプレートからPuppeteerで生成
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const http = require('node:http');

// ディレクトリパス
const TEMPLATE_DIR = __dirname;
const OUTPUT_DIR = path.join(__dirname, 'images');
const POPUP_HTML_SRC = path.join(__dirname, '..', 'src', 'popup', 'popup.html');
const POPUP_RENDER_DST = path.join(__dirname, 'popup-render.html');
const POPUP_SHIM_DST = path.join(__dirname, 'popup-shim.js');
const MESSAGES_SRC = path.join(__dirname, '..', '_locales', 'ja', 'messages.json');

/**
 * ストア素材レンダリング用の chrome.* API shim 内容を生成する。
 *
 * popup.html の CSP `script-src 'self'` 配下で実行できるよう、インライン script ではなく
 * 同階層の `popup-shim.js` として外部ファイル化する。actions.js / popup.js より先に
 * 実行されるよう、popup-render.html では `<head>` に挿入する。
 *
 * shim では:
 *   - storage は空オブジェクトを返す → 全マスタートグル OFF（install 既定状態）
 *   - tabs.query はダミー http タブを返す → 「このページでは使えません」エラーを抑制
 *   - runtime.sendMessage は常に `{ ok: true }` を返す
 *     → 音量スライダーは storage 空 → DEFAULT (100%) のまま
 *   - **i18n は `_locales/ja/messages.json` を焼き込んで実際に解決する**
 *     popup.html の静的テキストは日本語 fallback を持つので i18n 無しでも写るが、
 *     popup.js が `createElement` で組む文字列（調整タブのサブタブ名など）は
 *     fallback を持たない。i18n を欠くとそこが空欄のままストア素材に写り込むため、
 *     実メッセージを解決する（過去に調整タブのサブタブが空欄で撮れていた）。
 */
function buildPopupShimContent() {
  const messages = JSON.parse(fs.readFileSync(MESSAGES_SRC, 'utf-8'));
  return `// ストア素材レンダリング用 chrome.* API shim（generate-screenshots.js が生成、
// 実拡張機能では Chrome がネイティブに提供）。編集は generate-screenshots.js 側で行う。
const MESSAGES = ${JSON.stringify(messages)};

// chrome.i18n.getMessage 互換。$NAME$ プレースホルダを placeholders 定義の $1 / $2 …
// で substitutions に対応付けて置換する（Chrome の実装と同じ解決順）。
function getMessage(key, substitutions) {
  const entry = MESSAGES[key];
  if (!entry || typeof entry.message !== "string") return "";
  const subs = substitutions == null
    ? []
    : (Array.isArray(substitutions) ? substitutions : [substitutions]);
  let out = entry.message;
  const placeholders = entry.placeholders || {};
  for (const [name, def] of Object.entries(placeholders)) {
    const m = /^\\$(\\d+)$/.exec(String(def && def.content));
    const value = m ? (subs[Number(m[1]) - 1] ?? "") : String((def && def.content) ?? "");
    out = out.replace(new RegExp("\\\\$" + name + "\\\\$", "gi"), value);
  }
  return out.replace(/\\$(\\d+)/g, (_, i) => subs[Number(i) - 1] ?? "");
}

window.chrome = {
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  runtime: {
    sendMessage: () => Promise.resolve({ ok: true }),
    onMessage: { addListener: () => {}, removeListener: () => {} },
    getURL: (p) => new URL('../' + p, window.location.href).href,
    id: "mock-render-extension",
    lastError: null,
  },
  tabs: {
    query: () => Promise.resolve([{ id: 1, url: "https://example.com/", active: true, windowId: 1 }]),
  },
  i18n: {
    getMessage,
    getUILanguage: () => "ja",
  },
};
`;
}

/**
 * `src/popup/popup.html` を読んで chrome.* API shim と相対パス調整を施した
 * `webstore/popup-render.html` を生成する。`popup-shim.js` も同時に書き出す。
 *
 * これにより 01-popup-ui.html が iframe で実 popup を埋め込めるようになり、
 * popup.html / popup.css / popup.js の変更が即ストア素材に反映される（drift ゼロ）。
 *
 * popup.html の CSP `script-src 'self'` を満たすため、shim は inline ではなく
 * 同階層の `popup-shim.js` として配置し、`<script src="popup-shim.js">` で参照する。
 */
function generatePopupRenderHtml() {
  // shim を外部ファイルとして書き出し（CSP `script-src 'self'` を満たすため）。
  fs.writeFileSync(POPUP_SHIM_DST, buildPopupShimContent());

  let html = fs.readFileSync(POPUP_HTML_SRC, 'utf-8');

  // 相対パス調整: `src/popup/popup.html` → `webstore/popup-render.html` へ移すと
  // 隣接リソースの相対パスがずれるため、すべて webstore からの相対パスに書き換える。
  html = html.replace(/\b(href|src)="([^"]+)"/g, (attribute, name, value) => {
    // SVG symbol・外部 URL・絶対パスは移動しても参照先が変わらない。
    if (/^(?:#|\/|[a-z][a-z\d+.-]*:)/i.test(value)) return attribute;
    const source = path.resolve(path.dirname(POPUP_HTML_SRC), value);
    const relative = path.relative(path.dirname(POPUP_RENDER_DST), source).split(path.sep).join('/');
    return `${name}="${relative}"`;
  });

  // chrome.* API shim を <head> 末尾に注入（外部 JS ファイル参照、CSP 準拠）。
  // actions.js / popup.js より先に <head> 内で読み込まれるため shim が確実に先行する。
  const shimTag = `  <script src="popup-shim.js"></script>\n`;
  html = html.replace('</head>', `${shimTag}</head>`);

  fs.writeFileSync(POPUP_RENDER_DST, html);
  console.log(`📝 popup-render.html / popup-shim.js を生成`);
}

// HTMLテンプレートから生成する画像
const HTML_CONFIGS = [
  // スクリーンショット：1280x800
  {
    input: path.join(TEMPLATE_DIR, '01-popup-ui.html'),
    output: '01-popup-ui-1280x800.png',
    width: 1280,
    height: 800,
    type: 'screenshot'
  },
  {
    input: path.join(TEMPLATE_DIR, '02-features.html'),
    output: '02-features-1280x800.png',
    width: 1280,
    height: 800,
    type: 'screenshot'
  },
  {
    input: path.join(TEMPLATE_DIR, '03-hero-promo.html'),
    output: '03-hero-promo-1280x800.png',
    width: 1280,
    height: 800,
    type: 'screenshot'
  },

  // プロモーション タイル（小）：440x280
  {
    input: path.join(TEMPLATE_DIR, '04-promo-small.html'),
    output: 'promo-small-440x280.png',
    width: 440,
    height: 280,
    type: 'promo-small'
  },

  // マーキー プロモーション タイル：1400x560
  {
    input: path.join(TEMPLATE_DIR, '05-promo-marquee.html'),
    output: 'promo-marquee-1400x560.png',
    width: 1400,
    height: 560,
    type: 'promo-marquee'
  }
];

/**
 * 共有ブラウザインスタンスを使用してHTMLファイルから画像を生成
 */
async function generateScreenshot(browser, baseUrl, htmlPath, outputPath, width, height) {
  // 並列撮影とページ終了が同じコンテキストの撮影ロックを取り合わないよう分離する。
  const context = await browser.createBrowserContext();

  try {
    const page = await context.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // ストア素材は「初期インストール時の典型的見た目」をユーザーに伝えるため
    // ライトモード強制でレンダリングする。OS のダークモード設定を継承すると
    // popup.css の prefers-color-scheme:dark 経路が走り、和紙ベージュ背景が
    // 墨色背景に置き換わる（実機では正しい挙動だがマーケティング素材としては不適切）。
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: 'light' },
    ]);

    const relativePath = path.relative(path.join(__dirname, '..'), htmlPath).split(path.sep).join('/');
    await page.goto(new URL(relativePath, baseUrl).href, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // フォント・絵文字のレンダリング完了を待機
    await page.evaluate(() => document.fonts.ready);

    await page.screenshot({
      path: outputPath,
      type: 'png',
      omitBackground: false,
      clip: {
        x: 0,
        y: 0,
        width: width,
        height: height
      }
    });

    console.log(`✅ 生成完了: ${outputPath} (${width}x${height})`);
  } catch (error) {
    console.error(`❌ エラー: ${htmlPath} -> ${outputPath}`);
    console.error(error);
    // throw で Promise.all を reject させて main().catch → process.exit(1) へ伝播させる。
    // 握りつぶすと壊れた画像のまま CI が success 扱いになり、ストア申請 ZIP に混入しうる。
    throw error;
  } finally {
    await context.close();
  }
}

function findChromeExecutable() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium');
  }

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

// file:// では module と crossorigin フォントが CORS で拒否されるため、
// 同梱素材だけを loopback で配信する。外部インターフェースには公開しない。
async function startPreviewServer() {
  const root = path.resolve(__dirname, '..');
  const templates = new Set(HTML_CONFIGS.map(config => path.relative(root, config.input).split(path.sep).join('/')));
  templates.add('webstore/popup-render.html');
  templates.add('webstore/popup-shim.js');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = http.createServer((request, response) => {
    let file;
    try {
      file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    } catch {
      response.writeHead(400).end();
      return;
    }
    const relative = path.relative(root, file);
    const resource = relative.split(path.sep).join('/');
    const allowed = templates.has(resource)
      || /^src\/popup\/(?:[^/.]+\.(?:js|css)|fonts\/[^/.]+\.woff2)$/.test(resource)
      || /^src\/lib\/(?:actions|settings-backup)\.js$/.test(resource)
      || /^src\/shared\/kagayoi-support-[^/.]+\.(?:js|css)$/.test(resource);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !allowed) {
      response.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, body) => {
      if (error) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      response.end(body);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/` };
}

/**
 * メイン処理
 */
async function main() {
  console.log('🎨 Chrome Web Store用スクリーンショットを生成中...\n');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 01-popup-ui.html が iframe で読み込む popup-render.html を popup.html から動的生成。
  // popup.html 変更時に自動追従し、ストア素材の drift を防ぐ。
  generatePopupRenderHtml();

  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 300000
  };
  const executablePath = findChromeExecutable();
  if (executablePath) {
    launchOptions.executablePath = executablePath;
    console.log(`🧭 ローカル Chrome を使用します: ${executablePath}`);
  }

  const browser = await puppeteer.launch(launchOptions);
  let preview;

  try {
    preview = await startPreviewServer();
    // 複数ページを並列生成（Puppeteer の page は独立しているため CPU 競合のみ）。
    // 絵文字レンダリングが重いため concurrency を 2 に絞って過負荷を回避する。
    const CONCURRENCY = 2;
    const queue = [...HTML_CONFIGS];
    const runWorker = async () => {
      while (queue.length > 0) {
        const config = queue.shift();
        if (!config) break;
        const outputPath = path.join(OUTPUT_DIR, config.output);
        await generateScreenshot(browser, preview.baseUrl, config.input, outputPath, config.width, config.height);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, runWorker));
  } finally {
    try {
      await browser.close();
    } finally {
      if (preview) await new Promise(resolve => preview.server.close(resolve));
    }
  }

  console.log('\n✨ すべての画像生成が完了しました！');
  console.log(`\n📂 生成された画像は ${OUTPUT_DIR} ディレクトリにあります。`);
  console.log('\n📋 生成された画像一覧:');

  const files = fs.readdirSync(OUTPUT_DIR);
  files.forEach(file => {
    const filePath = path.join(OUTPUT_DIR, file);
    const stats = fs.statSync(filePath);
    const sizeKB = (stats.size / 1024).toFixed(2);
    console.log(`   - ${file} (${sizeKB} KB)`);
  });

  console.log('\n📝 Chrome Web Storeアップロード仕様:');
  console.log('   ✓ スクリーンショット: 1280x800 または 640x400');
  console.log('   ✓ プロモーション タイル（小）: 440x280');
  console.log('   ✓ マーキー プロモーション タイル: 1400x560');
  console.log('   ✓ 形式: PNG (24ビット、アルファなし)');
}

main().catch(error => {
  console.error('❌ エラーが発生しました:', error);
  process.exit(1);
});
