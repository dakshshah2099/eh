// Popup script for Privacy Lens Agent

// LiteLLM provider → { hint, needsBaseUrl }
const PROVIDER_META = {
  openai:           { hint: 'gpt-4o, gpt-4o-mini, o1-mini', needsBaseUrl: false },
  anthropic:        { hint: 'claude-3-5-sonnet-20241022, claude-3-haiku-20240307', needsBaseUrl: false },
  gemini:           { hint: 'gemini/gemini-2.0-flash, gemini/gemini-1.5-pro', needsBaseUrl: false },
  vertex_ai:        { hint: 'vertex_ai/gemini-2.0-flash', needsBaseUrl: false },
  azure:            { hint: 'azure/<deployment-name>', needsBaseUrl: true  },
  bedrock:          { hint: 'bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0', needsBaseUrl: false },
  groq:             { hint: 'groq/llama-3.3-70b-versatile, groq/gemma2-9b-it', needsBaseUrl: false },
  cerebras:         { hint: 'cerebras/llama3.1-8b', needsBaseUrl: false },
  fireworks_ai:     { hint: 'fireworks_ai/accounts/fireworks/models/llama-v3p1-8b-instruct', needsBaseUrl: false },
  together_ai:      { hint: 'together_ai/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', needsBaseUrl: false },
  deepinfra:        { hint: 'deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo', needsBaseUrl: false },
  sambanova:        { hint: 'sambanova/Meta-Llama-3.1-8B-Instruct', needsBaseUrl: false },
  deepseek:         { hint: 'deepseek/deepseek-chat, deepseek/deepseek-reasoner', needsBaseUrl: false },
  mistral:          { hint: 'mistral/mistral-large-latest, mistral/codestral-latest', needsBaseUrl: false },
  cohere:           { hint: 'command-r-plus, command-r', needsBaseUrl: false },
  xai:              { hint: 'xai/grok-2-latest, xai/grok-3-mini', needsBaseUrl: false },
  perplexity:       { hint: 'perplexity/sonar-pro, perplexity/sonar', needsBaseUrl: false },
  openrouter:       { hint: 'openrouter/meta-llama/llama-3.3-70b-instruct', needsBaseUrl: false },
  ollama:           { hint: 'ollama/llama3.2, ollama/qwen2.5-coder', needsBaseUrl: true  },
  vllm:             { hint: 'hosted_vllm/meta-llama/Llama-3.1-8B-Instruct', needsBaseUrl: true  },
  lm_studio:        { hint: 'lm_studio/qwen2.5-14b-instruct', needsBaseUrl: true  },
  openai_compatible:{ hint: 'openai/<model-name>', needsBaseUrl: true  },
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
  const runningTaskCard = document.getElementById('runningTaskCard');
  const runningTaskDescription = document.getElementById('runningTaskDescription');
  const idleSection = document.getElementById('idleSection');
  const runningSection = document.getElementById('runningSection');
  const handoverBtn = document.getElementById('handoverBtn') || document.getElementById('toggleBtn');
  const takebackBtn = document.getElementById('takebackBtn');
  const toggleBtn   = handoverBtn; // Backwards compatibility alias
  const taskInput   = document.getElementById('taskInput');

  let currentRunning = false;

  // ── Agent status & Handover/Takeback UI ──────────────────────────────────
  function setAgentRunningUI(isRunning, taskDescription = null) {
    currentRunning = Boolean(isRunning);

    if (currentRunning) {
      if (statusBadge) {
        statusBadge.textContent = 'RUNNING';
        statusBadge.className = 'badge badge-running';
      }
      if (runningTaskCard) {
        runningTaskCard.classList.remove('hidden');
        runningTaskCard.style.display = 'block';
      }
      if (runningTaskDescription) {
        const text = taskDescription || taskInput?.value?.trim() || 'Active task';
        runningTaskDescription.textContent = text;
      }
      if (idleSection) {
        idleSection.classList.add('hidden');
        idleSection.style.display = 'none';
      }
      if (runningSection) {
        runningSection.classList.remove('hidden');
        runningSection.style.display = 'block';
      }
      if (takebackBtn) {
        takebackBtn.disabled = false;
        takebackBtn.textContent = 'Take back control';
      }
      if (handoverBtn) {
        handoverBtn.textContent = 'Stop Agent';
        handoverBtn.className = 'btn btn-danger';
      }
    } else {
      if (statusBadge) {
        statusBadge.textContent = 'STOPPED';
        statusBadge.className = 'badge badge-stopped';
      }
      if (runningTaskCard) {
        runningTaskCard.classList.add('hidden');
        runningTaskCard.style.display = 'none';
      }
      if (idleSection) {
        idleSection.classList.remove('hidden');
        idleSection.style.display = 'block';
      }
      if (handoverBtn) {
        handoverBtn.disabled = false;
        handoverBtn.textContent = 'Hand over to agent';
        handoverBtn.className = 'btn btn-primary handover-btn';
      }
      if (runningSection) {
        runningSection.classList.add('hidden');
        runningSection.style.display = 'none';
      }
      if (takebackBtn) {
        takebackBtn.disabled = false;
        takebackBtn.textContent = 'Take back control';
      }
    }
  }

  function updateUI(isRunning, lastStartedAt, lastStoppedAt, taskDescription = null) {
    setAgentRunningUI(isRunning, taskDescription);
    if (isRunning) {
      const timeStr = lastStartedAt ? new Date(lastStartedAt).toLocaleTimeString() : 'now';
      if (statusInfo) {
        statusInfo.textContent = `Loop active since ${timeStr}`;
      }
    } else {
      const timeStr = lastStoppedAt ? ` (stopped at ${new Date(lastStoppedAt).toLocaleTimeString()})` : '';
      if (statusInfo && (!statusInfo.textContent || statusInfo.textContent.startsWith('Loop active') || statusInfo.textContent.startsWith('Starting'))) {
        statusInfo.textContent = `Agent is idle${timeStr}`;
      }
    }
  }

  function fetchStatus() {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (chrome.runtime?.lastError) {
        console.error('[Popup] Error getting status:', chrome.runtime.lastError.message);
        if (statusInfo) statusInfo.textContent = 'Service worker disconnected';
        setAgentRunningUI(false);
        return;
      }
      if (response && response.success && response.state) {
        const { isRunning, lastStartedAt, lastStoppedAt, currentTask } = response.state;
        updateUI(isRunning, lastStartedAt, lastStoppedAt, currentTask);
      } else {
        setAgentRunningUI(false);
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

  const statusLogPanel = document.getElementById('statusLogPanel');
  const clearLogBtn    = document.getElementById('clearLogBtn');

  // ── Activity Stream / Status Log Panel ───────────────────────────────────
  function clearStatusLogUI() {
    if (!statusLogPanel) return;
    statusLogPanel.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'log-empty-msg';
    empty.id = 'logEmptyMsg';
    empty.textContent = 'No activity yet';
    statusLogPanel.appendChild(empty);
  }

  function appendStatusLogEntry(item) {
    if (!statusLogPanel || !item) return;

    // Remove empty placeholder
    const empty = document.getElementById('logEmptyMsg');
    if (empty) {
      empty.remove();
    }

    const row = document.createElement('div');
    const ev = (item.event || item.type || '').toUpperCase();

    let entryClass = 'log-entry';
    if (ev === 'TASK_DONE') {
      entryClass += ' log-entry-done';
    } else if (ev === 'TASK_EXHAUSTED') {
      entryClass += ' log-entry-exhausted';
    } else if (ev === 'TASK_STOPPED') {
      entryClass += ' log-entry-stopped';
    } else if (ev === 'LOOP_ERROR' || item.error || item.level === 'error') {
      entryClass += ' log-entry-error';
    } else if (ev === 'STEP_STARTED') {
      entryClass += ' log-entry-step';
    } else if (ev === 'ACTION_DECIDED' || ev === 'ACTION_EXECUTED') {
      entryClass += ' log-entry-action';
    }
    row.className = entryClass;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    const ts = item.timestamp ? new Date(item.timestamp) : new Date();
    timeSpan.textContent = `[${ts.toLocaleTimeString()}]`;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-msg';

    let text = item.message;
    if (ev === 'TASK_DONE') {
      text = item.reason ? `✓ Done — ${item.reason}` : (item.message || '✓ Done');
    } else if (ev === 'TASK_EXHAUSTED') {
      text = '⚠ Step limit reached';
    } else if (ev === 'TASK_STOPPED') {
      text = item.message || '⏹ Agent stopped — control returned to user';
    } else if (ev === 'LOOP_ERROR') {
      text = item.error ? `Error: ${item.error}` : (item.message || 'Error occurred');
    } else if (!text) {
      if (ev === 'STEP_STARTED') {
        text = `Step ${item.step}/${item.maxSteps || '?'} started`;
      } else if (ev === 'ACTION_DECIDED') {
        text = `Action decided: ${item.actionType || 'unknown'}${item.target ? ' on ' + item.target : ''}`;
      } else if (ev === 'ACTION_EXECUTED') {
        text = `Action executed: ${item.actionType || 'unknown'}${item.target ? ' on ' + item.target : ''} (${item.success ? 'success' : 'failed'})`;
      } else {
        text = JSON.stringify(item);
      }
    }
    msgSpan.textContent = text;

    row.appendChild(timeSpan);
    row.appendChild(msgSpan);
    statusLogPanel.appendChild(row);

    statusLogPanel.scrollTop = statusLogPanel.scrollHeight;
  }

  function restoreStatusLog() {
    function handleEvents(events) {
      if (Array.isArray(events) && events.length > 0) {
        clearStatusLogUI();
        const empty = document.getElementById('logEmptyMsg');
        if (empty) empty.remove();
        for (const ev of events) {
          appendStatusLogEntry(ev);
        }
      }
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.session?.get) {
      chrome.storage.session.get(['agentStatusLog'], (data) => {
        if (!chrome.runtime?.lastError && Array.isArray(data?.agentStatusLog) && data.agentStatusLog.length > 0) {
          handleEvents(data.agentStatusLog);
        } else {
          fetchStatusLogViaMessage();
        }
      });
    } else {
      fetchStatusLogViaMessage();
    }

    function fetchStatusLogViaMessage() {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'GET_STATUS_LOG' }, (res) => {
          if (!chrome.runtime?.lastError && res && res.success && Array.isArray(res.log) && res.log.length > 0) {
            handleEvents(res.log);
          }
        });
      }
    }
  }

  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      clearStatusLogUI();
      if (typeof chrome !== 'undefined') {
        if (chrome.storage?.session?.set) {
          chrome.storage.session.set({ agentStatusLog: [] });
        }
        if (chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: 'CLEAR_STATUS_LOG' }, () => {});
        }
      }
    });
  }

  if (taskInput) {
    taskInput.addEventListener('input', () => {
      if (typeof chrome !== 'undefined' && chrome.storage?.session?.set) {
        chrome.storage.session.set({ draftTask: taskInput.value });
      }
    });
  }

  // ── Handover to agent button handler ──
  function handleHandover() {
    if (handoverBtn) handoverBtn.disabled = true;
    const task = taskInput?.value?.trim() || 'Describe what the agent should do…';

    // Optimistically transition UI immediately
    clearStatusLogUI();
    setAgentRunningUI(true, task);
    if (statusInfo) statusInfo.textContent = 'Starting loop…';

    if (typeof chrome !== 'undefined' && chrome.storage?.session?.set) {
      chrome.storage.session.set({
        agentState: {
          isRunning: true,
          currentTask: task,
          lastStartedAt: Date.now(),
          stepCount: 0
        },
        agentStatusLog: []
      });
    }

    resolveTargetTab((tabId) => {
      chrome.runtime.sendMessage({
        type: 'START_AUTONOMOUS_LOOP',
        tabId,
        task,
        async: true
      }, (response) => {
        if (handoverBtn) handoverBtn.disabled = false;
        if (chrome.runtime?.lastError) {
          console.error('[Popup] Error starting loop:', chrome.runtime.lastError.message);
          setAgentRunningUI(false);
          if (statusInfo) statusInfo.textContent = 'Error: ' + chrome.runtime.lastError.message;
          appendStatusLogEntry({
            event: 'LOOP_ERROR',
            error: chrome.runtime.lastError.message
          });
          fetchStatus();
          return;
        }
        if (response && response.success) {
          if (statusInfo) statusInfo.textContent = 'Loop active (running…)';
        } else {
          const err = response?.error || 'Failed to start loop';
          setAgentRunningUI(false);
          if (statusInfo) statusInfo.textContent = 'Error: ' + err;
          appendStatusLogEntry({
            event: 'LOOP_ERROR',
            error: err
          });
          fetchStatus();
        }
      });
    });
  }

  // ── Take back control button handler ──
  function handleTakeback() {
    if (takebackBtn) {
      takebackBtn.disabled = true;
      takebackBtn.textContent = 'Taking back control…';
    }
    if (statusInfo) statusInfo.textContent = 'Stopping agent after current action…';

    chrome.runtime.sendMessage({
      type: 'STOP_AUTONOMOUS_LOOP'
    }, (response) => {
      if (chrome.runtime?.lastError) {
        console.warn('[Popup] Error stopping loop:', chrome.runtime.lastError.message);
      }
      if (response && response.success && !response.isRunning) {
        // Confirmed stopped by background
      }
    });
  }

  if (handoverBtn) {
    handoverBtn.addEventListener('click', () => {
      if (currentRunning) {
        handleTakeback();
      } else {
        handleHandover();
      }
    });
  }

  if (takebackBtn) {
    takebackBtn.addEventListener('click', () => {
      handleTakeback();
    });
  }

  // ── Session & Storage Restore ──
  function restoreSessionState() {
    function handleEvents(events) {
      if (Array.isArray(events) && events.length > 0) {
        clearStatusLogUI();
        const empty = document.getElementById('logEmptyMsg');
        if (empty) empty.remove();
        for (const ev of events) {
          appendStatusLogEntry(ev);
        }
      }
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.session?.get) {
      chrome.storage.session.get(['agentState', 'agentStatusLog', 'draftTask'], (data) => {
        if (!chrome.runtime?.lastError && data?.draftTask && taskInput && !taskInput.value) {
          taskInput.value = data.draftTask;
        }

        if (!chrome.runtime?.lastError && data?.agentState) {
          const s = data.agentState;
          if (s.isRunning) {
            updateUI(true, s.lastStartedAt, null, s.currentTask);
            const stepText = s.stepCount > 0 ? ' (step ' + s.stepCount + ')' : '';
            if (statusInfo) statusInfo.textContent = 'Loop active' + stepText;
          } else {
            updateUI(false, null, s.lastStoppedAt, s.currentTask);
            if (statusInfo) {
              if (s.lastCompletionStatus === 'done') {
                const reasonText = s.lastCompletionReason ? ': ' + s.lastCompletionReason : '';
                statusInfo.textContent = 'Task done in ' + (s.stepCount || 1) + ' step(s)' + reasonText;
              } else if (s.lastCompletionStatus === 'exhausted') {
                statusInfo.textContent = 'Task stopped: reached maximum steps (' + (s.stepCount || 10) + ') without completion';
              } else if (s.lastCompletionStatus === 'stopped') {
                statusInfo.textContent = 'Control returned to user (stopped after ' + (s.stepCount || 0) + ' step(s))';
              } else {
                statusInfo.textContent = 'Agent is idle';
              }
            }
          }
        } else {
          fetchStatus();
        }

        if (!chrome.runtime?.lastError && Array.isArray(data?.agentStatusLog) && data.agentStatusLog.length > 0) {
          handleEvents(data.agentStatusLog);
        } else {
          fetchStatusLogViaMessage();
        }
      });
    } else {
      fetchStatus();
      fetchStatusLogViaMessage();
    }

    function fetchStatusLogViaMessage() {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'GET_STATUS_LOG' }, (res) => {
          if (!chrome.runtime?.lastError && res && res.success && Array.isArray(res.log) && res.log.length > 0) {
            handleEvents(res.log);
          }
        });
      }
    }
  }

  // Reactive state sync whenever background writes agentState to storage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session') {
        if (changes.agentState) {
          const state = changes.agentState.newValue;
          if (state) {
            updateUI(state.isRunning, state.lastStartedAt, state.lastStoppedAt, state.currentTask);
            if (statusInfo) {
              if (state.lastError) {
                statusInfo.textContent = 'Error: ' + state.lastError;
              } else if (state.isRunning) {
                const stepText = state.stepCount > 0 ? ' (step ' + state.stepCount + ')' : '';
                statusInfo.textContent = 'Loop active' + stepText;
              } else if (state.lastCompletionStatus === 'done') {
                const reasonText = state.lastCompletionReason ? ': ' + state.lastCompletionReason : '';
                statusInfo.textContent = 'Task done in ' + (state.stepCount || 1) + ' step(s)' + reasonText;
              } else if (state.lastCompletionStatus === 'exhausted') {
                statusInfo.textContent = 'Task stopped: reached maximum steps (' + (state.stepCount || 10) + ') without completion';
              } else if (state.lastCompletionStatus === 'stopped') {
                statusInfo.textContent = 'Control returned to user (stopped after ' + (state.stepCount || 0) + ' step(s))';
              }
            }
          }
        }
        if (changes.agentStatusLog) {
          const newLog = changes.agentStatusLog.newValue;
          if (Array.isArray(newLog) && newLog.length === 0) {
            clearStatusLogUI();
          }
        }
      }
      if (area === 'local') {
        if (changes.agentState) {
          const state = changes.agentState.newValue;
          if (state) {
            updateUI(state.isRunning, state.lastStartedAt, state.lastStoppedAt, state.currentTask);
            if (statusInfo) {
              if (state.lastError) {
                statusInfo.textContent = 'Error: ' + state.lastError;
              } else if (state.isRunning) {
                const stepText = state.stepCount > 0 ? ' (step ' + state.stepCount + ')' : '';
                statusInfo.textContent = 'Loop active' + stepText;
              } else if (state.lastCompletionStatus === 'done') {
                const reasonText = state.lastCompletionReason ? ': ' + state.lastCompletionReason : '';
                statusInfo.textContent = 'Task done in ' + (state.stepCount || 1) + ' step(s)' + reasonText;
              } else if (state.lastCompletionStatus === 'exhausted') {
                statusInfo.textContent = 'Task stopped: reached maximum steps (' + (state.stepCount || 10) + ') without completion';
              } else if (state.lastCompletionStatus === 'stopped') {
                statusInfo.textContent = 'Control returned to user (stopped after ' + (state.stepCount || 0) + ' step(s))';
              }
            }
          }
        }
        if (changes.secrets || changes.secret_aliases) {
          refreshSecrets();
        }
      }
    });
  }

  // Listen for task completion, exhaustion, stopped, and live agent status runtime messages
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'AGENT_STATUS') {
        if (message.event === 'STEP_STARTED' && message.step === 1) {
          clearStatusLogUI();
        }
        appendStatusLogEntry(message);
      } else if (message.type === 'TASK_DONE') {
        setAgentRunningUI(false);
        const reasonText = message.reason ? `: ${message.reason}` : '';
        const steps = message.stepCount ?? message.steps ?? 1;
        if (statusInfo) statusInfo.textContent = `Task done in ${steps} step(s)${reasonText}`;
      } else if (message.type === 'TASK_EXHAUSTED') {
        setAgentRunningUI(false);
        const max = message.maxSteps ?? message.stepCount ?? message.steps ?? 10;
        if (statusInfo) statusInfo.textContent = `Task stopped: reached maximum steps (${max}) without completion`;
      } else if (message.type === 'TASK_STOPPED') {
        setAgentRunningUI(false);
        const steps = message.stepCount ?? message.steps ?? 0;
        if (statusInfo) statusInfo.textContent = `Control returned to user (stopped after ${steps} step(s))`;
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
  const cloudModeToggle      = document.getElementById('cloudModeToggle');
  const cloudSettings        = document.getElementById('cloudSettings');
  const providerSelect       = document.getElementById('providerSelect');
  const modelInput           = document.getElementById('modelInput');
  const apiKeyInput          = document.getElementById('apiKeyInput');
  const toggleApiKeyBtn      = document.getElementById('toggleApiKeyVisibility');
  const serverTokenInput     = document.getElementById('serverTokenInput');
  const baseUrlInput         = document.getElementById('baseUrlInput');
  const baseUrlGroup         = document.getElementById('baseUrlGroup');
  const modelHint            = document.getElementById('modelHint');
  const toggleServerTokenBtn = document.getElementById('toggleServerTokenVisibility');
  const saveLlmBtn           = document.getElementById('saveLlmConfig');
  const saveStatus           = document.getElementById('saveStatus');
  const llmModeLabel         = document.getElementById('llmModeLabel');

  function applyProviderMeta(provider) {
    const meta = PROVIDER_META[provider] || { hint: '', needsBaseUrl: false };
    modelHint.textContent = meta.hint ? `e.g. ${meta.hint}` : '';
    baseUrlGroup.style.display = meta.needsBaseUrl ? '' : 'none';
    if (meta.needsBaseUrl && DEFAULT_BASE_URLS[provider] && !baseUrlInput.value) {
      baseUrlInput.value = DEFAULT_BASE_URLS[provider];
    }
  }

  providerSelect.addEventListener('change', () => applyProviderMeta(providerSelect.value));

  cloudModeToggle.addEventListener('change', () => {
    const isCloud = cloudModeToggle.checked;
    cloudSettings.classList.toggle('hidden', !isCloud);
    llmModeLabel.textContent = isCloud ? 'Cloud' : 'Local';
    // Save mode preference
    chrome.storage.local.set({ llmMode: isCloud ? 'cloud' : 'local' });
    // Notify background
    chrome.runtime.sendMessage({ type: 'SET_LLM_MODE', mode: isCloud ? 'cloud' : 'local' });
  });

  if (toggleApiKeyBtn && apiKeyInput) {
    toggleApiKeyBtn.addEventListener('click', () => {
      const isPassword = apiKeyInput.type === 'password';
      apiKeyInput.type = isPassword ? 'text' : 'password';
      toggleApiKeyBtn.textContent = isPassword ? '🙈' : '👁';
    });
  }

  if (toggleServerTokenBtn && serverTokenInput) {
    toggleServerTokenBtn.addEventListener('click', () => {
      const isPassword = serverTokenInput.type === 'password';
      serverTokenInput.type = isPassword ? 'text' : 'password';
      toggleServerTokenBtn.textContent = isPassword ? '🙈' : '👁';
    });
  }

  if (saveLlmBtn) {
    saveLlmBtn.addEventListener('click', () => {
      const config = {
        provider:    providerSelect.value,
        model:       modelInput.value.trim(),
        apiKey:      apiKeyInput ? apiKeyInput.value.trim() : '',
        baseUrl:     baseUrlInput.value.trim(),
        serverToken: serverTokenInput ? serverTokenInput.value.trim() : '',
      };

      if (!config.model) {
        saveStatus.style.color = '#f87171';
        saveStatus.textContent = 'Model name is required';
        setTimeout(() => { saveStatus.textContent = ''; }, 2500);
        return;
      }

      chrome.storage.local.set({ llmConfig: config }, () => {
        // Forward to background so it can use it immediately
        chrome.runtime.sendMessage({ type: 'SET_LLM_CONFIG', config });
        saveStatus.style.color = '#34d399';
        saveStatus.textContent = '✓ Saved';
        setTimeout(() => { saveStatus.textContent = ''; }, 2000);
      });
    });
  }

  // Load persisted LLM settings
  chrome.storage.local.get(['llmConfig', 'llmMode'], (data) => {
    const mode = data.llmMode || 'local';
    const isCloud = mode === 'cloud';
    cloudModeToggle.checked = isCloud;
    cloudSettings.classList.toggle('hidden', !isCloud);
    llmModeLabel.textContent = isCloud ? 'Cloud' : 'Local';

    if (data.llmConfig) {
      const c = data.llmConfig;
      if (c.provider) providerSelect.value = c.provider;
      if (c.model)    modelInput.value = c.model;
      if (c.apiKey && apiKeyInput) apiKeyInput.value = c.apiKey;
      if (c.baseUrl)  baseUrlInput.value = c.baseUrl;
      if (c.serverToken && serverTokenInput) serverTokenInput.value = c.serverToken;
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
      highlightBtn.textContent = '✨ Clear Highlights' + (count > 0 ? ` (${count})` : '');
      highlightBtn.className = 'btn btn-warning';
    } else {
      highlightBtn.textContent = '🔍 Highlight PII Fields';
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
            statusInfo.textContent = `Highlight error: ${chrome.runtime.lastError.message}`;
            return;
          }
          if (response && response.success) {
            updateHighlightUI(response.active, response.count);
            statusInfo.textContent = response.active
              ? `Highlighted ${response.count} PII field(s)`
              : 'Cleared PII highlights';
          } else {
            const err = (response && response.error) || 'Failed to highlight';
            statusInfo.textContent = `Highlight error: ${err}`;
          }
        });
      });
    });
  }

  // ── Secret Vault UI ───────────────────────────────────────────────────────
  const secretsSectionHeader   = document.getElementById('secretsSectionHeader');
  const secretsContent         = document.getElementById('secretsContent');
  const secretsToggleIcon      = document.getElementById('secretsToggleIcon');
  const secretAliasInput       = document.getElementById('secretAliasInput');
  const secretValueInput       = document.getElementById('secretValueInput');
  const toggleSecretVisibility = document.getElementById('toggleSecretVisibility');
  const saveSecretBtn          = document.getElementById('saveSecretBtn');
  const secretSaveStatus       = document.getElementById('secretSaveStatus');
  const secretList             = document.getElementById('secretList');
  const emptySecretsMsg        = document.getElementById('emptySecretsMsg');
  const secretCountBadge       = document.getElementById('secretCountBadge');

  let secretsCollapsed = false;

  if (secretsSectionHeader && secretsContent) {
    secretsSectionHeader.addEventListener('click', () => {
      secretsCollapsed = !secretsCollapsed;
      secretsContent.classList.toggle('hidden', secretsCollapsed);
      if (secretsToggleIcon) {
        secretsToggleIcon.style.transform = secretsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
      }
    });
  }

  if (toggleSecretVisibility && secretValueInput) {
    toggleSecretVisibility.addEventListener('click', () => {
      const isPassword = secretValueInput.type === 'password';
      secretValueInput.type = isPassword ? 'text' : 'password';
      toggleSecretVisibility.textContent = isPassword ? '🙈' : '👁';
    });
  }

  function showSecretStatus(text, color = '#34d399', durationMs = 2500) {
    if (!secretSaveStatus) return;
    secretSaveStatus.style.color = color;
    secretSaveStatus.textContent = text;
    if (durationMs > 0) {
      setTimeout(() => {
        if (secretSaveStatus.textContent === text) {
          secretSaveStatus.textContent = '';
        }
      }, durationMs);
    }
  }

  function loadSecretsFromVault(callback) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      if (callback) callback({});
      return;
    }
    chrome.storage.local.get(['secrets', 'secret_aliases'], (data) => {
      if (chrome.runtime?.lastError) {
        if (callback) callback({});
        return;
      }
      const secrets = (data && data.secrets) || {};
      if (callback) callback(secrets);
    });
  }

  function saveSecretToVault(alias, value, callback) {
    const cleanAlias = String(alias || '').trim();
    const cleanValue = String(value || '');

    if (!cleanAlias) {
      if (callback) callback({ success: false, error: 'Alias name is required' });
      return;
    }
    if (!cleanValue) {
      if (callback) callback({ success: false, error: 'Secret value is required' });
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      if (callback) callback({ success: false, error: 'chrome.storage.local unavailable' });
      return;
    }

    chrome.storage.local.get(['secrets', 'secret_aliases'], (data) => {
      if (chrome.runtime?.lastError) {
        if (callback) callback({ success: false, error: chrome.runtime.lastError.message });
        return;
      }

      const secrets = Object.assign({}, data && data.secrets);
      secrets[cleanAlias] = cleanValue;

      const existingAliases = Array.isArray(data?.secret_aliases)
        ? data.secret_aliases
        : Object.keys(secrets);
      const aliases = Array.from(new Set([...existingAliases, cleanAlias]));

      const payload = {
        secrets,
        secret_aliases: aliases,
        [cleanAlias]: cleanValue,
        [`secret_${cleanAlias}`]: cleanValue
      };

      chrome.storage.local.set(payload, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          if (callback) callback({ success: false, error: chrome.runtime.lastError.message });
        } else {
          if (callback) callback({ success: true, alias: cleanAlias });
        }
      });
    });
  }

  function deleteSecretFromVault(alias, callback) {
    const cleanAlias = String(alias || '').trim();
    if (!cleanAlias) {
      if (callback) callback({ success: false, error: 'Alias name is required' });
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      if (callback) callback({ success: false, error: 'chrome.storage.local unavailable' });
      return;
    }

    chrome.storage.local.get(['secrets', 'secret_aliases'], (data) => {
      if (chrome.runtime?.lastError) {
        if (callback) callback({ success: false, error: chrome.runtime.lastError.message });
        return;
      }

      const secrets = Object.assign({}, data && data.secrets);
      delete secrets[cleanAlias];

      const existingAliases = Array.isArray(data?.secret_aliases)
        ? data.secret_aliases
        : Object.keys(secrets);
      const aliases = existingAliases.filter((a) => a !== cleanAlias);

      chrome.storage.local.set({
        secrets,
        secret_aliases: aliases
      }, () => {
        if (chrome.storage.local.remove) {
          chrome.storage.local.remove([cleanAlias, `secret_${cleanAlias}`], () => {
            if (chrome.runtime && chrome.runtime.lastError) {
              if (callback) callback({ success: false, error: chrome.runtime.lastError.message });
            } else {
              if (callback) callback({ success: true, alias: cleanAlias });
            }
          });
        } else {
          if (callback) callback({ success: true, alias: cleanAlias });
        }
      });
    });
  }

  function renderSecretsList(secretsMap) {
    if (!secretList) return;
    secretList.innerHTML = '';
    const aliases = Object.keys(secretsMap || {}).sort();

    if (secretCountBadge) {
      secretCountBadge.textContent = `${aliases.length} secret${aliases.length === 1 ? '' : 's'}`;
    }

    if (aliases.length === 0) {
      if (emptySecretsMsg) emptySecretsMsg.style.display = 'block';
      return;
    }

    if (emptySecretsMsg) emptySecretsMsg.style.display = 'none';

    for (const alias of aliases) {
      const row = document.createElement('div');
      row.className = 'secret-item';
      row.dataset.alias = alias;

      const infoDiv = document.createElement('div');
      infoDiv.className = 'secret-item-info';

      const aliasEl = document.createElement('span');
      aliasEl.className = 'secret-alias';
      aliasEl.textContent = alias;

      const maskedEl = document.createElement('span');
      maskedEl.className = 'secret-masked';
      maskedEl.textContent = '•••••••• (vaulted)';

      infoDiv.appendChild(aliasEl);
      infoDiv.appendChild(maskedEl);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'icon-btn-delete';
      deleteBtn.title = `Delete ${alias}`;
      deleteBtn.textContent = '✕';
      deleteBtn.setAttribute('aria-label', `Delete secret ${alias}`);
      deleteBtn.addEventListener('click', () => {
        deleteSecretFromVault(alias, (res) => {
          if (res && res.success) {
            showSecretStatus(`✓ Deleted ${alias}`, '#f87171');
            refreshSecrets();
          } else {
            showSecretStatus(`Error: ${res?.error || 'failed to delete'}`, '#f87171');
          }
        });
      });

      row.appendChild(infoDiv);
      row.appendChild(deleteBtn);
      secretList.appendChild(row);
    }
  }

  function refreshSecrets() {
    loadSecretsFromVault((secrets) => {
      renderSecretsList(secrets);
    });
  }

  if (saveSecretBtn) {
    saveSecretBtn.addEventListener('click', () => {
      const alias = secretAliasInput ? secretAliasInput.value.trim() : '';
      const value = secretValueInput ? secretValueInput.value : '';

      if (!alias) {
        showSecretStatus('Alias name is required', '#f87171');
        return;
      }
      if (!value) {
        showSecretStatus('Secret value is required', '#f87171');
        return;
      }

      saveSecretToVault(alias, value, (res) => {
        if (res && res.success) {
          // Immediately wipe input values to prevent plaintext retention
          if (secretAliasInput) secretAliasInput.value = '';
          if (secretValueInput) {
            secretValueInput.value = '';
            secretValueInput.type = 'password';
          }
          if (toggleSecretVisibility) toggleSecretVisibility.textContent = '👁';

          showSecretStatus(`✓ Saved ${alias} to vault`, '#34d399');
          refreshSecrets();
        } else {
          showSecretStatus(`Error: ${res?.error || 'failed to save'}`, '#f87171');
        }
      });
    });
  }

  // Expose on window for testing or script access
  if (typeof window !== 'undefined') {
    window.SecretVault = {
      loadSecretsFromVault,
      saveSecretToVault,
      deleteSecretFromVault,
      renderSecretsList,
      refreshSecrets
    };
    window.StatusLog = {
      appendStatusLogEntry,
      clearStatusLogUI,
      restoreStatusLog
    };
    window.HandoverUX = {
      setAgentRunningUI,
      updateUI,
      fetchStatus,
      restoreSessionState,
      handleHandover,
      handleTakeback
    };
  }

  // ── Initial loads ────────────────────────────────────────────────────────
  restoreSessionState();
  fetchRuntimeStatus();
  fetchHighlightStatus();
  refreshSecrets();
});
