// Popup script for Privacy Lens Agent

// LiteLLM provider → { hint, needsKey, needsBaseUrl }
const PROVIDER_META = {
  openai:           { hint: 'gpt-4o, gpt-4o-mini, o1-mini', needsKey: true,  needsBaseUrl: false },
  anthropic:        { hint: 'claude-3-5-sonnet-20241022, claude-3-haiku-20240307', needsKey: true,  needsBaseUrl: false },
  gemini:           { hint: 'gemini/gemini-2.0-flash, gemini/gemini-1.5-pro', needsKey: true,  needsBaseUrl: false },
  vertex_ai:        { hint: 'vertex_ai/gemini-2.0-flash', needsKey: false, needsBaseUrl: false },
  azure:            { hint: 'azure/<deployment-name>', needsKey: true,  needsBaseUrl: true  },
  bedrock:          { hint: 'bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0', needsKey: false, needsBaseUrl: false },
  groq:             { hint: 'groq/llama-3.3-70b-versatile, groq/gemma2-9b-it', needsKey: true,  needsBaseUrl: false },
  cerebras:         { hint: 'cerebras/llama3.1-8b', needsKey: true,  needsBaseUrl: false },
  fireworks_ai:     { hint: 'fireworks_ai/accounts/fireworks/models/llama-v3p1-8b-instruct', needsKey: true,  needsBaseUrl: false },
  together_ai:      { hint: 'together_ai/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', needsKey: true,  needsBaseUrl: false },
  deepinfra:        { hint: 'deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo', needsKey: true,  needsBaseUrl: false },
  sambanova:        { hint: 'sambanova/Meta-Llama-3.1-8B-Instruct', needsKey: true,  needsBaseUrl: false },
  deepseek:         { hint: 'deepseek/deepseek-chat, deepseek/deepseek-reasoner', needsKey: true,  needsBaseUrl: false },
  mistral:          { hint: 'mistral/mistral-large-latest, mistral/codestral-latest', needsKey: true,  needsBaseUrl: false },
  cohere:           { hint: 'command-r-plus, command-r', needsKey: true,  needsBaseUrl: false },
  xai:              { hint: 'xai/grok-2-latest, xai/grok-3-mini', needsKey: true,  needsBaseUrl: false },
  perplexity:       { hint: 'perplexity/sonar-pro, perplexity/sonar', needsKey: true,  needsBaseUrl: false },
  openrouter:       { hint: 'openrouter/meta-llama/llama-3.3-70b-instruct', needsKey: true,  needsBaseUrl: false },
  ollama:           { hint: 'ollama/llama3.2, ollama/qwen2.5-coder', needsKey: false, needsBaseUrl: true  },
  vllm:             { hint: 'hosted_vllm/meta-llama/Llama-3.1-8B-Instruct', needsKey: false, needsBaseUrl: true  },
  lm_studio:        { hint: 'lm_studio/qwen2.5-14b-instruct', needsKey: false, needsBaseUrl: true  },
  openai_compatible:{ hint: 'openai/<model-name>', needsKey: true,  needsBaseUrl: true  },
};

const DEFAULT_BASE_URLS = {
  ollama:    'http://localhost:11434',
  vllm:      'http://localhost:8000',
  lm_studio: 'http://localhost:1234',
  azure:     'https://<resource>.openai.azure.com',
};

document.addEventListener('DOMContentLoaded', () => {
  const statusBadge = document.getElementById('statusBadge');
  const statusInfo  = document.getElementById('statusInfo');
  const toggleBtn   = document.getElementById('toggleBtn');

  let currentRunning = false;

  // ── Agent status UI ──────────────────────────────────────────────────────
  function updateUI(isRunning, lastStartedAt, lastStoppedAt) {
    currentRunning = Boolean(isRunning);
    if (currentRunning) {
      statusBadge.textContent = 'RUNNING';
      statusBadge.className = 'badge badge-running';
      toggleBtn.textContent = 'Stop Agent';
      toggleBtn.className = 'btn btn-danger';
      const timeStr = lastStartedAt ? new Date(lastStartedAt).toLocaleTimeString() : 'now';
      statusInfo.textContent = `Loop active since ${timeStr}`;
    } else {
      statusBadge.textContent = 'STOPPED';
      statusBadge.className = 'badge badge-stopped';
      toggleBtn.textContent = 'Start Agent';
      toggleBtn.className = 'btn btn-primary';
      const timeStr = lastStoppedAt ? ` (stopped at ${new Date(lastStoppedAt).toLocaleTimeString()})` : '';
      statusInfo.textContent = `Agent is idle${timeStr}`;
    }
  }

  function fetchStatus() {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Popup] Error getting status:', chrome.runtime.lastError.message);
        statusInfo.textContent = 'Service worker disconnected';
        return;
      }
      if (response && response.success && response.state) {
        const { isRunning, lastStartedAt, lastStoppedAt } = response.state;
        updateUI(isRunning, lastStartedAt, lastStoppedAt);
      }
    });
  }

  function resolveTargetTab(cb) {
    if (!chrome.tabs || !chrome.tabs.query) {
      cb(null);
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id != null) {
        cb(tabs[0].id);
        return;
      }
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (fallbackTabs) => {
        cb(fallbackTabs && fallbackTabs[0] && fallbackTabs[0].id != null ? fallbackTabs[0].id : null);
      });
    });
  }

  toggleBtn.addEventListener('click', () => {
    toggleBtn.disabled = true;
    const isStarting = !currentRunning;
    const actionType = isStarting ? 'START_AGENT' : 'STOP_AGENT';

    // Optimistic UI — flip immediately for crisp feedback
    if (isStarting) {
      updateUI(true, Date.now(), null);
      statusInfo.textContent = 'Starting agent\u2026';
    } else {
      updateUI(false, null, Date.now());
      statusInfo.textContent = 'Stopping agent\u2026';
    }

    resolveTargetTab((tabId) => {
      const task = document.getElementById('taskInput')?.value?.trim() || 'Fill profile and submit form';
      chrome.runtime.sendMessage({ type: actionType, tabId, task, async: true }, (response) => {
        toggleBtn.disabled = false;
        if (chrome.runtime.lastError) {
          console.error('[Popup] Error toggling agent:', chrome.runtime.lastError.message);
          statusInfo.textContent = 'Error: ' + chrome.runtime.lastError.message;
          fetchStatus();
          return;
        }

        if (response && response.success) {
          // Confirmed by background — lock in the confirmed state without racing fetchStatus
          const running = Boolean(response.isRunning ?? isStarting);
          updateUI(running, isStarting ? Date.now() : null, !isStarting ? Date.now() : null);
          statusInfo.textContent = running ? 'Loop active (running\u2026)' : 'Agent stopped';
        } else {
          const err = (response && response.error) || 'Failed to toggle agent';
          statusInfo.textContent = 'Error: ' + err;
          fetchStatus();
        }
      });
    });
  });

  // Reactive state sync whenever background writes agentState to storage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.agentState) {
        const state = changes.agentState.newValue;
        if (state) {
          updateUI(state.isRunning, state.lastStartedAt, state.lastStoppedAt);
          if (state.lastError) {
            statusInfo.textContent = 'Error: ' + state.lastError;
          } else if (state.isRunning) {
            const stepText = state.stepCount > 0 ? ' (step ' + state.stepCount + ')' : '';
            statusInfo.textContent = 'Loop active' + stepText;
          }
        }
      }
    });
  }

  // ── Runtime backend info ─────────────────────────────────────────────────
  function fetchRuntimeStatus() {
    chrome.runtime.sendMessage({ type: 'GET_RUNTIME_STATUS' }, (response) => {
      const runtimeInfo = document.getElementById('runtimeInfo');
      if (!runtimeInfo) return;
      if (response && response.success && response.state) {
        const backend = response.state.backend;
        const icon = backend === 'webgpu' ? '\u26A1 WebGPU' : '\uD83E\uDDE9 WASM (fallback)';
        runtimeInfo.textContent = 'Backend: ' + icon;
      } else {
        runtimeInfo.textContent = 'Backend: WASM (ready)';
      }
    });
  }

  // ── LLM Settings Panel ───────────────────────────────────────────────────
  const cloudModeToggle = document.getElementById('cloudModeToggle');
  const cloudSettings   = document.getElementById('cloudSettings');
  const providerSelect  = document.getElementById('providerSelect');
  const modelInput      = document.getElementById('modelInput');
  const apiKeyInput     = document.getElementById('apiKeyInput');
  const apiKeyGroup     = document.getElementById('apiKeyGroup');
  const baseUrlInput    = document.getElementById('baseUrlInput');
  const baseUrlGroup    = document.getElementById('baseUrlGroup');
  const modelHint       = document.getElementById('modelHint');
  const toggleKeyBtn    = document.getElementById('toggleKeyVisibility');
  const saveLlmBtn      = document.getElementById('saveLlmConfig');
  const saveStatus      = document.getElementById('saveStatus');
  const llmModeLabel    = document.getElementById('llmModeLabel');

  function applyProviderMeta(provider) {
    const meta = PROVIDER_META[provider] || { hint: '', needsKey: true, needsBaseUrl: false };
    modelHint.textContent = meta.hint ? 'e.g. ' + meta.hint : '';
    apiKeyGroup.style.display = meta.needsKey ? '' : 'none';
    baseUrlGroup.style.display = meta.needsBaseUrl ? '' : 'none';
    if (meta.needsBaseUrl && DEFAULT_BASE_URLS[provider] && !baseUrlInput.value) {
      baseUrlInput.value = DEFAULT_BASE_URLS[provider];
    }
  }

  providerSelect.addEventListener('change', () => applyProviderMeta(providerSelect.value));

  cloudModeToggle.addEventListener('change', () => {
    const isCloud = cloudModeToggle.checked;
    cloudSettings.classList.toggle('hidden', !isCloud);
    llmModeLabel.textContent = isCloud ? 'Local' : 'Local';
    chrome.storage.local.set({ llmMode: isCloud ? 'cloud' : 'local' });
    chrome.runtime.sendMessage({ type: 'SET_LLM_MODE', mode: isCloud ? 'cloud' : 'local' });
  });

  if (toggleKeyBtn) {
    toggleKeyBtn.addEventListener('click', () => {
      const isPassword = apiKeyInput.type === 'password';
      apiKeyInput.type = isPassword ? 'text' : 'password';
      toggleKeyBtn.textContent = isPassword ? '\uD83D\uDE48' : '\uD83D\uDC41';
    });
  }

  if (saveLlmBtn) {
    saveLlmBtn.addEventListener('click', () => {
      const config = {
        provider: providerSelect.value,
        model:    modelInput.value.trim(),
        apiKey:   apiKeyInput.value.trim(),
        baseUrl:  baseUrlInput.value.trim(),
      };
      if (!config.model) {
        saveStatus.style.color = '#f87171';
        saveStatus.textContent = 'Model name is required';
        setTimeout(() => { saveStatus.textContent = ''; }, 2500);
        return;
      }
      chrome.storage.local.set({ llmConfig: config }, () => {
        chrome.runtime.sendMessage({ type: 'SET_LLM_CONFIG', config });
        saveStatus.style.color = '#34d399';
        saveStatus.textContent = '\u2713 Saved';
        setTimeout(() => { saveStatus.textContent = ''; }, 2000);
      });
    });
  }

  // Load persisted LLM settings
  chrome.storage.local.get(['llmConfig', 'llmMode'], (data) => {
    const isCloud = (data.llmMode || 'local') === 'cloud';
    cloudModeToggle.checked = isCloud;
    cloudSettings.classList.toggle('hidden', !isCloud);
    if (data.llmConfig) {
      const c = data.llmConfig;
      if (c.provider) providerSelect.value = c.provider;
      if (c.model)    modelInput.value = c.model;
      if (c.apiKey)   apiKeyInput.value = c.apiKey;
      if (c.baseUrl)  baseUrlInput.value = c.baseUrl;
    }
    applyProviderMeta(providerSelect.value);
  });

  // ── Highlight PII Button ─────────────────────────────────────────────────
  const highlightBtn = document.getElementById('highlightBtn');
  let currentHighlightActive = false;

  function updateHighlightUI(isActive, count) {
    count = count || 0;
    currentHighlightActive = Boolean(isActive);
    if (!highlightBtn) return;
    if (currentHighlightActive) {
      highlightBtn.textContent = '\u2728 Clear Highlights' + (count > 0 ? ' (' + count + ')' : '');
      highlightBtn.className = 'btn btn-warning';
    } else {
      highlightBtn.textContent = '\uD83D\uDD0D Highlight PII Fields';
      highlightBtn.className = 'btn btn-secondary';
    }
  }

  function fetchHighlightStatus() {
    if (!chrome.tabs || !chrome.tabs.query) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (!activeTab || !activeTab.id) return;
      chrome.runtime.sendMessage({ type: 'GET_PII_HIGHLIGHT_STATUS', tabId: activeTab.id }, (response) => {
        if (!chrome.runtime.lastError && response && response.success) {
          updateHighlightUI(response.active, response.count);
        }
      });
    });
  }

  if (highlightBtn) {
    highlightBtn.addEventListener('click', () => {
      highlightBtn.disabled = true;
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs && tabs[0];
        const tabId = activeTab ? activeTab.id : null;
        chrome.runtime.sendMessage({ type: 'TOGGLE_PII_HIGHLIGHT', tabId }, (response) => {
          highlightBtn.disabled = false;
          if (chrome.runtime.lastError) {
            console.error('[Popup] Error toggling PII highlights:', chrome.runtime.lastError.message);
            statusInfo.textContent = 'Highlight error: ' + chrome.runtime.lastError.message;
            return;
          }
          if (response && response.success) {
            updateHighlightUI(response.active, response.count);
            statusInfo.textContent = response.active
              ? 'Highlighted ' + response.count + ' PII field(s)'
              : 'Cleared PII highlights';
          } else {
            const err = (response && response.error) || 'Failed to highlight';
            statusInfo.textContent = 'Highlight error: ' + err;
          }
        });
      });
    });
  }

  // ── Initial loads ────────────────────────────────────────────────────────
  fetchStatus();
  fetchRuntimeStatus();
  fetchHighlightStatus();
});
