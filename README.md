# Overleaf AI Assistant

A Firefox browser extension that integrates AI into the [Overleaf](https://www.overleaf.com) LaTeX editor, providing inline proofreading and style suggestions. Supports multiple AI providers: Anthropic Claude, Google Gemini, and OpenRouter (hundreds of models).

---

## Features

- **Proofreading mode** — finds typos, spelling errors, and grammar mistakes
- **Style mode** — additionally suggests improvements to clarity, flow, and academic writing style
- **Fact Checking mode** — identifies factual inaccuracies, wrong dates, incorrect attributions, and demonstrably false statements
- **Compacting mode** — shortens selected text while preserving all arguments and meaning (selection only)
- **Check full document** or **check selected text**
- **Inline highlights** in the editor with hover/click tooltips
- **Sidebar panel** listing all suggestions with original → corrected text and explanations
- **Token usage tracking** per call and for the session
- **Multi-provider**: Anthropic Claude, Google Gemini, OpenRouter (GPT-4, Llama, Mistral, DeepSeek, and more)
- Stores your API keys locally — sent only to the selected provider's API

---

## Installation (Firefox Developer / Temporary Load)

1. Open Firefox and navigate to `about:debugging`
2. Click **"This Firefox"** in the left sidebar
3. Click **"Load Temporary Add-on…"**
4. Navigate to the `overleaf-ai-extension/` folder and select **`manifest.json`**
5. The extension is now loaded (it will be removed when Firefox restarts)

### Permanent installation (unsigned)

Firefox requires extensions to be signed by Mozilla for permanent installation, unless you use:
- **Firefox Developer Edition** or **Firefox Nightly** — enable `xpinstall.signatures.required = false` in `about:config`
- Or package and submit to [addons.mozilla.org](https://addons.mozilla.org) for signing

---

## Setup

1. Click the **✦** toolbar icon
2. Choose a **Provider** in the popup:
   - **Anthropic** — get a key at [console.anthropic.com](https://console.anthropic.com)
     - Suggested models: `claude-haiku-4-5-20251001` (fast), `claude-sonnet-4-5`, `claude-opus-4-5`
   - **Google Gemini** — get a key at [aistudio.google.com](https://aistudio.google.com)
     - Suggested models: `gemini-2.0-flash`, `gemini-2.5-flash-preview-04-17`, `gemini-2.5-pro-preview-03-25`
   - **OpenRouter** — get a key at [openrouter.ai](https://openrouter.ai) (access to 100+ models)
     - Suggested models: `google/gemini-flash-1.5`, `meta-llama/llama-3.3-70b-instruct`, `mistralai/mistral-small-3.1-24b-instruct`, `deepseek/deepseek-chat-v3-0324`, `openai/gpt-4o-mini`
3. Paste your API key for that provider
4. Enter a model ID for that provider, or leave the provider default
5. Click **Save Settings**

---

## Usage

1. Open any project on **overleaf.com** (URL must match `/project/*`)
2. The AI sidebar appears in Overleaf's left sidebar
3. Choose a mode:
   - **Proofreading** — spell and grammar errors
   - **Style** — all of proofreading, plus clarity and flow suggestions
   - **Fact Checking** — flags factual inaccuracies and wrong attributions
   - **Compacting** — condenses a selection (only available with *Check Selection*)
4. Click **Check Document** to analyze the full document, or select some text and click **Check Selection**
5. Suggestions appear in the sidebar and as inline highlights in the editor:
   - 🔴 Red underline = typo
   - 🟠 Orange underline = grammar
   - 🔵 Blue dotted = style / fact issue
6. In Compacting mode, the result appears as a card — review and click **Apply** to replace the selection
7. Click a suggestion card in the sidebar (or hover/click a highlight) to see details
8. Click **Clear highlights** to remove all overlays

---

## File Structure

```
overleaf-claude-extension/
├── manifest.json           # MV3 extension manifest
├── background.js           # Service worker — handles multi-provider API calls
├── content/
│   ├── content.js          # Coordinates extraction, sidebar, highlights
│   ├── sidebar.js          # Sidebar panel UI
│   ├── highlights.js       # Inline highlight overlays & tooltips
│   └── content.css         # All injected styles
├── popup/
│   ├── popup.html          # Settings page
│   ├── popup.js            # Settings logic
│   └── popup.css           # Settings styles
├── icons/
│   └── icon48.png          # Extension icon
└── README.md
```

---

## Technical Notes

### CodeMirror 6 Text Extraction

Overleaf uses CodeMirror 6. Text is extracted by querying `.cm-content` and walking `.cm-line` elements:

```js
const lines = document.querySelectorAll(".cm-content .cm-line");
const text = Array.from(lines).map(l => l.textContent).join("\n");
```

### Highlight Overlays

Highlights are **floating `<span>` elements** positioned absolutely over the editor using `Range.getBoundingClientRect()`. They do not modify the editor DOM, so they cannot break CodeMirror's internal state. The overlay is repositioned on scroll/resize via `requestAnimationFrame`.

### CORS & API Calls

All provider APIs (Anthropic, Gemini, OpenRouter) block calls from content scripts due to CORS. All API requests are made from the **background service worker** (`background.js`), which has unrestricted network access. Content scripts communicate with it via `browser.runtime.sendMessage`.

### Permissions

| Permission | Purpose |
|---|---|
| `storage` | Store provider settings locally |
| `activeTab` | Interact with the active Overleaf tab |
| `host_permissions: overleaf.com` | Inject content scripts |
| `host_permissions: api.anthropic.com` | Anthropic API calls |
| `host_permissions: generativelanguage.googleapis.com` | Google Gemini API calls |
| `host_permissions: openrouter.ai` | OpenRouter API calls |

---

## Privacy

- Your API key is stored in `browser.storage.local` — it stays on your device
- Document text is sent only to your selected provider's API endpoint when you click "Check Document" or "Check Selection"
- No data is sent to any server other than your chosen provider

---

## Troubleshooting

**Sidebar not appearing**
- Make sure you're on a project page (`overleaf.com/project/…`), not the dashboard
- Reload the page after installing the extension

**"Could not find the Overleaf editor"**
- The editor may still be loading; wait a moment and try again

**API errors**
- Check that your API key is correct for the selected provider in the settings popup
- Make sure your account has sufficient credits/quota with that provider

**Highlights misaligned after scrolling**
- This can happen on very large documents; they auto-correct on the next scroll event
