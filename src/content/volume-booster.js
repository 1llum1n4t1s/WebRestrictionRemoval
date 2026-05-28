"use strict";

/**
 * 音量ブースター content script (MediaElementSource 方式)。
 *
 * 全 http(s) ページの全フレームに注入され、`<video>` / `<audio>` 要素に対して
 * MediaElementSource + 6 ノードチェーン (`source → normalizerAnalyzer →
 * normalizerGainNode → nightModeNode → gainNode → antiClipNode → destination`)
 * を attach して音量を補正する。`chrome.tabCapture` を使う旧経路と違って **user
 * gesture 不要** で自動適用できる。
 *
 * 旧 offscreen + tabCapture 経路は EME 保護動画 (Netflix / Prime Video 等) で
 * MediaElementSource が無音化する場合のフォールバックとして将来再利用する想定。
 *
 * 設計上の不変条件:
 *   - `<video>` / `<audio>` 1 要素に対して 1 AudioContext を作り、WeakMap で
 *     state を保持する。同じ要素への二重 attach は MediaElementSource API 仕様で
 *     例外になるため、WeakMap.has() で必ずガードする。
 *   - EME 保護動画は `video.mediaKeys != null` または `encrypted` event で検出し、
 *     attach をスキップする (silent 化を防ぐ + 将来 fallback の検出点)。
 *   - Cross-origin video で MediaElementSource attach 後に音が消える既知問題が
 *     あるため、attach 直後の `try/catch` で例外時は AudioContext を破棄する。
 *   - master OFF / unity (100% かつ全サブトグル OFF かつ muted OFF) では
 *     既存 AudioContext を解放して完全 no-op に戻す。
 *   - storage.onChanged で音量関連 6 キーの変化を監視し、即座に全 state へ反映する。
 *   - MutationObserver で動的追加される video/audio 要素にも追従する。
 *   - extension context invalidation guard (`chrome.runtime?.id` チェック) で
 *     拡張機能リロード後の orphan 化を検知し、observer 停止 + 全 state 解放する。
 *
 * 二重実行防止: `window.__cpaVolumeBoosterRunning` で同一フレーム内の重複起動を弾く。
 */

(() => {
  if (window.__cpaVolumeBoosterRunning === true) return;
  window.__cpaVolumeBoosterRunning = true;

  // EME (DRM) 多用サイト (Netflix / Prime Video / DAZN / Disney+ 等) では MediaElementSource を
  // attach すると動画の音そのものが完全無音化する仕様のため、起動自体を skip する。
  // 該当サイトでは popup 経由の旧 tabCapture 経路で boost する設計 (popup 必須)。
  // 判定リストは actions.js の VolumeBooster.EME_HOSTS に集約 (popup と共有)。
  if (VolumeBooster.isEmeHost(location.hostname)) {
    return;
  }

  // WeakMap<HTMLMediaElement, AudioState> で video/audio → state を管理。
  // WeakMap なので要素が DOM から消えれば GC で自動解放される。
  const STATE = new WeakMap();
  // EME 保護で attach 不可と判定した要素を記録 (二重判定スキップ)。
  const EME_DETECTED = new WeakSet();
  // attach 試行中フラグ (二重 attach の race 防止)。
  const ATTACHING = new WeakSet();

  /** @type {{enabled: boolean, gain: number, antiClip: boolean, normalize: boolean, nightMode: boolean, muted: boolean}} */
  let currentSettings = {
    enabled: false,
    gain: VolumeBooster.DEFAULT,
    antiClip: false,
    normalize: false,
    nightMode: false,
    muted: false,
  };

  // ============================================================
  // DSP コア関数: AudioPipeline (src/lib/audio-pipeline.js) から取得
  // /rere B1-004/B2-I001/D-001 修正: 旧実装は offscreen.js と同 8 関数を物理コピーで持ち、
  // 「片方を更新したら必ず他方も同期する」を人間運用に依存していた。drift 既発のため、
  // src/lib/audio-pipeline.js に集約して 1 ソースから両 caller (MES 経路 / EME fallback 経路) に
  // 配布する。値定数は actions.js の VolumeBooster (既存集約場所) を経由。
  // ============================================================
  const { dbToGain, scheduleNormalizerGain, tickLoudnessNormalizer,
          startLoudnessNormalizer, stopLoudnessNormalizer,
          updateLoudnessNormalizer, applyCompressorPreset } = AudioPipeline;

  // ============================================================
  // AudioContext + 6 ノードチェーン構築
  // ============================================================

  /**
   * UNITY release 判定: gain 100% + 全サブトグル OFF + muted OFF なら AudioContext 不要。
   * 旧 offscreen 経路の `releaseVolumeBoosterTab` 早期 return と同じ条件。
   */
  function isUnityRelease(settings) {
    return settings.gain === VolumeBooster.UNITY
      && !settings.antiClip
      && !settings.normalize
      && !settings.nightMode
      && !settings.muted;
  }

  /**
   * media 要素に attach して 6 ノードチェーンを構築。EME / cross-origin で attach 失敗した
   * 場合は EME_DETECTED に登録して以後スキップ。
   */
  function attachToMedia(media) {
    if (!(media instanceof HTMLMediaElement)) return;
    if (STATE.has(media) || EME_DETECTED.has(media) || ATTACHING.has(media)) return;
    if (media.mediaKeys != null) {
      EME_DETECTED.add(media);
      return;
    }
    ATTACHING.add(media);

    let ctx = null;
    let source = null;
    try {
      ctx = new AudioContext();
      source = ctx.createMediaElementSource(media);
    } catch (err) {
      // MediaElementSource 失敗 = 既に他の AudioContext に attach 済み or EME
      // 同じ video 要素に MES は 1 度だけしか attach できないため、サイト側 player が
      // 自前で MES を使っている場合 (まれ) もここに来る。EME と区別できないので
      // 安全側で EME_DETECTED 扱いにする。
      ATTACHING.delete(media);
      EME_DETECTED.add(media);
      if (ctx) ctx.close().catch(() => {});
      return;
    }

    // EME 後発検出: 再生開始時に EME 開始するケース (DRM 保護動画)
    const onEncrypted = () => {
      EME_DETECTED.add(media);
      detachFromMedia(media);
    };
    media.addEventListener("encrypted", onEncrypted);

    // Chrome autoplay policy で AudioContext が suspended になる場合は play で resume
    const onPlay = () => {
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
    };
    media.addEventListener("play", onPlay);

    const normalizerAnalyzer = ctx.createAnalyser();
    normalizerAnalyzer.fftSize = 512;
    const normalizerGainNode = ctx.createGain();
    normalizerGainNode.gain.value = 1;
    const nightModeNode = ctx.createDynamicsCompressor();
    const gainNode = ctx.createGain();
    const antiClipNode = ctx.createDynamicsCompressor();

    applyCompressorPreset(nightModeNode, VolumeBooster.COMPRESSOR_BYPASS);
    applyCompressorPreset(antiClipNode, VolumeBooster.COMPRESSOR_BYPASS);

    source.connect(normalizerAnalyzer);
    normalizerAnalyzer.connect(normalizerGainNode);
    normalizerGainNode.connect(nightModeNode);
    nightModeNode.connect(gainNode);
    gainNode.connect(antiClipNode);
    antiClipNode.connect(ctx.destination);

    /** @type {AudioState} */
    const state = {
      ctx,
      source,
      gainNode,
      normalizerAnalyzer,
      normalizerGainNode,
      normalizerBuffer: new Float32Array(normalizerAnalyzer.fftSize),
      normalizerTimer: null,
      normalizeEnabled: false,
      normalizerTargetGain: 1,
      nightModeNode,
      antiClipNode,
      lastSetPercent: VolumeBooster.UNITY,
      onEncrypted,
      onPlay,
    };
    STATE.set(media, state);
    ATTACHING.delete(media);

    applyStateSettings(state, currentSettings);
  }

  /**
   * gain ramp + compressor preset 切替 (旧 volumeSetGain の本体を移植)。
   * 既存ノードのプロパティを書き換えるだけなので AudioContext 再構築は不要、音切れなし。
   */
  function applyStateSettings(state, settings) {
    const clamped = VolumeBooster.clampValue(settings.gain);
    const targetGain = settings.muted ? 0 : VolumeBooster.percentToGain(clamped);
    const now = state.ctx.currentTime;
    state.gainNode.gain.cancelScheduledValues(now);
    state.gainNode.gain.setValueAtTime(state.gainNode.gain.value, now);
    state.gainNode.gain.setTargetAtTime(targetGain, now, VolumeBooster.RAMP_TIME_CONSTANT);
    state.lastSetPercent = clamped;
    updateLoudnessNormalizer(state, settings.normalize === true);
    applyCompressorPreset(
      state.nightModeNode,
      settings.nightMode === true ? VolumeBooster.NIGHT_MODE_PRESET : VolumeBooster.COMPRESSOR_BYPASS,
    );
    applyCompressorPreset(
      state.antiClipNode,
      settings.antiClip === true ? VolumeBooster.ANTI_CLIP_PRESET : VolumeBooster.COMPRESSOR_BYPASS,
    );
  }

  function detachFromMedia(media) {
    const state = STATE.get(media);
    if (!state) return;
    STATE.delete(media);
    try {
      stopLoudnessNormalizer(state);
      if (state.onEncrypted) media.removeEventListener("encrypted", state.onEncrypted);
      if (state.onPlay) media.removeEventListener("play", state.onPlay);
      state.ctx.close().catch(() => {});
    } catch {
      // close 失敗は致命的でない
    }
  }

  /**
   * DOM 全体の `<video>` / `<audio>` を scan して attach/detach を適用。
   * iframe 内 (cross-origin) はこの content script の別インスタンスが処理するため触らない。
   * /rere C2-Imp3 修正: master OFF / UNITY release のときは MutationObserver も disconnect する
   * (rtx-enhancer.js の activate/deactivate パターンと整合)。旧実装は observer を常時起動して
   * callback 入口で早期 return していたため、全非 EME http(s) サイトの全フレームで Chrome 内部の
   * AddedNodes 計算コスト + callback dispatch が常時発生していた。デフォルト OFF 方針の精神と
   * 整合させ、master OFF 時は完全無処理にする。
   */
  function scanAndApply() {
    const release = isUnityRelease(currentSettings);
    if (!currentSettings.enabled || release) {
      // 全 state を detach
      for (const media of document.querySelectorAll("video, audio")) {
        detachFromMedia(media);
      }
      // /rere C2-Imp3 修正: master OFF / UNITY release で observer 停止
      disconnectObserver();
      return;
    }
    // /rere C2-Imp3 修正: active 時のみ observer 起動 (idempotent)
    ensureObserver();
    for (const media of document.querySelectorAll("video, audio")) {
      if (!STATE.has(media)) {
        attachToMedia(media);
      } else {
        applyStateSettings(STATE.get(media), currentSettings);
      }
    }
  }

  // ============================================================
  // storage 監視
  // ============================================================

  function loadAndApply() {
    if (!chrome.runtime?.id) return; // orphan
    chrome.storage.local.get([
      StorageKeys.VOLUME_BOOSTER_ENABLED,
      StorageKeys.VOLUME_BOOSTER_LAST_GAIN,
      StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
      StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED,
      StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED,
      StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED,
    ], (s) => {
      if (chrome.runtime.lastError) return;
      currentSettings = {
        enabled: s[StorageKeys.VOLUME_BOOSTER_ENABLED] === true,
        gain: VolumeBooster.clampValue(s[StorageKeys.VOLUME_BOOSTER_LAST_GAIN] ?? VolumeBooster.DEFAULT),
        antiClip: s[StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED] === true,
        normalize: s[StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED] === true,
        nightMode: s[StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED] === true,
        muted: s[StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED] === true,
      };
      scanAndApply();
    });
  }

  const WATCHED_KEYS = new Set([
    StorageKeys.VOLUME_BOOSTER_ENABLED,
    StorageKeys.VOLUME_BOOSTER_LAST_GAIN,
    StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
    StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED,
    StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED,
    StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED,
  ]);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!chrome.runtime?.id) return;
    if (area !== "local") return;
    for (const key of Object.keys(changes)) {
      if (WATCHED_KEYS.has(key)) {
        loadAndApply();
        return;
      }
    }
  });

  // ============================================================
  // MutationObserver で動的 video/audio 追加に追従
  // /rere C2-Imp3 修正: rtx-enhancer.js の activate/deactivate パターンに揃え、
  // master OFF / UNITY release では observer を disconnect する。
  // observer を nullable + ensureObserver/disconnectObserver で idempotent 化。
  // ============================================================

  let observer = null;

  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      if (!chrome.runtime?.id) {
        disconnectObserver();
        return;
      }
      if (!currentSettings.enabled || isUnityRelease(currentSettings)) return;
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.("video, audio")) attachToMedia(node);
          if (node.querySelectorAll) {
            node.querySelectorAll("video, audio").forEach(attachToMedia);
          }
        }
      }
    });
    observer.observe(document.documentElement || document, {
      subtree: true,
      childList: true,
    });
  }

  function disconnectObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // ============================================================
  // 起動 + ライフサイクル
  // ============================================================

  window.addEventListener("pagehide", () => {
    disconnectObserver();
    for (const media of document.querySelectorAll("video, audio")) {
      detachFromMedia(media);
    }
  });

  loadAndApply();
})();
