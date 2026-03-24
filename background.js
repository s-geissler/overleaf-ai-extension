/**
 * Background service worker for Overleaf AI Assistant.
 * Handles API calls to multiple providers (Anthropic, Google Gemini, OpenRouter).
 */

const SYSTEM_PROMPTS = {
  proofreading: `You are an expert academic proofreader specializing in LaTeX documents.
Your task is to identify typos, spelling errors, and grammar mistakes in the provided text.

IMPORTANT:
- Focus only on clear errors: typos, misspellings, grammatical mistakes, wrong word usage.
- Do NOT suggest stylistic changes or rewrites in this mode.
- Ignore LaTeX commands and markup (\\begin, \\end, \\textbf, etc.) — only check the natural language text.
- Return ONLY a valid JSON array. No markdown, no explanation outside the JSON.

Return format (JSON array):
[
  {
    "original": "exact text with error as it appears",
    "suggestion": "corrected text",
    "explanation": "brief reason for correction",
    "type": "typo|grammar"
  }
]

If there are no errors, return an empty array: []`,

  style: `You are an expert academic writing coach specializing in LaTeX documents.
Your task is to identify both errors AND stylistic improvements in the provided text.

IMPORTANT:
- Check for typos, spelling errors, grammar mistakes.
- Also suggest improvements to clarity, flow, conciseness, and academic writing style.
- Ignore LaTeX commands and markup — only work with natural language text.
- Return ONLY a valid JSON array. No markdown, no explanation outside the JSON.

Return format (JSON array):
[
  {
    "original": "exact text as it appears",
    "suggestion": "improved text",
    "explanation": "brief reason for the suggestion",
    "type": "typo|grammar|style"
  }
]

If there are no suggestions, return an empty array: []`
};

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

async function handleAPICall({ text, mode, provider, apiKey, model }) {
  if (!apiKey) throw new Error("No API key configured. Open extension settings.");
  if (!text || !text.trim()) throw new Error("No text provided.");

  const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.proofreading;

  switch (provider) {
    case "anthropic":   return callAnthropic(apiKey, model, systemPrompt, text);
    case "gemini":      return callGemini(apiKey, model, systemPrompt, text);
    case "openrouter":  return callOpenRouter(apiKey, model, systemPrompt, text);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

// ─── Anthropic ─────────────────────────────────────────────────────────────

async function callAnthropic(apiKey, model, systemPrompt, text) {
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
      messages: [{ role: "user", content: `Analyze this LaTeX text:\n\n${text}` }]
    })
  });

  const raw = response.content?.[0]?.text || "[]";
  return {
    suggestions: parseJSON(raw),
    usage: {
      inputTokens:  response.usage?.input_tokens  || 0,
      outputTokens: response.usage?.output_tokens || 0
    }
  };
}

// ─── Google Gemini ─────────────────────────────────────────────────────────

async function callGemini(apiKey, model, systemPrompt, text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: `Analyze this LaTeX text:\n\n${text}` }] }],
      generationConfig: { maxOutputTokens: 4096 }
    })
  });

  const raw = response.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  const usage = response.usageMetadata || {};
  return {
    suggestions: parseJSON(raw),
    usage: {
      inputTokens:  usage.promptTokenCount    || 0,
      outputTokens: usage.candidatesTokenCount || 0
    }
  };
}

// ─── OpenRouter ────────────────────────────────────────────────────────────

async function callOpenRouter(apiKey, model, systemPrompt, text) {
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
        { role: "user",   content: `Analyze this LaTeX text:\n\n${text}` }
      ]
    })
  });

  const raw = response.choices?.[0]?.message?.content || "[]";
  const usage = response.usage || {};
  return {
    suggestions: parseJSON(raw),
    usage: {
      inputTokens:  usage.prompt_tokens     || 0,
      outputTokens: usage.completion_tokens || 0
    }
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

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

function parseJSON(raw) {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/,"").trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}
