/**
 * popup.js — Settings page for Overleaf AI Assistant.
 * Stores all provider credentials and models in a single normalized object.
 */

(function () {
  "use strict";

  const PRESETS = [
    { color: "#468847", label: "Overleaf Green" },
    { color: "#5b8fc7", label: "Pastel Blue" },
    { color: "#7c3aed", label: "Purple" },
    { color: "#e06c75", label: "Pastel Red" },
  ];

  const DEFAULT_COLOR = "#7c3aed";

  const PROVIDERS = {
    anthropic: {
      name: "Anthropic",
      keyPlaceholder: "sk-ant-api…",
      keyHint: "Get your key at console.anthropic.com. Stored locally and sent only to api.anthropic.com.",
      defaultModel: "claude-haiku-4-5-20251001",
      modelHint: "Examples: claude-haiku-4-5-20251001, claude-sonnet-4-5, claude-opus-4-5",
      copy: "Direct Anthropic access for Claude models."
    },
    gemini: {
      name: "Google Gemini",
      keyPlaceholder: "AIza…",
      keyHint: "Get your key at aistudio.google.com. Stored locally and sent only to generativelanguage.googleapis.com.",
      defaultModel: "gemini-2.0-flash",
      modelHint: "Examples: gemini-2.0-flash, gemini-2.5-flash-preview-04-17, gemini-2.5-pro-preview-03-25",
      copy: "Google-hosted Gemini models."
    },
    openrouter: {
      name: "OpenRouter",
      keyPlaceholder: "sk-or-…",
      keyHint: "Get your key at openrouter.ai. Stored locally and sent only to openrouter.ai.",
      defaultModel: "google/gemini-flash-1.5",
      modelHint: "Any OpenRouter model slug, for example meta-llama/llama-3.3-70b-instruct",
      copy: "One API key for many hosted models."
    }
  };

  const DEFAULT_SETTINGS = {
    provider: "anthropic",
    accentColor: DEFAULT_COLOR,
    providers: {
      anthropic: { apiKey: "", model: PROVIDERS.anthropic.defaultModel },
      gemini: { apiKey: "", model: PROVIDERS.gemini.defaultModel },
      openrouter: { apiKey: "", model: PROVIDERS.openrouter.defaultModel }
    }
  };

  const providerTabs = Array.from(document.querySelectorAll(".provider-tab"));
  const providerHint = document.getElementById("provider-hint");
  const providerTitle = document.getElementById("provider-title");
  const providerCopy = document.getElementById("provider-copy");
  const providerBadge = document.getElementById("provider-badge");
  const swatchRow = document.getElementById("swatch-row");
  const customColorText = document.getElementById("custom-color-text");
  const customColorPicker = document.getElementById("custom-color-picker");
  const apiKeyLabel = document.getElementById("api-key-label");
  const apiKeyInput = document.getElementById("api-key");
  const apiKeyHint = document.getElementById("api-key-hint");
  const modelInput = document.getElementById("model-input");
  const modelHint = document.getElementById("model-hint");
  const resetModelBtn = document.getElementById("reset-model");
  const saveBtn = document.getElementById("save-btn");
  const toggleVisBtn = document.getElementById("toggle-visibility");
  const statusMsg = document.getElementById("status-msg");

  let keyVisible = false;
  let settings = cloneDefaults();
  let savedProvider = DEFAULT_SETTINGS.provider;

  init();

  /**
   * Initialize the popup from persisted settings and paint the first provider view.
   * Inputs: None.
   * Returns: A promise that resolves after the UI has been populated.
   */
  async function init() {
    settings = await loadSettings();
    savedProvider = settings.provider;
    renderSwatches(settings.accentColor);
    selectColor(settings.accentColor);
    renderProvider(settings.provider);
  }

  /**
   * Create a writable copy of the default settings object.
   * Inputs: None.
   * Returns: A fresh settings object so UI edits do not mutate shared defaults.
   */
  function cloneDefaults() {
    return {
      provider: DEFAULT_SETTINGS.provider,
      accentColor: DEFAULT_SETTINGS.accentColor,
      providers: {
        anthropic: { ...DEFAULT_SETTINGS.providers.anthropic },
        gemini: { ...DEFAULT_SETTINGS.providers.gemini },
        openrouter: { ...DEFAULT_SETTINGS.providers.openrouter }
      }
    };
  }

  /**
   * Render the preset accent color buttons.
   * Inputs: `activeColor` as the currently selected hex color.
   * Returns: None; updates the swatch row DOM in place.
   */
  function renderSwatches(activeColor) {
    swatchRow.textContent = "";
    PRESETS.forEach(({ color, label }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "swatch-btn" + (color === activeColor ? " swatch-selected" : "");
      btn.title = label;
      btn.dataset.color = color;
      btn.style.background = color;
      btn.addEventListener("click", () => {
        settings.accentColor = color;
        selectColor(color);
      });
      swatchRow.appendChild(btn);
    });
  }

  /**
   * Convert a six-digit hex color string into RGB components.
   * Inputs: `hex` in `#RRGGBB` format.
   * Returns: `[r, g, b]` or `null` if the input is invalid.
   */
  function hexToRgb(hex) {
    const match = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!match) return null;
    return [
      parseInt(match[1].slice(0, 2), 16),
      parseInt(match[1].slice(2, 4), 16),
      parseInt(match[1].slice(4, 6), 16)
    ];
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
   * Apply the selected accent color to the popup preview and draft settings.
   * Inputs: `hex` in `#RRGGBB` format.
   * Returns: None; updates CSS variables and selected swatch state.
   */
  function selectColor(hex) {
    const rgb = hexToRgb(hex);
    const accentDark = rgb ? mixRgb(rgb, [0, 0, 0], 0.28) : null;
    const accentBright = rgb ? mixRgb(rgb, [255, 255, 255], 0.22) : null;
    settings.accentColor = hex;
    customColorText.value = hex;
    customColorPicker.value = hex;
    document.documentElement.style.setProperty("--accent", hex);
    if (accentDark) {
      document.documentElement.style.setProperty("--accent-dark", rgbCss(accentDark));
    }
    if (accentBright) {
      document.documentElement.style.setProperty("--accent-bright", rgbCss(accentBright));
    }
    if (rgb) {
      document.documentElement.style.setProperty("--accent-soft", `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.12)`);
      document.documentElement.style.setProperty("--accent-soft-strong", `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.2)`);
      document.documentElement.style.setProperty("--accent-glow", `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.22)`);
      document.documentElement.style.setProperty("--accent-glow-heavy", `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.3)`);
      document.documentElement.style.setProperty("--accent-sheen", `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.16)`);
    }
    document.querySelectorAll(".swatch-btn").forEach((btn) => {
      btn.classList.toggle("swatch-selected", btn.dataset.color === hex);
    });
  }

  /**
   * Render the provider-specific form fields for the chosen provider tab.
   * Inputs: `providerKey` matching one of the keys in `PROVIDERS`.
   * Returns: None; updates the visible form and provider badge state.
   */
  function renderProvider(providerKey) {
    settings.provider = providerKey;
    const provider = PROVIDERS[providerKey];
    const providerSettings = settings.providers[providerKey];
    const isSavedActive = providerKey === savedProvider;

    providerTabs.forEach((tab) => {
      const active = tab.dataset.provider === providerKey;
      tab.classList.toggle("provider-tab-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });

    providerHint.textContent = "Credentials and model are stored separately for each provider.";
    providerTitle.textContent = provider.name;
    providerCopy.textContent = provider.copy;
    providerBadge.textContent = isSavedActive ? "Active" : "Inactive";
    providerBadge.classList.toggle("provider-badge-inactive", !isSavedActive);
    apiKeyLabel.textContent = `${provider.name} API Key`;
    apiKeyInput.placeholder = provider.keyPlaceholder;
    apiKeyInput.value = providerSettings.apiKey || "";
    apiKeyHint.textContent = provider.keyHint;
    modelInput.placeholder = provider.defaultModel;
    modelInput.value = providerSettings.model || provider.defaultModel;
    modelHint.textContent = provider.modelHint;
    apiKeyInput.type = keyVisible ? "text" : "password";
    toggleVisBtn.textContent = keyVisible ? "Hide" : "Show";
  }

  /**
   * Load settings from storage and migrate legacy flat keys when needed.
   * Inputs: None.
   * Returns: A normalized settings object ready for use in the popup.
   */
  async function loadSettings() {
    const stored = await browser.storage.local.get(["settings", "provider", "apiKeys", "model", "accentColor"]);
    const normalized = normalizeSettings(stored);

    if (!stored.settings) {
      await browser.storage.local.set({ settings: normalized });
    }

    return normalized;
  }

  /**
   * Normalize stored data into the current per-provider settings schema.
   * Inputs: Raw values returned from `browser.storage.local.get(...)`.
   * Returns: A complete settings object with defaults filled in.
   */
  function normalizeSettings(stored) {
    const settings = cloneDefaults();

    if (stored.settings?.providers) {
      settings.provider = stored.settings.provider || settings.provider;
      settings.accentColor = stored.settings.accentColor || stored.accentColor || settings.accentColor;
      settings.providers.anthropic = { ...settings.providers.anthropic, ...(stored.settings.providers.anthropic || {}) };
      settings.providers.gemini = { ...settings.providers.gemini, ...(stored.settings.providers.gemini || {}) };
      settings.providers.openrouter = { ...settings.providers.openrouter, ...(stored.settings.providers.openrouter || {}) };
      return settings;
    }

    settings.provider = stored.provider || settings.provider;
    settings.accentColor = stored.accentColor || settings.accentColor;
    settings.providers.anthropic.apiKey = stored.apiKeys?.anthropic || "";
    settings.providers.gemini.apiKey = stored.apiKeys?.gemini || "";
    settings.providers.openrouter.apiKey = stored.apiKeys?.openrouter || "";

    if (stored.provider && stored.model) {
      settings.providers[stored.provider].model = stored.model;
    }

    return settings;
  }

  /**
   * Persist the normalized settings object and remove legacy storage keys.
   * Inputs: None; uses the current in-memory `settings` draft.
   * Returns: A promise that resolves after storage writes complete.
   */
  async function persistSettings() {
    await browser.storage.local.set({
      settings: {
        provider: settings.provider,
        accentColor: settings.accentColor,
        providers: settings.providers
      }
    });
    await browser.storage.local.remove(["provider", "apiKeys", "model", "accentColor"]);
  }

  /**
   * Copy the active form field values into the in-memory provider draft.
   * Inputs: None.
   * Returns: None; mutates `settings.providers[settings.provider]`.
   */
  function syncDraft() {
    const providerKey = settings.provider;
    settings.providers[providerKey] = {
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim() || PROVIDERS[providerKey].defaultModel
    };
  }

  providerTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      syncDraft();
      renderProvider(tab.dataset.provider);
    });
  });

  customColorText.addEventListener("input", () => {
    const value = customColorText.value.trim();
    if (/^#[0-9a-f]{6}$/i.test(value)) {
      selectColor(value);
    }
  });

  customColorPicker.addEventListener("input", () => {
    selectColor(customColorPicker.value);
  });

  apiKeyInput.addEventListener("input", syncDraft);
  modelInput.addEventListener("input", syncDraft);

  resetModelBtn.addEventListener("click", () => {
    const providerKey = settings.provider;
    modelInput.value = PROVIDERS[providerKey].defaultModel;
    syncDraft();
  });

  toggleVisBtn.addEventListener("click", () => {
    keyVisible = !keyVisible;
    apiKeyInput.type = keyVisible ? "text" : "password";
    toggleVisBtn.textContent = keyVisible ? "Hide" : "Show";
  });

  saveBtn.addEventListener("click", async () => {
    syncDraft();

    const providerKey = settings.provider;
    if (!settings.providers[providerKey].apiKey) {
      showStatus("Enter an API key for the active provider before saving.", "error");
      apiKeyInput.focus();
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    try {
      await persistSettings();
      savedProvider = settings.provider;
      renderProvider(settings.provider);
      showStatus("Settings saved.", "success");
    } catch (err) {
      showStatus(`Could not save: ${err.message}`, "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Settings";
    }
  });

  apiKeyInput.addEventListener("keydown", (event) => { if (event.key === "Enter") saveBtn.click(); });
  modelInput.addEventListener("keydown", (event) => { if (event.key === "Enter") saveBtn.click(); });

  let statusTimeout;
  /**
   * Show a temporary status message at the bottom of the popup.
   * Inputs: Message text and an optional status type (`info`, `success`, or `error`).
   * Returns: None; updates the status banner and schedules it to hide.
   */
  function showStatus(message, type = "info") {
    clearTimeout(statusTimeout);
    statusMsg.textContent = message;
    statusMsg.className = `status-msg status-${type}`;
    statusMsg.hidden = false;
    statusTimeout = setTimeout(() => { statusMsg.hidden = true; }, 3500);
  }
})();
