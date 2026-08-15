"use strict";

/**
 * 音量ブースター content script (MediaElementSource 方式、Firefox 専用パイプライン)。
 *
 * Firefox MV3 は `chrome.tabCapture` / `chrome.offscreen` 未対応のため、Chrome の
 * tabCapture → offscreen 経路が使えない。本 content script は **manifest.firefox.json のみ**
 * から全 http(s) ページの全フレームに注入され、ページ内の `<video>` / `<audio>` 要素へ
 * MediaElementSource + 18 処理ノードを attach する。出力は
 * `source → dryGain → destination` と
 * `source → preamp → eqFilters[0..9] → nightMode → gain → bassCut[0..1] → antiClip → wetGain → destination`
 * に分岐し、wet 内の DSP 順序は offscreen.js の createAudioState と一致する。
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
 *     `VolumeBooster.classifyMesSource` (純粋関数): safe = 即 attach / probe = same-origin の
 *     1 バイト Range GET (`redirect: "manual"`) で opaqueredirect でないことを確認してから attach
 *     (same-origin → cross-origin redirect 配信の opaque taint 無音化を予防) / pending = 再評価
 *     待ち / unsafe = 恒久 skip。probe は same-origin への 1 バイト Range GET のみで
 *     外部送信ゼロを維持する。
 *   - `encrypted` event が attach 後に来ても **detach しない** (close しても復帰しないため無意味。
 *     DRM 区間は仕様上無音になるが、graph を維持すれば非 DRM ソースへの切替で自然回復する)。
 *   - master OFF / UNITY release も **detach せずニュートラル設定へ ramp して bypass 維持**。
 *   - orphan 化 (拡張リロード) 時も **close せず bypass 維持** (close すると再生中の音が死ぬ。
 *     bypass なら音はそのまま流れ続ける)。Firefox が content script sandbox ごと破棄して guard が
 *     走らない場合にも、dry/wet 出力 AudioParam へ予約した lease 期限後の automation が
 *     AudioContext 側で実行され、最大 20 秒程度で旧 graph は自動的に bypass へ戻る。
 *   - `ctx.close()` するのは: DOM から除去され 30 秒再挿入されなかった要素 (資源解放。即 close
 *     すると remove → 後で reinsert するプレーヤーで再挿入後が無音のままになるため猶予を置く) と
 *     pagehide (persisted=false) のみ。
 *   - AudioContext が autoplay policy で suspended のままだと attach 済み要素が無音になるため、
 *     attach 直後 + play / volumechange + document の pointerdown / keydown (user activation
 *     発生点) で resume を試行する。
 *   - storage.onChanged で音量関連 9 キーの変化を監視し、即座に全 state へ反映する
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
  // EME 検出済み要素（期待される安全回避）と、実装上の attach 失敗要素を分離して管理する。
  const EME_DETECTED = new WeakSet();
  const ATTACH_REJECTED = new WeakSet();
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
  let tearingDown = false;
  // 同一 reason code はページ内で一度だけ出し、大量 media 要素があるページでもログを汚染しない。
  const REPORTED_DIAGNOSTICS = new Set();

  function reportDiagnosticOnce(reasonCode) {
    if (REPORTED_DIAGNOSTICS.has(reasonCode)) return;
    REPORTED_DIAGNOSTICS.add(reasonCode);
    // URL・要素・例外本文は出力せず、個人情報を含まない固定 reason code のみに限定する。
    console.warn("[WebViewingAssist] Firefox MES diagnostic:", reasonCode);
  }

  function resumeContext(ctx) {
    try {
      ctx.resume().catch(() => reportDiagnosticOnce("mes-resume-failed"));
    } catch {
      reportDiagnosticOnce("mes-resume-failed");
    }
  }

  function isRuntimeAvailable() {
    try {
      return Boolean(chrome.runtime?.id)
        && chrome.runtime.getURL("").startsWith("moz-extension://");
    } catch {
      return false;
    }
  }

  function isInvalidContextError(error) {
    if (!isRuntimeAvailable()) return true;
    return /extension context invalidated/i.test(String(error?.message ?? ""));
  }

  // same-origin redirect probe の結果キャッシュ (currentSrc → attach 可否)。
  const PROBE_CACHE = new Map();
  const PROBE_CACHE_MAX = 64;
  const PROBE_TIMEOUT_MS = 3000;
  // DOM 除去要素を ctx.close するまでの猶予 (remove → reinsert するプレーヤー対策)。
  const DETACH_GRACE_MS = 30_000;
  // detached だが再生継続中の要素の close 延長回数上限 (30s × 10 = 約 5 分)。
  // 再挿入プレーヤー対策で猶予延長する設計だが、上限が無いと detached+再生継続の異常系サイトで
  // AudioContext + 18処理ノード + closure が無限に GC されないため上限を設ける (/rere C2-M3)。
  const DETACH_MAX_RETRIES = 10;
  // background tabのtimer throttlingへ余裕を持たせつつ、sandbox消滅後の旧設定残留を短く抑える。
  // 20秒を超えてtickが遅延した場合はいったんdryへ安全退避し、次の生存確認成功時にwetへ復帰する。
  const LEASE_HEARTBEAT_MS = 5_000;
  const LEASE_TIMEOUT_SECONDS = 20;
  let leaseHeartbeatTimer = null;
  let leaseHeartbeatGeneration = 0;
  let leaseHeartbeatCheckInFlight = false;

  const {
    applyCompressorPreset,
    applyFilterPreset,
    createBassCutChain,
    applyEqualizer,
    createEqChain,
    connectAudioGraph,
  } = AudioPipeline;

  /** @type {{enabled: boolean, gain: number, antiClip: boolean, nightMode: boolean, bassCut: boolean, muted: boolean, eqEnabled: boolean, eqGains: number[], eqPreamp: number}} */
  let currentSettings = {
    enabled: false,
    gain: VolumeBooster.DEFAULT,
    antiClip: false,
    nightMode: false,
    bassCut: false,
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
    bassCut: false,
    muted: false,
    eqEnabled: false,
    eqGains: VolumeBooster.clampEqGains([]),
    eqPreamp: VolumeBooster.EQ_PREAMP_DEFAULT,
  });

  // UNITY release 判定は VolumeBooster.isUnityRelease に集約（background.js の tabCapture 経路と
  // 同一条件を単一情報源化。gain 100% + 全サブトグル OFF + ミュート OFF + EQ OFF なら処理不要・/rere D-002）。
  function isActive() {
    return currentSettings.enabled && !VolumeBooster.isUnityRelease(currentSettings);
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
  // AudioContext + 16 DSPノード + dry/wet出力2ノード構築
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
    if (!isRuntimeAvailable()) {
      teardownOrphan();
      return;
    }
    if (STATE.has(media) || EME_DETECTED.has(media) || ATTACH_REJECTED.has(media) || ATTACHING.has(media)) return;
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
    // 一時停止中の要素はここでは attach しない。多数のプレビュー動画/音声を抱えるフィード
    // (SNS のタイムライン等) で、まだ再生されてもいない全要素に AudioContext + EQ チェーン
    // (18処理ノード) を割り当てるのは資源浪費であり、Firefox では captured 状態のまま維持コストだけ
    // かかり続ける。watchMedia が登録する play イベントが実際の再生開始時に evaluateMedia 経由で
    // 再試行するため、ここで skip しても取りこぼしはない。
    if (media.paused) return;
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
    let cacheable = ok !== undefined;
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
        cacheable = true;
        // Range を無視して本文全体 (200 + フルボディ) を返すサーバーだと、ヘッダ確認後に
        // 本文を読み捨てないと実際のメディア GET と並行してバックグラウンド転送が続いてしまう。
        // ヘッダ判定だけで用は済んでいるため、ここで確実に打ち切る。
        res.body?.cancel().catch(() => {});
      } catch {
        ok = false; // 判定不能は今回 attach しないが、次の media event では再試行する
      } finally {
        ATTACHING.delete(media);
      }
      if (cacheable) {
        if (PROBE_CACHE.size >= PROBE_CACHE_MAX) PROBE_CACHE.clear();
        PROBE_CACHE.set(src, ok);
      }
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
   * MediaElementSource + 16 DSPノード + dry/wet出力GainNodeを構築する。
   * attach / DSP 例外は期待される EME 回避と分け、固定 reason code で一度だけ記録する。
   */
  function doAttach(media) {
    if (!isRuntimeAvailable()) {
      teardownOrphan();
      return;
    }
    if (STATE.has(media) || EME_DETECTED.has(media) || ATTACH_REJECTED.has(media) || ATTACHING.has(media)) return;
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
    let dryBypassConnected = false;
    let failureStage = "prepare";
    try {
      ctx = new AudioContext();
      const eqChain = createEqChain(ctx);
      const nightModeNode = ctx.createDynamicsCompressor();
      const gainNode = ctx.createGain();
      const bassCutChain = createBassCutChain(ctx);
      const antiClipNode = ctx.createDynamicsCompressor();
      const dryGainNode = ctx.createGain();
      const wetGainNode = ctx.createGain();
      // capture直後から安全なbypassが成立するよう、接続前の初期値はdry=1 / wet=0。
      dryGainNode.gain.value = 1;
      wetGainNode.gain.value = 0;
      applyCompressorPreset(nightModeNode, VolumeBooster.COMPRESSOR_BYPASS);
      applyCompressorPreset(antiClipNode, VolumeBooster.COMPRESSOR_BYPASS);
      failureStage = "capture";
      source = ctx.createMediaElementSource(media);
      // dry経路を先に確立する。以降のDSP接続が失敗してもcloseせず音を維持できる。
      failureStage = "connect";
      source.connect(dryGainNode);
      dryGainNode.connect(ctx.destination);
      dryBypassConnected = true;
      // wet内のノード順序はoffscreen.jsと同一。最終出力だけwetGainへ接続し、lease失効時は
      // dry=1 / wet=0へcrossfadeしてDSP全体を確実にbypassする。
      connectAudioGraph({
        source,
        eqChain,
        nightModeNode,
        gainNode,
        bassCutChain,
        antiClipNode,
        destination: wetGainNode,
      });
      wetGainNode.connect(ctx.destination);
      failureStage = "register";

      /** @type {AudioState} */
      const state = {
        ctx,
        source,
        gainNode,
        preampNode: eqChain.preampNode,
        eqFilters: eqChain.eqFilters,
        nightModeNode,
        bassCutNodes: bassCutChain.bassCutNodes,
        antiClipNode,
        dryGainNode,
        wetGainNode,
        lastSetPercent: VolumeBooster.UNITY,
        ref: new WeakRef(media),
      };
      STATE.set(media, state);
      ATTACHED.add(state.ref);

      // autoplay policy で suspended のままだと attach 済み要素が無音になる。
      // ここで失敗しても play / volumechange / user gesture の再試行経路がある。
      if (ctx.state === "suspended") resumeContext(ctx);

      failureStage = "settings";
      applyStateSettings(state, currentSettings, true);
      syncLeaseHeartbeat();
    } catch {
      // EME の期待された回避とは分離し、実装例外として固定 reason code で一度だけ可視化する。
      const reasonCode = {
        prepare: "mes-dsp-prepare-before-capture-failed",
        capture: "mes-attach-capture-failed",
        connect: "mes-dsp-connect-after-capture-failed",
        register: "mes-state-register-failed",
        settings: "mes-settings-apply-failed",
      }[failureStage];
      reportDiagnosticOnce(reasonCode);
      // graph 接続完了後の登録・設定失敗では直結を足すと二重出力になるため、現状の
      // ニュートラル graph を維持する。capture 後かつ graph 未完成の失敗だけを直結で救済する。
      if (failureStage === "register") {
        ATTACH_REJECTED.add(media);
        return;
      }
      if (failureStage === "settings") return;
      ATTACH_REJECTED.add(media);
      if (ctx && source) {
        if (!dryBypassConnected) {
          // capture 成立後の失敗: close せず直結 bypass で音を生かす (close は復帰不能なため)。
          try {
            source.connect(ctx.destination);
          } catch {
            // 直結 bypass も失敗した場合、それ以上の破壊的操作 (close 等) は行わない。
            reportDiagnosticOnce("mes-bypass-connect-failed");
          }
        }
        // dry bypass 確立後に wet graph だけ失敗した場合も ctx を生かす。
      } else if (ctx) {
        // capture 未成立 (source null): close しても media は影響を受けないため安全。
        ctx.close().catch(() => {});
      }
    } finally {
      ATTACHING.delete(media);
    }
  }

  /**
   * AudioParamの現在値を時刻nowへ固定して既存automationを取消し、targetへ短くrampする。
   * lease有効時は、その後ろへ期限時刻からneutralへ戻るrampを予約する。
   *
   * イベント順は常に
   * `anchor/cancel(now) → target ramp(now) → neutral ramp(deadline) → neutral固定(deadline+5τ)`。
   * heartbeatはdeadline前に同じ順序で予約を置き直すため、正常時のtargetがneutral予約で
   * 上書きされない。sandbox/timer消滅時だけ最後のneutral予約がAudioContext timeline上で発火する。
   */
  function scheduleLeasedParam(param, target, neutral, now, withLease) {
    try {
      if (typeof param.cancelAndHoldAtTime === "function") {
        param.cancelAndHoldAtTime(now);
      } else {
        const held = param.value;
        param.cancelScheduledValues(now);
        param.setValueAtTime(held, now);
      }
      param.setTargetAtTime(target, now, VolumeBooster.RAMP_TIME_CONSTANT);
      if (withLease) {
        const deadline = now + LEASE_TIMEOUT_SECONDS;
        param.setTargetAtTime(
          neutral,
          deadline,
          VolumeBooster.RAMP_TIME_CONSTANT,
        );
        // setTargetAtTime は漸近するため、5 time constants 後に完全な 0/1 へ固定する。
        param.setValueAtTime(
          neutral,
          deadline + VolumeBooster.RAMP_TIME_CONSTANT * 5,
        );
      }
      return true;
    } catch {
      reportDiagnosticOnce("mes-lease-automation-failed");
      return false;
    }
  }

  function scheduleOutputMix(state, active, withLease) {
    const now = state.ctx.currentTime;
    // dry/wetは同一time constantで逆方向へ動かし、通常適用・lease失効とも短いcrossfadeにする。
    // 並列経路が混ざるのはramp中だけで、定常時は必ず片側gain=0となる。
    const dryOk = scheduleLeasedParam(state.dryGainNode.gain, active ? 0 : 1, 1, now, withLease);
    const wetOk = scheduleLeasedParam(state.wetGainNode.gain, active ? 1 : 0, 0, now, withLease);
    if (!dryOk || !wetOk) {
      // 片側だけ予約されると二重出力または無音になるため、両側を即時bypassへ倒す。
      scheduleLeasedParam(state.dryGainNode.gain, 1, 1, now, false);
      scheduleLeasedParam(state.wetGainNode.gain, 0, 0, now, false);
    }
  }

  function applyStateSettings(state, settings, withLease = false) {
    // neutral化はDSP parameter更新より先に出力crossfadeを予約する。後続更新が例外でも旧wet設定は残らない。
    if (!withLease) scheduleOutputMix(state, false, false);
    const clamped = VolumeBooster.clampValue(settings.gain);
    const targetGain = settings.muted === true ? 0 : VolumeBooster.percentToGain(clamped);
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
    applyFilterPreset(
      state.bassCutNodes,
      settings.bassCut === true ? VolumeBooster.BASS_CUT_PRESET : VolumeBooster.BASS_CUT_BYPASS,
    );
    applyEqualizer(state, settings.eqEnabled === true, settings.eqGains, settings.eqPreamp);
    // active化はDSP設定完了後にwetへcrossfadeし、未設定graphが一瞬聞こえるのを防ぐ。
    if (withLease) scheduleOutputMix(state, true, true);
  }

  function applyStateSettingsSafely(state, settings, withLease) {
    try {
      applyStateSettings(state, settings, withLease);
    } catch {
      reportDiagnosticOnce("mes-settings-apply-failed");
      scheduleOutputMix(state, false, false);
    }
  }

  function stopLeaseHeartbeat() {
    leaseHeartbeatGeneration += 1;
    leaseHeartbeatCheckInFlight = false;
    if (leaseHeartbeatTimer !== null) {
      clearInterval(leaseHeartbeatTimer);
      leaseHeartbeatTimer = null;
    }
  }

  function refreshAudioParamLeases() {
    if (orphaned || !isRuntimeAvailable()) {
      stopLeaseHeartbeat();
      if (!orphaned) teardownOrphan();
      return;
    }
    if (leaseHeartbeatCheckInFlight) return;
    if (!isActive() || ATTACHED.size === 0) {
      stopLeaseHeartbeat();
      return;
    }
    // runtime.id/getURLだけでなくstorage APIの成功まで確認してからleaseを延長する。
    // 旧sandboxのtimerだけが生き残った場合、API失敗時に予約を更新せず安全側のneutral化へ委ねる。
    const requestGeneration = leaseHeartbeatGeneration;
    leaseHeartbeatCheckInFlight = true;
    try {
      chrome.storage.local.get([StorageKeys.VOLUME_BOOSTER_ENABLED], (stored) => {
        let runtimeError = null;
        try {
          runtimeError = chrome.runtime.lastError ?? null;
        } catch {
          runtimeError = new Error("extension context invalidated");
        }
        if (requestGeneration !== leaseHeartbeatGeneration) return;
        leaseHeartbeatCheckInFlight = false;
        if (runtimeError || !isRuntimeAvailable()) {
          if (isInvalidContextError(runtimeError)) {
            teardownOrphan();
          } else {
            reportDiagnosticOnce("mes-lease-heartbeat-failed");
            stopLeaseHeartbeat();
          }
          return;
        }
        if (stored?.[StorageKeys.VOLUME_BOOSTER_ENABLED] !== true) {
          currentSettings = { ...currentSettings, enabled: false };
          stopLeaseHeartbeat();
          forEachAttached((media, state) => applyStateSettingsSafely(state, NEUTRAL_SETTINGS, false));
          return;
        }
        if (!isActive() || ATTACHED.size === 0) {
          stopLeaseHeartbeat();
          return;
        }
        forEachAttached((media, state) => scheduleOutputMix(state, true, true));
        if (ATTACHED.size === 0) stopLeaseHeartbeat();
      });
    } catch (error) {
      if (requestGeneration !== leaseHeartbeatGeneration) return;
      leaseHeartbeatCheckInFlight = false;
      if (isInvalidContextError(error)) {
        teardownOrphan();
      } else {
        reportDiagnosticOnce("mes-lease-heartbeat-failed");
        stopLeaseHeartbeat();
      }
    }
  }

  function syncLeaseHeartbeat() {
    if (orphaned || tearingDown || !isActive() || ATTACHED.size === 0) {
      stopLeaseHeartbeat();
      return;
    }
    if (leaseHeartbeatTimer !== null) return;
    leaseHeartbeatTimer = setInterval(refreshAudioParamLeases, LEASE_HEARTBEAT_MS);
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
    syncLeaseHeartbeat();
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
      if (state && state.ctx.state === "suspended") resumeContext(state.ctx);
      evaluateMedia(media);
    }, { signal });
    // サイト UI での unmute (volumechange) も resume 契機にする (muted autoplay → 手動 unmute 対策)
    media.addEventListener("volumechange", () => {
      const state = STATE.get(media);
      if (state && state.ctx.state === "suspended") resumeContext(state.ctx);
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
      if (state.ctx.state === "suspended") resumeContext(state.ctx);
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
    // 設定適用前に旧heartbeat callbackを失効させ、古いtargetのlease再予約を防ぐ。
    stopLeaseHeartbeat();
    if (!isActive()) {
      // 将来leaseを取消し即neutralへ戻す。
      // 既 attach 要素は detach (ctx.close) ではなくニュートラル設定へ ramp して bypass 維持。
      // Firefox では close しても直接出力に復帰しないため、close は「音を殺す」操作にしかならない。
      // 一度も attach していないページでは何も起きない (完全無処理 = デフォルト OFF 方針)。
      forEachAttached((media, state) => applyStateSettingsSafely(state, NEUTRAL_SETTINGS, false));
      // observer は「DOM 除去要素の猶予付き解放」のため attach 済みが残る限り維持する
      if (ATTACHED.size === 0) disconnectObserver();
      return;
    }
    ensureObserver();
    ensureGestureResumeListeners();
    // active設定適用と同じ同期処理内で必ずleaseを予約し、次heartbeatまでの無保証区間を作らない。
    forEachAttached((media, state) => applyStateSettingsSafely(state, currentSettings, true));
    for (const media of document.querySelectorAll("video, audio")) {
      watchMedia(media);
      if (!STATE.has(media)) attachToMedia(media);
    }
    syncLeaseHeartbeat();
  }

  // ============================================================
  // storage 監視 (popup → storage 直書きが唯一のトリガー)
  // ============================================================

  const WATCHED_KEYS = [
    StorageKeys.VOLUME_BOOSTER_ENABLED,
    StorageKeys.VOLUME_BOOSTER_LAST_GAIN,
    StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
    StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED,
    StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED,
    StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED,
    StorageKeys.VOLUME_BOOSTER_EQ_ENABLED,
    StorageKeys.VOLUME_BOOSTER_EQ_GAINS,
    StorageKeys.VOLUME_BOOSTER_EQ_PREAMP,
  ];
  const WATCHED_KEY_SET = new Set(WATCHED_KEYS);
  let settingsLoadGeneration = 0;

  function loadAndApply() {
    if (orphaned) return;
    if (!isRuntimeAvailable()) {
      teardownOrphan();
      return;
    }
    const generation = ++settingsLoadGeneration;
    try {
      chrome.storage.local.get(WATCHED_KEYS, (s) => {
        let runtimeError = null;
        try {
          runtimeError = chrome.runtime.lastError ?? null;
        } catch {
          runtimeError = new Error("extension context invalidated");
        }
        if (runtimeError || !isRuntimeAvailable()) {
          if (isInvalidContextError(runtimeError)) teardownOrphan();
          else reportDiagnosticOnce("mes-storage-read-failed");
          return;
        }
        if (orphaned) return;
        if (generation !== settingsLoadGeneration) return;
        currentSettings = {
          enabled: s[StorageKeys.VOLUME_BOOSTER_ENABLED] === true,
          gain: VolumeBooster.clampValue(s[StorageKeys.VOLUME_BOOSTER_LAST_GAIN] ?? VolumeBooster.DEFAULT),
          antiClip: s[StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED] === true,
          nightMode: s[StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED] === true,
          bassCut: s[StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED] === true,
          muted: s[StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED] === true,
          eqEnabled: s[StorageKeys.VOLUME_BOOSTER_EQ_ENABLED] === true,
          eqGains: VolumeBooster.clampEqGains(s[StorageKeys.VOLUME_BOOSTER_EQ_GAINS]),
          eqPreamp: VolumeBooster.clampEqPreamp(s[StorageKeys.VOLUME_BOOSTER_EQ_PREAMP]),
        };
        scanAndApply();
      });
    } catch (error) {
      if (isInvalidContextError(error)) teardownOrphan();
      else reportDiagnosticOnce("mes-storage-read-failed");
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (orphaned) return;
    if (!isRuntimeAvailable()) {
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
  function scheduleDetachedCheck(media, retries = 0) {
    if (!STATE.has(media)) return;
    setTimeout(() => {
      if (orphaned) return;
      if (!STATE.has(media) || media.isConnected) return;
      if (!media.paused && !media.ended && retries < DETACH_MAX_RETRIES) {
        scheduleDetachedCheck(media, retries + 1);
        return;
      }
      // 再接続 / 再生停止で detach、または上限到達で強制 detach。上限到達時は Firefox では音が
      // 戻らない代償を払うが、detached+再生継続の異常系での無限メモリ保持を防ぐ (/rere C2-M3)。
      detachFromMedia(media);
    }, DETACH_GRACE_MS);
  }

  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      if (!isRuntimeAvailable()) {
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
    tearingDown = true;
    stopLeaseHeartbeat();
    try {
      disconnectObserver();
      listenerCtrl.abort();
      listenerCtrl = new AbortController();
      gestureResumeAttached = false;
      watchedMedia = new WeakSet();
      forEachAttached((media, state) => {
        if (closeContexts) {
          detachFromMedia(media);
        } else {
          applyStateSettingsSafely(state, NEUTRAL_SETTINGS, false);
        }
      });
    } finally {
      tearingDown = false;
    }
  }

  /**
   * 拡張機能リロード後の orphan 化検知時の teardown。graph は bypass 維持で残す
   * (Firefox では ctx.close しても音声が直接出力に復帰しない = close は音を殺すだけのため)。
   * guardが走らずsandboxごと消えた場合も、最後のlease予約がdry=1 / wet=0へ戻す。
   * 後継 content script の attach は MES 二重 attach 例外 → 恒久スキップに落ちるが、
   * 旧graphは期限後bypassとなり音は流れ続ける (ページ再読み込みで完全復旧)。
   */
  function teardownOrphan() {
    if (orphaned) return;
    orphaned = true;
    teardownAll(false);
  }

  window.addEventListener("pagehide", (event) => {
    // bfcache凍結中はheartbeatを止め、AudioContextが進む環境でもlease期限でneutralへ倒す。
    // 復帰時はloadAndApplyが最新設定を再適用し、leaseも同じ同期処理内で再開する。
    if (event.persisted) {
      stopLeaseHeartbeat();
      return;
    }
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
