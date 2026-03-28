/**
 * sidebar.js — Integrates the AI Assistant into Overleaf's left sidebar.
 *
 * Injects:
 *  1. A "✦ AI" tab button into the left icon strip, below the Comments button.
 *  2. A panel that overlays the File Outline area (bottom-left pane) so the
 *     file tree remains visible simultaneously.
 *
 * The overlay approach means we never modify Overleaf's own panel state —
 * their panels stay intact beneath ours, and reappear when another tab is picked.
 */

(function () {
  "use strict";

  const PANEL_ID  = "ocla-panel";
  const TAB_ID    = "ocla-tab-btn";
  const HOST_CLASS = "ocla-sidebar-host"; // marks the container we overlay

  let panelEl     = null;
  let resultsEl   = null;
  let statusEl    = null;
  let usageEl     = null;
  let checkDocBtn = null;
  let checkSelBtn = null;
  let modeSelect  = null;
  let isOpen      = false;
  let hostEl      = null; // the sidebar content container we overlay

  // ─── Sidebar element detection ────────────────────────────────────────────
  //
  // Target:
  //   panelBody  — the File Outline pane (bottom-left), which our AI panel overlays.
  //   iconStrip  — the narrow icon rail on the far left.
  //   commentsBtn — the Comments/Review button; we insert our tab after it.

  /**
   * Locate the Overleaf sidebar elements needed to inject the assistant UI.
   * Inputs: None.
   * Returns: `{ panelBody, iconStrip, commentsBtn }` or `null` if the layout is not ready.
   */
  function findSidebarElements() {
    // ── 1. Find the File Outline panel ──────────────────────────────────────
    const panelBody = findOutlinePanel();
    if (!panelBody) return null;

    // ── 2. Find the icon strip ───────────────────────────────────────────────
    const iconStrip = findIconStrip();

    // ── 3. Find the Comments / Review button inside the icon strip ───────────
    const commentsBtn = findCommentsButton(iconStrip);

    return { panelBody, iconStrip, commentsBtn };
  }

  /**
   * Find the File Outline pane specifically.
   *
   * Strategy: locate the outline content element, then walk up ONLY until we
   * are about to cross into an ancestor that also contains the file tree.
   * That ensures we host only the outline area, not the whole sidebar.
   */
  /**
   * Find the sidebar pane that hosts the document outline.
   * Inputs: None.
   * Returns: The DOM element to overlay with the AI panel, or `null` if not found.
   */
  function findOutlinePanel() {
    const OUTLINE_SELECTORS = [
      "[class*='outline-container']",
      "[class*='file-outline']",
      "[class*='outline-panel']",
      "[class*='document-outline']",
      "[class*='outline-root']",
      "[data-ol-outline]",
    ];

    const fileTreeAnchor = document.querySelector(
      ".file-tree-inner, #file-tree, [class*='file-tree-inner']"
    );

    for (const sel of OUTLINE_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;

      // Walk upward from the outline element, stopping the moment the candidate
      // ancestor also contains the file tree (we'd overshoot into the shared wrapper).
      let container = el;
      while (container.parentElement && container.parentElement !== document.body) {
        const parent = container.parentElement;
        // Stop if this parent also wraps the file tree.
        if (fileTreeAnchor && parent.contains(fileTreeAnchor)) break;
        // Stop if the parent is implausibly tall (whole-page ancestor).
        if (parent.offsetHeight > window.innerHeight * 0.85) break;
        container = parent;
      }
      if (container.offsetHeight > 30) return container;
    }

    // Fallback: find two vertically-stacked children in the sidebar and take
    // the lower one (the outline pane sits beneath the file tree).
    return findBottomSidebarPane(fileTreeAnchor);
  }

  /**
   * Fallback detector for the lower sidebar pane beneath the file tree.
   * Inputs: `fileTreeAnchor` pointing at the file tree container.
   * Returns: The lower sidebar pane element, or `null` when no plausible split is found.
   */
  function findBottomSidebarPane(fileTreeAnchor) {
    if (!fileTreeAnchor) return null;

    let split = fileTreeAnchor.parentElement;
    while (split && split !== document.body) {
      const kids = Array.from(split.children).filter(
        c => c.offsetHeight > 40 && c.offsetWidth > 80
      );
      if (kids.length >= 2) {
        // The lower child is the outline pane.
        return kids[kids.length - 1];
      }
      split = split.parentElement;
    }
    return null;
  }

  /**
   * Find the left-hand icon rail used for sidebar tabs.
   * Inputs: None.
   * Returns: The icon strip element, or `null` if Overleaf has not rendered it yet.
   */
  function findIconStrip() {
    // Attribute-based selectors (most stable across Overleaf versions).
    const byAttr = document.querySelector(
      "[role='tablist'], [class*='panel-switcher'], [class*='sidebar-tab'], " +
      "[class*='ide-panel-switcher'], .nav-pills.nav-stacked, [class*='sidebar-icons']"
    );
    if (byAttr) return byAttr;

    // Fallback: a narrow (<80px wide), tall element near the left edge.
    const fileTree = document.querySelector(".file-tree-inner, #file-tree");
    if (!fileTree) return null;
    let el = fileTree.parentElement;
    while (el && el !== document.body) {
      for (const sibling of el.parentElement?.children ?? []) {
        if (sibling === el) continue;
        if (sibling.offsetWidth > 10 && sibling.offsetWidth < 80) return sibling;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Find the existing Comments or Review tab to position the AI tab next to it.
   * Inputs: `iconStrip` DOM element containing sidebar tab controls.
   * Returns: The matching button-like element, or `null` if none is found.
   */
  function findCommentsButton(iconStrip) {
    if (!iconStrip) return null;
    // Cast a wide net: check all clickable descendants for review/comment text.
    const candidates = iconStrip.querySelectorAll("button, a, [role='tab'], li");
    for (const el of candidates) {
      const check = [
        el.title, el.getAttribute("aria-label"), el.getAttribute("data-testid"),
        el.textContent,
      ].join(" ").toLowerCase();
      if (check.includes("review") || check.includes("comment")) return el;
    }
    return null;
  }

  // ─── Tab button injection ─────────────────────────────────────────────────

  /**
   * Insert the AI Assistant tab button into Overleaf's left icon strip.
   * Inputs: `iconStrip` container and an optional `commentsBtn` anchor for placement.
   * Returns: None; updates the sidebar tab DOM if the button is not already present.
   */
  function injectTabButton(iconStrip, commentsBtn) {
    if (document.getElementById(TAB_ID)) return;

    const btn = document.createElement("button");
    btn.id        = TAB_ID;
    btn.type      = "button";
    btn.title     = "AI Assistant";
    btn.className = "ocla-tab-btn";
    btn.innerHTML = `<span class="ocla-tab-icon">✦</span><span class="ocla-tab-label">AI</span>`;
    btn.addEventListener("click", () => {
      if (isOpen) closePanel();
      else openPanel();
    });

    // Insert immediately after the Comments button; fall back to appending.
    if (commentsBtn && commentsBtn.parentElement === iconStrip) {
      commentsBtn.insertAdjacentElement("afterend", btn);
    } else if (commentsBtn) {
      // Comments button is a child of a list item or wrapper — insert after its parent.
      const insertAfter = findAncestorChild(commentsBtn, iconStrip);
      if (insertAfter) insertAfter.insertAdjacentElement("afterend", btn);
      else iconStrip.appendChild(btn);
    } else {
      iconStrip.appendChild(btn);
    }

    // Close our panel whenever the user clicks any other tab in the strip.
    iconStrip.addEventListener("click", (e) => {
      if (!e.target.closest(`#${TAB_ID}`)) closePanel();
    }, true);
  }

  /** Return the child of `ancestor` that contains `el`, or null. */
  /**
   * Find the direct child of `ancestor` that contains `el`.
   * Inputs: A descendant element and the ancestor to stop at.
   * Returns: The direct child wrapper used for insertion, or `null`.
   */
  function findAncestorChild(el, ancestor) {
    let node = el;
    while (node && node.parentElement !== ancestor) {
      node = node.parentElement;
    }
    return node && node.parentElement === ancestor ? node : null;
  }

  // ─── Panel injection ──────────────────────────────────────────────────────

  /**
   * Inject the assistant panel into the detected outline pane and wire its controls.
   * Inputs: `panelBody` element that will host the overlay panel.
   * Returns: None; populates module-level references to the panel controls.
   */
  function injectPanel(panelBody) {
    if (document.getElementById(PANEL_ID)) return;

    // The panel body must be position:relative so our absolute panel overlays it.
    panelBody.classList.add(HOST_CLASS);
    hostEl = panelBody;

    panelEl = buildPanel();
    panelBody.appendChild(panelEl);

    // Wire controls
    resultsEl   = panelEl.querySelector(".ocla-results");
    statusEl    = panelEl.querySelector(".ocla-status-msg");
    usageEl     = panelEl.querySelector(".ocla-usage");
    checkDocBtn = panelEl.querySelector("#ocla-check-doc");
    checkSelBtn = panelEl.querySelector("#ocla-check-sel");
    modeSelect  = panelEl.querySelector("#ocla-mode");

    checkDocBtn.addEventListener("click", () => window.__oclaContent?.onCheckDocument());
    checkSelBtn.addEventListener("click", () => window.__oclaContent?.onCheckSelection());
    modeSelect.addEventListener("change", () => {
      const mode = modeSelect.value;
      window.__oclaContent?.onModeChange(mode);
      const compacting = mode === "compacting";
      checkDocBtn.disabled = compacting;
      checkDocBtn.title = compacting ? "Compacting is only available for a selection" : "";
    });
    panelEl.querySelector("#ocla-clear").addEventListener("click", () => {
      window.__oclaContent?.onClearHighlights();
      resetResults();
    });
  }

  /**
   * Build the assistant sidebar panel markup.
   * Inputs: None.
   * Returns: The root DOM element for the injected panel.
   */
  function buildPanel() {
    const panel = document.createElement("div");
    panel.id        = PANEL_ID;
    panel.className = "ocla-panel ocla-panel-hidden";

    panel.innerHTML = `
      <div class="ocla-panel-header">
        <span class="ocla-panel-logo">✦</span>
        <span class="ocla-panel-title">AI Assistant</span>
      </div>

      <div class="ocla-panel-controls">
        <label class="ocla-ctrl-label">Mode</label>
        <select id="ocla-mode" class="ocla-select">
          <option value="proofreading">Proofreading</option>
          <option value="style">Style</option>
          <option value="factchecking">Fact Checking</option>
          <option value="compacting">Compacting</option>
        </select>
        <button id="ocla-check-doc" class="ocla-btn ocla-btn-primary">Check Document</button>
        <button id="ocla-check-sel" class="ocla-btn ocla-btn-secondary">Check Selection</button>
        <button id="ocla-clear" class="ocla-btn ocla-btn-ghost">Clear highlights</button>
      </div>

      <div class="ocla-status-msg" hidden></div>

      <div class="ocla-results">
        <div class="ocla-empty-state">Run a check to see suggestions here.</div>
      </div>

      <div class="ocla-usage" hidden></div>
    `;

    return panel;
  }

  // ─── Open / Close ─────────────────────────────────────────────────────────

  /**
   * Show the assistant panel and mark the AI tab as active.
   * Inputs: None.
   * Returns: None.
   */
  function openPanel() {
    if (!panelEl) return;
    panelEl.classList.remove("ocla-panel-hidden");
    isOpen = true;
    document.getElementById(TAB_ID)?.classList.add("ocla-tab-btn-active");
  }

  /**
   * Hide the assistant panel and clear the AI tab active state.
   * Inputs: None.
   * Returns: None.
   */
  function closePanel() {
    if (!panelEl) return;
    panelEl.classList.add("ocla-panel-hidden");
    isOpen = false;
    document.getElementById(TAB_ID)?.classList.remove("ocla-tab-btn-active");
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  /**
   * Toggle the loading state for the analysis buttons and results area.
   * Inputs: Boolean `loading` flag.
   * Returns: None; updates button state and the loading placeholder.
   */
  function setLoading(loading) {
    if (!checkDocBtn) return;
    checkDocBtn.disabled = loading;
    checkSelBtn.disabled = loading;

    if (loading) {
      openPanel();
      resultsEl.innerHTML = `
        <div class="ocla-loading">
          <div class="ocla-spinner"></div>
          <span>Analyzing…</span>
        </div>`;
      usageEl.hidden = true;
      hideStatus();
    }
  }

  // ─── Error ────────────────────────────────────────────────────────────────

  /**
   * Display a temporary error message in the sidebar panel.
   * Inputs: User-facing error message string.
   * Returns: None; opens the panel and shows the status banner.
   */
  function showError(message) {
    if (!statusEl) return;
    openPanel();
    statusEl.textContent = message;
    statusEl.className   = "ocla-status-msg ocla-status-error";
    statusEl.hidden      = false;
    setTimeout(() => { if (statusEl) statusEl.hidden = true; }, 6000);
  }

  /**
   * Hide the transient status banner.
   * Inputs: None.
   * Returns: None.
   */
  function hideStatus() {
    if (statusEl) statusEl.hidden = true;
  }

  // ─── Render suggestions ───────────────────────────────────────────────────

  /**
   * Render a list of suggestion cards and token usage in the sidebar.
   * Inputs: Suggestion array, last request usage, and running session token totals.
   * Returns: None; replaces the results area contents.
   */
  function renderSuggestions(suggestions, lastUsage, totalIn, totalOut) {
    hideStatus();
    openPanel();

    if (!suggestions || suggestions.length === 0) {
      resultsEl.innerHTML = `<div class="ocla-empty-state ocla-success">✓ No issues found!</div>`;
    } else {
      resultsEl.innerHTML = "";

      const countEl = document.createElement("div");
      countEl.className   = "ocla-count";
      countEl.textContent = `${suggestions.length} suggestion${suggestions.length !== 1 ? "s" : ""}`;
      resultsEl.appendChild(countEl);

      suggestions.forEach((s) => resultsEl.appendChild(buildCard(s)));
    }

    if (lastUsage) {
      usageEl.hidden = false;
      usageEl.textContent = "";
      const last = document.createElement("span");
      last.textContent = `Last: ${lastUsage.inputTokens.toLocaleString()} in / ${lastUsage.outputTokens.toLocaleString()} out`;
      const sep = document.createElement("span");
      sep.className = "ocla-usage-sep";
      sep.textContent = "·";
      const session = document.createElement("span");
      session.textContent = `Session: ${totalIn.toLocaleString()} / ${totalOut.toLocaleString()}`;
      usageEl.append(last, sep, session);
    }
  }

  /**
   * Render the compacted-text result card with apply and discard actions.
   * Inputs: Compacted text, explanation, last request usage, and session token totals.
   * Returns: None; replaces the results area contents.
   */
  function renderCompactResult(compactedText, explanation, lastUsage, totalIn, totalOut) {
    hideStatus();
    openPanel();
    resultsEl.textContent = "";

    const card = document.createElement("div");
    card.className = "ocla-card ocla-compact-card";

    const top = document.createElement("div");
    top.className = "ocla-card-top";
    const badge = document.createElement("span");
    badge.className = "ocla-type-badge ocla-type-compact";
    badge.textContent = "COMPACTED";
    top.appendChild(badge);

    const preview = document.createElement("div");
    preview.className = "ocla-compact-preview";
    preview.textContent = compactedText;

    const expl = document.createElement("div");
    expl.className = "ocla-expl";
    expl.textContent = explanation || "";

    const actions = document.createElement("div");
    actions.className = "ocla-card-actions ocla-compact-actions";
    const applyBtn = document.createElement("button");
    applyBtn.className = "ocla-action-btn ocla-accept-btn";
    applyBtn.title = "Replace selection with compacted text";
    applyBtn.textContent = "✓ Apply";
    const discardBtn = document.createElement("button");
    discardBtn.className = "ocla-action-btn ocla-reject-btn";
    discardBtn.title = "Discard compacted result";
    discardBtn.textContent = "✗ Discard";
    actions.append(applyBtn, discardBtn);

    card.append(top, preview, expl, actions);

    applyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.__oclaContent?.onApplyCompact(compactedText);
    });
    discardBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.__oclaContent?.onClearHighlights();
      resetResults();
    });

    resultsEl.appendChild(card);

    if (lastUsage) {
      usageEl.hidden = false;
      usageEl.textContent = "";
      const last = document.createElement("span");
      last.textContent = `Last: ${lastUsage.inputTokens.toLocaleString()} in / ${lastUsage.outputTokens.toLocaleString()} out`;
      const sep = document.createElement("span");
      sep.className = "ocla-usage-sep";
      sep.textContent = "·";
      const session = document.createElement("span");
      session.textContent = `Session: ${totalIn.toLocaleString()} / ${totalOut.toLocaleString()}`;
      usageEl.append(last, sep, session);
    }
  }

  /**
   * Build one suggestion card and wire its jump, accept, and reject actions.
   * Inputs: A normalized suggestion object with id, type, original, suggestion, and explanation.
   * Returns: The DOM element representing the card.
   */
  function buildCard(suggestion) {
    const TYPE_CLASS = { typo: "ocla-type-typo", grammar: "ocla-type-grammar", style: "ocla-type-style", factual: "ocla-type-factual" };
    const typeClass  = TYPE_CLASS[suggestion.type] || "ocla-type-grammar";

    const card = document.createElement("div");
    card.className     = "ocla-card";
    card.dataset.suggestionId = suggestion.id;
    const top = document.createElement("div");
    top.className = "ocla-card-top";
    const badge = document.createElement("span");
    badge.className = `ocla-type-badge ${typeClass}`;
    badge.textContent = (suggestion.type || "issue").toUpperCase();
    top.appendChild(badge);

    const diff = document.createElement("div");
    diff.className = "ocla-card-diff";
    const orig = document.createElement("span");
    orig.className = "ocla-text ocla-text-error";
    orig.textContent = suggestion.original || "";
    const arrow = document.createElement("span");
    arrow.className = "ocla-arrow";
    arrow.textContent = "→";
    const sugg = document.createElement("span");
    sugg.className = "ocla-text ocla-text-success";
    sugg.textContent = suggestion.suggestion || "";
    diff.append(orig, arrow, sugg);

    const expl = document.createElement("div");
    expl.className = "ocla-expl";
    expl.textContent = suggestion.explanation || "";

    const actions = document.createElement("div");
    actions.className = "ocla-card-actions";
    const acceptBtn = document.createElement("button");
    acceptBtn.className = "ocla-action-btn ocla-accept-btn";
    acceptBtn.title = "Apply this suggestion";
    acceptBtn.textContent = "✓ Accept";
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "ocla-action-btn ocla-reject-btn";
    rejectBtn.title = "Dismiss this suggestion";
    rejectBtn.textContent = "✗ Reject";
    actions.append(acceptBtn, rejectBtn);

    card.append(top, diff, expl, actions);

    // Clicking the card body (not the action buttons) jumps to the highlight.
    card.addEventListener("click", (e) => {
      if (!e.target.closest(".ocla-card-actions")) {
        window.__oclaHighlights?.scrollToHighlight(suggestion.id);
      }
    });

    acceptBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.__oclaContent?.onAcceptSuggestion(suggestion.id);
    });

    rejectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.__oclaContent?.onRejectSuggestion(suggestion.id);
    });

    return card;
  }

  /**
   * Remove a suggestion card from the sidebar after accept or reject.
   * Inputs: Suggestion id string.
   * Returns: None; updates the results area and shows the resolved state if empty.
   */
  function removeSuggestion(id) {
    const card = resultsEl?.querySelector(`[data-suggestion-id="${id}"]`);
    if (card) card.remove();
    // If no cards remain, show the empty state.
    if (resultsEl && !resultsEl.querySelector(".ocla-card")) {
      resultsEl.innerHTML = `<div class="ocla-empty-state ocla-success">✓ All suggestions resolved!</div>`;
    }
  }

  /**
   * Reset the sidebar results area to its initial empty state.
   * Inputs: None.
   * Returns: None; clears usage text and hides status messages.
   */
  function resetResults() {
    if (resultsEl) resultsEl.innerHTML = `<div class="ocla-empty-state">Run a check to see suggestions here.</div>`;
    if (usageEl)   usageEl.hidden = true;
    hideStatus();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Escape HTML special characters in a string.
   * Inputs: Raw string value.
   * Returns: A safely escaped HTML string.
   */
  function escapeHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  /**
   * Public entry point — always resets module state so file-switch re-inits
   * start clean, then delegates to tryInit() which retries up to 12 times
   * (every 500 ms) while Overleaf's SPA finishes rendering the sidebar.
   */
  /**
   * Reinitialize sidebar module state and begin locating the host DOM.
   * Inputs: None.
   * Returns: None; schedules sidebar injection retries until the layout is ready.
   */
  function init() {
    panelEl = resultsEl = statusEl = usageEl = checkDocBtn = checkSelBtn = modeSelect = null;
    hostEl  = null;
    isOpen  = false;
    tryInit(0);
  }

  /**
   * Retry sidebar injection while Overleaf's SPA layout is still rendering.
   * Inputs: Retry attempt count.
   * Returns: None; injects the tab and panel once the required elements appear.
   */
  function tryInit(attempt) {
    // Panel already live — nothing to do.
    const existing = document.getElementById(PANEL_ID);
    if (existing && document.body.contains(existing)) return;

    const els = findSidebarElements();
    if (!els) {
      if (attempt < 12) setTimeout(() => tryInit(attempt + 1), 500);
      return;
    }

    const { panelBody, iconStrip, commentsBtn } = els;

    if (iconStrip) {
      const existingTab = document.getElementById(TAB_ID);
      if (!existingTab || !document.body.contains(existingTab)) {
        injectTabButton(iconStrip, commentsBtn);
      }
    }

    injectPanel(panelBody);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.__oclaSidebar = { init, setLoading, showError, renderSuggestions, removeSuggestion, renderCompactResult, clearResults: resetResults };

})();
