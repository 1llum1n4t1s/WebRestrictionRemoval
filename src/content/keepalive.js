"use strict";

/**
 * セッション維持用ポーラーのファクトリ。
 *
 * 動作:
 *   - `start()` で `intervalMs` 間隔の `setInterval` 起動、`stop()` で停止
 *   - 毎 tick:
 *     A) document に合成 `mousemove` を dispatch（サイト側 JS のアイドル検知をリセット）
 *     B) `KeepAlive.PRESET_ENDPOINTS` にマッチしたサイトでは同一オリジン GET を fire-and-forget
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
  // HTTP ping を発射するか（iframe 多重発射を避けつつ「アプリが iframe 内にある」ケースもカバー）
  const httpPingAllowed = matchedPaths.length > 0 && shouldFireHttpPing();

  function collectMatchedPaths(hostname) {
    const paths = [];
    for (const preset of KeepAlive.PRESET_ENDPOINTS) {
      if (preset.test(hostname)) {
        preset.paths.forEach((p) => paths.push(p));
      }
    }
    return paths;
  }

  function tick() {
    // A) 合成 mousemove — 各フレームのサイト側アイドル検知（SessionTimeoutManager 等）のリセット用。
    //    iframe でも独立に必要（mousemove は frame 内に閉じるため親から届かない）。
    try {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    } catch {
      // 環境次第で MouseEvent constructor が使えないケースの保険
    }
    // B) HTTP ping — 同一オリジンの重複発射を避けるため httpPingAllowed で絞る。
    //    credentials: "include" はデフォルトで同一オリジンでは有効だが、意図を明示する。
    //    keepalive: true はタブが閉じられても送信継続させるため。
    if (!httpPingAllowed) return;
    for (const path of matchedPaths) {
      try {
        fetch(path, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          keepalive: true,
        }).catch(() => {});
      } catch {
        // Manifest 等で fetch が禁止される異常環境用の保険
      }
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

