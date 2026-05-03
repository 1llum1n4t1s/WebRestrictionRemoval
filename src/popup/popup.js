"use strict";

/**
 * Popup ロジック。
 *
 * 責務:
 *   - chrome.storage.local から現在の設定を復元し、UI 要素にバインド
 *   - 各 input の変更を都度 background に APPLY_SETTINGS で送信
 *   - SearchFixer の機能トグル（19 個）と select は actions.js の定数から動的生成
 *   - 音量ブースターはマスタートグルなしの常時表示。100% で AudioContext 解放、
 *     それ以外の値で増幅処理を起動する
 */

document.addEventListener("DOMContentLoaded", async () => {
  // ----- 要素参照 -----
  const $keepAliveToggle = document.getElementById("keepAliveToggle");
  const $searchFixerToggle = document.getElementById("searchFixerToggle");
  const $amazonDeliveryToggle = document.getElementById("amazonDeliveryToggle");
  const $volumeSlider = document.getElementById("volumeSlider");
  const $volumeValue = document.getElementById("volumeValue");
  const $volumeResetBtn = document.getElementById("volumeResetBtn");
  const $volumeHint = document.getElementById("volumeHint");
  const $volumeAntiClipToggle = document.getElementById("volumeAntiClipToggle");
  const $volumeNormalizeToggle = document.getElementById("volumeNormalizeToggle");
  const $intervalRow = document.getElementById("intervalRow");
  const $intervalSlider = document.getElementById("intervalSlider");
  const $intervalValue = document.getElementById("intervalValue");
  const $keepAliveHttpPingToggle = document.getElementById("keepAliveHttpPingToggle");
  const $featureCategories = document.getElementById("featureCategories");
  const $cleanerCount = document.getElementById("cleanerCount");
  const $cleanerAccordion = document.getElementById("cleanerAccordion");
  const $searchFixerPill = document.getElementById("searchFixerPill");
  const $gridItemsSelect = document.getElementById("gridItemsSelect");
  const $instagramCleanerToggle = document.getElementById("instagramCleanerToggle");
  const $igFeatureCategories = document.getElementById("igFeatureCategories");
  const $igCleanerCount = document.getElementById("igCleanerCount");
  const $igCleanerAccordion = document.getElementById("igCleanerAccordion");
  const $instagramCleanerPill = document.getElementById("instagramCleanerPill");
  const $status = document.getElementById("statusMsg");

  // ----- ローカル状態 -----
  let statusTimer = null;
  let applySeq = 0;
  /** @type {Map<string, HTMLInputElement>} */
  const featureInputs = new Map();
  /** @type {Map<string, HTMLInputElement>} Instagram クリーナーの個別機能入力 */
  const igFeatureInputs = new Map();

  // ----- スライダー単位は分、storage は ms -----
  const MIN_MIN = Math.round(KeepAlive.MIN_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  const MAX_MIN = Math.round(KeepAlive.MAX_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  const DEFAULT_MIN = Math.round(KeepAlive.DEFAULT_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  $intervalSlider.min = String(MIN_MIN);
  $intervalSlider.max = String(MAX_MIN);

  buildFeatureCategories();
  buildGridSelect();
  buildInstagramFeatureCategories();

  // ----- 現在状態を復元 -----
  const stored = await chrome.storage.local.get([
    StorageKeys.KEEP_ALIVE_ENABLED,
    StorageKeys.KEEP_ALIVE_INTERVAL_MS,
    StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED,
    StorageKeys.SEARCH_FIXER_ENABLED,
    StorageKeys.SEARCH_FIXER_FEATURES,
    StorageKeys.SEARCH_FIXER_GRID_ITEMS,
    StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED,
    StorageKeys.INSTAGRAM_CLEANER_ENABLED,
    StorageKeys.INSTAGRAM_CLEANER_FEATURES,
    StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
    StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED,
  ]);

  $keepAliveToggle.checked = stored[StorageKeys.KEEP_ALIVE_ENABLED] === true;
  $keepAliveHttpPingToggle.checked = stored[StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED] === true;
  $searchFixerToggle.checked = stored[StorageKeys.SEARCH_FIXER_ENABLED] === true;
  $amazonDeliveryToggle.checked = stored[StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED] === true;
  $instagramCleanerToggle.checked = stored[StorageKeys.INSTAGRAM_CLEANER_ENABLED] === true;
  $volumeAntiClipToggle.checked = stored[StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED] === true;
  $volumeNormalizeToggle.checked = stored[StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED] === true;

  // 音量スライダー初期値設定（ブースト中なら active tab の現在値を反映）
  $volumeSlider.min = String(VolumeBooster.MIN);
  $volumeSlider.max = String(VolumeBooster.MAX);
  $volumeSlider.step = String(VolumeBooster.STEP);
  $volumeSlider.value = String(VolumeBooster.DEFAULT);
  updateVolumeLabel(VolumeBooster.DEFAULT);
  syncCurrentTabVolume().catch(() => {});

  const storedIntervalMs = Number.isFinite(stored[StorageKeys.KEEP_ALIVE_INTERVAL_MS])
    ? stored[StorageKeys.KEEP_ALIVE_INTERVAL_MS]
    : KeepAlive.DEFAULT_INTERVAL_MS;
  const storedMin = clampMinutes(Math.round(storedIntervalMs / KeepAlive.MS_PER_MIN));
  $intervalSlider.value = String(storedMin);
  updateIntervalLabel(storedMin);
  updateIntervalRowVisibility();

  const storedFeatures = SearchFixer.mergeFeatures(stored[StorageKeys.SEARCH_FIXER_FEATURES]);
  for (const [key, input] of featureInputs) {
    input.checked = storedFeatures[key] === true;
  }
  $gridItemsSelect.value = String(SearchFixer.clampGridItems(stored[StorageKeys.SEARCH_FIXER_GRID_ITEMS]));

  const storedIgFeatures = InstagramCleaner.mergeFeatures(stored[StorageKeys.INSTAGRAM_CLEANER_FEATURES]);
  for (const [key, input] of igFeatureInputs) {
    input.checked = storedIgFeatures[key] === true;
  }

  updateCleanerCountBadge();
  updateCleanerDimState();
  updateIgCleanerCountBadge();
  updateIgCleanerDimState();

  // ----- イベントバインド -----
  $keepAliveToggle.addEventListener("change", () => {
    updateIntervalRowVisibility();
    apply();
  });
  $keepAliveHttpPingToggle.addEventListener("change", apply);
  $searchFixerToggle.addEventListener("change", () => {
    updateCleanerDimState();
    if ($searchFixerToggle.checked && !$cleanerAccordion.open) {
      $cleanerAccordion.open = true;
    }
    apply();
  });
  $amazonDeliveryToggle.addEventListener("change", apply);

  $instagramCleanerToggle.addEventListener("change", () => {
    updateIgCleanerDimState();
    if ($instagramCleanerToggle.checked && !$igCleanerAccordion.open) {
      $igCleanerAccordion.open = true;
    }
    apply();
  });

  // 音量スライダー: input でラベル + debounced push、change（マウスアップ）で即送信
  $volumeSlider.addEventListener("input", () => {
    const v = VolumeBooster.clampValue($volumeSlider.value);
    updateVolumeLabel(v);
    scheduleVolumePush(v);
  });
  $volumeSlider.addEventListener("change", () => {
    const v = VolumeBooster.clampValue($volumeSlider.value);
    cancelVolumePush();
    pushVolumeNow(v).catch(() => {});
  });

  $volumeResetBtn.addEventListener("click", async () => {
    cancelVolumePush();
    $volumeSlider.value = String(VolumeBooster.DEFAULT);
    updateVolumeLabel(VolumeBooster.DEFAULT);
    await pushVolumeNow(VolumeBooster.DEFAULT);
  });

  // 自動歪み防止 / 自動音量正規化トグル: storage に保存 + 現在 gain を再送信して即時反映。
  // ブースト中なら offscreen の compressor パラメータが書き換わり、UNITY (100%) なら次回ブースト時に有効。
  // cancelVolumePush() を先頭で呼ぶのは、debounce タイマー (120ms) が古いトグル状態のまま
  // 発火するレースを防ぐため。storage.set は fire-and-forget で OK（pushVolumeNow は DOM
  // のトグル状態を直接読むので storage 書き込み完了を待つ必要がない）。
  $volumeAntiClipToggle.addEventListener("change", () => {
    cancelVolumePush();
    chrome.storage.local.set({
      [StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED]: $volumeAntiClipToggle.checked,
    }).catch(() => {});
    applyCompressorTogglePush();
  });
  $volumeNormalizeToggle.addEventListener("change", () => {
    cancelVolumePush();
    chrome.storage.local.set({
      [StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED]: $volumeNormalizeToggle.checked,
    }).catch(() => {});
    applyCompressorTogglePush();
  });

  /**
   * compressor トグル変更時の共通処理: 現在 gain を再送信 → UNITY のときだけ
   * 「100% より上で有効」のヒントを表示する。
   *
   * UNITY (100%) では `setVolumeBoosterGain` が `releaseVolumeBoosterTab` を呼んで
   * AudioContext を解放するため、compressor 設定は次回ブースト時まで反映されない。
   * トグルを ON にしたのに音が変わらないというユーザーの誤解を防ぐためヒントを出す。
   */
  async function applyCompressorTogglePush() {
    const v = VolumeBooster.clampValue($volumeSlider.value);
    await pushVolumeNow(v).catch(() => {});
    if (v === VolumeBooster.UNITY && ($volumeAntiClipToggle.checked || $volumeNormalizeToggle.checked)) {
      setVolumeHint("ℹ️ 100% より上で有効になります");
    }
  }

  $intervalSlider.addEventListener("input", () => {
    updateIntervalLabel(Number($intervalSlider.value));
  });
  $intervalSlider.addEventListener("change", apply);

  for (const input of featureInputs.values()) {
    input.addEventListener("change", () => {
      updateCleanerCountBadge();
      apply();
    });
  }
  $gridItemsSelect.addEventListener("change", apply);

  for (const input of igFeatureInputs.values()) {
    input.addEventListener("change", () => {
      updateIgCleanerCountBadge();
      apply();
    });
  }

  // ----- DOM 構築 -----

  /**
   * クリーナー詳細アコーディオンの DOM ビルダー（YouTube クリーナー / Instagram クリーナー共通）。
   *
   * 構造: `cat` > `cat-head` (アイコン + ラベル) + `cat-list` (各機能のトグル行)。
   * 各 `feature-row` は 1 行 1 トグル + 説明文の縦積みレイアウト。
   * 各 `<input type="checkbox">` には `id="${idPrefix}${item.key}"` を付与し、
   * `inputMap` (`Map<key, input>`) に登録して呼び出し側で値の収集・復元に使う。
   */
  function _buildAccordionCategories(rootEl, categories, features, inputMap, idPrefix) {
    const frag = document.createDocumentFragment();
    for (const cat of categories) {
      const items = features.filter((f) => f.category === cat.id);
      if (items.length === 0) continue;

      const wrap = document.createElement("div");
      wrap.className = "cat";

      const head = document.createElement("div");
      head.className = "cat-head";
      const headIcon = document.createElement("span");
      headIcon.className = "cat-head-icon";
      headIcon.textContent = cat.icon;
      headIcon.setAttribute("aria-hidden", "true");
      const headLabel = document.createElement("span");
      headLabel.textContent = cat.label;
      head.append(headIcon, headLabel);

      const list = document.createElement("div");
      list.className = "cat-list";

      for (const item of items) {
        const row = document.createElement("label");
        row.className = "feature-row";

        const text = document.createElement("span");
        text.className = "fr-text";

        const name = document.createElement("span");
        name.className = "fr-name";
        name.textContent = item.label;
        text.appendChild(name);

        if (item.desc) {
          const desc = document.createElement("span");
          desc.className = "fr-desc";
          desc.textContent = item.desc;
          text.appendChild(desc);
        }

        const sw = document.createElement("span");
        sw.className = "switch";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.id = `${idPrefix}${item.key}`;
        input.dataset.featureKey = item.key;
        const track = document.createElement("span");
        track.className = "switch-track";
        track.setAttribute("aria-hidden", "true");
        sw.append(input, track);

        row.append(text, sw);
        list.appendChild(row);
        inputMap.set(item.key, input);
      }

      wrap.append(head, list);
      frag.appendChild(wrap);
    }
    rootEl.appendChild(frag);
  }

  function buildFeatureCategories() {
    _buildAccordionCategories(
      $featureCategories,
      SearchFixer.CATEGORIES,
      SearchFixer.FEATURES,
      featureInputs,
      "feature-"
    );
  }

  function buildGridSelect() {
    for (const opt of SearchFixer.GRID_OPTIONS) {
      const o = document.createElement("option");
      o.value = String(opt.value);
      o.textContent = opt.label;
      $gridItemsSelect.appendChild(o);
    }
  }

  function updateCleanerCountBadge() {
    let on = 0;
    for (const input of featureInputs.values()) {
      if (input.checked) on++;
    }
    const total = featureInputs.size;
    $cleanerCount.textContent = `${on}/${total}`;
    // pill のテキストもここで同期。actions.js の SearchFixer.FEATURES への増減に
    // 連動して自動更新されるため HTML 側の数値ハードコードによるドリフトを防ぐ。
    if ($searchFixerPill) $searchFixerPill.textContent = `${total} 機能`;
  }

  function updateCleanerDimState() {
    const dim = !$searchFixerToggle.checked;
    $featureCategories.classList.toggle("cleaner-disabled", dim);
  }

  // ----- Instagram クリーナー DOM 構築（YouTube クリーナーと共通の _buildAccordionCategories を再利用） -----
  function buildInstagramFeatureCategories() {
    _buildAccordionCategories(
      $igFeatureCategories,
      InstagramCleaner.CATEGORIES,
      InstagramCleaner.FEATURES,
      igFeatureInputs,
      "ig-feature-"
    );
  }

  function updateIgCleanerCountBadge() {
    let on = 0;
    for (const input of igFeatureInputs.values()) {
      if (input.checked) on++;
    }
    const total = igFeatureInputs.size;
    $igCleanerCount.textContent = `${on}/${total}`;
    // pill のテキストもここで同期（YouTube 側と同じドリフト防止策）。
    if ($instagramCleanerPill) $instagramCleanerPill.textContent = `${total} 機能`;
  }

  function updateIgCleanerDimState() {
    const dim = !$instagramCleanerToggle.checked;
    $igFeatureCategories.classList.toggle("cleaner-disabled", dim);
  }

  // ----- 適用 -----
  async function apply() {
    const keepAliveEnabled = $keepAliveToggle.checked;
    const keepAliveHttpPingEnabled = $keepAliveHttpPingToggle.checked;
    const searchFixerEnabled = $searchFixerToggle.checked;
    const amazonDeliveryTotalEnabled = $amazonDeliveryToggle.checked;
    const instagramCleanerEnabled = $instagramCleanerToggle.checked;
    const minutes = clampMinutes(Number($intervalSlider.value));
    const keepAliveIntervalMs = minutes * KeepAlive.MS_PER_MIN;
    const searchFixerFeatures = collectFeatureValues();
    const searchFixerGridItems = SearchFixer.clampGridItems($gridItemsSelect.value);
    const instagramCleanerFeatures = collectIgFeatureValues();

    const seq = ++applySeq;
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.APPLY_SETTINGS,
        data: {
          keepAliveEnabled,
          keepAliveIntervalMs,
          keepAliveHttpPingEnabled,
          searchFixerEnabled,
          searchFixerFeatures,
          searchFixerGridItems,
          amazonDeliveryTotalEnabled,
          instagramCleanerEnabled,
          instagramCleanerFeatures,
        },
      });
      if (seq !== applySeq) return;
      if (res?.ok) {
        showStatus(
          buildOkMessage(
            keepAliveEnabled,
            searchFixerEnabled,
            amazonDeliveryTotalEnabled,
            instagramCleanerEnabled
          ),
          "ok"
        );
      } else {
        showStatus("⚠️ このページには適用できません", "error");
      }
    } catch {
      if (seq !== applySeq) return;
      showStatus("⚠️ このページには適用できません", "error");
    }
  }

  function collectFeatureValues() {
    const out = {};
    for (const [key, input] of featureInputs) {
      out[key] = input.checked;
    }
    return out;
  }

  function collectIgFeatureValues() {
    const out = {};
    for (const [key, input] of igFeatureInputs) {
      out[key] = input.checked;
    }
    return out;
  }

  function buildOkMessage(
    keepAliveEnabled,
    searchFixerEnabled,
    amazonDeliveryTotalEnabled,
    instagramCleanerEnabled
  ) {
    const parts = [];
    if (keepAliveEnabled) parts.push("セッション維持");
    if (searchFixerEnabled) parts.push("YT クリーナー");
    if (amazonDeliveryTotalEnabled) parts.push("Amazon");
    if (instagramCleanerEnabled) parts.push("Instagram");
    if (parts.length === 0) return "⏹  すべて停止";
    return "✓  " + parts.join("  /  ");
  }

  // ----- ヘルパー -----
  function updateIntervalLabel(min) {
    $intervalValue.textContent = `${min} min`;
  }

  function updateIntervalRowVisibility() {
    $intervalRow.classList.toggle("hidden", !$keepAliveToggle.checked);
  }

  // ----- 音量ブースター ヘルパー -----
  function updateVolumeLabel(v) {
    $volumeValue.textContent = `${v}%`;
  }

  function setVolumeHint(text, isError = false) {
    $volumeHint.textContent = text ?? "";
    $volumeHint.className = isError ? "volume-hint error" : "volume-hint";
  }

  /**
   * input イベントごとに sendMessage する代わりに 120ms debounce してから送る。
   * スライダー連続ドラッグ時の getMediaStreamId 連打を抑制する。
   */
  let volumePushTimer = null;
  function scheduleVolumePush(value) {
    if (volumePushTimer) clearTimeout(volumePushTimer);
    volumePushTimer = setTimeout(() => {
      volumePushTimer = null;
      pushVolumeNow(value).catch(() => {});
    }, 120);
  }

  function cancelVolumePush() {
    if (!volumePushTimer) return;
    clearTimeout(volumePushTimer);
    volumePushTimer = null;
  }

  /**
   * gain と compressor フラグを background に送って反映する。100% 時は background 側で
   * release を呼ぶため、ここではただ送るだけでよい。エラー時は res.error をユーザーに
   * 伝えてデバッグしやすくする。
   *
   * antiClip / normalize は現在のトグル状態を都度読み取るため、トグルだけ変えて gain は
   * 据え置く操作も「現在 gain を再 push」だけで反映できる。
   */
  async function pushVolumeNow(value) {
    const tab = await getActiveHttpTab();
    if (!tab) {
      setVolumeHint("⚠ このページでは使えません", true);
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.VOLUME_BOOSTER_SET_GAIN,
        data: {
          tabId: tab.id,
          gain: value,
          antiClip: $volumeAntiClipToggle.checked,
          normalize: $volumeNormalizeToggle.checked,
        },
      });
      if (res?.ok) {
        setVolumeHint("");
      } else {
        setVolumeHint(formatVolumeError(res?.error), true);
      }
    } catch {
      setVolumeHint("⚠ 通信エラー", true);
    }
  }

  /**
   * background が返すエラーコード文字列を、ユーザー向けの短い日本語ヒントに翻訳する。
   * 不明なエラーは raw text を UI に漏らさず、汎用メッセージにフォールバックして
   * console.warn にだけ原文を出力する（開発時の調査は DevTools 経由で行う）。
   */
  function formatVolumeError(error) {
    if (!error) return "⚠ このページでは使えません";
    const s = String(error);
    if (s.includes("invalid-tab-id")) return "⚠ タブを取得できません";
    if (s.includes("offscreen-unavailable")) return "⚠ 内部処理を起動できません";
    if (s.includes("invalid-stream-id")) return "⚠ 音声を取得できません";
    if (/Tab capture not granted|user gesture/i.test(s)) {
      return "⚠ ポップアップ操作中のみ変更可能です";
    }
    if (/cannot capture|chrome:|edge:/i.test(s)) {
      return "⚠ このページでは使えません";
    }
    if (/permission/i.test(s)) {
      return "⚠ 権限エラー";
    }
    // 不明なエラー: ユーザーには汎用メッセージのみ提示し、原文は DevTools console に。
    // raw error text を UI に出すと内部実装が漏れるため意図的に隠す。
    console.warn("[VolumeBooster] Unknown error:", s);
    return "⚠ 音量設定に失敗しました";
  }

  /**
   * Popup を開いたときに active tab の現在 gain を取得して反映する。
   * offscreen が起動していない / 未ブーストなら DEFAULT (100%) を表示。
   */
  async function syncCurrentTabVolume() {
    const tab = await getActiveHttpTab();
    if (!tab) {
      setVolumeHint("⚠ このページでは使えません", true);
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.VOLUME_BOOSTER_GET_GAIN,
        data: { tabId: tab.id },
      });
      const v = Number.isFinite(res?.gain) ? VolumeBooster.clampValue(res.gain) : VolumeBooster.DEFAULT;
      $volumeSlider.value = String(v);
      updateVolumeLabel(v);
      setVolumeHint("");
    } catch {
      $volumeSlider.value = String(VolumeBooster.DEFAULT);
      updateVolumeLabel(VolumeBooster.DEFAULT);
    }
  }

  /**
   * tabCapture が動作するのは http(s):// タブのみ。
   * activeTab permission 経由で active tab を取得し、URL 判定で弾く。
   */
  async function getActiveHttpTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) return null;
      const url = tab.url ?? "";
      if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
      return tab;
    } catch {
      return null;
    }
  }

  function clampMinutes(min) {
    const n = Number(min);
    if (!Number.isFinite(n)) return DEFAULT_MIN;
    const ms = KeepAlive.clampIntervalMs(n * KeepAlive.MS_PER_MIN);
    return Math.round(ms / KeepAlive.MS_PER_MIN);
  }

  function showStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "footer-status " + type;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      $status.textContent = "";
      $status.className = "footer-status";
      statusTimer = null;
    }, 1500);
  }
});
