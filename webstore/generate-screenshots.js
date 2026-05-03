// Chrome Web Store用のスクリーンショット画像を自動生成するスクリプト
// HTMLテンプレートからPuppeteerで生成
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ディレクトリパス
const TEMPLATE_DIR = __dirname;
const OUTPUT_DIR = path.join(__dirname, 'images');
const POPUP_HTML_SRC = path.join(__dirname, '..', 'src', 'popup', 'popup.html');
const POPUP_RENDER_DST = path.join(__dirname, 'popup-render.html');

/**
 * `src/popup/popup.html` を読んで chrome.* API shim と相対パス調整を施した
 * `webstore/popup-render.html` を生成する。
 *
 * これにより 01-popup-ui.html が iframe で実 popup を埋め込めるようになり、
 * popup.html / popup.css / popup.js の変更が即ストア素材に反映される（drift ゼロ）。
 *
 * shim では:
 *   - storage は空オブジェクトを返す → 全マスタートグル OFF（install 既定状態）
 *   - tabs.query はダミー http タブを返す → 「このページでは使えません」エラーを抑制
 *   - runtime.sendMessage は VOLUME_BOOSTER_GET_GAIN に対し `{ gain: null }` を返す
 *     → 音量スライダーは DEFAULT (100%) のまま
 */
function generatePopupRenderHtml() {
  let html = fs.readFileSync(POPUP_HTML_SRC, 'utf-8');

  // 相対パス調整: `src/popup/popup.html` → `webstore/popup-render.html` へ移すと
  // 隣接リソースの相対パスがずれるため、すべて webstore からの相対パスに書き換える。
  html = html
    .replace(/href="popup\.css"/g, 'href="../src/popup/popup.css"')
    .replace(/src="\.\.\/lib\/actions\.js"/g, 'src="../src/lib/actions.js"')
    .replace(/src="popup\.js"/g, 'src="../src/popup/popup.js"');

  // chrome.* API shim を <head> 末尾に注入（actions.js / popup.js より先に実行される）。
  const shim = `
  <script>
    // ストア素材レンダリング用 shim（実拡張機能では Chrome がネイティブに提供）。
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
        sendMessage: (msg) => {
          if (msg && msg.action === "volumeBoosterGetGain") return Promise.resolve({ gain: null });
          return Promise.resolve({ ok: true });
        },
        onMessage: { addListener: () => {}, removeListener: () => {} },
        getURL: (p) => p,
        id: "mock-render-extension",
        lastError: null,
      },
      tabs: {
        query: () => Promise.resolve([{ id: 1, url: "https://example.com/", active: true, windowId: 1 }]),
      },
    };
  </script>
`;
  html = html.replace('</head>', `${shim}</head>`);

  fs.writeFileSync(POPUP_RENDER_DST, html);
  console.log(`📝 popup-render.html を生成: ${POPUP_RENDER_DST}`);
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
async function generateScreenshot(browser, htmlPath, outputPath, width, height) {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // ストア素材は「初期インストール時の典型的見た目」をユーザーに伝えるため
    // ライトモード強制でレンダリングする。OS のダークモード設定を継承すると
    // popup.css の prefers-color-scheme:dark 経路が走り、和紙ベージュ背景が
    // 墨色背景に置き換わる（実機では正しい挙動だがマーケティング素材としては不適切）。
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: 'light' },
    ]);

    const absolutePath = path.resolve(htmlPath);
    await page.goto(`file://${absolutePath}`, {
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
    await page.close();
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

  try {
    // 複数ページを並列生成（Puppeteer の page は独立しているため CPU 競合のみ）。
    // 絵文字レンダリングが重いため concurrency を 2 に絞って過負荷を回避する。
    const CONCURRENCY = 2;
    const queue = [...HTML_CONFIGS];
    const runWorker = async () => {
      while (queue.length > 0) {
        const config = queue.shift();
        if (!config) break;
        const outputPath = path.join(OUTPUT_DIR, config.output);
        await generateScreenshot(browser, config.input, outputPath, config.width, config.height);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, runWorker));
  } finally {
    await browser.close();
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
