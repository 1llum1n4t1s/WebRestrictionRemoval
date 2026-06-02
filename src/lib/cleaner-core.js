"use strict";

/**
 * cleaner-core.js — body-class クリーナーの設定購読共通ランタイム
 *
 * /opop で抽出した共通モジュール。Instagram / TikTok クリーナーが同型コピーで持っていた
 * 「master + features の 2 キー設定購読 3 経路 (初期 storage.get / runtime.onMessage gate /
 * storage.onChanged 部分更新)」を集約する。
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

    // 経路 1: 初期 storage.get — master / features 両方を通知
    chrome.storage.local
      .get([masterKey, featuresKey])
      .then((stored) => {
        onUpdate({
          active: stored[masterKey] === true,
          features: mergeFeatures(stored[featuresKey]),
        });
      })
      .catch(() => {});

    // 経路 2: background からの APPLY_*_CS — enabled / features 両方を通知
    chrome.runtime.onMessage.addListener((request, sender) => {
      if (!SenderCheck.isFromBackground(sender)) return;
      if (request?.action !== applyAction) return;
      const data = request.data ?? {};
      onUpdate({
        active: data.enabled === true,
        features: mergeFeatures(data.features),
      });
    });

    // 経路 3: storage.onChanged — 変わったキーだけ通知 (片方だけ変わるケースに対応)
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const patch = {};
      if (masterKey in changes) patch.active = changes[masterKey].newValue === true;
      if (featuresKey in changes) patch.features = mergeFeatures(changes[featuresKey].newValue);
      if ("active" in patch || "features" in patch) onUpdate(patch);
    });
  }

  globalThis.CleanerCore = Object.freeze({ subscribe });
})();
