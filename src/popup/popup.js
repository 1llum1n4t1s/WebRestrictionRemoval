"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const $enabledToggle = document.getElementById("enabledToggle");
  const $keepAliveToggle = document.getElementById("keepAliveToggle");
  const $intervalRow = document.getElementById("intervalRow");
  const $intervalSlider = document.getElementById("intervalSlider");
  const $intervalValue = document.getElementById("intervalValue");
  const $status = document.getElementById("statusMsg");

  // ステータス表示のタイムアウト管理（関数プロパティではなくクロージャで保持）
  let statusTimer = null;
  // 連打時の送信レースを避けるため直近の送信を追跡する
  let applySeq = 0;

  // スライダーの単位は分、storage は ms で保持する
  const MIN_MIN = Math.round(KeepAlive.MIN_INTERVAL_MS / 60_000);
  const MAX_MIN = Math.round(KeepAlive.MAX_INTERVAL_MS / 60_000);
  const DEFAULT_MIN = Math.round(KeepAlive.DEFAULT_INTERVAL_MS / 60_000);
  $intervalSlider.min = String(MIN_MIN);
  $intervalSlider.max = String(MAX_MIN);

  // ---------- 現在状態を復元 ----------
  // 未設定時のデフォルト: ENABLED=true, KEEP_ALIVE_ENABLED=false, KEEP_ALIVE_INTERVAL_MS=DEFAULT
  const stored = await chrome.storage.local.get([
    StorageKeys.ENABLED,
    StorageKeys.KEEP_ALIVE_ENABLED,
    StorageKeys.KEEP_ALIVE_INTERVAL_MS,
  ]);
  $enabledToggle.checked = stored[StorageKeys.ENABLED] !== false;
  $keepAliveToggle.checked = stored[StorageKeys.KEEP_ALIVE_ENABLED] === true;

  const storedIntervalMs = Number.isFinite(stored[StorageKeys.KEEP_ALIVE_INTERVAL_MS])
    ? stored[StorageKeys.KEEP_ALIVE_INTERVAL_MS]
    : KeepAlive.DEFAULT_INTERVAL_MS;
  const storedMin = clampMinutes(Math.round(storedIntervalMs / 60_000));
  $intervalSlider.value = String(storedMin);
  updateIntervalLabel(storedMin);
  updateIntervalRowVisibility();

  // ---------- トグル / スライダーの変更で適用 ----------
  $enabledToggle.addEventListener("change", apply);
  $keepAliveToggle.addEventListener("change", () => {
    updateIntervalRowVisibility();
    apply();
  });
  // 入力中（ドラッグ）はラベルだけ更新し、確定時に適用する（chrome.storage 書き込みの連打抑制）
  $intervalSlider.addEventListener("input", () => {
    updateIntervalLabel(Number($intervalSlider.value));
  });
  $intervalSlider.addEventListener("change", apply);

  async function apply() {
    const enabled = $enabledToggle.checked;
    const keepAliveEnabled = $keepAliveToggle.checked;
    const minutes = clampMinutes(Number($intervalSlider.value));
    const keepAliveIntervalMs = minutes * 60_000;

    const seq = ++applySeq;
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.APPLY_SETTINGS,
        data: { enabled, keepAliveEnabled, keepAliveIntervalMs },
      });
      // 後発の apply() が完了した後に先発の結果が遅れて届くケースのステータス上書きを防ぐ
      if (seq !== applySeq) return;
      if (res?.ok) {
        showStatus(buildOkMessage(enabled, keepAliveEnabled), "ok");
      } else {
        showStatus("⚠️ このページでは適用できません", "error");
      }
    } catch {
      if (seq !== applySeq) return;
      showStatus("⚠️ このページでは適用できません", "error");
    }
  }

  function buildOkMessage(enabled, keepAliveEnabled) {
    if (!enabled && !keepAliveEnabled) return "⏹️ 無効化しました";
    const parts = [];
    if (enabled) parts.push("制限解除");
    if (keepAliveEnabled) parts.push("セッション維持");
    return "✅ " + parts.join(" / ") + " を有効化";
  }

  function updateIntervalLabel(min) {
    $intervalValue.textContent = min + " 分";
  }

  function updateIntervalRowVisibility() {
    $intervalRow.classList.toggle("hidden", !$keepAliveToggle.checked);
  }

  function clampMinutes(min) {
    if (!Number.isFinite(min)) return DEFAULT_MIN;
    if (min < MIN_MIN) return MIN_MIN;
    if (min > MAX_MIN) return MAX_MIN;
    return min;
  }

  function showStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "status " + type;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      $status.textContent = "";
      $status.className = "status";
      statusTimer = null;
    }, 1500);
  }
});
