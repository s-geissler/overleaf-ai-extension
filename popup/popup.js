/**
 * popup.js — Settings page for Overleaf AI Assistant.
 * Handles provider selection, API key entry, model text input.
 */

(function () {
  "use strict";

  const PROVIDERS = {
    anthropic: {
      name: "Anthropic",
      keyPlaceholder: "sk-ant-api…",
      keyHint: "Get your key at console.anthropic.com. Stored locally, sent only to api.anthropic.com.",
      defaultModel: "claude-haiku-4-5-20251001",
      modelHint: "e.g. claude-haiku-4-5-20251001, claude-sonnet-4-5, claude-opus-4-5"
    },
    gemini: {
      name: "Google Gemini",
      keyPlaceholder: "AIza…",
      keyHint: "Get your key at aistudio.google.com. Stored locally, sent only to generativelanguage.googleapis.com.",
      defaultModel: "gemini-2.0-flash",
      modelHint: "e.g. gemini-2.0-flash, gemini-2.5-flash-preview-04-17, gemini-2.5-pro-preview-03-25"
    },
    openrouter: {
      name: "OpenRouter",
      keyPlaceholder: "sk-or-…",
      keyHint: "Get your key at openrouter.ai. Hundreds of models available via one API.",
      defaultModel: "google/gemini-flash-1.5",
      modelHint: "Any model slug from openrouter.ai/models, e.g. meta-llama/llama-3.3-70b-instruct"
    }
  };

  // ─── DOM refs ──────────────────────────────────────────────────────────────

  const providerSelect = document.getElementById("provider-select");
  const apiKeyInput    = document.getElementById("api-key");
  const apiKeyLabel    = document.getElementById("api-key-label");
  const apiKeyHint     = document.getElementById("api-key-hint");
  const modelInput     = document.getElementById("model-input");
  const modelHint      = document.getElementById("model-hint");
  const saveBtn        = document.getElementById("save-btn");
  const toggleVisBtn   = document.getElementById("toggle-visibility");
  const statusMsg      = document.getElementById("status-msg");

  let keyVisible = false;

  // ─── Update UI for selected provider ──────────────────────────────────────

  function applyProvider(providerKey, savedModel) {
    const p = PROVIDERS[providerKey];
    apiKeyLabel.textContent  = `${p.name} API Key`;
    apiKeyInput.placeholder  = p.keyPlaceholder || "";
    apiKeyHint.textContent   = p.keyHint || "";
    modelInput.placeholder   = p.defaultModel;
    modelHint.textContent    = p.modelHint || "";
    // Only set the model value if one was saved; leave blank to use the placeholder default.
    modelInput.value = savedModel || "";
  }

  // ─── Load saved settings ───────────────────────────────────────────────────

  browser.storage.local.get(["provider", "apiKeys", "model"], ({ provider, apiKeys, model }) => {
    const savedProvider = provider || "anthropic";
    providerSelect.value = savedProvider;
    applyProvider(savedProvider, model);

    if (apiKeys && apiKeys[savedProvider]) {
      apiKeyInput.value = apiKeys[savedProvider];
    }
  });

  // ─── Provider change ───────────────────────────────────────────────────────

  providerSelect.addEventListener("change", () => {
    const pKey = providerSelect.value;

    // Reload the saved model for this provider (may differ per provider).
    browser.storage.local.get(["apiKeys", "model"], ({ apiKeys, model }) => {
      applyProvider(pKey, model);
      apiKeyInput.value = (apiKeys && apiKeys[pKey]) ? apiKeys[pKey] : "";
    });
  });

  // ─── Toggle key visibility ─────────────────────────────────────────────────

  toggleVisBtn.addEventListener("click", () => {
    keyVisible = !keyVisible;
    apiKeyInput.type = keyVisible ? "text" : "password";
    toggleVisBtn.textContent = keyVisible ? "🙈" : "👁";
  });

  // ─── Save ──────────────────────────────────────────────────────────────────

  saveBtn.addEventListener("click", async () => {
    const provider = providerSelect.value;
    const apiKey   = apiKeyInput.value.trim();
    // If left blank, fall back to the provider's default model.
    const model    = modelInput.value.trim() || PROVIDERS[provider].defaultModel;

    if (!apiKey) {
      showStatus("Please enter an API key.", "error");
      apiKeyInput.focus();
      return;
    }

    saveBtn.disabled    = true;
    saveBtn.textContent = "Saving…";

    try {
      const { apiKeys: existing } = await browser.storage.local.get("apiKeys");
      const apiKeys = existing || {};
      apiKeys[provider] = apiKey;

      await browser.storage.local.set({ provider, apiKeys, model });
      showStatus("Settings saved!", "success");
    } catch (err) {
      showStatus(`Could not save: ${err.message}`, "error");
    } finally {
      saveBtn.disabled    = false;
      saveBtn.textContent = "Save Settings";
    }
  });

  apiKeyInput.addEventListener("keydown", e => { if (e.key === "Enter") saveBtn.click(); });
  modelInput.addEventListener("keydown",  e => { if (e.key === "Enter") saveBtn.click(); });

  // ─── Status helper ─────────────────────────────────────────────────────────

  let statusTimeout;
  function showStatus(message, type = "info") {
    clearTimeout(statusTimeout);
    statusMsg.textContent = message;
    statusMsg.className   = `status-msg status-${type}`;
    statusMsg.hidden      = false;
    statusTimeout = setTimeout(() => { statusMsg.hidden = true; }, 3500);
  }

})();
