"use strict";

/**
 * cleaner-core.js — content script の設定購読共通ランタイム
 *
 * /opop で抽出した共通モジュール。Instagram / TikTok クリーナーが同型コピーで持っていた
 * 「master + features の 2 キー設定購読 3 経路 (初期 storage.get / runtime.onMessage gate /
 * storage.onChanged 部分更新)」を集約する。
 * 単一 boolean の直接通知は subscribeBoolean、保存値を直列再取得する通知は subscribeStored が担う。
 * 直接通知と保存値再取得の契約は分け、サイト固有の状態・適用処理は呼び出し側に残す。
 *
 * 設計判断:
 *   - active / features の保持と applyBodyClasses / 固有ロジック (Instagram の DOM スイープ・
 *     URL guard・i18n watchdog 等) は各 cs に残す。本モジュールは「購読 3 経路のセットアップ +
 *     変化通知」だけを担う最小責務 (early-framework.js / scan-runner.js と同じ「boilerplate 集約 +
 *     サイト固有ロジックは各 cs に残す」思想)。共通ベースに固有ロジックを押し込まないことで
 *     config 肥大化を避ける。
 *   - onUpdate(patch) で変化を通知する。patch は { active?, features? } で、storage.onChanged の
 *     片方のキーだけ変わったケースに対応するため変わったものだけ含む (各 cs が現在値を保持して
 *     部分更新する。変わってないキーが undefined で上書きされる罠を回避)。
 *
 * 二重ロード許容: 各 content_scripts エントリで個別ロードされても __cpaCleanerCoreLoaded ガードで
 * 2 回目以降は即 return する (actions.js / scan-runner.js と同じパターン)。
 */

(() => {
  if (window.__cpaCleanerCoreLoaded === true) return;
  window.__cpaCleanerCoreLoaded = true;

  /**
   * master + features 2 キーの設定購読 3 経路をセットアップする。
   * @param {Object} config
   * @param {string} config.masterKey       master トグルの storage key
   * @param {string} config.featuresKey     features オブジェクトの storage key
   * @param {string} config.applyAction     background から来る APPLY_*_CS action 名
   * @param {(raw: any) => Object} config.mergeFeatures  features を正規化する関数 (this 非依存に
   *   束縛するため呼び出し側でアローラップして渡す)
   * @param {(patch: {active?: boolean, features?: Object}) => void} config.onUpdate
   *   変化通知。変わったキーだけ patch に含む (active / features)。各 cs が現在値に部分適用する。
   */
  function subscribe(config) {
    const { masterKey, featuresKey, applyAction, mergeFeatures, onUpdate } = config;
    let masterNotified = false;
    let featuresNotified = false;

    // 経路 1: 初期 storage.get — master / features 両方を通知
    chrome.storage.local
      .get([masterKey, featuresKey])
      .then((stored) => {
        // 初期取得より後の通知をキーごとに優先し、未通知キーだけを補完する。
        const patch = {};
        if (!masterNotified) patch.active = stored[masterKey] === true;
        if (!featuresNotified) patch.features = mergeFeatures(stored[featuresKey]);
        if ("active" in patch || "features" in patch) onUpdate(patch);
      })
      .catch(() => {});

    // 経路 2: background からの APPLY_*_CS — enabled / features 両方を通知
    chrome.runtime.onMessage.addListener((request, sender) => {
      if (!SenderCheck.isFromBackground(sender)) return;
      if (request?.action !== applyAction) return;
      const data = request.data ?? {};
      masterNotified = true;
      featuresNotified = true;
      onUpdate({
        active: data.enabled === true,
        features: mergeFeatures(data.features),
      });
    });

    // 経路 3: storage.onChanged — 変わったキーだけ通知 (片方だけ変わるケースに対応)
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const patch = {};
      if (masterKey in changes) {
        masterNotified = true;
        patch.active = changes[masterKey].newValue === true;
      }
      if (featuresKey in changes) {
        featuresNotified = true;
        patch.features = mergeFeatures(changes[featuresKey].newValue);
      }
      if ("active" in patch || "features" in patch) onUpdate(patch);
    });
  }

  /** 単一 boolean の直接通知。読み取り失敗時は現在の状態を保持する。 */
  function subscribeBoolean({ masterKey, applyAction, onUpdate }) {
    let notified = false;
    chrome.storage.local.get(masterKey)
      .then((stored) => {
        if (!notified) onUpdate(stored[masterKey] === true);
      })
      .catch(() => {});

    chrome.runtime.onMessage.addListener((request, sender) => {
      if (!SenderCheck.isFromBackground(sender)) return;
      if (request?.action !== applyAction) return;
      notified = true;
      onUpdate(request.data?.enabled === true);
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (masterKey in changes) {
        notified = true;
        onUpdate(changes[masterKey].newValue === true);
      }
    });
  }

  /**
   * 通知を契機に保存値を再取得し、並行する要求は 1 回の後追いへまとめる。
   * changeKeys は取得キーの一部だけを変更契機にする場合に指定する。
   * onStored のサイト固有適用を含めて失敗時は保持し、次の通知で再試行する。
   */
  function subscribeStored({ keys, changeKeys = keys, applyAction, onStored }) {
    let inFlight = false;
    let queued = false;

    async function readSettingsAndApply() {
      if (!chrome?.runtime?.id) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const stored = await chrome.storage.local.get(keys);
        if (!chrome?.runtime?.id) return;
        onStored(stored);
      } catch {
        // 次の storage.onChanged / APPLY で再試行する。
      } finally {
        inFlight = false;
        if (queued) {
          queued = false;
          readSettingsAndApply();
        }
      }
    }

    readSettingsAndApply();
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (!chrome?.runtime?.id) return;
        if (areaName !== "local") return;
        if (changeKeys.some((key) => key in changes)) readSettingsAndApply();
      });
    } catch {}

    try {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!chrome?.runtime?.id) return;
        if (!SenderCheck.isFromBackground(sender)) return;
        if (request?.action !== applyAction) return;
        readSettingsAndApply();
        try { sendResponse({ ok: true }); } catch {}
      });
    } catch {}
  }

  globalThis.CleanerCore = Object.freeze({ subscribe, subscribeBoolean, subscribeStored });
})();
