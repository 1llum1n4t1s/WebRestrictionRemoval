/**
 * Offscreen Document の役割:
 *   音量ブースター — chrome.tabCapture で取得した MediaStream を AudioContext に流し、
 *   GainNode で増幅して再出力する。AudioContext / GainNode は extension コンテキストで
 *   生かす必要があるため、service worker（再起動で消える）ではなく offscreen に置く。
 *
 * 「制限解除」機能（強制ペースト/コピー）の削除に伴い、クリップボード処理は
 * offscreen からも除去済み。reasons は USER_MEDIA + AUDIO_PLAYBACK のみ。
 */

"use strict";

// ============================================================
// 音量ブースター（USER_MEDIA + AUDIO_PLAYBACK reasons）
// ============================================================

/**
 * tabId → { ctx: AudioContext, gainNode: GainNode, stream: MediaStream } の Map。
 * AudioContext は close するまで音声を増幅し続けるため、release 時に必ず close する。
 */
const audioStates = new Map();
/** @type {Map<number, Promise<{ctx: AudioContext, gainNode: GainNode, stream: MediaStream}>>} */
const audioInitPromises = new Map();

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
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return { ok: false, error: "invalid-tab-id" };
    }

    let state = audioStates.get(tabId);
    const pending = audioInitPromises.get(tabId);
    if (!state && pending) {
      try {
        state = await pending;
      } catch {
        state = audioStates.get(tabId);
      }
    }

    if (!state) {
      if (!streamId || typeof streamId !== "string") {
        return { ok: false, error: "invalid-stream-id" };
      }

      // chromeMediaSource: "tab" で getUserMedia するパターン。
      // 旧 Chrome は mandatory ネスト形式のみを受理し、新 Chrome はフラット形式 + mandatory の両方を
      // 受理するが、tab capture の場合は実質 mandatory ネストが必須なので mandatory を先に試す。
      const initPromise = createAudioState(tabId, streamId);
      audioInitPromises.set(tabId, initPromise);
      try {
        state = await initPromise;
      } finally {
        if (audioInitPromises.get(tabId) === initPromise) {
          audioInitPromises.delete(tabId);
        }
      }
    }

    state.gainNode.gain.value = VolumeBooster.clampValue(gainPercent) / 100;
    return { ok: true, gain: Math.round(state.gainNode.gain.value * 100) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

async function createAudioState(tabId, streamId) {
  let stream = null;
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      });
    } catch {
      // 念のためフラット形式にもフォールバック
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { chromeMediaSourceId: streamId },
        video: false,
      });
    }

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const gainNode = ctx.createGain();
    // mediaSource → gainNode → destination のシンプルな 3 ノード構成。
    // 音質変更（BiquadFilter / Analyser）は機能スコープ外のため省略し、純粋な GainNode で増幅。
    source.connect(gainNode);
    gainNode.connect(ctx.destination);

    const state = { ctx, gainNode, stream };
    audioStates.set(tabId, state);
    return state;
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop());
    throw err;
  }
}

function volumeGetGain(tabId) {
  const state = audioStates.get(tabId);
  if (!state) return { gain: null };
  return { gain: Math.round(state.gainNode.gain.value * 100) };
}

async function volumeReleaseTab(tabId) {
  const pending = audioInitPromises.get(tabId);
  if (pending) {
    try { await pending; } catch {}
  }
  const state = audioStates.get(tabId);
  if (!state) return { ok: true };
  audioStates.delete(tabId);
  try {
    state.stream?.getTracks().forEach((t) => t.stop());
    await state.ctx.close();
  } catch {
    // close 失敗は致命的ではない（既に閉じている可能性）
  }
  return { ok: true };
}

async function volumeReleaseAll() {
  const ids = Array.from(audioStates.keys());
  await Promise.all(ids.map((id) => volumeReleaseTab(id)));
  return { ok: true };
}

function volumeQueryActive() {
  return { activeCount: audioStates.size };
}

// ============================================================
// ライフサイクル: offscreen 強制 close 時の cleanup
// ============================================================
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
  if (!SenderCheck.isFromBackground(sender)) return false;
  if (msg?.target !== Offscreen.TARGET) return false;

  if (msg.action === Offscreen.ACTION_VOLUME_SET_GAIN) {
    volumeSetGain(msg.tabId, msg.streamId, msg.gain).then(sendResponse);
    return true;
  }
  if (msg.action === Offscreen.ACTION_VOLUME_GET_GAIN) {
    sendResponse(volumeGetGain(msg.tabId));
    return false;
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
