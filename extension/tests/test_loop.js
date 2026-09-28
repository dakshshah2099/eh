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
    }
  },
  storage: {
    local: {
      get: async (key) => (typeof key === 'string' ? { [key]: storedData[key] } : storedData),
      set: async (obj) => { Object.assign(storedData, obj); }
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
