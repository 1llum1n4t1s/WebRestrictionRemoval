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
 * tabId → AudioState の Map。AudioContext は close するまで音声を増幅し続けるため
 * release 時に必ず close する。
 *
 * AudioState の構造（ノードチェーン: source → gainNode → normalizerNode → antiClipNode → destination）:
 *   - ctx: AudioContext
 *   - gainNode: GainNode（ユーザースライダーの 0-600% ブースト）
 *   - normalizerNode: DynamicsCompressorNode（自動音量正規化、OFF 時はバイパス設定）
 *   - antiClipNode: DynamicsCompressorNode（自動歪み防止 / リミッタ、OFF 時はバイパス設定）
 *   - stream: MediaStream
 *
 * 両 compressor は常時チェーン接続したまま、OFF 時は ratio:1 のバイパス設定で実質パススルー化。
 * disconnect/reconnect を避けることでトグル切替時の音切れリスクを排除。
 */
const audioStates = new Map();
/** @type {Map<number, Promise<{ctx: AudioContext, gainNode: GainNode, normalizerNode: DynamicsCompressorNode, antiClipNode: DynamicsCompressorNode, stream: MediaStream}>>} */
const audioInitPromises = new Map();

/**
 * DynamicsCompressorNode に preset を適用する。
 * 機能 OFF 時は VolumeBooster.COMPRESSOR_BYPASS（ratio:1）を渡してパススルー化する。
 */
function applyCompressorPreset(node, preset) {
  node.threshold.value = preset.threshold;
  node.knee.value = preset.knee;
  node.ratio.value = preset.ratio;
  node.attack.value = preset.attack;
  node.release.value = preset.release;
}

/**
 * 指定タブの GainNode 値と compressor 設定を反映する。未登録なら getUserMedia → AudioContext を構築する。
 *
 * @param {number} tabId 対象タブ ID
 * @param {string} streamId chrome.tabCapture.getMediaStreamId が返した stream ID
 * @param {number} gainPercent 0-600 の整数（％）
 * @param {boolean} antiClip 自動歪み防止 ON/OFF
 * @param {boolean} normalize 自動音量正規化 ON/OFF
 * @returns {Promise<{ok: boolean, gain?: number, error?: string}>}
 */
async function volumeSetGain(tabId, streamId, gainPercent, antiClip, normalize) {
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

    // 対数マッピングで実 gain を算出 → setTargetAtTime で 45ms ramp。
    // 直接 `.value =` 代入だとプチノイズが乗るため必ず ramp 経由にする。
    // cancelScheduledValues で古いランプ予約を破棄してから現在値を anchor し新しいランプを開始。
    const clamped = VolumeBooster.clampValue(gainPercent);
    const targetGain = VolumeBooster.percentToGain(clamped);
    const now = state.ctx.currentTime;
    state.gainNode.gain.cancelScheduledValues(now);
    state.gainNode.gain.setValueAtTime(state.gainNode.gain.value, now);
    state.gainNode.gain.setTargetAtTime(targetGain, now, VolumeBooster.RAMP_TIME_CONSTANT);
    // ユーザーが意図したスライダー位置を保持（gain.value はランプ中で別値）。
    state.lastSetPercent = clamped;
    // 既存ノードのプロパティを書き換えるだけなので AudioContext 再構築は不要。トグル切替時も音切れなし。
    applyCompressorPreset(
      state.normalizerNode,
      normalize === true ? VolumeBooster.NORMALIZE_PRESET : VolumeBooster.COMPRESSOR_BYPASS,
    );
    applyCompressorPreset(
      state.antiClipNode,
      antiClip === true ? VolumeBooster.ANTI_CLIP_PRESET : VolumeBooster.COMPRESSOR_BYPASS,
    );
    return { ok: true, gain: clamped };
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
    // 自動音量正規化（緩い圧縮）→ 自動歪み防止（リミッタ）の直列接続。
    // 音響工学のセオリーに従い「平均化してからピーク抑制」の順で並べる。
    // 両 compressor は volumeSetGain で OFF 時にバイパス設定 (ratio:1) に切り替えるので
    // 機能 OFF 時もチェーン上に残したまま実質パススルー化する（disconnect/reconnect の音切れ回避）。
    const normalizerNode = ctx.createDynamicsCompressor();
    const antiClipNode = ctx.createDynamicsCompressor();
    applyCompressorPreset(normalizerNode, VolumeBooster.COMPRESSOR_BYPASS);
    applyCompressorPreset(antiClipNode, VolumeBooster.COMPRESSOR_BYPASS);
    source.connect(gainNode);
    gainNode.connect(normalizerNode);
    normalizerNode.connect(antiClipNode);
    antiClipNode.connect(ctx.destination);

    // lastSetPercent は volumeGetGain の応答値として使う（gain.value はランプ中で
    // ターゲット値と一致しないため、ユーザーが意図したスライダー位置を保持する）。
    const state = { ctx, gainNode, normalizerNode, antiClipNode, stream, lastSetPercent: VolumeBooster.UNITY };
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
  // gain.value はランプ中の中間値になり得るため、ユーザーが最後に指定した
  // スライダー percent を返す。round-trip 誤差ゼロでスライダー位置を再現できる。
  return { gain: state.lastSetPercent };
}

async function volumeReleaseTab(tabId) {
  const pending = audioInitPromises.get(tabId);
  if (pending) {
    try { await pending; } catch {}
    // B1-B3 修正: pending を await し終えたら必ず Map から削除する。
    // volumeSetGain の finally 経路では削除されるが、release 経由では削除漏れになり
    // Map に古い完了済み Promise が残留してメモリリークの種になる。
    if (audioInitPromises.get(tabId) === pending) {
      audioInitPromises.delete(tabId);
    }
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
  // B1-B4 修正: pending な初期化 Promise も clear する。
  // offscreen が再作成されても新規 Map になるためリークではないが、現インスタンスの
  // shutdown 中に getUserMedia が解決した場合の宙吊り Promise を明示的に切る。
  audioInitPromises.clear();
}
// 3-C3 修正: Chrome 140+ では `unload` は非推奨で bfcache を無効化する。
// `pagehide` のみで cleanup は十分（offscreen document は extension context だが
// 将来の Chrome 仕様変更に備えて pagehide のみで運用する）。
window.addEventListener("pagehide", cleanupAllAudio);

// ============================================================
// メッセージハンドラ
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!SenderCheck.isFromBackground(sender)) return false;
  if (msg?.target !== Offscreen.TARGET) return false;

  if (msg.action === Offscreen.ACTION_VOLUME_SET_GAIN) {
    volumeSetGain(msg.tabId, msg.streamId, msg.gain, msg.antiClip, msg.normalize).then(sendResponse);
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
