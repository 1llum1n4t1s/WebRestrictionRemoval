/**
 * Offscreen Document の役割:
 *   content script が http:// 等の非 secure context で動作する場合、
 *   navigator.clipboard.readText() は reject される。
 *   chrome-extension:// の offscreen document は常に secure context なので
 *   ここでクリップボードを読み取り、background 経由で content script に返す。
 */

"use strict";

async function readClipboard() {
  // 1. Async Clipboard API を優先
  try {
    const text = await navigator.clipboard.readText();
    return { ok: true, text };
  } catch {}
  // 2. フォールバック: 一時 textarea + execCommand("paste")
  try {
    const ta = document.getElementById("clip");
    if (ta) {
      ta.focus();
      ta.value = "";
      const ok = document.execCommand("paste");
      if (ok) return { ok: true, text: ta.value };
    }
  } catch {}
  return { ok: false, text: "" };
}

async function writeClipboard(text) {
  // 1. Async Clipboard API を優先
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch {}
  // 2. フォールバック: 一時 textarea + execCommand("copy")
  //    （offscreen document は extension context なのでサイト側の copy ブロッカーの影響を受けない）
  try {
    const ta = document.getElementById("clip");
    if (ta) {
      ta.value = text;
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      if (ok) return { ok: true };
    }
  } catch {}
  return { ok: false };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // offscreen document へのメッセージは background (Service Worker) 由来のみ許可する。
  // background の isFromContentScript ゲートを経由せずに offscreen を直接叩く抜け道
  // （同一拡張内の popup / 他 content script からの直接送信）を塞ぐ二層防御。
  // - sender.id === chrome.runtime.id: 同一拡張のコンテキスト
  // - !sender.tab: content script 由来を弾く（content script には sender.tab.id がある）
  // - sender.url が background SW の URL: popup / 他 offscreen 等の extension ページを弾く
  const expectedBackgroundUrl = chrome.runtime.getURL("src/background/background.js");
  if (
    sender?.id !== chrome.runtime.id ||
    sender?.tab ||
    sender?.url !== expectedBackgroundUrl
  ) {
    return false;
  }
  if (msg?.target !== Offscreen.TARGET) return false;
  if (msg?.action === Offscreen.ACTION_READ) {
    readClipboard().then(sendResponse);
    return true; // 非同期 sendResponse のためメッセージチャネルを保持
  }
  if (msg?.action === Offscreen.ACTION_WRITE) {
    writeClipboard(msg?.text ?? "").then(sendResponse);
    return true;
  }
  return false;
});
