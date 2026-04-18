"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const $toggle = document.getElementById("enabledToggle");
  const $status = document.getElementById("statusMsg");

  // ステータス表示のタイムアウト管理（関数プロパティではなくクロージャで保持）
  let statusTimer = null;

  // ---------- 現在状態を復元 ----------
  // 未設定時はデフォルト ON とみなす
  const stored = await chrome.storage.local.get(StorageKeys.ENABLED);
  $toggle.checked = stored[StorageKeys.ENABLED] !== false;

  // ---------- トグル変更で即適用 ----------
  $toggle.addEventListener("change", async () => {
    const enabled = $toggle.checked;
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.APPLY_SETTINGS,
        data: { enabled },
      });
      if (res?.ok) {
        showStatus(enabled ? "✅ 有効化しました" : "⏹️ 無効化しました", "ok");
      } else {
        showStatus("⚠️ このページでは適用できません", "error");
      }
    } catch {
      showStatus("⚠️ このページでは適用できません", "error");
    }
  });

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
