(function () {
  const DEFAULT_PERCENT = 72;
  const MIN_PERCENT = 45;
  const MAX_PERCENT = 96;
  const STORAGE_KEY = "chatgptContentWidthPercent";
  const BACKGROUND_KEY = "chatgptPageBackground";
  const DEFAULT_BACKGROUND = "default";
  const BACKGROUNDS = {
    default: "",
    warm: "#fbf7ef",
    mint: "#eef8f2",
    blue: "#eef5ff",
    gray: "#f4f4f5",
    rose: "#fff1f2"
  };
  const CONTENT_SIDE_GAP = 32;
  const FORMULA_SELECTOR = ".katex-display, .katex, .MathJax, mjx-container, [data-latex]";
  const USER_MESSAGE_SELECTOR = "[data-message-author-role='user']";
  const MAX_MARKDOWN_SOURCE_LENGTH = 20000;
  const WIDTH_SELECTOR = [
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
  ].join(",");
  const PAGE_RENDER_REQUEST_EVENT = "CGPT_PAGE_RENDER_LATEX_REQUEST";
  const PAGE_RENDER_RESPONSE_EVENT = "CGPT_PAGE_RENDER_LATEX_RESPONSE";
  const PAGE_RENDER_CAPABILITY_REQUEST_EVENT = "CGPT_PAGE_RENDER_LATEX_CAPABILITY_REQUEST";
  const PAGE_RENDER_CAPABILITY_RESPONSE_EVENT = "CGPT_PAGE_RENDER_LATEX_CAPABILITY_RESPONSE";
  const PAGE_RENDER_PROBE_TIMEOUT_MS = 350;
  const PAGE_RENDER_RETRY_MS = 5000;

  let widthPercent = DEFAULT_PERCENT;
  let backgroundName = DEFAULT_BACKGROUND;
  let latexRenderId = 0;
  let pageRendererProbeId = 0;
  let pageRendererState = "unknown";
  let pageRendererProbeTimer = null;
  let lastPageRendererProbeAt = 0;
  let observer = null;
  let observedRoot = null;
  let refreshTimer = null;
  let resizeFrame = null;
  let pendingFullRefresh = false;
  const dirtyRefreshRoots = new Set();
  const pendingPageRenderElements = new Set();
  const pageRenderElements = new Map();
  const markdownSourceCache = new WeakMap();
  const formulaLatexCache = new WeakMap();

  const storage = chrome.storage && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;

  function clamp(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_PERCENT;
    return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(number)));
  }

  function getReferenceViewportWidth() {
    const widths = [
      window.screen && window.screen.availWidth,
      window.screen && window.screen.width,
      window.outerWidth,
      window.innerWidth
    ].filter((value) => Number.isFinite(value) && value > 0);

    return widths.length ? Math.max(...widths) : window.innerWidth;
  }

  function getContentWidthCssValue(percent) {
    const referenceWidth = getReferenceViewportWidth();
    const desiredWidth = Math.round(referenceWidth * clamp(percent) / 100);
    const availableWidth = Math.max(0, window.innerWidth - CONTENT_SIDE_GAP);

    return desiredWidth <= availableWidth ? `${desiredWidth}px` : `calc(100vw - ${CONTENT_SIDE_GAP}px)`;
  }

  function setRootWidth(value) {
    widthPercent = clamp(value);
    const widthValue = getContentWidthCssValue(widthPercent);
    document.documentElement.dataset.cgptWidthEnabled = "true";
    document.documentElement.style.setProperty("--cgpt-width", widthValue);
    document.documentElement.style.setProperty("--thread-content-max-width", widthValue);
  }

  function normalizeBackground(value) {
    return Object.prototype.hasOwnProperty.call(BACKGROUNDS, value) ? value : DEFAULT_BACKGROUND;
  }

  function setPageBackground(value) {
    backgroundName = normalizeBackground(value);
    document.documentElement.dataset.cgptBackground = backgroundName;

    if (backgroundName === DEFAULT_BACKGROUND) {
      document.documentElement.style.removeProperty("--cgpt-page-background");
      return;
    }

    document.documentElement.style.setProperty("--cgpt-page-background", BACKGROUNDS[backgroundName]);
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
      (Boolean(inlineMaxWidth) && (inlineMaxWidth.includes("rem") || inlineMaxWidth.includes("px")))
    );
  }

  function widenElement(element) {
    if (element.dataset.cgptWidthMaxApplied === "true") return;
    element.dataset.cgptWidthMaxApplied = "true";
    element.classList.add("cgpt-width-max-target");
    element.style.setProperty("max-width", "min(var(--cgpt-width), calc(100vw - 32px))", "important");
  }

  function markThreadWidthElement(element) {
    if (!(element instanceof HTMLElement) || element.dataset.cgptThreadWidthApplied === "true") return;
    element.dataset.cgptThreadWidthApplied = "true";
    element.classList.add("cgpt-thread-width-target");
    element.style.setProperty("--thread-content-max-width", "min(var(--cgpt-width), calc(100vw - 32px))", "important");
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
    for (const element of collectScopedElements(roots, WIDTH_SELECTOR)) {
      if (shouldWiden(element)) widenElement(element);
      markThreadWidthElement(element);
    }
  }

  function getLatexFromFormula(formula) {
    if (formulaLatexCache.has(formula)) return formulaLatexCache.get(formula);

    const annotation = formula.querySelector("annotation[encoding='application/x-tex']");
    const rawLatex =
      (formula instanceof HTMLElement ? formula.dataset.latex : "") ||
      (annotation && annotation.textContent) ||
      formula.getAttribute("data-latex") ||
      (formula.matches(".MathJax, mjx-container") ? formula.getAttribute("aria-label") : "");

    if (!rawLatex || !rawLatex.trim()) {
      return null;
    }

    const block = Boolean(
      formula.closest(".katex-display, mjx-container[display='true'], .MathJax_Display") ||
      formula.closest(".cgpt-user-math.is-block") ||
      formula.getAttribute("display") === "true"
    );

    const latex = {
      element: formula,
      text: wrapLatex(rawLatex.trim(), block)
    };
    formulaLatexCache.set(formula, latex);
    return latex;
  }

  function resolveFormulaElement(node) {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return null;
    return (
      element.closest(".katex-display") ||
      element.closest(".katex") ||
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
    for (const formula of collectScopedElements(roots, ".katex-display, .katex, .MathJax, mjx-container, [data-latex]")) {
      if (!(formula instanceof HTMLElement)) continue;
      if (!isChatSurfaceElement(formula)) continue;
      if (formula.classList.contains("cgpt-latex-copy-target")) continue;
      if (formula.matches(".katex") && formula.closest(".katex-display")) continue;
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

  function mathMlRow(content) {
    return `<mrow>${content}</mrow>`;
  }

  function mathMlGrouped(content) {
    return mathMlRow(content || mathMlElement("mrow", ""));
  }

  function skipLatexWhitespace(text, index) {
    let cursor = index;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    return cursor;
  }

  function safeMathColor(color) {
    const value = color.trim();
    if (/^[A-Za-z]+$/.test(value) || /^#[0-9A-Fa-f]{3,8}$/.test(value)) return value;
    return "";
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

  function renderMathcal(text) {
    return mathMlRow(
      Array.from(text).map((char) => {
        if (/[A-Za-z]/.test(char)) return `<mi mathvariant="script">${escapeHtml(char)}</mi>`;
        if (/[0-9]/.test(char)) return mathMlElement("mn", escapeHtml(char));
        if (/\s/.test(char)) return "";
        return mathMlElement("mo", escapeHtml(char));
      }).join("")
    );
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

      if (command === "text") {
        const group = readLatexGroup(text, next);
        if (group) {
          return {
            html: mathMlElement("mtext", escapeHtml(group.value)),
            next: group.next
          };
        }
      }

      if (command === "color") {
        const color = readLatexGroup(text, next);
        const body = color ? readLatexGroup(text, color.next) : null;
        if (color && body) {
          const mathColor = safeMathColor(color.value);
          const colorAttribute = mathColor ? ` mathcolor="${escapeHtml(mathColor)}"` : "";
          return {
            html: `<mstyle${colorAttribute}>${parseLatexToMathMl(body.value)}</mstyle>`,
            next: body.next
          };
        }
      }

      if (command === "mathcal") {
        const group = readLatexGroup(text, next);
        if (group) {
          return {
            html: renderMathcal(group.value),
            next: group.next
          };
        }
      }

      if (command === "frac") {
        const numerator = readLatexGroup(text, next);
        const denominator = numerator ? readLatexGroup(text, numerator.next) : null;
        if (numerator && denominator) {
          return {
            html: `<mfrac>${mathMlGrouped(parseLatexToMathMl(numerator.value))}${mathMlGrouped(parseLatexToMathMl(denominator.value))}</mfrac>`,
            next: denominator.next
          };
        }
      }

      if (command === "sqrt") {
        const radicand = readLatexGroup(text, next);
        if (radicand) {
          return {
            html: `<msqrt>${mathMlGrouped(parseLatexToMathMl(radicand.value))}</msqrt>`,
            next: radicand.next
          };
        }
      }

      if (command === "underbrace") {
        const base = readLatexGroup(text, next);
        if (base) {
          next = skipLatexWhitespace(text, base.next);
          if (text[next] === "_") {
            const annotationStart = skipLatexWhitespace(text, next + 1);
            const annotation = parseLatexAtom(text, annotationStart);
            return {
              html: `<munder accentunder="false"><munder accentunder="true">${mathMlGrouped(parseLatexToMathMl(base.value))}<mo stretchy="true">&#x23DF;</mo></munder>${mathMlGrouped(annotation.html)}</munder>`,
              next: annotation.next
            };
          }

          return {
            html: `<munder accentunder="true">${mathMlGrouped(parseLatexToMathMl(base.value))}<mo stretchy="true">&#x23DF;</mo></munder>`,
            next: base.next
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
      index = skipLatexWhitespace(text, index);

      if (text[index] === "_" || text[index] === "^") {
        const firstOperator = text[index];
        const firstScript = parseLatexAtom(text, skipLatexWhitespace(text, index + 1));
        index = firstScript.next;
        index = skipLatexWhitespace(text, index);

        if (text[index] === "_" || text[index] === "^") {
          const secondOperator = text[index];
          const secondScript = parseLatexAtom(text, skipLatexWhitespace(text, index + 1));
          index = secondScript.next;

          const sub = firstOperator === "_" ? firstScript.html : secondScript.html;
          const sup = firstOperator === "^" ? firstScript.html : secondScript.html;
          atom = {
            html: `<msubsup>${mathMlGrouped(atom.html)}${mathMlGrouped(sub)}${mathMlGrouped(sup)}</msubsup>`,
            next: index
          };
        } else {
          atom = {
            html: firstOperator === "_" ?
              `<msub>${mathMlGrouped(atom.html)}${mathMlGrouped(firstScript.html)}</msub>` :
              `<msup>${mathMlGrouped(atom.html)}${mathMlGrouped(firstScript.html)}</msup>`,
            next: index
          };
        }
      }

      nodes.push(atom.html);
    }

    return nodes.join("");
  }

  function renderFallbackMath(cleanLatex, block) {
    return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${block ? "block" : "inline"}">${parseLatexToMathMl(cleanLatex)}</math>`;
  }

  function renderLatexMath(latex, block) {
    const cleanLatex = stripLatexWrapper(latex);
    const wrappedLatex = wrapLatex(cleanLatex, block);
    const tag = block ? "div" : "span";
    const renderId = `cgpt-latex-${latexRenderId += 1}`;
    const math = pageRendererState === "available" ?
      `<span class="cgpt-user-math-placeholder">${escapeHtml(wrappedLatex)}</span>` :
      renderFallbackMath(cleanLatex, block);
    return `<${tag} class="cgpt-user-math ${block ? "is-block" : "is-inline"}" data-latex="${escapeHtml(wrappedLatex)}" data-cgpt-latex-raw="${escapeHtml(cleanLatex)}" data-cgpt-latex-block="${block ? "true" : "false"}" data-cgpt-page-render-id="${renderId}" data-cgpt-page-render-status="pending">${math}</${tag}>`;
  }

  function setPendingPageRendersToFallback() {
    for (const formula of pendingPageRenderElements) {
      if (formula instanceof HTMLElement && formula.dataset.cgptPageRenderStatus === "pending") {
        formula.dataset.cgptPageRenderStatus = "fallback";
      }
    }
    pendingPageRenderElements.clear();
  }

  function dispatchPageLatexRender(formula) {
    const id = formula.dataset.cgptPageRenderId;
    const latex = formula.dataset.cgptLatexRaw;
    if (!id || !latex) return;

    pageRenderElements.set(id, formula);
    formula.dataset.cgptPageRenderStatus = "requested";
    window.dispatchEvent(new CustomEvent(PAGE_RENDER_REQUEST_EVENT, {
      detail: {
        id,
        latex,
        block: formula.dataset.cgptLatexBlock === "true"
      }
    }));
  }

  function flushPendingPageRenders() {
    const formulas = Array.from(pendingPageRenderElements);
    pendingPageRenderElements.clear();
    for (const formula of formulas) {
      if (formula instanceof HTMLElement && formula.dataset.cgptPageRenderStatus === "pending") {
        dispatchPageLatexRender(formula);
      }
    }
  }

  function probePageRenderer() {
    if (pageRendererState === "available" || pageRendererState === "probing") return;
    const now = Date.now();
    if (pageRendererState === "unavailable" && now - lastPageRendererProbeAt < PAGE_RENDER_RETRY_MS) return;

    pageRendererState = "probing";
    lastPageRendererProbeAt = now;
    const id = `cgpt-render-probe-${pageRendererProbeId += 1}`;
    window.clearTimeout(pageRendererProbeTimer);
    pageRendererProbeTimer = window.setTimeout(() => {
      if (pageRendererState !== "probing") return;
      pageRendererState = "unavailable";
      setPendingPageRendersToFallback();
    }, PAGE_RENDER_PROBE_TIMEOUT_MS);

    window.dispatchEvent(new CustomEvent(PAGE_RENDER_CAPABILITY_REQUEST_EVENT, {
      detail: { id }
    }));
  }

  function queuePageLatexRender(formula) {
    if (!(formula instanceof HTMLElement)) return;

    if (pageRendererState === "available") {
      dispatchPageLatexRender(formula);
      return;
    }

    formula.dataset.cgptPageRenderStatus = "pending";
    pendingPageRenderElements.add(formula);
    probePageRenderer();

    if (pageRendererState === "unavailable") {
      setPendingPageRendersToFallback();
    }
  }

  function requestPageLatexRender(root) {
    if (!(root instanceof Element)) return;

    const formulas = root.querySelectorAll(".cgpt-user-math[data-cgpt-page-render-status='pending']");
    for (const formula of formulas) {
      queuePageLatexRender(formula);
    }
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

  function findDisplayMathDelimiter(line, from = 0) {
    let index = from;
    while (index < line.length) {
      const found = line.indexOf("$$", index);
      if (found === -1) return -1;
      if (found === 0 || line[found - 1] !== "\\") return found;
      index = found + 2;
    }
    return -1;
  }

  function hasDisplayMathDelimiter(line) {
    return findDisplayMathDelimiter(line) !== -1;
  }

  function renderDisplayMathLine(lines, index, blocks) {
    const line = lines[index];
    const start = findDisplayMathDelimiter(line);
    if (start === -1) return null;

    const before = line.slice(0, start).trimEnd();
    const sameLineEnd = findDisplayMathDelimiter(line, start + 2);
    let mathContent = "";
    let trailing = "";
    let endIndex = index;

    if (sameLineEnd !== -1) {
      mathContent = line.slice(start + 2, sameLineEnd);
      trailing = line.slice(sameLineEnd + 2);
    } else {
      const mathLines = [line.slice(start + 2)];
      let cursor = index + 1;
      let foundEnd = false;

      while (cursor < lines.length) {
        const end = findDisplayMathDelimiter(lines[cursor]);
        if (end !== -1) {
          mathLines.push(lines[cursor].slice(0, end));
          trailing = lines[cursor].slice(end + 2);
          endIndex = cursor;
          foundEnd = true;
          break;
        }
        mathLines.push(lines[cursor]);
        cursor += 1;
      }

      if (!foundEnd) return null;
      mathContent = mathLines.join("\n");
    }

    if (before.trim()) {
      blocks.push(renderMarkdown(before));
    }
    blocks.push(renderLatexMath(mathContent, true));

    if (trailing.trim()) {
      lines[endIndex] = trailing;
      return endIndex;
    }

    return endIndex + 1;
  }

  function isMarkdownBlockStart(line) {
    return (
      /^```/.test(line) ||
      hasDisplayMathDelimiter(line) ||
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

      const displayMathNextIndex = renderDisplayMathLine(lines, index, blocks);
      if (displayMathNextIndex !== null) {
        index = displayMathNextIndex;
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

      const cachedSource = markdownSourceCache.get(target) || target.dataset.cgptMarkdownSource || "";
      const source = target.dataset.cgptMarkdownRendered === "true" && cachedSource ? cachedSource : target.textContent || "";
      if (!source.trim()) continue;
      if (target.dataset.cgptMarkdownRendered === "true" && cachedSource === source) continue;
      if (source.length > MAX_MARKDOWN_SOURCE_LENGTH) continue;

      markdownSourceCache.set(target, source);
      target.dataset.cgptMarkdownSource = source;
      target.dataset.cgptMarkdownRendered = "true";
      target.classList.add("cgpt-user-markdown");
      try {
        target.innerHTML = renderMarkdown(source);
        requestPageLatexRender(target);
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

  function serializeFormulaElementOnce(formula, state) {
    if (!formula) return null;
    if (state.seenFormulas.has(formula)) return "";

    const latex = getLatexFromFormula(formula);
    if (!latex) return null;

    state.seenFormulas.add(formula);
    state.hasFormula = true;
    return formatFormulaForSelection(latex);
  }

  function serializeFormulaOnce(formula, range, state) {
    if (!formula || !formulaTouchesRange(formula, range)) return null;
    return serializeFormulaElementOnce(formula, state);
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

  function serializeClonedNode(node, state) {
    const formulaText = node.nodeType === Node.ELEMENT_NODE ?
      serializeFormulaElementOnce(resolveFormulaElement(node), state) :
      null;
    if (formulaText !== null) return formulaText;

    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return "";
    }

    const element = node;
    if (element.nodeType === Node.ELEMENT_NODE && element.tagName === "BR") {
      return "\n";
    }

    let text = "";
    for (const child of node.childNodes) {
      text += serializeClonedNode(child, state);
    }

    if (node.nodeType === Node.ELEMENT_NODE && text.trim() && isBlockElement(element) && !text.endsWith("\n")) {
      text += "\n";
    }

    return text;
  }

  function serializeRangeWithLatex(range, state) {
    const commonFormula = getClosestFormula(range.commonAncestorContainer);
    const formulaText = serializeFormulaOnce(commonFormula, range, state);
    if (formulaText !== null) return formulaText;

    return serializeClonedNode(range.cloneContents(), state);
  }

  function rangeContainsFormula(range) {
    const commonFormula = getClosestFormula(range.commonAncestorContainer);
    if (formulaTouchesRange(commonFormula, range)) return true;

    try {
      const fragment = range.cloneContents();
      return Boolean(fragment.querySelector && fragment.querySelector(FORMULA_SELECTOR));
    } catch (error) {
      return false;
    }
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
      element.closest(".cgpt-copy-toast, .cgpt-user-math")
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

  const scheduleIdle = typeof window.requestIdleCallback === "function"
    ? (fn) => window.requestIdleCallback(fn, { timeout: 200 })
    : (fn) => window.setTimeout(fn, 80);
  const cancelIdle = typeof window.cancelIdleCallback === "function"
    ? window.cancelIdleCallback.bind(window)
    : window.clearTimeout.bind(window);

  function scheduleRefresh(options = {}) {
    if (options.full) {
      pendingFullRefresh = true;
      dirtyRefreshRoots.clear();
    } else if (options.roots) {
      for (const root of normalizeRefreshRoots(options.roots)) {
        dirtyRefreshRoots.add(root);
      }
    }

    cancelIdle(refreshTimer);
    refreshTimer = scheduleIdle(() => {
      const roots = pendingFullRefresh ? null : Array.from(dirtyRefreshRoots).filter((root) => root instanceof Element && root.isConnected);
      pendingFullRefresh = false;
      dirtyRefreshRoots.clear();

      if (roots && !roots.length) return;
      refreshChatWidths(roots);
      refreshUserMarkdown(roots);
      refreshLatexTargets(roots);
    });
  }

  function observePage() {
    const root = document.querySelector("main") || document.body || document.documentElement;
    if (observer && observedRoot === root) return;
    if (observer) observer.disconnect();
    observedRoot = root;
    observer = new MutationObserver((mutations) => {
      queueMutationRoots(mutations);
      if (dirtyRefreshRoots.size) scheduleRefresh();
    });
    observer.observe(root, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    storage.get(
      {
        [STORAGE_KEY]: DEFAULT_PERCENT,
        [BACKGROUND_KEY]: DEFAULT_BACKGROUND
      },
      (items) => {
        setRootWidth(items[STORAGE_KEY]);
        setPageBackground(items[BACKGROUND_KEY]);
        probePageRenderer();
        observePage();
        refreshChatWidths();
        refreshUserMarkdown();
        refreshLatexTargets();
      }
    );
  }

  window.addEventListener("resize", () => {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = null;
      setRootWidth(widthPercent);
    });
  });

  function getFormulaLineScope(formula) {
    const block = formula.closest("p, li, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, td, th");
    return block && isChatSurfaceElement(block) ? block : null;
  }

  function getClickCopyPayload(target) {
    const formula = resolveFormulaElement(
      target instanceof Element ? target : target && target.parentElement
    );
    if (!formula) return null;

    const single = getLatexFromFormula(formula);
    if (!single) return null;

    const scope = getFormulaLineScope(formula);
    if (scope) {
      const state = { hasFormula: false, seenFormulas: new Set() };
      const lineText = normalizeCopiedText(serializeClonedNode(scope, state));
      if (state.hasFormula && lineText && lineText !== single.text) {
        return { text: lineText, element: scope };
      }
    }

    return { text: single.text, element: single.element };
  }

  document.addEventListener("click", async (event) => {
    const payload = getClickCopyPayload(event.target);
    if (!payload) return;

    event.preventDefault();
    event.stopPropagation();

    try {
      await copyText(payload.text);
      showCopyFeedback(payload.element, true);
    } catch (error) {
      showCopyFeedback(payload.element, false);
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

  document.addEventListener("copy", handleCopyWithLatex, true);

  window.addEventListener(PAGE_RENDER_CAPABILITY_RESPONSE_EVENT, (event) => {
    const detail = event.detail || {};
    if (detail.id !== `cgpt-render-probe-${pageRendererProbeId}`) return;

    window.clearTimeout(pageRendererProbeTimer);
    pageRendererProbeTimer = null;
    pageRendererState = detail.ok ? "available" : "unavailable";

    if (pageRendererState === "available") {
      flushPendingPageRenders();
      return;
    }

    setPendingPageRendersToFallback();
  });

  window.addEventListener(PAGE_RENDER_RESPONSE_EVENT, (event) => {
    const detail = event.detail || {};
    if (!detail.id) return;

    const formula = pageRenderElements.get(detail.id) || document.querySelector(`[data-cgpt-page-render-id="${detail.id}"]`);
    pageRenderElements.delete(detail.id);
    if (!(formula instanceof HTMLElement)) return;

    if (detail.ok && typeof detail.html === "string" && detail.html.trim()) {
      formula.innerHTML = detail.html;
      formula.dataset.cgptPageRenderStatus = "rendered";
      formula.dataset.cgptPageRenderer = detail.renderer || "page";
      formula.classList.add("cgpt-user-math-page-rendered");
      refreshLatexTargets([formula]);
      return;
    }

    const latex = formula.dataset.cgptLatexRaw;
    if (latex) {
      formula.innerHTML = renderFallbackMath(latex, formula.dataset.cgptLatexBlock === "true");
    }
    formula.dataset.cgptPageRenderStatus = "fallback";
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === "CGPT_SET_WIDTH") {
      setRootWidth(message.value);
      return;
    }
    if (message.type === "CGPT_SET_BACKGROUND") {
      setPageBackground(message.value);
    }
  });

  init();
})();
