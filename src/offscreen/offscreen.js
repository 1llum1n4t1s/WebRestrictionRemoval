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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  if (msg?.action === "readClipboard") {
    readClipboard().then(sendResponse);
    return true; // 非同期 sendResponse のためメッセージチャネルを保持
  }
  if (msg?.action === "writeClipboard") {
    writeClipboard(msg?.text ?? "").then(sendResponse);
    return true;
  }
  return false;
});
