"use strict";

/**
 * Popup ロジック。
 *
 * 責務:
 *   - chrome.storage.local から現在の設定を復元し、UI 要素にバインド
 *   - 各 input の変更を都度 background に APPLY_SETTINGS で送信
 *   - SearchFixer / InstagramCleaner の機能トグルと select は actions.js の FEATURES 配列から動的生成
 *     （個別機能数は actions.js を単一情報源とし、ここでは数値をハードコードしない）
 *   - 音量ブースターはマスタートグルなしの常時表示。100% で AudioContext 解放、
 *     それ以外の値で増幅処理を起動する
 *   - カラーピッカータブは EyeDropper API で画面色を採取し、履歴 / format chips / コピー先制御を提供
 *
 * ローカライズ:
 *   - 全 UI 文字列は `_locales/{en,ja}/messages.json` から `chrome.i18n.getMessage` 経由で取得する
 *   - 静的テキストは popup.html の `data-i18n` / `data-i18n-html` / `data-i18n-attr` 属性で指定し、
 *     applyI18nToDom() が DOMContentLoaded で一括適用する
 *   - 動的テキスト（status / picker note / pill 等）は i18n() ヘルパー経由
 *   - ブラウザ UI 言語が ja → 日本語、それ以外 → 英語にフォールバック
 *     （manifest.json の `default_locale: "en"` で実現）
 */

/**
 * `chrome.i18n.getMessage(key, substitutions)` の薄いラッパ。
 * - test 環境（Node）等で chrome global が無いケースでも throw しない
 * - キーが messages.json に無いと空文字を返すので、呼び出し側で fallback を持っても良い
 */
function i18n(key, ...substitutions) {
  if (!key) return "";
  if (typeof chrome === "undefined" || !chrome.i18n || !chrome.i18n.getMessage) return "";
  if (substitutions.length === 0) return chrome.i18n.getMessage(key) || "";
  return chrome.i18n.getMessage(key, substitutions) || "";
}

/**
 * カテゴリ id（例 "video_filter"）を category メッセージキー（例 "categoryVideoFilter"）に変換する。
 * actions.js の CATEGORIES の id と messages.json のキー命名規則を機械的に対応付ける。
 */
function categoryMessageKey(categoryId) {
  if (typeof categoryId !== "string" || !categoryId) return "";
  const camel = categoryId
    .split("_")
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return `category${camel}`;
}

/**
 * `data-i18n` / `data-i18n-html` / `data-i18n-attr` 属性を持つ要素群に対して
 * messages.json のメッセージを一括適用する。popup.html を fallback 日本語入りで配信し、
 * DOMContentLoaded 直後にここで上書きすることで、英語環境でも違和感のない UI を出す。
 *
 * - data-i18n="key": textContent を上書き
 * - data-i18n-html="key": innerHTML を上書き（messages.json は信頼できるソースのみなので XSS リスク無し）
 * - data-i18n-attr="attr1:key1;attr2:key2": 任意属性を上書き（aria-label / placeholder / title 等）
 */
function applyI18nToDom(root) {
  const scope = root || document;
  // textContent
  scope.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const msg = i18n(key);
    if (msg) el.textContent = msg;
  });
  // innerHTML（<code> タグ等のマークアップを含む説明文用）
  scope.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html");
    const msg = i18n(key);
    if (msg) el.innerHTML = msg;
  });
  // 属性
  scope.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    const spec = el.getAttribute("data-i18n-attr") || "";
    spec.split(";").forEach((pair) => {
      const idx = pair.indexOf(":");
      if (idx < 0) return;
      const attr = pair.slice(0, idx).trim();
      const key = pair.slice(idx + 1).trim();
      if (!attr || !key) return;
      const msg = i18n(key);
      if (msg) el.setAttribute(attr, msg);
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  // ----- ローカライズ: 静的テキストを最初に置換し、英語環境での FOUT を最小化 -----
  // <html lang> も UI 言語に追従させる（フォントフォールバックや スクリーンリーダー向け）
  try {
    if (chrome?.i18n?.getUILanguage) {
      const ui = chrome.i18n.getUILanguage();
      if (typeof ui === "string" && ui.length > 0) {
        document.documentElement.lang = ui.startsWith("ja") ? "ja" : "en";
      }
    }
  } catch {
    // 読めなくても表示には影響しない
  }
  applyI18nToDom();

  // ----- 観測性: 拡張バージョンを footer に表示 (I-7) -----
  // サポート対応時の「バージョンを教えてください」コストを削るため、popup を開けば常時見える形で提示。
  // chrome.runtime.getManifest() は同期 API なので非同期処理を待たずに即時反映できる。
  try {
    const $extVersion = document.getElementById("extVersion");
    if ($extVersion) {
      const manifest = chrome.runtime.getManifest();
      $extVersion.textContent = `v${manifest.version}`;
    }
  } catch {
    // manifest 読み取り失敗時はサイレント（version 表示は観測性向上で機能要件ではない）。
  }

  // ----- 要素参照 -----
  const $keepAliveToggle = document.getElementById("keepAliveToggle");
  const $searchFixerToggle = document.getElementById("searchFixerToggle");
  const $amazonDeliveryToggle = document.getElementById("amazonDeliveryToggle");
  const $volumeBoosterToggle = document.getElementById("volumeBoosterToggle");
  const $volumeRow = document.getElementById("volumeRow");
  const $volumeSlider = document.getElementById("volumeSlider");
  const $volumeValue = document.getElementById("volumeValue");
  const $volumeResetBtn = document.getElementById("volumeResetBtn");
  const $volumeHint = document.getElementById("volumeHint");
  const $volumeAntiClipToggle = document.getElementById("volumeAntiClipToggle");
  const $volumeNormalizeToggle = document.getElementById("volumeNormalizeToggle");
  const $volumeNightModeToggle = document.getElementById("volumeNightModeToggle");
  const $intervalRow = document.getElementById("intervalRow");
  const $intervalSlider = document.getElementById("intervalSlider");
  const $intervalValue = document.getElementById("intervalValue");
  const $keepAliveHttpPingToggle = document.getElementById("keepAliveHttpPingToggle");
  const $featureCategories = document.getElementById("featureCategories");
  const $searchFixerPill = document.getElementById("searchFixerPill");
  // $gridItemsSelect は buildFeatureCategories で menu_ui カテゴリ末尾に動的挿入されるため、
  // ここでは取得せず、buildFeatureCategories の後で参照する。
  const $videoGammaToggle = document.getElementById("videoGammaToggle");
  const $videoGammaRow = document.getElementById("videoGammaRow");
  const $videoGammaSlider = document.getElementById("videoGammaSlider");
  const $videoGammaValueLabel = document.getElementById("videoGammaValueLabel");
  const $videoGammaResetBtn = document.getElementById("videoGammaResetBtn");
  const $instagramCleanerToggle = document.getElementById("instagramCleanerToggle");
  const $igFeatureCategories = document.getElementById("igFeatureCategories");
  const $instagramCleanerPill = document.getElementById("instagramCleanerPill");
  const $tiktokCleanerToggle = document.getElementById("tiktokCleanerToggle");
  const $ttFeatureCategories = document.getElementById("ttFeatureCategories");
  const $tiktokCleanerPill = document.getElementById("tiktokCleanerPill");
  const $status = document.getElementById("statusMsg");

  // ----- ローカル状態 -----
  let statusTimer = null;
  let applySeq = 0;
  /** @type {Map<string, HTMLInputElement>} */
  const featureInputs = new Map();
  /** @type {Map<string, HTMLInputElement>} Instagram クリーナーの個別機能入力 */
  const igFeatureInputs = new Map();
  /** @type {Map<string, HTMLInputElement>} TikTok クリーナーの個別機能入力 */
  const ttFeatureInputs = new Map();

  // ----- スライダー単位は分、storage は ms -----
  const MIN_MIN = Math.round(KeepAlive.MIN_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  const MAX_MIN = Math.round(KeepAlive.MAX_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  const DEFAULT_MIN = Math.round(KeepAlive.DEFAULT_INTERVAL_MS / KeepAlive.MS_PER_MIN);
  $intervalSlider.min = String(MIN_MIN);
  $intervalSlider.max = String(MAX_MIN);

  buildFeatureCategories();
  // menu_ui カテゴリ末尾に挿入された gridItemsSelect を以降の処理で参照する。
  // _buildAccordionCategories が cat.id === "menu_ui" のとき _buildGridItemsRow で生成する。
  const $gridItemsSelect = document.getElementById("gridItemsSelect");
  buildGridSelect();
  buildInstagramFeatureCategories();
  buildTikTokFeatureCategories();

  // ----- 現在状態を復元 -----
  // 3-C4 最適化: アシスト系 + カラーピッカー系の storage key を 1 回の get で並列取得し、
  // popup 起動時の直列 RTT (旧: 2 回 await) を 1 回に削減する。
  // P0-#3: INSTALL_SENTINEL も同じ get に乗せて storage 破損 / リセットを検知する。
  const stored = await chrome.storage.local.get([
    StorageKeys.KEEP_ALIVE_ENABLED,
    StorageKeys.KEEP_ALIVE_INTERVAL_MS,
    StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED,
    StorageKeys.KEEP_ALIVE_ORIGINS,
    StorageKeys.SEARCH_FIXER_ENABLED,
    StorageKeys.SEARCH_FIXER_FEATURES,
    StorageKeys.SEARCH_FIXER_GRID_ITEMS,
    StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED,
    StorageKeys.INSTAGRAM_CLEANER_ENABLED,
    StorageKeys.INSTAGRAM_CLEANER_FEATURES,
    StorageKeys.TIKTOK_CLEANER_ENABLED,
    StorageKeys.TIKTOK_CLEANER_FEATURES,
    StorageKeys.VOLUME_BOOSTER_ENABLED,
    StorageKeys.VOLUME_BOOSTER_LAST_GAIN,
    StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED,
    StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED,
    StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED,
    StorageKeys.VIDEO_GAMMA_ENABLED,
    StorageKeys.VIDEO_GAMMA_VALUE,
    StorageKeys.COLOR_PICKER_HISTORY,
    StorageKeys.COLOR_PICKER_DEFAULT_FORMAT,
    StorageKeys.COLOR_PICKER_HEX_HASH,
    StorageKeys.POPUP_LAST_TAB,
    StorageKeys.INSTALL_SENTINEL,
  ]);

  // P0-#3 storage 破損検知: onInstalled で必ず書き込まれる sentinel が消えていれば、
  // chrome.storage.local がリセット・破損した可能性。本番ユーザーへ telemetry 送信は行わず
  // 開発者コンソールに警告のみ出して、自動的にセンチネルを再書き込みする（次回以降は警告なし）。
  if (stored[StorageKeys.INSTALL_SENTINEL] !== 1) {
    console.warn(
      "[WebViewingAssist] storage センチネルが見つかりません。chrome.storage.local が" +
        "リセットまたは破損された可能性があります。設定が初期状態（全マスタートグル OFF）に" +
        "戻っている場合は再度トグルを有効化してください。"
    );
    chrome.storage.local
      .set({ [StorageKeys.INSTALL_SENTINEL]: 1 })
      .catch(() => {});
  }

  let keepAliveOrigins = KeepAlive.normalizeOrigins(stored[StorageKeys.KEEP_ALIVE_ORIGINS]);
  const currentKeepAliveOrigin = await getActiveHttpOrigin();
  $keepAliveToggle.checked =
    stored[StorageKeys.KEEP_ALIVE_ENABLED] === true &&
    currentKeepAliveOrigin !== null &&
    KeepAlive.isOriginAllowed(keepAliveOrigins, currentKeepAliveOrigin);
  if (!currentKeepAliveOrigin) {
    $keepAliveToggle.disabled = true;
    $keepAliveHttpPingToggle.disabled = true;
  }
  $keepAliveHttpPingToggle.checked = stored[StorageKeys.KEEP_ALIVE_HTTP_PING_ENABLED] === true;
  $searchFixerToggle.checked = stored[StorageKeys.SEARCH_FIXER_ENABLED] === true;
  $amazonDeliveryToggle.checked = stored[StorageKeys.AMAZON_DELIVERY_TOTAL_ENABLED] === true;
  $instagramCleanerToggle.checked = stored[StorageKeys.INSTAGRAM_CLEANER_ENABLED] === true;
  $tiktokCleanerToggle.checked = stored[StorageKeys.TIKTOK_CLEANER_ENABLED] === true;
  $volumeBoosterToggle.checked = stored[StorageKeys.VOLUME_BOOSTER_ENABLED] === true;
  $volumeAntiClipToggle.checked = stored[StorageKeys.VOLUME_BOOSTER_ANTI_CLIP_ENABLED] === true;
  $volumeNormalizeToggle.checked = stored[StorageKeys.VOLUME_BOOSTER_NORMALIZE_ENABLED] === true;
  $volumeNightModeToggle.checked = stored[StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED] === true;

  // 動画ガンマ補正の初期値設定
  $videoGammaToggle.checked = stored[StorageKeys.VIDEO_GAMMA_ENABLED] === true;
  $videoGammaSlider.min = String(VideoGamma.SLIDER_MIN);
  $videoGammaSlider.max = String(VideoGamma.SLIDER_MAX);
  $videoGammaSlider.step = String(VideoGamma.SLIDER_STEP);
  const storedGamma = VideoGamma.clampValue(stored[StorageKeys.VIDEO_GAMMA_VALUE]);
  $videoGammaSlider.value = String(VideoGamma.valueToSlider(storedGamma));
  updateVideoGammaLabel(storedGamma);
  updateVideoGammaRowVisibility();

  // 音量スライダー: 保存済み gain があればそれを復元、なければ DEFAULT
  $volumeSlider.min = String(VolumeBooster.SLIDER_MIN);
  $volumeSlider.max = String(VolumeBooster.SLIDER_MAX);
  $volumeSlider.step = String(VolumeBooster.STEP);
  const savedGain = Number.isFinite(stored[StorageKeys.VOLUME_BOOSTER_LAST_GAIN])
    ? VolumeBooster.clampValue(stored[StorageKeys.VOLUME_BOOSTER_LAST_GAIN])
    : VolumeBooster.DEFAULT;
  $volumeSlider.value = String(VolumeBooster.percentToSliderPosition(savedGain));
  updateVolumeLabel(savedGain);
  updateVolumeBoosterDimState();
  // マスター ON 時は active tab にも保存設定を即適用（タブ切替で漏れた場合の保証）
  if ($volumeBoosterToggle.checked) {
    pushVolumeNow(savedGain).catch(() => {});
  }

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

  const storedTtFeatures = TikTokCleaner.mergeFeatures(stored[StorageKeys.TIKTOK_CLEANER_FEATURES]);
  for (const [key, input] of ttFeatureInputs) {
    input.checked = storedTtFeatures[key] === true;
  }

  updateCleanerCountBadge();
  updateCleanerDimState();
  updateIgCleanerCountBadge();
  updateIgCleanerDimState();
  updateTtCleanerCountBadge();
  updateTtCleanerDimState();

  // ============================================================
  // ===== タブナビ + 顔料アトリエ（カラーピッカー） =====
  // ============================================================

  // ---------- DOM 参照 ----------
  // 5 タブ構成: 調整 (tune) / YouTube / Instagram / TikTok / カラーピッカー (picker)。
  // tab/panel ペアを Map で保持し、setActiveTab / 矢印キー操作を統一的に扱う。
  const $tabTune = document.getElementById("tabTune");
  const $tabYoutube = document.getElementById("tabYoutube");
  const $tabInstagram = document.getElementById("tabInstagram");
  const $tabTikTok = document.getElementById("tabTikTok");
  const $tabPicker = document.getElementById("tabPicker");
  const $panelTune = document.getElementById("panelTune");
  const $panelYoutube = document.getElementById("panelYoutube");
  const $panelInstagram = document.getElementById("panelInstagram");
  const $panelTikTok = document.getElementById("panelTikTok");
  const $panelPicker = document.getElementById("panelPicker");

  /** タブ id → { tab, panel } の対応表。順序は UI と一致させる（矢印キー巡回用）。 */
  const TAB_REGISTRY = [
    { id: PopupTabs.TUNE, tab: $tabTune, panel: $panelTune },
    { id: PopupTabs.YOUTUBE, tab: $tabYoutube, panel: $panelYoutube },
    { id: PopupTabs.INSTAGRAM, tab: $tabInstagram, panel: $panelInstagram },
    { id: PopupTabs.TIKTOK, tab: $tabTikTok, panel: $panelTikTok },
    { id: PopupTabs.PICKER, tab: $tabPicker, panel: $panelPicker },
  ];
  const $specimenCard = document.getElementById("specimenCard");
  const $specimenSwatch = document.getElementById("specimenSwatch");
  const $specimenNo = document.getElementById("specimenNo");
  const $specimenTime = document.getElementById("specimenTime");
  const $specimenPill = document.getElementById("specimenPill");
  const $hexValue = document.getElementById("hexValue");
  const $rgbValue = document.getElementById("rgbValue");
  const $hslValue = document.getElementById("hslValue");
  const $valueList = document.getElementById("valueList");
  const $pickBtn = document.getElementById("pickBtn");
  const $pickerNote = document.getElementById("pickerNote");
  const $historyGrid = document.getElementById("historyGrid");
  const $historyCount = document.getElementById("historyCount");
  const $historyEmpty = document.getElementById("historyEmpty");
  const $clearHistoryBtn = document.getElementById("clearHistoryBtn");
  const $fmtRadios = Array.from(document.querySelectorAll('input[name="defaultFormat"]'));
  const $copyBtns = Array.from(document.querySelectorAll(".copy-btn"));
  const $hexHashCheck = document.getElementById("hexHashCheck");

  // ---------- ピッカー状態 ----------
  /** @type {string|null} 現在表示中の HEX 色（"#rrggbb"）。null なら未採取 */
  let currentHex = null;
  /** @type {Array<{hex:string, ts:number}>} 採取履歴（新しい順） */
  let history = [];
  /** 既定の保存形式 */
  let defaultFormat = ColorPicker.DEFAULT_FORMAT;
  /** HEX コピー時に # を含めるか */
  let hexIncludeHash = true;

  // ---------- ストレージ復元 (3-C4: 上の stored を共有して二度目の get を省略) ----------
  const pickerStored = stored;
  defaultFormat = ColorPicker.normalizeFormat(pickerStored[StorageKeys.COLOR_PICKER_DEFAULT_FORMAT]);
  hexIncludeHash = pickerStored[StorageKeys.COLOR_PICKER_HEX_HASH] !== false;
  history = sanitizeHistory(pickerStored[StorageKeys.COLOR_PICKER_HISTORY]);
  for (const radio of $fmtRadios) {
    radio.checked = radio.value === defaultFormat;
  }
  $hexHashCheck.checked = hexIncludeHash;
  applyDefaultFormatHighlight();

  // 履歴があれば最新色を初期表示。無ければ空状態のまま。
  if (history.length > 0) {
    setCurrentColor(history[0].hex, { time: history[0].ts, silent: true });
  } else {
    setEmptyState();
  }
  renderHistory();

  // EyeDropper 未対応ブラウザの早期検出（minimum_chrome_version は 140 だが念のため防御）
  if (typeof window.EyeDropper !== "function") {
    $pickBtn.disabled = true;
    $pickerNote.classList.add("is-error");
    $pickerNote.textContent = i18n("eyedropperUnsupported");
  }

  // ---------- タブ初期化 ----------
  // 旧 "assist" 値が残っていても PopupTabs.migrate で "tune" に正規化する。
  const lastTab = PopupTabs.migrate(pickerStored[StorageKeys.POPUP_LAST_TAB]);
  setActiveTab(lastTab, { persist: false, focus: false });

  for (const entry of TAB_REGISTRY) {
    entry.tab.addEventListener("click", () => setActiveTab(entry.id));
    // ←/→ 矢印キーで前後に巡回（WAI-ARIA Authoring Practices 準拠）。最後で → なら最初に折返し。
    entry.tab.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      const idx = TAB_REGISTRY.findIndex((e) => e.id === entry.id);
      if (idx < 0) return;
      const delta = ev.key === "ArrowRight" ? 1 : -1;
      const nextIdx = (idx + delta + TAB_REGISTRY.length) % TAB_REGISTRY.length;
      setActiveTab(TAB_REGISTRY[nextIdx].id, { focus: true });
    });
  }

  function setActiveTab(tabId, { persist = true, focus = false } = {}) {
    const target = PopupTabs.normalize(tabId);
    let activeEntry = null;
    for (const entry of TAB_REGISTRY) {
      const isActive = entry.id === target;
      entry.tab.classList.toggle("is-active", isActive);
      entry.tab.setAttribute("aria-selected", String(isActive));
      entry.tab.tabIndex = isActive ? 0 : -1;
      entry.panel.classList.toggle("is-active", isActive);
      entry.panel.hidden = !isActive;
      if (isActive) activeEntry = entry;
    }
    if (focus && activeEntry) activeEntry.tab.focus();
    if (persist) {
      chrome.storage.local
        .set({ [StorageKeys.POPUP_LAST_TAB]: target })
        .catch(() => {});
    }
  }

  // ---------- ピッカ��イベント ----------
  $pickBtn.addEventListener("click", onPick);
  $clearHistoryBtn.addEventListener("click", onClearHistory);
  for (const radio of $fmtRadios) radio.addEventListener("change", onFormatChange);
  $hexHashCheck.addEventListener("change", onHexHashChange);
  for (const btn of $copyBtns) btn.addEventListener("click", onCopyClick);
  $historyGrid.addEventListener("click", onHistoryClick);

  // 別ウィンドウで履歴が変わったら反映（複数 popup 同時起動の保険）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[StorageKeys.COLOR_PICKER_HISTORY]) {
      history = sanitizeHistory(changes[StorageKeys.COLOR_PICKER_HISTORY].newValue);
      renderHistory();
    }
    if (changes[StorageKeys.COLOR_PICKER_DEFAULT_FORMAT]) {
      defaultFormat = ColorPicker.normalizeFormat(
        changes[StorageKeys.COLOR_PICKER_DEFAULT_FORMAT].newValue
      );
      for (const radio of $fmtRadios) radio.checked = radio.value === defaultFormat;
      applyDefaultFormatHighlight();
    }
    if (changes[StorageKeys.COLOR_PICKER_HEX_HASH]) {
      hexIncludeHash = changes[StorageKeys.COLOR_PICKER_HEX_HASH].newValue !== false;
      $hexHashCheck.checked = hexIncludeHash;
    }
  });

  // ----- イベントバインド -----
  $keepAliveToggle.addEventListener("change", () => {
    updateIntervalRowVisibility();
    apply();
  });
  $keepAliveHttpPingToggle.addEventListener("change", apply);
  $searchFixerToggle.addEventListener("change", () => {
    updateCleanerDimState();
    apply();
  });
  $amazonDeliveryToggle.addEventListener("change", apply);

  $instagramCleanerToggle.addEventListener("change", () => {
    updateIgCleanerDimState();
    apply();
  });

  $tiktokCleanerToggle.addEventListener("change", () => {
    updateTtCleanerDimState();
    apply();
  });

  // 動画ガンマ補正: master toggle / slider / 1.0 戻すボタン
  $videoGammaToggle.addEventListener("change", () => {
    updateVideoGammaRowVisibility();
    apply();
  });
  $videoGammaSlider.addEventListener("input", () => {
    updateVideoGammaLabel(currentVideoGammaValue());
  });
  $videoGammaSlider.addEventListener("change", apply);
  $videoGammaResetBtn.addEventListener("click", () => {
    $videoGammaSlider.value = String(VideoGamma.SLIDER_DEFAULT);
    updateVideoGammaLabel(VideoGamma.DEFAULT);
    apply();
  });

  // 音量ブースター: マスタートグル
  $volumeBoosterToggle.addEventListener("change", () => {
    const on = $volumeBoosterToggle.checked;
    chrome.storage.local.set({ [StorageKeys.VOLUME_BOOSTER_ENABLED]: on }).catch(() => {});
    updateVolumeBoosterDimState();
    if (on) {
      const v = VolumeBooster.sliderPositionToPercent($volumeSlider.value);
      pushVolumeNow(v).catch(() => {});
    }
  });

  // 音量スライダー: input でラベル + debounced push、change（マウスアップ）で即送信
  $volumeSlider.addEventListener("input", () => {
    const v = VolumeBooster.sliderPositionToPercent($volumeSlider.value);
    updateVolumeLabel(v);
    scheduleVolumePush(v);
  });
  $volumeSlider.addEventListener("change", () => {
    const v = VolumeBooster.sliderPositionToPercent($volumeSlider.value);
    cancelVolumePush();
    pushVolumeNow(v).catch(() => {});
  });

  $volumeResetBtn.addEventListener("click", async () => {
    cancelVolumePush();
    $volumeSlider.value = String(VolumeBooster.percentToSliderPosition(VolumeBooster.DEFAULT));
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
  $volumeNightModeToggle.addEventListener("change", () => {
    cancelVolumePush();
    chrome.storage.local.set({
      [StorageKeys.VOLUME_BOOSTER_NIGHT_MODE_ENABLED]: $volumeNightModeToggle.checked,
    }).catch(() => {});
    applyCompressorTogglePush();
  });

  /**
   * compressor トグル変更時の共通処理: 現在 gain を再送信して AudioContext / compressor 状態を即時反映する。
   *
   * UNITY (100%) でもサブトグルが ON なら background が AudioContext を維持するため、
   * トグルだけ変えても即座に効果が出る（旧仕様の「100% より上で有効」ヒントは廃止）。
   */
  async function applyCompressorTogglePush() {
    const v = VolumeBooster.sliderPositionToPercent($volumeSlider.value);
    await pushVolumeNow(v).catch(() => {});
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

  for (const input of ttFeatureInputs.values()) {
    input.addEventListener("change", () => {
      updateTtCleanerCountBadge();
      apply();
    });
  }

  // ----- DOM 構築 -----

  /**
   * メニュー/UI カテゴリの末尾に挿入する「ホーム列数」select 行を構築する。
   * popup.html から static な select-row を取り除き、SearchFixer のカテゴリと整列させて
   * 動的に menu_ui カテゴリ配下に置く。<select> の options は別途 buildGridSelect が埋める。
   */
  function _buildGridItemsRow(listEl) {
    const row = document.createElement("div");
    row.className = "select-row";

    const label = document.createElement("label");
    label.className = "select-label";
    label.setAttribute("for", "gridItemsSelect");
    const icon = document.createElement("span");
    icon.className = "select-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "🔢";
    const nameSpan = document.createElement("span");
    nameSpan.className = "select-name";
    nameSpan.textContent = i18n("gridItemsLabel");
    label.append(icon, nameSpan);

    const select = document.createElement("select");
    select.id = "gridItemsSelect";
    select.className = "select";

    row.append(label, select);
    listEl.appendChild(row);
  }

  /**
   * クリーナー詳細アコーディオンの DOM ビルダー（YouTube クリーナー / Instagram クリーナー / TikTok クリーナー共通）。
   *
   * 構造: `cat` > `cat-head` (アイコン + ラベル) + `cat-list` (各機能のトグル行)。
   * 各 `feature-row` は 1 行 1 トグル + 説明文の縦積みレイアウト。
   * 各 `<input type="checkbox">` には `id="${idPrefix}${item.key}"` を付与し、
   * `inputMap` (`Map<key, input>`) に登録して呼び出し側で値の収集・復元に使う。
   *
   * カテゴリ id が "menu_ui" のときは末尾にホーム列数 select 行を動的挿入する。
   *
   * @param {string} messageKeyPrefix `feat_sf_` / `feat_ig_` / `feat_tt_` のいずれか。
   *   これに `${item.key}_label` / `${item.key}_desc` を後置して messages.json から取得する。
   */
  function _buildAccordionCategories(rootEl, categories, features, inputMap, idPrefix, messageKeyPrefix) {
    const frag = document.createDocumentFragment();
    for (const cat of categories) {
      const items = features.filter((f) => f.category === cat.id);
      // menu_ui カテゴリは features が空でもホーム列数 select を含めるため空チェックの除外対象。
      if (items.length === 0 && cat.id !== "menu_ui") continue;

      const wrap = document.createElement("div");
      wrap.className = "cat";

      const head = document.createElement("div");
      head.className = "cat-head";
      const headIcon = document.createElement("span");
      headIcon.className = "cat-head-icon";
      headIcon.textContent = cat.icon;
      headIcon.setAttribute("aria-hidden", "true");
      const headLabel = document.createElement("span");
      headLabel.textContent = i18n(categoryMessageKey(cat.id));
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
        name.textContent = i18n(`${messageKeyPrefix}${item.key}_label`);
        text.appendChild(name);

        const descMessage = i18n(`${messageKeyPrefix}${item.key}_desc`);
        if (descMessage) {
          const desc = document.createElement("span");
          desc.className = "fr-desc";
          desc.textContent = descMessage;
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

      // menu_ui カテゴリの末尾にホーム列数 select 行を挿入。
      // （Instagram / TikTok クリーナーには menu_ui カテゴリが無いため呼ばれない / カテゴリ集合次第で安全）
      if (cat.id === "menu_ui") {
        _buildGridItemsRow(list);
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
      "feature-",
      "feat_sf_"
    );
  }

  function buildGridSelect() {
    for (const opt of SearchFixer.GRID_OPTIONS) {
      const o = document.createElement("option");
      o.value = String(opt.value);
      o.textContent = i18n(opt.messageKey);
      $gridItemsSelect.appendChild(o);
    }
  }

  function updateCleanerCountBadge() {
    let on = 0;
    for (const input of featureInputs.values()) {
      if (input.checked) on++;
    }
    const total = featureInputs.size;
    // section title の grp-pill に「ON 数 / 全数 機能」を集約表示する。
    // アコーディオン廃止に伴い旧 .acc-count バッジは削除し、pill 1 つに情報を統合。
    if ($searchFixerPill) $searchFixerPill.textContent = i18n("pillTemplate", String(on), String(total));
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
      "ig-feature-",
      "feat_ig_"
    );
  }

  function updateIgCleanerCountBadge() {
    let on = 0;
    for (const input of igFeatureInputs.values()) {
      if (input.checked) on++;
    }
    const total = igFeatureInputs.size;
    if ($instagramCleanerPill) $instagramCleanerPill.textContent = i18n("pillTemplate", String(on), String(total));
  }

  function updateIgCleanerDimState() {
    const dim = !$instagramCleanerToggle.checked;
    $igFeatureCategories.classList.toggle("cleaner-disabled", dim);
  }

  // ----- TikTok クリーナー DOM 構築（Instagram と同じ _buildAccordionCategories を再利用） -----
  function buildTikTokFeatureCategories() {
    _buildAccordionCategories(
      $ttFeatureCategories,
      TikTokCleaner.CATEGORIES,
      TikTokCleaner.FEATURES,
      ttFeatureInputs,
      "tt-feature-",
      "feat_tt_"
    );
  }

  function updateTtCleanerCountBadge() {
    let on = 0;
    for (const input of ttFeatureInputs.values()) {
      if (input.checked) on++;
    }
    const total = ttFeatureInputs.size;
    if ($tiktokCleanerPill) $tiktokCleanerPill.textContent = i18n("pillTemplate", String(on), String(total));
  }

  function updateTtCleanerDimState() {
    const dim = !$tiktokCleanerToggle.checked;
    $ttFeatureCategories.classList.toggle("cleaner-disabled", dim);
  }

  // ----- 適用 -----
  async function apply() {
    const keepAliveSiteEnabled = $keepAliveToggle.checked;
    const nextKeepAliveOrigins = new Set(keepAliveOrigins);
    if (currentKeepAliveOrigin) {
      if (keepAliveSiteEnabled) {
        nextKeepAliveOrigins.add(currentKeepAliveOrigin);
      } else {
        nextKeepAliveOrigins.delete(currentKeepAliveOrigin);
      }
    }
    keepAliveOrigins = KeepAlive.normalizeOrigins(Array.from(nextKeepAliveOrigins));
    const keepAliveEnabled = keepAliveOrigins.length > 0;
    const keepAliveHttpPingEnabled = $keepAliveHttpPingToggle.checked;
    const searchFixerEnabled = $searchFixerToggle.checked;
    const amazonDeliveryTotalEnabled = $amazonDeliveryToggle.checked;
    const instagramCleanerEnabled = $instagramCleanerToggle.checked;
    const tiktokCleanerEnabled = $tiktokCleanerToggle.checked;
    const videoGammaEnabled = $videoGammaToggle.checked;
    const videoGammaValue = currentVideoGammaValue();
    const minutes = clampMinutes(Number($intervalSlider.value));
    const keepAliveIntervalMs = minutes * KeepAlive.MS_PER_MIN;
    const searchFixerFeatures = collectFeatureValues();
    const searchFixerGridItems = SearchFixer.clampGridItems($gridItemsSelect.value);
    const instagramCleanerFeatures = collectIgFeatureValues();
    const tiktokCleanerFeatures = collectTtFeatureValues();

    const seq = ++applySeq;
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.APPLY_SETTINGS,
        data: {
          keepAliveEnabled,
          keepAliveIntervalMs,
          keepAliveHttpPingEnabled,
          keepAliveOrigins,
          searchFixerEnabled,
          searchFixerFeatures,
          searchFixerGridItems,
          amazonDeliveryTotalEnabled,
          instagramCleanerEnabled,
          instagramCleanerFeatures,
          tiktokCleanerEnabled,
          tiktokCleanerFeatures,
          videoGammaEnabled,
          videoGammaValue,
        },
      });
      if (seq !== applySeq) return;
      if (res?.ok) {
        showStatus(
          buildOkMessage(
            keepAliveSiteEnabled,
            searchFixerEnabled,
            amazonDeliveryTotalEnabled,
            instagramCleanerEnabled,
            tiktokCleanerEnabled,
            videoGammaEnabled
          ),
          "ok"
        );
      } else {
        showStatus(i18n("applyError"), "error");
      }
    } catch {
      if (seq !== applySeq) return;
      showStatus(i18n("applyError"), "error");
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

  function collectTtFeatureValues() {
    const out = {};
    for (const [key, input] of ttFeatureInputs) {
      out[key] = input.checked;
    }
    return out;
  }

  function buildOkMessage(
    keepAliveEnabled,
    searchFixerEnabled,
    amazonDeliveryTotalEnabled,
    instagramCleanerEnabled,
    tiktokCleanerEnabled,
    videoGammaEnabled
  ) {
    const parts = [];
    if (keepAliveEnabled) parts.push(i18n("applyOkSession"));
    if (searchFixerEnabled) parts.push(i18n("applyOkSearchFixer"));
    if (amazonDeliveryTotalEnabled) parts.push(i18n("applyOkAmazon"));
    if (instagramCleanerEnabled) parts.push(i18n("applyOkInstagram"));
    if (tiktokCleanerEnabled) parts.push(i18n("applyOkTiktok"));
    if (videoGammaEnabled) parts.push(i18n("applyOkVideoGamma"));
    if (parts.length === 0) return i18n("applyOkAllStopped");
    return i18n("applyOkPrefix") + parts.join(i18n("applyOkSeparator"));
  }

  // ----- ヘルパー -----
  function updateIntervalLabel(min) {
    $intervalValue.textContent = i18n("intervalUnit", String(min));
  }

  function updateIntervalRowVisibility() {
    $intervalRow.classList.toggle("hidden", !$keepAliveToggle.checked);
  }

  // ----- 動画ガンマ補正 ヘルパー -----
  function currentVideoGammaValue() {
    return VideoGamma.sliderToValue($videoGammaSlider.value);
  }

  function updateVideoGammaLabel(value) {
    const v = VideoGamma.clampValue(value);
    $videoGammaValueLabel.textContent = v.toFixed(2);
  }

  function updateVideoGammaRowVisibility() {
    $videoGammaRow.classList.toggle("hidden", !$videoGammaToggle.checked);
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
    if (!$volumeBoosterToggle.checked) return;
    // popup → background は normalizeSettings を経由しない直接書き込み経路のため、
    // popup 側で必ず VolumeBooster.clampValue を通す。background ハンドラ側でも clamp
    // するが、storage に範囲外値が紛れ込むのを防ぐため二重防御 (/rere B1-S1-1)。
    const clamped = VolumeBooster.clampValue(value);
    chrome.storage.local.set({ [StorageKeys.VOLUME_BOOSTER_LAST_GAIN]: clamped }).catch(() => {});
    const tab = await getActiveHttpTab();
    // popup クローズ後の orphan await から戻ったときは DOM が detached になっていることが
    // ある。`document.body.isConnected` が false なら setVolumeHint も storage 書き込みも
    // 副作用ゼロ路に倒して終了する (/rere B1-S2-1)。
    if (!document.body?.isConnected) return;
    if (!tab) {
      setVolumeHint(i18n("volumeErrorUnsupportedPage"), true);
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({
        action: Actions.VOLUME_BOOSTER_SET_GAIN,
        data: {
          tabId: tab.id,
          gain: clamped,
          antiClip: $volumeAntiClipToggle.checked,
          normalize: $volumeNormalizeToggle.checked,
          nightMode: $volumeNightModeToggle.checked,
        },
      });
      if (!document.body?.isConnected) return;
      if (res?.ok) {
        setVolumeHint("");
      } else {
        setVolumeHint(formatVolumeError(res?.error), true);
      }
    } catch {
      if (!document.body?.isConnected) return;
      setVolumeHint(i18n("volumeErrorCommunication"), true);
    }
  }

  /**
   * background が返すエラーコード文字列を、ユーザー向けの短いローカライズメッセージに翻訳する。
   * 不明なエラーは raw text を UI に漏らさず、汎用メッセージにフォールバックして
   * console.warn にだけ原文を出力する（開発時の調査は DevTools 経由で行う）。
   */
  function formatVolumeError(error) {
    if (!error) return i18n("volumeErrorUnsupportedPage");
    const s = String(error);
    if (s.includes("invalid-tab-id")) return i18n("volumeErrorInvalidTab");
    if (s.includes("offscreen-unavailable")) return i18n("volumeErrorOffscreenUnavailable");
    if (s.includes("invalid-stream-id")) return i18n("volumeErrorInvalidStream");
    // B1-B2 対策: getVolumeBoosterGain の await 中にタブが閉じられた race で
    // 「No tab with id」「Cannot find tab」等が返るケースを明示的に翻訳する。
    if (/no tab|cannot find.*tab|tab.*not found|invalid.*tab/i.test(s)) {
      return i18n("volumeErrorTabClosed");
    }
    if (/Tab capture not granted|user gesture/i.test(s)) {
      return i18n("volumeErrorUserGesture");
    }
    if (/cannot capture|chrome:|edge:/i.test(s)) {
      return i18n("volumeErrorUnsupportedPage");
    }
    if (/permission/i.test(s)) {
      return i18n("volumeErrorPermission");
    }
    // 不明なエラー: ユーザーには汎用メッセージのみ提示し、原文は DevTools console に。
    // raw error text を UI に出すと内部実装が漏れるため意図的に隠す。
    console.warn("[VolumeBooster] Unknown error:", s);
    return i18n("volumeErrorUnknown");
  }

  function updateVolumeBoosterDimState() {
    const off = !$volumeBoosterToggle.checked;
    $volumeRow.classList.toggle("volume-disabled", off);
    $volumeSlider.disabled = off;
    $volumeAntiClipToggle.disabled = off;
    $volumeNormalizeToggle.disabled = off;
    $volumeNightModeToggle.disabled = off;
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

  async function getActiveHttpOrigin() {
    const tab = await getActiveHttpTab();
    if (!tab?.url) return null;
    return KeepAlive.normalizeOrigin(tab.url);
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

  // ============================================================
  // ===== 顔料アトリエ（カラーピッカー）の関数群 =====
  // ============================================================

  /**
   * EyeDropper API を起動して画面上の色を採取する。
   *
   * 注意: ポップアップは focus を失うと閉じる挙動があるため、結果が出たらすぐ
   * `chrome.storage.local.set` でストレージに永続化してから UI 更新へ進む。
   * 万が一 .then 経路で popup が死んでも、ストレージは reload 後に復旧できる。
   */
  async function onPick() {
    if ($pickBtn.disabled) return;
    $pickBtn.disabled = true;
    $pickerNote.classList.remove("is-error");
    $pickerNote.textContent = i18n("pickerNoteActive");

    try {
      const dropper = new EyeDropper();
      const res = await dropper.open();
      const hex = normalizeHex(res?.sRGBHex);
      if (!hex) throw new Error("invalid_color");

      const entry = { hex, ts: Date.now() };
      history = addHistory(history, entry);
      // 先にストレージへ書く（popup が消えても復旧可能）
      await chrome.storage.local
        .set({ [StorageKeys.COLOR_PICKER_HISTORY]: history })
        .catch(() => {});

      setCurrentColor(hex, { time: entry.ts });
      renderHistory();

      // 既定形式で自動コピー（クリップボード書き込みは EyeDropper のユーザー
      // ジェスチャ範囲内なので Permission policy 下でも通る）
      const { text, label } = formatColor(hex, defaultFormat, { includeHash: hexIncludeHash });
      try {
        await navigator.clipboard.writeText(text);
        showStatus(i18n("pickerCopyOk", label, text), "ok");
      } catch {
        showStatus(i18n("pickerCopyFail", label, text), "");
      }
      $pickerNote.classList.remove("is-error");
      $pickerNote.textContent = i18n("pickerNoteRetake");
    } catch (err) {
      // ユーザーがキャンセル (AbortError) は静かに戻す
      if (err && err.name === "AbortError") {
        $pickerNote.textContent = i18n("pickerNoteCancelled");
      } else {
        $pickerNote.classList.add("is-error");
        $pickerNote.textContent = i18n("pickerNoteFailed");
      }
    } finally {
      $pickBtn.disabled = false;
    }
  }

  async function onClearHistory() {
    if (history.length === 0) return;
    history = [];
    await chrome.storage.local
      .set({ [StorageKeys.COLOR_PICKER_HISTORY]: [] })
      .catch(() => {});
    setEmptyState();
    renderHistory();
    showStatus(i18n("historyClearedToast"), "ok");
  }

  async function onFormatChange(ev) {
    const next = ev.target.value;
    if (!ColorPicker.isValidFormat(next)) return;
    defaultFormat = next;
    applyDefaultFormatHighlight();
    await chrome.storage.local
      .set({ [StorageKeys.COLOR_PICKER_DEFAULT_FORMAT]: defaultFormat })
      .catch(() => {});
  }

  async function onHexHashChange() {
    hexIncludeHash = $hexHashCheck.checked;
    await chrome.storage.local
      .set({ [StorageKeys.COLOR_PICKER_HEX_HASH]: hexIncludeHash })
      .catch(() => {});
  }

  async function onCopyClick(ev) {
    const btn = ev.currentTarget;
    if (btn.disabled || !currentHex) return;
    const fmt = btn.dataset.copy;
    if (!ColorPicker.isValidFormat(fmt)) return;
    const { text, label } = formatColor(currentHex, fmt, { includeHash: hexIncludeHash });
    try {
      await navigator.clipboard.writeText(text);
      const glyph = btn.querySelector(".copy-btn-glyph");
      if (glyph) {
        const original = glyph.textContent;
        btn.classList.add("is-copied");
        glyph.textContent = "✓";
        setTimeout(() => {
          btn.classList.remove("is-copied");
          glyph.textContent = original;
        }, 1100);
      }
      showStatus(i18n("copyOkToast", label, text), "ok");
    } catch {
      showStatus(i18n("copyFailToast"), "warn");
    }
  }

  async function onHistoryClick(ev) {
    const btn = ev.target.closest(".history-chip");
    if (!btn) return;
    const hex = normalizeHex(btn.getAttribute("data-hex"));
    if (!hex) return;
    const ts = Number(btn.getAttribute("data-ts"));
    setCurrentColor(hex, { time: Number.isFinite(ts) ? ts : Date.now() });

    // 履歴クリックでも既定形式で自動コピー
    const { text, label } = formatColor(hex, defaultFormat, { includeHash: hexIncludeHash });
    try {
      await navigator.clipboard.writeText(text);
      showStatus(i18n("copyOkToast", label, text), "ok");
    } catch {
      showStatus(i18n("copyToast", label, text), "");
    }
  }

  function applyDefaultFormatHighlight() {
    const rows = $valueList.querySelectorAll(".value-row");
    rows.forEach((row) => {
      row.dataset.default = row.dataset.fmt === defaultFormat ? "true" : "false";
    });
  }

  function setEmptyState() {
    currentHex = null;
    $specimenCard.classList.add("is-empty");
    document.documentElement.style.removeProperty("--pigment");
    document.documentElement.style.removeProperty("--pigment-contrast");
    document.documentElement.style.removeProperty("--pigment-tint");
    $hexValue.textContent = "—";
    $rgbValue.textContent = "—";
    $hslValue.textContent = "—";
    $hexValue.dataset.empty = "true";
    $rgbValue.dataset.empty = "true";
    $hslValue.dataset.empty = "true";
    $specimenNo.textContent = "No. — —";
    $specimenTime.textContent = i18n("specimenTimeEmpty");
    $specimenPill.textContent = i18n("specimenPillEmpty");
    for (const btn of $copyBtns) btn.disabled = true;
  }

  function setCurrentColor(hex, { silent = false, time = Date.now() } = {}) {
    const norm = normalizeHex(hex);
    if (!norm) return;
    currentHex = norm;
    $specimenCard.classList.remove("is-empty");

    const rgb = hexToRgb(norm);
    const hsl = rgbToHsl(rgb);
    const tint = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.10)`;
    const contrast = pickContrast(rgb);

    document.documentElement.style.setProperty("--pigment", norm);
    document.documentElement.style.setProperty("--pigment-contrast", contrast);
    document.documentElement.style.setProperty("--pigment-tint", tint);

    $hexValue.textContent = norm.toUpperCase();
    $rgbValue.textContent = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
    $hslValue.textContent = `${hsl.h}°, ${hsl.s}%, ${hsl.l}%`;
    delete $hexValue.dataset.empty;
    delete $rgbValue.dataset.empty;
    delete $hslValue.dataset.empty;

    const idx = findHistoryIndex(history, norm);
    const no = idx >= 0 ? String(idx + 1).padStart(2, "0") : "—";
    $specimenNo.textContent = `No. ${no}`;
    $specimenTime.textContent = formatTime(time);
    $specimenPill.textContent = norm.toUpperCase();
    for (const btn of $copyBtns) btn.disabled = false;

    void silent;
  }

  function renderHistory() {
    const limit = ColorPicker.HISTORY_LIMIT;
    $historyCount.textContent = `${history.length} / ${limit}`;
    $clearHistoryBtn.disabled = history.length === 0;

    if (history.length === 0) {
      $historyGrid.replaceChildren();
      $historyGrid.classList.add("hidden");
      $historyEmpty.classList.remove("hidden");
      return;
    }
    $historyGrid.classList.remove("hidden");
    $historyEmpty.classList.add("hidden");

    const items = history.map((entry, idx) => {
      const li = document.createElement("li");
      li.className = "history-item";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-chip";
      btn.style.background = entry.hex;
      btn.dataset.hex = entry.hex;
      btn.dataset.ts = String(entry.ts);
      const hexUpper = entry.hex.toUpperCase();
      btn.title = i18n("historyChipTitle", hexUpper, formatTime(entry.ts));
      btn.setAttribute("aria-label", i18n("historyChipAria", hexUpper));

      const meta = document.createElement("span");
      meta.className = "history-meta";
      meta.textContent = String(idx + 1).padStart(2, "0");

      li.append(btn, meta);
      return li;
    });
    $historyGrid.replaceChildren(...items);
  }
});

// ============================================================================
// 顔料アトリエ: 純関数ヘルパー（DOM/storage に依存しないので IIFE 外に切り出し）
// ============================================================================

/**
 * 受け取った任意の値を `#rrggbb` 6 桁小文字形式に正規化する。
 * 不正な入力は null を返す。
 *   - 先頭 # の有無は問わない
 *   - 短縮 3 桁形式 (#abc) は #aabbcc に展開
 *   - 余白は trim
 */
function normalizeHex(value) {
  if (typeof value !== "string") return null;
  let s = value.trim().toLowerCase();
  if (!s.startsWith("#")) s = "#" + s;
  if (!ColorPicker.HEX_RE.test(s)) return null;
  if (s.length === 4) {
    const r = s[1], g = s[2], b = s[3];
    s = `#${r}${r}${g}${g}${b}${b}`;
  }
  return s;
}

/** "#rrggbb" → {r,g,b} (各 0..255 整数)。不正値は黒を返す。 */
function hexToRgb(hex) {
  const norm = normalizeHex(hex) || "#000000";
  return {
    r: parseInt(norm.slice(1, 3), 16),
    g: parseInt(norm.slice(3, 5), 16),
    b: parseInt(norm.slice(5, 7), 16),
  };
}

/**
 * sRGB 0..255 → HSL（h 0..360 整数、s,l 0..100 整数）の変換。
 * W3C CSS Color Module の標準アルゴリズムを実装した独自関数（数学変換）。
 */
function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return {
    h: Math.round(h),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

/**
 * WCAG 2.1 の相対輝度に基づいて、対象色の上に置くべき高コントラストの文字色を返す。
 * 0.5 を境界に白/黒（実際は和紙系の暖色寄り）を切り替える。
 */
function pickContrast({ r, g, b }) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.5 ? "#1a1614" : "#fefcf9";
}

/** HEX を指定形式の文字列にフォーマット（"#RRGGBB" / "rgb(...)" / "hsl(...)"）。 */
function formatColor(hex, fmt, { includeHash = true } = {}) {
  const norm = normalizeHex(hex) || "#000000";
  if (fmt === "rgb") {
    const { r, g, b } = hexToRgb(norm);
    return { text: `rgb(${r}, ${g}, ${b})`, label: "RGB" };
  }
  if (fmt === "hsl") {
    const { h, s, l } = rgbToHsl(hexToRgb(norm));
    return { text: `hsl(${h}, ${s}%, ${l}%)`, label: "HSL" };
  }
  const upper = norm.toUpperCase();
  return { text: includeHash ? upper : upper.slice(1), label: "HEX" };
}

/** 不正/欠損エントリを除外して新しい順に最大 HISTORY_LIMIT 件を返す（重複は先勝ち）。 */
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const hex = normalizeHex(entry.hex);
    if (!hex || seen.has(hex)) continue;
    const ts = Number(entry.ts);
    seen.add(hex);
    out.push({ hex, ts: Number.isFinite(ts) ? ts : Date.now() });
    if (out.length >= ColorPicker.HISTORY_LIMIT) break;
  }
  return out;
}

/** 既存配列に新エントリを先頭挿入。同色は重複排除。上限超過は末尾を切り捨て。 */
function addHistory(list, entry) {
  const hex = normalizeHex(entry.hex);
  if (!hex) return list;
  const ts = Number.isFinite(entry.ts) ? entry.ts : Date.now();
  const filtered = list.filter((it) => it.hex !== hex);
  filtered.unshift({ hex, ts });
  if (filtered.length > ColorPicker.HISTORY_LIMIT) {
    filtered.length = ColorPicker.HISTORY_LIMIT;
  }
  return filtered;
}

/** 履歴配列の中で指定 HEX が何番目（0 始まり）かを返す。見つからなければ -1。 */
function findHistoryIndex(list, hex) {
  const norm = normalizeHex(hex);
  if (!norm) return -1;
  return list.findIndex((it) => it.hex === norm);
}

/** タイムスタンプを popup 用にコンパクトな文字列にする。当日は HH:mm のみ。 */
function formatTime(ts) {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
