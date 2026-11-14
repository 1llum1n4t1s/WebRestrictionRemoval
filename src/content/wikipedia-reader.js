"use strict";

// 記事の実ノードを新しい閲覧構造へ組み込み、解除時は元の配置へ戻す。
(() => {
  if (window !== window.top || window.__cpaWikipediaReaderRunning) return;
  window.__cpaWikipediaReaderRunning = true;

  const prefix = "__cpa-wiki-";
  const keys = [StorageKeys.WIKIPEDIA_ENABLED, StorageKeys.WIKIPEDIA_FEATURES, StorageKeys.WIKIPEDIA_APPEARANCE];
  let enabled = false;
  let features = WikipediaReader.mergeFeatures({});
  let appearance = WikipediaReader.normalizeAppearance({});
  let listeners = null;
  let appearanceStyle = null;
  let contents = null;
  let headingSignature = "";
  let contentsEntries = [];
  let currentContentsLink = null;
  let contentsFrame = 0;
  let revealContentsPosition = false;
  let reference = null;
  let referenceAnchor = null;
  let imageDialog = null;
  let imageOpener = null;
  let hideReferenceTimer = 0;
  let modern = null;
  const appearanceAttributes = {
    theme: "data-cpa-wiki-theme", font: "data-cpa-wiki-font", headingFont: "data-cpa-wiki-heading-font",
    linkStyle: "data-cpa-wiki-links", articleStyle: "data-cpa-wiki-article-style",
  };
  const assignedIds = new Map();
  // 新レイアウトで「左レールに目次を常時表示し、基本情報を導入部の右へ浮かべる」幅。
  // CSS の @media (min-width: 1000px) と同じ値を保つこと（片方だけ変えると開閉の初期状態と見た目がずれる）。
  const WIDE_LAYOUT = "(min-width: 1000px)";
  // readableLayout OFF の浮動目次は従来どおり 1400px 以上で開く。
  const FLOATING_CONTENTS = "(min-width: 1400px)";
  // 目次を既定で開く画面幅か。新レイアウトでは左レールが出る幅、従来の浮動目次では 1400px 以上。
  const contentsOpenByDefault = () => matchMedia(modern ? WIDE_LAYOUT : FLOATING_CONTENTS).matches;

  function moveInto(node, target) {
    if (!node?.parentNode || !target || target.contains(node)) return;
    const anchor = document.createComment("vuora-article-position");
    node.before(anchor);
    modern.moves.push({ node, anchor, target, parent: anchor.parentNode });
    target.append(node);
  }

  function restoreModernLayout() {
    if (!modern) return;
    const state = modern;
    const focused = document.activeElement;
    const replacedPage = state.sourceRoot && !state.sourceRoot.isConnected && !!document.querySelector("body > .mw-page-container");
    modern = null;
    // 目次は独立した機能なので、レイアウトだけの解除では維持する。
    if (contents && state.shell.contains(contents)) document.body.append(contents);
    for (const { anchor, target, parent } of state.moves.toReversed()) {
      // 移動先に残るサイト所有ノードを戻す。サイトによる置換やID変更も保持する。
      const current = [...target.childNodes].filter(node => !state.owned.has(node));
      if (target.isConnected && anchor.isConnected) anchor.replaceWith(...current);
      else {
        for (const node of current) {
          const replacement = node.id && [...document.querySelectorAll("#" + CSS.escape(node.id))].some(item => item !== node && !state.shell.contains(item));
          if (node.isConnected && state.shell.contains(node) && !anchor.isConnected && !replacement && !replacedPage) {
            (parent.isConnected ? parent : document.body).append(node);
          }
        }
        anchor.remove();
      }
    }
    state.factsObserver?.disconnect();
    cancelAnimationFrame(state.factsFrame);
    state.header?.remove();
    state.facts?.remove();
    state.display?.remove();
    state.shell.remove();
    document.documentElement.classList.remove(prefix + "modern");
    if (focused?.isConnected && focused !== document.body) focused.focus({ preventScroll: true });
  }

  function buildModernLayout() {
    let source = article();
    const supportedSkin = document.body.matches(".skin-vector-2022");
    if (modern && (!supportedSkin || !modern.shell.isConnected || modern.article !== source || !modern.contentAnchor?.isConnected)) restoreModernLayout();
    if (modern) return;
    source = article();
    const content = document.getElementById("content");
    if (!supportedSkin || !document.querySelector(".vector-header-container") || !document.querySelector(".vector-page-titlebar") || !document.querySelector(".vector-page-toolbar") || !source || !content?.contains(source) || !document.getElementById("firstHeading")) return;
    const focused = document.activeElement;
    const shell = document.createElement("div"); shell.className = prefix + "shell";
    const topbar = document.createElement("div"); topbar.className = prefix + "topbar";
    const notices = document.createElement("div"); notices.className = prefix + "notices";
    const grid = document.createElement("div"); grid.className = prefix + "reading-grid";
    const rail = document.createElement("aside"); rail.className = prefix + "rail";
    const footer = document.createElement("div"); footer.className = prefix + "footer";
    grid.append(rail); shell.append(topbar, notices, grid, footer);
    // Wikipedia の委任イベントが参照するページ祖先を維持する。
    (content.closest(".mw-page-container-inner") ?? document.body).append(shell);
    modern = { shell, rail, grid, article: source, content, sourceRoot: content.closest(".mw-page-container"), moves: [], owned: new Set([shell, topbar, notices, grid, rail, footer]) };
    moveInto(document.querySelector(".vector-header-container") ?? document.querySelector("body > header"), topbar);
    moveInto(document.querySelector(".vector-sitenotice-container"), notices);
    const nativeMenu = document.querySelector(".vector-column-start");
    if (nativeMenu) {
      const menu = document.createElement("details"); menu.className = prefix + "site-menu";
      const summary = document.createElement("summary"); summary.textContent = msg("wikipediaSiteMenu");
      modern.owned.add(menu).add(summary);
      menu.append(summary); rail.append(menu); moveInto(nativeMenu, menu);
      modern.siteMenu = menu;
    }
    moveInto(content, grid);
    modern.contentAnchor = modern.moves.find(item => item.node === content)?.anchor;
    moveInto(document.getElementById("footer"), footer);

    // 題名・言語ボタン・記事の操作（ツールバー）は Wikipedia の実ノードを元の場所に残し、CSS の grid だけで
    // 「題名 → 説明 → 閲覧/編集/履歴＋言語」の順に並べる。移動しないので、言語メニューの初期化と復元に影響しない。
    const description = source.querySelector(".shortdescription")?.textContent.trim();
    if (description) {
      // 説明文だけが独自ノード。題名バーの直後に置き、読み上げ順も「題名 → 説明」にする。
      const header = document.createElement("header"); header.className = prefix + "article-header";
      const text = document.createElement("p"); text.className = prefix + "description";
      text.textContent = description; header.append(text);
      modern.owned.add(header).add(text);
      const titlebar = content.querySelector(":scope > .vector-page-titlebar");
      if (titlebar) titlebar.after(header); else content.prepend(header);
      modern.header = header;
    }
    const infobox = source.querySelector("table.infobox");
    if (infobox && !infobox.closest(".navbox, .metadata")) {
      const facts = document.createElement("details"); facts.className = prefix + "facts";
      const rows = [...infobox.tBodies].flatMap(body => [...body.rows]);
      // 通常の項目／値の表だけを行ごとの2列に整え、複雑な結合セルは元の表構造で表示する。
      if (rows.some(row => row.cells.length === 2 && row.cells[0].tagName === "TH") && rows.every(row =>
        row.cells.length <= 2 && [...row.cells].every(cell => cell.rowSpan === 1)
        && (row.cells.length === 1 || [...row.cells].every(cell => cell.colSpan === 1)))) facts.classList.add(prefix + "facts-compact");
      const summary = document.createElement("summary"); summary.textContent = msg("wikipediaArticleInfo"); facts.append(summary);
      modern.owned.add(facts).add(summary);
      // 基本情報は元の位置（導入部の先頭）に置く。広い画面ではそこから右へ浮かべる（右列がある幅では CSS が右列へ張り出させ、
      // それ以外では導入文が横に回り込む）。
      // 位置を変えないので、節構造の違うパーサー出力でも同じ経路で動き、復元も元の位置コメントだけで済む。
      infobox.before(facts);
      moveInto(infobox, facts);
      modern.facts = facts;
      // 広い画面ではカードを開き、狭い画面では閉じた状態から始める。利用者が一度でも開閉したら画面幅の変更で上書きしない。
      facts.open = matchMedia(WIDE_LAYOUT).matches;
      summary.addEventListener("click", () => { modern.factsTouched = true; });
    }
    // 右の「表示」パネル（文字サイズ・幅・色）は読書中のノイズになるため、閉じた折りたたみに入れる。
    // 実ノード(nav)を移すだけで内容は複製しない。Vector の「非表示」操作で中身が無くなれば CSS で枠ごと消す。
    const appearanceNav = content.querySelector(".vector-column-end nav.vector-appearance-landmark");
    if (appearanceNav) {
      const display = document.createElement("details"); display.className = prefix + "display";
      const summary = document.createElement("summary"); summary.textContent = msg("wikipediaDisplaySettings");
      modern.owned.add(display).add(summary);
      display.append(summary);
      appearanceNav.before(display);
      moveInto(appearanceNav, display);
      modern.display = display;
    }
    document.documentElement.classList.add(prefix + "modern");
    // 基本情報が右列へ張り出す配置（position: absolute）では、記事本文より長いカードがフッターへ重ならないよう、
    // はみ出す高さを測って本文グリッドの下余白へ足す。カードや本文の大きさが変わるたびに測り直す（画像の読込・開閉・フォント）。
    if (modern.facts && typeof ResizeObserver === "function") {
      modern.factsObserver = new ResizeObserver(scheduleFactsOverflow);
      modern.factsObserver.observe(modern.facts);
      modern.factsObserver.observe(content);
    }
    if (focused?.isConnected && focused !== document.body) focused.focus({ preventScroll: true });
    revealHashTarget();
  }

  function syncFactsOverflow() {
    const state = modern;
    if (!state?.grid) return;
    let extra = 0;
    const facts = state.facts;
    // 張り出し配置（absolute）のときだけ測る。本文列内に浮かべる配置では、本文の高さにカードが含まれる。
    if (facts?.isConnected && getComputedStyle(facts).position === "absolute") {
      const overflow = facts.getBoundingClientRect().bottom + parseFloat(getComputedStyle(facts).marginBottom || "0") - state.content.getBoundingClientRect().bottom;
      extra = Math.max(0, Math.ceil(overflow));
    }
    const value = extra + "px";
    if (state.factsOverflow !== value) { state.factsOverflow = value; state.grid.style.setProperty("--cpa-wiki-facts-overflow", value); }
  }

  function scheduleFactsOverflow() {
    const state = modern;
    if (!state || state.factsFrame) return;
    state.factsFrame = requestAnimationFrame(() => {
      state.factsFrame = 0;
      if (modern === state) syncFactsOverflow();
    });
  }

  function revealHashTarget() {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const target = id && document.getElementById(id);
    if (!target || !modern?.shell.contains(target)) return;
    let opened = false;
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement && !parent.open) { parent.open = true; opened = true; }
    }
    if (opened) target.scrollIntoView({ block: "start" });
  }

  // 文言取得は manifest で先に読み込む ScanRunner の共有ヘルパーに寄せる。
  // fallback に "" を渡し、未定義キー・context 失効時も従来どおり空文字を返す（textContent に "undefined" を出さない）。
  const msg = (key) => ScanRunner.safeMsg(key, "");
  const article = () => document.querySelector("#mw-content-text .mw-parser-output");
  function isArticle() {
    const query = new URL(location.href).searchParams;
    return document.body.classList.contains("ns-0") && document.body.classList.contains("action-view")
      && !document.body.classList.contains("mw-mainpage") && !query.has("diff") && !query.has("veaction")
      && (!query.has("action") || query.get("action") === "view") && !!article()
      && !document.querySelector(".ve-active, .ve-activated, #wpTextbox1");
  }

  function closeReference() {
    clearTimeout(hideReferenceTimer);
    hideReferenceTimer = 0;
    reference?.remove();
    reference = null;
    referenceAnchor = null;
  }

  function closeImage() {
    if (!imageDialog) return;
    const opener = imageOpener;
    imageDialog.remove();
    imageDialog = null;
    imageOpener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  function removeContents() {
    cancelAnimationFrame(contentsFrame);
    contentsFrame = 0;
    revealContentsPosition = false;
    contentsEntries = [];
    currentContentsLink = null;
    contents?.remove();
    contents = null;
    headingSignature = "";
    document.documentElement.classList.remove(prefix + "contents");
    for (const [heading, id] of assignedIds) {
      if (heading.id === id) heading.removeAttribute("id");
    }
    assignedIds.clear();
  }

  function cleanup() {
    listeners?.abort();
    listeners = null;
    closeReference();
    closeImage();
    removeContents();
    restoreModernLayout();
    appearanceStyle?.remove();
    appearanceStyle = null;
    const root = document.documentElement;
    root.classList.remove(prefix + "active", prefix + "readable", prefix + "previews", prefix + "dark", prefix + "hide-appearance", prefix + "narrow");
    for (const attribute of Object.values(appearanceAttributes)) root.removeAttribute(attribute);
  }

  function imageCaption(source) {
    return source.closest("figure, .thumb")?.querySelector("figcaption, .thumbcaption")?.textContent?.trim() || source.alt;
  }

  function allowedImageSource(source) {
    try {
      const url = new URL(source.currentSrc || source.src);
      return url.protocol === "https:" && (["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname) || url.hostname.endsWith(".wikipedia.org"));
    } catch { return false; }
  }

  function makeImageCanvas(source, maxEdge) {
    if (!source.complete || source.naturalWidth < 1 || source.naturalHeight < 1) return null;
    if (!allowedImageSource(source)) return null;
    // 表示用 canvas だけを使い、再取得・画素の読出し・保存を行わない。
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, maxEdge / Math.max(source.naturalWidth, source.naturalHeight));
    canvas.width = Math.round(source.naturalWidth * scale);
    canvas.height = Math.round(source.naturalHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) return null;
    try { context.drawImage(source, 0, 0, canvas.width, canvas.height); } catch { return null; }
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", source.alt || msg("wikipediaImage"));
    return canvas;
  }

  function scheduleContentsPosition(reveal = false) {
    if (reveal === true) revealContentsPosition = true;
    if (!contents || contentsFrame) return;
    contentsFrame = requestAnimationFrame(() => {
      contentsFrame = 0;
      const reveal = revealContentsPosition;
      revealContentsPosition = false;
      if (!contents?.isConnected) return;
      const line = Math.min(160, innerHeight * .2);
      let selected = null;
      for (let index = contentsEntries.length - 1; index >= 0; index--) {
        const { heading, link } = contentsEntries[index];
        if (heading.isConnected && heading.getBoundingClientRect().top <= line) { selected = link; break; }
      }
      if (window.scrollY > 0 && window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2) selected = contentsEntries.at(-1)?.link ?? selected;
      if (selected === currentContentsLink && !reveal) return;
      currentContentsLink?.removeAttribute("aria-current");
      currentContentsLink = selected;
      selected?.setAttribute("aria-current", "location");
      if (!selected || !contents.open) return;
      // 記事の位置は動かさず、目次内のスクロール領域だけを追従させる。
      const scroller = [contents.closest("." + prefix + "rail"), contents.querySelector("nav")].find(el => el && /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight);
      if (!scroller) return;
      const item = selected.getBoundingClientRect(), box = scroller.getBoundingClientRect();
      if (item.top < box.top + 8) scroller.scrollTop += item.top - box.top - 8;
      else if (item.bottom > box.bottom - 8) scroller.scrollTop += item.bottom - box.bottom + 8;
    });
  }

  function buildContents() {
    const headings = [...article().querySelectorAll("h2, h3")].filter((el) => !el.closest("table, .navbox, .metadata"));
    for (const [heading, id] of assignedIds) {
      if (heading.isConnected) continue;
      if (heading.id === id) heading.removeAttribute("id");
      assignedIds.delete(heading);
    }
    const signature = headings.map((heading, index) => {
      const text = heading.querySelector(".mw-headline")?.textContent
        ?? [...heading.childNodes].filter((node) => !node.classList?.contains("mw-editsection")).map((node) => node.textContent).join("");
      let id = heading.id || heading.querySelector("[id]")?.id;
      if (!id) {
        id = prefix + "section-" + index;
        while (document.getElementById(id)) id += "-";
        heading.id = id;
        assignedIds.set(heading, id);
      }
      return { id, text: text.trim(), sub: heading.tagName === "H3" };
    });
    const nextSignature = JSON.stringify(signature);
    if (contents?.isConnected && nextSignature === headingSignature) {
      for (const [index, entry] of contentsEntries.entries()) entry.heading = headings[index];
      return;
    }
    const wasOpen = contents?.open ?? contentsOpenByDefault();
    contents?.remove();
    contentsEntries = [];
    currentContentsLink = null;
    headingSignature = nextSignature;
    if (!headings.length) {
      contents = null;
      document.documentElement.classList.remove(prefix + "contents");
      return;
    }
    contents = document.createElement("details");
    contents.className = prefix + "toc";
    contents.open = wasOpen;
    const summary = document.createElement("summary");
    summary.textContent = msg("wikipediaContents");
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", msg("wikipediaContents"));
    const list = document.createElement("ol");
    for (const [index, item] of signature.entries()) {
      const li = document.createElement("li");
      if (item.sub) li.className = prefix + "toc-sub";
      const link = document.createElement("a");
      link.href = "#" + encodeURIComponent(item.id);
      link.textContent = item.text;
      contentsEntries.push({ heading: headings[index], link });
      link.addEventListener("click", () => {
        // 左レールに常設できない幅では、項目を選んだら一覧を閉じて本文を見せる。
        if (!contentsOpenByDefault()) contents.open = false;
      }, { signal: listeners.signal });
      li.append(link);
      list.append(li);
    }
    nav.append(list);
    contents.append(summary, nav);
    contents.addEventListener("toggle", () => scheduleContentsPosition(true), { signal: listeners.signal });
    document.body.append(contents);
    document.documentElement.classList.add(prefix + "contents");
  }

  function positionReference() {
    if (!reference || !referenceAnchor?.isConnected) return closeReference();
    const rect = referenceAnchor.getBoundingClientRect();
    reference.style.left = Math.max(8, Math.min(rect.left, innerWidth - reference.offsetWidth - 8)) + "px";
    reference.style.top = Math.max(8, Math.min(rect.bottom + 8, innerHeight - reference.offsetHeight - 8)) + "px";
  }

  function showReference(anchor) {
    if (anchor === referenceAnchor) { clearTimeout(hideReferenceTimer); return; }
    let url;
    try { url = new URL(anchor.href); } catch { return; }
    if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search || !url.hash) return;
    let id;
    try { id = decodeURIComponent(url.hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    if (!target?.matches('li[id^="cite_note"], .reference-text, .mw-reference-text')) return;
    const text = (target.querySelector(".reference-text, .mw-reference-text") ?? target).textContent.trim();
    if (!text) return;
    closeReference();
    referenceAnchor = anchor;
    reference = document.createElement("aside");
    reference.className = prefix + "reference";
    reference.setAttribute("role", "note");
    reference.setAttribute("aria-label", msg("wikipediaReference"));
    // サイト由来の HTML は挿入せず、現在文書内のテキストだけを表示する。
    reference.textContent = text.slice(0, 1800);
    reference.addEventListener("pointerenter", () => clearTimeout(hideReferenceTimer));
    reference.addEventListener("pointerleave", closeReference);
    document.body.append(reference);
    positionReference();
  }

  function onReferenceEnter(event) {
    if (!checkContext() || !features.linkPreview) return;
    const anchor = event.target.closest?.("#mw-content-text a[href]");
    if (anchor) showReference(anchor);
  }

  function onReferenceLeave(event) {
    if (!reference || event.target.closest?.("a") !== referenceAnchor) return;
    hideReferenceTimer = setTimeout(closeReference, 180);
  }

  function onImageClick(event) {
    if (!checkContext() || !features.imageViewer || event.defaultPrevented || event.button !== 0
      || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest?.('#mw-content-text a.mw-file-description, #mw-content-text a.image');
    const source = anchor?.querySelector("img");
    if (!source || source.closest(".noviewer") || source.naturalWidth < 80 || source.naturalHeight < 50) return;
    if (openImage(source, anchor)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }

  function openImage(source, opener) {
    const image = makeImageCanvas(source, 4096);
    if (!image) return false;
    closeImage();
    imageOpener = opener;
    imageDialog = document.createElement("dialog");
    imageDialog.className = prefix + "image-dialog";
    imageDialog.setAttribute("aria-label", msg("wikipediaImage"));
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = msg("wikipediaClose");
    close.addEventListener("click", closeImage);
    const caption = document.createElement("p");
    caption.textContent = imageCaption(source);
    imageDialog.append(close, image, caption);
    imageDialog.addEventListener("cancel", (ev) => { ev.preventDefault(); closeImage(); });
    imageDialog.addEventListener("click", (ev) => { if (ev.target === imageDialog) closeImage(); });
    document.body.append(imageDialog);
    imageDialog.showModal();
    close.focus();
    return true;
  }

  function onLanguageFallback(event) {
    if (!document.body.classList.contains("mw-interlanguage-selector-disabled") || !event.target.closest?.("#p-lang-btn-sticky-header")) return;
    const checkbox = document.getElementById("p-lang-btn-checkbox");
    if (!checkbox || checkbox.disabled) return;
    // 固定ヘッダー側は一覧を持たないため、同じ標準メニューへ案内する。
    event.preventDefault();
    event.stopPropagation();
    const menu = checkbox.closest("#p-lang-btn");
    const headerHeight = document.getElementById("vector-sticky-header")?.getBoundingClientRect().height || 0;
    window.scrollTo({ top: window.scrollY + menu.getBoundingClientRect().top - headerHeight - 16, behavior: "instant" });
    checkbox.focus({ preventScroll: true });
    if (!checkbox.checked) checkbox.click();
  }

  function checkContext() {
    if (!chrome.runtime?.id) { enabled = false; runner.stop(); cleanup(); return false; }
    const viewing = isArticle();
    if (!viewing) { cleanup(); return false; }
    return enabled;
  }

  function render() {
    if (!checkContext()) return;
    if (!listeners) {
      listeners = new AbortController();
      const signal = listeners.signal;
      document.addEventListener("click", onImageClick, { capture: true, signal });
      document.addEventListener("click", onLanguageFallback, { capture: true, signal });
      document.addEventListener("pointerover", onReferenceEnter, { signal });
      document.addEventListener("focusin", onReferenceEnter, { signal });
      document.addEventListener("pointerout", onReferenceLeave, { signal });
      document.addEventListener("focusout", onReferenceLeave, { signal });
      document.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape") return;
        closeReference();
        const checkbox = document.getElementById("p-lang-btn-checkbox");
        if (document.body.classList.contains("mw-interlanguage-selector-disabled") && checkbox?.checked) {
          checkbox.click();
          checkbox.focus({ preventScroll: true });
          ev.preventDefault();
        }
      }, { signal });
      window.addEventListener("scroll", () => { closeReference(); scheduleContentsPosition(); }, { passive: true, signal });
      window.addEventListener("resize", () => { positionReference(); scheduleContentsPosition(true); scheduleFactsOverflow(); }, { signal });
      window.addEventListener("hashchange", revealHashTarget, { signal });
      window.addEventListener("beforeprint", () => {
        if (modern?.facts) { modern.printFactsOpen = modern.facts.open; modern.facts.open = true; }
      }, { signal });
      window.addEventListener("afterprint", () => {
        if (modern?.facts && typeof modern.printFactsOpen === "boolean") modern.facts.open = modern.printFactsOpen;
      }, { signal });
      // 画面幅の境界を跨いだら、目次と基本情報を「その幅の既定の開閉」へ合わせる。
      // 基本情報は利用者が自分で開閉した後は触らない。境界は新レイアウト（WIDE_LAYOUT）と従来の浮動目次（FLOATING_CONTENTS）で別。
      for (const query of [WIDE_LAYOUT, FLOATING_CONTENTS]) {
        matchMedia(query).addEventListener("change", () => {
          // 目次は、そのレイアウトの境界を跨いだときだけ既定へ戻す（もう一方の境界では利用者の開閉を保つ）。
          if (contents && query === (modern ? WIDE_LAYOUT : FLOATING_CONTENTS)) contents.open = contentsOpenByDefault();
          if (modern?.facts && !modern.factsTouched && query === WIDE_LAYOUT) modern.facts.open = matchMedia(WIDE_LAYOUT).matches;
        }, { signal });
      }
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (appearance.theme === "auto") runner.scheduleRender();
      }, { signal });
    }
    const root = document.documentElement;
    root.classList.add(prefix + "active");
    root.classList.toggle(prefix + "readable", features.readableLayout);
    root.classList.toggle(prefix + "previews", features.linkPreview);
    root.classList.toggle(prefix + "hide-appearance", features.hideAppearance);
    root.classList.toggle(prefix + "narrow", features.narrowContent);
    root.classList.toggle(prefix + "dark", ["dark", "grey", "deep-ocean", "nature", "one-dark", "dracula", "nord", "monokai", "solarized-dark", "github-dark"].includes(appearance.theme)
      || (appearance.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches));
    for (const [key, attribute] of Object.entries(appearanceAttributes)) root.setAttribute(attribute, appearance[key]);
    if (!appearanceStyle?.isConnected) {
      appearanceStyle = document.createElement("style");
      document.head.append(appearanceStyle);
    }
    const font = WikipediaReader.FONTS.find(({ key }) => key === appearance.font);
    const headingFont = WikipediaReader.FONTS.find(({ key }) => key === appearance.headingFont);
    const selectedFonts = [...new Set([font, headingFont].filter(Boolean))];
    // 選択された書体だけを宣言し、ブラウザが必要なウェイトを遅延読込する。
    // src は固定の同梱ファイルだけに限定し、サイトや設定由来の URL を受け取らない。
    const faces = selectedFonts.flatMap(selected => [[400, selected.regular], [700, selected.bold]].map(([weight, file]) =>
      `@font-face { font-family: "${prefix}${selected.key}"; src: url("${chrome.runtime.getURL("src/fonts/wikipedia/" + file)}") format("woff2"); font-weight: ${weight}; font-display: swap; }`
    )).join("\n");
    const css = `${faces}\n:root.${prefix}active { --cpa-wiki-size: ${appearance.fontSize}px; --cpa-wiki-width: ${appearance.contentWidth}px; --cpa-wiki-line-height: ${appearance.lineHeight}; ${font ? `--cpa-wiki-font: "${prefix}${font.key}", system-ui, sans-serif;` : ""} ${headingFont ? `--cpa-wiki-heading-font: "${prefix}${headingFont.key}", system-ui, sans-serif;` : ""} }`;
    if (appearanceStyle.textContent !== css) appearanceStyle.textContent = css;
    if (features.readableLayout) buildModernLayout(); else restoreModernLayout();
    if (features.stickyContents) buildContents(); else removeContents();
    if (modern) {
      if (contents && contents.parentNode !== modern.rail) modern.rail.append(contents);
      const pinned = !!modern.rail.querySelector("#vector-main-menu-pinned-container > *");
      if (modern.siteMenu && (modern.menuPinned !== pinned || modern.hasContents !== !!contents)) modern.siteMenu.open = pinned || !contents;
      modern.menuPinned = pinned; modern.hasContents = !!contents;
    }
    if (!features.linkPreview) closeReference();
    if (modern) { syncFactsOverflow(); scheduleFactsOverflow(); }
    scheduleContentsPosition();
    if (!features.imageViewer || appearance.articleStyle === "text") closeImage();
  }

  const runner = ScanRunner.create({
    render, cleanup,
    observeTarget: () => document.documentElement,
    observeOptions: { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] },
  });
  CleanerCore.subscribeStored({
    keys,
    applyAction: Actions.APPLY_WIKIPEDIA_CS,
    onStored(stored) {
      enabled = stored[StorageKeys.WIKIPEDIA_ENABLED] === true;
      features = WikipediaReader.mergeFeatures(stored[StorageKeys.WIKIPEDIA_FEATURES]);
      appearance = WikipediaReader.normalizeAppearance(stored[StorageKeys.WIKIPEDIA_APPEARANCE]);
      if (enabled) { runner.start(); runner.scheduleRender(); } else { runner.stop(); cleanup(); }
    },
  });
  window.addEventListener("popstate", () => { if (enabled) runner.scheduleRender(); });
  window.addEventListener("pagehide", (event) => { if (!event.persisted) runner.stop(); });
})();
