"use strict";

/**
 * ルーペ機能 content script。
 *
 * 全 http(s) サイトの top frame に注入され、popup の master トグルが ON になったら
 * `chrome.tabs.captureVisibleTab` 経由でタブの静止画 (JPEG) を取得し、
 * 円形レンズ (position: fixed, clip-path: circle()) に background-image として貼り付ける。
 * mousemove でレンズ DOM の left/top と background-position を 60fps で更新し、
 * カーソル下の領域を拡大表示する。
 *
 * 設計上の不変条件:
 *   - 全 6 つの内部状態 (isActive / captureInFlight / pendingRecapture /
 *     recaptureTimer / currentBlobURL / currentZoom + currentSize) を IIFE クロージャに閉じ込め
 *   - 左クリックで OFF: storage の loupeEnabled を false に書き戻し、即座に DOM 撤去
 *   - 再キャプチャ trigger: 初回 / scroll (500ms debounced) / MutationObserver(childList, subtree:false) / resize
 *   - メモリ管理: DataURL → Blob URL に変換し、cleanup 時に必ず URL.revokeObjectURL
 *   - rAF コアレスで mousemove をスロットリング（60fps、追加 throttle 不要）
 *   - visibilitychange でタブ非表示時に cleanup（古い画面が新タブで残らない）
 *
 * 論理分割（同一 IIFE 内のクロージャ共有変数で疎結合）:
 *   - LensView: DOM 構築・スタイル更新・破棄
 *   - CaptureCoordinator: background との sendMessage / Blob URL ライフサイクル / 再キャプチャ debounce
 *   - EventHandler: addEventListener / removeEventListener / rAF コアレス
 *
 * 共通ガード:
 *   - window === window.top: top frame 限定（manifest all_frames:false と二重防御）
 *   - window.__cpaLoupeRunning: 同一フレーム二重実行防止
 */
(() => {
  // top frame 限定。manifest の all_frames:false で物理的に iframe には注入されないが
  // 防御的に二重ガード（CLAUDE.md の iframe 多重対策パターンに準拠）。
  if (window !== window.top) return;
  if (window.__cpaLoupeRunning === true) return;
  window.__cpaLoupeRunning = true;

  // ========== 状態変数（IIFE クロージャ内のみ）==========

  /** ルーペが現在 active かどうか */
  let isActive = false;
  /** readSettingsAndApply の並列実行を防ぐ dedup フラグ (/rere レビュー B1-E3) */
  let applyInFlight = false;
  /** applyInFlight 中に再呼び出しが来たら 1 回だけ後追い実行する */
  let applyQueued = false;

  /** キャプチャリクエスト in-flight かどうか（重複リクエスト防止） */
  let captureInFlight = false;

  /** in-flight 中に再キャプチャがスケジュールされたか（フライト完了後に再実行する） */
  let pendingRecapture = false;

  /**
   * キャプチャシーケンス番号（epoch）。
   * `deactivate()` で増加させることで、過去の `requestCaptureAndUpdate()` が await から戻った時点で
   * 「自分は古いリクエストだ」と検知できる。ON→OFF→ON の高速切替で旧キャプチャ画像が新セッションに
   * 紛れ込む stale フラッシュを防ぐためのガード（Phase 6 レビュー指摘 B 対応）。
   */
  let captureSeq = 0;

  /** 再キャプチャ debounce の setTimeout ID */
  let recaptureTimer = null;

  /** 現在の Blob URL（cleanup 時に revokeObjectURL する対象） */
  let currentBlobURL = null;

  /** 現在の倍率 */
  let currentZoom = Loupe.DEFAULT_ZOOM;

  /** 現在のレンズ直径 px */
  let currentSize = Loupe.SIZE_DEFAULT;

  /** ページ DOM に置くレンズホスト（closed Shadow DOM の外側。Blob URL は保持しない） */
  let lensHostEl = null;
  /** closed Shadow DOM 内の背景描画要素 */
  let lensEl = null;

  /** 倍率バッジ要素 */
  let badgeEl = null;

  /** rAF ID（mousemove スロットリング用） */
  let rafId = null;

  /** 最後のマウス位置 */
  let lastMouseX = 0;
  let lastMouseY = 0;

  /** MutationObserver インスタンス */
  let domObserver = null;

  // ========== LensView: DOM 構築 / 更新 / 破棄 ==========

  /**
   * レンズ DOM を構築して <body> に append。
   * 初期位置は画面外 (-9999) で、mousemove が来てから可視位置に更新される。
   */
  function buildLensDOM() {
    if (lensHostEl) destroyLensDOM();

    lensHostEl = document.createElement("div");
    lensHostEl.id = Loupe.LENS_ID;
    lensHostEl.className = Loupe.CLASS_LENS;
    // 初期位置は画面外。mousemove で更新される。
    lensHostEl.style.left = "-9999px";
    lensHostEl.style.top = "-9999px";

    // captureVisibleTab の Blob URL は closed Shadow DOM 内の要素にだけ設定する。
    // ページ JS から取得できる host の属性 / inline style には画像 URL を一切置かない。
    const shadow = lensHostEl.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .surface { position:absolute; inset:0; overflow:hidden; border-radius:50%;
        background-repeat:no-repeat; pointer-events:none; will-change:background-position; }
      .${Loupe.CLASS_CROSSHAIR} { position:absolute; top:50%; left:50%;
        transform:translate(-50%,-50%); width:22px; height:22px; pointer-events:none;
        background:radial-gradient(circle,rgba(255,255,255,.25) 0%,rgba(255,255,255,0) 60%);
        border-radius:50%; }
      .${Loupe.CLASS_CROSSHAIR}::before, .${Loupe.CLASS_CROSSHAIR}::after {
        content:""; position:absolute; background:rgba(255,255,255,.75); pointer-events:none;
        box-shadow:0 0 2px rgba(0,0,0,.5); }
      .${Loupe.CLASS_CROSSHAIR}::before { width:100%; height:1px; top:50%; left:0;
        transform:translateY(-50%); }
      .${Loupe.CLASS_CROSSHAIR}::after { width:1px; height:100%; top:0; left:50%;
        transform:translateX(-50%); }
      .${Loupe.CLASS_BADGE} { position:absolute; bottom:12%; right:14%; padding:3px 8px;
        border-radius:10px; background:rgba(0,0,0,.55); color:rgba(255,255,255,.95);
        font:600 11px/1 system-ui,-apple-system,"Segoe UI","IBM Plex Sans JP",sans-serif;
        letter-spacing:.04em; text-shadow:0 1px 2px rgba(0,0,0,.6); pointer-events:none;
        user-select:none; white-space:nowrap; }
    `;
    lensEl = document.createElement("div");
    lensEl.className = "surface";

    // クロスヘア（中央 +字）
    const crosshair = document.createElement("div");
    crosshair.className = Loupe.CLASS_CROSSHAIR;
    crosshair.setAttribute("aria-hidden", "true");

    // 倍率バッジ（右下に「2.5×」を表示）
    badgeEl = document.createElement("div");
    badgeEl.className = Loupe.CLASS_BADGE;
    badgeEl.setAttribute("aria-hidden", "true");

    lensEl.appendChild(crosshair);
    lensEl.appendChild(badgeEl);
    shadow.appendChild(style);
    shadow.appendChild(lensEl);

    applyLensSize();
    applyBackgroundImage();
    applyBadgeText();

    document.body.appendChild(lensHostEl);
  }

  /**
   * レンズの直径だけを更新する。`background-size` 等の画像表示パラメータは触らず、
   * 呼び出し元が必要に応じて `applyBackgroundImage()` を別途呼ぶ責務とする
   * (暗黙の連鎖呼び出しを避けて副作用を明示化)。
   */
  function applyLensSize() {
    if (!lensHostEl) return;
    lensHostEl.style.width = `${currentSize}px`;
    lensHostEl.style.height = `${currentSize}px`;
  }

  /** background-image (Blob URL) + background-size を更新 */
  function applyBackgroundImage() {
    if (!lensEl) return;
    if (currentBlobURL) {
      lensEl.style.backgroundImage = `url("${currentBlobURL}")`;
      lensEl.style.backgroundSize = `${window.innerWidth * currentZoom}px ${window.innerHeight * currentZoom}px`;
    } else {
      // キャプチャ未取得 / 失敗時: 半透明黒で「読み込み中」の視覚的ヒント
      lensEl.style.backgroundImage = "none";
      lensEl.style.backgroundColor = "rgba(0,0,0,0.2)";
    }
  }

  /** 倍率バッジテキスト更新（例: "2.5×"） */
  function applyBadgeText() {
    if (!badgeEl) return;
    // 倍率は数値 + × 記号でロケール非依存
    badgeEl.textContent = `${currentZoom}×`;
  }

  /** レンズ位置と background-position を更新（rAF callback で呼ばれる） */
  function applyLensPosition() {
    rafId = null;
    if (!lensHostEl || !lensEl || !isActive) return;

    const r = currentSize / 2;
    const pos = Loupe.computeLensPosition(lastMouseX, lastMouseY, currentSize);
    const bg = Loupe.computeBackgroundPosition(lastMouseX, lastMouseY, currentZoom, r);

    lensHostEl.style.left = `${pos.left}px`;
    lensHostEl.style.top = `${pos.top}px`;
    lensEl.style.backgroundPosition = `${bg.bgX}px ${bg.bgY}px`;
  }

  function destroyLensDOM() {
    if (lensHostEl) {
      lensHostEl.remove();
      lensHostEl = null;
      lensEl = null;
      badgeEl = null;
    }
  }

  // ========== CaptureCoordinator: background との通信 + Blob URL 管理 ==========

  /**
   * background に LOUPE_REQUEST_CAPTURE を送って DataURL を取得し、
   * Blob URL に変換して currentBlobURL に保持する。古い Blob URL は revoke する。
   *
   * 同時に複数の capture が走らないように captureInFlight でガードし、
   * 進行中に scheduleRecapture が呼ばれた場合は pendingRecapture フラグで完了後に再実行する。
   *
   * @returns {Promise<boolean>} 成功なら true（lens 更新が完了）、失敗なら false
   */
  async function requestCaptureAndUpdate() {
    // zombie guard (/rere レビュー B1-D3 / D-4 横展開 PATTERN SYNC):
    // orphan content script では sendMessage が "Extension context invalidated" で reject する。
    // catch で silent fail はするが、lens DOM が残置されるので deactivate でクリーンアップする。
    if (!chrome.runtime?.id) {
      deactivate();
      return false;
    }
    if (captureInFlight) {
      pendingRecapture = true;
      return false;
    }
    captureInFlight = true;
    // 自分が開始したリクエストの epoch を記録。await から戻った時点で captureSeq が進んでいれば
    // 「ON→OFF→ON 等で別セッションに切り替わった」ことを意味するため、結果を破棄する。
    const mySeq = captureSeq;
    let success = false;
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.LOUPE_REQUEST_CAPTURE,
      });
      // epoch ガード: 自分の世代と現在の世代が一致しないなら、deactivate / 別 activate が走った後。
      // isActive が再 true に戻っているケース (stale 表示) も含めて確実に弾ける。
      if (!isActive || mySeq !== captureSeq) return false;
      if (res?.ok && typeof res.dataUrl === "string") {
        const newBlobURL = await dataUrlToBlobURL(res.dataUrl);
        if (!isActive || mySeq !== captureSeq) {
          // dataUrlToBlobURL の await 中に OFF / 世代切替された場合は新 Blob URL を破棄して leak 防止
          URL.revokeObjectURL(newBlobURL);
          return false;
        }
        // 古い Blob URL を解放してから新しいものに切替
        revokeCurrentBlobURL();
        currentBlobURL = newBlobURL;
        applyBackgroundImage();
        success = true;
      } else {
        // sendResponse がエラー: silent fail（lens は古い画像のまま）
        // 詳細は console.warn で開発者向けに残す
        console.warn("[WebViewingAssist] loupe capture failed:", res?.error);
      }
    } catch (err) {
      console.warn("[WebViewingAssist] loupe capture exception:", err);
    } finally {
      captureInFlight = false;
      // 進行中に scheduleRecapture が積み上がっていたら 1 回だけ後追い実行
      // (epoch が進んでいる = deactivate 済みなら isActive が false なのでこの分岐は走らない)
      if (pendingRecapture && isActive && mySeq === captureSeq) {
        pendingRecapture = false;
        scheduleRecapture();
      }
    }
    return success;
  }

  /** DataURL を Blob URL に変換（メモリ管理を revokeObjectURL で明示制御可能にする） */
  async function dataUrlToBlobURL(dataUrl) {
    // 旧実装は `fetch(dataUrl)` 経由で Blob 変換していたが、内部的に network stack + URL parse を
    // 通るため 100ms オーダーのオーバーヘッドがある (/rere レビュー C-#P3-A)。
    // data URL を atob で直接 decode して Uint8Array → Blob に変換することで同等の結果を得る。
    // 失敗時は旧来の fetch fallback に戻す (data URL 形式が想定外でも安全に degrade)。
    try {
      const m = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/);
      if (m) {
        // /rere B1-009 修正 (defensive coding): background の captureVisibleTab は JPEG 固定で
        // 信頼ソースだが、将来の使途拡大 (background DataURL 経路の追加 / format オプション変更等)
        // で MIME が text/html / application/javascript に化けると、Blob URL 経路が <iframe src=...>
        // / <object> 等で XSS 経路化する可能性がある。最低限のホワイトリスト validation で
        // 「画像 MIME のみ許可」を強制し、将来の構造変更耐性を確保する (実害現状ゼロ、保険的)。
        let mime = m[1] || "application/octet-stream";
        if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) {
          mime = "application/octet-stream";
        }
        const isBase64 = !!m[2];
        const payload = m[3];
        let bytes;
        if (isBase64) {
          const binary = atob(payload);
          bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        } else {
          bytes = new TextEncoder().encode(decodeURIComponent(payload));
        }
        return URL.createObjectURL(new Blob([bytes], { type: mime }));
      }
    } catch {
      // pattern unmatched or atob 失敗時は fetch fallback へ
    }
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  /** 現在の Blob URL を解放（leak 防止） */
  function revokeCurrentBlobURL() {
    if (currentBlobURL) {
      URL.revokeObjectURL(currentBlobURL);
      currentBlobURL = null;
    }
  }

  /** 再キャプチャを debounce してスケジュール */
  function scheduleRecapture() {
    if (!isActive) return;
    clearTimeout(recaptureTimer);
    recaptureTimer = setTimeout(() => {
      recaptureTimer = null;
      requestCaptureAndUpdate();
    }, Loupe.RECAPTURE_DEBOUNCE_MS);
  }

  // ========== EventHandler: ユーザー入力 + 環境変化 ==========

  function onMouseMove(e) {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    if (rafId === null) {
      rafId = requestAnimationFrame(applyLensPosition);
    }
  }

  function onScroll() {
    scheduleRecapture();
  }

  function onResize() {
    // viewport サイズが変わると background-size の計算が変わるため再キャプチャ + 再描画
    scheduleRecapture();
    applyBackgroundImage();
  }

  /**
   * クリックでルーペ OFF。capture phase で listen して、サイト側 click ハンドラより先に
   * stopPropagation することで「ルーペを閉じるためのクリックがサイト側で副作用を起こす」のを防ぐ。
   * 左クリック (button === 0) のみで OFF（中クリック / 右クリックは無視してサイト側に渡す）。
   */
  function onClickOff(e) {
    if (e.button !== 0) return; // 左クリック以外は無視
    // OFF 実行: cleanup() + storage 書き戻し
    e.preventDefault();
    e.stopPropagation();
    deactivate();
    chrome.storage.local.set({ [StorageKeys.LOUPE_ENABLED]: false }).catch(() => {});
  }

  function onVisibilityChange() {
    // タブが background に隠れた瞬間に cleanup（古い画面が新タブで残らない、過剰なキャプチャ抑制）
    if (document.hidden && isActive) {
      deactivate();
      // storage は触らない（master トグル状態は維持）。
      return;
    }
    // フォアグラウンド復帰時の自動再 activate (/rere レビュー D-1 採用: ユーザー UX 確認済み 2026-05-13)。
    // 音量ブースターと UX を揃え、popup 再操作を不要にする。storage の loupeEnabled が true のままなら
    // 自動でレンズを復帰させる。captureVisibleTab の 2fps quota は通常のタブ切替間隔 (500ms+) で当たらない。
    if (!document.hidden && !isActive) {
      readSettingsAndApply();
    }
  }

  function onDomMutation() {
    scheduleRecapture();
  }

  function attachEventListeners() {
    document.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("click", onClickOff, { capture: true });
    document.addEventListener("visibilitychange", onVisibilityChange);

    // body 直下の childList 変化のみ監視（subtree:true は SPA で過剰発火するため避ける）。
    // SPA top-level navigation / モーダル追加等の「大きな構造変化」を捉えるのに十分。
    if (document.body) {
      domObserver = new MutationObserver(onDomMutation);
      domObserver.observe(document.body, { childList: true, subtree: false });
    }
  }

  function detachEventListeners() {
    document.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("resize", onResize);
    document.removeEventListener("click", onClickOff, { capture: true });
    document.removeEventListener("visibilitychange", onVisibilityChange);

    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
  }

  // ========== ライフサイクル: activate / deactivate ==========

  /**
   * ルーペを有効化する。
   *
   * 1. DOM 構築 + リスナー登録（初回 capture 前にレンズを出して「読み込み中」表示）
   * 2. background に capture 要求 → DataURL → Blob URL → applyBackgroundImage
   *
   * @param {number} zoom 倍率（validateZoom で正規化済の値を想定）
   * @param {number} size レンズ直径 px（clampSize で正規化済の値を想定）
   */
  async function activate(zoom, size) {
    const newZoom = Loupe.validateZoom(zoom);
    const newSize = Loupe.clampSize(size);

    if (isActive) {
      // zoom/size のみ変更されたケース: 既存レンズを更新するだけ。
      // - サイズ変更時はレンズの DOM 寸法を更新 → 同時に background-size の基準矩形も変わるため
      //   `applyBackgroundImage()` を再実行して `background-size` を再計算する。
      // - 倍率変更時はバッジ文字と background-size の両方が変わる。
      const sizeChanged = newSize !== currentSize;
      const zoomChanged = newZoom !== currentZoom;
      currentZoom = newZoom;
      currentSize = newSize;
      if (sizeChanged) {
        applyLensSize();
        applyBackgroundImage();
      }
      if (zoomChanged) {
        applyBadgeText();
        if (!sizeChanged) applyBackgroundImage();
      }
      return;
    }

    isActive = true;
    currentZoom = newZoom;
    currentSize = newSize;

    buildLensDOM();
    attachEventListeners();
    await requestCaptureAndUpdate();
  }

  function deactivate() {
    if (!isActive) return;
    isActive = false;

    // captureSeq を進めて in-flight な requestCaptureAndUpdate の結果を無効化する。
    // captureInFlight / pendingRecapture フラグは触らない（async 関数の finally に後始末を委譲）。
    // finally 側では mySeq !== captureSeq で stale を弾くため安全。
    captureSeq++;

    // タイマーは即座にキャンセル（debounce 中の再キャプチャを止める）
    clearTimeout(recaptureTimer);
    recaptureTimer = null;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    // pendingRecapture も明示的にリセット（次回 activate 時に古いフラグが残らないように）
    pendingRecapture = false;

    detachEventListeners();
    destroyLensDOM();
    revokeCurrentBlobURL();
  }

  // ========== 設定読込・購読 ==========

  /**
   * storage から最新値を読んで isActive と同期。
   *
   * 並列実行ガード (/rere レビュー B1-E3):
   *   storage.onChanged / runtime.onMessage / visibilitychange 復帰 / 初期評価が
   *   重なると activate と deactivate が race し、DOM 状態とリスナー状態が不整合になる経路がある。
   *   applyInFlight フラグで in-flight 中の追加呼び出しは applyQueued で 1 回だけ後追い実行する
   *   (Promise.all で複数 await が並列に走るのを直列化)。
   */
  async function readSettingsAndApply() {
    if (applyInFlight) {
      applyQueued = true;
      return;
    }
    applyInFlight = true;
    try {
      const s = await chrome.storage.local.get([
        StorageKeys.LOUPE_ENABLED,
        StorageKeys.LOUPE_ZOOM,
        StorageKeys.LOUPE_SIZE,
      ]);
      const enabled = s[StorageKeys.LOUPE_ENABLED] === true;
      if (enabled) {
        await activate(s[StorageKeys.LOUPE_ZOOM], s[StorageKeys.LOUPE_SIZE]);
      } else {
        deactivate();
      }
    } catch {
      // storage 障害時は silent fail（次回 onChanged で再試行される）
    } finally {
      applyInFlight = false;
      if (applyQueued) {
        applyQueued = false;
        // setTimeout 0 で stack を解いてから再実行 (再帰 await の深さ爆発防止)
        setTimeout(() => readSettingsAndApply(), 0);
      }
    }
  }

  // background からの即時通知（APPLY_LOUPE_CS）
  chrome.runtime.onMessage.addListener((req, sender) => {
    if (!SenderCheck.isFromBackground(sender)) return;
    if (req?.action !== Actions.APPLY_LOUPE_CS) return;
    // enabled フラグのみ message で受け取り、zoom/size は storage から直接読む
    // （popup → storage 直書きで normalizeSettings を経由しないため）
    readSettingsAndApply();
  });

  // 非 active タブ / popup 直書き経路の同期は storage.onChanged で
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      StorageKeys.LOUPE_ENABLED in changes ||
      StorageKeys.LOUPE_ZOOM in changes ||
      StorageKeys.LOUPE_SIZE in changes
    ) {
      readSettingsAndApply();
    }
  });

  // ページ破棄時の後始末（bfcache 凍結 persisted=true は温存）。タブ閉じは通常
  // visibilitychange(hidden) で deactivate されるが、それを経由しない直接破棄の保険として
  // pagehide でも deactivate（Blob URL revoke + listener detach + observer disconnect）する。
  // /rere C2-2 PATTERN SYNC（video-fill.js と同型）。deactivate は冪等（!isActive で no-op）。
  window.addEventListener("pagehide", (e) => {
    if (e.persisted) return;
    deactivate();
  });

  // 初期評価（content script ロード時に storage 状態に従って activate or 待機）
  readSettingsAndApply();
})();
