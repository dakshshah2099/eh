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

      chrome.runtime.sendMessage({ type: actionType, tabId, async: true }, (response) => {
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

  // Initial fetch
  fetchStatus();
  fetchRuntimeStatus();
});
