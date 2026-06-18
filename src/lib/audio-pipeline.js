"use strict";

/**
 * audio-pipeline.js — 音量ブースター DSP コア関数共有モジュール
 *
 * /rere B1-004 / B2-I001 / D-001 修正で抽出した共通モジュール。
 * 当初は旧 MES 経路 (content script) と offscreen.js (tabCapture 経路) で同じ DSP 関数群を
 * 物理コピーで保持しており、その drift 解消が抽出動機だった。
 * **MES 経路は撤去済み (音量ブースターは tabCapture 一本に戻した)**、さらに
 * **自動音量正規化サブ機能も撤去済み (現実的でないため削除)** のため、現在の caller は
 * offscreen.js のみ、提供するのは compressor preset 適用 1 関数のみとなった。
 * 共有モジュール構造は Firefox MV3 が tabCapture / offscreen に catch-up したときの再利用に
 * 備えて残している (globalThis.AudioPipeline 公開定数の 1 つとしてカウント済み)。
 *
 * 本モジュールは `src/offscreen/offscreen.js` から `globalThis.AudioPipeline` 経由で参照される。
 * 値定数 (NIGHT_MODE_PRESET / ANTI_CLIP_PRESET / COMPRESSOR_BYPASS) は actions.js の
 * `VolumeBooster` を経由 (既存集約場所)。
 *
 * 二重ロード許容: offscreen.html で個別ロードされても
 * `__cpaAudioPipelineLoaded` ガードで 2 回目以降は即 return する (actions.js と同じパターン)。
 */

(() => {
  if (globalThis.__cpaAudioPipelineLoaded === true) return;
  globalThis.__cpaAudioPipelineLoaded = true;

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

  globalThis.AudioPipeline = Object.freeze({
    applyCompressorPreset,
  });
})();
