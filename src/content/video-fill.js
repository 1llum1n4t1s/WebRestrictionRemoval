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

  /** el → 退避した元の inline transform / transform-origin（撤去時に復元）。
   *  /rere C2-Critical1 + CodeRabbit/Codex 4 巡目修正: 旧実装は別途 `modified` を Set で持って
   *  revertAll で iterate していたが、(1) detach された video の strong ref が残って GC を妨げる
   *  リーク、(2) WeakSet 化すると iterate 不可になり detach 済み video を revert できない退行、の
   *  二律背反があった。解決策として「detach を MutationObserver の removedNodes で検知して即
   *  revertVideo する」方式に変更し、tracker は original (WeakMap) 1 本に集約。detach 検知時に
   *  original から外れるので strong ref を持たず、revertAll() は DOM 上の video だけ走査すれば十分。 */
  const original = new WeakMap();
  let observer = null;
  let orphaned = false;
  /** /rere C2-Critical1 修正: loadedmetadata listener の一括 abort 用 AbortController。
   *  revertAll() 時に abort して全 listener を解除、新たな AbortController に差し替えて再受付。
   *  __cpaVfMetaAttached マーカーは abort 後に再 attach 可能化のため要削除。 */
  let metaListenerCtrl = new AbortController();

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
  }

  function revertVideo(v) {
    if (!original.has(v)) return;
    const o = original.get(v);
    if (o.transform) v.style.setProperty("transform", o.transform, o.transformPriority);
    else v.style.removeProperty("transform");
    if (o.origin) v.style.setProperty("transform-origin", o.origin, o.originPriority);
    else v.style.removeProperty("transform-origin");
    original.delete(v);
  }

  function revertAll() {
    // DOM 上の video を走査して revert する。detach 済み video は observer の removedNodes 検知時に
    // 既に revertVideo 済みなので、ここで取りこぼしても OFF 後に transform が残ることはない。
    const vids = document.getElementsByTagName("video");
    for (let i = 0; i < vids.length; i++) revertVideo(vids[i]);
    // loadedmetadata listener を一括 abort + マーカークリアで再 attach 可能化
    metaListenerCtrl.abort();
    metaListenerCtrl = new AbortController();
    for (let i = 0; i < vids.length; i++) delete vids[i].__cpaVfMetaAttached;
  }

  // intrinsic サイズが確定する loadedmetadata で再適用（videoWidth=0 の段階を取りこぼさない）。
  // /rere C2-Critical1 修正: AbortSignal を渡して revertAll 時の一括解除を可能にする。
  // 旧実装は listener を永久 attach + __cpaVfMetaAttached マーカーで再 attach も防いでいたため、
  // master OFF 後も video element に listener が残り続け、closure 経由で module scope の
  // enabled/mode/targetAspect を chain capture して GC を妨げる潜在的リークがあった。
  function ensureMetaListener(v) {
    if (v.__cpaVfMetaAttached) return;
    v.__cpaVfMetaAttached = true;
    v.addEventListener(
      "loadedmetadata",
      () => {
        if (isActive()) applyToVideo(v);
      },
      { signal: metaListenerCtrl.signal }
    );
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
    observer = new MutationObserver((records) => {
      if (!chrome.runtime?.id) {
        teardownOrphan();
        return;
      }
      if (!isActive()) return;
      // Codex 4 巡目 P2 + リーク対策: DOM から外れた transform 済み video を即 revert する。
      // SPA が video を detach → ユーザーが機能 OFF → 同 video を再挿入、の順だと revertAll() は
      // DOM 上の video しか戻せず、detach 済み video に ON 時代の transform が残る (OFF なのに拡大表示
      // のまま再表示)。検出時点で revertVideo すれば再挿入時も素の状態に戻り、original WeakMap からも
      // 外れて element の GC を妨げない (旧 Set 方式の strong-ref リーク再発も防ぐ)。reparent (同一
      // バッチで再挿入された video) は isConnected===true で除外し、後続の scanAndApply で再適用する。
      for (const rec of records) {
        for (const node of rec.removedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "VIDEO") {
            if (!node.isConnected) revertVideo(node);
          } else if (typeof node.querySelectorAll === "function") {
            const inner = node.querySelectorAll("video");
            for (let i = 0; i < inner.length; i++) {
              if (!inner[i].isConnected) revertVideo(inner[i]);
            }
          }
        }
      }
      scanAndApply();
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
