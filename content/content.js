/**
 * content.js — Main content script for Overleaf AI Assistant.
 * Coordinates CodeMirror text extraction, sidebar, and highlights.
 * Injected on overleaf.com/project/* pages.
 */

(function () {
  "use strict";

  // Avoid double-injection
  if (window.__overleafAIAssistant) return;
  window.__overleafAIAssistant = true;

  // ─── State ────────────────────────────────────────────────────────────────
  const state = {
    mode: "proofreading",   // "proofreading" | "style" | "factchecking" | "compacting"
    suggestions: [],
    isLoading: false,
    isApplyingEdit: false,
    isStale: false,
    lastUsage: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    compactRange: null,     // saved selection Range for compacting mode
    analysisContext: null   // metadata about the last analyzed document or selection
  };

  const DEFAULTS = {
    provider: "anthropic",
    providers: {
      anthropic: { apiKey: "", model: "claude-haiku-4-5-20251001" },
      gemini: { apiKey: "", model: "gemini-2.0-flash" },
      openrouter: { apiKey: "", model: "google/gemini-flash-1.5" }
    }
  };

  // ─── CodeMirror Text Extraction ──────────────────────────────────────────

  /**
   * Extract the full document text from a CodeMirror 6 editor.
   * Overleaf renders each line as a .cm-line inside .cm-content.
   * We join them with newlines to reconstruct the source.
   */
  /**
   * Reconstruct the full CodeMirror document by walking the virtualized viewport.
   * Inputs: None.
   * Returns: A promise resolving to the full document text, or `null` if the editor is unavailable.
   */
  async function extractFullText() {
    const scroller = document.querySelector(".cm-scroller");
    const cmContent = document.querySelector(".cm-content");
    if (!scroller || !cmContent) return null;

    const originalScrollTop = scroller.scrollTop;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const step = Math.max(200, Math.floor(scroller.clientHeight * 0.75));
    const linesByTop = new Map();

    try {
      for (let top = 0; top <= maxScrollTop + step; top += step) {
        scroller.scrollTop = Math.min(top, maxScrollTop);
        await waitForPaint();
        collectVisibleLines(scroller, linesByTop);
      }

      scroller.scrollTop = maxScrollTop;
      await waitForPaint();
      collectVisibleLines(scroller, linesByTop);
    } finally {
      scroller.scrollTop = originalScrollTop;
      await waitForPaint();
    }

    if (!linesByTop.size) return null;

    return Array
      .from(linesByTop.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join("\n");
  }

  /**
   * Extract currently selected text from the CodeMirror editor.
   * Falls back to window.getSelection() which works across DOM.
   */
  /**
   * Read the user's current text selection from the editor DOM.
   * Inputs: None.
   * Returns: The selected text string, or `null` when nothing meaningful is selected.
   */
  function extractSelectedText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;

    const selected = selection.toString();
    return selected.trim().length > 0 ? selected : null;
  }

  // ─── API Communication ────────────────────────────────────────────────────

  /**
   * Load provider settings from extension storage.
   * Inputs: None.
   * Returns: A promise resolving to the raw storage payload.
   */
  async function getSettings() {
    return new Promise(resolve => {
      browser.storage.local.get(["settings", "provider", "apiKeys", "model"], resolve);
    });
  }

  /**
   * Call the background worker for the current mode and update UI state with the result.
   * Inputs: Source text to analyze and optional analysis context for anchoring suggestions.
   * Returns: A promise that resolves after the sidebar and highlights have been updated.
   */
  async function runAnalysis(text, context = null) {
    state.isLoading = true;
    window.__oclaSidebar.setLoading(true);

    try {
      const rawSettings = await getSettings();
      const settings = normalizeSettings(rawSettings);
      const activeProvider = settings.provider;
      const providerConfig = settings.providers[activeProvider] || DEFAULTS.providers[activeProvider];
      const apiKey = providerConfig.apiKey || "";
      const activeModel = providerConfig.model || DEFAULTS.providers[activeProvider].model;

      const response = await browser.runtime.sendMessage({
        action: "callAPI",
        text,
        mode: state.mode,
        provider: activeProvider,
        apiKey,
        model: activeModel
      });

      if (!response.success) {
        throw new Error(response.error);
      }

      state.lastUsage = response.data.usage;
      state.totalInputTokens += response.data.usage.inputTokens;
      state.totalOutputTokens += response.data.usage.outputTokens;

      if (response.data.compacted !== undefined) {
        // Compacting mode: single replacement result, no highlights
        state.isStale = false;
        window.__oclaSidebar.renderCompactResult(response.data.compacted, response.data.explanation, state.lastUsage, state.totalInputTokens, state.totalOutputTokens);
      } else {
        state.analysisContext = context;
        state.isStale = false;
        // Anchors let later jump/apply actions target the original occurrence
        // rather than re-matching the first identical text in the editor.
        const anchoredSuggestions = attachSuggestionAnchors(response.data.suggestions, context);
        state.suggestions = anchoredSuggestions.map((suggestion, index) => ({
          ...suggestion,
          id: createSuggestionId(index)
        }));
        window.__oclaSidebar.renderSuggestions(state.suggestions, state.lastUsage, state.totalInputTokens, state.totalOutputTokens);
        window.__oclaHighlights.applyHighlights(state.suggestions, state.analysisContext);
      }

    } catch (err) {
      window.__oclaSidebar.showError(err.message);
    } finally {
      state.isLoading = false;
      window.__oclaSidebar.setLoading(false);
    }
  }

  // ─── Event Handlers exposed to sidebar ───────────────────────────────────

  window.__oclaContent = {
    /**
     * Analyze the full current document in the active mode.
     * Inputs: None.
     * Returns: A promise that resolves after analysis has been started.
     */
    async onCheckDocument() {
      if (state.isLoading) return;
      const text = await extractFullText();
      if (!text) {
        window.__oclaSidebar.showError("Could not find the Overleaf editor. Make sure a project is open.");
        return;
      }
      state.analysisContext = createAnalysisContext("document", text);
      runAnalysis(text, state.analysisContext);
    },

    /**
     * Analyze only the current selection in the active mode.
     * Inputs: None.
     * Returns: None; shows an error when no valid selection exists.
     */
    onCheckSelection() {
      if (state.isLoading) return;
      const sel = window.getSelection();
      const text = extractSelectedText();
      const range = (sel && !sel.isCollapsed) ? sel.getRangeAt(0).cloneRange() : null;
      if (!text || !range) {
        window.__oclaSidebar.showError("No text selected. Select some text in the editor first.");
        return;
      }
      state.analysisContext = createAnalysisContext("selection", text, { range });
      if (state.mode === "compacting") {
        state.compactRange = range.cloneRange();
      }
      runAnalysis(text, state.analysisContext);
    },

    /**
     * Update the active analysis mode selected in the sidebar.
     * Inputs: New mode string.
     * Returns: None.
     */
    onModeChange(newMode) {
      state.mode = newMode;
    },

    /**
     * Clear all active suggestions, anchors, and compacting state.
     * Inputs: None.
     * Returns: None.
     */
    onClearHighlights() {
      state.suggestions = [];
      state.compactRange = null;
      state.analysisContext = null;
      state.isStale = false;
      window.__oclaHighlights.clearHighlights();
    },

    /**
     * Replace the saved compacting selection with a commented original block plus the compacted text.
     * Inputs: The compacted replacement text.
     * Returns: A promise that resolves after the editor edit and UI cleanup complete.
     */
    async onApplyCompact(compactedText) {
      if (!state.compactRange) return;
      const cmContent = document.querySelector(".cm-content");
      if (cmContent) {
        const originalText = state.analysisContext?.text || state.compactRange.toString() || "";
        const replacementText = buildCompactingWriteback(originalText, compactedText);
        await performTrackedEditorEdit(() => {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(state.compactRange);
          cmContent.focus();
          return document.execCommand("insertText", false, replacementText);
        });
      }
      state.compactRange = null;
      state.analysisContext = null;
      state.isStale = false;
      window.__oclaSidebar.clearResults();
    },

    /**
     * Apply one suggestion to the editor and update remaining anchors.
     * Inputs: Suggestion id string.
     * Returns: A promise that resolves after the accept flow completes.
     */
    async onAcceptSuggestion(id) {
      if (state.isStale) {
        window.__oclaSidebar.showError("The document changed after analysis. Run the check again before applying suggestions.");
        return;
      }
      let applied = null;
      state.isApplyingEdit = true;
      try {
        applied = await window.__oclaHighlights.acceptHighlight(id);
      } finally {
        await waitForPaint();
        state.isApplyingEdit = false;
      }
      if (!applied) {
        window.__oclaSidebar.showError("Could not apply that suggestion to the current editor selection.");
        return;
      }
      if (applied?.anchor && state.analysisContext?.text) {
        updateAnalysisContextAfterAccept(applied.anchor, applied.replacementText || "");
      }
      state.suggestions = state.suggestions.filter((suggestion) => suggestion.id !== id);
      if (applied?.anchor) {
        shiftRemainingSuggestionAnchors(applied.anchor, applied.replacementText || "", id);
      }
      window.__oclaHighlights.applyHighlights(state.suggestions, state.analysisContext);
      window.__oclaSidebar.removeSuggestion(id);
    },

    /**
     * Dismiss one suggestion without editing the document.
     * Inputs: Suggestion id string.
     * Returns: None.
     */
    onRejectSuggestion(id) {
      window.__oclaHighlights.rejectHighlight(id);
      state.suggestions = state.suggestions.filter((suggestion) => suggestion.id !== id);
      window.__oclaHighlights.applyHighlights(state.suggestions, state.analysisContext);
      window.__oclaSidebar.removeSuggestion(id);
    },

    /**
     * Invalidate the current analysis after a user-driven editor change.
     * Inputs: None.
     * Returns: None; clears stale UI state and prompts the user to re-run analysis.
     */
    onEditorChanged() {
      if (state.isApplyingEdit) return;
      if (!state.analysisContext && !state.compactRange && !state.suggestions.length) return;
      state.isStale = true;
      state.suggestions = [];
      state.compactRange = null;
      state.analysisContext = null;
      window.__oclaHighlights.clearHighlights();
      window.__oclaSidebar.clearResults();
      window.__oclaSidebar.showError("The document changed after analysis. Run the check again.");
    }
  };

  /**
   * Attach document or selection offsets to model suggestions based on the analyzed text.
   * Inputs: Suggestion array and the analysis context that produced them.
   * Returns: A new suggestion array with `anchor` metadata where matches can be found.
   */
  function attachSuggestionAnchors(suggestions, context) {
    if (!Array.isArray(suggestions) || !context?.text) {
      return Array.isArray(suggestions) ? suggestions : [];
    }

    const occupied = [];
    return suggestions.map((suggestion) => {
      const original = typeof suggestion.original === "string" ? suggestion.original : "";
      const anchor = original ? findSuggestionAnchor(context.text, original, occupied, context.scope) : null;
      if (anchor) {
        occupied.push([anchor.start, anchor.end]);
      }
      return anchor ? { ...suggestion, anchor } : suggestion;
    });
  }

  /**
   * Build the metadata needed to map suggestion offsets back into the editor later.
   * Inputs: Context scope (`document` or `selection`), analyzed text, and extra fields to merge in.
   * Returns: A normalized analysis context object.
   */
  function createAnalysisContext(scope, text, extra = {}) {
    return {
      scope,
      text,
      ...extra,
      ...buildTextIndex(text)
    };
  }

  /**
   * Find a stable offset range for a suggestion's original text in the analyzed source.
   * Inputs: Full analyzed text, original snippet, already-used ranges, and analysis scope.
   * Returns: `{ scope, start, end }` for the chosen occurrence, or `null` if none is found.
   */
  function findSuggestionAnchor(text, original, occupied, scope) {
    const matches = [];
    let startIndex = 0;

    while (startIndex <= text.length) {
      const foundAt = text.indexOf(original, startIndex);
      if (foundAt === -1) break;
      matches.push([foundAt, foundAt + original.length]);
      startIndex = foundAt + Math.max(1, original.length);
    }

    if (!matches.length) return null;

    const freeMatch = matches.find(([start, end]) => !occupied.some(([usedStart, usedEnd]) => start < usedEnd && end > usedStart));
    const [start, end] = freeMatch || matches[0];
    return { scope, start, end };
  }

  /**
   * Update the stored analyzed text after the extension applies a replacement.
   * Inputs: Applied anchor and the replacement text inserted into the editor.
   * Returns: None; mutates `state.analysisContext` and rebuilds its text index.
   */
  function updateAnalysisContextAfterAccept(anchor, replacementText) {
    const before = state.analysisContext.text.slice(0, anchor.start);
    const after = state.analysisContext.text.slice(anchor.end);
    state.analysisContext.text = `${before}${replacementText}${after}`;
    Object.assign(state.analysisContext, buildTextIndex(state.analysisContext.text));
  }

  /**
   * Shift later suggestion anchors to account for a text length change after acceptance.
   * Inputs: Applied anchor, replacement text, and the accepted suggestion id.
   * Returns: None; rewrites later anchors in `state.suggestions`.
   */
  function shiftRemainingSuggestionAnchors(anchor, replacementText, acceptedId) {
    const delta = replacementText.length - (anchor.end - anchor.start);
    if (!delta) return;

    state.suggestions = state.suggestions.map((suggestion) => {
      if (suggestion.id === acceptedId || !suggestion.anchor || suggestion.anchor.scope !== anchor.scope) {
        return suggestion;
      }
      if (suggestion.anchor.start < anchor.end) {
        return suggestion;
      }
      return {
        ...suggestion,
        anchor: {
          ...suggestion.anchor,
          start: suggestion.anchor.start + delta,
          end: suggestion.anchor.end + delta
        }
      };
    });
  }

  /**
   * Format compacting output so the original selection remains as LaTeX comments above the new text.
   * Inputs: Original selected text and the compacted replacement text.
   * Returns: A single string ready to insert back into the editor.
   */
  function buildCompactingWriteback(originalText, compactedText) {
    const commentPrefix = "% ";
    const commentedOriginal = originalText
      .split("\n")
      .map((line) => `${commentPrefix}${line}`)
      .join("\n");

    return `${commentedOriginal}\n${compactedText}`;
  }

  // ─── Accent color theming ─────────────────────────────────────────────────

  /**
   * Convert a six-digit hex color string into RGB components.
   * Inputs: `hex` in `#RRGGBB` format.
   * Returns: `[r, g, b]` or `null` if the input is invalid.
   */
  function hexToRgb(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  }

  /**
   * Blend one RGB color toward another by a fractional amount.
   * Inputs: Source RGB array, target RGB array, and mix ratio from 0 to 1.
   * Returns: A new RGB array with the blended color.
   */
  function mixRgb(rgb, target, amount) {
    return rgb.map((value, index) => {
      const mixed = value + (target[index] - value) * amount;
      return Math.max(0, Math.min(255, Math.round(mixed)));
    });
  }

  /**
   * Format an RGB tuple for CSS custom properties.
   * Inputs: `[r, g, b]`.
   * Returns: A `rgb(...)` CSS color string.
   */
  function rgbCss(rgb) {
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  /**
   * Push the configured accent color into the content-script CSS variable palette.
   * Inputs: `hex` in `#RRGGBB` format.
   * Returns: None; updates root-level CSS custom properties.
   */
  function applyAccentColor(hex) {
    if (!hex) return;
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const [r, g, b] = rgb;
    const accentStrong = mixRgb(rgb, [0, 0, 0], 0.2);
    const accentText = mixRgb(rgb, [255, 255, 255], 0.55);
    // Inline styles on :root always win over any stylesheet declaration,
    // including the extension's own content.css injection.
    const root = document.documentElement;
    root.style.setProperty("--ocla-accent", hex);
    root.style.setProperty("--ocla-accent-strong", rgbCss(accentStrong));
    root.style.setProperty("--ocla-accent-text", rgbCss(accentText));
    root.style.setProperty("--ocla-accent-light", `rgba(${r},${g},${b},0.18)`);
    root.style.setProperty("--ocla-accent-dim", `rgba(${r},${g},${b},0.4)`);
    root.style.setProperty("--ocla-accent-soft", `rgba(${r},${g},${b},0.08)`);
    root.style.setProperty("--ocla-accent-hover", `rgba(${r},${g},${b},0.28)`);
    root.style.setProperty("--ocla-accent-glow", `rgba(${r},${g},${b},0.6)`);
    root.style.setProperty("--ocla-accent-glow-clear", `rgba(${r},${g},${b},0)`);
  }

  browser.storage.local.get(["settings", "accentColor"], ({ settings, accentColor }) => {
    const resolvedAccent = settings?.accentColor || accentColor;
    if (resolvedAccent) applyAccentColor(resolvedAccent);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.settings?.newValue?.accentColor) {
      applyAccentColor(changes.settings.newValue.accentColor);
      return;
    }

    if (changes.accentColor?.newValue) {
      applyAccentColor(changes.accentColor.newValue);
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────

  /**
   * Wait for the Overleaf editor DOM to be ready.
   * Overleaf is a SPA — the CodeMirror editor may load well after the page shell.
   * We wait for .cm-editor (CodeMirror 6) which is the reliable signal.
   */
  /**
   * Poll until Overleaf's editor and sidebar shell are available.
   * Inputs: Callback to run when ready, retry count, and delay between retries in ms.
   * Returns: None; invokes `callback` once the page is ready or logs a warning after timeout.
   */
  function waitForEditor(callback, retries = 40, delay = 500) {
    const check = () => {
      const hasEditor   = !!document.querySelector(".cm-editor");
      const hasFileTree = !!document.querySelector(".file-tree-inner, #file-tree, [class*='file-tree-inner']");
      // Outline may not exist in all documents; don't block on it.
      if (hasEditor && hasFileTree) {
        callback();
      } else if (retries > 0) {
        retries--;
        setTimeout(check, delay);
      } else {
        console.warn("[Overleaf AI] Editor not found after waiting.");
      }
    };
    check();
  }

  /**
   * Normalize raw storage values into the current per-provider settings schema.
   * Inputs: Raw values returned from `browser.storage.local.get(...)`.
   * Returns: A settings object with defaults filled in for every provider.
   */
  function normalizeSettings(raw) {
    if (raw.settings?.providers) {
      return {
        provider: raw.settings.provider || DEFAULTS.provider,
        providers: {
          anthropic: { ...DEFAULTS.providers.anthropic, ...(raw.settings.providers.anthropic || {}) },
          gemini: { ...DEFAULTS.providers.gemini, ...(raw.settings.providers.gemini || {}) },
          openrouter: { ...DEFAULTS.providers.openrouter, ...(raw.settings.providers.openrouter || {}) }
        }
      };
    }

    return {
      provider: raw.provider || DEFAULTS.provider,
      providers: {
        anthropic: {
          ...DEFAULTS.providers.anthropic,
          apiKey: raw.apiKeys?.anthropic || "",
          model: raw.provider === "anthropic" && raw.model ? raw.model : DEFAULTS.providers.anthropic.model
        },
        gemini: {
          ...DEFAULTS.providers.gemini,
          apiKey: raw.apiKeys?.gemini || "",
          model: raw.provider === "gemini" && raw.model ? raw.model : DEFAULTS.providers.gemini.model
        },
        openrouter: {
          ...DEFAULTS.providers.openrouter,
          apiKey: raw.apiKeys?.openrouter || "",
          model: raw.provider === "openrouter" && raw.model ? raw.model : DEFAULTS.providers.openrouter.model
        }
      }
    };
  }

  /**
   * Capture the currently rendered CodeMirror lines keyed by their scroll position.
   * Inputs: Editor scroller element and a map collecting `top -> lineText`.
   * Returns: None; mutates `linesByTop` in place.
   */
  function collectVisibleLines(scroller, linesByTop) {
    const scrollerRect = scroller.getBoundingClientRect();
    const lines = scroller.querySelectorAll(".cm-line");
    lines.forEach((line) => {
      const rect = line.getBoundingClientRect();
      const absoluteTop = Math.round(rect.top - scrollerRect.top + scroller.scrollTop);
      if (rect.height <= 0) return;
      linesByTop.set(absoluteTop, line.textContent);
    });
  }

  /**
   * Wait for two animation frames so scroll-driven DOM updates have landed.
   * Inputs: None.
   * Returns: A promise that resolves after the next paint cycle.
   */
  function waitForPaint() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  /**
   * Run an editor edit while suppressing stale-analysis invalidation callbacks.
   * Inputs: Function that performs the editor mutation.
   * Returns: A promise resolving to the edit function's result, or `false` if it throws.
   */
  async function performTrackedEditorEdit(editFn) {
    state.isApplyingEdit = true;
    try {
      return editFn();
    } catch (_) {
      return false;
    } finally {
      await waitForPaint();
      state.isApplyingEdit = false;
    }
  }

  /**
   * Build line-based lookup tables for mapping flat offsets into document positions.
   * Inputs: Full analyzed text.
   * Returns: `{ lines, lineStarts }` derived from the text.
   */
  function buildTextIndex(text) {
    const lines = text.split("\n");
    const lineStarts = [];
    let offset = 0;

    lines.forEach((line) => {
      lineStarts.push(offset);
      offset += line.length + 1;
    });

    return { lines, lineStarts };
  }

  /**
   * Create a stable enough UI id for a suggestion card/highlight pair.
   * Inputs: The suggestion's array index within the current response.
   * Returns: A unique-ish string identifier.
   */
  function createSuggestionId(index) {
    return `s-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
  }

  waitForEditor(() => {
    if (window.__oclaHighlights) window.__oclaHighlights.init();
    if (window.__oclaSidebar)    window.__oclaSidebar.init();
    attachEditorChangeObserver();
    observeEditorRebuild();
  });

  /**
   * Overleaf is a SPA: switching files tears down and recreates .cm-editor.
   *
   * - highlights.js needs to re-init (new .cm-scroller, stale positions).
   * - sidebar.js panel lives in the LEFT sidebar which persists across file
   *   switches, so its init() guard (document.body.contains check) will skip
   *   re-injection correctly when the panel is still live.
   *   If Overleaf ever rebuilds the sidebar too, the guard detects the
   *   detached element and re-injects.
   */
  /**
   * Detect CodeMirror teardown/rebuild events when Overleaf switches files.
   * Inputs: None.
   * Returns: None; reinitializes extension UI state after the new editor mounts.
   */
  function observeEditorRebuild() {
    let debounceTimer = null;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          const isEditor = node.classList?.contains("cm-editor");
          const hasEditor = !isEditor && node.querySelector?.(".cm-editor");
          if (!isEditor && !hasEditor) continue;

          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            state.suggestions = [];
            state.isLoading   = false;
            state.isStale     = false;
            state.compactRange = null;
            state.analysisContext = null;

            // File switches invalidate every cached range and anchor-backed overlay.
            if (window.__oclaHighlights) window.__oclaHighlights.init();
            if (window.__oclaSidebar) {
              window.__oclaSidebar.init();
              window.__oclaSidebar.clearResults();
            }
            attachEditorChangeObserver();
          }, 150);
          return;
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  let observedEditor = null;
  let editorChangeObserver = null;

  /**
   * Watch the current `.cm-content` subtree for user edits that invalidate analysis anchors.
   * Inputs: None.
   * Returns: None; installs or refreshes the editor mutation observer.
   */
  function attachEditorChangeObserver() {
    const cmContent = document.querySelector(".cm-content");
    if (!cmContent || observedEditor === cmContent) return;

    observedEditor = cmContent;
    editorChangeObserver?.disconnect();
    editorChangeObserver = new MutationObserver((mutations) => {
      const changed = mutations.some((mutation) =>
        mutation.type === "characterData" ||
        mutation.addedNodes.length > 0 ||
        mutation.removedNodes.length > 0
      );
      if (changed) {
        window.__oclaContent?.onEditorChanged();
      }
    });
    editorChangeObserver.observe(cmContent, {
      characterData: true,
      childList: true,
      subtree: true
    });
  }

})();
