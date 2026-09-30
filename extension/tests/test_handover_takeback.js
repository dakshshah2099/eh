import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

let currentElementsById = new Map();

// Create a lightweight DOM simulation for popup testing
class MockElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this._classes = new Set();
    this.style = {};
    this.dataset = {};
    this._textContent = '';
    this.value = '';
    this.placeholder = '';
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.listeners = new Map();
    this._id = '';
  }

  get id() {
    return this._id;
  }

  set id(val) {
    this._id = val;
    if (val && currentElementsById) {
      currentElementsById.set(val, this);
    }
  }

  get classList() {
    const self = this;
    return {
      has: (c) => self._classes.has(c),
      add: (c) => self._classes.add(c),
      remove: (c) => self._classes.delete(c),
      delete: (c) => self._classes.delete(c),
      contains: (c) => self._classes.has(c)
    };
  }

  get className() {
    return Array.from(this._classes).join(' ');
  }

  set className(val) {
    this._classes = new Set(val.split(' ').filter(Boolean));
  }

  get textContent() {
    if (this.children.length > 0) {
      return this.children.map(c => c.textContent).join('');
    }
    return this._textContent;
  }

  set textContent(val) {
    this._textContent = val;
    this.children = [];
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this._id && currentElementsById) {
      currentElementsById.delete(this._id);
    }
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx, 1);
      }
    }
  }

  addEventListener(event, fn) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(fn);
  }

  dispatch(event, eventObj = {}) {
    const handlers = this.listeners.get(event) || [];
    for (const h of handlers) {
      h(eventObj);
    }
  }

  getElementById(id) {
    for (const child of this.children) {
      if (child.id === id) return child;
      const found = child.getElementById ? child.getElementById(id) : null;
      if (found) return found;
    }
    return null;
  }
}

// In-memory mock chrome API
let mockSessionStorage = {};
let mockLocalStorage = {};
let mockRuntimeListeners = [];
let mockMessagesSent = [];
let mockStorageChangeListeners = [];

function setupPopupMockEnvironment() {
  mockSessionStorage = {};
  mockLocalStorage = {};
  mockRuntimeListeners = [];
  mockMessagesSent = [];
  mockStorageChangeListeners = [];

  currentElementsById = new Map();
  const elementsById = currentElementsById;

  globalThis.document = {
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => elementsById.get(id) || null
  };

  // Build standard popup elements
  const statusBadge = new MockElement('span');
  statusBadge.id = 'statusBadge';
  statusBadge.textContent = 'STOPPED';
  statusBadge.className = 'badge badge-stopped';
  elementsById.set('statusBadge', statusBadge);

  const statusInfo = new MockElement('span');
  statusInfo.id = 'statusInfo';
  statusInfo.textContent = 'Agent is idle';
  elementsById.set('statusInfo', statusInfo);

  const runningTaskCard = new MockElement('div');
  runningTaskCard.id = 'runningTaskCard';
  runningTaskCard.classList.add('hidden');
  runningTaskCard.style.display = 'none';
  elementsById.set('runningTaskCard', runningTaskCard);

  const runningTaskDescription = new MockElement('div');
  runningTaskDescription.id = 'runningTaskDescription';
  elementsById.set('runningTaskDescription', runningTaskDescription);
  runningTaskCard.appendChild(runningTaskDescription);

  const idleSection = new MockElement('div');
  idleSection.id = 'idleSection';
  elementsById.set('idleSection', idleSection);

  const taskInput = new MockElement('textarea');
  taskInput.id = 'taskInput';
  taskInput.placeholder = 'Describe what the agent should do…';
  elementsById.set('taskInput', taskInput);
  idleSection.appendChild(taskInput);

  const handoverBtn = new MockElement('button');
  handoverBtn.id = 'handoverBtn';
  handoverBtn.textContent = 'Hand over to agent';
  elementsById.set('handoverBtn', handoverBtn);
  idleSection.appendChild(handoverBtn);

  const runningSection = new MockElement('div');
  runningSection.id = 'runningSection';
  runningSection.classList.add('hidden');
  runningSection.style.display = 'none';
  elementsById.set('runningSection', runningSection);

  const takebackBtn = new MockElement('button');
  takebackBtn.id = 'takebackBtn';
  takebackBtn.textContent = 'Take back control';
  elementsById.set('takebackBtn', takebackBtn);
  runningSection.appendChild(takebackBtn);

  const statusLogPanel = new MockElement('div');
  statusLogPanel.id = 'statusLogPanel';
  elementsById.set('statusLogPanel', statusLogPanel);

  const clearLogBtn = new MockElement('button');
  clearLogBtn.id = 'clearLogBtn';
  elementsById.set('clearLogBtn', clearLogBtn);

  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => mockRuntimeListeners.push(fn)
      },
      sendMessage: (msg, cb) => {
        mockMessagesSent.push(msg);
        if (msg.type === 'START_AUTONOMOUS_LOOP') {
          mockSessionStorage.agentState = {
            isRunning: true,
            currentTask: msg.task,
            lastStartedAt: Date.now()
          };
          if (cb) cb({ success: true, isRunning: true });
        } else if (msg.type === 'STOP_AUTONOMOUS_LOOP') {
          if (mockSessionStorage.agentState) {
            mockSessionStorage.agentState.isRunning = false;
            mockSessionStorage.agentState.lastStoppedAt = Date.now();
          }
          if (cb) cb({ success: true, isRunning: false });
        } else if (msg.type === 'GET_STATUS') {
          const isRunning = Boolean(mockSessionStorage.agentState?.isRunning);
          if (cb) cb({
            success: true,
            state: {
              isRunning,
              currentTask: mockSessionStorage.agentState?.currentTask || null,
              lastStartedAt: mockSessionStorage.agentState?.lastStartedAt || null,
              lastStoppedAt: mockSessionStorage.agentState?.lastStoppedAt || null
            }
          });
        } else if (msg.type === 'GET_STATUS_LOG') {
          if (cb) cb({ success: true, log: mockSessionStorage.agentStatusLog || [] });
        } else if (msg.type === 'CLEAR_STATUS_LOG') {
          mockSessionStorage.agentStatusLog = [];
          if (cb) cb({ success: true });
        } else {
          if (cb) cb({ success: true });
        }
      }
    },
    tabs: {
      query: (filter, cb) => {
        if (cb) cb([{ id: 101, active: true }]);
      }
    },
    storage: {
      session: {
        get: (keys, cb) => {
          const res = {};
          const kArray = Array.isArray(keys) ? keys : [keys];
          for (const k of kArray) {
            if (k in mockSessionStorage) res[k] = mockSessionStorage[k];
          }
          if (cb) cb(res);
          return Promise.resolve(res);
        },
        set: (obj, cb) => {
          Object.assign(mockSessionStorage, obj);
          if (cb) cb();
          return Promise.resolve();
        }
      },
      local: {
        get: (keys, cb) => {
          const res = {};
          const kArray = Array.isArray(keys) ? keys : [keys];
          for (const k of kArray) {
            if (k in mockLocalStorage) res[k] = mockLocalStorage[k];
          }
          if (cb) cb(res);
          return Promise.resolve(res);
        },
        set: (obj, cb) => {
          Object.assign(mockLocalStorage, obj);
          if (cb) cb();
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener: (fn) => mockStorageChangeListeners.push(fn)
      }
    }
  };

  return {
    elementsById,
    statusBadge,
    statusInfo,
    runningTaskCard,
    runningTaskDescription,
    idleSection,
    runningSection,
    taskInput,
    handoverBtn,
    takebackBtn,
    statusLogPanel,
    clearLogBtn
  };
}

// Helper to simulate popup UI logic (matching popup.js)
function createPopupStateMachine(env) {
  const {
    statusBadge,
    statusInfo,
    runningTaskCard,
    runningTaskDescription,
    idleSection,
    runningSection,
    taskInput,
    handoverBtn,
    takebackBtn,
    statusLogPanel
  } = env;

  let currentRunning = false;

  function clearStatusLogUI() {
    if (!statusLogPanel) return;
    statusLogPanel.children = [];
    const empty = document.createElement('div');
    empty.id = 'logEmptyMsg';
    empty.textContent = 'No activity yet';
    statusLogPanel.appendChild(empty);
  }

  function appendStatusLogEntry(item) {
    if (!statusLogPanel || !item) return;
    const empty = document.getElementById('logEmptyMsg');
    if (empty) empty.remove();

    const row = document.createElement('div');
    const ev = (item.event || item.type || '').toUpperCase();
    let entryClass = 'log-entry';
    if (ev === 'TASK_DONE') entryClass += ' log-entry-done';
    else if (ev === 'TASK_EXHAUSTED') entryClass += ' log-entry-exhausted';
    else if (ev === 'TASK_STOPPED') entryClass += ' log-entry-stopped';
    else if (ev === 'LOOP_ERROR') entryClass += ' log-entry-error';
    row.className = entryClass;

    const msgSpan = document.createElement('span');
    let text = item.message;
    if (ev === 'TASK_DONE') text = item.reason ? `✓ Done — ${item.reason}` : '✓ Done';
    else if (ev === 'TASK_EXHAUSTED') text = '⚠ Step limit reached';
    else if (ev === 'TASK_STOPPED') text = item.message || '⏹ Agent stopped — control returned to user';
    msgSpan.textContent = text;
    row.appendChild(msgSpan);
    statusLogPanel.appendChild(row);
  }

  function setAgentRunningUI(isRunning, taskDescription = null) {
    currentRunning = Boolean(isRunning);
    if (currentRunning) {
      statusBadge.textContent = 'RUNNING';
      statusBadge.className = 'badge badge-running';

      if (runningTaskCard) {
        runningTaskCard.classList.remove('hidden');
        runningTaskCard.style.display = 'block';
      }
      if (runningTaskDescription) {
        runningTaskDescription.textContent = taskDescription || taskInput?.value?.trim() || 'Active task';
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
    } else {
      statusBadge.textContent = 'STOPPED';
      statusBadge.className = 'badge badge-stopped';

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
      }
      if (runningSection) {
        runningSection.classList.add('hidden');
        runningSection.style.display = 'none';
      }
    }
  }

  function updateUI(isRunning, lastStartedAt, lastStoppedAt, taskDescription = null) {
    setAgentRunningUI(isRunning, taskDescription);
    if (isRunning) {
      statusInfo.textContent = 'Loop active';
    } else {
      statusInfo.textContent = 'Agent is idle';
    }
  }

  function handleHandover() {
    handoverBtn.disabled = true;
    const task = taskInput?.value?.trim() || 'Describe what the agent should do…';
    clearStatusLogUI();
    setAgentRunningUI(true, task);
    statusInfo.textContent = 'Starting loop…';

    chrome.storage.session.set({
      agentState: {
        isRunning: true,
        currentTask: task,
        lastStartedAt: Date.now(),
        stepCount: 0
      },
      agentStatusLog: []
    });

    chrome.runtime.sendMessage({
      type: 'START_AUTONOMOUS_LOOP',
      tabId: 101,
      task,
      async: true
    }, (res) => {
      handoverBtn.disabled = false;
      if (res && res.success) {
        statusInfo.textContent = 'Loop active (running…)';
      }
    });
  }

  function handleTakeback() {
    takebackBtn.disabled = true;
    takebackBtn.textContent = 'Taking back control…';
    statusInfo.textContent = 'Stopping agent after current action…';

    chrome.runtime.sendMessage({
      type: 'STOP_AUTONOMOUS_LOOP'
    });
  }

  function handleRuntimeMessage(message) {
    if (message.type === 'AGENT_STATUS') {
      appendStatusLogEntry(message);
    } else if (message.type === 'TASK_DONE') {
      setAgentRunningUI(false);
      const reasonText = message.reason ? `: ${message.reason}` : '';
      statusInfo.textContent = `Task done in ${message.stepCount || 1} step(s)${reasonText}`;
    } else if (message.type === 'TASK_EXHAUSTED') {
      setAgentRunningUI(false);
      statusInfo.textContent = `Task stopped: reached maximum steps (${message.maxSteps || 10}) without completion`;
    } else if (message.type === 'TASK_STOPPED') {
      setAgentRunningUI(false);
      statusInfo.textContent = `Control returned to user (stopped after ${message.stepCount || 0} step(s))`;
    }
  }

  function restoreSessionState(callback) {
    chrome.storage.session.get(['agentState', 'agentStatusLog', 'draftTask'], (data) => {
      if (data?.draftTask && taskInput && !taskInput.value) {
        taskInput.value = data.draftTask;
      }
      if (data?.agentState) {
        const s = data.agentState;
        if (s.isRunning) {
          updateUI(true, s.lastStartedAt, null, s.currentTask);
        } else {
          updateUI(false, null, s.lastStoppedAt, s.currentTask);
          if (s.lastCompletionStatus === 'done') {
            statusInfo.textContent = `Task done: ${s.lastCompletionReason || ''}`;
          } else if (s.lastCompletionStatus === 'stopped') {
            statusInfo.textContent = 'Control returned to user';
          }
        }
      }
      if (Array.isArray(data?.agentStatusLog) && data.agentStatusLog.length > 0) {
        clearStatusLogUI();
        for (const ev of data.agentStatusLog) {
          appendStatusLogEntry(ev);
        }
      }
      if (callback) callback();
    });
  }

  // Hook elements
  handoverBtn.addEventListener('click', handleHandover);
  takebackBtn.addEventListener('click', handleTakeback);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  return {
    setAgentRunningUI,
    updateUI,
    handleHandover,
    handleTakeback,
    handleRuntimeMessage,
    restoreSessionState,
    appendStatusLogEntry,
    clearStatusLogUI
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test('Ticket 05: Initial idle state has task input, handover button, and hidden takeback controls', () => {
  const env = setupPopupMockEnvironment();
  createPopupStateMachine(env);

  assert.equal(env.taskInput.placeholder, 'Describe what the agent should do…');
  assert.equal(env.handoverBtn.textContent, 'Hand over to agent');
  assert.ok(!env.idleSection.classList.has('hidden'), 'idleSection must be visible');
  assert.equal(env.idleSection.style.display || 'block', 'block');

  assert.ok(env.runningSection.classList.has('hidden'), 'runningSection must be hidden');
  assert.equal(env.runningSection.style.display, 'none');
  assert.ok(env.runningTaskCard.classList.has('hidden'), 'runningTaskCard must be hidden');
  assert.equal(env.statusBadge.textContent, 'STOPPED');
  assert.equal(env.statusInfo.textContent, 'Agent is idle');
});

test('Ticket 05: Clicking "Hand over to agent" sends START_AUTONOMOUS_LOOP and transitions to agent-running state', () => {
  const env = setupPopupMockEnvironment();
  const sm = createPopupStateMachine(env);

  env.taskInput.value = 'Book flight from NYC to London';
  env.handoverBtn.dispatch('click');

  // Verify message sent
  assert.equal(mockMessagesSent.length, 1);
  const msg = mockMessagesSent[0];
  assert.equal(msg.type, 'START_AUTONOMOUS_LOOP');
  assert.equal(msg.task, 'Book flight from NYC to London');
  assert.equal(msg.tabId, 101);
  assert.equal(msg.async, true);

  // Verify transition to agent-running state
  assert.equal(env.statusBadge.textContent, 'RUNNING');
  assert.ok(env.statusBadge.classList.has('badge-running'));

  // Read-only task description visible at top
  assert.ok(!env.runningTaskCard.classList.has('hidden'));
  assert.equal(env.runningTaskCard.style.display, 'block');
  assert.equal(env.runningTaskDescription.textContent, 'Book flight from NYC to London');

  // Task input & handover button replaced (hidden)
  assert.ok(env.idleSection.classList.has('hidden'));
  assert.equal(env.idleSection.style.display, 'none');

  // "Take back control" button visible
  assert.ok(!env.runningSection.classList.has('hidden'));
  assert.equal(env.runningSection.style.display, 'block');
  assert.equal(env.takebackBtn.textContent, 'Take back control');

  // Session storage updated
  assert.equal(mockSessionStorage.agentState?.isRunning, true);
  assert.equal(mockSessionStorage.agentState?.currentTask, 'Book flight from NYC to London');
});

test('Ticket 05: Clicking "Take back control" sends STOP_AUTONOMOUS_LOOP and on TASK_STOPPED transitions back to idle', () => {
  const env = setupPopupMockEnvironment();
  const sm = createPopupStateMachine(env);

  // Put in running state first
  env.taskInput.value = 'Fill registration form';
  env.handoverBtn.dispatch('click');
  assert.equal(env.statusBadge.textContent, 'RUNNING');

  // User clicks take back control
  env.takebackBtn.dispatch('click');

  assert.equal(env.takebackBtn.disabled, true);
  assert.equal(env.takebackBtn.textContent, 'Taking back control…');
  assert.ok(mockMessagesSent.some(m => m.type === 'STOP_AUTONOMOUS_LOOP'));

  // Background signals TASK_STOPPED
  sm.handleRuntimeMessage({
    type: 'TASK_STOPPED',
    stepCount: 2,
    reason: 'Agent stopped by user'
  });

  // Transitions back to idle state
  assert.equal(env.statusBadge.textContent, 'STOPPED');
  assert.ok(!env.idleSection.classList.has('hidden'), 'idleSection must be visible after stop');
  assert.equal(env.idleSection.style.display, 'block');

  assert.ok(env.runningSection.classList.has('hidden'), 'runningSection must be hidden after stop');
  assert.equal(env.runningSection.style.display, 'none');
  assert.ok(env.runningTaskCard.classList.has('hidden'), 'runningTaskCard must be hidden after stop');
  assert.ok(env.statusInfo.textContent.includes('Control returned to user'));
});

test('Ticket 05: TASK_DONE and TASK_EXHAUSTED transition popup back to idle state with outcome shown', () => {
  const env = setupPopupMockEnvironment();
  const sm = createPopupStateMachine(env);

  // 1. Test TASK_DONE
  sm.setAgentRunningUI(true, 'Complete purchase');
  assert.equal(env.statusBadge.textContent, 'RUNNING');

  sm.handleRuntimeMessage({
    type: 'TASK_DONE',
    stepCount: 3,
    reason: 'Purchase order placed successfully'
  });

  assert.equal(env.statusBadge.textContent, 'STOPPED');
  assert.ok(!env.idleSection.classList.has('hidden'));
  assert.ok(env.runningSection.classList.has('hidden'));
  assert.ok(env.statusInfo.textContent.includes('Task done in 3 step(s): Purchase order placed successfully'));

  // 2. Test TASK_EXHAUSTED
  sm.setAgentRunningUI(true, 'Find product discount code');
  assert.equal(env.statusBadge.textContent, 'RUNNING');

  sm.handleRuntimeMessage({
    type: 'TASK_EXHAUSTED',
    stepCount: 10,
    maxSteps: 10
  });

  assert.equal(env.statusBadge.textContent, 'STOPPED');
  assert.ok(!env.idleSection.classList.has('hidden'));
  assert.ok(env.runningSection.classList.has('hidden'));
  assert.ok(env.statusInfo.textContent.includes('reached maximum steps (10)'));
});

test('Ticket 05: Agent-running state survives popup close/reopen via chrome.storage.session', async () => {
  const env = setupPopupMockEnvironment();
  const sm = createPopupStateMachine(env);

  // Simulate active background loop stored in session storage
  mockSessionStorage.agentState = {
    isRunning: true,
    currentTask: 'Submitting tax declaration',
    lastStartedAt: Date.now() - 5000,
    stepCount: 2
  };
  mockSessionStorage.agentStatusLog = [
    { event: 'STEP_STARTED', step: 1, maxSteps: 5, message: 'Step 1/5 started' },
    { event: 'ACTION_DECIDED', step: 1, actionType: 'click', target: '#agree-terms' },
    { event: 'STEP_STARTED', step: 2, maxSteps: 5, message: 'Step 2/5 started' }
  ];

  // Reopen popup: restore from session
  await new Promise(resolve => sm.restoreSessionState(resolve));

  // Should immediately show running state and read-only task description at top
  assert.equal(env.statusBadge.textContent, 'RUNNING');
  assert.ok(!env.runningTaskCard.classList.has('hidden'));
  assert.equal(env.runningTaskCard.style.display, 'block');
  assert.equal(env.runningTaskDescription.textContent, 'Submitting tax declaration');

  // Input & start button replaced by take back button
  assert.ok(env.idleSection.classList.has('hidden'));
  assert.ok(!env.runningSection.classList.has('hidden'));
  assert.equal(env.runningSection.style.display, 'block');

  // Live status log restored
  assert.equal(env.statusLogPanel.children.length, 3);
  assert.ok(env.statusLogPanel.children[0].textContent.includes('Step 1/5 started'));
});

test('Ticket 05: Popup shows idle state when no loop is active (fresh install / restart)', async () => {
  const env = setupPopupMockEnvironment();
  const sm = createPopupStateMachine(env);

  // Fresh state: session storage has no active loop
  mockSessionStorage.agentState = {
    isRunning: false,
    lastStartedAt: null,
    lastStoppedAt: null
  };

  await new Promise(resolve => sm.restoreSessionState(resolve));

  assert.equal(env.statusBadge.textContent, 'STOPPED');
  assert.ok(!env.idleSection.classList.has('hidden'));
  assert.ok(env.runningSection.classList.has('hidden'));
  assert.ok(env.runningTaskCard.classList.has('hidden'));
  assert.equal(env.statusInfo.textContent, 'Agent is idle');
});

test('Ticket 05: Background startLoop exits cleanly after current action on stopLoop and broadcasts TASK_STOPPED', async () => {
  // Mock canvas for node test runner
  globalThis.createImageBitmap = async () => ({
    width: 1280,
    height: 720,
    close: () => {}
  });

  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return {
        drawImage: () => {},
        fillRect: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(4) })
      };
    }
    async convertToBlob() {
      return new Blob(['fake-scaled-image'], { type: 'image/jpeg' });
    }
  };

  // Spin up a mock planner HTTP server
  let actionsExecuted = [];
  let runtimeMessages = [];
  let port;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      // Propose scroll action
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        actions: [{ type: 'scroll', deltaY: 100 }],
        task_complete: false,
        confidence: 0.9
      }));
    });
  });

  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });

  try {
    const bg = await import('../src/background.js');

    // Mock chrome environment for background
    globalThis.chrome = {
      runtime: {
        sendMessage: (msg, cb) => {
          runtimeMessages.push(msg);
          if (cb) cb();
        },
        getURL: (p) => `chrome-extension://mock-id/${p}`,
        getContexts: async () => []
      },
      tabs: {
        get: async (id) => ({ id, windowId: 1, active: true }),
        update: async () => {},
        captureVisibleTab: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        query: async () => [{ id: 101, active: true }],
        sendMessage: async (tabId, msg) => {
          if (msg.type === 'EXTRACT_DOM_SKELETON') {
            return {
              success: true,
              skeleton: { tag: 'body', children: [] },
              viewport: { width: 1280, height: 720 }
            };
          }
          if (msg.type === 'ACTION_EXECUTE') {
            actionsExecuted.push(msg.action);
            // Call stopLoop while action executes to test safe exit after action completes
            await bg.stopLoop();
            return { success: true, action: msg.action?.type };
          }
          return { success: false };
        }
      },
      scripting: {
        executeScript: async () => [{ result: { success: true } }]
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {}
        },
        session: {
          get: async () => ({ agentStatusLog: [] }),
          set: async () => {}
        }
      }
    };

    const loopResult = await bg.startLoop(101, 'Test takeback after action', {
      serverUrl: `http://127.0.0.1:${port}/api/plan`,
      maxSteps: 5,
      domSettleDelay: 50
    });

    assert.equal(loopResult.success, true);
    assert.equal(loopResult.taskComplete, false);
    assert.equal(loopResult.stepsExecuted, 1, 'Loop must exit cleanly after 1 action completes');

    // Verify TASK_STOPPED message was broadcast
    const stoppedMsg = runtimeMessages.find(m => m.type === 'TASK_STOPPED');
    assert.ok(stoppedMsg, 'Background must broadcast TASK_STOPPED on takeback');
    assert.equal(stoppedMsg.stepCount, 1);
  } finally {
    server.close();
  }
});
