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
  function findAncestorChild(el, ancestor) {
    let node = el;
    while (node && node.parentElement !== ancestor) {
      node = node.parentElement;
    }
    return node && node.parentElement === ancestor ? node : null;
  }

  // ─── Panel injection ──────────────────────────────────────────────────────

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
    modeSelect.addEventListener("change", () => window.__oclaContent?.onModeChange(modeSelect.value));
    panelEl.querySelector("#ocla-clear").addEventListener("click", () => {
      window.__oclaContent?.onClearHighlights();
      resetResults();
    });
  }

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

  function openPanel() {
    if (!panelEl) return;
    panelEl.classList.remove("ocla-panel-hidden");
    isOpen = true;
    document.getElementById(TAB_ID)?.classList.add("ocla-tab-btn-active");
  }

  function closePanel() {
    if (!panelEl) return;
    panelEl.classList.add("ocla-panel-hidden");
    isOpen = false;
    document.getElementById(TAB_ID)?.classList.remove("ocla-tab-btn-active");
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

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

  function showError(message) {
    if (!statusEl) return;
    openPanel();
    statusEl.textContent = message;
    statusEl.className   = "ocla-status-msg ocla-status-error";
    statusEl.hidden      = false;
    setTimeout(() => { if (statusEl) statusEl.hidden = true; }, 6000);
  }

  function hideStatus() {
    if (statusEl) statusEl.hidden = true;
  }

  // ─── Render suggestions ───────────────────────────────────────────────────

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

      suggestions.forEach((s, idx) => resultsEl.appendChild(buildCard(s, idx)));
    }

    if (lastUsage) {
      usageEl.hidden = false;
      usageEl.innerHTML = `
        <span>Last: ${lastUsage.inputTokens.toLocaleString()} in / ${lastUsage.outputTokens.toLocaleString()} out</span>
        <span class="ocla-usage-sep">·</span>
        <span>Session: ${totalIn.toLocaleString()} / ${totalOut.toLocaleString()}</span>
      `;
    }
  }

  function buildCard(suggestion, index) {
    const TYPE_CLASS = { typo: "ocla-type-typo", grammar: "ocla-type-grammar", style: "ocla-type-style" };
    const typeClass  = TYPE_CLASS[suggestion.type] || "ocla-type-grammar";

    const card = document.createElement("div");
    card.className     = "ocla-card";
    card.dataset.index = index;
    card.innerHTML = `
      <div class="ocla-card-top">
        <span class="ocla-type-badge ${typeClass}">${escapeHtml((suggestion.type || "issue").toUpperCase())}</span>
      </div>
      <div class="ocla-card-diff">
        <span class="ocla-text ocla-text-error">${escapeHtml(suggestion.original || "")}</span>
        <span class="ocla-arrow">→</span>
        <span class="ocla-text ocla-text-success">${escapeHtml(suggestion.suggestion || "")}</span>
      </div>
      <div class="ocla-expl">${escapeHtml(suggestion.explanation || "")}</div>
      <div class="ocla-card-actions">
        <button class="ocla-action-btn ocla-accept-btn" title="Apply this suggestion">✓ Accept</button>
        <button class="ocla-action-btn ocla-reject-btn" title="Dismiss this suggestion">✗ Reject</button>
      </div>
    `;

    // Clicking the card body (not the action buttons) jumps to the highlight.
    card.addEventListener("click", (e) => {
      if (!e.target.closest(".ocla-card-actions")) {
        window.__oclaHighlights?.scrollToHighlight(index);
      }
    });

    card.querySelector(".ocla-accept-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      window.__oclaContent?.onAcceptSuggestion(index);
    });

    card.querySelector(".ocla-reject-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      window.__oclaContent?.onRejectSuggestion(index);
    });

    return card;
  }

  function removeSuggestion(index) {
    const card = resultsEl?.querySelector(`[data-index="${index}"]`);
    if (card) card.remove();
    // If no cards remain, show the empty state.
    if (resultsEl && !resultsEl.querySelector(".ocla-card")) {
      resultsEl.innerHTML = `<div class="ocla-empty-state ocla-success">✓ All suggestions resolved!</div>`;
    }
  }

  function resetResults() {
    if (resultsEl) resultsEl.innerHTML = `<div class="ocla-empty-state">Run a check to see suggestions here.</div>`;
    if (usageEl)   usageEl.hidden = true;
    hideStatus();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    // If our panel is already live in the DOM, nothing to do.
    const existing = document.getElementById(PANEL_ID);
    if (existing && document.body.contains(existing)) return;

    // Reset module state (handles file-switch re-init).
    panelEl = resultsEl = statusEl = usageEl = checkDocBtn = checkSelBtn = modeSelect = null;
    hostEl  = null;
    isOpen  = false;

    const els = findSidebarElements();
    if (!els) {
      console.warn("[Overleaf AI] Could not find sidebar elements — retrying.");
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

  window.__oclaSidebar = { init, setLoading, showError, renderSuggestions, removeSuggestion };

})();
