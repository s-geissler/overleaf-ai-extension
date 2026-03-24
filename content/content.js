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
    lastUsage: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    compactRange: null      // saved selection Range for compacting mode
  };

  // ─── CodeMirror Text Extraction ──────────────────────────────────────────

  /**
   * Extract the full document text from a CodeMirror 6 editor.
   * Overleaf renders each line as a .cm-line inside .cm-content.
   * We join them with newlines to reconstruct the source.
   */
  function extractFullText() {
    const cmContent = document.querySelector(".cm-content");
    if (!cmContent) return null;

    const lines = cmContent.querySelectorAll(".cm-line");
    if (lines.length === 0) return null;

    return Array.from(lines).map(line => line.textContent).join("\n");
  }

  /**
   * Extract currently selected text from the CodeMirror editor.
   * Falls back to window.getSelection() which works across DOM.
   */
  function extractSelectedText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;

    const selected = selection.toString().trim();
    return selected.length > 0 ? selected : null;
  }

  // ─── API Communication ────────────────────────────────────────────────────

  async function getSettings() {
    return new Promise(resolve => {
      browser.storage.local.get(["provider", "apiKeys", "model"], resolve);
    });
  }

  async function runAnalysis(text) {
    state.isLoading = true;
    window.__oclaSidebar.setLoading(true);

    try {
      const { provider, apiKeys, model } = await getSettings();
      const activeProvider = provider || "anthropic";
      const apiKey = (apiKeys && apiKeys[activeProvider]) || "";
      const activeModel = model || "claude-haiku-4-5-20251001";

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
        window.__oclaSidebar.renderCompactResult(response.data.compacted, response.data.explanation, state.lastUsage, state.totalInputTokens, state.totalOutputTokens);
      } else {
        state.suggestions = response.data.suggestions;
        window.__oclaSidebar.renderSuggestions(state.suggestions, state.lastUsage, state.totalInputTokens, state.totalOutputTokens);
        window.__oclaHighlights.applyHighlights(state.suggestions);
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
    onCheckDocument() {
      if (state.isLoading) return;
      const text = extractFullText();
      if (!text) {
        window.__oclaSidebar.showError("Could not find the Overleaf editor. Make sure a project is open.");
        return;
      }
      runAnalysis(text);
    },

    onCheckSelection() {
      if (state.isLoading) return;
      const text = extractSelectedText();
      if (!text) {
        window.__oclaSidebar.showError("No text selected. Select some text in the editor first.");
        return;
      }
      // Capture the selection range now — it will be lost once the panel focuses or API returns.
      if (state.mode === "compacting") {
        const sel = window.getSelection();
        state.compactRange = (sel && !sel.isCollapsed) ? sel.getRangeAt(0).cloneRange() : null;
      }
      runAnalysis(text);
    },

    onModeChange(newMode) {
      state.mode = newMode;
    },

    onClearHighlights() {
      state.suggestions = [];
      state.compactRange = null;
      window.__oclaHighlights.clearHighlights();
    },

    onApplyCompact(compactedText) {
      if (!state.compactRange) return;
      const cmContent = document.querySelector(".cm-content");
      if (cmContent) {
        try {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(state.compactRange);
          cmContent.focus();
          document.execCommand("insertText", false, compactedText);
        } catch (_) {}
      }
      state.compactRange = null;
      window.__oclaSidebar.clearResults();
    },

    onAcceptSuggestion(index) {
      window.__oclaHighlights.acceptHighlight(index);
      state.suggestions = state.suggestions.filter((_, i) => i !== index);
      window.__oclaSidebar.removeSuggestion(index);
    },

    onRejectSuggestion(index) {
      window.__oclaHighlights.rejectHighlight(index);
      state.suggestions = state.suggestions.filter((_, i) => i !== index);
      window.__oclaSidebar.removeSuggestion(index);
    }
  };

  // ─── Accent color theming ─────────────────────────────────────────────────

  function hexToRgb(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  }

  function applyAccentColor(hex) {
    if (!hex) return;
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const [r, g, b] = rgb;
    // Inline styles on :root always win over any stylesheet declaration,
    // including the extension's own content.css injection.
    const root = document.documentElement;
    root.style.setProperty("--ocla-accent", hex);
    root.style.setProperty("--ocla-accent-light", `rgba(${r},${g},${b},0.18)`);
    root.style.setProperty("--ocla-accent-dim", `rgba(${r},${g},${b},0.4)`);
  }

  browser.storage.local.get("accentColor", ({ accentColor }) => {
    if (accentColor) applyAccentColor(accentColor);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.accentColor) {
      applyAccentColor(changes.accentColor.newValue);
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────

  /**
   * Wait for the Overleaf editor DOM to be ready.
   * Overleaf is a SPA — the CodeMirror editor may load well after the page shell.
   * We wait for .cm-editor (CodeMirror 6) which is the reliable signal.
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

  waitForEditor(() => {
    if (window.__oclaHighlights) window.__oclaHighlights.init();
    if (window.__oclaSidebar)    window.__oclaSidebar.init();
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

            if (window.__oclaHighlights) window.__oclaHighlights.init();
            if (window.__oclaSidebar)    window.__oclaSidebar.init();
          }, 150);
          return;
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

})();
