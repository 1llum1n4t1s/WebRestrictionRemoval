"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const $applyBtn = document.getElementById("applyBtn");
  const $allOnBtn = document.getElementById("allOnBtn");
  const $allOffBtn = document.getElementById("allOffBtn");
  const $toggleItems = document.querySelectorAll(".toggle-item");

  /** 各トグルの checkbox を feature キーでマッピング（構築後は変更しない） */
  const checkboxMap = Object.fromEntries(
    Array.from($toggleItems, (item) => {
      const feature = item.dataset.feature;
      const checkbox = item.querySelector('input[type="checkbox"]');
      return feature && checkbox ? [feature, checkbox] : null;
    }).filter(Boolean)
  );

  /** 現在のトグル状態を取得 */
  function getCurrentSettings() {
    return Object.fromEntries(
      Object.entries(checkboxMap).map(([feature, cb]) => [feature, cb.checked])
    );
  }

  /** トグル状態を設定 */
  function setAllToggles(value) {
    for (const checkbox of Object.values(checkboxMap)) {
      checkbox.checked = value;
    }
  }

  // ---------- 設定復元 ----------
  chrome.storage.local.get(StorageKeys.SETTINGS).then((result) => {
    const saved = result[StorageKeys.SETTINGS];
    if (saved) {
      for (const [feature, checkbox] of Object.entries(checkboxMap)) {
        checkbox.checked = !!saved[feature];
      }
    }
  });

  // ---------- 適用ボタン ----------
  $applyBtn.addEventListener("click", () => {
    const settings = getCurrentSettings();

    // background 経由で storage 保存 + content script に適用
    chrome.runtime.sendMessage({ action: Actions.APPLY_SETTINGS, data: settings })
      .then((response) => {
        if (!response?.ok) {
          $applyBtn.textContent = "このページでは使用できません";
          $applyBtn.classList.add("error");
        } else {
          $applyBtn.textContent = "適用しました！";
          $applyBtn.classList.add("applied");
        }
        setTimeout(() => window.close(), 800);
      })
      .catch(() => {
        $applyBtn.textContent = "このページでは使用できません";
        $applyBtn.classList.add("error");
        setTimeout(() => window.close(), 800);
      });
  });

  // ---------- 全ON / 全OFF ----------
  $allOnBtn.addEventListener("click", () => setAllToggles(true));
  $allOffBtn.addEventListener("click", () => setAllToggles(false));
});
