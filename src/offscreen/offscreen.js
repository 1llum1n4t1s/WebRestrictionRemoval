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
 * AudioState の構造（ノードチェーン: source → normalizerAnalyzer → normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination）:
 *   - ctx: AudioContext
 *   - gainNode: GainNode（ユーザースライダーの 0-300% ブースト）
 *   - normalizerAnalyzer: AnalyserNode（自動音量正規化の短時間RMS測定）
 *   - normalizerGainNode: GainNode（測定値から自動調整するラウドネス補正）
 *   - nightModeNode: DynamicsCompressorNode（ゲーム配信向けナイトモード圧縮、OFF 時はバイパス設定）
 *   - antiClipNode: DynamicsCompressorNode（自動歪み防止 / リミッタ、OFF 時はバイパス設定）
 *   - stream: MediaStream
 *
 * 自動音量正規化はコンプレッサーではなく、短時間RMSを目標値へ寄せる自動 GainNode として動く。
 * ナイトモード / 自動歪み防止の compressor は常時チェーン接続し、OFF 時は ratio:1 のバイパス設定にする。
 */
const audioStates = new Map();
/** @type {Map<number, Promise<{ctx: AudioContext, gainNode: GainNode, normalizerAnalyzer: AnalyserNode, normalizerGainNode: GainNode, normalizerBuffer: Float32Array, normalizerTimer: number|null, normalizeEnabled: boolean, normalizerTargetGain: number, nightModeNode: DynamicsCompressorNode, antiClipNode: DynamicsCompressorNode, stream: MediaStream, lastSetPercent: number}>>} */
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

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function clampNormalizerGain(gain) {
  const minGain = dbToGain(VolumeBooster.NORMALIZE_MIN_GAIN_DB);
  const maxGain = dbToGain(VolumeBooster.NORMALIZE_MAX_GAIN_DB);
  if (!Number.isFinite(gain)) return 1;
  return Math.min(maxGain, Math.max(minGain, gain));
}

function scheduleNormalizerGain(state, targetGain) {
  const clamped = clampNormalizerGain(targetGain);
  const now = state.ctx.currentTime;
  const previousTarget = Number.isFinite(state.normalizerTargetGain)
    ? state.normalizerTargetGain
    : 1;
  const timeConstant = clamped < previousTarget
    ? VolumeBooster.NORMALIZE_GAIN_DOWN_TIME_CONSTANT
    : VolumeBooster.NORMALIZE_GAIN_UP_TIME_CONSTANT;
  state.normalizerGainNode.gain.cancelScheduledValues(now);
  state.normalizerGainNode.gain.setValueAtTime(state.normalizerGainNode.gain.value, now);
  state.normalizerGainNode.gain.setTargetAtTime(clamped, now, timeConstant);
  state.normalizerTargetGain = clamped;
}

function tickLoudnessNormalizer(state) {
  if (!state.normalizeEnabled) return;
  const buffer = state.normalizerBuffer;
  state.normalizerAnalyzer.getFloatTimeDomainData(buffer);

  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    sum += buffer[i] * buffer[i];
  }
  const rms = Math.sqrt(sum / buffer.length);
  const silenceGate = dbToGain(VolumeBooster.NORMALIZE_SILENCE_GATE_DB);
  if (!Number.isFinite(rms)) return;
  if (rms < silenceGate) {
    scheduleNormalizerGain(state, 1);
    return;
  }

  const targetRms = dbToGain(VolumeBooster.NORMALIZE_TARGET_RMS_DB);
  scheduleNormalizerGain(state, targetRms / rms);
}

function startLoudnessNormalizer(state) {
  if (state.normalizerTimer !== null) return;
  tickLoudnessNormalizer(state);
  state.normalizerTimer = setInterval(
    () => tickLoudnessNormalizer(state),
    VolumeBooster.NORMALIZE_UPDATE_MS
  );
}

function stopLoudnessNormalizer(state) {
  if (state.normalizerTimer !== null) {
    clearInterval(state.normalizerTimer);
    state.normalizerTimer = null;
  }
}

function updateLoudnessNormalizer(state, enabled) {
  state.normalizeEnabled = enabled === true;
  if (state.normalizeEnabled) {
    startLoudnessNormalizer(state);
  } else {
    stopLoudnessNormalizer(state);
    scheduleNormalizerGain(state, 1);
  }
}

/**
 * 指定タブの GainNode 値と compressor 設定を反映する。未登録なら getUserMedia → AudioContext を構築する。
 *
 * @param {number} tabId 対象タブ ID
 * @param {string} streamId chrome.tabCapture.getMediaStreamId が返した stream ID
 * @param {number} gainPercent 0-300 の整数（％）
 * @param {boolean} antiClip 自動歪み防止 ON/OFF
 * @param {boolean} normalize 自動音量正規化 ON/OFF
 * @param {boolean} nightMode ナイトモード圧縮 ON/OFF
 * @returns {Promise<{ok: boolean, gain?: number, error?: string}>}
 */
async function volumeSetGain(tabId, streamId, gainPercent, antiClip, normalize, nightMode) {
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
      // P3-#23: 制御文字・空白・非 ASCII を含まない印字可能 ASCII のみ許可する保守的検証。
      // chrome.tabCapture.getMediaStreamId の戻り値は内部生成 ID で印字可能 ASCII の範囲に
      // 収まる（UUID 様 + コロン区切り等）。過去に厳格な `^[a-zA-Z0-9_:.\-]{8,256}$` で誤拒否
      // が出た経緯があるため、ここでは「制御文字・空白を含まない」「長さが妥当」程度に緩める。
      // 万一 background 経由で不正な streamId が混入してもこの段階で拒否でき、防御を一段増やす。
      if (!/^[\x21-\x7e]{4,1024}$/.test(streamId)) {
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
    updateLoudnessNormalizer(state, normalize === true);
    applyCompressorPreset(
      state.nightModeNode,
      nightMode === true ? VolumeBooster.NIGHT_MODE_PRESET : VolumeBooster.COMPRESSOR_BYPASS,
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
    const normalizerAnalyzer = ctx.createAnalyser();
    const normalizerGainNode = ctx.createGain();
    const gainNode = ctx.createGain();
    // ノード順序: ラウドネス正規化（測定 + 自動 gain）→ ナイトモード（コンプ）
    // → ブースト（gain）→ 自動歪み防止（リミッタ）の直列接続。
    // 正規化は「音源全体の平均的な音量」を先に整え、ナイトモードはその後で瞬間的な大小差を狭める。
    normalizerAnalyzer.fftSize = 2048;
    normalizerGainNode.gain.value = 1;
    const nightModeNode = ctx.createDynamicsCompressor();
    const antiClipNode = ctx.createDynamicsCompressor();
    applyCompressorPreset(nightModeNode, VolumeBooster.COMPRESSOR_BYPASS);
    applyCompressorPreset(antiClipNode, VolumeBooster.COMPRESSOR_BYPASS);
    source.connect(normalizerAnalyzer);
    normalizerAnalyzer.connect(normalizerGainNode);
    normalizerGainNode.connect(nightModeNode);
    nightModeNode.connect(gainNode);
    gainNode.connect(antiClipNode);
    antiClipNode.connect(ctx.destination);

    // lastSetPercent は volumeGetGain の応答値として使う（gain.value はランプ中で
    // ターゲット値と一致しないため、ユーザーが意図したスライダー位置を保持する）。
    const state = {
      ctx,
      gainNode,
      normalizerAnalyzer,
      normalizerGainNode,
      normalizerBuffer: new Float32Array(normalizerAnalyzer.fftSize),
      normalizerTimer: null,
      normalizeEnabled: false,
      normalizerTargetGain: 1,
      nightModeNode,
      antiClipNode,
      stream,
      lastSetPercent: VolumeBooster.UNITY,
    };
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
    stopLoudnessNormalizer(state);
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
      stopLoudnessNormalizer(state);
      state.stream?.getTracks().forEach((t) => t.stop());
      // P3-#20: `AudioContext.close()` は Promise を返すが、`pagehide` ハンドラから同期的に
      // 呼ばれるため await 不可。fire-and-forget で発射するだけで十分（offscreen document
      // 自体が破棄されるため、close 完了を待たなくても OS リソースは GC される）。
      // `volumeReleaseTab` 経路では await しているのと意図的に異なる。
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
    volumeSetGain(
      msg.tabId,
      msg.streamId,
      msg.gain,
      msg.antiClip,
      msg.normalize,
      msg.nightMode
    ).then(sendResponse);
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
