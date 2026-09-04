(() => {
  "use strict";
  const K = StorageKeys;
  const toggle = document.getElementById("settingsSyncToggle");
  const message = document.getElementById("settingsSyncStatus");
  const retry = document.getElementById("settingsSyncRetry");
  const labels = {
    off: "settingsSyncOff", working: "settingsSyncWorking",
    ready: "settingsSyncReady", error: "settingsSyncError",
  };
  let enabled = false;
  let state = "off";
  function render() {
    toggle.checked = enabled;
    message.textContent = chrome.i18n.getMessage(labels[enabled ? (state === "off" ? "working" : state) : "off"] || labels.working);
    retry.hidden = !enabled;
  }
  async function restore() {
    const stored = await chrome.storage.local.get([K.SETTINGS_SYNC_ENABLED, K.SETTINGS_SYNC_STATUS]);
    enabled = stored[K.SETTINGS_SYNC_ENABLED] === true;
    state = stored[K.SETTINGS_SYNC_STATUS] || "working";
    render();
  }
  function failed() {
    message.textContent = chrome.i18n.getMessage("settingsSyncError");
  }
  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      await chrome.storage.local.set({ [K.SETTINGS_SYNC_ENABLED]: toggle.checked });
      await restore();
    } catch {
      toggle.checked = enabled;
      failed();
    } finally {
      toggle.disabled = false;
    }
  });
  retry.addEventListener("click", () => {
    chrome.storage.local.set({ [K.SETTINGS_SYNC_RETRY]: Date.now() }).catch(failed);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (K.SETTINGS_SYNC_APPLIED in changes) {
      // 全機能の UI と内部状態を一緒に復元する。保存要求の失効判定は background が担う。
      location.reload();
      return;
    }
    if (K.SETTINGS_SYNC_ENABLED in changes || K.SETTINGS_SYNC_STATUS in changes) {
      restore().catch(failed);
    }
  });
  restore().catch(failed);
})();
