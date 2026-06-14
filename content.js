(function () {
  const DEFAULT_PERCENT = 72;
  const MIN_PERCENT = 45;
  const MAX_PERCENT = 96;
  const STORAGE_KEY = "chatgptContentWidthPercent";
  const COLLAPSED_KEY = "chatgptWidthSliderCollapsed";
  const PANEL_POSITION_KEY = "chatgptEnhancerPanelPosition";
  const PANEL_MARGIN = 12;
  const FORMULA_SELECTOR = ".katex-display, .katex, .MathJax, mjx-container, [data-latex]";

  let widthPercent = DEFAULT_PERCENT;
  let collapsed = false;
  let panelPosition = null;
  let observer = null;
  let refreshTimer = null;

  const storage = chrome.storage && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;

  function clamp(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_PERCENT;
    return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(number)));
  }

  function setRootWidth(value) {
    widthPercent = clamp(value);
    document.documentElement.dataset.cgptWidthEnabled = "true";
    document.documentElement.style.setProperty("--cgpt-width", `${widthPercent}vw`);
    document.documentElement.style.setProperty("--thread-content-max-width", `${widthPercent}vw`);
    updatePanelValue();
    scheduleRefresh();
  }

  function saveWidth(value) {
    setRootWidth(value);
    storage.set({ [STORAGE_KEY]: widthPercent });
  }

  function clampPanelPosition(left, top, panel) {
    const width = panel.offsetWidth || 320;
    const height = panel.offsetHeight || 72;
    const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN);
    return {
      left: Math.min(maxLeft, Math.max(PANEL_MARGIN, Math.round(left))),
      top: Math.min(maxTop, Math.max(PANEL_MARGIN, Math.round(top)))
    };
  }

  function applyPanelPosition(panel, position) {
    const nextPosition = position || {
      left: window.innerWidth - panel.offsetWidth - 20,
      top: window.innerHeight - panel.offsetHeight - 92
    };
    panelPosition = clampPanelPosition(nextPosition.left, nextPosition.top, panel);
    panel.style.left = `${panelPosition.left}px`;
    panel.style.top = `${panelPosition.top}px`;
  }

  function repositionAfterPanelSizeChange(panel, previousRect) {
    const shouldAnchorRight = previousRect.left + previousRect.width / 2 > window.innerWidth / 2;
    const right = window.innerWidth - previousRect.right;
    const nextLeft = shouldAnchorRight ? window.innerWidth - right - panel.offsetWidth : previousRect.left;
    const next = clampPanelPosition(nextLeft, previousRect.top, panel);
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
    panelPosition = next;
    storage.set({ [PANEL_POSITION_KEY]: panelPosition });
  }

  function savePanelPosition(panel) {
    panelPosition = clampPanelPosition(panel.offsetLeft, panel.offsetTop, panel);
    panel.style.left = `${panelPosition.left}px`;
    panel.style.top = `${panelPosition.top}px`;
    storage.set({ [PANEL_POSITION_KEY]: panelPosition });
  }

  function updatePanelValue() {
    const range = document.getElementById("cgpt-width-range");
    const value = document.querySelector(".cgpt-width-value");
    if (range) range.value = String(widthPercent);
    if (value) value.textContent = `${widthPercent}%`;
  }

  function isChatSurfaceElement(element) {
    const main = element.closest("main");
    if (!main) return false;
    if (element.closest("nav, aside, header, [role='navigation']")) return false;
    return true;
  }

  function shouldWiden(element) {
    if (!(element instanceof HTMLElement) || !isChatSurfaceElement(element)) return false;
    const className = typeof element.className === "string" ? element.className : "";
    const inlineMaxWidth = element.style && element.style.maxWidth;
    return (
      /\bmax-w-(2xl|3xl|4xl|5xl|6xl|7xl)\b/.test(className) ||
      className.includes("max-w-[") ||
      inlineMaxWidth.includes("rem") ||
      inlineMaxWidth.includes("px")
    );
  }

  function widenElement(element) {
    element.style.setProperty("max-width", `min(${widthPercent}vw, calc(100vw - 32px))`, "important");
  }

  function refreshChatWidths() {
    const main = document.querySelector("main");
    if (!main) return;

    const candidates = new Set();
    for (const selector of [
        ".max-w-2xl",
        ".max-w-3xl",
        ".max-w-4xl",
        ".max-w-5xl",
        ".max-w-6xl",
        ".max-w-7xl",
        "[class]",
        "[data-testid^='conversation-turn']",
        "[data-message-author-role]"
      ]) {
      for (const element of main.querySelectorAll(selector)) {
        candidates.add(element);
      }
    }

    for (const element of candidates) {
      if (shouldWiden(element)) widenElement(element);
      if (element instanceof HTMLElement) {
        element.style.setProperty("--thread-content-max-width", `${widthPercent}vw`, "important");
      }
    }
  }

  function getLatexFromFormula(formula) {
    const annotation = formula.querySelector("annotation[encoding='application/x-tex']");
    const rawLatex =
      (formula instanceof HTMLElement ? formula.dataset.latex : "") ||
      (annotation && annotation.textContent) ||
      formula.getAttribute("data-latex") ||
      (formula.matches(".MathJax, mjx-container") ? formula.getAttribute("aria-label") : "");

    if (!rawLatex || !rawLatex.trim()) return null;

    const block = Boolean(
      formula.closest(".katex-display, mjx-container[display='true'], .MathJax_Display") ||
      formula.getAttribute("display") === "true"
    );

    return {
      element: formula,
      text: wrapLatex(rawLatex.trim(), block)
    };
  }

  function resolveFormulaElement(node) {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return null;
    return (
      element.closest(".katex") ||
      element.closest(".katex-display") ||
      element.closest(".MathJax") ||
      element.closest("mjx-container") ||
      element.closest("[data-latex]")
    );
  }

  function getLatexFromElement(element) {
    if (!(element instanceof Element)) return null;
    const formula = resolveFormulaElement(element);
    return formula ? getLatexFromFormula(formula) : null;
  }

  function stripLatexWrapper(text) {
    const trimmed = text.trim();
    const pairs = [
      ["$$", "$$"],
      ["$", "$"],
      ["\\[", "\\]"],
      ["\\(", "\\)"]
    ];

    for (const [start, end] of pairs) {
      if (trimmed.startsWith(start) && trimmed.endsWith(end) && trimmed.length > start.length + end.length) {
        return trimmed.slice(start.length, trimmed.length - end.length).trim();
      }
    }

    return trimmed;
  }

  function wrapLatex(text, block) {
    const latex = stripLatexWrapper(text);
    return block ? `$$${latex}$$` : `$${latex}$`;
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function showCopyFeedback(element, ok) {
    element.classList.add(ok ? "cgpt-latex-copy-ok" : "cgpt-latex-copy-fail");
    window.setTimeout(() => {
      element.classList.remove("cgpt-latex-copy-ok", "cgpt-latex-copy-fail");
    }, 900);

    const toast = document.createElement("div");
    toast.className = `cgpt-copy-toast ${ok ? "is-ok" : "is-fail"}`;
    toast.textContent = ok ? "LaTeX 已复制" : "复制失败";
    document.documentElement.appendChild(toast);
    window.setTimeout(() => toast.remove(), 1100);
  }

  function refreshLatexTargets() {
    for (const element of document.querySelectorAll(".cgpt-latex-copy-target")) {
      element.classList.remove("cgpt-latex-copy-target");
      element.removeAttribute("title");
    }

    const formulas = document.querySelectorAll(".katex, .MathJax, mjx-container, [data-latex]");
    for (const formula of formulas) {
      if (!(formula instanceof HTMLElement)) continue;
      if (!isChatSurfaceElement(formula)) continue;
      if (!getLatexFromElement(formula)) continue;
      formula.classList.add("cgpt-latex-copy-target");
      formula.title = "点击复制完整 LaTeX";
    }
  }

  function normalizeCopiedText(text) {
    return text
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function nodeIntersectsRange(node, range) {
    try {
      return range.intersectsNode(node);
    } catch (error) {
      return false;
    }
  }

  function nodeContainsRangeBoundary(node, range) {
    return (
      node === range.startContainer ||
      node === range.endContainer ||
      node.contains(range.startContainer) ||
      node.contains(range.endContainer)
    );
  }

  function formulaTouchesRange(formula, range) {
    return Boolean(formula && (nodeIntersectsRange(formula, range) || nodeContainsRangeBoundary(formula, range)));
  }

  function getClosestFormula(node) {
    return resolveFormulaElement(node);
  }

  function formatFormulaForSelection(latex) {
    return latex.text.startsWith("$$") ? `\n${latex.text}\n` : latex.text;
  }

  function serializeFormulaOnce(formula, range, state) {
    if (!formula || !formulaTouchesRange(formula, range)) return null;
    if (state.seenFormulas.has(formula)) return "";

    const latex = getLatexFromFormula(formula);
    if (!latex) return null;

    state.seenFormulas.add(formula);
    state.hasFormula = true;
    return formatFormulaForSelection(latex);
  }

  function getSelectedTextFromTextNode(node, range) {
    if (!nodeIntersectsRange(node, range)) return "";

    let start = 0;
    let end = node.nodeValue.length;

    if (range.startContainer === node) {
      start = range.startOffset;
    }

    if (range.endContainer === node) {
      end = range.endOffset;
    }

    return node.nodeValue.slice(start, end);
  }

  function isBlockElement(element) {
    return [
      "ARTICLE",
      "BLOCKQUOTE",
      "DIV",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "LI",
      "OL",
      "P",
      "PRE",
      "TABLE",
      "TR",
      "UL"
    ].includes(element.tagName);
  }

  function serializeRangeNode(node, range, state) {
    if (!nodeIntersectsRange(node, range)) return "";

    const formulaText = serializeFormulaOnce(resolveFormulaElement(node), range, state);
    if (formulaText !== null) return formulaText;

    if (node.nodeType === Node.TEXT_NODE) {
      return getSelectedTextFromTextNode(node, range);
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    if (element.tagName === "BR") {
      return "\n";
    }

    let text = "";
    for (const child of element.childNodes) {
      text += serializeRangeNode(child, range, state);
    }

    if (text.trim() && isBlockElement(element) && !text.endsWith("\n")) {
      text += "\n";
    }

    return text;
  }

  function serializeRangeWithLatex(range, state) {
    const commonFormula = getClosestFormula(range.commonAncestorContainer);
    const formulaText = serializeFormulaOnce(commonFormula, range, state);
    if (formulaText !== null) return formulaText;

    const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

    return root ? serializeRangeNode(root, range, state) : "";
  }

  function getSelectionTextWithLatex(selection) {
    const state = {
      hasFormula: false,
      seenFormulas: new Set()
    };
    let text = "";

    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      text += serializeRangeWithLatex(range, state);
      if (index < selection.rangeCount - 1) {
        text += "\n";
      }
    }

    if (!state.hasFormula) return null;
    return normalizeCopiedText(text);
  }

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshChatWidths();
      refreshLatexTargets();
    }, 80);
  }

  function createPanel() {
    if (document.getElementById("cgpt-width-slider-panel")) return;

    const panel = document.createElement("div");
    panel.id = "cgpt-width-slider-panel";
    panel.dataset.collapsed = String(collapsed);
    panel.innerHTML = `
      <button type="button" class="cgpt-panel-handle" title="拖动面板；点击收起或展开" aria-label="拖动面板；点击收起或展开">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 19L16.5 7.5" />
          <path d="M14.5 5.5l4 4" />
          <path d="M7 4.5v3M5.5 6h3" />
          <path d="M18 15.5v3M16.5 17h3" />
          <path d="M11 3.5l.7 1.4 1.3.6-1.3.6-.7 1.4-.7-1.4L9 5.5l1.3-.6.7-1.4z" />
        </svg>
      </button>
      <div class="cgpt-width-body">
        <div class="cgpt-width-label">
          <span>内容宽度</span>
          <span class="cgpt-width-value">${widthPercent}%</span>
        </div>
        <input id="cgpt-width-range" type="range" min="${MIN_PERCENT}" max="${MAX_PERCENT}" value="${widthPercent}" aria-label="ChatGPT 内容宽度百分比">
      </div>
    `;

    const handle = panel.querySelector(".cgpt-panel-handle");
    let drag = null;

    handle.addEventListener("pointerdown", (event) => {
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: panel.offsetLeft,
        top: panel.offsetTop,
        moved: false
      };
      handle.setPointerCapture(event.pointerId);
      panel.dataset.dragging = "true";
    });

    handle.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      const next = clampPanelPosition(drag.left + dx, drag.top + dy, panel);
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
    });

    handle.addEventListener("pointerup", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      handle.releasePointerCapture(event.pointerId);
      panel.dataset.dragging = "false";
      if (drag.moved) {
        savePanelPosition(panel);
      } else {
        const previousRect = panel.getBoundingClientRect();
        collapsed = !collapsed;
        panel.dataset.collapsed = String(collapsed);
        storage.set({ [COLLAPSED_KEY]: collapsed });
        window.requestAnimationFrame(() => repositionAfterPanelSizeChange(panel, previousRect));
      }
      drag = null;
    });

    handle.addEventListener("pointercancel", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      panel.dataset.dragging = "false";
      drag = null;
    });

    panel.querySelector("#cgpt-width-range").addEventListener("input", (event) => {
      saveWidth(event.target.value);
    });

    document.documentElement.appendChild(panel);
    window.requestAnimationFrame(() => applyPanelPosition(panel, panelPosition));
    window.addEventListener("resize", () => applyPanelPosition(panel, panelPosition));
  }

  function observePage() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    storage.get(
      {
        [STORAGE_KEY]: DEFAULT_PERCENT,
        [COLLAPSED_KEY]: false,
        [PANEL_POSITION_KEY]: null
      },
      (items) => {
        collapsed = Boolean(items[COLLAPSED_KEY]);
        panelPosition = items[PANEL_POSITION_KEY];
        setRootWidth(items[STORAGE_KEY]);
        createPanel();
        observePage();
        refreshChatWidths();
        refreshLatexTargets();
      }
    );
  }

  document.addEventListener("click", async (event) => {
    const latex = getLatexFromElement(event.target);
    if (!latex) return;

    event.preventDefault();
    event.stopPropagation();

    try {
      await copyText(latex.text);
      showCopyFeedback(latex.element, true);
    } catch (error) {
      showCopyFeedback(latex.element, false);
    }
  }, true);

  function handleCopyWithLatex(event) {
    if (event.defaultPrevented) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;

    const copiedText = getSelectionTextWithLatex(selection);
    if (!copiedText) return;

    event.preventDefault();
    event.stopPropagation();
    event.clipboardData.setData("text/plain", copiedText);
  }

  window.addEventListener("copy", handleCopyWithLatex, true);
  document.addEventListener("copy", handleCopyWithLatex, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "CGPT_SET_WIDTH") return;
    saveWidth(message.value);
  });

  init();
})();
