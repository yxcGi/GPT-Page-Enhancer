# AGENTS.md

## Project Overview

GPT Page Enhancer is a Manifest V3 Chrome extension for ChatGPT pages. It improves the ChatGPT web UI by widening conversation content, applying optional page background colors, rendering sent user prompts as Markdown, rendering LaTeX in those prompts, and copying rendered formulas back as complete LaTeX.

The extension is intentionally small and dependency-light. There is no build step, package manager config, linter config, or test runner in this repository. Source files are loaded directly by Chrome.

## Supported Surfaces

The extension only targets:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

Keep host permissions, content script matches, and README descriptions in sync when changing supported pages.

## Important Files

- `manifest.json`: Manifest V3 extension metadata, permissions, content script registration, popup registration, and web-accessible KaTeX fonts.
- `content.js`: Main isolated-world content script. Handles width/background settings, ChatGPT DOM observation, user-message Markdown rendering, LaTeX fallback rendering, formula copy behavior, selection copy serialization, and popup messages.
- `content.css`: Styles injected into ChatGPT pages for width overrides, background overrides, Markdown output, math output, copy hover states, and toast feedback.
- `mainWorld.js`: MAIN-world bridge used to access page/global renderers. It listens for custom render/probe events and renders LaTeX with bundled KaTeX first, then page MathJax when available.
- `popup.html`, `popup.css`, `popup.js`: Browser action popup for width and background controls.
- `vendor/katex/`: Vendored KaTeX runtime, stylesheet, license, and fonts. These are loaded directly by the manifest and should stay self-contained.
- `README.md`: User-facing installation, usage, feature, and limitation documentation.

## Architecture Notes

Chrome isolates content scripts from page JavaScript. This project uses two content scripts to work with that boundary:

- `vendor/katex/katex.min.js` and `mainWorld.js` run at `document_start` in `"world": "MAIN"`.
- `content.js` runs at `document_idle` in the default isolated world.

`content.js` and `mainWorld.js` communicate with `CustomEvent`s on `window`. The event names are duplicated constants in both files:

- `CGPT_PAGE_RENDER_LATEX_REQUEST`
- `CGPT_PAGE_RENDER_LATEX_RESPONSE`
- `CGPT_PAGE_RENDER_LATEX_CAPABILITY_REQUEST`
- `CGPT_PAGE_RENDER_LATEX_CAPABILITY_RESPONSE`

If any event name or payload shape changes, update both files together.

`content.js` has a fallback MathML renderer for a limited LaTeX subset. Do not assume it is a full TeX parser. Prefer keeping the MAIN-world KaTeX path working and treat fallback rendering as graceful degradation.

The ChatGPT DOM is not stable. Width and Markdown behavior depend on selectors such as `[data-message-author-role]`, `[data-testid^='conversation-turn']`, `main`, `.whitespace-pre-wrap`, and classes containing `max-w-`. When adjusting selectors, verify against current ChatGPT markup and keep the scope inside the chat surface so navigation/sidebar UI is not modified.

## Storage and Messages

User settings are stored through `chrome.storage.sync` when available, otherwise `chrome.storage.local`.

Current storage keys:

- `chatgptContentWidthPercent`
- `chatgptPageBackground`

Popup-to-content message types:

- `CGPT_SET_WIDTH`
- `CGPT_SET_BACKGROUND`

Keep these names stable unless you also migrate old stored settings and update both popup/content logic.

## Development Workflow

There is no install/build command. To run locally:

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this repository root.
5. Open or refresh ChatGPT.

After changing extension files, reload the extension in `chrome://extensions/` and refresh the ChatGPT tab. Changes to popup files may require closing and reopening the popup.

Useful local inspection commands:

```sh
git status --short
rg "CGPT_" .
rg "chatgptContentWidthPercent|chatgptPageBackground" .
```

## Manual Verification Checklist

Because this repo has no automated test suite, manually verify behavior in Chrome after meaningful changes:

- Load the unpacked extension without manifest errors.
- Open `https://chatgpt.com/` and confirm no console errors from the extension.
- Move the popup width slider and confirm conversation content width updates immediately and persists after refresh.
- Select each popup background swatch and confirm the page background updates and persists.
- Send a prompt containing Markdown headings, lists, blockquotes, links, inline code, and fenced code; confirm the sent user message renders cleanly.
- Send inline math such as `$a^2 + b^2 = c^2$` and display math such as `$$\\frac{1}{2}$$`; confirm rendering works.
- Click rendered formulas and confirm the clipboard receives wrapped LaTeX with `$...$` or `$$...$$`.
- Select text containing formulas and copy it; confirm formulas are copied as LaTeX rather than visual math text.
- Resize the browser window and confirm the width calculation remains usable.
- Check that ChatGPT navigation, sidebars, composer, buttons, tables, images, videos, and code blocks are not rewritten as user Markdown.

## Coding Guidelines

- Keep the extension buildless unless there is a strong reason to introduce tooling.
- Prefer plain JavaScript, HTML, and CSS consistent with the existing files.
- Use ASCII in source edits unless the file already needs user-facing Chinese text or mathematical symbols.
- Keep permissions narrow. Do not add new host permissions or extension permissions without a clear feature need.
- Avoid network-loaded runtime dependencies. Vendored assets should include their license.
- In `content.js`, keep refresh work scoped and throttled. The mutation observer currently batches dirty roots with a short timeout to avoid reprocessing the whole page on every DOM change.
- Preserve user-entered source text when rendering Markdown. The code stores the original source in `WeakMap`/dataset before replacing `innerHTML`.
- Escape untrusted text before writing HTML. `renderMarkdown` intentionally routes text through escaping helpers; keep that safety property when extending Markdown support.
- Do not rewrite interactive controls, inputs, media, tables, pre/code blocks, navigation, or sidebars as Markdown.
- When editing styles for ChatGPT pages, scope selectors under the extension classes or `html[data-cgpt-*]` attributes where possible.
- Update `README.md` and `manifest.json` version/description when changing user-visible behavior.

## Release Notes

The current manifest version is `1.4.0`. If preparing a release, bump `manifest.json` and update the README if features, permissions, supported pages, or limitations changed.
