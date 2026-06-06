"use strict";

/**
 * audio-pipeline.js — 音量ブースター DSP コア関数共有モジュール
 *
 * /rere B1-004 / B2-I001 / D-001 修正で抽出した共通モジュール。
 * 当初は `src/content/volume-booster.js` (旧 MES 経路、普通サイト) と
 * `src/offscreen/offscreen.js` (tabCapture 経路) の両方で同じ 8 関数を物理コピーで保持しており、
 * その drift 解消が抽出動機だった。**MES 経路は撤去済み (音量ブースターは tabCapture 一本に戻した)**
 * ため、現在の caller は offscreen.js のみ。単一 caller 向けの DSP モジュールとして残している。
 *
 * 本モジュールは `src/offscreen/offscreen.js` から `globalThis.AudioPipeline` 経由で参照される。
 * 値定数は actions.js の `VolumeBooster` を経由 (既存集約場所)、
 * DSP フロー制御ロジックのみを本モジュールに集約する。
 *
 * 設計判断:
 *   - state オブジェクト (`{ ctx, normalizerGainNode, normalizerAnalyzer, normalizerBuffer,
 *     normalizerTimer, normalizeEnabled, normalizerTargetGain, normalizerSmoothedRms }`) は caller 側が構築する
 *     (両 caller で 6 ノードチェーン構築は微妙に違うため、本モジュールは「state を受け取って
 *     DSP 制御する」純粋関数群に責務を絞る)
 *   - 6 ノードチェーン構築自体は caller 側に残す (source タイプが MediaElement vs MediaStream で
 *     異なるため)
 *
 * 二重ロード許容: 各 content_scripts エントリ + offscreen.html で個別ロードされても
 * `__cpaAudioPipelineLoaded` ガードで 2 回目以降は即 return する (actions.js と同じパターン)。
 */

(() => {
  if (globalThis.__cpaAudioPipelineLoaded === true) return;
  globalThis.__cpaAudioPipelineLoaded = true;

  /**
   * デシベル値 → 振幅倍率 (gain)。`Math.pow(10, db/20)` の標準変換。
   * 例: dbToGain(6) ≈ 2 (= +6dB = 2 倍)、dbToGain(-6) ≈ 0.5。
   */
  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  /**
   * 自動正規化 gain を VolumeBooster.NORMALIZE_MIN_GAIN_DB / MAX_GAIN_DB の範囲に clamp。
   * Number でないときは安全値 1 を返す (UNITY、無処理)。
   */
  function clampNormalizerGain(gain) {
    const minGain = dbToGain(VolumeBooster.NORMALIZE_MIN_GAIN_DB);
    const maxGain = dbToGain(VolumeBooster.NORMALIZE_MAX_GAIN_DB);
    if (!Number.isFinite(gain)) return 1;
    return Math.min(maxGain, Math.max(minGain, gain));
  }

  /**
   * `state.normalizerGainNode.gain` を target gain にランプ予約する。
   *
   * Dead zone: 通常 tick 経由ではターゲットの差が NORMALIZE_DEAD_ZONE_DB 未満なら更新をスキップ。
   * これで RMS の細かい揺れによる ±数 dB のポンピングを止め、BGM のうねりを耳から消す。
   * `options.force === true` (機能 OFF 時の 1.0x 復帰など) のときは dead zone を無視して必ず適用する。
   *
   * 同じ target への再 schedule はスキップ (`clamped === previousTarget` の早期 return)。
   * silence-gate 経路は 400ms 毎に force=true で unity (1) を要求してくるが、既に target=1 で
   * settled (`state.normalizerTargetGain === 1`) なら早期 return でスキップする。これで「同じ
   * target への重複 schedule」を構造的に止め、ramp が毎 tick 再 schedule されて settle しない
   * 罠を回避する (元 Codex P2 指摘 2026-05-08)。
   *
   * 現行 ramp 設計は UP=2.5s < DOWN=3.0s (actions.js NORMALIZE_GAIN_*_TIME_CONSTANT)。
   * 「上げる方が速く、下げる方がゆっくり」の非対称で、急な大音量からはゆっくり守りつつ
   * 小音源は素早く適切音量へ持ち上げる方針。silence からの復帰 (clamped > previousTarget) は
   * UP=2.5s、boost 中→silence への遷移 (clamped < previousTarget) は DOWN=3.0s が選ばれる。
   *
   * @param {object} state - { ctx, normalizerGainNode, normalizerTargetGain }
   * @param {number} targetGain 目標ゲイン倍率（clamp 前）
   * @param {{force?: boolean}} [options] force=true で dead zone を無視して必ず更新する。
   */
  function scheduleNormalizerGain(state, targetGain, options) {
    const clamped = clampNormalizerGain(targetGain);
    const now = state.ctx.currentTime;
    const previousTarget = Number.isFinite(state.normalizerTargetGain)
      ? state.normalizerTargetGain
      : 1;
    if (options?.force !== true && previousTarget > 0 && clamped > 0) {
      const deltaDb = Math.abs(20 * Math.log10(clamped / previousTarget));
      if (deltaDb < VolumeBooster.NORMALIZE_DEAD_ZONE_DB) return;
    }
    if (clamped === previousTarget) return;
    const timeConstant = clamped < previousTarget
      ? VolumeBooster.NORMALIZE_GAIN_DOWN_TIME_CONSTANT
      : VolumeBooster.NORMALIZE_GAIN_UP_TIME_CONSTANT;
    state.normalizerGainNode.gain.cancelScheduledValues(now);
    state.normalizerGainNode.gain.setValueAtTime(state.normalizerGainNode.gain.value, now);
    state.normalizerGainNode.gain.setTargetAtTime(clamped, now, timeConstant);
    state.normalizerTargetGain = clamped;
  }

  /**
   * 1 tick 分の RMS 測定 → normalizer gain 更新。
   * `normalizerTimer` から setInterval で呼ばれる経路と、`startLoudnessNormalizer` での初回手動 tick の
   * 2 経路がある。
   *
   * 静寂/ノイズ区間 (rms < NORMALIZE_SILENCE_GATE_DB) は必ず UNITY (1.0x) に強制復帰する。dead zone を
   * 無視するため force=true。dead zone 経由だと「直前の正規化が +1.58 dB 未満の boost で settled」の
   * ときに unity 復帰 (1.0 vs 1.2 の差 ~1.58 dB) が dead zone 内で skip されて、ノイズ区間が古い gain で
   * 増幅されたままになる罠を回避する (Codex P2 指摘)。
   */
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
    // 無音/ノイズ区間は即 unity 復帰。**瞬間 rms と平滑値 (smoothedRms) の二重判定** で、
    // 瞬間 rms の揺れが gate を一瞬下回るだけ (= 通常音声中のディップ) ではスキップしない設計。
    // 両方が gate 下のときだけ「確実な無音」と判定して unity 復帰、片方だけなら EMA 経路に流す。
    // これにより「ON にして 10 秒で boost 到達 → 瞬間 rms が gate を割って force UNITY → 即下がる」
    // タイプのチャタリング (silence gate 跨ぎポンピング) を根絶する。
    // 平滑値は最後の有効音の値を保持しリセットしない (句間の度にリセットすると喋り再開ごとに
    // 追従がやり直しになり効かなくなる)。初回 tick (prevSmoothed が null/NaN) は瞬間 rms ベース
    // fallback で従来通り動作 → initial silence もちゃんと拾える。
    const prevSmoothed = state.normalizerSmoothedRms;
    const prevFinite = Number.isFinite(prevSmoothed);
    if (rms < silenceGate && (!prevFinite || prevSmoothed < silenceGate)) {
      scheduleNormalizerGain(state, 1, { force: true });
      return;
    }

    // 瞬間 RMS は測定窓内でも tick 間でも揺れるため、EMA で平滑化して動画全体のラウドネスを安定推定する。
    // これをしないと「うるさい/小さい動画でも targetGain がほぼ 1 に丸まる」(効かない) 問題が出る。
    const alpha = VolumeBooster.NORMALIZE_RMS_SMOOTHING;
    const smoothedRms = prevFinite
      ? alpha * rms + (1 - alpha) * prevSmoothed
      : rms;
    state.normalizerSmoothedRms = smoothedRms;

    const targetRms = dbToGain(VolumeBooster.NORMALIZE_TARGET_RMS_DB);
    scheduleNormalizerGain(state, targetRms / smoothedRms);
  }

  /**
   * 自動正規化 ON 化。`normalizerTimer` が既に動いていれば no-op。初回 tick を即時実行してから
   * NORMALIZE_UPDATE_MS 間隔で setInterval を開始する。
   */
  function startLoudnessNormalizer(state) {
    if (state.normalizerTimer !== null) return;
    tickLoudnessNormalizer(state);
    state.normalizerTimer = setInterval(
      () => tickLoudnessNormalizer(state),
      VolumeBooster.NORMALIZE_UPDATE_MS
    );
  }

  /** 自動正規化 OFF 化。timer 停止のみで、gain ramp は呼び出し側が必要に応じて行う。 */
  function stopLoudnessNormalizer(state) {
    if (state.normalizerTimer !== null) {
      clearInterval(state.normalizerTimer);
      state.normalizerTimer = null;
    }
  }

  /**
   * 自動正規化サブトグルの ON/OFF を反映。
   * OFF 化時は dead zone を無視して即時 1.0x へ ramp する (force=true)。dead zone が効いてしまうと
   * OFF 後も僅かなブースト/減衰が残り、ユーザーが意図したスルー状態にならない。
   */
  function updateLoudnessNormalizer(state, enabled) {
    state.normalizeEnabled = enabled === true;
    if (state.normalizeEnabled) {
      startLoudnessNormalizer(state);
    } else {
      stopLoudnessNormalizer(state);
      scheduleNormalizerGain(state, 1, { force: true });
    }
  }

  /**
   * DynamicsCompressor preset を node に適用 (5 パラメータ一括設定)。
   * VolumeBooster.COMPRESSOR_NIGHT_MODE / COMPRESSOR_ANTI_CLIP / COMPRESSOR_BYPASS のいずれか。
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
    dbToGain,
    clampNormalizerGain,
    scheduleNormalizerGain,
    tickLoudnessNormalizer,
    startLoudnessNormalizer,
    stopLoudnessNormalizer,
    updateLoudnessNormalizer,
    applyCompressorPreset,
  });
})();
