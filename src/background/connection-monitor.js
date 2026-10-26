// 接続モニターの固定経路診断。ページの CSP と分離し、動画・設定・世代を確認して計測する。
(() => {
  const requests = new Map();
  const lastStart = new Map();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function youtubeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.port &&
        (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")) ? url : null;
    } catch { return null; }
  }

  function videoKey(url) {
    if (!url) return null;
    const id = url.pathname === "/watch" ? url.searchParams.get("v") :
      /^\/live\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    return typeof id === "string" && /^[\w-]{11}$/.test(id) ? id : null;
  }

  function cancel(tabId) {
    const record = requests.get(tabId);
    if (!record) return;
    record.controller.abort();
    if (requests.get(tabId) === record) requests.delete(tabId);
  }

  function current(record) {
    return requests.get(record.tabId) === record && !record.controller.signal.aborted;
  }

  async function waitForTurn(record) {
    const started = lastStart.get(record.tabId);
    const delay = started === undefined ? 0 : Math.max(0, started + ConnectionMonitor.DIAGNOSIS_INTERVAL_MS - performance.now());
    if (!delay) return;
    await new Promise((resolve) => {
      const signal = record.controller.signal;
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  async function authorized(record) {
    if (!current(record)) return false;
    const settings = await chrome.storage.local.get([
      StorageKeys.SEARCH_FIXER_ENABLED, StorageKeys.SEARCH_FIXER_FEATURES,
    ]);
    if (!current(record) || settings[StorageKeys.SEARCH_FIXER_ENABLED] !== true ||
        settings[StorageKeys.SEARCH_FIXER_FEATURES]?.connectionMonitor !== true) return false;
    const tab = await chrome.tabs.get(record.tabId);
    return current(record) && videoKey(youtubeUrl(tab.url)) === record.videoKey;
  }

  async function probe(record) {
    try {
      if (!await authorized(record) || !current(record)) return { ok: false };
      // タイマーの微小なずれで次の診断を捨てず、残り時間だけ取消可能な状態で待つ。
      await waitForTurn(record);
      if (!current(record) || !await authorized(record) || !current(record)) return { ok: false };
      // 認可に時間がかかった場合も、実際の計測開始から次の5秒を確保する。
      lastStart.set(record.tabId, performance.now());
      const signal = AbortSignal.any([
        record.controller.signal, AbortSignal.timeout(ConnectionMonitor.ENDPOINT_TIMEOUT_MS),
      ]);
      const measure = async (url) => {
        if (!current(record)) return null;
        const start = performance.now();
        try {
          const response = await fetch(url, {
            method: "GET", mode: "no-cors", credentials: "omit",
            referrerPolicy: "no-referrer", cache: "no-store", redirect: "error", signal,
          });
          const rtt = performance.now() - start;
          // 本文を保持・解析しない。opaque 応答では body は null。
          if (response.body) void response.body.cancel().catch(() => {});
          return current(record) && Number.isFinite(rtt) ? rtt : null;
        } catch { return null; }
      };
      const [googleRtt, cloudflareRtt] = await Promise.all([
        measure(ConnectionMonitor.ENDPOINT_GOOGLE), measure(ConnectionMonitor.ENDPOINT_CLOUDFLARE),
      ]);
      if (!current(record) || !await authorized(record) || !current(record)) return { ok: false };
      return { ok: true, googleRtt, cloudflareRtt };
    } catch {
      return { ok: false };
    } finally {
      if (requests.get(record.tabId) === record) requests.delete(record.tabId);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action !== Actions.CONNECTION_MONITOR_PROBE &&
        message?.action !== Actions.CONNECTION_MONITOR_CANCEL) return false;
    const tabId = sender?.tab?.id;
    const url = youtubeUrl(sender?.url);
    if (!SenderCheck.isFromContentScript(sender) || sender.frameId !== 0 ||
        !Number.isInteger(tabId) || tabId < 0 || !url ||
        typeof message.requestId !== "string" || !uuidPattern.test(message.requestId)) {
      sendResponse({ ok: false });
      return false;
    }
    if (message.action === Actions.CONNECTION_MONITOR_CANCEL) {
      const record = requests.get(tabId);
      if (record?.requestId === message.requestId && record.documentId === sender.documentId) cancel(tabId);
      sendResponse({ ok: true });
      return false;
    }
    const key = videoKey(url);
    const now = performance.now();
    for (const [id, started] of lastStart) {
      if (!requests.has(id) && now - started >= ConnectionMonitor.DIAGNOSIS_INTERVAL_MS) lastStart.delete(id);
    }
    if (!key || requests.has(tabId)) {
      sendResponse({ ok: false });
      return false;
    }
    // await より先に予約し、認可待ち中の取消・重複要求も同じ世代で扱う。
    const record = {
      tabId, requestId: message.requestId, documentId: sender.documentId,
      videoKey: key, controller: new AbortController(),
    };
    requests.set(tabId, record);
    void probe(record).then(sendResponse);
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (StorageKeys.SEARCH_FIXER_ENABLED in changes ||
        StorageKeys.SEARCH_FIXER_FEATURES in changes)) {
      for (const tabId of requests.keys()) cancel(tabId);
    }
  });
  chrome.tabs.onUpdated.addListener((tabId, changes) => {
    if (changes.url !== undefined || changes.status === "loading") cancel(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    cancel(tabId);
    lastStart.delete(tabId);
  });
})();
