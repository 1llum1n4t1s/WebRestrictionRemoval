"use strict";

/**
 * 音量ブースター content script (MediaElementSource 方式、Firefox 専用パイプライン)。
 *
 * Firefox MV3 は `chrome.tabCapture` / `chrome.offscreen` 未対応のため、Chrome の
 * tabCapture → offscreen 経路が使えない。本 content script は **manifest.firefox.json のみ**
 * から全 http(s) ページの全フレームに注入され、ページ内の `<video>` / `<audio>` 要素へ
 * MediaElementSource + 14 ノードチェーン
 * (`source → preamp → eqFilters[0..9] → nightMode → gain → antiClip → destination`、
 * offscreen.js の createAudioState と同一順序) を attach して音量を補正する。
 *
 * tabCapture と違い user gesture 不要で、popup を開かなくても storage 変化だけで
 * **全タブに自動適用** される (タブ共有バナーも出ない)。
 *
 * Chrome への影響ゼロの担保:
 *   - manifest.json (Chrome) は本ファイルを一切参照しない (Firefox 版 manifest 専用エントリ)
 *   - 冒頭の `chrome.runtime.getURL("")` スキーム検査 (`moz-extension://` = Gecko) で、万一
 *     Chrome 系環境にロードされても即 return する。
 *     ※ `typeof browser` 判定は Chrome 137+ が extension context に browser namespace を露出する
 *     ため判別子にならない。`chrome.tabCapture` の typeof 検査も「content script には Chrome でも
 *     露出しない」「AMO linter の UNSUPPORTED_API 警告対象」の 2 理由で使えない
 *
 * ⚠️ 最重要の前提 (敵対的レビューで確定): **Firefox では一度 MES で capture した要素は
 * `ctx.close()` しても直接出力に復帰しない** (要素は captured のまま = 無音)。したがって
 * 「detach して音を元に戻す」という回復手段は存在せず、設計は徹底的に **誤 attach の予防** と
 * **graph を生かしたまま bypass** に寄せる。`ctx.close()` は音声がもう不要な場面
 * (DOM 除去後の猶予経過 / pagehide 実破棄) の資源解放専用。
 *
 * 設計上の不変条件:
 *   - `<video>` / `<audio>` 1 要素に対して 1 AudioContext。WeakMap (STATE) + WeakRef レジストリ
 *     (ATTACHED) で管理する。設定の適用 / bypass は **ATTACHED レジストリを反復** して行う
 *     (document.querySelectorAll 依存だと shadow DOM へ移動した要素や detached 再生中の要素に
 *     設定変更が届かず、boost/mute が固着するため)。querySelectorAll は新規要素の発見にのみ使う。
 *   - attach 判定は三段: ① EME (`EME_HOSTS` 起動 skip + `mediaKeys != null` + `encrypted` event
 *     の事前検出)、② `readyState >= HAVE_METADATA` 待ち (DRM の encrypted event は metadata 確定
 *     までに発火するため、この gate だけで attach 前検出がほぼ確実になる)、③
 *     `VolumeBooster.classifyMesSource` (純粋関数): safe = 即 attach / probe = same-origin HEAD
 *     probe (redirect: "manual") で opaqueredirect でないことを確認してから attach
 *     (same-origin → cross-origin redirect 配信の opaque taint 無音化を予防) / pending = 再評価
 *     待ち / unsafe = 恒久 skip。probe は same-origin への HEAD のみで外部送信ゼロを維持する。
 *   - `encrypted` event が attach 後に来ても **detach しない** (close しても復帰しないため無意味。
 *     DRM 区間は仕様上無音になるが、graph を維持すれば非 DRM ソースへの切替で自然回復する)。
 *   - master OFF / UNITY release も **detach せずニュートラル設定へ ramp して bypass 維持**。
 *   - orphan 化 (拡張リロード) 時も **close せず bypass 維持** (close すると再生中の音が死ぬ。
 *     bypass なら音はそのまま流れ続ける)。なお Firefox は拡張リロード時に content script sandbox
 *     ごと破棄するため本 guard が走らないケースがあり、その場合 boost 中タブは最後の設定のまま
 *     残る (ページ再読み込みで解消される既知の制約)。
 *   - `ctx.close()` するのは: DOM から除去され 30 秒再挿入されなかった要素 (資源解放。即 close
 *     すると remove → 後で reinsert するプレーヤーで再挿入後が無音のままになるため猶予を置く) と
 *     pagehide (persisted=false) のみ。
 *   - AudioContext が autoplay policy で suspended のままだと attach 済み要素が無音になるため、
 *     attach 直後 + play / volumechange + document の pointerdown / keydown (user activation
 *     発生点) で resume を試行する。
 *   - storage.onChanged で音量関連 8 キーの変化を監視し、即座に全 state へ反映する
 *     (popup → storage 直書きが唯一のトリガー。メッセージ購読はしない)。
 *   - MutationObserver は「新規 media の発見」(active 時のみ) と「DOM 除去要素の猶予付き解放」の
 *     2 責務。**attach 済み要素が残っている間は master OFF でも切断しない** (切断すると bypass
 *     維持中の AudioContext が DOM 除去後に解放されず pagehide までリークする)。
 *
 * 二重実行防止: `window.__cpaVolumeBoosterMesRunning` で同一フレーム内の重複起動を弾く。
 */

(() => {
  if (window.__cpaVolumeBoosterMesRunning === true) return;
  window.__cpaVolumeBoosterMesRunning = true;

  // Firefox (Gecko) 専用ガード: 拡張機能 URL スキームで判定する。Chrome 系は
  // chrome-extension:// を返すため、万一 manifest drift で Chrome に注入されても即 return する。
  try {
    if (!chrome.runtime.getURL("").startsWith("moz-extension://")) return;
  } catch {
    return;
  }

  // EME (DRM) 多用サイトでは MES attach で動画音声が完全無音化するため起動自体を skip。
  // Firefox には tabCapture フォールバックが無いので、これらのサイトでは音量ブースターは
  // 効かない (音は普通に出る)。判定リストは actions.js の VolumeBooster.EME_HOSTS に集約。
  if (VolumeBooster.isEmeHost(location.hostname)) return;

  // WeakMap<HTMLMediaElement, AudioState>。要素が GC されれば state も自動解放される。
  const STATE = new WeakMap();
  // attach 済み要素の反復用レジストリ (Set<WeakRef<HTMLMediaElement>>)。
  // WeakMap は反復できないため、設定適用 / bypass / teardown はここを回す。
  const ATTACHED = new Set();
  // EME 検出 / MES attach 例外で attach 不可と判定した要素 (恒久スキップ)。
  const EME_DETECTED = new WeakSet();
  // attach 試行中フラグ (probe の await 越し二重 attach の race 防止)。
  const ATTACHING = new WeakSet();
  // watchMedia 済み要素 (per-element listener の二重登録防止)。teardown で new WeakSet() に差し替え。
  let watchedMedia = new WeakSet();
  // 全 media / document listener の一括解除用 (video-fill.js の metaListenerCtrl パターン)。
  let listenerCtrl = new AbortController();
  // document レベルの user-activation resume listener 登録済みフラグ。
  let gestureResumeAttached = false;
  // orphan 化を 1 回検知したら以後の処理を全て止める (CPU 浪費ゼロ化)。
  let orphaned = false;

  // same-origin redirect probe の結果キャッシュ (currentSrc → attach 可否)。
  const PROBE_CACHE = new Map();
  const PROBE_CACHE_MAX = 64;
  const PROBE_TIMEOUT_MS = 3000;
  // DOM 除去要素を ctx.close するまでの猶予 (remove → reinsert するプレーヤー対策)。
  const DETACH_GRACE_MS = 30_000;

  const { applyCompressorPreset, applyEqualizer, createEqChain } = AudioPipeline;

  /** @type {{enabled: boolean, gain: number, antiClip: boolean, nightMode: boolean, muted: boolean, eqEnabled: boolean, eqGains: number[], eqPreamp: number}} */
  let currentSettings = {
    enabled: false,
    gain: VolumeBooster.DEFAULT,
    antiClip: false,
    nightMode: false,
    muted: false,
    eqEnabled: false,
    eqGains: VolumeBooster.clampEqGains([]),
    eqPreamp: VolumeBooster.EQ_PREAMP_DEFAULT,
  };

  /** bypass (実質無処理) へ戻すためのニュートラル設定。 */
  const NEUTRAL_SETTINGS = Object.freeze({
    enabled: false,
    gain: VolumeBooster.UNITY,
    antiClip: false,
    nightMode: false,
    muted: false,
    eqEnabled: false,
    eqGains: VolumeBooster.clampEqGains([]),
    eqPreamp: VolumeBooster.EQ_PREAMP_DEFAULT,
  });

  /**
   * UNITY release 判定: gain 100% + 全サブトグル OFF + ミュート OFF + EQ OFF なら処理不要。
   * background.js setVolumeBoosterGain の release 早期 return と同じ条件 (EQ 込み)。
   */
  function isUnityRelease(settings) {
    return settings.gain === VolumeBooster.UNITY
      && !settings.antiClip
      && !settings.nightMode
      && !settings.muted
      && !settings.eqEnabled;
  }

  function isActive() {
    return currentSettings.enabled && !isUnityRelease(currentSettings);
  }

  /**
   * ATTACHED レジストリを反復し、GC 済みの WeakRef を掃除しながら fn(media, state) を呼ぶ。
   */
  function forEachAttached(fn) {
    for (const ref of ATTACHED) {
      const media = ref.deref();
      if (!media) {
        ATTACHED.delete(ref);
        continue;
      }
      const state = STATE.get(media);
      if (!state) {
        ATTACHED.delete(ref);
        continue;
      }
      fn(media, state);
    }
  }

  // ============================================================
  // AudioContext + 14 ノードチェーン構築
  // ============================================================

  /**
   * media 要素の現在ソースの安全性分類。srcObject (MediaStream 等) は URL を持たず taint
   * しないため safe 扱い、それ以外は classifyMesSource (純粋関数) に委ねる。
   * @returns {"safe"|"probe"|"pending"|"unsafe"}
   */
  function mediaSourceSafety(media) {
    if (media.srcObject) return "safe";
    return VolumeBooster.classifyMesSource(media.currentSrc, media.crossOrigin, location.href);
  }

  /**
   * attach のエントリポイント。ガード → 安全性分類 → safe は即 attach / probe は
   * same-origin redirect probe を挟んでから attach。
   */
  function attachToMedia(media) {
    if (!(media instanceof HTMLMediaElement)) return;
    if (STATE.has(media) || EME_DETECTED.has(media) || ATTACHING.has(media)) return;
    if (media.mediaKeys != null) {
      EME_DETECTED.add(media);
      return;
    }
    // metadata 確定前は attach しない (watchMedia の loadedmetadata で再評価される)。
    // DRM コンテンツの encrypted event は init segment 処理中 = metadata 確定までに発火する
    // ため、この gate + watchMedia の encrypted 事前検出で「attach 後に DRM 化」の race を潰す。
    if (media.readyState < HTMLMediaElement.HAVE_METADATA) return;
    // ページがまだ一度もユーザー操作を受けていない場合 (sticky activation 無し) に attach すると、
    // 新規 AudioContext は suspended のまま resume が保証されず、MEI 等でミュート無しの自動再生が
    // 許可されているサイトで「既に音が出ている要素」を沈黙させてしまうリスクがある。
    // Firefox は navigator.userActivation.hasBeenActive を実装済み (Baseline Widely available、
    // Firefox 119+) なので、未取得の間は attach を保留し、ensureGestureResumeListeners の
    // pointerdown/keydown (初回操作) で retryPendingAttachments() を通じて再試行する。
    // `navigator.userActivation` 自体が無い環境では判定せず (フォールバックで現行動作を維持)。
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    const safety = mediaSourceSafety(media);
    if (safety === "safe") {
      doAttach(media);
    } else if (safety === "probe") {
      probeAndAttach(media);
    }
    // pending / unsafe は attach しない (pending は loadedmetadata / loadstart で再評価)
  }

  /**
   * same-origin http(s) ソースの redirect probe。HTML 仕様上 currentSrc はリダイレクト前の
   * URL を返すため、same-origin → cross-origin redirect 配信だと opaque taint で無音化する。
   * `redirect: "manual"` で opaqueredirect が返らないことを確認してから attach する。
   * probe 失敗 / redirect 検出時は attach しない (音は普通に出る fail-safe)。
   * same-origin への 1 バイト Range GET のみなので外部送信ゼロは維持される。
   *
   * HEAD ではなく `Range: bytes=0-0` 付き GET を使う理由: サーバー / リバースプロキシが
   * HEAD と実際のメディア取得 (`<video>`/`<audio>` は Range GET で取得するのが一般的) を
   * 別ロジックで処理し、HEAD はリダイレクトしないが実 GET は cross-origin CDN にリダイレクトする
   * ケースがある。実際のメディア要求と同じ method/semantics で probe することで、この不整合による
   * 誤 safe 判定 (= 無音化) を防ぐ。
   */
  async function probeAndAttach(media) {
    const src = media.currentSrc;
    let ok = PROBE_CACHE.get(src);
    if (ok === undefined) {
      ATTACHING.add(media);
      try {
        const res = await fetch(src, {
          method: "GET",
          headers: { Range: "bytes=0-0" },
          redirect: "manual",
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        // redirect さえしていなければ status は問わない (206/200/416 等は taint 判定に無関係)
        ok = res.type !== "opaqueredirect";
      } catch {
        ok = false; // 判定不能は attach しない側に倒す
      } finally {
        ATTACHING.delete(media);
      }
      if (PROBE_CACHE.size >= PROBE_CACHE_MAX) PROBE_CACHE.clear();
      PROBE_CACHE.set(src, ok);
    }
    if (!ok) return;
    // post-await guard: probe 中に状況が変わっていたら attach しない / 再評価に回す
    if (orphaned || !isActive()) return;
    if (media.currentSrc !== src) {
      evaluateMedia(media);
      return;
    }
    doAttach(media);
  }

  /**
   * MediaElementSource + 14 ノードチェーンを構築する (安全性判定済みの要素のみ)。
   * attach 例外 = サイト側 player が自前で MES 済み等。区別できないので恒久スキップ。
   */
  function doAttach(media) {
    if (STATE.has(media) || EME_DETECTED.has(media) || ATTACHING.has(media)) return;
    if (media.mediaKeys != null) {
      EME_DETECTED.add(media);
      return;
    }
    ATTACHING.add(media);

    // capture (createMediaElementSource) が成立した後に ctx.close() すると、Firefox では
    // 音声が直接出力に復帰しない (ファイル冒頭の不変条件) ため恒久無音化する。これを避けるため、
    // capture 前に作れるノードは先に作り、capture (createMediaElementSource) は最後に回す。
    // capture 成立後の失敗は close せず、source を ctx.destination へ直結する bypass で
    // 「無処理だが音は出る」状態に逃がす (source が null なら capture 未成立 = close 安全)。
    let ctx = null;
    let source = null;
    try {
      ctx = new AudioContext();
      const eqChain = createEqChain(ctx);
      const nightModeNode = ctx.createDynamicsCompressor();
      const gainNode = ctx.createGain();
      const antiClipNode = ctx.createDynamicsCompressor();
      applyCompressorPreset(nightModeNode, VolumeBooster.COMPRESSOR_BYPASS);
      applyCompressorPreset(antiClipNode, VolumeBooster.COMPRESSOR_BYPASS);
      source = ctx.createMediaElementSource(media);
      // ノード順序は offscreen.js createAudioState と同一 (EQ → ナイトモード → gain → anti-clip)
      source.connect(eqChain.head);
      eqChain.tail.connect(nightModeNode);
      nightModeNode.connect(gainNode);
      gainNode.connect(antiClipNode);
      antiClipNode.connect(ctx.destination);

      /** @type {AudioState} */
      const state = {
        ctx,
        source,
        gainNode,
        preampNode: eqChain.preampNode,
        eqFilters: eqChain.eqFilters,
        nightModeNode,
        antiClipNode,
        lastSetPercent: VolumeBooster.UNITY,
        ref: new WeakRef(media),
      };
      STATE.set(media, state);
      ATTACHED.add(state.ref);

      // autoplay policy で suspended のままだと attach 済み要素が無音になる。
      // ここで失敗しても play / volumechange / user gesture の再試行経路がある。
      if (ctx.state === "suspended") ctx.resume().catch(() => {});

      applyStateSettings(state, currentSettings);
    } catch {
      // MES attach 失敗 = サイト側 player が自前で MES 済み等。安全側で恒久スキップ (音は普通に出る)。
      EME_DETECTED.add(media);
      if (ctx && source) {
        // capture 成立後の失敗: close せず直結 bypass で音を生かす (close は復帰不能なため)。
        try {
          source.connect(ctx.destination);
        } catch {
          // 直結 bypass も失敗した場合、それ以上の破壊的操作 (close 等) は行わない。
        }
      } else if (ctx) {
        // capture 未成立 (source null): close しても media は影響を受けないため安全。
        ctx.close().catch(() => {});
      }
    } finally {
      ATTACHING.delete(media);
    }
  }

  /**
   * gain ramp 三点セット + compressor preset + EQ 適用 (offscreen.js volumeSetGain と同じ更新則)。
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
    applyCompressorPreset(
      state.nightModeNode,
      settings.nightMode === true ? VolumeBooster.NIGHT_MODE_PRESET : VolumeBooster.COMPRESSOR_BYPASS,
    );
    applyCompressorPreset(
      state.antiClipNode,
      settings.antiClip === true ? VolumeBooster.ANTI_CLIP_PRESET : VolumeBooster.COMPRESSOR_BYPASS,
    );
    applyEqualizer(state, settings.eqEnabled === true, settings.eqGains, settings.eqPreamp);
  }

  /**
   * ctx.close で AudioContext を破棄する **資源解放専用** の後始末。
   * ⚠️ Firefox では close しても要素は captured のまま = 音声は直接出力に復帰しない。
   * したがって「音がもう不要」な場面 (DOM 除去後の猶予経過 / pagehide 実破棄) でのみ呼ぶこと。
   * 音を生かしたまま無効化したい場合は applyStateSettings(state, NEUTRAL_SETTINGS) を使う。
   */
  function detachFromMedia(media) {
    const state = STATE.get(media);
    if (!state) return;
    STATE.delete(media);
    ATTACHED.delete(state.ref);
    try {
      state.ctx.close().catch(() => {});
    } catch {
      // close 失敗は致命的でない
    }
    // 非アクティブ + attach 残ゼロなら observer も不要になる
    if (!isActive() && ATTACHED.size === 0) disconnectObserver();
  }

  /**
   * 要素の attach 可否を再評価する (watchMedia の各イベントから呼ばれる)。
   * attach 済み要素には何もしない: src が unsafe に差し替わっても detach は無意味
   * (Firefox では close しても復帰しない)。taint したソースの区間は仕様上無音になるが、
   * graph を維持していれば安全なソースに戻った時点で音声も自然回復する。
   */
  function evaluateMedia(media) {
    if (orphaned) return;
    if (STATE.has(media)) return;
    if (!isActive()) return;
    attachToMedia(media);
  }

  /**
   * per-element listener を一度だけ登録する。listenerCtrl.signal に束ねるので
   * teardown 時は abort 一発で全解除される (video-fill.js metaListenerCtrl パターン)。
   */
  function watchMedia(media) {
    if (!(media instanceof HTMLMediaElement)) return;
    if (watchedMedia.has(media)) return;
    watchedMedia.add(media);
    const signal = listenerCtrl.signal;
    // ソース確定 / src 差し替え / 再生開始のタイミングで attach 可否を再評価
    media.addEventListener("loadedmetadata", () => evaluateMedia(media), { signal });
    media.addEventListener("loadstart", () => evaluateMedia(media), { signal });
    media.addEventListener("play", () => {
      const state = STATE.get(media);
      if (state && state.ctx.state === "suspended") state.ctx.resume().catch(() => {});
      evaluateMedia(media);
    }, { signal });
    // サイト UI での unmute (volumechange) も resume 契機にする (muted autoplay → 手動 unmute 対策)
    media.addEventListener("volumechange", () => {
      const state = STATE.get(media);
      if (state && state.ctx.state === "suspended") state.ctx.resume().catch(() => {});
    }, { signal });
    // EME 事前検出: encrypted は metadata 処理中に発火するため、attach 前なら恒久スキップに
    // できる (これが本命の防御)。attach 後に発火した場合は何もしない — Firefox では detach
    // (ctx.close) しても音声は復帰せず、graph 維持なら非 DRM ソースへの切替で自然回復するため。
    media.addEventListener("encrypted", () => {
      EME_DETECTED.add(media);
    }, { signal });
  }

  /**
   * suspended のまま取り残された AudioContext を user activation 発生点で resume する。
   * pointerdown / keydown は capture + passive で登録し、コストはレジストリ走査のみ。
   */
  function resumeSuspendedContexts() {
    if (orphaned) return;
    forEachAttached((media, state) => {
      if (state.ctx.state === "suspended") state.ctx.resume().catch(() => {});
    });
  }

  /**
   * sticky activation が無いため attachToMedia でスキップされていた要素を再試行する。
   * pointerdown/keydown (初回操作) で navigator.userActivation.hasBeenActive が true になった
   * 直後に呼ぶことで、無音化を避けて保留していた attach を安全なタイミングで実行する。
   */
  function retryPendingAttachments() {
    if (orphaned || !isActive()) return;
    for (const media of document.querySelectorAll("video, audio")) {
      if (!STATE.has(media)) attachToMedia(media);
    }
  }

  function ensureGestureResumeListeners() {
    if (gestureResumeAttached) return;
    gestureResumeAttached = true;
    const opts = { capture: true, passive: true, signal: listenerCtrl.signal };
    const onGesture = () => {
      resumeSuspendedContexts();
      retryPendingAttachments();
    };
    document.addEventListener("pointerdown", onGesture, opts);
    document.addEventListener("keydown", onGesture, opts);
  }

  /**
   * 設定を全 attach 済み要素へ適用し、active なら DOM を scan して新規要素を attach する。
   * 適用は ATTACHED レジストリ経由 (shadow DOM 移動 / detached 再生中の要素にも届く)。
   */
  function scanAndApply() {
    if (orphaned) return;
    if (!isActive()) {
      // 既 attach 要素は detach (ctx.close) ではなくニュートラル設定へ ramp して bypass 維持。
      // Firefox では close しても直接出力に復帰しないため、close は「音を殺す」操作にしかならない。
      // 一度も attach していないページでは何も起きない (完全無処理 = デフォルト OFF 方針)。
      forEachAttached((media, state) => applyStateSettings(state, NEUTRAL_SETTINGS));
      // observer は「DOM 除去要素の猶予付き解放」のため attach 済みが残る限り維持する
      if (ATTACHED.size === 0) disconnectObserver();
      return;
    }
    ensureObserver();
    ensureGestureResumeListeners();
    forEachAttached((media, state) => applyStateSettings(state, currentSettings));
    for (const media of document.querySelectorAll("video, audio")) {
      watchMedia(media);
      if (!STATE.has(media)) attachToMedia(media);
    }
  }

  // ============================================================
  // storage 監視 (popup → storage 直書きが唯一のトリガー)
  // ============================================================

  const WATCHED_KEYS = [
    StorageKeys.VOLUME_BOOSTER_ENABLED,
    StorageKeys.VOLUME_BOOSTER_LAST_GAIN,
    StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
    StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED,
    StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED,
    StorageKeys.VOLUME_BOOSTER_EQ_ENABLED,
    StorageKeys.VOLUME_BOOSTER_EQ_GAINS,
    StorageKeys.VOLUME_BOOSTER_EQ_PREAMP,
  ];
  const WATCHED_KEY_SET = new Set(WATCHED_KEYS);

  function loadAndApply() {
    if (orphaned) return;
    if (!chrome.runtime?.id) {
      teardownOrphan();
      return;
    }
    chrome.storage.local.get(WATCHED_KEYS, (s) => {
      if (chrome.runtime.lastError) return;
      if (orphaned) return;
      currentSettings = {
        enabled: s[StorageKeys.VOLUME_BOOSTER_ENABLED] === true,
        gain: VolumeBooster.clampValue(s[StorageKeys.VOLUME_BOOSTER_LAST_GAIN] ?? VolumeBooster.DEFAULT),
        antiClip: s[StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED] === true,
        nightMode: s[StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED] === true,
        muted: s[StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED] === true,
        eqEnabled: s[StorageKeys.VOLUME_BOOSTER_EQ_ENABLED] === true,
        eqGains: VolumeBooster.clampEqGains(s[StorageKeys.VOLUME_BOOSTER_EQ_GAINS]),
        eqPreamp: VolumeBooster.clampEqPreamp(s[StorageKeys.VOLUME_BOOSTER_EQ_PREAMP]),
      };
      scanAndApply();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (orphaned) return;
    if (!chrome.runtime?.id) {
      teardownOrphan();
      return;
    }
    if (area !== "local") return;
    for (const key of Object.keys(changes)) {
      if (WATCHED_KEY_SET.has(key)) {
        loadAndApply();
        return;
      }
    }
  });

  // ============================================================
  // MutationObserver: 新規 media の発見 (active 時) + DOM 除去要素の猶予付き解放
  // ============================================================

  let observer = null;

  /**
   * DOM から除去された attach 済み要素を、猶予後もまだ切断されたままなら ctx.close で解放する。
   * 即 close しないのは remove → 後で reinsert するプレーヤー (miniplayer 等) の再挿入後が
   * 無音のままになるのを避けるため (Firefox では close 後の復帰手段が無い)。
   * 猶予経過時点でまだ再生中 (`!paused && !ended`) なら、意図的に detached 状態で保持し続ける
   * プレーヤー実装の可能性が高いと判断し、close せず猶予を延長する (再スケジュール)。
   * 再接続されるか、再生が止まる/終わるまで close は保留され続ける。
   */
  function scheduleDetachedCheck(media) {
    if (!STATE.has(media)) return;
    setTimeout(() => {
      if (orphaned) return;
      if (!STATE.has(media) || media.isConnected) return;
      if (!media.paused && !media.ended) {
        scheduleDetachedCheck(media);
        return;
      }
      detachFromMedia(media);
    }, DETACH_GRACE_MS);
  }

  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      if (!chrome.runtime?.id) {
        teardownOrphan();
        return;
      }
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (!isActive()) continue;
          if (node.matches?.("video, audio")) {
            watchMedia(node);
            attachToMedia(node);
          }
          node.querySelectorAll?.("video, audio").forEach((m) => {
            watchMedia(m);
            attachToMedia(m);
          });
        }
        for (const node of r.removedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.("video, audio")) scheduleDetachedCheck(node);
          if (node.querySelectorAll) {
            node.querySelectorAll("video, audio").forEach(scheduleDetachedCheck);
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
  // teardown + ライフサイクル
  // ============================================================

  /**
   * listener / observer を一括撤去する共通 teardown。
   * @param {boolean} closeContexts true = ctx.close で資源解放 (pagehide 実破棄のみ)。
   *   false = graph を bypass 維持 (orphan 化: close すると再生中の音が死ぬため)。
   */
  function teardownAll(closeContexts) {
    disconnectObserver();
    listenerCtrl.abort();
    listenerCtrl = new AbortController();
    gestureResumeAttached = false;
    watchedMedia = new WeakSet();
    forEachAttached((media, state) => {
      if (closeContexts) {
        detachFromMedia(media);
      } else {
        applyStateSettings(state, NEUTRAL_SETTINGS);
      }
    });
  }

  /**
   * 拡張機能リロード後の orphan 化検知時の teardown。graph は bypass 維持で残す
   * (Firefox では ctx.close しても音声が直接出力に復帰しない = close は音を殺すだけのため)。
   * 後継 content script の attach は MES 二重 attach 例外 → 恒久スキップに落ちるが、
   * 音は bypass graph 経由で流れ続ける (ページ再読み込みで完全復旧)。
   */
  function teardownOrphan() {
    if (orphaned) return;
    orphaned = true;
    teardownAll(false);
  }

  window.addEventListener("pagehide", (event) => {
    // bfcache 凍結 (persisted=true) は listener / state ごと凍結され CPU 消費ゼロ + 復帰で
    // そのまま継続できるので温存する (video-fill.js と同じ方針)。実破棄のみ資源解放。
    if (event.persisted) return;
    teardownAll(true);
  });

  window.addEventListener("pageshow", (event) => {
    // bfcache 凍結中は storage.onChanged が配送されず復帰後も再送されないため、凍結中に
    // popup で行われた設定変更 (master OFF / gain 変更等) が復帰タブに残留する。
    // 復帰時に storage を読み直して「戻ったタブだけ旧設定で boost 継続」を防ぐ
    // (orphan / lastError の guard は loadAndApply 内で処理済み)。
    if (event.persisted) loadAndApply();
  });

  loadAndApply();
})();
