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
  let currentHighlights = []; // { el, suggestion, range }
  let currentSuggestions = [];
  let rafScheduled = false;
  let activeScroller = null;  // tracked so we can detach on re-init
  let currentContext = null;

  // ─── Init ─────────────────────────────────────────────────────────────────

  /**
   * Initialize overlay state against the current CodeMirror instance.
   * Inputs: None.
   * Returns: None; recreates listeners and overlay plumbing for the active editor.
   */
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

  /**
   * Create the absolute-positioned highlight overlay container if needed.
   * Inputs: None.
   * Returns: None; stores the overlay element on the document body.
   */
  function createOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    overlayEl = document.createElement("div");
    overlayEl.id = OVERLAY_ID;
    overlayEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(overlayEl);
  }

  /**
   * Create the shared tooltip element used for suggestion details.
   * Inputs: None.
   * Returns: None; appends the tooltip to `document.body` once.
   */
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

  /**
   * Render overlays for the current suggestion set and analysis context.
   * Inputs: Suggestion array and optional analysis context with anchor metadata.
   * Returns: None; refreshes the internal highlight registry and overlay DOM.
   */
  function applyHighlights(suggestions, context = null) {
    clearHighlights();
    currentContext = context;
    currentSuggestions = Array.isArray(suggestions) ? suggestions.slice() : [];
    if (!suggestions || suggestions.length === 0) return;

    const cmContent = document.querySelector(".cm-content");
    if (!cmContent) return;

    suggestions.forEach((suggestion) => {
      if (!suggestion.original) return;
      upsertHighlight(suggestion, cmContent);
    });
  }

  /**
   * Find all occurrences of `suggestion.original` in the editor's line elements
   * and position a highlight overlay <span> over each one.
   *
   * We use a Range + getBoundingClientRect approach so the overlay floats
   * on top of the text without modifying the editor DOM.
   */
  /**
   * Create a new overlay element for a suggestion currently resolvable in the viewport.
   * Inputs: Suggestion object and the active `.cm-content` element.
   * Returns: None; appends a positioned overlay span when a valid range is found.
   */
  function highlightText(suggestion, cmContent) {
    const range = resolveSuggestionRange(suggestion, cmContent);
    if (!range) return;

    const typeClass = getTypeClass(suggestion.type);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const highlight = createHighlightEl(rect, suggestion, typeClass);
    overlayEl.appendChild(highlight);
    currentHighlights.push({ el: highlight, suggestion, range });
  }

  /**
   * Create, update, or remove a single overlay entry based on the current DOM range.
   * Inputs: Suggestion object and the active `.cm-content` element.
   * Returns: The current highlight entry for that suggestion, or `null` if unresolved.
   */
  function upsertHighlight(suggestion, cmContent) {
    const existing = currentHighlights.find((entry) => entry.suggestion.id === suggestion.id);
    const range = resolveSuggestionRange(suggestion, cmContent);

    if (!range) {
      if (existing) {
        existing.el.remove();
        currentHighlights = currentHighlights.filter((entry) => entry.suggestion.id !== suggestion.id);
      }
      return null;
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;

    if (existing) {
      existing.range = range;
      positionEl(existing.el, rect);
      return existing;
    }

    highlightText(suggestion, cmContent);
    return currentHighlights.find((entry) => entry.suggestion.id === suggestion.id) || null;
  }

  /**
   * Create a Range that wraps `needle` text inside `lineEl`, starting at `offset`.
   * Walks text nodes to find the correct positions.
   */
  /**
   * Build a DOM `Range` for a substring inside one rendered CodeMirror line.
   * Inputs: Line element, search string, and character offset within that line.
   * Returns: A `Range` spanning the substring, or `null` if the text nodes do not line up.
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

  /**
   * Create the overlay DOM element for one suggestion highlight.
   * Inputs: Bounding rect, suggestion object, and CSS class for the suggestion type.
   * Returns: The configured overlay span element.
   */
  function createHighlightEl(rect, suggestion, typeClass) {
    const el = document.createElement("span");
    el.className = `ocla-highlight ${typeClass}`;
    el.dataset.suggestionId = suggestion.id;
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

  /**
   * Position an overlay element over its backing text range.
   * Inputs: Overlay element and the target client rect.
   * Returns: None; writes absolute position styles onto the element.
   */
  function positionEl(el, rect) {
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    el.style.left = `${rect.left + scrollX}px`;
    el.style.top = `${rect.top + scrollY}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${Math.max(rect.height, 14)}px`;
  }

  // ─── Tooltip ──────────────────────────────────────────────────────────────

  /**
   * Populate and position the shared tooltip for a suggestion.
   * Inputs: Highlight element, suggestion object, and optional pinned state.
   * Returns: None; shows the tooltip near the highlight.
   */
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

  /**
   * Hide the shared suggestion tooltip.
   * Inputs: None.
   * Returns: None.
   */
  function hideTooltip() {
    if (!tooltipEl) return;
    tooltipEl.style.display = "none";
    tooltipEl.setAttribute("aria-hidden", "true");
    tooltipEl.classList.remove("ocla-tooltip-pinned");
  }

  // ─── Reposition on scroll/resize ──────────────────────────────────────────

  /**
   * Throttle highlight repositioning to the next animation frame.
   * Inputs: None.
   * Returns: None; schedules `repositionAll()` once per frame.
   */
  function scheduleRepositionAll() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      repositionAll();
      rafScheduled = false;
    });
  }

  /**
   * Re-resolve every suggestion against the current viewport and refresh overlay positions.
   * Inputs: None.
   * Returns: None; updates or materializes visible highlight entries.
   */
  function repositionAll() {
    const cmContent = document.querySelector(".cm-content");
    if (!cmContent) return;

    currentSuggestions.forEach((suggestion) => {
      upsertHighlight(suggestion, cmContent);
    });
  }

  // ─── Scroll to highlight ──────────────────────────────────────────────────

  /**
   * Scroll to a suggestion, move the cursor there, and pulse its overlay.
   * Inputs: Suggestion id string.
   * Returns: A promise that resolves after the best-effort jump completes.
   */
  async function scrollToHighlight(id) {
    const suggestion = currentSuggestions.find((item) => item.id === id);
    if (!suggestion) return;

    const entry = await ensureSuggestionVisible(suggestion, { behavior: "smooth" });
    if (!entry) return;

    placeCursor(entry.range);
    entry.el.classList.add("ocla-highlight-pulse");
    setTimeout(() => entry.el.classList.remove("ocla-highlight-pulse"), 1200);
  }

  /** Collapse the browser selection to the start of `range` and focus CM. */
  /**
   * Collapse the browser selection to the start of a DOM range.
   * Inputs: Target `Range`.
   * Returns: None; focuses CodeMirror if the range can be applied.
   */
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
  /**
   * Apply a suggestion by replacing its current range in the editor.
   * Inputs: Suggestion id string.
   * Returns: A metadata object with the applied anchor and replacement text, or `null` on failure.
   */
  async function acceptHighlight(id) {
    const suggestion = currentSuggestions.find((item) => item.id === id);
    if (!suggestion) return null;
    const entry = await ensureSuggestionVisible(suggestion, { behavior: "auto" });
    const cmContent = document.querySelector(".cm-content");
    const range = cmContent ? resolveSuggestionRange(suggestion, cmContent) : entry?.range;

    let replaced = false;
    if (range && cmContent) {
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        cmContent.focus();
        // execCommand is deprecated but remains the most reliable way to drive
        // CM6's input handling from a content script without CM internals access.
        replaced = document.execCommand("insertText", false, suggestion.suggestion);
      } catch (_) {}
    }

    if (!replaced) {
      return null;
    }

    removeHighlight(id);
    return {
      anchor: suggestion.anchor || null,
      replacementText: suggestion.suggestion || ""
    };
  }

  /** Remove the highlight for a rejected suggestion without editing the text. */
  /**
   * Dismiss a suggestion highlight without editing the document.
   * Inputs: Suggestion id string.
   * Returns: None.
   */
  function rejectHighlight(id) {
    removeHighlight(id);
  }

  /**
   * Remove one suggestion from both the overlay registry and visible DOM.
   * Inputs: Suggestion id string.
   * Returns: None; hides the tooltip as part of cleanup.
   */
  function removeHighlight(id) {
    const i = currentHighlights.findIndex(h => h.suggestion.id === id);
    currentSuggestions = currentSuggestions.filter((suggestion) => suggestion.id !== id);
    if (i === -1) {
      hideTooltip();
      return;
    }
    currentHighlights[i].el.remove();
    currentHighlights.splice(i, 1);
    hideTooltip();
  }

  // ─── Clear ────────────────────────────────────────────────────────────────

  /**
   * Remove all rendered overlays and forget the active suggestion context.
   * Inputs: None.
   * Returns: None.
   */
  function clearHighlights() {
    currentHighlights.forEach(({ el }) => el.remove());
    currentHighlights = [];
    currentSuggestions = [];
    currentContext = null;
    hideTooltip();
  }

  /**
   * Resolve a suggestion to the best available DOM range in the current editor view.
   * Inputs: Suggestion object and the active `.cm-content` element.
   * Returns: A `Range` for the suggestion, or `null` if it cannot currently be located.
   */
  function resolveSuggestionRange(suggestion, cmContent) {
    if (!suggestion || !cmContent) return null;

    if (suggestion.anchor?.scope === "selection" && currentContext?.scope === "selection" && currentContext.range) {
      const selectionRange = findSubRangeWithinRange(currentContext.range, suggestion.anchor.start, suggestion.anchor.end);
      if (selectionRange) return selectionRange;
    }

    if (suggestion.anchor?.scope === "document" && currentContext?.scope === "document") {
      const documentRange = findRangeFromDocumentAnchor(cmContent, suggestion.anchor);
      if (documentRange) return documentRange;
    }

    return findFirstVisibleOccurrence(cmContent, suggestion.original);
  }

  /**
   * Ensure a suggestion is scrolled into view and has a live overlay entry.
   * Inputs: Suggestion object and optional scroll behavior options.
   * Returns: The corresponding highlight entry, or `null` if the suggestion cannot be resolved.
   */
  async function ensureSuggestionVisible(suggestion, options = {}) {
    const cmContent = document.querySelector(".cm-content");
    let entry = currentHighlights.find((item) => item.suggestion.id === suggestion.id);
    if (entry?.range) {
      scrollRangeIntoView(entry.range, options.behavior || "smooth");
      return entry;
    }

    if (suggestion.anchor?.scope === "document" && currentContext?.scope === "document") {
      await scrollDocumentAnchorIntoView(suggestion.anchor, options.behavior || "auto");
      if (cmContent) {
        entry = upsertHighlight(suggestion, cmContent);
      }
      if (entry?.range) {
        scrollRangeIntoView(entry.range, options.behavior || "smooth");
        return entry;
      }
    }

    if (cmContent) {
      entry = upsertHighlight(suggestion, cmContent);
      if (entry?.range) {
        scrollRangeIntoView(entry.range, options.behavior || "smooth");
        return entry;
      }
    }

    return null;
  }

  /**
   * Scroll the CodeMirror scroller toward a document-level anchor offset.
   * Inputs: Anchor object with document offsets and the desired scroll behavior.
   * Returns: A promise that resolves after the viewport has had time to repaint.
   */
  async function scrollDocumentAnchorIntoView(anchor, behavior) {
    const scroller = activeScroller || document.querySelector(".cm-scroller");
    if (!scroller || !currentContext?.lineStarts?.length) return;

    const startPosition = getLineColumnForOffset(currentContext, anchor.start);
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const maxLineIndex = Math.max(currentContext.lines.length - 1, 1);
    const targetRatio = startPosition.lineIndex / maxLineIndex;
    const targetTop = Math.max(0, Math.min(maxScrollTop, maxScrollTop * targetRatio - scroller.clientHeight * 0.2));
    scroller.scrollTo({ top: targetTop, behavior });
    await waitForPaint();
  }

  /**
   * Scroll the editor viewport just enough to reveal a DOM range.
   * Inputs: Target `Range` and desired scroll behavior.
   * Returns: None.
   */
  function scrollRangeIntoView(range, behavior) {
    const scroller = activeScroller || document.querySelector(".cm-scroller");
    if (!scroller || !range) return;

    const rangeRect = range.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    if (rangeRect.top < scrollerRect.top || rangeRect.bottom > scrollerRect.bottom) {
      scroller.scrollTo({
        top: scroller.scrollTop + (rangeRect.top - scrollerRect.top) - scrollerRect.height / 3,
        behavior
      });
    }
  }

  /**
   * Map a document-level anchor back to a visible DOM range in the current viewport.
   * Inputs: Active `.cm-content` element and anchor object with start/end offsets.
   * Returns: A `Range` if both boundaries can be resolved, or `null`.
   */
  function findRangeFromDocumentAnchor(cmContent, anchor) {
    if (!anchor || !currentContext?.lines?.length) return null;

    const startPos = getLineColumnForOffset(currentContext, anchor.start);
    const mapping = mapVisibleLinesToDocument(cmContent, currentContext.lines, startPos.lineIndex);
    if (!mapping) return null;
    const endPos = getLineColumnForOffset(currentContext, anchor.end);
    const startLine = mapping.get(startPos.lineIndex);
    const endLine = mapping.get(endPos.lineIndex);
    if (!startLine || !endLine) return null;

    const startBoundary = findBoundaryInLine(startLine, startPos.column);
    const endBoundary = findBoundaryInLine(endLine, endPos.column);
    if (!startBoundary || !endBoundary) return null;

    try {
      const range = document.createRange();
      range.setStart(startBoundary.node, startBoundary.offset);
      range.setEnd(endBoundary.node, endBoundary.offset);
      return range;
    } catch (_) {
      return null;
    }
  }

  /**
   * Match rendered `.cm-line` elements to the most likely slice of the analyzed document.
   * Inputs: Active `.cm-content`, full analyzed document lines, and an optional preferred line index.
   * Returns: A map from analyzed document line index to visible line element, or `null`.
   */
  function mapVisibleLinesToDocument(cmContent, documentLines, preferredLineIndex) {
    const lineEls = Array.from(cmContent.querySelectorAll(".cm-line"));
    if (!lineEls.length || !documentLines?.length) return null;

    const visibleTexts = lineEls.map((line) => line.textContent);
    let bestStart = -1;
    let bestScore = -1;

    for (const docStart of collectCandidateStarts(documentLines, visibleTexts.length, preferredLineIndex)) {
      let score = 0;
      for (let i = 0; i < visibleTexts.length; i += 1) {
        if (documentLines[docStart + i] === visibleTexts[i]) {
          score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestStart = docStart;
      }
    }

    if (bestStart === -1 || bestScore <= 0) return null;

    const mapping = new Map();
    lineEls.forEach((lineEl, index) => {
      mapping.set(bestStart + index, lineEl);
    });
    return mapping;
  }

  /**
   * Build candidate document windows for viewport-to-document line matching.
   * Inputs: Full document line array, visible window size, and optional preferred line index.
   * Returns: An array of possible document start indices for scoring.
   */
  function collectCandidateStarts(documentLines, windowSize, preferredLineIndex) {
    const maxStart = Math.max(0, documentLines.length - windowSize);
    const candidates = [];

    for (let docStart = 0; docStart <= maxStart; docStart += 1) {
      if (typeof preferredLineIndex === "number" && (preferredLineIndex < docStart || preferredLineIndex >= docStart + windowSize)) {
        continue;
      }
      candidates.push(docStart);
    }

    if (candidates.length) return candidates;
    return Array.from({ length: maxStart + 1 }, (_, index) => index);
  }

  /**
   * Convert a flat character offset into document line and column coordinates.
   * Inputs: Analysis context with `lineStarts` and full text, plus the target offset.
   * Returns: `{ lineIndex, column }` describing the offset position.
   */
  function getLineColumnForOffset(context, offset) {
    const lineStarts = context.lineStarts || [0];
    const safeOffset = Math.max(0, Math.min(offset, context.text.length));
    let lineIndex = 0;

    for (let i = 0; i < lineStarts.length; i += 1) {
      const lineStart = lineStarts[i];
      const nextLineStart = i + 1 < lineStarts.length ? lineStarts[i + 1] : context.text.length + 1;
      if (safeOffset >= lineStart && safeOffset < nextLineStart) {
        lineIndex = i;
        break;
      }
      if (safeOffset >= nextLineStart) {
        lineIndex = i;
      }
    }

    return {
      lineIndex,
      column: safeOffset - lineStarts[lineIndex]
    };
  }

  /**
   * Resolve a character boundary inside one rendered CodeMirror line.
   * Inputs: Line element and character offset within that line.
   * Returns: `{ node, offset }` for range construction, or `null`.
   */
  function findBoundaryInLine(lineEl, offset) {
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let node;

    while ((node = walker.nextNode())) {
      const nextConsumed = consumed + node.textContent.length;
      if (offset <= nextConsumed) {
        return {
          node,
          offset: Math.max(0, offset - consumed)
        };
      }
      consumed = nextConsumed;
    }

    return null;
  }

  /**
   * Wait for two animation frames so CodeMirror and layout can settle after scrolling.
   * Inputs: None.
   * Returns: A promise that resolves after the next paint cycle.
   */
  function waitForPaint() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  /**
   * Find the first visible occurrence of a suggestion string as a last-resort fallback.
   * Inputs: Active `.cm-content` element and the text to search for.
   * Returns: A DOM `Range` for the visible match, or `null`.
   */
  function findFirstVisibleOccurrence(cmContent, needle) {
    if (!needle || needle.trim().length === 0) return null;

    const lines = cmContent.querySelectorAll(".cm-line");
    for (const line of lines) {
      const lineText = line.textContent;
      const pos = lineText.indexOf(needle);
      if (pos === -1) continue;

      const range = findTextRange(line, needle, pos);
      if (range) return range;
    }

    return null;
  }

  /**
   * Resolve a relative offset pair to a concrete sub-range inside an existing DOM range.
   * Inputs: Root range plus start and end offsets relative to that range's text content.
   * Returns: A `Range` covering the requested slice, or `null`.
   */
  function findSubRangeWithinRange(rootRange, startOffset, endOffset) {
    if (!rootRange || startOffset < 0 || endOffset <= startOffset) return null;

    const root = rootRange.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!rootRange.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let seen = 0;
    let startNode = null;
    let startNodeOffset = 0;
    let endNode = null;
    let endNodeOffset = 0;
    let node;

    while ((node = walker.nextNode())) {
      const segment = getNodeIntersectionSegment(rootRange, node);
      if (!segment) continue;

      const [nodeStart, nodeEnd] = segment;
      const segmentLength = nodeEnd - nodeStart;
      if (segmentLength <= 0) continue;

      const segmentStart = seen;
      const segmentEnd = seen + segmentLength;

      if (!startNode && startOffset < segmentEnd) {
        startNode = node;
        startNodeOffset = nodeStart + Math.max(0, startOffset - segmentStart);
      }

      if (startNode && endOffset <= segmentEnd) {
        endNode = node;
        endNodeOffset = nodeStart + Math.max(0, endOffset - segmentStart);
        break;
      }

      seen = segmentEnd;
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

  /**
   * Compute the segment of a text node that lies inside a root range.
   * Inputs: Root `Range` and one intersecting text node.
   * Returns: `[start, end]` offsets inside the node, or `null` if there is no overlap.
   */
  function getNodeIntersectionSegment(range, node) {
    try {
      const nodeRange = document.createRange();
      nodeRange.selectNodeContents(node);

      const startsBeforeNode = range.compareBoundaryPoints(Range.START_TO_START, nodeRange) <= 0;
      const endsAfterNode = range.compareBoundaryPoints(Range.END_TO_END, nodeRange) >= 0;

      const start = startsBeforeNode
        ? 0
        : Math.max(0, offsetFromBoundary(node, range.startContainer, range.startOffset));
      const end = endsAfterNode
        ? node.textContent.length
        : Math.min(node.textContent.length, offsetFromBoundary(node, range.endContainer, range.endOffset));

      return end >= start ? [start, end] : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Measure the character offset from the start of a text node to an arbitrary boundary point.
   * Inputs: Text node plus a DOM boundary container and offset.
   * Returns: Character count from the node start to that boundary.
   */
  function offsetFromBoundary(textNode, container, offset) {
    if (container === textNode) {
      return offset;
    }

    const boundaryRange = document.createRange();
    boundaryRange.selectNodeContents(textNode);

    try {
      boundaryRange.setEnd(container, offset);
    } catch (_) {
      return 0;
    }

    return boundaryRange.toString().length;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Map a suggestion type to the corresponding highlight CSS class.
   * Inputs: Suggestion type string.
   * Returns: CSS class name used for overlay styling.
   */
  function getTypeClass(type) {
    const map = { typo: "ocla-hl-typo", grammar: "ocla-hl-grammar", style: "ocla-hl-style", factual: "ocla-hl-factual" };
    return map[type] || "ocla-hl-grammar";
  }

  /**
   * Escape HTML special characters in a string.
   * Inputs: Raw string value.
   * Returns: A safely escaped HTML string.
   */
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
