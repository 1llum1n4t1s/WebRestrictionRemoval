(function () {
  "use strict";

  // 二重実行防止。
  // 新フラグ名 `__webRestrictionRemoverRunning` を採用（旧名 `__copyPasteAssistRunning` は
  // v1.0.x のコピペ特化時代の遺物で現在の多機能化に名前が合わない）。
  // 拡張機能更新（ページリロードなし）で新旧インスタンスが混在する移行期の二重実行を
  // 防ぐため、両フラグを OR でチェックし set する（旧コードが先に set していても
  // 新コードが再実行されない、逆も同様）。
  if (window.__copyPasteAssistRunning || window.__webRestrictionRemoverRunning) return;
  window.__copyPasteAssistRunning = true;
  window.__webRestrictionRemoverRunning = true;

  /** キャプチャフェーズでブロックしたイベントハンドラ登録簿 */
  const blockHandlers = {};

  // トップフレーム判定（MW 除去の多重送信を防ぐ用途）。cross-origin iframe でも安全に比較できる。
  const isTopFrame = window === window.top;

  /**
   * セッション維持ポーラー。初回 applyKeepAlive まで null。
   * all_frames: true で全 iframe に注入される。合成アクティビティ束は各フレームの idle 検知用に
   * 全フレーム発火が必要（他フレームには届かないため）。HTTP ping 側は keepalive.js 内で
   * クロスオリジン/重複判定をしてから発射する（同一オリジン iframe の N 倍発射を回避）。
   */
  let keepAlive = null;

  /**
   * インラインハンドラ属性除去を済ませたかのフラグ。
   * 属性は一度消せば DOM ノードのプロパティとして null 化された状態で維持されるため、
   * applyEnabled が複数回呼ばれても全DOM走査は初回のみに抑える。
   */
  let inlineHandlersRemoved = false;

  /**
   * ユーザー追加の contextmenu 許可ドメイン。storage / メッセージ経由で同期する。
   * 組み込みパターンは actions.js の ContextMenuAllowlist.BUILTIN_PATTERNS が判定する。
   */
  let currentAllowDomains = [];

  /**
   * 現在の storage 状態の closure キャッシュ。
   * storage.onChanged の changes には「変化したキー」しか含まれないため、
   * 変化していないキーの現在値を得るために毎回 storage.local.get するのは
   * 全フレーム × 変更頻度 × iframe 数 の IPC 爆発を招く。
   * ここで closure 保持し、各パス（初回 load / APPLY_SETTINGS_CS / storage.onChanged）
   * で最新値を一貫して更新することで追加 get を不要にする。
   */
  let currentEnabled = true;
  let currentKeepAliveEnabled = false;
  let currentKeepAliveIntervalMs = KeepAlive.DEFAULT_INTERVAL_MS;

  /**
   * 直近の右クリック対象のうち編集可能だった要素をキャッシュする。
   * chrome.contextMenus クリック時に document.activeElement が <body> に
   * リセットされるケース（Chrome のフォーカス仕様）があり、forcePaste で
   * フォールバック参照するための保険。
   */
  let lastContextEditable = null;

  function isEditableElement(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
  }

  /**
   * 右クリック時の編集可能要素キャッシュ。capture + passive で登録することで
   * サイト側リスナーの発火有無や preventDefault に影響されずに先行実行される。
   * ブロックハンドラ登録時に stopImmediatePropagation されるが、それは同じフェーズ
   * の後続リスナーに対するもので、先に addEventListener したこのハンドラは実行される。
   */
  document.addEventListener(
    "contextmenu",
    (e) => {
      lastContextEditable = isEditableElement(e.target) ? e.target : null;
    },
    { capture: true, passive: true }
  );

  /**
   * SPA ページ（X.com 等）でロゴ等のリンクをダブルクリックしたとき、
   * SPA ルーターが再レンダリング中で 2 回目の click に対して
   * preventDefault() を呼べない競合状態が起きる。
   * キャプチャフェーズで同一アンカーへの連続 click（600ms 以内）を検知し、
   * 2 回目以降は preventDefault() でネイティブナビゲーションをブロックする。
   * stopImmediatePropagation は呼ばないため SPA 側ハンドラには届く。
   */
  {
    let _lastAnchorClick = null;
    document.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      const anchor = e.target.closest("a[href]");
      if (!anchor) return;
      const now = performance.now();
      if (
        _lastAnchorClick &&
        _lastAnchorClick.href === anchor.href &&
        now - _lastAnchorClick.time < 600
      ) {
        // stopImmediatePropagation は呼ばない（React の event delegation 状態を壊して
        // 次のダブルクリックで React の handler が機能停止するため）。
        // preventDefault だけでネイティブリンク遷移は防げる。
        e.preventDefault();
        _lastAnchorClick = null;
        return;
      }
      _lastAnchorClick = { href: anchor.href, time: now };
    }, true);
  }

  /**
   * キャプチャフェーズでイベントを横取りしてサイト側のリスナー発火を封じる。
   * document 1箇所のみに登録するため処理負荷は極小。
   *
   * 注意: preventDefault は呼ばない。contextmenu に対して呼ぶとネイティブメニュー
   * まで抑制してしまうため、本拡張の「右クリック解除」の目的と逆になる。
   * サイト側 capture が content script より先に登録され preventDefault 済みのケース
   * （document_idle 注入のため起きうる）は本戦術では解消できないため、
   * 設計上の既知の制限として受容する。
   */
  function blockEvent(eventName) {
    if (blockHandlers[eventName]) return;
    const handler = (e) => { e.stopImmediatePropagation(); };
    blockHandlers[eventName] = handler;
    document.addEventListener(eventName, handler, true);
  }

  function unblockEvent(eventName) {
    if (!blockHandlers[eventName]) return;
    document.removeEventListener(eventName, blockHandlers[eventName], true);
    delete blockHandlers[eventName];
  }

  /**
   * インラインハンドラを isolated world 側で除去する。
   * DOM 要素のプロパティ/属性は isolated world と MAIN world で共有されるため、
   * ここで querySelectorAll でヒットした要素の属性・プロパティ除去はページ側にも反映される。
   * ただし document/html/body の各ノード「プロパティ」は隔離されているため、
   * ページ側のグローバル設定分は background.js の removeInlineHandlersInMainWorld で別途除去する。
   * 属性セレクタヒットと主要3ノードのみ対象にして全DOM走査を回避する。
   */
  function removeInlineHandlers() {
    if (inlineHandlersRemoved) return;
    inlineHandlersRemoved = true;
    const attrs = SilentUnlock.INLINE_ATTRS;
    const selector = attrs.map((a) => `[${a}]`).join(",");
    document.querySelectorAll(selector).forEach((el) => {
      attrs.forEach((a) => {
        el.removeAttribute(a);
        el[a] = null;
      });
    });
    [document, document.documentElement, document.body].forEach((root) => {
      if (!root) return;
      attrs.forEach((a) => { root[a] = null; });
    });
  }

  /**
   * サイレント自動解除を有効化/無効化する。
   * 対象: 右クリック制限 + テキスト選択制限（processing cost を抑えるため自動発動）
   *
   * @param {boolean} isEnabled
   * @param {{ requestMwRemove?: boolean }} [opts] - MW 除去を background に依頼するか。
   *   true の経路（初回 load / popup からの APPLY_SETTINGS_CS 受信）のみ送信する。
   *   storage.onChanged は iframe 毎に発火するため送信源を絞らないと O(iframe^2) 負荷。
   *   background 側は allFrames: true で全フレームの MW 除去を行うので 1 回送れば十分。
   */
  function applyEnabled(isEnabled, opts) {
    if (isEnabled) {
      // 許可ホスト（Excel Online / Google Docs / Notion 等）では contextmenu + selectstart を
      // サイト側に通し、カスタム右クリックメニューとテキスト選択制御を尊重する。
      // selectstart も通すのは、contextmenu だけ通しても Google Sheets 等でサイト側の
      // 選択範囲追跡が動かず「コピー項目がグレーアウトする」半壊を起こしうるため。
      // dragstart ブロックとインラインハンドラ除去・user-select CSS は通常通り作用させる。
      // currentAllowDomains が後から変化しても再 apply で切り替わるよう毎回判定する。
      const allowCustomMenu = ContextMenuAllowlist.isAllowed(location.hostname, currentAllowDomains);
      for (const ev of SilentUnlock.EVENTS) {
        if (allowCustomMenu && (ev === "contextmenu" || ev === "selectstart")) {
          unblockEvent(ev);
        } else {
          blockEvent(ev);
        }
      }
      removeInlineHandlers();
      document.documentElement.classList.add(SilentUnlock.CSS_CLASS_SELECT);
      if (opts?.requestMwRemove) {
        chrome.runtime.sendMessage({ action: Actions.REMOVE_HANDLERS_MW }).catch(() => {});
      }
    } else {
      SilentUnlock.EVENTS.forEach(unblockEvent);
      document.documentElement.classList.remove(SilentUnlock.CSS_CLASS_SELECT);
    }
  }

  /**
   * セッション維持機能を有効化/無効化する。
   * iframe を含む全フレームで動作する（合成アクティビティ束は各フレームの idle 検知に必要）。
   * HTTP ping の多重発射回避は keepalive.js 内で shouldFireHttpPing() がクロスオリジン判定する。
   * 初回呼び出しで createKeepAlive によりポーラーを生成し、以降は同じインスタンスを start/stop/setIntervalMs で制御する。
   * 値の正規化（非数値・範囲外）は keepalive.js 側に一任する。
   *
   * @param {boolean} isEnabled
   * @param {number | unknown} intervalMs ポーリング間隔候補（数値以外や範囲外は keepalive 内で DEFAULT にクランプ）
   */
  function applyKeepAlive(isEnabled, intervalMs) {
    if (!keepAlive) {
      // 遅延生成: keepAliveEnabled が一度も true にならないタブでは createKeepAlive を呼ばない
      if (!isEnabled) return;
      keepAlive = createKeepAlive({ intervalMs });
    } else {
      keepAlive.setIntervalMs(intervalMs);
    }
    if (isEnabled) {
      keepAlive.start();
    } else {
      keepAlive.stop();
    }
  }

  // ---------- 強制ペースト ----------
  /**
   * クリップボードを読み取り、編集可能な要素に書き込む。
   * 対象要素の解決優先度:
   *   1. document.activeElement（編集可能な場合のみ）
   *   2. lastContextEditable（直前の右クリック対象キャッシュ）
   *      → Chrome が contextmenu 後に activeElement を body にリセットするケースへの対応。
   * input/textarea: native setter を使って React 等のフレームワークにも反映。
   * contenteditable: Range API でキャレット位置に挿入。
   * execCommand を最初に試し、失敗時のみフォールバック。
   */
  async function forcePaste() {
    // content script は http:// 等の非 secure context で動作しうるため
    // 直接 navigator.clipboard.readText を呼ぶと reject される。
    // background 経由で offscreen document (chrome-extension:// = secure) を通す。
    let text = "";
    try {
      const response = await chrome.runtime.sendMessage({ action: Actions.READ_CLIPBOARD });
      text = response?.text ?? "";
    } catch {
      return;
    }
    if (!text) return;

    const active = document.activeElement;
    const el = isEditableElement(active) ? active : lastContextEditable;
    if (!isEditableElement(el)) return;

    // キャッシュフォールバック時はフォーカスを戻してから execCommand を実行
    // （execCommand("insertText") はフォーカス要素に対して作用するため）
    if (el !== active && typeof el.focus === "function") {
      try { el.focus(); } catch {}
    }

    // execCommand('insertText') は input/textarea/contenteditable 全てで動作し
    // 多くのフレームワークでも適切にイベントが発火される
    try {
      if (document.execCommand("insertText", false, text)) return;
    } catch {}

    // フォールバック: 要素種別で振り分け
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      insertIntoInput(el, text);
    } else if (el.isContentEditable) {
      insertIntoContentEditable(el, text);
    }
  }

  function insertIntoInput(el, text) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    // React 等のコントロールドコンポーネント対応のため native setter で代入
    const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, next);
    } else {
      el.value = next;
    }
    const caret = start + text.length;
    try { el.setSelectionRange(caret, caret); } catch {}
    // InputEvent に inputType/data を付与することで React 等のフレームワーク側で
    // paste/insert として適切に処理される
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function insertIntoContentEditable(el, text) {
    const sel = window.getSelection();
    // Range が el の内側に収まっているかは commonAncestorContainer で判定する。
    // anchorNode だけだと選択開始が el 内で終端が外にあるケースに対応できない。
    const range0 = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const rangeInside = range0 && el.contains(range0.commonAncestorContainer);

    if (rangeInside) {
      range0.deleteContents();
      const node = document.createTextNode(text);
      range0.insertNode(node);
      range0.setStartAfter(node);
      range0.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range0);
    } else {
      // セレクションが無い / el 外にある場合は末尾に textNode として追記する。
      // `el.textContent += text` は editable 配下のマークアップを全破壊するため使わない。
      const node = document.createTextNode(text);
      el.appendChild(node);
      // キャレットを挿入直後に移動（可能なら）
      try {
        const range = document.createRange();
        range.setStartAfter(node);
        range.collapse(true);
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {}
    }
    // inputType/data 付きで dispatch することで React 等のフレームワーク互換性を高める
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  // ---------- 強制コピー ----------
  /**
   * 選択範囲のテキストをクリップボードに書き込む。
   * 優先度: background から渡された info.selectionText → window.getSelection()
   *
   * 書き込み自体は background → offscreen document (chrome-extension:// = secure) で実行する。
   * content script 直接の navigator.clipboard.writeText は http:// で secure context 制限により
   * reject されるうえ、execCommand("copy") フォールバックもサイト側の copy ブロッカーに
   * 阻害されうるため、extension context 側で確実に書き込む。
   */
  async function forceCopy(selectionText) {
    let text = selectionText;
    if (!text) {
      text = window.getSelection()?.toString() ?? "";
    }
    if (!text) return;
    try {
      await chrome.runtime.sendMessage({
        action: Actions.WRITE_CLIPBOARD,
        data: { text },
      });
    } catch {}
  }

  // ---------- メッセージ受信 ----------
  // content script へのメッセージは background (Service Worker) 由来のみ許可する。
  // 同一拡張内の popup / 他 content script / offscreen から APPLY_SETTINGS_CS を偽装されて
  // currentAllowDomains 上書き等の挙動差し替えを受けないよう二層防御を固める。
  const _expectedBackgroundUrl = chrome.runtime.getURL("src/background/background.js");
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (
      sender?.id !== chrome.runtime.id ||
      sender?.tab ||
      sender?.url !== _expectedBackgroundUrl
    ) {
      return;
    }
    if (request.action === Actions.APPLY_SETTINGS_CS) {
      const enabled = request.data?.enabled === true;
      // 許可ドメインはメッセージに含まれている場合のみ更新する（互換性のため。
      // 無い場合は storage.onChanged 経由の同期値を維持）。
      if (Array.isArray(request.data?.contextMenuAllowDomains)) {
        currentAllowDomains = request.data.contextMenuAllowDomains;
      }
      // closure キャッシュを更新（storage.onChanged の追加 get を不要にするため）
      currentEnabled = enabled;
      const kaEnabled = request.data?.keepAliveEnabled === true;
      currentKeepAliveEnabled = kaEnabled;
      if (Number.isFinite(request.data?.keepAliveIntervalMs)) {
        currentKeepAliveIntervalMs = request.data.keepAliveIntervalMs;
      }
      // MW 除去は background (handleApplySettings) 側で handleApplySettings 直後に
      // allFrames: true で直接実行されるため、APPLY_SETTINGS_CS 経路からは再送しない。
      // storage.onChanged 経由の再適用は iframe でも発火するためそちらに一本化する。
      applyEnabled(enabled, { requestMwRemove: false });
      applyKeepAlive(kaEnabled, currentKeepAliveIntervalMs);
      sendResponse({ ok: true });
    } else if (request.action === Actions.FORCE_PASTE) {
      // async 関数の結果を待ってから sendResponse。return true でチャネルを保持する。
      // これがないと background 側は完了前に「成功」応答を受け取り、失敗を検知できない。
      forcePaste()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    } else if (request.action === Actions.FORCE_COPY) {
      forceCopy(request.data?.selectionText)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
  });

  // ---------- ストレージ変更監視 ----------
  // all_frames: true で iframe にも content script が注入されるため、popup からの
  // APPLY_SETTINGS_CS はアクティブタブのトップフレームにしか届かない。
  // 非アクティブタブや同タブ内の他フレームも挙動を同期させるため storage.onChanged を購読する。
  // MW 除去依頼は 1 タブあたりトップフレーム 1 回に限定し、O(iframe²) 負荷を回避する
  // （background 側は allFrames: true で全フレームに実行するため 1 回で十分）。
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const enabledChange = changes[StorageKeys.ENABLED];
    const allowChange = changes[StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS];
    const kaEnabledChange = changes[StorageKeys.KEEP_ALIVE_ENABLED];
    const kaIntervalChange = changes[StorageKeys.KEEP_ALIVE_INTERVAL_MS];

    if (allowChange) {
      currentAllowDomains = Array.isArray(allowChange.newValue) ? allowChange.newValue : [];
    }
    if (enabledChange) {
      currentEnabled = enabledChange.newValue === true;
    }

    // enabled / allow-list のどちらかが変化したら applyEnabled を再実行。
    // 現在値は closure の currentEnabled を参照するため追加 storage.get 不要。
    if (enabledChange || allowChange) {
      // enabled 変化時のみ MW 除去を再依頼（allow-list のみの変化では不要）。
      // トップフレームに集約して O(iframe²) 負荷を回避（background は allFrames: true）。
      const requestMwRemove = !!enabledChange && currentEnabled && isTopFrame;
      applyEnabled(currentEnabled, { requestMwRemove });
    }

    // セッション維持関連の変更は enabled と独立に処理する（片方だけのトグル変更もあり得るため）。
    // changes[key].newValue を直接使い、closure キャッシュも同時に更新。これで追加 get 不要。
    if (kaEnabledChange || kaIntervalChange) {
      if (kaEnabledChange) currentKeepAliveEnabled = kaEnabledChange.newValue === true;
      if (kaIntervalChange && Number.isFinite(kaIntervalChange.newValue)) {
        currentKeepAliveIntervalMs = kaIntervalChange.newValue;
      }
      applyKeepAlive(currentKeepAliveEnabled, currentKeepAliveIntervalMs);
    }
  });

  // ---------- 初回ロード ----------
  // document_idle で注入されるため DOM は既に安定しており、setTimeout で遅延させる必要はない。
  // むしろ遅延すると blockEvent の登録前にサイト側 contextmenu が発火するリスクが残る。
  chrome.storage.local
    .get([
      StorageKeys.ENABLED,
      StorageKeys.KEEP_ALIVE_ENABLED,
      StorageKeys.KEEP_ALIVE_INTERVAL_MS,
      StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS,
    ])
    .then((result) => {
      currentEnabled = result[StorageKeys.ENABLED] !== false;
      currentKeepAliveEnabled = result[StorageKeys.KEEP_ALIVE_ENABLED] === true;
      if (Number.isFinite(result[StorageKeys.KEEP_ALIVE_INTERVAL_MS])) {
        currentKeepAliveIntervalMs = result[StorageKeys.KEEP_ALIVE_INTERVAL_MS];
      }
      const ad = result[StorageKeys.CONTEXT_MENU_ALLOW_DOMAINS];
      currentAllowDomains = Array.isArray(ad) ? ad : [];
      applyEnabled(currentEnabled, { requestMwRemove: currentEnabled && isTopFrame });
      applyKeepAlive(currentKeepAliveEnabled, currentKeepAliveIntervalMs);
    });
})();
