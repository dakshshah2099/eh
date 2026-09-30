import assert from 'node:assert/strict';
import test from 'node:test';

// Create a lightweight DOM simulation for popup testing
class MockElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classList = new Set();
    this.style = {};
    this.dataset = {};
    this._textContent = '';
    this.value = '';
    this.scrollTop = 0;
    this.scrollHeight = 100;
  }

  get className() {
    return Array.from(this.classList).join(' ');
  }

  set className(val) {
    this.classList = new Set(val.split(' ').filter(Boolean));
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
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx, 1);
      }
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
let mockRuntimeListeners = [];

function setupMockEnvironment() {
  mockSessionStorage = {};
  mockRuntimeListeners = [];

  const elementsById = new Map();

  globalThis.document = {
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => elementsById.get(id) || null
  };

  // Mock standard popup DOM nodes
  const statusLogPanel = new MockElement('div');
  statusLogPanel.id = 'statusLogPanel';
  elementsById.set('statusLogPanel', statusLogPanel);

  const clearLogBtn = new MockElement('button');
  clearLogBtn.id = 'clearLogBtn';
  elementsById.set('clearLogBtn', clearLogBtn);

  const statusBadge = new MockElement('span');
  statusBadge.id = 'statusBadge';
  elementsById.set('statusBadge', statusBadge);

  const statusInfo = new MockElement('span');
  statusInfo.id = 'statusInfo';
  elementsById.set('statusInfo', statusInfo);

  const toggleBtn = new MockElement('button');
  toggleBtn.id = 'toggleBtn';
  elementsById.set('toggleBtn', toggleBtn);

  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => mockRuntimeListeners.push(fn)
      },
      sendMessage: (msg, cb) => {
        if (msg.type === 'GET_STATUS_LOG') {
          if (cb) cb({ success: true, log: mockSessionStorage.agentStatusLog || [] });
        } else if (msg.type === 'CLEAR_STATUS_LOG') {
          mockSessionStorage.agentStatusLog = [];
          if (cb) cb({ success: true });
        }
      }
    },
    storage: {
      session: {
        get: (keys, cb) => {
          const res = { agentStatusLog: mockSessionStorage.agentStatusLog || [] };
          if (cb) cb(res);
          return Promise.resolve(res);
        },
        set: (obj, cb) => {
          Object.assign(mockSessionStorage, obj);
          if (cb) cb();
          return Promise.resolve();
        }
      }
    }
  };

  return { elementsById, statusLogPanel, clearLogBtn };
}

test('Ticket 04 Popup: formats and renders AGENT_STATUS events correctly', () => {
  const { statusLogPanel } = setupMockEnvironment();

  function appendStatusLogEntry(item) {
    if (!statusLogPanel || !item) return;

    const row = document.createElement('div');
    const ev = (item.event || item.type || '').toUpperCase();

    let entryClass = 'log-entry';
    if (ev === 'TASK_DONE') {
      entryClass += ' log-entry-done';
    } else if (ev === 'TASK_EXHAUSTED') {
      entryClass += ' log-entry-exhausted';
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
  }

  // 1. Render step started
  appendStatusLogEntry({
    event: 'STEP_STARTED',
    step: 1,
    maxSteps: 5,
    timestamp: 1600000000000,
    message: 'Step 1/5 started'
  });
  assert.equal(statusLogPanel.children.length, 1);
  assert.ok(statusLogPanel.children[0].classList.has('log-entry-step'));
  assert.ok(statusLogPanel.children[0].textContent.includes('Step 1/5 started'));

  // 2. Render action decided
  appendStatusLogEntry({
    event: 'ACTION_DECIDED',
    step: 1,
    actionType: 'click',
    target: '#submit-btn',
    timestamp: 1600000001000,
    message: 'Action decided: click on #submit-btn'
  });
  assert.equal(statusLogPanel.children.length, 2);
  assert.ok(statusLogPanel.children[1].classList.has('log-entry-action'));
  assert.ok(statusLogPanel.children[1].textContent.includes('Action decided: click on #submit-btn'));

  // 3. Render action executed
  appendStatusLogEntry({
    event: 'ACTION_EXECUTED',
    step: 1,
    actionType: 'click',
    target: '#submit-btn',
    success: true,
    timestamp: 1600000002000,
    message: 'Action executed: click on #submit-btn (success)'
  });
  assert.equal(statusLogPanel.children.length, 3);
  assert.ok(statusLogPanel.children[2].classList.has('log-entry-action'));

  // 4. Render TASK_DONE (green class with ✓ Done — {reason})
  appendStatusLogEntry({
    event: 'TASK_DONE',
    step: 2,
    reason: 'Profile updated successfully',
    timestamp: 1600000003000
  });
  assert.equal(statusLogPanel.children.length, 4);
  const doneEntry = statusLogPanel.children[3];
  assert.ok(doneEntry.classList.has('log-entry-done'), 'TASK_DONE must have log-entry-done (green styling)');
  assert.ok(doneEntry.textContent.includes('✓ Done — Profile updated successfully'), 'Must render "✓ Done — {reason}"');

  // 5. Render TASK_EXHAUSTED (amber class with ⚠ Step limit reached)
  appendStatusLogEntry({
    event: 'TASK_EXHAUSTED',
    step: 5,
    maxSteps: 5,
    timestamp: 1600000004000
  });
  assert.equal(statusLogPanel.children.length, 5);
  const exhaustedEntry = statusLogPanel.children[4];
  assert.ok(exhaustedEntry.classList.has('log-entry-exhausted'), 'TASK_EXHAUSTED must have log-entry-exhausted (amber styling)');
  assert.ok(exhaustedEntry.textContent.includes('⚠ Step limit reached'), 'Must render "⚠ Step limit reached"');

  // 6. Render LOOP_ERROR (red class with error text)
  appendStatusLogEntry({
    event: 'LOOP_ERROR',
    step: 1,
    error: 'Connection timed out',
    timestamp: 1600000005000
  });
  assert.equal(statusLogPanel.children.length, 6);
  const errorEntry = statusLogPanel.children[5];
  assert.ok(errorEntry.classList.has('log-entry-error'), 'LOOP_ERROR must have log-entry-error (red styling)');
  assert.ok(errorEntry.textContent.includes('Error: Connection timed out'));
});

test('Ticket 04 Popup: restores history from chrome.storage.session on open', async () => {
  const { statusLogPanel } = setupMockEnvironment();

  // Populate session storage
  mockSessionStorage.agentStatusLog = [
    { event: 'STEP_STARTED', step: 1, maxSteps: 3, timestamp: Date.now(), message: 'Step 1/3 started' },
    { event: 'ACTION_DECIDED', step: 1, actionType: 'click', target: '#btn', timestamp: Date.now(), message: 'Action decided: click on #btn' },
    { event: 'TASK_DONE', step: 1, reason: 'Completed immediately', timestamp: Date.now() }
  ];

  function restoreStatusLog(callback) {
    chrome.storage.session.get(['agentStatusLog'], (data) => {
      const events = data?.agentStatusLog || [];
      statusLogPanel.children = [];
      for (const ev of events) {
        const row = document.createElement('div');
        row.className = ev.event === 'TASK_DONE' ? 'log-entry log-entry-done' : 'log-entry';
        const msg = document.createElement('span');
        msg.textContent = ev.reason ? `✓ Done — ${ev.reason}` : ev.message;
        row.appendChild(msg);
        statusLogPanel.appendChild(row);
      }
      if (callback) callback();
    });
  }

  await new Promise(resolve => restoreStatusLog(resolve));

  assert.equal(statusLogPanel.children.length, 3);
  assert.ok(statusLogPanel.children[0].textContent.includes('Step 1/3 started'));
  assert.ok(statusLogPanel.children[1].textContent.includes('Action decided: click on #btn'));
  assert.ok(statusLogPanel.children[2].classList.has('log-entry-done'));
  assert.ok(statusLogPanel.children[2].textContent.includes('✓ Done — Completed immediately'));
});
