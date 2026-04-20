"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const $enabledToggle = document.getElementById("enabledToggle");
  const $keepAliveToggle = document.getElementById("keepAliveToggle");
  const $intervalRow = document.getElementById("intervalRow");
  const $intervalSlider = document.getElementById("intervalSlider");
  const $intervalValue = document.getElementById("intervalValue");
  const $allowDomainsInput = document.getElementById("allowDomainsInput");
  const $allowlistStatus = document.getElementById("allowlistStatus");
  const $status = document.getElementById("statusMsg");

  // ステータス表示のタイムアウト管理（関数プロパティではなくクロージャで保持）
  let statusTimer = null;
  // 連打時の送信レースを避けるため直近の送信を追跡する
  let applySeq = 0;

  // スライダーの単位は分、storage は ms で保持する
  const MIN_MIN = Math.round(KeepAlive.MIN_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  const MAX_MIN = Math.round(KeepAlive.MAX_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  const DEFAULT_MIN = Math.round(KeepAlive.DEFAULT_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  $intervalSlider.min = String(MIN_MIN);
  $intervalSlider.max = String(MAX_MIN);

  // ---------- 現在状態を復元 ----------
  // 未設定時のデフォルト: ENABLED=true, KEEP_ALIVE_ENABLED=false, KEEP_ALIVE_INTERVAL_MS=DEFAULT
  const stored = await chrome.storage.local.get([
    StorageKeys.ENABLED,
    StorageKeys.KEEP_ALIVE_ENABLED,
    StorageKeys.KEEP_ALIVE_INTERVAL_MS,
    StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS,
  ]);
  $enabledToggle.checked = stored[StorageKeys.ENABLED] !== false;
  $keepAliveToggle.checked = stored[StorageKeys.KEEP_ALIVE_ENABLED] === true;

  const storedIntervalMs = Number.isFinite(stored[StorageKeys.KEEP_ALIVE_INTERVAL_MS])
    ? stored[StorageKeys.KEEP_ALIVE_INTERVAL_MS]
    : KeepAlive.DEFAULT_INTERVAL_MS;
  const storedMin = clampMinutes(Math.round(storedIntervalMs / KeepAlive.MS_PER_MIN));
  $intervalSlider.value = String(storedMin);
  updateIntervalLabel(storedMin);
  updateIntervalRowVisibility();

  // textarea には保存値をそのまま改行区切りで表示。未保存時の入力途中表記を崩さないため
  // 編集中の normalize は行わず、確定（blur / change）時に整形する。
  const storedDomains = Array.isArray(stored[StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS])
    ? stored[StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS]
    : [];
  $allowDomainsInput.value = storedDomains.join("\n");

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

  // textarea は blur で確定。編集途中に毎行 apply しない（連続 storage 書き込み回避）。
  $allowDomainsInput.addEventListener("blur", () => {
    const { domains, rejectedCount } = parseAllowDomains($allowDomainsInput.value);
    // 正規化後の値で textarea を書き戻す（重複削除・不正行除去の視覚フィードバック）
    $allowDomainsInput.value = domains.join("\n");
    if (rejectedCount > 0) {
      $allowlistStatus.textContent = `⚠️ ${rejectedCount} 行を無効として除外しました`;
      $allowlistStatus.className = "allowlist-status error";
    } else if (domains.length > 0) {
      $allowlistStatus.textContent = `✅ ${domains.length} 件のドメインを保存`;
      $allowlistStatus.className = "allowlist-status ok";
    } else {
      $allowlistStatus.textContent = "";
      $allowlistStatus.className = "allowlist-status";
    }
    apply();
  });

  async function apply() {
    const enabled = $enabledToggle.checked;
    const keepAliveEnabled = $keepAliveToggle.checked;
    const minutes = clampMinutes(Number($intervalSlider.value));
    const keepAliveIntervalMs = minutes * KeepAlive.MS_PER_MIN;
    // apply() 時点での textarea を都度 parse する（blur 未発火で呼ばれるケースに備えて）
    const { domains: contextMenuAllowDomains } = parseAllowDomains($allowDomainsInput.value);

    const seq = ++applySeq;
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.APPLY_SETTINGS,
        data: { enabled, keepAliveEnabled, keepAliveIntervalMs, contextMenuAllowDomains },
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

  /**
   * textarea の複数行入力を正規化済みドメイン配列に変換する。
   * 1 行 1 ドメイン・空行スキップ・重複排除・不正行カウント。
   * 正規化ロジックは actions.js の ContextMenuAllowlist.normalizeDomain に集約。
   */
  function parseAllowDomains(text) {
    const seen = new Set();
    const domains = [];
    let rejectedCount = 0;
    const lines = String(text ?? "").split(/\r?\n/);
    for (const line of lines) {
      const raw = line.trim();
      if (!raw) continue;
      const d = ContextMenuAllowlist.normalizeDomain(raw);
      if (!d) {
        rejectedCount++;
        continue;
      }
      if (seen.has(d)) continue;
      seen.add(d);
      domains.push(d);
    }
    return { domains, rejectedCount };
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
