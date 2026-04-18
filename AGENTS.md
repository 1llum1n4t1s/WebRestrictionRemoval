# AGENTS.md

This file provides guidance to Codex (and other AI agents) when working with code in this repository.

## Overview

Chrome extension (Manifest V3) — 右クリック・テキスト選択の制限を自動解除。右クリックメニューから強制ペースト・強制コピーが可能。サイレントモードで対象イベント (`contextmenu`, `selectstart`, `dragstart`) をキャプチャフェーズで `stopImmediatePropagation`。

## Commands

**Build:** `npm install && node scripts/generate-icons.js`
**Package:** `.\zip.ps1` (Windows) / `./zip.sh` (Linux/macOS) → `web-restriction-remover.zip`

## Directory Structure (統一規約)

```
manifest.json
icons/
src/
├── popup/
├── background/
├── content/             # content.js + content.css
└── lib/
    └── actions.js       # 共通定数 (Actions / StorageKeys / SilentUnlock 等)
scripts/                 # ビルドツール
webstore/
.github/workflows/
```

## Architecture

- **`src/background/background.js`** — `chrome.contextMenus` で「強制ペースト/コピー」を提供。ENABLED トグルに応じて content script に APPLY_SETTINGS_CS を中継
- **`src/content/content.js`** — `SilentUnlock.EVENTS` のキャプチャブロック + インラインハンドラ除去（メインワールド注入）+ CSS class 付与による select 解除
- **`src/lib/actions.js`** — `Actions` / `StorageKeys` / `ContextMenuIds` / `SilentUnlock` を `Object.freeze` で定義

## Conventions

- 単一トグル `StorageKeys.ENABLED` で全機能の有効/無効を制御
- インラインハンドラ除去はメインワールド経由（chrome.scripting.executeScript with world: 'MAIN'）
