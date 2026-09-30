import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

// Setup mock chrome API before importing background.js
let messageListeners = [];
let installedListeners = [];
let startupListeners = [];
let storedData = {};
let actionsExecuted = [];
let domSkeletonRequests = 0;
let runtimeMessagesSent = [];

let sessionData = {};

globalThis.chrome = {
  runtime: {
    getURL: (path) => `chrome-extension://mock-id/${path}`,
    getContexts: async () => [],
    onInstalled: {
      addListener: (fn) => installedListeners.push(fn)
    },
    onStartup: {
      addListener: (fn) => startupListeners.push(fn)
    },
    onMessage: {
      addListener: (fn) => messageListeners.push(fn)
    },
    sendMessage: (msg, callback) => {
      runtimeMessagesSent.push(msg);
      if (typeof callback === 'function') callback({ success: true });
      return Promise.resolve({ success: true });
    }
  },
  storage: {
    local: {
      get: async (key) => (typeof key === 'string' ? { [key]: storedData[key] } : storedData),
      set: async (obj) => { Object.assign(storedData, obj); }
    },
    session: {
      get: async (key) => {
        if (Array.isArray(key)) {
          const res = {};
          for (const k of key) res[k] = sessionData[k];
          return res;
        }
        return typeof key === 'string' ? { [key]: sessionData[key] } : { ...sessionData };
      },
      set: async (obj) => { Object.assign(sessionData, obj); }
    }
  },
  tabs: {
    query: async () => [{ id: 101, active: true, windowId: 1 }],
    get: async (id) => ({ id, active: true, windowId: 1 }),
    update: async () => {},
    captureVisibleTab: async () => 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    sendMessage: async (tabId, msg) => {
      if (msg.type === 'EXTRACT_DOM_SKELETON') {
        domSkeletonRequests++;
        return {
          success: true,
          skeleton: {
            tag: 'body',
            children: [{ tag: 'input', id: 'search-input' }]
          },
          viewport: { width: 1280, height: 720 }
        };
      }
      if (msg.type === 'ACTION_EXECUTE') {
        actionsExecuted.push(msg.action);
        return {
          success: true,
          action: msg.action?.type || 'unknown'
        };
      }
      return { success: false };
    }
  },
  offscreen: undefined
};

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
      drawImage: () => {}
    };
  }
  async convertToBlob() {
    return new Blob(['fake-scaled-image'], { type: 'image/jpeg' });
  }
};

const bg = await import('../src/background.js');

test('waitForDomSettle completes successfully with delay', async () => {
  const start = Date.now();
  const res = await bg.waitForDomSettle(101, 60);
  const elapsed = Date.now() - start;
  assert.equal(res, true);
  assert.ok(elapsed >= 50, `Elapsed ${elapsed}ms should be at least 50ms`);
});

test('startLoop executes action, waits for DOM settle, recaptures, and completes on task_complete', async () => {
  actionsExecuted = [];
  domSkeletonRequests = 0;

  // Spin up a mock HTTP server returning dynamic plan responses
  let planCallCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      planCallCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (planCallCount === 1) {
        // Step 1: type into search input
        res.end(JSON.stringify({
          actions: [
            {
              type: 'type',
              target_selector: '#search-input',
              text: 'wireless mouse',
              reason: 'Type search query'
            }
          ],
          task_complete: false,
          confidence: 0.95
        }));
      } else if (planCallCount === 2) {
        // Step 2: click submit
        res.end(JSON.stringify({
          actions: [
            {
              type: 'click',
              target_selector: '#search-submit',
              reason: 'Submit search'
            }
          ],
          task_complete: false,
          confidence: 0.95
        }));
      } else {
        // Step 3: task complete
        res.end(JSON.stringify({
          actions: [],
          task_complete: true,
          confidence: 0.99
        }));
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    const loopResult = await bg.startLoop(101, 'Search for wireless mouse', {
      serverUrl: mockServerUrl,
      maxSteps: 5,
      domSettleDelay: 50
    });

    assert.equal(loopResult.success, true);
    assert.equal(loopResult.taskComplete, true);
    assert.equal(loopResult.stepsExecuted, 3);
    assert.equal(loopResult.maxStepsReached, false);
    assert.equal(loopResult.history.length, 3);

    // Verify actions were executed in tab
    assert.equal(actionsExecuted.length, 2);
    assert.equal(actionsExecuted[0].type, 'type');
    assert.equal(actionsExecuted[0].text, 'wireless mouse');
    assert.equal(actionsExecuted[1].type, 'click');

    // Verify screen / DOM skeleton was recaptured for each step
    assert.equal(domSkeletonRequests, 3);
  } finally {
    server.close();
  }
});

test('startLoop respects maxSteps limit and terminates safely', async () => {
  actionsExecuted = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        actions: [{ type: 'scroll', deltaY: 100 }],
        task_complete: false,
        confidence: 0.8
      }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    const loopResult = await bg.startLoop(101, 'Scroll indefinitely', {
      serverUrl: mockServerUrl,
      maxSteps: 3,
      domSettleDelay: 50
    });

    assert.equal(loopResult.success, true);
    assert.equal(loopResult.taskComplete, false);
    assert.equal(loopResult.stepsExecuted, 3);
    assert.equal(loopResult.maxStepsReached, true);
    assert.equal(actionsExecuted.length, 3);
  } finally {
    server.close();
  }
});

test('stopLoop halts running loop early', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        actions: [{ type: 'scroll', deltaY: 50 }],
        task_complete: false,
        confidence: 0.8
      }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    let stepsRan = 0;
    const loopPromise = bg.startLoop(101, 'Infinite loop test', {
      serverUrl: mockServerUrl,
      maxSteps: 10,
      domSettleDelay: 80,
      onStep: async ({ step }) => {
        stepsRan = step;
        if (step === 2) {
          await bg.stopLoop();
        }
      }
    });

    const result = await loopPromise;
    assert.equal(result.success, true);
    assert.equal(stepsRan, 2);
    assert.ok(result.stepsExecuted <= 2, `Steps executed should be <= 2, was ${result.stepsExecuted}`);
  } finally {
    server.close();
  }
});

test('Message listener handles START_LOOP and STOP_LOOP', async () => {
  const listener = messageListeners[0];
  assert.ok(listener, 'onMessage listener must exist');

  // Test STOP_LOOP when stopped
  const stopPromise = new Promise(resolve => {
    listener({ type: 'STOP_LOOP' }, {}, resolve);
  });
  const stopRes = await stopPromise;
  assert.equal(stopRes.success, true);
  assert.equal(stopRes.isRunning, false);
});

test('startLoop preserves identical task_id and session_id across multi-step execution (3-step loop)', async () => {
  actionsExecuted = [];
  domSkeletonRequests = 0;
  const outboundPayloads = [];

  let planCallCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      planCallCount++;
      const payload = JSON.parse(body);
      outboundPayloads.push(payload);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (planCallCount === 1) {
        res.end(JSON.stringify({
          actions: [{ type: 'scroll', deltaY: 50 }],
          task_complete: false,
          confidence: 0.9
        }));
      } else if (planCallCount === 2) {
        res.end(JSON.stringify({
          actions: [{ type: 'scroll', deltaY: 50 }],
          task_complete: false,
          confidence: 0.9
        }));
      } else {
        res.end(JSON.stringify({
          actions: [],
          task_complete: true,
          confidence: 0.99
        }));
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  const onStepPlanResults = [];

  try {
    const loopResult = await bg.startLoop(101, '3-step task_id consistency test', {
      serverUrl: mockServerUrl,
      maxSteps: 5,
      domSettleDelay: 50,
      onStep: async ({ planResult }) => {
        if (planResult) {
          onStepPlanResults.push(planResult);
        }
      }
    });

    assert.equal(loopResult.success, true);
    assert.equal(loopResult.taskComplete, true);
    assert.equal(loopResult.stepsExecuted, 3);
    assert.equal(loopResult.history.length, 3);
    assert.equal(outboundPayloads.length, 3);
    assert.equal(onStepPlanResults.length, 3);

    // Verify task_id and session_id generated once and identical across all steps
    const firstTaskId = loopResult.history[0].payload.task_id;
    const firstSessionId = loopResult.history[0].payload.session_id;

    assert.ok(firstTaskId, 'task_id must be present on payload');
    assert.ok(firstSessionId, 'session_id must be present on payload');
    assert.ok(firstTaskId.startsWith('task_'), 'generated task_id should start with task_');

    for (let i = 0; i < loopResult.history.length; i++) {
      const historyStep = loopResult.history[i];
      const planResult = historyStep.planResult;
      assert.ok(planResult, `history[${i}].planResult must exist`);
      assert.ok(planResult.payload, `history[${i}].planResult.payload must exist`);

      // Assert that every outbound planResult.payload.task_id is identical across all steps
      assert.equal(
        planResult.payload.task_id,
        firstTaskId,
        `Step ${i + 1} planResult.payload.task_id (${planResult.payload.task_id}) must match first step (${firstTaskId})`
      );

      // Assert onStep received planResult with identical task_id
      assert.equal(
        onStepPlanResults[i].payload.task_id,
        firstTaskId,
        `onStep step ${i + 1} planResult.payload.task_id must match first step (${firstTaskId})`
      );

      // Assert outbound HTTP payload received by server matches exactly
      assert.equal(
        outboundPayloads[i].task_id,
        firstTaskId,
        `Server received step ${i + 1} task_id must match first step (${firstTaskId})`
      );

      // Assert session_id is also identical across all steps
      assert.equal(
        planResult.payload.session_id,
        firstSessionId,
        `Step ${i + 1} planResult.payload.session_id must match first step (${firstSessionId})`
      );
      assert.equal(
        outboundPayloads[i].session_id,
        firstSessionId,
        `Server received step ${i + 1} session_id must match first step (${firstSessionId})`
      );
    }

    assert.equal(loopResult.taskId, firstTaskId);
    assert.equal(loopResult.sessionId, firstSessionId);
  } finally {
    server.close();
  }
});

test('startLoop preserves custom taskId and sessionId across multi-step execution', async () => {
  actionsExecuted = [];
  const outboundPayloads = [];

  let planCallCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      planCallCount++;
      outboundPayloads.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (planCallCount < 3) {
        res.end(JSON.stringify({ actions: [{ type: 'scroll', deltaY: 20 }], task_complete: false, confidence: 0.9 }));
      } else {
        res.end(JSON.stringify({ actions: [], task_complete: true, confidence: 1.0 }));
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    const customTaskId = 'custom-task-xyz-123';
    const customSessionId = 'custom-session-abc-456';

    const loopResult = await bg.startLoop(101, 'Custom IDs test', {
      serverUrl: mockServerUrl,
      taskId: customTaskId,
      sessionId: customSessionId,
      maxSteps: 5,
      domSettleDelay: 50
    });

    assert.equal(loopResult.stepsExecuted, 3);
    assert.equal(outboundPayloads.length, 3);

    for (let i = 0; i < loopResult.history.length; i++) {
      assert.equal(loopResult.history[i].planResult.payload.task_id, customTaskId);
      assert.equal(loopResult.history[i].planResult.payload.session_id, customSessionId);
      assert.equal(outboundPayloads[i].task_id, customTaskId);
      assert.equal(outboundPayloads[i].session_id, customSessionId);
    }
  } finally {
    server.close();
  }
});

test('Ticket 07 / C7: startLoop halts with ConfirmationRequired when planner proposes high-risk action without confirmation callback', async () => {
  actionsExecuted = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Planner proposes a high-risk Submit Payment action
      res.end(JSON.stringify({
        actions: [
          {
            type: 'click',
            target_selector: '#submit-payment-button',
            reason: 'Submit Payment for checkout'
          }
        ],
        task_complete: false,
        confidence: 0.95
      }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    await assert.rejects(
      async () => {
        await bg.startLoop(101, 'Buy item and submit payment', {
          serverUrl: mockServerUrl,
          maxSteps: 3,
          domSettleDelay: 50
        });
      },
      (err) => {
        assert.ok(err instanceof bg.ConfirmationRequired, 'Must throw ConfirmationRequired');
        assert.equal(err.name, 'ConfirmationRequired');
        return true;
      }
    );

    // Verify dangerous action was NOT executed in tab
    assert.equal(actionsExecuted.length, 0);
  } finally {
    server.close();
  }
});

test('Ticket 07 / C7: startLoop executes high-risk action when onConfirmAction returns true', async () => {
  actionsExecuted = [];
  let confirmedCalled = false;

  let planCallCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      planCallCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (planCallCount === 1) {
        res.end(JSON.stringify({
          actions: [
            {
              type: 'click',
              target_selector: '#submit-payment-button',
              reason: 'Submit Payment for checkout'
            }
          ],
          task_complete: false,
          confidence: 0.95
        }));
      } else {
        res.end(JSON.stringify({
          actions: [],
          task_complete: true,
          confidence: 1.0
        }));
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    const loopResult = await bg.startLoop(101, 'Buy item and submit payment', {
      serverUrl: mockServerUrl,
      maxSteps: 3,
      domSettleDelay: 50,
      onConfirmAction: async (action) => {
        confirmedCalled = true;
        assert.equal(action.risk, 'high');
        assert.equal(action.requires_confirmation, true);
        return true;
      }
    });

    assert.equal(loopResult.success, true);
    assert.equal(confirmedCalled, true);
    assert.equal(actionsExecuted.length, 1);
    assert.equal(actionsExecuted[0].type, 'click');
    assert.equal(actionsExecuted[0].confirmed, true);
  } finally {
    server.close();
  }
});

test('Ticket 01: startLoop exits immediately on done action without exhausting maxSteps and broadcasts TASK_DONE', async () => {
  actionsExecuted = [];
  runtimeMessagesSent = [];
  let planCallCount = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      planCallCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (planCallCount === 1) {
        res.end(JSON.stringify({
          actions: [{ type: 'type', target_selector: '#name-field', text: 'Alice' }],
          task_complete: false,
          confidence: 0.95
        }));
      } else if (planCallCount === 2) {
        // Return done action with reason string
        res.end(JSON.stringify({
          actions: [{ action: 'done', reason: 'User profile updated and saved' }],
          task_complete: false,
          confidence: 0.99
        }));
      } else {
        res.end(JSON.stringify({
          actions: [{ type: 'scroll', deltaY: 100 }],
          task_complete: false,
          confidence: 0.5
        }));
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    const loopResult = await bg.startLoop(101, 'Update user profile', {
      serverUrl: mockServerUrl,
      maxSteps: 10,
      domSettleDelay: 50
    });

    // Must exit immediately after step 2 (not running all 10 steps)
    assert.equal(loopResult.success, true);
    assert.equal(loopResult.taskComplete, true);
    assert.equal(loopResult.stepsExecuted, 2);
    assert.equal(loopResult.maxStepsReached, false);
    assert.equal(loopResult.reason, 'User profile updated and saved');
    assert.equal(planCallCount, 2);

    // Verify broadcast TASK_DONE message sent with step count and reason string
    const taskDoneMsg = runtimeMessagesSent.find(m => m.type === 'TASK_DONE');
    assert.ok(taskDoneMsg, 'Expected TASK_DONE message to be sent');
    assert.equal(taskDoneMsg.stepCount, 2);
    assert.equal(taskDoneMsg.reason, 'User profile updated and saved');
  } finally {
    server.close();
  }
});

test('Ticket 01: startLoop broadcasts TASK_EXHAUSTED when maxSteps reached without done action', async () => {
  actionsExecuted = [];
  runtimeMessagesSent = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        actions: [{ type: 'scroll', deltaY: 50 }],
        task_complete: false,
        confidence: 0.8
      }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    const loopResult = await bg.startLoop(101, 'Infinite scroll test', {
      serverUrl: mockServerUrl,
      maxSteps: 2,
      domSettleDelay: 50
    });

    assert.equal(loopResult.success, true);
    assert.equal(loopResult.taskComplete, false);
    assert.equal(loopResult.stepsExecuted, 2);
    assert.equal(loopResult.maxStepsReached, true);

    // Verify broadcast TASK_EXHAUSTED message sent, distinct from TASK_DONE
    const taskDoneMsg = runtimeMessagesSent.find(m => m.type === 'TASK_DONE');
    assert.equal(taskDoneMsg, undefined, 'TASK_DONE must not be sent on exhaustion');

    const taskExhaustedMsg = runtimeMessagesSent.find(m => m.type === 'TASK_EXHAUSTED');
    assert.ok(taskExhaustedMsg, 'Expected TASK_EXHAUSTED message to be sent');
    assert.equal(taskExhaustedMsg.stepCount, 2);
    assert.equal(taskExhaustedMsg.maxSteps, 2);
  } finally {
    server.close();
  }
});

test('Ticket 04: startLoop sends AGENT_STATUS messages for each loop event (STEP_STARTED, ACTION_DECIDED, ACTION_EXECUTED, TASK_DONE)', async () => {
  actionsExecuted = [];
  runtimeMessagesSent = [];
  sessionData = {};
  let planCount = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      planCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (planCount === 1) {
        res.end(JSON.stringify({
          actions: [{ type: 'click', target_selector: 'button#save-profile', reason: 'Save profile changes' }],
          task_complete: false,
          confidence: 0.95
        }));
      } else {
        res.end(JSON.stringify({
          actions: [{ action: 'done', reason: 'Profile updated successfully' }],
          task_complete: true,
          confidence: 0.99
        }));
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    const loopResult = await bg.startLoop(101, 'Save profile test', {
      serverUrl: mockServerUrl,
      maxSteps: 5,
      domSettleDelay: 50
    });

    assert.equal(loopResult.success, true);
    assert.equal(loopResult.taskComplete, true);

    const statusEvents = runtimeMessagesSent.filter(m => m.type === 'AGENT_STATUS');
    assert.ok(statusEvents.length >= 4, `Expected at least 4 AGENT_STATUS events, got ${statusEvents.length}`);

    // Verify STEP_STARTED event
    const step1Start = statusEvents.find(e => e.event === 'STEP_STARTED' && e.step === 1);
    assert.ok(step1Start, 'STEP_STARTED event for step 1 should exist');
    assert.equal(step1Start.maxSteps, 5);
    assert.ok(step1Start.timestamp > 0);

    // Verify ACTION_DECIDED event
    const actionDecided = statusEvents.find(e => e.event === 'ACTION_DECIDED' && e.step === 1);
    assert.ok(actionDecided, 'ACTION_DECIDED event should exist');
    assert.equal(actionDecided.actionType, 'click');
    assert.equal(actionDecided.target, 'button#save-profile');

    // Verify ACTION_EXECUTED event
    const actionExecuted = statusEvents.find(e => e.event === 'ACTION_EXECUTED' && e.step === 1);
    assert.ok(actionExecuted, 'ACTION_EXECUTED event should exist');
    assert.equal(actionExecuted.actionType, 'click');
    assert.equal(actionExecuted.target, 'button#save-profile');
    assert.equal(actionExecuted.success, true);

    // Verify TASK_DONE event
    const taskDoneStatus = statusEvents.find(e => e.event === 'TASK_DONE');
    assert.ok(taskDoneStatus, 'TASK_DONE status event should exist');
    assert.equal(taskDoneStatus.reason, 'Profile updated successfully');
    assert.equal(taskDoneStatus.step, 2);
  } finally {
    server.close();
  }
});

test('Ticket 04: startLoop sends AGENT_STATUS TASK_EXHAUSTED when step limit reached', async () => {
  actionsExecuted = [];
  runtimeMessagesSent = [];
  sessionData = {};

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        actions: [{ type: 'scroll', deltaY: 20 }],
        task_complete: false,
        confidence: 0.8
      }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    const loopResult = await bg.startLoop(101, 'Exhaustion test', {
      serverUrl: mockServerUrl,
      maxSteps: 2,
      domSettleDelay: 50
    });

    assert.equal(loopResult.success, true);
    assert.equal(loopResult.maxStepsReached, true);

    const statusEvents = runtimeMessagesSent.filter(m => m.type === 'AGENT_STATUS');
    const exhaustedEvent = statusEvents.find(e => e.event === 'TASK_EXHAUSTED');
    assert.ok(exhaustedEvent, 'Expected AGENT_STATUS TASK_EXHAUSTED event');
    assert.equal(exhaustedEvent.step, 2);
    assert.equal(exhaustedEvent.maxSteps, 2);
  } finally {
    server.close();
  }
});

test('Ticket 04: startLoop sends AGENT_STATUS LOOP_ERROR on fatal error', async () => {
  actionsExecuted = [];
  runtimeMessagesSent = [];
  sessionData = {};

  const server = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Internal model inference crash' }));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    await assert.rejects(async () => {
      await bg.startLoop(101, 'Failing task', {
        serverUrl: mockServerUrl,
        maxSteps: 2,
        domSettleDelay: 50
      });
    });

    const statusEvents = runtimeMessagesSent.filter(m => m.type === 'AGENT_STATUS');
    const errorEvent = statusEvents.find(e => e.event === 'LOOP_ERROR');
    assert.ok(errorEvent, 'Expected AGENT_STATUS LOOP_ERROR event');
    assert.ok(errorEvent.error, 'Error property should exist on LOOP_ERROR event');
  } finally {
    server.close();
  }
});

test('Ticket 04: chrome.storage.session stores recent events and clears on new task', async () => {
  actionsExecuted = [];
  runtimeMessagesSent = [];
  sessionData = {};
  let planCount = 0;

  const server = http.createServer((req, res) => {
    planCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      actions: [{ action: 'done', reason: `Task run ${planCount} finished` }],
      task_complete: true,
      confidence: 0.99
    }));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    // Run Task 1
    await bg.startLoop(101, 'Task 1', {
      serverUrl: mockServerUrl,
      maxSteps: 3,
      domSettleDelay: 50,
      taskId: 'task-111'
    });

    // Check sessionData received status events
    const log1 = sessionData.agentStatusLog;
    assert.ok(Array.isArray(log1) && log1.length > 0, 'sessionData.agentStatusLog should store events');
    assert.ok(log1.every(e => e.taskId === 'task-111'), 'All events should belong to task-111');

    // Run Task 2 (should clear prior log)
    await bg.startLoop(101, 'Task 2', {
      serverUrl: mockServerUrl,
      maxSteps: 3,
      domSettleDelay: 50,
      taskId: 'task-222'
    });

    const log2 = sessionData.agentStatusLog;
    assert.ok(Array.isArray(log2) && log2.length > 0);
    // Crucial check: old task-111 events were cleared when task-222 started!
    assert.ok(log2.every(e => e.taskId === 'task-222'), 'Task 2 start must clear old task-111 events from session storage');
  } finally {
    server.close();
  }
});

test('Ticket 04: PII safety: raw sensitive field values are not leaked into status messages', async () => {
  actionsExecuted = [];
  runtimeMessagesSent = [];
  sessionData = {};

  let planCount = 0;
  const server = http.createServer((req, res) => {
    planCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (planCount === 1) {
      res.end(JSON.stringify({
        actions: [
          {
            type: 'type',
            target_selector: 'input#credit-card-number',
            text: '4111-2222-3333-4444',
            reason: 'Enter payment card number'
          },
          {
            type: 'fill_secret',
            target_selector: 'input#secret-pin',
            secret_key: 'BANK_PIN_SECRET'
          }
        ],
        task_complete: false,
        confidence: 0.99
      }));
    } else {
      res.end(JSON.stringify({
        actions: [{ action: 'done', reason: 'Form submission completed' }],
        task_complete: true,
        confidence: 0.99
      }));
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    await bg.startLoop(101, 'Fill sensitive form', {
      serverUrl: mockServerUrl,
      maxSteps: 3,
      domSettleDelay: 50,
      onConfirmAction: async () => true
    });

    const statusEvents = runtimeMessagesSent.filter(m => m.type === 'AGENT_STATUS');
    assert.ok(statusEvents.length > 0);

    const serialized = JSON.stringify(statusEvents);
    // Raw sensitive field input value must NEVER appear anywhere in AGENT_STATUS messages
    assert.equal(
      serialized.includes('4111-2222-3333-4444'),
      false,
      'Raw credit card number / typed text must NOT be present in status messages'
    );

    // Target must report selector strings or element types, not values
    const typeActionDecided = statusEvents.find(e => e.event === 'ACTION_DECIDED' && e.actionType === 'type');
    assert.ok(typeActionDecided, 'Type ACTION_DECIDED should be recorded');
    assert.equal(typeActionDecided.target, 'input#credit-card-number');
    assert.equal(typeActionDecided.text, undefined);
  } finally {
    server.close();
  }
});



