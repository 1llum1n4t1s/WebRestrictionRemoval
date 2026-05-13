"use strict";

/**
 * セッション維持用ポーラーのファクトリ。
 *
 * 動作:
 *   - `start()` で `intervalMs` 間隔の `setInterval` 起動、`stop()` で停止
 *   - 毎 tick:
 *     A) `window` / `document` に複数の合成アクティビティを dispatch
 *        （サイト側 JS のアイドル検知をリセット）— 副作用ゼロ。常時実行。
 *     B) 同一オリジン HTTP ping を fire-and-forget — **`httpPingEnabled === true` のときのみ実行**。
 *        - `KeepAlive.PRESET_ENDPOINTS` があれば専用 GET を優先
 *        - それ以外は現在 URL / origin root に軽量 HEAD を試す
 *        （サーバー側のスライディングセッションをリフレッシュ）
 *        - 認証プロキシ環境（Zscaler 等）で 401/302 ループや SIEM ログアラートを誘発しうるため
 *          オプトイン化されている。デフォルトは合成イベントのみ。
 *   - 全ての失敗は catch で握り潰す（サイレントスキップ方針）
 *
 * 制限:
 *   - `chrome.alarms` は使わず `setInterval` で動くため、タブが Memory Saver で freeze されると停止する
 *     （= 見えないタブを無理に延命しない仕様）
 *
 * 依存: `KeepAlive.PRESET_ENDPOINTS`（`src/lib/actions.js`）
 *
 * @param {{ intervalMs: number, httpPingEnabled?: boolean }} options
 */
function createKeepAlive({ intervalMs, httpPingEnabled = false }) {
  // 初期値も setIntervalMs と同じルールでクランプする
  // （呼び出し側で Number.isFinite チェックを重複させないため）。
  let currentIntervalMs = KeepAlive.clampIntervalMs(intervalMs);
  let currentHttpPingEnabled = httpPingEnabled === true;
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
    // セッション維持は popup で許可した top-level origin にだけ効かせる。
    // iframe 由来の第三者 origin へ ping を出すと、ユーザーが意図していない埋め込み先の
    // セッション延命や監査ログ生成につながるため、HTTP ping 候補は top frame のみで作る。
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
    // 合成イベントは top frame のみで dispatch する。iframe 内で全 http(s) フレームに mousemove を
    // 撃ち続けると企業環境 DLP/SIEM が「ユーザー操作なしの mousemove 連発」をボット行動として
    // 検知するルールに引っかかりうる。HTTP ping も shouldFireHttpPing() で top frame のみに
    // 絞っているため、合成イベントも同等の保守的な範囲に揃える。
    if (window !== window.top) return;

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
      // credentials: "same-origin" に限定 (#3): クロスオリジン iframe からの ping で
      // 第三者ドメインに認証情報が送られるのを防ぐ。SharePoint プリセットは同一オリジンなので
      // 影響なし。汎用フォールバック HEAD は Cookie なしで投げる（同一オリジン解決時のみ
      // ブラウザが自動付与する）。
      // タイムアウト追加 (#21): ネットワーク断でリクエストが永遠に解決されず pingInFlight が
      // ロックされるのを防ぐため、5 秒で abort する。
      // redirect: "manual" 採用: SharePoint 等の `/_api/web` GET が認証プロキシで第三者オリジンに
      // 302 された場合、Fetch Standard 上 `credentials: "same-origin"` だけでは Cookie 送信が
      // 仕様上曖昧（実装依存）。redirect を手動扱いにすれば opaqueredirect 応答を `ok: false` として
      // 弾くことでクロスオリジン Cookie 漏洩経路を完全に閉じる。同一オリジン 200 のみ成功扱い。
      const response = await fetch(candidate.url, {
        method: candidate.method,
        credentials: "same-origin",
        cache: "no-store",
        keepalive: true,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
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
    // zombie guard (/rere レビュー B1-D3 / D-4 横展開 PATTERN SYNC):
    // 拡張機能リロード後の orphan content script では `chrome.runtime.id` が undefined。
    // setInterval は extension context が死んでも止まらないため、自前で stop する必要がある。
    // 合成イベント dispatch は chrome API 非依存なので動き続けるが、setInterval を放置すると
    // CPU を浪費し続けるので 1 回検知したら即停止 + timerId クリアで以後の tick を完全停止する。
    if (!chrome.runtime?.id) {
      if (timerId !== null) {
        try { clearInterval(timerId); } catch {}
        timerId = null;
      }
      return;
    }
    // A) 合成アクティビティ束 — 各フレームのサイト側アイドル検知
    //    （SessionTimeoutManager / pointer 系 / focus 系）を幅広くリセットする。副作用ゼロで常時実行。
    dispatchSyntheticActivity();
    // B) HTTP ping — オプトイン時のみ実行。認証プロキシ環境（Zscaler 等）で 401/302 ループや
    //    SIEM ログアラートを誘発しうるため、デフォルト OFF。成功した候補は以後再利用される。
    if (currentHttpPingEnabled) {
      runHttpPing().catch(() => {});
    }
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
    /** HTTP ping の有効/無効を切り替え（合成イベント dispatch は影響なく継続）。 */
    setHttpPingEnabled(enabled) {
      currentHttpPingEnabled = enabled === true;
    },
  };
}

/**
 * 現在フレームから HTTP ping を発射すべきかを判定する。
 * サイト単位オプトインの境界を守るため、top frame のみ発射する。
 */
function shouldFireHttpPing() {
  return window === window.top;
}

// ============================================================
// ランナー: storage / メッセージ購読 + ライフサイクル管理
// ============================================================
//
// content.js 削除に伴い、keepalive 自身が起動責任を持つ。
// 全 http(s) フレームに注入され、`chrome.storage.onChanged` と
// `APPLY_KEEP_ALIVE_CS` メッセージの両経路で active tab / 非 active タブの両方を
// 同期する。`window.__cpaKeepAliveRunning` で同一フレーム二重実行を防ぐ。
(() => {
  if (window.__cpaKeepAliveRunning) return;
  window.__cpaKeepAliveRunning = true;

  let keeper = null;

  function ensureKeeper(intervalMs, httpPingEnabled) {
    if (!keeper) {
      keeper = createKeepAlive({ intervalMs, httpPingEnabled });
    } else {
      keeper.setIntervalMs(intervalMs);
      keeper.setHttpPingEnabled(httpPingEnabled);
    }
    return keeper;
  }

  function applyState(enabled, intervalMs, httpPingEnabled, origins) {
    const ms = KeepAlive.clampIntervalMs(intervalMs);
    const ping = httpPingEnabled === true;
    const siteEnabled = enabled === true && KeepAlive.isOriginAllowed(origins, location.origin);
    if (siteEnabled) {
      ensureKeeper(ms, ping).start();
    } else if (keeper) {
      keeper.stop();
    }
  }

  // 初期復元: storage から状態を読み出して適用
  chrome.storage.local
    .get([
      StorageKeys.KEEP_ALIVE_ENABLED,
      StorageKeys.KEEP_ALIVE_INTERVAL_MS,
      StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED,
      StorageKeys.KEEP_ALIVE_ORIGINS,
    ])
    .then((stored) => {
      const enabled = stored[StorageKeys.KEEP_ALIVE_ENABLED] === true;
      const ms = Number.isFinite(stored[StorageKeys.KEEP_ALIVE_INTERVAL_MS])
        ? stored[StorageKeys.KEEP_ALIVE_INTERVAL_MS]
        : KeepAlive.DEFAULT_INTERVAL_MS;
      const httpPing = stored[StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED] === true;
      const origins = KeepAlive.normalizeOrigins(stored[StorageKeys.KEEP_ALIVE_ORIGINS]);
      applyState(enabled, ms, httpPing, origins);
    })
    .catch(() => {});

  // background → APPLY_KEEP_ALIVE_CS で active tab に即時同期
  chrome.runtime.onMessage.addListener((request, sender) => {
    if (!SenderCheck.isFromBackground(sender)) return;
    if (request?.action !== Actions.APPLY_KEEP_ALIVE_CS) return;
    const enabled = request.data?.keepAliveEnabled === true;
    const ms = Number.isFinite(request.data?.keepAliveIntervalMs)
      ? request.data.keepAliveIntervalMs
      : KeepAlive.DEFAULT_INTERVAL_MS;
    const httpPing = request.data?.keepAliveHttpPingEnabled === true;
    const origins = KeepAlive.normalizeOrigins(request.data?.keepAliveOrigins);
    applyState(enabled, ms, httpPing, origins);
  });

  // 全タブ・全フレーム横断の同期 (onChanged は MV3 で全 frame に発火する)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const enabledChange = changes[StorageKeys.KEEP_ALIVE_ENABLED];
    const intervalChange = changes[StorageKeys.KEEP_ALIVE_INTERVAL_MS];
    const httpPingChange = changes[StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED];
    const originsChange = changes[StorageKeys.KEEP_ALIVE_ORIGINS];
    if (!enabledChange && !intervalChange && !httpPingChange && !originsChange) return;

    // P3-#24: 変化したキーは newValue を即利用し、欠損キーのみ storage.get で補完する選択的補完方式。
    // 旧実装は「3 キーすべて変化」のみ高速パス、それ以外は全 3 キーを get していた。
    // この変更で「2 キー変化 / 1 キー変化」のエッジケースでも RTT を最小化できる
    // （全 http(s) フレーム × 全タブ分の節約効果）。
    const missingKeys = [];
    if (!enabledChange) missingKeys.push(StorageKeys.KEEP_ALIVE_ENABLED);
    if (!intervalChange) missingKeys.push(StorageKeys.KEEP_ALIVE_INTERVAL_MS);
    if (!httpPingChange) missingKeys.push(StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED);
    if (!originsChange) missingKeys.push(StorageKeys.KEEP_ALIVE_ORIGINS);

    const apply = (filled) => {
      const enabled = enabledChange
        ? enabledChange.newValue === true
        : filled[StorageKeys.KEEP_ALIVE_ENABLED] === true;
      const intervalRaw = intervalChange
        ? intervalChange.newValue
        : filled[StorageKeys.KEEP_ALIVE_INTERVAL_MS];
      const ms = Number.isFinite(intervalRaw)
        ? intervalRaw
        : KeepAlive.DEFAULT_INTERVAL_MS;
      const httpPing = httpPingChange
        ? httpPingChange.newValue === true
        : filled[StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED] === true;
      const origins = originsChange
        ? KeepAlive.normalizeOrigins(originsChange.newValue)
        : KeepAlive.normalizeOrigins(filled[StorageKeys.KEEP_ALIVE_ORIGINS]);
      applyState(enabled, ms, httpPing, origins);
    };

    if (missingKeys.length === 0) {
      apply({});
      return;
    }
    chrome.storage.local.get(missingKeys).then(apply).catch(() => {});
  });
})();
