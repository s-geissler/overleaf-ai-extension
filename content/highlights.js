/**
 * highlights.js — Inline text highlighting in the CodeMirror editor.
 * Uses a transparent overlay layer approach to avoid corrupting editor state.
 * Exposes window.__oclaHighlights for coordination with content.js.
 */

(function () {
  "use strict";

  const OVERLAY_ID = "ocla-highlight-overlay";
  const TOOLTIP_ID = "ocla-tooltip";

  let overlayEl = null;
  let tooltipEl = null;
  let currentHighlights = []; // { el, suggestion, index, range }
  let rafScheduled = false;
  let activeScroller = null;  // tracked so we can detach on re-init

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    // Clear stale highlights from a previous file — their positions are invalid.
    clearHighlights();

    // Overlay and tooltip live on body and survive file switches; only create once.
    createOverlay();
    createTooltip();

    // Global listeners are idempotent (addEventListener deduplicates same fn ref).
    window.addEventListener("resize", scheduleRepositionAll);
    window.addEventListener("scroll", scheduleRepositionAll, { passive: true });

    // Detach listener from the old .cm-scroller before attaching to the new one.
    if (activeScroller) {
      activeScroller.removeEventListener("scroll", scheduleRepositionAll);
    }
    activeScroller = document.querySelector(".cm-scroller");
    if (activeScroller) {
      activeScroller.addEventListener("scroll", scheduleRepositionAll, { passive: true });
    }
  }

  function createOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    overlayEl = document.createElement("div");
    overlayEl.id = OVERLAY_ID;
    overlayEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(overlayEl);
  }

  function createTooltip() {
    if (document.getElementById(TOOLTIP_ID)) return;
    tooltipEl = document.createElement("div");
    tooltipEl.id = TOOLTIP_ID;
    tooltipEl.setAttribute("role", "tooltip");
    tooltipEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(tooltipEl);

    // Hide tooltip when clicking elsewhere
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".ocla-highlight")) {
        hideTooltip();
      }
    });
  }

  // ─── Apply highlights ─────────────────────────────────────────────────────

  function applyHighlights(suggestions) {
    clearHighlights();
    if (!suggestions || suggestions.length === 0) return;

    const cmContent = document.querySelector(".cm-content");
    if (!cmContent) return;

    suggestions.forEach((suggestion, index) => {
      if (!suggestion.original) return;
      highlightText(suggestion, index, cmContent);
    });
  }

  /**
   * Find all occurrences of `suggestion.original` in the editor's line elements
   * and position a highlight overlay <span> over each one.
   *
   * We use a Range + getBoundingClientRect approach so the overlay floats
   * on top of the text without modifying the editor DOM.
   */
  function highlightText(suggestion, index, cmContent) {
    const needle = suggestion.original;
    if (!needle || needle.trim().length === 0) return;

    const lines = cmContent.querySelectorAll(".cm-line");
    const typeClass = getTypeClass(suggestion.type);

    for (const line of lines) {
      const lineText = line.textContent;
      const pos = lineText.indexOf(needle);
      if (pos === -1) continue;

      const range = findTextRange(line, needle, pos);
      if (!range) continue;

      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const highlight = createHighlightEl(rect, suggestion, index, typeClass);
      overlayEl.appendChild(highlight);
      currentHighlights.push({ el: highlight, suggestion, index, range });

      // Only highlight the first occurrence to avoid confusion
      break;
    }
  }

  /**
   * Create a Range that wraps `needle` text inside `lineEl`, starting at `offset`.
   * Walks text nodes to find the correct positions.
   */
  function findTextRange(lineEl, needle, startOffset) {
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    let accumulated = 0;
    let startNode = null, startNodeOffset = 0;
    let endNode = null, endNodeOffset = 0;
    const targetEnd = startOffset + needle.length;

    let node;
    while ((node = walker.nextNode())) {
      const nodeLen = node.textContent.length;
      const nodeStart = accumulated;
      const nodeEnd = accumulated + nodeLen;

      if (startNode === null && nodeEnd > startOffset) {
        startNode = node;
        startNodeOffset = startOffset - nodeStart;
      }

      if (startNode !== null && nodeEnd >= targetEnd) {
        endNode = node;
        endNodeOffset = targetEnd - nodeStart;
        break;
      }

      accumulated += nodeLen;
    }

    if (!startNode || !endNode) return null;

    try {
      const range = document.createRange();
      range.setStart(startNode, startNodeOffset);
      range.setEnd(endNode, endNodeOffset);
      return range;
    } catch (_) {
      return null;
    }
  }

  function createHighlightEl(rect, suggestion, index, typeClass) {
    const el = document.createElement("span");
    el.className = `ocla-highlight ${typeClass}`;
    el.dataset.index = index;
    el.setAttribute("aria-label", `Suggestion: ${suggestion.suggestion}`);

    positionEl(el, rect);

    el.addEventListener("mouseenter", () => showTooltip(el, suggestion));
    el.addEventListener("mouseleave", () => {
      // Small delay so user can move to tooltip
      setTimeout(() => {
        if (!tooltipEl.matches(":hover")) hideTooltip();
      }, 150);
    });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      showTooltip(el, suggestion, true);
    });

    return el;
  }

  function positionEl(el, rect) {
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    el.style.left = `${rect.left + scrollX}px`;
    el.style.top = `${rect.top + scrollY}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${Math.max(rect.height, 14)}px`;
  }

  // ─── Tooltip ──────────────────────────────────────────────────────────────

  function showTooltip(anchorEl, suggestion, pinned = false) {
    tooltipEl.textContent = "";

    const typeDiv = document.createElement("div");
    typeDiv.className = `ocla-tooltip-type ${getTypeClass(suggestion.type)}`;
    typeDiv.textContent = (suggestion.type || "issue").toUpperCase();

    const origRow = document.createElement("div");
    origRow.className = "ocla-tooltip-row";
    const origLabel = document.createElement("span");
    origLabel.className = "ocla-tooltip-label";
    origLabel.textContent = "Original:";
    const origVal = document.createElement("span");
    origVal.className = "ocla-tooltip-orig";
    origVal.textContent = suggestion.original || "";
    origRow.append(origLabel, origVal);

    const suggRow = document.createElement("div");
    suggRow.className = "ocla-tooltip-row";
    const suggLabel = document.createElement("span");
    suggLabel.className = "ocla-tooltip-label";
    suggLabel.textContent = "Suggestion:";
    const suggVal = document.createElement("span");
    suggVal.className = "ocla-tooltip-sugg";
    suggVal.textContent = suggestion.suggestion || "";
    suggRow.append(suggLabel, suggVal);

    const explDiv = document.createElement("div");
    explDiv.className = "ocla-tooltip-expl";
    explDiv.textContent = suggestion.explanation || "";

    tooltipEl.append(typeDiv, origRow, suggRow, explDiv);
    tooltipEl.setAttribute("aria-hidden", "false");
    tooltipEl.classList.toggle("ocla-tooltip-pinned", pinned);

    const anchorRect = anchorEl.getBoundingClientRect();
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;

    // Position below the highlight, fall back to above if not enough space
    const MARGIN = 8;
    let top = anchorRect.bottom + scrollY + MARGIN;
    let left = anchorRect.left + scrollX;

    tooltipEl.style.visibility = "hidden";
    tooltipEl.style.display = "block";
    const tRect = tooltipEl.getBoundingClientRect();

    if (anchorRect.bottom + tRect.height + MARGIN > window.innerHeight) {
      top = anchorRect.top + scrollY - tRect.height - MARGIN;
    }
    if (left + tRect.width > window.innerWidth + scrollX) {
      left = window.innerWidth + scrollX - tRect.width - MARGIN;
    }

    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
    tooltipEl.style.visibility = "visible";
  }

  function hideTooltip() {
    if (!tooltipEl) return;
    tooltipEl.style.display = "none";
    tooltipEl.setAttribute("aria-hidden", "true");
    tooltipEl.classList.remove("ocla-tooltip-pinned");
  }

  // ─── Reposition on scroll/resize ──────────────────────────────────────────

  function scheduleRepositionAll() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      repositionAll();
      rafScheduled = false;
    });
  }

  function repositionAll() {
    if (!currentHighlights.length) return;
    const cmContent = document.querySelector(".cm-content");
    if (!cmContent) return;

    // Re-run positioning for each highlight
    currentHighlights.forEach(({ el, suggestion, index }) => {
      const needle = suggestion.original;
      if (!needle) return;

      const lines = cmContent.querySelectorAll(".cm-line");
      for (const line of lines) {
        const lineText = line.textContent;
        const pos = lineText.indexOf(needle);
        if (pos === -1) continue;

        const range = findTextRange(line, needle, pos);
        if (!range) continue;

        const rect = range.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          positionEl(el, rect);
        }
        break;
      }
    });
  }

  // ─── Scroll to highlight ──────────────────────────────────────────────────

  function scrollToHighlight(index) {
    const entry = currentHighlights.find(h => h.index === index);
    if (!entry) return;

    const hlRect = entry.el.getBoundingClientRect();

    // Scroll the CodeMirror scroller so the highlighted text is visible,
    // positioning it roughly one-third from the top of the viewport.
    const scroller = activeScroller || document.querySelector(".cm-scroller");
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      if (hlRect.top < sr.top || hlRect.bottom > sr.bottom) {
        scroller.scrollTo({
          top: scroller.scrollTop + (hlRect.top - sr.top) - sr.height / 3,
          behavior: "smooth"
        });
      }
    }

    // Move the CodeMirror cursor to the start of the highlighted text.
    placeCursor(entry.range);

    // Flash animation
    entry.el.classList.add("ocla-highlight-pulse");
    setTimeout(() => entry.el.classList.remove("ocla-highlight-pulse"), 1200);
  }

  /** Collapse the browser selection to the start of `range` and focus CM. */
  function placeCursor(range) {
    if (!range) return;
    try {
      const sel = window.getSelection();
      const cursor = range.cloneRange();
      cursor.collapse(true);
      sel.removeAllRanges();
      sel.addRange(cursor);
      document.querySelector(".cm-content")?.focus();
    } catch (_) {}
  }

  // ─── Accept / Reject ──────────────────────────────────────────────────────

  /**
   * Replace the original text in the editor with the suggested text.
   * Uses the stored Range to select the exact span, then insertText execCommand.
   * Returns true if the replacement was applied.
   */
  function acceptHighlight(index) {
    const entry = currentHighlights.find(h => h.index === index);
    if (!entry) return false;

    // Re-find the range at accept-time to handle any editor scrolling since
    // the highlight was created.
    const cmContent = document.querySelector(".cm-content");
    let range = entry.range;

    if (cmContent) {
      const lines = cmContent.querySelectorAll(".cm-line");
      for (const line of lines) {
        const pos = line.textContent.indexOf(entry.suggestion.original);
        if (pos === -1) continue;
        const fresh = findTextRange(line, entry.suggestion.original, pos);
        if (fresh) { range = fresh; break; }
      }
    }

    let replaced = false;
    if (range && cmContent) {
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        cmContent.focus();
        // execCommand is deprecated but remains the most reliable way to drive
        // CM6's input handling from a content script without CM internals access.
        replaced = document.execCommand("insertText", false, entry.suggestion.suggestion);
      } catch (_) {}
    }

    removeHighlight(index);
    return replaced;
  }

  /** Remove the highlight for a rejected suggestion without editing the text. */
  function rejectHighlight(index) {
    removeHighlight(index);
  }

  function removeHighlight(index) {
    const i = currentHighlights.findIndex(h => h.index === index);
    if (i === -1) return;
    currentHighlights[i].el.remove();
    currentHighlights.splice(i, 1);
    hideTooltip();
  }

  // ─── Clear ────────────────────────────────────────────────────────────────

  function clearHighlights() {
    currentHighlights.forEach(({ el }) => el.remove());
    currentHighlights = [];
    hideTooltip();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function getTypeClass(type) {
    const map = { typo: "ocla-hl-typo", grammar: "ocla-hl-grammar", style: "ocla-hl-style" };
    return map[type] || "ocla-hl-grammar";
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.__oclaHighlights = {
    init,
    applyHighlights,
    clearHighlights,
    scrollToHighlight,
    acceptHighlight,
    rejectHighlight,
  };

})();
