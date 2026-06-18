"use strict";

/**
 * audio-pipeline.js — 音量ブースター DSP コア関数共有モジュール
 *
 * /rere B1-004 / B2-I001 / D-001 修正で抽出した共通モジュール。
 * 当初は旧 MES 経路 (content script) と offscreen.js (tabCapture 経路) で同じ DSP 関数群を
 * 物理コピーで保持しており、その drift 解消が抽出動機だった。
 * **MES 経路 + 自動音量正規化は撤去済み** のため現在の caller は offscreen.js のみ。
 * 提供するのは dB→gain 変換 / compressor preset 適用 / グラフィックイコライザ適用の 3 関数。
 * 共有モジュール構造は Firefox MV3 が tabCapture / offscreen に catch-up したときの再利用に
 * 備えて維持している (globalThis.AudioPipeline 公開定数の 1 つとしてカウント済み)。
 *
 * 値定数は actions.js の `VolumeBooster` を経由 (既存集約場所)。
 *
 * 二重ロード許容: offscreen.html で個別ロードされても
 * `__cpaAudioPipelineLoaded` ガードで 2 回目以降は即 return する (actions.js と同じパターン)。
 */

(() => {
  if (globalThis.__cpaAudioPipelineLoaded === true) return;
  globalThis.__cpaAudioPipelineLoaded = true;

  /**
   * デシベル値 → 振幅倍率 (gain)。`Math.pow(10, db/20)` の標準変換。
   * 例: dbToGain(6) ≈ 2 (= +6dB = 2 倍)、dbToGain(-6) ≈ 0.5。
   * イコライザのプリアンプ (dB 指定の全体 GainNode) で使用する。
   */
  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  /**
   * DynamicsCompressor preset を node に適用 (5 パラメータ一括設定)。
   * VolumeBooster.NIGHT_MODE_PRESET / ANTI_CLIP_PRESET / COMPRESSOR_BYPASS のいずれか。
   * preset 切替頻度が低くアタックが速い (1〜50ms) ため setTargetAtTime ramp 不要、`.value =`
   * 直接代入で十分。BYPASS preset (ratio:1, threshold/knee 中立) で素通り化が実現でき、
   * ノードを disconnect/reconnect する経路 (= 一瞬無音化 + プチノイズ) を回避する。
   */
  function applyCompressorPreset(node, preset) {
    node.threshold.value = preset.threshold;
    node.knee.value = preset.knee;
    node.ratio.value = preset.ratio;
    node.attack.value = preset.attack;
    node.release.value = preset.release;
  }

  /**
   * グラフィックイコライザ (10 バンド peaking + プリアンプ) を state に適用する。
   *
   * `state.preampNode` (GainNode) と `state.eqFilters` (BiquadFilterNode[10]) は caller (offscreen)
   * がチェーン構築時に生成済み。本関数はそれらの gain を ramp で更新するだけ。
   * - プリアンプ: dB → 倍率に変換して GainNode に設定。OFF 時は unity (1.0)。
   * - 各バンド: BiquadFilterNode.gain は peaking で dB 単位なのでスライダー値をそのまま設定。
   *   OFF 時は 0dB (= フラット = 素通り)。チェーン上は常時接続のまま gain でバイパス制御する
   *   (compressor の COMPRESSOR_BYPASS と同じ思想で、ノード抜き差しによる無音/プチノイズを避ける)。
   *
   * gain 直接代入はサンプル境界の不連続でクリックを生むため、`cancelScheduledValues` →
   * `setValueAtTime(現在値)` → `setTargetAtTime(target, now, τ)` の 3 点セットで ramp する
   * (周波数特性が連続変化する EQ ではスライダー追従時の段差ノイズ防止に必須)。
   *
   * @param {object} state - { ctx, preampNode, eqFilters }
   * @param {boolean} enabled イコライザ ON/OFF
   * @param {number[]} gains 10 バンドの gain (dB, VolumeBooster.EQ_BANDS と同順)
   * @param {number} preamp プリアンプ (dB)
   */
  function applyEqualizer(state, enabled, gains, preamp) {
    const on = enabled === true;
    const now = state.ctx.currentTime;
    const tc = VolumeBooster.RAMP_TIME_CONSTANT;
    const preampGain = dbToGain(on ? VolumeBooster.clampEqPreamp(preamp) : 0);
    state.preampNode.gain.cancelScheduledValues(now);
    state.preampNode.gain.setValueAtTime(state.preampNode.gain.value, now);
    state.preampNode.gain.setTargetAtTime(preampGain, now, tc);
    const clamped = VolumeBooster.clampEqGains(gains);
    for (let i = 0; i < state.eqFilters.length; i += 1) {
      const f = state.eqFilters[i];
      const target = on ? clamped[i] : 0;
      f.gain.cancelScheduledValues(now);
      f.gain.setValueAtTime(f.gain.value, now);
      f.gain.setTargetAtTime(target, now, tc);
    }
  }

  globalThis.AudioPipeline = Object.freeze({
    dbToGain,
    applyCompressorPreset,
    applyEqualizer,
  });
})();
