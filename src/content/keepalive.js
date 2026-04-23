"use strict";

/**
 * セッション維持用ポーラーのファクトリ。
 *
 * 動作:
 *   - `start()` で `intervalMs` 間隔の `setInterval` 起動、`stop()` で停止
 *   - 毎 tick:
 *     A) `window` / `document` に複数の合成アクティビティを dispatch
 *        （サイト側 JS のアイドル検知をリセット）
 *     B) 同一オリジン HTTP ping を fire-and-forget
 *        - `KeepAlive.PRESET_ENDPOINTS` があれば専用 GET を優先
 *        - それ以外は現在 URL / origin root に軽量 HEAD を試す
 *        （サーバー側のスライディングセッションをリフレッシュ）
 *   - 全ての失敗は catch で握り潰す（サイレントスキップ方針）
 *
 * 制限:
 *   - `chrome.alarms` は使わず `setInterval` で動くため、タブが Memory Saver で freeze されると停止する
 *     （= 見えないタブを無理に延命しない仕様）
 *
 * 依存: `KeepAlive.PRESET_ENDPOINTS`（`src/lib/actions.js`）
 *
 * @param {{ intervalMs: number }} options
 */
function createKeepAlive({ intervalMs }) {
  // 初期値も setIntervalMs と同じルールでクランプする
  // （呼び出し側で Number.isFinite チェックを重複させないため）。
  let currentIntervalMs = KeepAlive.clampIntervalMs(intervalMs);
  let timerId = null;
  // hostname は location で取得。プリセットマッチは初期化時 1 回だけ行い
  // 以降は tick ごとの再計算を避ける（hostname は frame 内で不変）。
  const matchedPaths = collectMatchedPaths(location.hostname);
  // HTTP ping 候補は初期化時に固定し、成功した候補を以後再利用する。
  // 毎 tick の URL 構築や 405 fallback 判定を避けるため。
  const httpPingCandidates = collectHttpPingCandidates();
  let selectedPingCandidate = httpPingCandidates[0] ?? null;
  let pingInFlight = false;

  function collectMatchedPaths(hostname) {
    const paths = [];
    for (const preset of KeepAlive.PRESET_ENDPOINTS) {
      if (preset.test(hostname)) {
        preset.paths.forEach((p) => paths.push(p));
      }
    }
    return paths;
  }

  function collectHttpPingCandidates() {
    // iframe 多重発射を避けつつ「アプリ本体が iframe 内にある」ケースは許可する。
    if (!shouldFireHttpPing()) return [];

    let currentUrl = null;
    try {
      currentUrl = new URL(location.href);
    } catch {
      return [];
    }
    if (!/^https?:$/i.test(currentUrl.protocol)) return [];

    const candidates = [];
    const seen = new Set();
    const pushCandidate = (candidate) => {
      const key = candidate.method + " " + candidate.url;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    };

    for (const path of matchedPaths) {
      pushCandidate({
        method: "GET",
        url: new URL(path, currentUrl.origin).href,
      });
    }

    // 汎用 fallback:
    //   1. 現在 URL に HEAD（副作用と転送量を抑えつつ認証済みリソースに触れる）
    //   2. origin root に HEAD（深い SPA ルートや 405/404 に備える）
    currentUrl.hash = "";
    currentUrl.search = "";
    pushCandidate({ method: "HEAD", url: currentUrl.href });
    pushCandidate({ method: "HEAD", url: currentUrl.origin + "/" });

    return candidates;
  }

  function dispatchEventToTargets(targets, type, EventCtor, init) {
    for (const target of targets) {
      if (!target) continue;
      try {
        target.dispatchEvent(new EventCtor(type, init));
      } catch {
        // 一部 ctor 非対応環境や dispatch 不可オブジェクトは黙って飛ばす
      }
    }
  }

  function dispatchSyntheticActivity() {
    const bubbleTargets = [document, window];
    dispatchEventToTargets(
      bubbleTargets,
      "mousemove",
      MouseEvent,
      { bubbles: true, cancelable: false, clientX: 0, clientY: 0, screenX: 0, screenY: 0 }
    );

    if (typeof PointerEvent === "function") {
      dispatchEventToTargets(
        bubbleTargets,
        "pointermove",
        PointerEvent,
        {
          bubbles: true,
          cancelable: false,
          clientX: 0,
          clientY: 0,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }
      );
    }

    // `scroll` / `focus` を軽く送って、mousemove 以外を見ている idle detector にも寄せる。
    // クリック / keydown のような副作用を誘発しやすいイベントは送らない。
    dispatchEventToTargets([document, window], "scroll", Event, { bubbles: false, cancelable: false });
    dispatchEventToTargets([window], "focus", Event, { bubbles: false, cancelable: false });
  }

  async function tryHttpPing(candidate) {
    try {
      const response = await fetch(candidate.url, {
        method: candidate.method,
        credentials: "include",
        cache: "no-store",
        keepalive: true,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function runHttpPing() {
    if (httpPingCandidates.length === 0 || pingInFlight) return;
    pingInFlight = true;
    try {
      if (selectedPingCandidate && await tryHttpPing(selectedPingCandidate)) {
        return;
      }
      for (const candidate of httpPingCandidates) {
        if (
          selectedPingCandidate &&
          candidate.method === selectedPingCandidate.method &&
          candidate.url === selectedPingCandidate.url
        ) {
          continue;
        }
        if (await tryHttpPing(candidate)) {
          selectedPingCandidate = candidate;
          return;
        }
      }
    } finally {
      pingInFlight = false;
    }
  }

  function tick() {
    // A) 合成アクティビティ束 — 各フレームのサイト側アイドル検知
    //    （SessionTimeoutManager / pointer 系 / focus 系）を幅広くリセットする。
    dispatchSyntheticActivity();
    // B) HTTP ping — 重いページ GET を毎回投げないよう、成功した候補を以後再利用する。
    runHttpPing().catch(() => {});
  }

  return {
    start() {
      if (timerId !== null) return;
      // 初回ハートビートを即時実行してから interval を開始する。
      // setInterval の最初の発火は currentIntervalMs 後のため、有効化時点で既にアイドルが進んでいると
      // 1 周期分の猶予でセッションが切れうる（例: 5分 timeout / 4分間隔で、2分アイドル後に有効化すると
      // 初回ハートビートは分6 = タイムアウト後）。
      tick();
      timerId = setInterval(tick, currentIntervalMs);
    },
    stop() {
      if (timerId === null) return;
      clearInterval(timerId);
      timerId = null;
    },
    /** 稼働中なら新しい間隔で再起動、停止中なら次回 start に反映 */
    setIntervalMs(ms) {
      const clamped = KeepAlive.clampIntervalMs(ms);
      if (clamped === currentIntervalMs) return;
      currentIntervalMs = clamped;
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = setInterval(tick, currentIntervalMs);
      }
    },
  };
}

/**
 * 現在フレームから HTTP ping を発射すべきかを判定する。
 *
 * 狙い:
 *   - 同一オリジンの多重発射を回避（例: SharePoint トップ + その内部 iframe で10倍に膨らむ問題）
 *   - かつ「アプリ本体が iframe 内で動く」ケースでも ping を止めない
 *     （例: 社内ポータル <iframe src="*.box.com"> のように top と frame のオリジンが違う）
 *
 * ルール:
 *   - トップフレームなら常に発射（同一/異オリジン iframe の重複判定はそちらに任せる）
 *   - iframe では、トップフレームの hostname が取れて自フレームと一致するなら発射しない
 *     （同一オリジン iframe: トップが発射するので重複回避）
 *   - hostname 取得が SecurityError で失敗（= トップがクロスオリジン）なら発射する
 *     （トップからは自フレームのオリジンへ ping を撃てないため、代わりに自分が撃つ）
 */
function shouldFireHttpPing() {
  if (window === window.top) return true;
  try {
    return window.top.location.hostname !== location.hostname;
  } catch {
    // クロスオリジン: トップからは presets が自フレームに適用できないので、ここで発射する
    return true;
  }
}
