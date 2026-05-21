"use strict";

/**
 * 動画黒帯除去（ワイド表示）content script。
 *
 * 全 http(s) ページの全フレームに注入され、`<video>` 要素に CSS `transform` を当てて
 * ウルトラワイド画面のレターボックス黒帯を除去する。
 *
 * **方式: モニターの縦横比だけ設定で受け取り、動画側の縦横比は要素ごとに自動検出**
 *   - 設定 (`videoFillTarget`) = ユーザーが選んだモニターのプリセット id（→ 目標縦横比）。
 *   - 各 `<video>` の intrinsic 縦横比 (videoWidth/videoHeight) を読み、
 *     `VideoFill.computeTransform` で「その動画を目標縦横比いっぱいに収める transform」を
 *     動画ごとに算出して inline style に `!important` で当てる。
 *   - 16:9 でも 21:9 シネマでも 4:3 でも、動画ごとに正しい倍率を出すので破綻しない。
 *   - 焼き込み黒帯（動画フレーム内に最初から入っている上下帯）は videoWidth/videoHeight に
 *     現れないため検出不能（どのツールでも同じ原理的限界）。
 *
 * 設計メモ:
 *   - inline `style.setProperty(..., "important")` はサイト stylesheet の !important にも勝つ
 *     （cascade 上、author origin で inline !important が最優先）。元の inline transform は
 *     WeakMap に退避し、撤去時に復元する。
 *   - `loadedmetadata` で intrinsic サイズ確定を待つ（videoWidth=0 の段階では計算不能）。
 *   - MutationObserver(subtree) で SPA / 遅延追加された video を追従。
 *   - iframe 内 `<video>`（YouTube 埋め込み等）も対象にするため manifest の all_frames は true。
 *   - 拡張リロード後の orphan 化を `chrome.runtime?.id` で検知し、observer 切断 + 復元する。
 *
 * 二重実行防止: `window.__cpaVideoFillRunning` フラグで同一フレーム内の重複起動を弾く。
 */

(() => {
  if (window.__cpaVideoFillRunning === true) return;
  window.__cpaVideoFillRunning = true;

  let enabled = false;
  let mode = VideoFill.DEFAULT_MODE;
  let targetAspect = VideoFill.targetAspect(VideoFill.DEFAULT_TARGET);

  /** transform を当てた video 要素の集合（撤去時に走査するため WeakMap ではなく Set）。 */
  const modified = new Set();
  /** el → 退避した元の inline transform / transform-origin（撤去時に復元）。 */
  const original = new WeakMap();
  let observer = null;
  let orphaned = false;

  function isActive() {
    return enabled === true;
  }

  function applyToVideo(v) {
    const t = VideoFill.computeTransform(targetAspect, v.videoWidth, v.videoHeight, mode);
    if (!t) {
      // 補正不要（縦横比一致 or metadata 未確定）。既に当てていたら戻す。
      revertVideo(v);
      return;
    }
    if (!original.has(v)) {
      original.set(v, {
        transform: v.style.getPropertyValue("transform"),
        transformPriority: v.style.getPropertyPriority("transform"),
        origin: v.style.getPropertyValue("transform-origin"),
        originPriority: v.style.getPropertyPriority("transform-origin"),
      });
    }
    v.style.setProperty("transform", t, "important");
    v.style.setProperty("transform-origin", "center center", "important");
    modified.add(v);
  }

  function revertVideo(v) {
    if (!original.has(v)) return;
    const o = original.get(v);
    if (o.transform) v.style.setProperty("transform", o.transform, o.transformPriority);
    else v.style.removeProperty("transform");
    if (o.origin) v.style.setProperty("transform-origin", o.origin, o.originPriority);
    else v.style.removeProperty("transform-origin");
    original.delete(v);
    modified.delete(v);
  }

  function revertAll() {
    for (const v of Array.from(modified)) revertVideo(v);
    modified.clear();
  }

  // intrinsic サイズが確定する loadedmetadata で再適用（videoWidth=0 の段階を取りこぼさない）。
  function ensureMetaListener(v) {
    if (v.__cpaVfMetaAttached) return;
    v.__cpaVfMetaAttached = true;
    v.addEventListener("loadedmetadata", () => {
      if (isActive()) applyToVideo(v);
    });
  }

  function scanAndApply() {
    const vids = document.getElementsByTagName("video");
    for (let i = 0; i < vids.length; i++) {
      ensureMetaListener(vids[i]);
      applyToVideo(vids[i]);
    }
  }

  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (!chrome.runtime?.id) {
        teardownOrphan();
        return;
      }
      if (isActive()) scanAndApply();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function disconnectObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // 拡張リロード後の orphan content script: observer を止め、当てた transform を全て戻す。
  function teardownOrphan() {
    if (orphaned) return;
    orphaned = true;
    disconnectObserver();
    revertAll();
  }

  function applyState() {
    if (isActive()) {
      scanAndApply();
      ensureObserver();
    } else {
      disconnectObserver();
      revertAll();
    }
  }

  function readSettingsAndApply() {
    // zombie guard (PATTERN SYNC): orphan 化した content script は chrome.runtime.id が undefined。
    if (!chrome.runtime?.id) {
      teardownOrphan();
      return;
    }
    chrome.storage.local
      .get([
        StorageKeys.VIDEO_FILL_ENABLED,
        StorageKeys.VIDEO_FILL_MODE,
        StorageKeys.VIDEO_FILL_TARGET,
      ])
      .then((s) => {
        enabled = s[StorageKeys.VIDEO_FILL_ENABLED] === true;
        mode = VideoFill.normalizeMode(s[StorageKeys.VIDEO_FILL_MODE]);
        targetAspect = VideoFill.targetAspect(VideoFill.normalizeTarget(s[StorageKeys.VIDEO_FILL_TARGET]));
        applyState();
      })
      .catch(() => {});
  }

  // background → content script の即時通知（active tab の全フレームに broadcast される）。
  chrome.runtime.onMessage.addListener((req, sender) => {
    if (!SenderCheck.isFromBackground(sender)) return;
    if (req?.action !== Actions.APPLY_VIDEO_FILL_CS) return;
    const d = req.data ?? {};
    if (typeof d.enabled === "boolean") enabled = d.enabled;
    if (typeof d.mode === "string") mode = VideoFill.normalizeMode(d.mode);
    if (typeof d.target === "string") targetAspect = VideoFill.targetAspect(VideoFill.normalizeTarget(d.target));
    applyState();
  });

  // 非 active タブも storage.onChanged で同期する。3 キーのいずれか変化したときだけ再取得。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const changed =
      changes[StorageKeys.VIDEO_FILL_ENABLED] !== undefined ||
      changes[StorageKeys.VIDEO_FILL_MODE] !== undefined ||
      changes[StorageKeys.VIDEO_FILL_TARGET] !== undefined;
    if (!changed) return;
    readSettingsAndApply();
  });

  readSettingsAndApply();
})();
