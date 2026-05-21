/**
 * ESLint Flat Config (v9+ 形式)
 *
 * 旧 `.eslintrc.json` から移行 (/opop Phase 1 で MN-4 適用、2026-05-19)。
 * v9 で flat config が標準化されたため、`.eslintrc.*` 系は廃止。
 *
 * 設計方針:
 * - `src/` の IIFE + globalThis 公開 20 定数を明示列挙 (no-implicit-globals 違反を防ぎつつ、
 *   actions.js が公開する定数を読み取り専用 global として承認する)
 * - `scripts/` / `webstore/generate-screenshots.js` は Node ESM/CJS 環境
 * - `test/` は Node 標準 test runner 環境
 */

const globals = require("globals");

const ACTIONS_GLOBALS = {
  // src/lib/actions.js が globalThis に公開する 20 個。
  // 新規 globalThis 公開を追加したら本リストにも追加すること。
  SettingsSchema: "readonly",
  Actions: "readonly",
  ExtensionPaths: "readonly",
  SenderCheck: "readonly",
  Offscreen: "readonly",
  StorageKeys: "readonly",
  KeepAlive: "readonly",
  YouTubeShorts: "readonly",
  SearchFixer: "readonly",
  AmazonDeliveryTotal: "readonly",
  AmazonRankingJump: "readonly",
  InstagramCleaner: "readonly",
  TikTokCleaner: "readonly",
  ImageDownloader: "readonly",
  VolumeBooster: "readonly",
  VideoGamma: "readonly",
  VideoFill: "readonly",
  Loupe: "readonly",
  ColorPicker: "readonly",
  PopupTabs: "readonly",
};

const COMMON_RULES = {
  // ESLint v9 で `no-implicit-globals` が top-level function declarations も検出するようになり、
  // 既存 IIFE 設計の影響で 48 件エラー化した。全ファイル IIFE wrap 化はスコープ外のため warn に降格し、
  // 将来の IIFE wrap タスクで段階的に解消する方針 (CLAUDE.md D-004 の延長)。
  "no-implicit-globals": "warn",
  "no-undef": "error",
  "no-unused-vars": [
    "warn",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
};

module.exports = [
  {
    // ignorePatterns に相当 (flat config では files/ignores で指定)
    ignores: [
      "node_modules/**",
      "dist/**",
      "webstore/images/**",
      "webstore/popup-render.html",
      "webstore/popup-shim.js",
      "firefox-build/**",
      "web-ext-artifacts/**",
      "temp/**",
      "temp-build/**",
      "cxcx-out/**",
      "**/*.min.js",
    ],
  },
  {
    // 拡張機能本体 (src/): ブラウザ + WebExtensions + globalThis 公開定数
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
        browser: "readonly",
        importScripts: "readonly",
        EyeDropper: "readonly",
        __cpaEarlyFramework: "readonly",
        ...ACTIONS_GLOBALS,
      },
    },
    rules: COMMON_RULES,
  },
  {
    // テスト: Node 標準 test runner + actions.js グローバル参照経路を許可
    files: ["test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.node,
        ...ACTIONS_GLOBALS,
      },
    },
    rules: COMMON_RULES,
  },
  {
    // ビルドスクリプト: Node ESM (.mjs) + CJS スクリプト
    files: [
      "scripts/**/*.mjs",
      "scripts/generate-icons.js",
      "webstore/generate-screenshots.js",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: COMMON_RULES,
  },
  {
    // Puppeteer の page.evaluate(() => document.fonts.ready) は callback 内がブラウザ context
    // で動くため、ESLint には外側スコープでも document を許可しておく必要がある
    files: ["webstore/generate-screenshots.js"],
    languageOptions: {
      globals: {
        document: "readonly",
      },
    },
  },
];
