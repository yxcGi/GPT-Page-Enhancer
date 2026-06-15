(function () {
  const REQUEST_EVENT = "CGPT_PAGE_RENDER_LATEX_REQUEST";
  const RESPONSE_EVENT = "CGPT_PAGE_RENDER_LATEX_RESPONSE";

  function renderWithKatex(latex, block) {
    if (!window.katex || typeof window.katex.renderToString !== "function") return null;

    return window.katex.renderToString(latex, {
      displayMode: Boolean(block),
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml"
    });
  }

  function renderWithMathJax(latex, block) {
    if (!window.MathJax || typeof window.MathJax.tex2chtml !== "function") return null;

    const node = window.MathJax.tex2chtml(latex, {
      display: Boolean(block)
    });
    const container = document.createElement(block ? "div" : "span");
    container.appendChild(node);
    return container.innerHTML;
  }

  function renderLatex(latex, block) {
    try {
      const katexHtml = renderWithKatex(latex, block);
      if (katexHtml) return { ok: true, renderer: "katex", html: katexHtml };
    } catch (error) {
      // Try the next renderer.
    }

    try {
      const mathJaxHtml = renderWithMathJax(latex, block);
      if (mathJaxHtml) return { ok: true, renderer: "mathjax", html: mathJaxHtml };
    } catch (error) {
      // Fall through to the content-script fallback renderer.
    }

    return { ok: false, renderer: "", html: "" };
  }

  window.addEventListener(REQUEST_EVENT, (event) => {
    const detail = event.detail || {};
    if (!detail.id || typeof detail.latex !== "string") return;

    const result = renderLatex(detail.latex, detail.block);
    window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
      detail: {
        id: detail.id,
        ...result
      }
    }));
  });
})();
