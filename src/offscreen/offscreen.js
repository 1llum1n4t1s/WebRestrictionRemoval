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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  if (msg?.action === "readClipboard") {
    readClipboard().then(sendResponse);
    return true; // 非同期 sendResponse のためメッセージチャネルを保持
  }
  return false;
});
