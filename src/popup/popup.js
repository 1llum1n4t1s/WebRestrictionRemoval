"use strict";

/**
 * Popup ロジック。
 *
 * 責務:
 *   - chrome.storage.local から現在の設定を復元し、UI 要素にバインド
 *   - 各 input の変更を都度 background に APPLY_SETTINGS で送信
 *   - SearchFixer の機能トグル（19 個）と select は actions.js の定数から動的生成
 *   - 状態メッセージ（適用/失敗）は応答ベースで 1.5 秒表示
 *
 * 設計上の判断:
 *   - apply() 単一関数で全フィールドを集約して送信する。トグルごとの差分送信は採用しない
 *     （storage の単一トランザクション化と background の sender 検証を簡潔に保つため）
 *   - applySeq でレース防止: 後発リクエスト完了後に先発の遅延応答が UI を上書きしないよう
 *   - クリーナー詳細はマスター OFF のときも編集可能（ON にしたとき即反映できるよう）
 */

document.addEventListener("DOMContentLoaded", async () => {
  // ----- 要素参照 -----
  const $enabledToggle = document.getElementById("enabledToggle");
  const $keepAliveToggle = document.getElementById("keepAliveToggle");
  const $ytShortsToggle = document.getElementById("ytShortsToggle");
  const $searchFixerToggle = document.getElementById("searchFixerToggle");
  const $amazonDeliveryToggle = document.getElementById("amazonDeliveryToggle");
  const $volumeBoosterToggle = document.getElementById("volumeBoosterToggle");
  const $volumeRow = document.getElementById("volumeRow");
  const $volumeSlider = document.getElementById("volumeSlider");
  const $volumeValue = document.getElementById("volumeValue");
  const $volumeResetBtn = document.getElementById("volumeResetBtn");
  const $volumeHint = document.getElementById("volumeHint");
  const $intervalRow = document.getElementById("intervalRow");
  const $intervalSlider = document.getElementById("intervalSlider");
  const $intervalValue = document.getElementById("intervalValue");
  const $allowDomainsInput = document.getElementById("allowDomainsInput");
  const $allowlistStatus = document.getElementById("allowlistStatus");
  const $featureCategories = document.getElementById("featureCategories");
  const $cleanerCount = document.getElementById("cleanerCount");
  const $cleanerAccordion = document.getElementById("cleanerAccordion");
  const $gridItemsSelect = document.getElementById("gridItemsSelect");
  const $status = document.getElementById("statusMsg");

  // ----- ローカル状態 -----
  let statusTimer = null;
  let applySeq = 0;
  // 機能チェックボックスは動的生成。key → input の参照を保持して apply() で集計する
  /** @type {Map<string, HTMLInputElement>} */
  const featureInputs = new Map();

  // ----- スライダー単位は分、storage は ms -----
  const MIN_MIN = Math.round(KeepAlive.MIN_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  const MAX_MIN = Math.round(KeepAlive.MAX_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  const DEFAULT_MIN = Math.round(KeepAlive.DEFAULT_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  $intervalSlider.min = String(MIN_MIN);
  $intervalSlider.max = String(MAX_MIN);

  // ----- 機能トグル DOM をカテゴリごとに生成 -----
  buildFeatureCategories();
  buildGridSelect();

  // ----- 現在状態を復元 -----
  const stored = await chrome.storage.local.get([
    StorageKeys.ENABLED,
    StorageKeys.KEEP_ALIVE_ENABLED,
    StorageKeys.KEEP_ALIVE_INTERVAL_MS,
    StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS,
    StorageKeys.YT_SHORTS_REMOVAL_ENABLED,
    StorageKeys.SEARCH_FIXER_ENABLED,
    StorageKeys.SEARCH_FIXER_FEATURES,
    StorageKeys.SEARCH_FIXER_GRID_ITEMS,
    StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED,
    StorageKeys.VOLUME_BOOSTER_ENABLED,
  ]);

  // 全 4 トグルは未設定時 false 扱い
  $enabledToggle.checked = stored[StorageKeys.ENABLED] === true;
  $keepAliveToggle.checked = stored[StorageKeys.KEEP_ALIVE_ENABLED] === true;
  $ytShortsToggle.checked = stored[StorageKeys.YT_SHORTS_REMOVAL_ENABLED] === true;
  $searchFixerToggle.checked = stored[StorageKeys.SEARCH_FIXER_ENABLED] === true;
  $amazonDeliveryToggle.checked = stored[StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED] === true;
  $volumeBoosterToggle.checked = stored[StorageKeys.VOLUME_BOOSTER_ENABLED] === true;

  // 音量スライダーの初期値設定（master ON のときに active tab の現在値を取得して反映）
  $volumeSlider.min = String(VolumeBooster.MIN);
  $volumeSlider.max = String(VolumeBooster.MAX);
  $volumeSlider.step = String(VolumeBooster.STEP);
  $volumeSlider.value = String(VolumeBooster.DEFAULT);
  updateVolumeLabel(VolumeBooster.DEFAULT);
  updateVolumeRowVisibility();
  if ($volumeBoosterToggle.checked) {
    syncCurrentTabVolume().catch(() => {});
  }

  const storedIntervalMs = Number.isFinite(stored[StorageKeys.KEEP_ALIVE_INTERVAL_MS])
    ? stored[StorageKeys.KEEP_ALIVE_INTERVAL_MS]
    : KeepAlive.DEFAULT_INTERVAL_MS;
  const storedMin = clampMinutes(Math.round(storedIntervalMs / KeepAlive.MS_PER_MIN));
  $intervalSlider.value = String(storedMin);
  updateIntervalLabel(storedMin);
  updateIntervalRowVisibility();

  const storedDomains = Array.isArray(stored[StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS])
    ? stored[StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS]
    : [];
  $allowDomainsInput.value = storedDomains.join("\n");

  // 機能フラグを復元
  const storedFeatures = SearchFixer.mergeFeatures(stored[StorageKeys.SEARCH_FIXER_FEATURES]);
  for (const [key, input] of featureInputs) {
    input.checked = storedFeatures[key] === true;
  }
  // グリッド列数を復元
  $gridItemsSelect.value = String(SearchFixer.clampGridItems(stored[StorageKeys.SEARCH_FIXER_GRID_ITEMS]));

  updateCleanerCountBadge();
  updateCleanerDimState();

  // ----- イベントバインド -----
  $enabledToggle.addEventListener("change", apply);
  $keepAliveToggle.addEventListener("change", () => {
    updateIntervalRowVisibility();
    apply();
  });
  $ytShortsToggle.addEventListener("change", apply);
  $searchFixerToggle.addEventListener("change", () => {
    updateCleanerDimState();
    // master ON にしたとき詳細未開封ならアクセス導線として開く
    if ($searchFixerToggle.checked && !$cleanerAccordion.open) {
      $cleanerAccordion.open = true;
    }
    apply();
  });
  $amazonDeliveryToggle.addEventListener("change", apply);
  $volumeBoosterToggle.addEventListener("change", async () => {
    updateVolumeRowVisibility();
    // master ON にした瞬間、active tab の現在 gain を offscreen から取得してスライダーへ反映。
    // 未ブーストなら 100% (DEFAULT) を表示。OFF にすると background が release_all を呼ぶ。
    if ($volumeBoosterToggle.checked) {
      // 設定を保存してから問い合わせる（保存前は background ガードに弾かれる）
      await apply();
      await syncCurrentTabVolume();
    } else {
      $volumeSlider.value = String(VolumeBooster.DEFAULT);
      updateVolumeLabel(VolumeBooster.DEFAULT);
      setVolumeHint("");
      await apply();
    }
  });

  // 音量スライダー: input でラベルだけ更新、change で gain を即送信。
  // input ごとに送るとメッセージが洪水になるので、change（マウスアップ）で送信。
  // ただし反応性のため、debounced input でも送るようにする（最終的な値の取りこぼし防止）。
  $volumeSlider.addEventListener("input", () => {
    const v = VolumeBooster.clampValue($volumeSlider.value);
    updateVolumeLabel(v);
    scheduleVolumePush(v);
  });
  $volumeSlider.addEventListener("change", () => {
    const v = VolumeBooster.clampValue($volumeSlider.value);
    pushVolumeNow(v).catch(() => {});
  });

  $volumeResetBtn.addEventListener("click", async () => {
    $volumeSlider.value = String(VolumeBooster.DEFAULT);
    updateVolumeLabel(VolumeBooster.DEFAULT);
    await pushVolumeNow(VolumeBooster.DEFAULT);
  });

  // スライダーは入力中は label のみ更新、確定時に apply（書き込み連打抑制）
  $intervalSlider.addEventListener("input", () => {
    updateIntervalLabel(Number($intervalSlider.value));
  });
  $intervalSlider.addEventListener("change", apply);

  // 機能トグルと select は change で apply
  for (const input of featureInputs.values()) {
    input.addEventListener("change", () => {
      updateCleanerCountBadge();
      apply();
    });
  }
  $gridItemsSelect.addEventListener("change", apply);

  // 許可ドメインは blur で正規化 + apply（編集途中の連打を避ける）
  $allowDomainsInput.addEventListener("blur", () => {
    const { domains, rejectedCount } = parseAllowDomains($allowDomainsInput.value);
    $allowDomainsInput.value = domains.join("\n");
    if (rejectedCount > 0) {
      $allowlistStatus.textContent = `⚠️ ${rejectedCount} 行を無効として除外`;
      $allowlistStatus.className = "textarea-status error";
    } else if (domains.length > 0) {
      $allowlistStatus.textContent = `✓ ${domains.length} 件のドメインを保存`;
      $allowlistStatus.className = "textarea-status ok";
    } else {
      $allowlistStatus.textContent = "";
      $allowlistStatus.className = "textarea-status";
    }
    apply();
  });

  // ----- DOM 構築 -----

  /**
   * クリーナーの詳細設定 UI（カテゴリブロック + 個別トグル）を SearchFixer 定数から生成する。
   * label/input を組み立て、後で apply に集計するため featureInputs Map に登録する。
   */
  function buildFeatureCategories() {
    const frag = document.createDocumentFragment();
    for (const cat of SearchFixer.CATEGORIES) {
      const items = SearchFixer.FEATURES.filter((f) => f.category === cat.id);
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

        const name = document.createElement("span");
        name.className = "fr-name";
        name.textContent = item.label;

        const sw = document.createElement("span");
        sw.className = "switch";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.id = `feature-${item.key}`;
        input.dataset.featureKey = item.key;
        const track = document.createElement("span");
        track.className = "switch-track";
        track.setAttribute("aria-hidden", "true");
        sw.append(input, track);

        row.append(name, sw);
        list.appendChild(row);
        featureInputs.set(item.key, input);
      }

      wrap.append(head, list);
      frag.appendChild(wrap);
    }
    $featureCategories.appendChild(frag);
  }

  /** グリッド select を SearchFixer.GRID_OPTIONS から生成 */
  function buildGridSelect() {
    for (const opt of SearchFixer.GRID_OPTIONS) {
      const o = document.createElement("option");
      o.value = String(opt.value);
      o.textContent = opt.label;
      $gridItemsSelect.appendChild(o);
    }
  }

  // ----- バッジ・dim 更新 -----
  function updateCleanerCountBadge() {
    let on = 0;
    for (const input of featureInputs.values()) {
      if (input.checked) on++;
    }
    const total = featureInputs.size;
    $cleanerCount.textContent = `${on}/${total}`;
  }

  /** マスター OFF のとき詳細を視覚的に薄くする（編集自体は許可） */
  function updateCleanerDimState() {
    const dim = !$searchFixerToggle.checked;
    $featureCategories.classList.toggle("cleaner-disabled", dim);
  }

  // ----- 適用 -----
  async function apply() {
    const enabled = $enabledToggle.checked;
    const keepAliveEnabled = $keepAliveToggle.checked;
    const ytShortsRemovalEnabled = $ytShortsToggle.checked;
    const searchFixerEnabled = $searchFixerToggle.checked;
    const amazonDeliveryTotalEnabled = $amazonDeliveryToggle.checked;
    const volumeBoosterEnabled = $volumeBoosterToggle.checked;
    const minutes = clampMinutes(Number($intervalSlider.value));
    const keepAliveIntervalMs = minutes * KeepAlive.MS_PER_MIN;
    const { domains: contextMenuAllowDomains } = parseAllowDomains($allowDomainsInput.value);
    const searchFixerFeatures = collectFeatureValues();
    const searchFixerGridItems = SearchFixer.clampGridItems($gridItemsSelect.value);

    const seq = ++applySeq;
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.APPLY_SETTINGS,
        data: {
          enabled,
          keepAliveEnabled,
          keepAliveIntervalMs,
          contextMenuAllowDomains,
          ytShortsRemovalEnabled,
          searchFixerEnabled,
          searchFixerFeatures,
          searchFixerGridItems,
          amazonDeliveryTotalEnabled,
          volumeBoosterEnabled,
        },
      });
      if (seq !== applySeq) return;
      if (res?.ok) {
        showStatus(
          buildOkMessage(
            enabled,
            keepAliveEnabled,
            ytShortsRemovalEnabled,
            searchFixerEnabled,
            amazonDeliveryTotalEnabled,
            volumeBoosterEnabled
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

  function buildOkMessage(
    enabled,
    keepAliveEnabled,
    ytShortsRemovalEnabled,
    searchFixerEnabled,
    amazonDeliveryTotalEnabled,
    volumeBoosterEnabled
  ) {
    const parts = [];
    if (enabled) parts.push("制限解除");
    if (keepAliveEnabled) parts.push("セッション維持");
    if (ytShortsRemovalEnabled) parts.push("Shorts");
    if (searchFixerEnabled) parts.push("クリーナー");
    if (amazonDeliveryTotalEnabled) parts.push("Amazon");
    if (volumeBoosterEnabled) parts.push("音量");
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

  function updateVolumeRowVisibility() {
    $volumeRow.classList.toggle("hidden", !$volumeBoosterToggle.checked);
  }

  function setVolumeHint(text, isError = false) {
    $volumeHint.textContent = text ?? "";
    $volumeHint.className = isError ? "volume-hint error" : "volume-hint";
  }

  /**
   * input イベントごとに sendMessage する代わりに、120ms debounce してから送る。
   * スライダーをドラッグ中は連続して input が走るが、その都度 tabCapture を呼ぶと
   * Chrome 側の getMediaStreamId 連打になるため、debounce で 1 つに集約する。
   */
  let volumePushTimer = null;
  function scheduleVolumePush(value) {
    if (volumePushTimer) clearTimeout(volumePushTimer);
    volumePushTimer = setTimeout(() => {
      volumePushTimer = null;
      pushVolumeNow(value).catch(() => {});
    }, 120);
  }

  async function pushVolumeNow(value) {
    if (!$volumeBoosterToggle.checked) return;
    const tab = await getActiveHttpTab();
    if (!tab) {
      setVolumeHint("⚠ このページでは使えません", true);
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.VOLUME_BOOSTER_SET_GAIN,
        data: { tabId: tab.id, gain: value },
      });
      if (res?.ok) {
        setVolumeHint("");
      } else {
        // master-disabled / no-stream-id / chrome:// など
        const msg = res?.error === "master-disabled"
          ? "⚠ 先にトグルを ON にしてください"
          : "⚠ このページでは使えません";
        setVolumeHint(msg, true);
      }
    } catch {
      setVolumeHint("⚠ 通信エラー", true);
    }
  }

  /**
   * Popup を開いたとき / master ON 時に、active tab の現在 gain を取得して反映する。
   * offscreen が起動していない場合は gain=null が返り、デフォルト 100% 表示にする。
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
   * tabCapture が動作するのは http(s):// タブのみ（chrome:// 等は不可）。
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

  // KeepAlive.clampIntervalMs を ms 単位の単一情報源として再利用 (#19)。
  // popup は分単位で操作するが、内部で ms に変換してクランプ後また分に戻すことで
  // MIN/MAX の数値定義を 1 箇所に集約する。
  function clampMinutes(min) {
    const n = Number(min);
    if (!Number.isFinite(n)) return DEFAULT_MIN;
    const ms = KeepAlive.clampIntervalMs(n * KeepAlive.MS_PER_MIN);
    return Math.round(ms / KeepAlive.MS_PER_MIN);
  }

  /**
   * textarea の複数行入力を正規化済みドメイン配列に変換する。
   * 1 行 1 ドメイン・空行スキップ・重複排除・不正行カウント。
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
    $status.className = "footer-status " + type;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      $status.textContent = "";
      $status.className = "footer-status";
      statusTimer = null;
    }, 1500);
  }
});
