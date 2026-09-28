// Popup script for Privacy Lens Agent

document.addEventListener('DOMContentLoaded', () => {
  const statusBadge = document.getElementById('statusBadge');
  const statusInfo = document.getElementById('statusInfo');
  const toggleBtn = document.getElementById('toggleBtn');

  let currentRunning = false;

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

  toggleBtn.addEventListener('click', () => {
    toggleBtn.disabled = true;
    const actionType = currentRunning ? 'STOP_AGENT' : 'START_AGENT';

    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      const tabId = activeTab ? activeTab.id : null;
      const task = document.getElementById('taskInput')?.value?.trim() || 'Fill profile and submit form';
      chrome.runtime.sendMessage({ type: actionType, tabId, task, async: true }, (response) => {
        toggleBtn.disabled = false;
        if (chrome.runtime.lastError) {
          console.error('[Popup] Error toggling agent:', chrome.runtime.lastError.message);
          statusInfo.textContent = `Error: ${chrome.runtime.lastError.message}`;
          return;
        }

        if (response && response.success) {
          fetchStatus();
        } else {
          const err = (response && response.error) || 'Failed to toggle agent';
          statusInfo.textContent = `Error: ${err}`;
        }
      });
    });
  });

  function fetchRuntimeStatus() {
    chrome.runtime.sendMessage({ type: 'GET_RUNTIME_STATUS' }, (response) => {
      const runtimeInfo = document.getElementById('runtimeInfo');
      if (!runtimeInfo) return;
      if (response && response.success && response.state) {
        const backend = response.state.backend;
        const icon = backend === 'webgpu' ? '⚡ WebGPU' : '🧩 WASM (fallback)';
        runtimeInfo.textContent = `Backend: ${icon}`;
      } else {
        runtimeInfo.textContent = 'Backend: WASM (ready)';
      }
    });
  }

  // Highlight PII Button logic
  const highlightBtn = document.getElementById('highlightBtn');
  let currentHighlightActive = false;

  function updateHighlightUI(isActive, count = 0) {
    currentHighlightActive = Boolean(isActive);
    if (!highlightBtn) return;
    if (currentHighlightActive) {
      highlightBtn.textContent = `✨ Clear Highlights${count > 0 ? ` (${count})` : ''}`;
      highlightBtn.className = 'btn btn-warning';
    } else {
      highlightBtn.textContent = '🔍 Highlight PII Fields';
      highlightBtn.className = 'btn btn-secondary';
    }
  }

  function fetchHighlightStatus() {
    if (!chrome.tabs?.query) return;
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
            const err = response?.error || 'Failed to highlight';
            statusInfo.textContent = `Highlight error: ${err}`;
          }
        });
      });
    });
  }

  // Initial fetch
  fetchStatus();
  fetchRuntimeStatus();
  fetchHighlightStatus();
});
