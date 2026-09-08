(() => {
  "use strict";
  const backup = globalThis.SettingsBackup;
  const exportButton = document.getElementById("settingsExport");
  const importButton = document.getElementById("settingsImport");
  const input = document.getElementById("settingsImportFile");
  const status = document.getElementById("settingsBackupStatus");
  const say = (key) => { status.textContent = chrome.i18n.getMessage(key); };
  const busy = (value) => {
    exportButton.disabled = value;
    importButton.disabled = value;
  };
  if (sessionStorage.getItem("settingsImportSuccess")) {
    say("settingsImportSuccess");
  }
  exportButton.addEventListener("click", async () => {
    busy(true);
    let url;
    try {
      const stored = await chrome.storage.local.get(backup.keys);
      const text = backup.stringify(stored, chrome.runtime.getManifest().version);
      url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `vuora-settings-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      say("settingsExportSuccess");
    } catch { say("settingsExportError"); }
    finally {
      // ダウンロードが Blob を取得するまで URL を維持する。
      if (url) setTimeout(() => URL.revokeObjectURL(url), 10000);
      busy(false);
    }
  });
  importButton.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    busy(true);
    try {
      if (file.size > backup.MAX_BYTES) throw new Error("file-too-large");
      const text = await file.text();
      backup.parse(text);
      globalThis.settingsImportInProgress = true;
      const result = await chrome.runtime.sendMessage({ action: Actions.IMPORT_SETTINGS, data: text });
      if (!result?.ok) throw new Error("import-failed");
      sessionStorage.setItem("settingsImportSuccess", "1");
      location.reload();
    } catch { say("settingsImportError"); }
    finally {
      globalThis.settingsImportInProgress = false;
      busy(false);
      input.value = "";
    }
  });
})();
