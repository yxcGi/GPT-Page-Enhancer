# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Workflow

No build step or package manager. To test changes:

1. Open `chrome://extensions/`, enable Developer mode, click "Load unpacked", select the repo root.
2. After editing any file: reload the extension on `chrome://extensions/`, then hard-refresh the ChatGPT tab.
3. Popup changes require closing and reopening the popup.

There is no automated test suite — see the manual checklist in `AGENTS.md`.

## Architecture

Manifest V3 extension with **two separate JavaScript worlds**:

| File | World | Runs at | Can access |
|---|---|---|---|
| `vendor/katex/katex.min.js` + `mainWorld.js` | `MAIN` | `document_start` | `window.katex`, `window.MathJax` |
| `content.js` | Isolated (default) | `document_idle` | `chrome.*` APIs |

`content.js` cannot call `window.katex` directly. Instead it fires `CustomEvent`s on `window`; `mainWorld.js` listens, renders, and fires back a response event. Both files must stay in sync on event names and payload shapes — the constants are duplicated in each file:

```
CGPT_PAGE_RENDER_LATEX_REQUEST / RESPONSE
CGPT_PAGE_RENDER_LATEX_CAPABILITY_REQUEST / RESPONSE
```

### content.js internals

All logic is in one IIFE. Key responsibilities and their locations:

- **DOM observation**: `MutationObserver` in `observePage()` feeds dirty roots into `scheduleRefresh()` (80 ms debounce). Mutations inside `.cgpt-user-math` are intentionally excluded via `isExtensionElement()` to avoid loops when the extension injects KaTeX HTML.
- **Width control**: `refreshChatWidths()` targets ChatGPT selectors like `[class*='max-w-']` and `[data-message-author-role]`. Selectors are fragile against ChatGPT DOM changes.
- **User-message Markdown**: `refreshUserMarkdown()` / `renderMarkdown()`. Skips tables, `<pre>`, interactive elements, media, nav, and sidebars. Stores original source in a `WeakMap` before overwriting `innerHTML`.
- **Formula rendering**: `renderLatexMath()` creates `.cgpt-user-math[data-latex]` wrappers. Rendering is dispatched to `mainWorld.js`; on response, `formula.innerHTML` is replaced with KaTeX HTML. Fallback: a minimal MathML renderer for offline/unavailable cases.
- **Formula hover/copy**: `refreshLatexTargets()` adds `cgpt-latex-copy-target` to `.katex-display`, `.katex`, `mjx-container`, and `[data-latex]` elements. `.katex` inside `.katex-display` is skipped (display wrapper covers the full visual hit area). `resolveFormulaElement()` walks up the DOM preferring `.katex-display` over `.katex`.
- **LaTeX cache**: `formulaLatexCache` (WeakMap) caches successful extractions only — null results are not cached so async-rendered elements are retried on the next refresh cycle.

### Storage and messaging

- Storage keys: `chatgptContentWidthPercent`, `chatgptPageBackground`
- Popup → content message types: `CGPT_SET_WIDTH`, `CGPT_SET_BACKGROUND`
- Prefer `chrome.storage.sync`; falls back to `chrome.storage.local`

## Key Constraints

- **Scope everything** to the chat surface (`inside <main>`, not nav/aside/header). `isChatSurfaceElement()` enforces this.
- **Escape before writing HTML**. `renderMarkdown()` and helpers route text through `escapeHtml()`; keep this property when adding Markdown features.
- **ChatGPT DOM is unstable**. Selectors like `.whitespace-pre-wrap`, `[data-testid^='conversation-turn']`, and `max-w-*` classes can break on ChatGPT updates.
- **No network dependencies** at runtime. Vendored assets must include their license.
- **Keep extension buildless** unless there is a strong reason for tooling.
- When changing user-visible behavior, bump `manifest.json` version and update `README.md`.
