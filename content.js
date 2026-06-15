(function () {
  const DEFAULT_PERCENT = 72;
  const MIN_PERCENT = 45;
  const MAX_PERCENT = 96;
  const STORAGE_KEY = "chatgptContentWidthPercent";
  const COLLAPSED_KEY = "chatgptWidthSliderCollapsed";
  const PANEL_POSITION_KEY = "chatgptEnhancerPanelPosition";
  const PANEL_MARGIN = 12;
  const FORMULA_SELECTOR = ".katex-display, .katex, .MathJax, mjx-container, [data-latex]";
  const USER_MESSAGE_SELECTOR = "[data-message-author-role='user']";
  const MAX_MARKDOWN_SOURCE_LENGTH = 20000;

  let widthPercent = DEFAULT_PERCENT;
  let collapsed = false;
  let panelPosition = null;
  let observer = null;
  let refreshTimer = null;
  let widthStorageTimer = null;
  let pendingFullRefresh = false;
  const dirtyRefreshRoots = new Set();

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
  }

  function persistWidthSoon() {
    window.clearTimeout(widthStorageTimer);
    widthStorageTimer = window.setTimeout(() => {
      storage.set({ [STORAGE_KEY]: widthPercent });
    }, 180);
  }

  function persistWidthNow() {
    window.clearTimeout(widthStorageTimer);
    storage.set({ [STORAGE_KEY]: widthPercent });
  }

  function saveWidth(value) {
    setRootWidth(value);
    persistWidthSoon();
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
      /\bmax-w-/.test(className) ||
      inlineMaxWidth.includes("rem") ||
      inlineMaxWidth.includes("px")
    );
  }

  function widenElement(element) {
    element.style.setProperty("max-width", "min(var(--cgpt-width), calc(100vw - 32px))", "important");
  }

  function normalizeRefreshRoots(roots) {
    if (!roots) {
      const main = document.querySelector("main");
      return main ? [main] : [];
    }
    const list = Array.isArray(roots) ? roots : [roots];
    return list.filter((root) => root && (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE));
  }

  function collectScopedElements(roots, selector) {
    const candidates = new Set();
    for (const root of normalizeRefreshRoots(roots)) {
      if (root instanceof Element && root.matches(selector)) {
        candidates.add(root);
      }
      for (const element of root.querySelectorAll(selector)) {
        candidates.add(element);
      }
    }
    return candidates;
  }

  function refreshChatWidths(roots) {
    const candidates = new Set();
    for (const selector of [
        ".max-w-2xl",
        ".max-w-3xl",
        ".max-w-4xl",
        ".max-w-5xl",
        ".max-w-6xl",
        ".max-w-7xl",
        "[class*='max-w-']",
        "[style*='max-width']",
        "[data-testid^='conversation-turn']",
        "[data-message-author-role]"
      ]) {
      for (const element of collectScopedElements(roots, selector)) {
        candidates.add(element);
      }
    }

    for (const element of candidates) {
      if (shouldWiden(element)) widenElement(element);
      if (element instanceof HTMLElement) {
        element.style.setProperty("--thread-content-max-width", "min(var(--cgpt-width), calc(100vw - 32px))", "important");
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
      formula.closest(".cgpt-user-math.is-block") ||
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

  function refreshLatexTargets(roots) {
    for (const formula of collectScopedElements(roots, ".katex, .MathJax, mjx-container, [data-latex]")) {
      if (!(formula instanceof HTMLElement)) continue;
      if (!isChatSurfaceElement(formula)) continue;
      if (formula.classList.contains("cgpt-latex-copy-target")) continue;
      if (!getLatexFromFormula(formula)) continue;
      formula.classList.add("cgpt-latex-copy-target");
      formula.title = "点击复制完整 LaTeX";
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getSafeHref(url) {
    const value = url.trim();
    if (/^(https?:|mailto:|#|\/)/i.test(value)) return value;
    return "";
  }

  function renderInlineStyles(text) {
    return escapeHtml(text)
      .replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>")
      .replace(/(^|[^\*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  }

  function mathMlElement(tag, content) {
    return `<${tag}>${content}</${tag}>`;
  }

  function readLatexGroup(text, index) {
    if (text[index] !== "{") return null;
    let depth = 0;
    for (let cursor = index; cursor < text.length; cursor += 1) {
      if (text[cursor] === "{") depth += 1;
      if (text[cursor] === "}") depth -= 1;
      if (depth === 0) {
        return {
          value: text.slice(index + 1, cursor),
          next: cursor + 1
        };
      }
    }
    return null;
  }

  function commandToMathMl(command) {
    const greek = {
      alpha: "α",
      beta: "β",
      gamma: "γ",
      delta: "δ",
      epsilon: "ϵ",
      theta: "θ",
      lambda: "λ",
      mu: "μ",
      pi: "π",
      rho: "ρ",
      sigma: "σ",
      tau: "τ",
      phi: "φ",
      omega: "ω",
      Delta: "Δ",
      Gamma: "Γ",
      Lambda: "Λ",
      Omega: "Ω",
      Phi: "Φ",
      Pi: "Π",
      Sigma: "Σ",
      Theta: "Θ"
    };
    const operators = {
      cdot: "·",
      times: "×",
      div: "÷",
      le: "≤",
      leq: "≤",
      ge: "≥",
      geq: "≥",
      neq: "≠",
      approx: "≈",
      infty: "∞",
      pm: "±",
      to: "→",
      rightarrow: "→",
      leftarrow: "←"
    };

    if (["left", "right", "big", "Big", "bigl", "bigr", "Bigl", "Bigr"].includes(command)) return "";
    if (greek[command]) return mathMlElement("mi", greek[command]);
    if (operators[command]) return mathMlElement("mo", operators[command]);
    return mathMlElement("mi", escapeHtml(command));
  }

  function parseLatexAtom(text, index) {
    if (index >= text.length) return { html: "", next: index };
    const char = text[index];

    if (char === "{") {
      const group = readLatexGroup(text, index);
      if (!group) return { html: mathMlElement("mo", "{"), next: index + 1 };
      return {
        html: parseLatexToMathMl(group.value),
        next: group.next
      };
    }

    if (char === "\\") {
      const commandMatch = text.slice(index + 1).match(/^[A-Za-z]+/);
      if (!commandMatch) {
        return { html: mathMlElement("mo", escapeHtml(text[index + 1] || "\\")), next: index + 2 };
      }

      const command = commandMatch[0];
      let next = index + command.length + 1;

      if (command === "frac") {
        const numerator = readLatexGroup(text, next);
        const denominator = numerator ? readLatexGroup(text, numerator.next) : null;
        if (numerator && denominator) {
          return {
            html: `<mfrac>${parseLatexToMathMl(numerator.value)}${parseLatexToMathMl(denominator.value)}</mfrac>`,
            next: denominator.next
          };
        }
      }

      if (command === "sqrt") {
        const radicand = readLatexGroup(text, next);
        if (radicand) {
          return {
            html: `<msqrt>${parseLatexToMathMl(radicand.value)}</msqrt>`,
            next: radicand.next
          };
        }
      }

      return {
        html: commandToMathMl(command),
        next
      };
    }

    if (/[A-Za-z]/.test(char)) return { html: mathMlElement("mi", escapeHtml(char)), next: index + 1 };
    if (/[0-9]/.test(char)) return { html: mathMlElement("mn", escapeHtml(char)), next: index + 1 };
    if (/\s/.test(char)) return { html: "", next: index + 1 };
    return { html: mathMlElement("mo", escapeHtml(char)), next: index + 1 };
  }

  function parseLatexToMathMl(text) {
    const nodes = [];
    let index = 0;

    while (index < text.length) {
      let atom = parseLatexAtom(text, index);
      index = atom.next;

      if (text[index] === "_" || text[index] === "^") {
        const firstOperator = text[index];
        const firstScript = parseLatexAtom(text, index + 1);
        index = firstScript.next;

        if (text[index] === "_" || text[index] === "^") {
          const secondOperator = text[index];
          const secondScript = parseLatexAtom(text, index + 1);
          index = secondScript.next;

          const sub = firstOperator === "_" ? firstScript.html : secondScript.html;
          const sup = firstOperator === "^" ? firstScript.html : secondScript.html;
          atom = {
            html: `<msubsup>${atom.html}${sub}${sup}</msubsup>`,
            next: index
          };
        } else {
          atom = {
            html: firstOperator === "_" ? `<msub>${atom.html}${firstScript.html}</msub>` : `<msup>${atom.html}${firstScript.html}</msup>`,
            next: index
          };
        }
      }

      nodes.push(atom.html);
    }

    return nodes.join("");
  }

  function renderLatexMath(latex, block) {
    const cleanLatex = stripLatexWrapper(latex);
    const wrappedLatex = wrapLatex(cleanLatex, block);
    const tag = block ? "div" : "span";
    const math = `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${block ? "block" : "inline"}">${parseLatexToMathMl(cleanLatex)}</math>`;
    return `<${tag} class="cgpt-user-math ${block ? "is-block" : "is-inline"}" data-latex="${escapeHtml(wrappedLatex)}">${math}</${tag}>`;
  }

  function renderInlineMathAndStyles(text) {
    const parts = [];
    let cursor = 0;
    const mathPattern = /(^|[^\\])\$([^$\n]+?)\$/g;
    let mathMatch;

    while ((mathMatch = mathPattern.exec(text))) {
      const start = mathMatch.index + mathMatch[1].length;
      if (start > cursor) {
        parts.push(renderInlineStyles(text.slice(cursor, start)));
      }
      parts.push(renderLatexMath(mathMatch[2], false));
      cursor = mathPattern.lastIndex;
    }

    if (cursor < text.length) {
      parts.push(renderInlineStyles(text.slice(cursor)));
    }

    return parts.join("");
  }

  function renderInlineMarkdown(text) {
    const parts = [];
    let cursor = 0;
    const codePattern = /(`+)([\s\S]*?)\1/g;
    let codeMatch;

    while ((codeMatch = codePattern.exec(text))) {
      if (codeMatch.index > cursor) {
        parts.push(renderInlineMarkdownWithoutCode(text.slice(cursor, codeMatch.index)));
      }
      parts.push(`<code>${escapeHtml(codeMatch[2])}</code>`);
      cursor = codePattern.lastIndex;
    }

    if (cursor < text.length) {
      parts.push(renderInlineMarkdownWithoutCode(text.slice(cursor)));
    }

    return parts.join("");
  }

  function renderInlineMarkdownWithoutCode(text) {
    const parts = [];
    let cursor = 0;
    const linkPattern = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let linkMatch;

    while ((linkMatch = linkPattern.exec(text))) {
      if (linkMatch.index > cursor) {
        parts.push(renderInlineMathAndStyles(text.slice(cursor, linkMatch.index)));
      }

      const href = getSafeHref(linkMatch[2]);
      const label = renderInlineMathAndStyles(linkMatch[1]);
      parts.push(href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label);
      cursor = linkPattern.lastIndex;
    }

    if (cursor < text.length) {
      parts.push(renderInlineMathAndStyles(text.slice(cursor)));
    }

    return parts.join("");
  }

  function isMarkdownBlockStart(line) {
    return (
      /^```/.test(line) ||
      /^\$\$/.test(line) ||
      /^#{1,6}\s+/.test(line) ||
      /^>\s?/.test(line) ||
      /^\s*[-*+]\s+/.test(line) ||
      /^\s*\d+[.)]\s+/.test(line)
    );
  }

  function renderList(lines, index, ordered) {
    const items = [];
    const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;

    while (index < lines.length) {
      const match = lines[index].match(pattern);
      if (!match) break;
      items.push(`<li>${renderInlineMarkdown(match[1])}</li>`);
      index += 1;
    }

    return {
      html: `<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`,
      index
    };
  }

  function renderMarkdown(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let index = 0;
    let guard = 0;

    while (index < lines.length && guard < lines.length + 100) {
      guard += 1;
      const line = lines[index];

      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^```\s*([A-Za-z0-9_-]+)?\s*$/);
      if (fence) {
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^```\s*$/.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const language = fence[1] ? ` data-language="${escapeHtml(fence[1])}"` : "";
        blocks.push(`<pre${language}><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        continue;
      }

      if (/^\$\$/.test(line)) {
        const sameLineMath = line.match(/^\$\$\s*([\s\S]*?)\s*\$\$$/);
        if (sameLineMath) {
          blocks.push(renderLatexMath(sameLineMath[1], true));
          index += 1;
          continue;
        }

        if (/^\$\$\s*$/.test(line)) {
          const mathLines = [];
          index += 1;
          while (index < lines.length && !/^\s*\$\$\s*$/.test(lines[index])) {
            mathLines.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) index += 1;
          blocks.push(renderLatexMath(mathLines.join("\n"), true));
          continue;
        }

        blocks.push(`<p>${renderInlineMarkdown(line)}</p>`);
        index += 1;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quoteLines = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^>\s?/, ""));
          index += 1;
        }
        blocks.push(`<blockquote>${renderMarkdown(quoteLines.join("\n"))}</blockquote>`);
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const result = renderList(lines, index, false);
        blocks.push(result.html);
        index = result.index;
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        const result = renderList(lines, index, true);
        blocks.push(result.html);
        index = result.index;
        continue;
      }

      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
        paragraph.push(lines[index]);
        index += 1;
      }
      if (!paragraph.length) {
        blocks.push(`<p>${renderInlineMarkdown(line)}</p>`);
        index += 1;
        continue;
      }
      blocks.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    }

    return blocks.join("");
  }

  function looksLikeTextMessageTarget(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.closest("textarea, input, [contenteditable='true']")) return false;
    if (element.querySelector("button, textarea, input, select, img, video, canvas, table")) return false;
    if (element.matches("pre, code") || element.closest("pre, code")) return false;

    const text = element.textContent || "";
    if (!text.trim()) return false;

    const elementChildren = Array.from(element.children).filter((child) => child.tagName !== "BR");
    if (element.dataset.cgptMarkdownRendered === "true") return true;
    return elementChildren.length <= 1;
  }

  function findUserMessageTextTarget(message) {
    const preferredSelectors = [
      ".whitespace-pre-wrap",
      "[class*='whitespace-pre-wrap']",
      "[class*='break-words']"
    ];

    for (const selector of preferredSelectors) {
      for (const element of message.querySelectorAll(selector)) {
        if (looksLikeTextMessageTarget(element)) return element;
      }
    }

    return looksLikeTextMessageTarget(message) ? message : null;
  }

  function refreshUserMarkdown(roots) {
    for (const message of collectScopedElements(roots, USER_MESSAGE_SELECTOR)) {
      const target = findUserMessageTextTarget(message);
      if (!target) continue;

      const source = target.dataset.cgptMarkdownSource || target.textContent || "";
      if (!source.trim()) continue;
      if (target.dataset.cgptMarkdownRendered === "true" && target.dataset.cgptMarkdownSource === source) continue;
      if (source.length > MAX_MARKDOWN_SOURCE_LENGTH) continue;

      target.dataset.cgptMarkdownSource = source;
      target.dataset.cgptMarkdownRendered = "true";
      target.classList.add("cgpt-user-markdown");
      try {
        target.innerHTML = renderMarkdown(source);
      } catch (error) {
        target.textContent = source;
        target.dataset.cgptMarkdownRendered = "false";
      }
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

  function rangeContainsFormula(range) {
    const commonFormula = getClosestFormula(range.commonAncestorContainer);
    if (formulaTouchesRange(commonFormula, range)) return true;

    const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

    if (!root) return false;
    for (const formula of collectScopedElements(root, FORMULA_SELECTOR)) {
      if (formulaTouchesRange(formula, range)) return true;
    }
    return false;
  }

  function getSelectionTextWithLatex(selection) {
    let hasFormulaRange = false;
    for (let index = 0; index < selection.rangeCount; index += 1) {
      if (rangeContainsFormula(selection.getRangeAt(index))) {
        hasFormulaRange = true;
        break;
      }
    }
    if (!hasFormulaRange) return null;

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

  function isExtensionElement(element) {
    return Boolean(
      element &&
      element.closest &&
      element.closest("#cgpt-width-slider-panel, .cgpt-copy-toast")
    );
  }

  function getRefreshRootFromNode(node) {
    const element = node instanceof Element ? node : node && node.parentElement;
    if (!element || isExtensionElement(element)) return null;
    const main = element.closest("main");
    if (!main) return null;
    return (
      element.closest("[data-message-author-role]") ||
      element.closest("[data-testid^='conversation-turn']") ||
      element.closest("article") ||
      element
    );
  }

  function queueMutationRoots(mutations) {
    for (const mutation of mutations) {
      const targetRoot = getRefreshRootFromNode(mutation.target);
      if (targetRoot) dirtyRefreshRoots.add(targetRoot);

      for (const node of mutation.addedNodes) {
        const root = getRefreshRootFromNode(node);
        if (root) dirtyRefreshRoots.add(root);
      }
    }
  }

  function scheduleRefresh(options = {}) {
    if (options.full) {
      pendingFullRefresh = true;
      dirtyRefreshRoots.clear();
    } else if (options.roots) {
      for (const root of normalizeRefreshRoots(options.roots)) {
        dirtyRefreshRoots.add(root);
      }
    }

    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      const roots = pendingFullRefresh ? null : Array.from(dirtyRefreshRoots);
      pendingFullRefresh = false;
      dirtyRefreshRoots.clear();

      if (roots && !roots.length) return;
      refreshChatWidths(roots);
      refreshUserMarkdown(roots);
      refreshLatexTargets(roots);
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
    panel.querySelector("#cgpt-width-range").addEventListener("change", (event) => {
      setRootWidth(event.target.value);
      persistWidthNow();
    });

    document.documentElement.appendChild(panel);
    window.requestAnimationFrame(() => applyPanelPosition(panel, panelPosition));
    window.addEventListener("resize", () => applyPanelPosition(panel, panelPosition));
  }

  function observePage() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      queueMutationRoots(mutations);
      if (dirtyRefreshRoots.size) scheduleRefresh();
    });
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
        refreshUserMarkdown();
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
    setRootWidth(message.value);
  });

  init();
})();
