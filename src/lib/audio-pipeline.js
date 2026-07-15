"use strict";

/**
 * audio-pipeline.js — 音量ブースター DSP コア関数共有モジュール
 *
 * /rere B1-004 / B2-I001 / D-001 修正で抽出した共通モジュール。
 * 当初は旧 MES 経路 (content script) と offscreen.js (tabCapture 経路) で同じ DSP 関数群を
 * 物理コピーで保持しており、その drift 解消が抽出動機だった。
 * 現在の caller は 2 つ:
 *   - offscreen.js — Chrome の tabCapture 経路 (Chrome では唯一の音量ブースター経路)
 *   - volume-booster-mes.js — Firefox 専用 MES 経路 (manifest.firefox.json のみから注入。
 *     2026-07-02 に Firefox 専用パイプラインとして復活。「Firefox catch-up に備えて共有
 *     モジュール構造を維持する」判断がここで活きた)
 * 提供するのは dB→gain 変換 / compressor・filter preset 適用 / bass cut・EQ チェーン構築 / EQ 適用
 * (自動音量正規化の normalizer 関数群は撤去済み)。
 *
 * 値定数は actions.js の `VolumeBooster` を経由 (既存集約場所)。
 *
 * 二重ロード許容: offscreen.html / manifest content_scripts で個別ロードされても
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
   * 1個以上の BiquadFilterNode (type 固定、frequency/Q のみ可変) に preset を適用する。
   * VolumeBooster.BASS_CUT_PRESET / BASS_CUT_BYPASS のいずれか。applyCompressorPreset と同じ思想:
   * 切替頻度が低いため ramp 不要で `.value =` 直接代入で十分、BYPASS (frequency:0) で
   * 素通り化してノードの disconnect/reconnect による音切れを避ける。
   * 単一 node も受け付け、旧 caller との互換性を保つ。
   */
  function applyFilterPreset(nodeOrNodes, preset) {
    const nodes = Array.isArray(nodeOrNodes) ? nodeOrNodes : [nodeOrNodes];
    for (const node of nodes) {
      node.frequency.value = preset.frequency;
      node.Q.value = preset.Q;
    }
  }

  /**
   * 壁ドン対策用 highpass チェーンを構築する。
   * 2次 Butterworth を BASS_CUT_STAGES 段直列化し、150Hz 未満を 24dB/oct で減衰させる。
   * caller は head/tail を上下のノードへ接続し、設定変更時は bassCutNodes 全体へ preset を適用する。
   *
   * @param {AudioContext} ctx
   * @returns {{bassCutNodes: BiquadFilterNode[], head: AudioNode, tail: AudioNode}}
   */
  function createBassCutChain(ctx) {
    const bassCutNodes = Array.from({ length: VolumeBooster.BASS_CUT_STAGES }, () => {
      const node = ctx.createBiquadFilter();
      node.type = "highpass";
      return node;
    });
    for (let i = 1; i < bassCutNodes.length; i += 1) {
      bassCutNodes[i - 1].connect(bassCutNodes[i]);
    }
    applyFilterPreset(bassCutNodes, VolumeBooster.BASS_CUT_BYPASS);
    return {
      bassCutNodes,
      head: bassCutNodes[0],
      tail: bassCutNodes[bassCutNodes.length - 1],
    };
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
    // 防御的: state.eqFilters と clamped の長さ不一致 (将来のバンド数変更 / 予期せぬ初期化エラー) で
    // target が undefined → NaN になり setTargetAtTime が例外を吐く事故を避ける。両配列の最小長で
    // ループし、clamped[i] が undefined のときは 0dB (素通り) フォールバック。
    const clamped = VolumeBooster.clampEqGains(gains);
    const limit = Math.min(state.eqFilters.length, clamped.length);
    for (let i = 0; i < limit; i += 1) {
      const f = state.eqFilters[i];
      const target = on ? (clamped[i] ?? 0) : 0;
      f.gain.cancelScheduledValues(now);
      f.gain.setValueAtTime(f.gain.value, now);
      f.gain.setTargetAtTime(target, now, tc);
    }
  }

  /**
   * EQ チェーン (preampNode + 10 バンド peaking BiquadFilterNode) を ctx 上で構築する。
   * caller (offscreen.js) は head/tail を見て上下のノードに connect するだけで済むよう、
   * チェーン構築の DSP 知識を applyEqualizer と同じファイルに集約する。
   *
   * @param {AudioContext} ctx
   * @returns {{preampNode: GainNode, eqFilters: BiquadFilterNode[], head: AudioNode, tail: AudioNode}}
   */
  function createEqChain(ctx) {
    const preampNode = ctx.createGain();
    const eqFilters = VolumeBooster.EQ_BANDS.map((freq) => {
      const f = ctx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = freq;
      f.Q.value = VolumeBooster.EQ_Q;
      f.gain.value = 0;
      return f;
    });
    let tail = preampNode;
    for (const f of eqFilters) {
      tail.connect(f);
      tail = f;
    }
    return { preampNode, eqFilters, head: preampNode, tail };
  }

  /**
   * 音量ブースターの最上位 DSP グラフを共通順序で接続する。
   * 各チェーン内部の接続は createEqChain / createBassCutChain が担当し、本関数は
   * caller 間で drift しやすい6本の境界接続だけを単一情報源にする。
   *
   * @param {{
   *   source: AudioNode,
   *   eqChain: {head: AudioNode, tail: AudioNode},
   *   nightModeNode: AudioNode,
   *   gainNode: AudioNode,
   *   bassCutChain: {head: AudioNode, tail: AudioNode},
   *   antiClipNode: AudioNode,
   *   destination: AudioNode,
   * }} graph
   */
  function connectAudioGraph(graph) {
    graph.source.connect(graph.eqChain.head);
    graph.eqChain.tail.connect(graph.nightModeNode);
    graph.nightModeNode.connect(graph.gainNode);
    graph.gainNode.connect(graph.bassCutChain.head);
    graph.bassCutChain.tail.connect(graph.antiClipNode);
    graph.antiClipNode.connect(graph.destination);
  }

  globalThis.AudioPipeline = Object.freeze({
    dbToGain,
    applyCompressorPreset,
    applyFilterPreset,
    createBassCutChain,
    applyEqualizer,
    createEqChain,
    connectAudioGraph,
  });
})();
