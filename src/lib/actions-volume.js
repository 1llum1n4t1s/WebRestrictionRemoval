"use strict";

// 定義を globalThis で共有し、同じフレームでの再評価時も参照を維持する。
(() => {
  if (globalThis.__cpaActionsVolumeLoaded === true) return;
  globalThis.__cpaActionsVolumeLoaded = true;

/**
 * @readonly 音量ブースター（タブごとの音量増幅）の定数（独自実装）。
 *
 * Chrome の標準 API（`chrome.tabCapture.getMediaStreamId` + `getUserMedia` + AudioContext +
 * GainNode）のみを使ってタブ音声を増幅する。`tabCapture` で取得した MediaStream を offscreen
 * の AudioContext に流し込み、単純な GainNode で増幅して `destination` に再出力するパイプライン
 * （音質変更などの追加処理は持たない）。
 *
 * master トグルなしのスライダーのみ構成。UNITY (100%) のときは AudioContext を解放、
 * それ以外の値が設定された時点でブーストを起動する。
 */
const VolumeBooster = Object.freeze({
  // EQ preset は表示用で、実行時は gains を使用する。
  SETTINGS_KEYS: Object.freeze([
    StorageKeys.VOLUME_BOOSTER_ENABLED,
    StorageKeys.VOLUME_BOOSTER_LAST_GAIN,
    StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
    StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED,
    StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED,
    StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED,
    StorageKeys.VOLUME_BOOSTER_EQ_ENABLED,
    StorageKeys.VOLUME_BOOSTER_EQ_GAINS,
    StorageKeys.VOLUME_BOOSTER_EQ_PREAMP,
  ]),
  normalizeSettings(stored) {
    return {
      enabled: stored[StorageKeys.VOLUME_BOOSTER_ENABLED] === true,
      gain: VolumeBooster.clampValue(stored[StorageKeys.VOLUME_BOOSTER_LAST_GAIN] ?? VolumeBooster.DEFAULT),
      antiClip: stored[StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED] === true,
      nightMode: stored[StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED] === true,
      bassCut: stored[StorageKeys.VOLUME_BOOSTER_BASS_CUT_ENABLED] === true,
      muted: stored[StorageKeys.VOLUME_BOOSTER_MUTED_ENABLED] === true,
      eqEnabled: stored[StorageKeys.VOLUME_BOOSTER_EQ_ENABLED] === true,
      eqGains: VolumeBooster.clampEqGains(stored[StorageKeys.VOLUME_BOOSTER_EQ_GAINS]),
      eqPreamp: VolumeBooster.clampEqPreamp(stored[StorageKeys.VOLUME_BOOSTER_EQ_PREAMP]),
    };
  },
  MIN: 0,
  /** デフォルト音量 (%)。100 で原音そのまま（gain 1.0、リソース解放状態）。 */
  DEFAULT: 100,
  MAX: 300,
  /** スライダー上の「等倍ライン」。この値ではブースト処理を起動せず AudioContext を解放する。 */
  UNITY: 100,
  /** UI スライダーの内部最小値。実音量 percent とは別に扱い、100% を中央へ置く。 */
  SLIDER_MIN: 0,
  /** UI スライダーの中央/等倍位置。 */
  SLIDER_UNITY: 100,
  /** UI スライダーの内部最大値。左半分 0..100% / 右半分 100..300% に割り当てる。 */
  SLIDER_MAX: 200,
  STEP: 1,
  /**
   * ± ボタン 1 回あたりの増減幅（**表示 % = 実音量倍率**なので 10 = 0.1 倍）。
   * スライダーは中央 100% を境に左右で割り当てが違う（左 0..100% / 右 100..300%）ため、
   * 増減は「スライダー位置」ではなく **percent 側で計算**して位置へ変換し直す。
   */
  NUDGE_STEP: 10,
  /**
   * gain 変更時の `setTargetAtTime` time constant (秒)。
   * 約 3τ (~45ms) で目標値の 95% に到達する設定。
   * 直接 `.value =` 代入だとサンプル境界で不連続が発生し、クリック/プチノイズの原因になる。
   * popup 側の debounce が 120ms なのでドラッグ中も次の更新前にランプが収束する。
   */
  RAMP_TIME_CONSTANT: 0.015,
  clampValue(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return VolumeBooster.DEFAULT;
    if (n < VolumeBooster.MIN) return VolumeBooster.MIN;
    if (n > VolumeBooster.MAX) return VolumeBooster.MAX;
    return Math.round(n);
  },
  /**
   * UNITY release 判定（音量ブースターが実質無処理な状態か）: gain が UNITY(100%) かつ
   * 全サブトグル OFF かつミュート OFF かつ EQ OFF なら AudioContext / MES パイプラインを
   * 解放してよい（100% でもサブトグル / EQ / ミュートのいずれかが ON なら処理を維持）。
   * background.js（tabCapture 経路の release 早期 return）と volume-booster-mes.js
   * （Firefox MES 経路の bypass 判定）が同一条件をベタ書きして per-browser drift の温床に
   * なっていたのを単一情報源化する（/rere D-002）。
   * settings は {gain, antiClip, nightMode, bassCut, muted, eqEnabled}（gain は clampValue 済み整数を想定）。
   */
  isUnityRelease(settings) {
    return (
      settings.gain === VolumeBooster.UNITY &&
      !settings.antiClip &&
      !settings.nightMode &&
      !settings.bassCut &&
      !settings.muted &&
      !settings.eqEnabled
    );
  },
  /**
   * スライダー percent (0..MAX) を実 gain 倍率に変換する線形マッピング。
   *
   * 「表示 % = 実音量倍率」を一致させる: 100% = 1.0x / 150% = 1.5x / 200% = 2.0x /
   * MAX(300)% = 3.0x。単純に percent / 100 を返すだけ。
   *
   * 旧実装は 100..MAX を対数（等 dB ステップ）で配分してドラッグ体感を均一化していたが、
   * 表示 % と実倍率が乖離し「150% なのに約 1.2 倍」とユーザーに誤読される問題があったため
   * 線形に統一した（ゆろさん指摘 2026-06-27）。スライダー UI は sliderPositionToPercent 側で
   * 中央 = 等倍 (100%)・左で減衰・右で増幅の配置を維持しているので操作感は変わらない。
   */
  percentToGain(percent) {
    return VolumeBooster.clampValue(percent) / 100;
  },
  /**
   * percentToGain の逆関数。実 gain 倍率からスライダー上の整数 percent を復元する。
   * 線形マッピングなので gain × 100 を四捨五入して 0..MAX にクランプするだけ。
   * popup syncCurrentTabVolume などで AudioContext 内の現在 gain を表示値に戻すときに使う。
   */
  gainToPercent(gain) {
    const g = Number(gain);
    if (!Number.isFinite(g) || g <= 0) return VolumeBooster.MIN;
    return VolumeBooster.clampValue(Math.round(g * 100));
  },
  /**
   * UI スライダー位置 (0..200) を実音量 percent (0..MAX) に変換する。
   * 100% を中央へ置くため、下げる側は 0..100、上げる側は 100..MAX に分ける。
   */
  sliderPositionToPercent(position) {
    const n = Number(position);
    const p = Number.isFinite(n) ? n : VolumeBooster.SLIDER_UNITY;
    const clamped = Math.min(VolumeBooster.SLIDER_MAX, Math.max(VolumeBooster.SLIDER_MIN, p));
    if (clamped <= VolumeBooster.SLIDER_UNITY) {
      return VolumeBooster.clampValue(clamped);
    }
    const t = (clamped - VolumeBooster.SLIDER_UNITY) /
      (VolumeBooster.SLIDER_MAX - VolumeBooster.SLIDER_UNITY);
    return VolumeBooster.clampValue(
      VolumeBooster.UNITY + t * (VolumeBooster.MAX - VolumeBooster.UNITY)
    );
  },
  /** 実音量 percent (0..MAX) から UI スライダー位置 (0..200) を復元する。 */
  /**
   * 現在の音量 (%) を `delta` だけ動かして範囲内へ収める（純粋関数）。
   * ± ボタン用。端では clamp されるだけで、範囲外へは出ない。
   *
   * @param {unknown} percent 現在値（不正値は DEFAULT 扱い）
   * @param {unknown} delta 増減量（不正値は 0 扱い＝現在値を維持）
   * @returns {number} MIN〜MAX に収めた整数 %
   */
  nudgePercent(percent, delta) {
    const base = VolumeBooster.clampValue(percent);
    const d = Number(delta);
    if (!Number.isFinite(d)) return base;
    return VolumeBooster.clampValue(Math.round(base + d));
  },

  percentToSliderPosition(percent) {
    const p = VolumeBooster.clampValue(percent);
    if (p <= VolumeBooster.UNITY) return p;
    const t = (p - VolumeBooster.UNITY) / (VolumeBooster.MAX - VolumeBooster.UNITY);
    return Math.round(
      VolumeBooster.SLIDER_UNITY + t * (VolumeBooster.SLIDER_MAX - VolumeBooster.SLIDER_UNITY)
    );
  },
  /**
   * 自動歪み防止用 DynamicsCompressor プリセット。
   * threshold:-3dBFS / ratio:12、attack:1ms / release:50ms で大半のピークを抑える。
   * この段だけではサンプルピークが ±1 を超える（音量 3 倍・1 kHz EQ +6 dB の定常正弦で約 1.07）。
   * attack 0・ratio 20 に強めても 1 を少し超えたままなので、後段の WaveShaper が
   * 範囲外のサンプルだけを ±1 に揃える。サンプル間の再構成ピークは対象にしない。
   */
  ANTI_CLIP_PRESET: Object.freeze({
    threshold: -3,
    knee: 0,
    ratio: 12,
    attack: 0.001,
    release: 0.05,
  }),
  /**
   * ナイトモード用コンプレッサー（ダイナミックレンジを縮める）。
   *
   * 履歴:
   * - 旧 ratio:2.5 / release:0.4 はゲーム配信の爆音抑制向きだが、BGM + ナレーション動画で
   *   「喋りが圧縮 → やめた瞬間に release で BGM が立ち上がる」ポンピングが目立った。
   * - 中間 threshold:-18 / ratio:2.0 / release:1.0s は語間ポンピングは抑えられたものの、
   *   「圧縮が弱くて大きい音と小さい音の幅が広すぎる」という体感問題が残った。
   *
   * 現行 threshold:-30 / knee:12 / ratio:4.0 / release:1.0s:
   *   - threshold を -18 → -30 dBFS まで下げ、ダイアログ帯（-22〜-28 dBFS RMS）を確実に
   *     圧縮対象に収める。typical な action 動画の 24dB ダイナミックレンジ（softest -30dB,
   *     loudest -6dB）が圧縮後 6dB 程度（-30 → -24dB）に縮まり、夜間視聴で大きい音が
   *     飛び出してこなくなる。
   *   - ratio を 2.0 → 4.0 に倍化。ratio:4 は放送向け圧縮の標準値で、aggressive すぎず
   *     dynamic range をしっかり潰せる落としどころ。
   *   - knee を 8 → 12 dB に広げて、threshold 越えの折れ目を滑らかにし「圧縮感」を耳に
   *     付かなくする。dialog 中心帯が knee 内で扱われるため、自然なフェード圧縮になる。
   *   - release は引き続き 1.0s（Chrome の nominal max）で句末ポンピング抑制を維持。
   * antiClipNode の後段が、±1 を超えたサンプルだけを ±1 に揃える。
   */
  NIGHT_MODE_PRESET: Object.freeze({
    threshold: -30,
    knee: 12,
    ratio: 4.0,
    attack: 0.02,
    release: 1.0,
  }),
  /**
   * compressor 機能 OFF 時のバイパス設定（ratio:1 で実質パススルー）。
   * AudioContext の構築コストを避けるためチェーン上は常時接続のままパラメータで制御する。
   *
   * attack:0.003 / release:0.25 は Web Audio API の DynamicsCompressor デフォルト値。
   * `0` を渡すと Chrome が内部最小値 (~0.0003 秒) に clamp し DevTools 警告を出すケースが
   * あるため、安全側のデフォルト値を採用してパススルー時の DSP 負荷も最小化する。
   */
  COMPRESSOR_BYPASS: Object.freeze({
    threshold: 0,
    knee: 0,
    ratio: 1,
    attack: 0.003,
    release: 0.25,
  }),
  /**
   * 壁ドン対策モード用 highpass フィルタ段数。
   * 2次 Butterworth を2段直列にして Linkwitz-Riley 4次相当（24dB/oct）にする。
   * 1段（12dB/oct）ではカットオフ直下の低音が残りやすく、壁・床の振動対策として弱かった。
   */
  BASS_CUT_STAGES: 2,
  /**
   * 壁ドン対策モード用 highpass フィルタプリセット（各 BiquadFilterNode type:"highpass"）。
   * カットオフ 150Hz は、壁・床を伝って隣室に響きやすいサブベース〜低音域（ドスドス感の主因）を
   * 除去しつつ、ボーカルや楽器の芯（中音域）は残す落としどころ。各段は共振ピークを作らない
   * Butterworth 特性で固定し、同一段の直列化で減衰だけを急峻にする。
   *
   * **Q の単位に注意（復活禁止: `Q: 0.7071`）**: Web Audio API の `lowpass` / `highpass` の Q は
   * `peaking` などと違い「カットオフでの共振量を **デシベル** で指定」する例外仕様。線形 Q の
   * Butterworth 値 0.7071 をそのまま入れると「+0.71dB の共振」の意味になり、実測（2 段合成）で
   * 150Hz +1.4dB / 200Hz +3.5dB / 250Hz +2.9dB と、**壁を伝うドスドス感の主帯域を逆にブースト**
   * してしまう（「壁ドン対策が効かない」の実原因。2026-08-04 修正）。Butterworth 相当の指定値は
   * `20*log10(0.7071) = -3.0103` dB で、修正後は 150Hz -6.0dB / 200Hz -2.4dB と素直な減衰になる。
   */
  BASS_CUT_PRESET: Object.freeze({
    frequency: 150,
    Q: -3.0103,
  }),
  /**
   * 壁ドン対策モード OFF 時のバイパス設定。highpass のカットオフを 0Hz にすると
   * 可聴域全体を素通しできる（disconnect/reconnect による音切れを避けるため、
   * COMPRESSOR_BYPASS と同じ「ノードは繋いだままパラメータで無効化」方式）。
   * frequency:0 では Q は特性に影響しない（実測で全帯域 0dB）が、PRESET と単位を
   * 揃えておくため同じ dB 表記の Butterworth 値を入れる。
   */
  BASS_CUT_BYPASS: Object.freeze({
    frequency: 0,
    Q: -3.0103,
  }),

  // ===== Firefox 専用 MES (MediaElementSource) 経路 =====
  /**
   * EME (DRM) 動画を多用するサイトの hostname ブラックリスト (Firefox MES 経路専用)。
   *
   * これらのサイトでは MediaElementSource 経路 (content script の volume-booster-mes.js) を
   * 起動しない。理由: `createMediaElementSource(video)` で video の音声経路を AudioContext に
   * redirect すると、EME 保護動画は復号後の音声 sample を AudioContext に流さない仕様
   * (Chrome / Firefox 共通) のため、結果として **動画の音そのものが完全無音化** する副作用がある。
   *
   * Chrome には tabCapture フォールバックがあるが、Firefox MV3 は tabCapture 未対応なので
   * これらのサイトでは音量ブースターは効かない (動画の音は普通に出る)。
   *
   * このリストにないサイトでも runtime で EME を検出した場合 (`mediaKeys` / `encrypted` event) は
   * volume-booster-mes.js が attach 回避 / detach する fallback がある。完璧な保護は
   * ホスト名ブラックリストのみなので、追加要望があったら hostname を確認して RegExp を追加すること。
   *
   * 履歴: v1.0.33 の MES 経路 (Chrome + Firefox 両対応、URL 分岐あり) 用に導入 → v1.0.35 で
   * MES 経路ごと撤去 → 2026-07-02 に Firefox 専用パイプラインとして復活 (Chrome は tabCapture 一本のまま)。
   */
  EME_HOSTS: Object.freeze([
    /(^|\.)netflix\.com$/,
    /(^|\.)primevideo\.com$/,
    // Amazon Prime Video は amazon.co.jp / amazon.com の `/gp/video/` 配下に統合されているため
    // 親ドメイン全体を入れる。Amazon ランキング機能 (amazon-ranking-jump.js) と同居するが、
    // ランキングは商品ページ DOM 操作 + 外部送信ゼロなので衝突しない (volume-booster-mes だけ EME skip)。
    /(^|\.)amazon\.co\.jp$/,
    /(^|\.)amazon\.com$/,
    /(^|\.)dazn\.com$/,
    /(^|\.)disneyplus\.com$/,
    /(^|\.)hulu\.com$/,
    /(^|\.)hulu\.jp$/,
    /(^|\.)tv\.apple\.com$/,
    /(^|\.)abema\.tv$/,
    /(^|\.)unext\.jp$/,
    /(^|\.)tver\.jp$/,
    /(^|\.)nhk-ondemand\.jp$/,
    /(^|\.)spotify\.com$/,
    /(^|\.)fod\.fujitv\.co\.jp$/,
    /(^|\.)spoox\.jp$/,
  ]),

  /**
   * hostname が EME_HOSTS のいずれかに該当するか判定する純粋関数 (Firefox MES 経路専用)。
   * volume-booster-mes.js が起動時に `location.hostname` を渡して MES 起動を skip する。
   *
   * @param {string|null|undefined} hostname `location.hostname` または URL から抽出した hostname
   * @returns {boolean} true なら EME 多用サイトで MES 経路を使わない
   */
  isEmeHost(hostname) {
    if (typeof hostname !== "string" || hostname.length === 0) return false;
    const lower = hostname.toLowerCase();
    for (const re of VolumeBooster.EME_HOSTS) {
      if (re.test(lower)) return true;
    }
    return false;
  },

  /**
   * MES attach 可否のためのメディアソース安全性分類 (Firefox MES 経路専用の純粋関数)。
   *
   * cross-origin かつ CORS 未検証のメディアに MediaElementSource を繋ぐと、Web Audio 仕様で
   * 例外ではなく **出力が無音になる** (site の音が消えたように見える最悪の failure mode)。
   * さらに Firefox では一度 attach した要素は `ctx.close()` でも直接出力に復帰しないため、
   * 誤 attach は「ページ再読み込みまで無音」になり得る。attach 前の分類で徹底的に防ぐ。
   * - `"safe"`: 即 attach してよい。blob: / data: (MSE・インラインは taint しない)、または
   *   `crossorigin` 属性付き http(s) (CORS 検証を通ったリソースしか再生されない = リダイレクト先も
   *   含めて taint し得ない)
   * - `"probe"`: same-origin http(s) かつ crossorigin 属性なし。URL 上は安全に見えるが、HTML 仕様上
   *   `currentSrc` は**リダイレクト前の URL** を返すため、same-origin → cross-origin redirect 配信
   *   (メディアプロキシ / presigned CDN 等) だと opaque taint で無音化する。caller が
   *   `redirect: "manual"` の same-origin HEAD probe で opaqueredirect でないことを確認してから
   *   attach する (probe 失敗 / redirect 検出時は attach しない = 音は普通に出る fail-safe)
   * - `"pending"`: ソース未確定 (currentSrc が空)。loadedmetadata / loadstart で再評価する
   * - `"unsafe"`: cross-origin かつ CORS 未検証。attach すると無音化するため skip
   *
   * `srcObject` (MediaStream 等) は URL を持たないため本関数の対象外で、caller が別途 safe 扱いする。
   *
   * @param {string|null|undefined} currentSrc `media.currentSrc`
   * @param {string|null|undefined} crossOrigin `media.crossOrigin` ("anonymous" / "use-credentials" / null)
   * @param {string} pageHref `location.href` (相対 URL 解決 + same-origin 判定基準)
   * @returns {"safe"|"probe"|"pending"|"unsafe"}
   */
  classifyMesSource(currentSrc, crossOrigin, pageHref) {
    if (typeof currentSrc !== "string" || currentSrc === "") return "pending";
    let url;
    try {
      url = new URL(currentSrc, pageHref);
    } catch {
      return "unsafe";
    }
    if (url.protocol === "blob:" || url.protocol === "data:") return "safe";
    if (url.protocol === "http:" || url.protocol === "https:") {
      // crossorigin 属性付きは CORS 検証済みリソースしか再生されない (redirect 先も含む) ため
      // same-origin / cross-origin を問わず safe
      if (crossOrigin === "anonymous" || crossOrigin === "use-credentials") return "safe";
      let pageOrigin = null;
      try {
        pageOrigin = new URL(pageHref).origin;
      } catch {
        // pageHref 不正時は same-origin 判定不能 → 安全側で unsafe に倒す
      }
      if (pageOrigin !== null && url.origin === pageOrigin) return "probe";
      return "unsafe";
    }
    return "unsafe";
  },

  // ===== グラフィックイコライザ (10 バンド peaking) =====
  /**
   * イコライザの中心周波数 (Hz)。各バンド ~1 オクターブ間隔。offscreen で
   * BiquadFilterNode(type:"peaking") を 10 個直列接続し、各 gain をスライダー値 (dB) に設定する。
   * 正規化 (撤去済み) と違ってフィードバックなしの固定フィルタなので決定論的で安定。
   */
  EQ_BANDS: Object.freeze([32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]),
  EQ_BAND_COUNT: 10,
  /** 各バンドの gain 範囲 (dB)。BiquadFilterNode.gain は peaking で dB 単位。 */
  EQ_GAIN_MIN: -12,
  EQ_GAIN_MAX: 12,
  EQ_GAIN_DEFAULT: 0,
  /** プリアンプ (全体ゲイン) 範囲 (dB)。各バンド boost によるクリップを補正する用途。 */
  EQ_PREAMP_MIN: -12,
  EQ_PREAMP_MAX: 12,
  EQ_PREAMP_DEFAULT: 0,
  /** peaking フィルタの Q。~1 オクターブ間隔 10 バンドの定番値 (√2 ≈ 1.41)。 */
  EQ_Q: 1.41,
  /** プリセット未選択 (手動調整) を表す id。EQ_PRESETS には含めない特別値。 */
  EQ_PRESET_CUSTOM: "custom",
  EQ_PRESET_DEFAULT: "flat",
  /**
   * 同梱プリセット。各値は EQ_BANDS と同順の 10 バンド gain (dB)。
   * popup のドロップダウンから選択でき、手動でスライダーを動かすと "custom" に切り替わる。
   *
   * コミュニティプリセット (eargasm / eargasmKai / perfect / perfectKai) の出典:
   * - eargasm: Spotify ユーザー間で世界的に有名な "Eargasm Explosion"。iTunes / eqMac 10 バンド
   *   原典 (dacci gist, iyusuke.jp 他)。perfect の 4kHz バンドだけを +9 → +4 に下げた派生として
   *   2014 年頃に登場 (日本発、SoraNews24 が英語圏に紹介)。
   * - eargasmKai: SONY Android WALKMAN NW-A100 シリーズ向けの「Eargasm Explosion 改」
   *   (楽天ブログ hisat 氏、2021-12-04)。低域 +10 / 超高域 +10 のドンシャリ強化型。
   *   NW-A100 の 31/62Hz は Vuora の 32/64Hz と同一バンドの別表記なので直接マッピング。
   * - perfect: 2004 年頃から iTunes 10 バンド EQ で「完璧過ぎる最強の EQ 設定」として広まった
   *   preset (hints.macworld.com 2004, methodshop.com)。eargasm と 4kHz バンド (+9 vs +4) のみ
   *   異なる原典。ゆろさん判断で iTunes 10 バンド原典を採用 (Spotify 6 バンド補間版は不採用)。
   * - perfectKai: perfect を全帯域 -6dB した派生 (minkara スバルフォレスター記事 / musicfab.ne.jp
   *   ガイドで値完全一致)。「カーブ形状維持 + スピーカー負担軽減」狙い。
   *
   * 出典の詳細・補間方法・調査経緯は memory-bank / PR #27 の deep-research 結果 (wnhg9pt91) 参照。
   */
  EQ_PRESETS: Object.freeze({
    flat: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    bassBoost: Object.freeze([6, 5, 4, 2, 0, 0, 0, 0, 0, 0]),
    trebleBoost: Object.freeze([0, 0, 0, 0, 0, 0, 2, 4, 5, 6]),
    vocal: Object.freeze([-2, -1, 0, 2, 3, 3, 2, 1, 0, -1]),
    loudness: Object.freeze([5, 4, 2, 0, -1, -1, 0, 2, 4, 5]),
    eargasm: Object.freeze([3, 6, 9, 7, 6, 5, 7, 4, 11, 8]),
    eargasmKai: Object.freeze([10, 10, 10, 6, 5, 4, 6, 3, 9, 10]),
    perfect: Object.freeze([3, 6, 9, 7, 6, 5, 7, 9, 11, 8]),
    perfectKai: Object.freeze([-3, 0, 3, 1, 0, -1, 1, 3, 5, 2]),
  }),
  /**
   * プリセット id → i18n キーの対応表。`EQ_PRESETS` の全キー + `EQ_PRESET_CUSTOM` を網羅。
   * popup の dropdown 構築でラベル表示に使う (旧実装は popup.js 側 const で TDZ workaround が
   * 必要だったが、データの正しい在処はプリセット定義と同じ actions-volume.js)。
   */
  EQ_PRESET_I18N_KEYS: Object.freeze({
    flat: "volumeEqPresetFlat",
    bassBoost: "volumeEqPresetBass",
    trebleBoost: "volumeEqPresetTreble",
    vocal: "volumeEqPresetVocal",
    loudness: "volumeEqPresetLoudness",
    eargasm: "volumeEqPresetEargasm",
    eargasmKai: "volumeEqPresetEargasmKai",
    perfect: "volumeEqPresetPerfect",
    perfectKai: "volumeEqPresetPerfectKai",
    custom: "volumeEqPresetCustom",
  }),
  /** 1 バンドの gain を EQ_GAIN_MIN..MAX に clamp し整数化。不正値は EQ_GAIN_DEFAULT。 */
  clampEqGain(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return VolumeBooster.EQ_GAIN_DEFAULT;
    if (n < VolumeBooster.EQ_GAIN_MIN) return VolumeBooster.EQ_GAIN_MIN;
    if (n > VolumeBooster.EQ_GAIN_MAX) return VolumeBooster.EQ_GAIN_MAX;
    return Math.round(n);
  },
  /** プリアンプを EQ_PREAMP_MIN..MAX に clamp し整数化。不正値は EQ_PREAMP_DEFAULT。 */
  clampEqPreamp(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return VolumeBooster.EQ_PREAMP_DEFAULT;
    if (n < VolumeBooster.EQ_PREAMP_MIN) return VolumeBooster.EQ_PREAMP_MIN;
    if (n > VolumeBooster.EQ_PREAMP_MAX) return VolumeBooster.EQ_PREAMP_MAX;
    return Math.round(n);
  },
  /**
   * 任意の入力を 10 バンドの gain 配列に正規化する。
   * 配列でなければ全 EQ_GAIN_DEFAULT、長さ不足は補完、超過は切り捨て、各要素 clampEqGain。
   */
  clampEqGains(arr) {
    const src = Array.isArray(arr) ? arr : [];
    const out = new Array(VolumeBooster.EQ_BAND_COUNT);
    for (let i = 0; i < VolumeBooster.EQ_BAND_COUNT; i += 1) {
      out[i] = VolumeBooster.clampEqGain(src[i] ?? VolumeBooster.EQ_GAIN_DEFAULT);
    }
    return out;
  },
  /** プリセット id を正規化。既知プリセット or CUSTOM のみ許可、未知は EQ_PRESET_DEFAULT。 */
  normalizeEqPreset(id) {
    if (id === VolumeBooster.EQ_PRESET_CUSTOM) return VolumeBooster.EQ_PRESET_CUSTOM;
    return Object.hasOwn(VolumeBooster.EQ_PRESETS, id)
      ? id
      : VolumeBooster.EQ_PRESET_DEFAULT;
  },
  /** プリセット id から 10 バンド gain 配列 (コピー) を返す。CUSTOM / 未知は null。 */
  eqPresetGains(id) {
    if (Object.hasOwn(VolumeBooster.EQ_PRESETS, id)) {
      return VolumeBooster.EQ_PRESETS[id].slice();
    }
    return null;
  },
});

  globalThis.VolumeBooster = VolumeBooster;
})();
