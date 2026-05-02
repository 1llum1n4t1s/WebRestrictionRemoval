/**
 * Offscreen Document の役割:
 *   1. クリップボード読み書き — content script が http:// 等の非 secure context で動作する場合、
 *      navigator.clipboard.{readText,writeText} は reject される。
 *      chrome-extension:// の offscreen document は常に secure context なので
 *      ここで操作し、background 経由で content script に返す。
 *   2. 音量ブースター — chrome.tabCapture で取得した MediaStream を AudioContext に流し、
 *      GainNode で増幅して再出力する。AudioContext / GainNode は extension コンテキストで
 *      生かす必要があるため、service worker（再起動で消える）ではなく offscreen に置く。
 *
 * Chrome は 1 拡張機能あたり 1 offscreen document しか開けないため、両機能を同居させる。
 * ライフサイクルは background 側で制御: 音量ブースト中タブが 1 つでもあれば close しない。
 */

"use strict";

// ============================================================
// クリップボード（CLIPBOARD reasons）
// ============================================================

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

// ============================================================
// 音量ブースター（USER_MEDIA + AUDIO_PLAYBACK reasons）
// ============================================================

/**
 * tabId → { ctx: AudioContext, gainNode: GainNode, stream: MediaStream } の Map。
 * AudioContext は close するまで音声を増幅し続けるため、release 時に必ず close する。
 */
const audioStates = new Map();

/**
 * 指定タブの GainNode 値を設定する。未登録なら getUserMedia → AudioContext を構築する。
 *
 * @param {number} tabId 対象タブ ID
 * @param {string} streamId chrome.tabCapture.getMediaStreamId が返した stream ID
 * @param {number} gainPercent 0-600 の整数（％）
 * @returns {Promise<{ok: boolean, gain?: number, error?: string}>}
 */
async function volumeSetGain(tabId, streamId, gainPercent) {
  try {
    let state = audioStates.get(tabId);
    if (!state) {
      // streamId 形式検証 (#15): 想定外の値 (NaN, 空文字, 制御文字混入) を getUserMedia に
      // 流す前に拒否する。chrome.tabCapture.getMediaStreamId が返す ID は英数記号のみ。
      if (
        !streamId ||
        typeof streamId !== "string" ||
        !/^[a-zA-Z0-9_:.\-]{8,256}$/.test(streamId)
      ) {
        return { ok: false, error: "invalid-stream-id" };
      }

      // chromeMediaSource: "tab" で getUserMedia するパターン。
      // mandatory.chromeMediaSourceId は廃止予定なので、まずフラット形式 (chromeMediaSourceId
      // をトップレベルに置く新形式) を試して、失敗したら mandatory ネストにフォールバックする。
      // 旧 Chrome では mandatory のみ受け付け、新 Chrome ではどちらも受け付ける挙動。
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { chromeMediaSourceId: streamId },
          video: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: streamId,
            },
          },
          video: false,
        });
      }

      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const gainNode = ctx.createGain();
      // mediaSource → gainNode → destination のシンプルな 3 ノード構成。
      // 元拡張は BiquadFilter / Analyser を挟んでいたが Equalizer 機能は除外したため省略。
      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      state = { ctx, gainNode, stream };
      audioStates.set(tabId, state);
    }

    // gainPercent / 100 で 1.0 = 等倍、6.0 = 6 倍ブースト。
    // VolumeBooster.clampValue を使って actions.js の MIN/MAX/DEFAULT と単一情報源を共有。
    state.gainNode.gain.value = VolumeBooster.clampValue(gainPercent) / 100;
    return { ok: true, gain: Math.round(state.gainNode.gain.value * 100) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** 指定タブの現在 gain（％）を返す。未登録なら null。 */
function volumeGetGain(tabId) {
  const state = audioStates.get(tabId);
  if (!state) return { gain: null };
  return { gain: Math.round(state.gainNode.gain.value * 100) };
}

/** 指定タブの AudioContext を解放してマップから削除。再生中の音声は等倍に戻る。 */
async function volumeReleaseTab(tabId) {
  const state = audioStates.get(tabId);
  if (!state) return { ok: true };
  audioStates.delete(tabId);
  try {
    // ストリームの track を全停止 → AudioContext を close。順序は重要:
    // close を先に呼ぶと、生きているソースから出力先が無いタイミングが生じてエラーになり得る。
    state.stream?.getTracks().forEach((t) => t.stop());
    await state.ctx.close();
  } catch {
    // close 失敗は致命的ではない（既に閉じている可能性）
  }
  return { ok: true };
}

/** 全タブを解放。master OFF 時に呼ぶ。 */
async function volumeReleaseAll() {
  const ids = Array.from(audioStates.keys());
  await Promise.all(ids.map((id) => volumeReleaseTab(id)));
  return { ok: true };
}

/** 現在 boost 中のタブ数を返す（background のアイドル close 判定に使う）。 */
function volumeQueryActive() {
  return { activeCount: audioStates.size };
}

// 旧 clampGain は VolumeBooster.clampValue に統合（DRY 違反 #2 解消）。
// 数値クランプの単一情報源は actions.js 側にある。

// ============================================================
// ライフサイクル: offscreen 強制 close 時の cleanup
// ============================================================
//
// SW 強制終了や Chrome の独立クローズで offscreen がアンロードされる際、
// MediaStreamTrack.stop() と AudioContext.close() が呼ばれずに tabCapture セッションが
// ブラウザレベルで残存するリスクがある。pagehide / unload で全 audioStates を解放する。
function cleanupAllAudio() {
  for (const state of audioStates.values()) {
    try {
      state.stream?.getTracks().forEach((t) => t.stop());
      state.ctx?.close();
    } catch {
      // 既に閉じている等は無視
    }
  }
  audioStates.clear();
}
window.addEventListener("pagehide", cleanupAllAudio);
window.addEventListener("unload", cleanupAllAudio);

// ============================================================
// メッセージハンドラ
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // offscreen document へのメッセージは background (Service Worker) 由来のみ許可する。
  // 検証ロジックは actions.js の SenderCheck.isFromBackground に集約。
  // popup / 他 content script から offscreen を直接叩く抜け道を塞ぐ二層防御。
  if (!SenderCheck.isFromBackground(sender)) return false;
  if (msg?.target !== Offscreen.TARGET) return false;

  // ---- クリップボード ----
  if (msg.action === Offscreen.ACTION_READ) {
    readClipboard().then(sendResponse);
    return true;
  }
  if (msg.action === Offscreen.ACTION_WRITE) {
    writeClipboard(msg?.text ?? "").then(sendResponse);
    return true;
  }

  // ---- 音量ブースター ----
  if (msg.action === Offscreen.ACTION_VOLUME_SET_GAIN) {
    volumeSetGain(msg.tabId, msg.streamId, msg.gain).then(sendResponse);
    return true;
  }
  if (msg.action === Offscreen.ACTION_VOLUME_GET_GAIN) {
    sendResponse(volumeGetGain(msg.tabId));
    return false; // 同期 response 完了
  }
  if (msg.action === Offscreen.ACTION_VOLUME_RELEASE_TAB) {
    volumeReleaseTab(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === Offscreen.ACTION_VOLUME_RELEASE_ALL) {
    volumeReleaseAll().then(sendResponse);
    return true;
  }
  if (msg.action === Offscreen.ACTION_VOLUME_QUERY_ACTIVE) {
    sendResponse(volumeQueryActive());
    return false;
  }

  return false;
});
