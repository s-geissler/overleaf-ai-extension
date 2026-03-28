/**
 * Background service worker for Overleaf AI Assistant.
 * Handles API calls to multiple providers (Anthropic, Google Gemini, OpenRouter).
 */

const JSON_RESPONSE_RULES = `JSON OUTPUT RULES:
- Output valid JSON only. No markdown, no code fences, no prose before or after the JSON.
- Use standard JSON with double-quoted keys and strings.
- Do not include comments, trailing commas, ellipses, placeholders, or extra keys.
- Escape embedded quotes and newlines correctly so the JSON parses with JSON.parse().
- If there is nothing to report, return the exact empty value required by the schema.`;

const SYSTEM_PROMPTS = {
  proofreading: `You are an expert academic proofreader specializing in LaTeX documents.
Your task is to identify typos, spelling errors, and grammar mistakes in the provided text.

IMPORTANT:
- Focus only on clear errors: typos, misspellings, grammatical mistakes, wrong word usage.
- Do NOT suggest stylistic changes or rewrites in this mode.
- Ignore LaTeX commands and markup (\\begin, \\end, \\textbf, etc.) and only check the natural language text.
- Each suggestion must quote the original text exactly as it appears in the input.
- Keep explanations brief and factual.

${JSON_RESPONSE_RULES}

Required schema:
[
  {
    "original": "exact text with error as it appears",
    "suggestion": "corrected text",
    "explanation": "brief reason for correction",
    "type": "typo"
  }
]

Valid "type" values for this mode: "typo", "grammar"
If there are no errors, return exactly []`,

  style: `You are an expert academic writing coach specializing in LaTeX documents.
Your task is to identify both errors and stylistic improvements in the provided text.

IMPORTANT:
- Check for typos, spelling errors, grammar mistakes, and improvements to clarity, flow, conciseness, and academic writing style.
- Ignore LaTeX commands and markup and only work with natural language text.
- Each suggestion must quote the original text exactly as it appears in the input.
- Keep explanations brief and specific.

${JSON_RESPONSE_RULES}

Required schema:
[
  {
    "original": "exact text as it appears",
    "suggestion": "improved text",
    "explanation": "brief reason for the suggestion",
    "type": "style"
  }
]

Valid "type" values for this mode: "typo", "grammar", "style"
If there are no suggestions, return exactly []`,

  factchecking: `You are an expert fact-checker for academic LaTeX documents.
Your task is to identify factual inaccuracies, incorrect attributions, wrong dates, or demonstrably false statements.

IMPORTANT:
- Focus only on clear factual errors: wrong names, incorrect dates, false claims, or misattributed quotes.
- Do NOT flag matters of opinion, unverifiable claims, or stylistic issues.
- Ignore LaTeX commands and markup and only assess the natural language content.
- Each suggestion must quote the original text exactly as it appears in the input.
- Keep explanations brief and factual.

${JSON_RESPONSE_RULES}

Required schema:
[
  {
    "original": "exact text as it appears",
    "suggestion": "corrected text",
    "explanation": "brief reason why this is factually incorrect",
    "type": "factual"
  }
]

Valid "type" values for this mode: "factual"
If there are no factual issues, return exactly []`,

  compacting: `You are an expert academic editor specializing in LaTeX documents.
Your task is to shorten the provided text while preserving its full meaning, all arguments, and the author's writing style.

IMPORTANT:
- You may restructure sentences and paragraphs to improve conciseness.
- You must not remove any content, facts, or arguments and may only condense the expression.
- You must keep all LaTeX commands (\\begin, \\end, \\textbf, \\cite, \\ref, \\label, etc.) completely unchanged and in their correct positions relative to the surrounding text.
- Prioritize readability over maximum shortness.
- Match the author's existing register, tone, and writing style.

${JSON_RESPONSE_RULES}

Required schema:
{
  "compacted": "the full compacted text, ready to paste",
  "explanation": "brief summary of what was changed or restructured"
}

The response must be a single JSON object with exactly those two keys.
The "compacted" value must always be a non-empty string.`
};

/**
 * Build the user-facing prompt for the selected analysis mode.
 * Inputs: `text` as the LaTeX source to analyze, `mode` as the active feature mode.
 * Returns: A provider-agnostic prompt string that restates the expected JSON shape.
 */
function buildUserPrompt(text, mode) {
  if (mode === "compacting") {
    return `Compact the following LaTeX text.

Return exactly one JSON object with this shape and no extra keys:
{"compacted":"...","explanation":"..."}

Do not wrap the JSON in markdown fences.
Do not add any commentary outside the JSON.

LaTeX text:
${text}`;
  }

  return `Analyze the following LaTeX text.

Return exactly one JSON array of suggestion objects and nothing else.
Each object must contain exactly these keys in this order:
"original", "suggestion", "explanation", "type"

If there are no issues to report, return exactly [].
Do not wrap the JSON in markdown fences.
Do not add any commentary outside the JSON.

LaTeX text:
${text}`;
}

// ─── Provider Definitions ──────────────────────────────────────────────────

const PROVIDERS = {
  anthropic: {
    name: "Anthropic",
    url: "https://api.anthropic.com/v1/messages",
    models: [
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fast)" },
      { id: "claude-sonnet-4-5",         label: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-5",           label: "Claude Opus 4.5" }
    ]
  },
  gemini: {
    name: "Google Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    models: [
      { id: "gemini-2.0-flash",         label: "Gemini 2.0 Flash (fast)" },
      { id: "gemini-2.5-flash-preview-04-17", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro-preview-03-25",   label: "Gemini 2.5 Pro" }
    ]
  },
  openrouter: {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    models: [
      { id: "google/gemini-flash-1.5",          label: "Gemini Flash 1.5" },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
      { id: "mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1" },
      { id: "deepseek/deepseek-chat-v3-0324",   label: "DeepSeek V3" },
      { id: "openai/gpt-4o-mini",               label: "GPT-4o Mini" },
      { id: "openai/gpt-4.1",                   label: "GPT-4.1" },
      { id: "anthropic/claude-sonnet-4-5",      label: "Claude Sonnet 4.5 (via OR)" }
    ]
  }
};

// ─── Message Handler ───────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "callAPI") {
    handleAPICall(message)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getProviders") {
    sendResponse({ success: true, data: PROVIDERS });
    return false;
  }
});

// ─── Router ────────────────────────────────────────────────────────────────

/**
 * Route an analysis request to the configured provider implementation.
 * Inputs: Request payload with text, mode, provider id, API key, and model id.
 * Returns: A normalized result object containing suggestions or compacted text plus usage.
 */
async function handleAPICall({ text, mode, provider, apiKey, model }) {
  if (!apiKey) throw new Error("No API key configured. Open extension settings.");
  if (!text || !text.trim()) throw new Error("No text provided.");

  const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.proofreading;

  switch (provider) {
    case "anthropic":   return callAnthropic(apiKey, model, systemPrompt, text, mode);
    case "gemini":      return callGemini(apiKey, model, systemPrompt, text, mode);
    case "openrouter":  return callOpenRouter(apiKey, model, systemPrompt, text, mode);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

// ─── Anthropic ─────────────────────────────────────────────────────────────

/**
 * Send an analysis request to Anthropic's Messages API.
 * Inputs: Provider credentials, selected model, prepared system prompt, source text, and mode.
 * Returns: Parsed suggestions or compacted text with token usage normalized to the extension format.
 */
async function callAnthropic(apiKey, model, systemPrompt, text, mode) {
  const userPrompt = buildUserPrompt(text, mode);
  const response = await fetchJSON("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: model || "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    })
  });

  const raw = response.content?.[0]?.text || "";
  return {
    ...parseResult(raw, mode),
    usage: {
      inputTokens:  response.usage?.input_tokens  || 0,
      outputTokens: response.usage?.output_tokens || 0
    }
  };
}

// ─── Google Gemini ─────────────────────────────────────────────────────────

/**
 * Send an analysis request to the Google Gemini API.
 * Inputs: Provider credentials, selected model, prepared system prompt, source text, and mode.
 * Returns: Parsed suggestions or compacted text with token usage normalized to the extension format.
 */
async function callGemini(apiKey, model, systemPrompt, text, mode) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const userPrompt = buildUserPrompt(text, mode);

  const response = await fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: 4096 }
    })
  });

  const raw = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const usage = response.usageMetadata || {};
  return {
    ...parseResult(raw, mode),
    usage: {
      inputTokens:  usage.promptTokenCount    || 0,
      outputTokens: usage.candidatesTokenCount || 0
    }
  };
}

// ─── OpenRouter ────────────────────────────────────────────────────────────

/**
 * Send an analysis request to OpenRouter's chat completions API.
 * Inputs: Provider credentials, selected model, prepared system prompt, source text, and mode.
 * Returns: Parsed suggestions or compacted text with token usage normalized to the extension format.
 */
async function callOpenRouter(apiKey, model, systemPrompt, text, mode) {
  const userPrompt = buildUserPrompt(text, mode);
  const response = await fetchJSON("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/overleaf-ai-assistant",
      "X-Title": "Overleaf AI Assistant"
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt }
      ]
    })
  });

  const raw = response.choices?.[0]?.message?.content || "";
  const usage = response.usage || {};
  return {
    ...parseResult(raw, mode),
    usage: {
      inputTokens:  usage.prompt_tokens     || 0,
      outputTokens: usage.completion_tokens || 0
    }
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Fetch JSON from a provider endpoint and normalize common transport and API errors.
 * Inputs: `url` string and `options` object passed through to `fetch`.
 * Returns: The parsed JSON response body, or throws a user-facing error.
 */
async function fetchJSON(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      detail = body.error?.message || body.message || detail;
    } catch (_) {}

    if (response.status === 401) throw new Error("Invalid API key. Check your settings.");
    if (response.status === 429) throw new Error("Rate limit exceeded. Please wait and try again.");
    throw new Error(`API error: ${detail}`);
  }

  return response.json();
}

/**
 * Parse and validate the model response for the active mode.
 * Inputs: Raw model text and the requested mode.
 * Returns: `{ suggestions }` for analysis modes or `{ compacted, explanation }` for compacting.
 */
function parseResult(raw, mode) {
  const cleaned = normalizeModelOutput(raw);
  if (!cleaned) {
    throw new Error("The model returned an empty response.");
  }

  if (mode === "compacting") {
    try {
      const obj = JSON.parse(extractJSONPayload(cleaned, "object"));
      if (!obj || typeof obj !== "object") {
        throw new Error("invalid compacting payload");
      }
      if (typeof obj.compacted !== "string" || !obj.compacted.trim()) {
        throw new Error("missing compacted text");
      }
      return { compacted: obj.compacted, explanation: typeof obj.explanation === "string" ? obj.explanation : "" };
    } catch (_) {
      throw new Error("The model returned invalid JSON for compacting mode.");
    }
  }

  try {
    const parsed = JSON.parse(extractJSONPayload(cleaned, "array"));
    if (!Array.isArray(parsed)) {
      throw new Error("invalid suggestion payload");
    }
    return { suggestions: parsed };
  } catch (_) {
    throw new Error("The model returned invalid JSON suggestions.");
  }
}

/**
 * Strip common wrapper noise before JSON recovery.
 * Inputs: Raw model response text.
 * Returns: Trimmed text with leading and trailing Markdown fences removed.
 */
function normalizeModelOutput(raw) {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

/**
 * Recover the first parseable JSON payload from noisy model output.
 * Inputs: Cleaned response text and the expected top-level type (`array` or `object`).
 * Returns: A JSON substring that can be safely passed to `JSON.parse()`.
 */
function extractJSONPayload(raw, expectedType) {
  try {
    JSON.parse(raw);
    return raw;
  } catch (_) {}

  const ranges = expectedType === "object"
    ? findBalancedJSONRanges(raw, "{", "}")
    : findBalancedJSONRanges(raw, "[", "]");

  for (const [start, end] of ranges) {
    const candidate = raw.slice(start, end + 1).trim();
    try {
      const parsed = JSON.parse(candidate);
      if (expectedType === "object" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return candidate;
      }
      if (expectedType === "array" && Array.isArray(parsed)) {
        return candidate;
      }
    } catch (_) {}
  }

  throw new Error("No recoverable JSON payload found.");
}

/**
 * Scan text for balanced top-level JSON-like spans while respecting quoted strings.
 * Inputs: Source text plus the opening and closing delimiter characters to match.
 * Returns: An array of `[start, end]` index pairs for candidate JSON substrings.
 */
function findBalancedJSONRanges(text, openChar, closeChar) {
  const ranges = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === openChar) {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (char === closeChar && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        ranges.push([start, i]);
        start = -1;
      }
    }
  }

  return ranges;
}
