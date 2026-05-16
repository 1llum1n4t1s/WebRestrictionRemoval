// RTX 動画強化 (NVIDIA RTX Super Resolution / AMD FidelityFX 等のドライバ側映像補正を
// 動画ページで認識されやすくする hint inject)
//
// 仕組み:
//   ページに `<video>` 要素が存在し、かつ master トグルが ON のとき、視覚的に影響のない
//   極小 hint 要素 (1×1 px、opacity 0、pointer-events: none) を `<video>` の直近祖先に
//   差し込む。GPU 側ドライバ (NVIDIA RTX Super Resolution / AMD FidelityFX Super Resolution
//   for Browser など) は「動画ページ」を判定して自動補正を入れるため、hint 要素があることで
//   driver の動画ページ検知が安定するケースを補助する。
//
// 設計上の不変条件:
//   - master OFF / 拡張機能 disable / SPA 離脱時は hint 要素を必ず撤去 (clean-up)
//   - `<video>` ごとに 1 度だけ inject、重複 inject しない (data-* マーカーで管理)
//   - 視認できない要素 (1px / opacity:0 / aria-hidden) なのでアクセシビリティ影響ゼロ
//   - MutationObserver で <video> の DOM 追加・削除を検知し、追従
//   - context invalidation 後は MutationObserver を必ず disconnect (CPU リーク防止)
//   - 既存の context invalidation guard パターンに準拠 (chrome.runtime?.id チェック)
//   - top frame のみで動作 (iframe 内 <video> はサイト側で処理されるためスキップ)

(() => {
  // 同一フレームでの二重実行防止 (manifest content_scripts が二重ロードされた場合の保険)
  if (window.__cpaRtxEnhancerRunning) return;
  window.__cpaRtxEnhancerRunning = true;

  // top frame 限定: iframe 内動画はサイト側で処理 (Netflix の player iframe 等)、
  // top + iframe 両方に inject すると重複でドライバ判定がブレる可能性
  if (window !== window.top) return;

  // 拡張機能が orphan 状態 (拡張機能リロード後の content script) なら一切処理せず即終了
  if (!chrome?.runtime?.id) return;

  // hint 要素のクラス名と video 側のマーカー属性 (cleanup と重複検知に使う)
  const HINT_CLASS = "__cpa-rtx-hint";
  const VIDEO_MARKER = "__cpaRtxAttached"; // data-* dataset key (camelCase で data-* attribute に対応)

  let mutationObserver = null;
  // /rere B2-014: rAF coalesce 用、複数 mutation を 1 フレームに圧縮
  let scanRaf = 0;
  let active = false;
  // master 設定読み込み中 / 適用中の並列化を直列化するフラグ (storage onChanged と APPLY 同時呼出対応)
  let applyInFlight = false;
  let applyQueued = false;

  /**
   * 指定 <video> に hint 要素を 1 度だけ inject。
   * - 親要素 (parentElement) に対して append、video の position 制約に依存しない
   * - 視覚的影響ゼロ (opacity:0, 1×1 px, pointer-events:none)
   * - aria-hidden で支援技術にも見せない
   */
  function attachHint(video) {
    if (!chrome?.runtime?.id) return;
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.dataset[VIDEO_MARKER] === "1") return; // 既 inject 済み
    const parent = video.parentElement;
    if (!parent) return;

    const hint = document.createElement("div");
    hint.className = HINT_CLASS;
    hint.setAttribute("aria-hidden", "true");
    hint.setAttribute("data-cpa-rtx-hint", "1");
    // inline style で site 側 CSS と独立。layout / paint への影響を最小化する 1×1 透明 div。
    hint.style.cssText =
      "position:absolute;width:1px;height:1px;top:0;left:0;" +
      "opacity:0;pointer-events:none;background:transparent;z-index:0;contain:strict;";

    try {
      parent.appendChild(hint);
      // weak ref がわりに dataset と関連付け。後で cleanup するときに参照解除
      video.dataset[VIDEO_MARKER] = "1";
    } catch {
      // append 失敗 (parent が detached 等) は無視。次の MutationObserver スキャンで再試行されうる
    }
  }

  /**
   * ページ内の全 <video> をスキャンして未注入のものに hint を attach。
   * SPA navigation 直後や observer 起動時に呼ぶ。
   */
  function scanAll() {
    if (!chrome?.runtime?.id) return;
    const videos = document.querySelectorAll("video");
    for (const v of videos) attachHint(v);
  }

  /**
   * 全 hint 要素を撤去し、video 側のマーカーも消す。
   * master OFF / cleanup 経路で呼ぶ。
   */
  function removeAllHints() {
    const hints = document.querySelectorAll("." + HINT_CLASS);
    hints.forEach((h) => {
      try { h.remove(); } catch {}
    });
    const taggedVideos = document.querySelectorAll("video[data-" + camelToKebab(VIDEO_MARKER) + "]");
    taggedVideos.forEach((v) => {
      try { delete v.dataset[VIDEO_MARKER]; } catch {}
    });
  }

  function camelToKebab(s) {
    return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  }

  /**
   * 機能を有効化: scan + MutationObserver 起動。
   * 既に active なら no-op。
   */
  function activate() {
    if (active) return;
    if (!chrome?.runtime?.id) return;
    active = true;
    scanAll();
    // subtree:true で SPA の遅延 inject される <video> も検知。
    // 大規模 mutation (Netflix の player 切り替え等) で頻発するが、
    // 内側で chrome.runtime?.id ガード + 既 inject 判定があるので副作用は軽量。
    //
    // /rere B2-014 修正: SPA で頻発する mutation（Netflix / YouTube / Twitch で秒間数十〜数百件）
    // で callback 自体が高頻度起動して `scanAll` が毎回 `querySelectorAll('video')` を実行する
    // CPU 浪費を防ぐため、rAF coalesce で 1 フレームに 1 回 (60fps 上限) に圧縮する。
    // `attachHint` の `dataset[VIDEO_MARKER]` ガードは健在で多重 inject はない、ここでは
    // `querySelectorAll` 自体の頻度を抑える。
    mutationObserver = new MutationObserver(() => {
      if (!chrome?.runtime?.id) {
        deactivate();
        return;
      }
      if (scanRaf) return;
      scanRaf = requestAnimationFrame(() => {
        scanRaf = 0;
        scanAll();
      });
    });
    try {
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      // documentElement が無い極めて稀なケース。ignore (次回 readSettingsAndApply で再試行)
    }
  }

  /**
   * 機能を無効化: observer 切断 + hint 全削除。
   */
  function deactivate() {
    if (!active) {
      // observer がなくても、念のため hint が残っていれば撤去 (orphan 後の cleanup 等)
      removeAllHints();
      return;
    }
    active = false;
    if (mutationObserver) {
      try { mutationObserver.disconnect(); } catch {}
      mutationObserver = null;
    }
    // /rere B2-014: rAF cancel - deactivate 後に stale scanAll が走らないようにする
    if (scanRaf) {
      cancelAnimationFrame(scanRaf);
      scanRaf = 0;
    }
    removeAllHints();
  }

  /**
   * storage から master トグルを読んで activate/deactivate。
   * 並列呼び出しを直列化 (queued フラグで再実行)。
   */
  async function readSettingsAndApply() {
    if (!chrome?.runtime?.id) return;
    if (applyInFlight) {
      applyQueued = true;
      return;
    }
    applyInFlight = true;
    try {
      const stored = await chrome.storage.local.get(StorageKeys.RTX_ENHANCER_ENABLED);
      if (!chrome?.runtime?.id) return; // await 後 orphan 化チェック
      const enabled = stored[StorageKeys.RTX_ENHANCER_ENABLED] === true;
      if (enabled) activate();
      else deactivate();
    } catch {
      // storage read エラーは UI 影響なし、次回 storage.onChanged / APPLY で再試行
    } finally {
      applyInFlight = false;
      if (applyQueued) {
        applyQueued = false;
        readSettingsAndApply();
      }
    }
  }

  // 初回適用 (content script 起動直後)
  readSettingsAndApply();

  // storage 変更で同期 (popup 操作 / 他タブからの変更)
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (!chrome?.runtime?.id) return;
      if (areaName !== "local") return;
      if (StorageKeys.RTX_ENHANCER_ENABLED in changes) {
        readSettingsAndApply();
      }
    });
  } catch {}

  // popup → background → content script: APPLY_RTX_ENHANCER_CS メッセージで再適用。
  // 他 content script との設計一貫性のため SenderCheck.isFromBackground で gate する
  // （/rere レビュー A1-001）。同一拡張内の sender 偽装は SenderCheck の三層検証で遮断される。
  try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (!chrome?.runtime?.id) return;
      if (!SenderCheck.isFromBackground(sender)) return;
      if (request?.action !== Actions.APPLY_RTX_ENHANCER_CS) return;
      readSettingsAndApply();
      try { sendResponse({ ok: true }); } catch {}
    });
  } catch {}

  // タブが非表示になったときに cleanup する必要はない (hint は静的なので CPU 消費ゼロ)。
  // ただし pagehide / unload では observer を disconnect しておく (browser cleanup の補助)。
  window.addEventListener(
    "pagehide",
    () => {
      if (mutationObserver) {
        try { mutationObserver.disconnect(); } catch {}
        mutationObserver = null;
      }
    },
    { once: true }
  );
})();
