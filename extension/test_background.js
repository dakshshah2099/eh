import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

let server;
let mockServerUrl;

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        actions: [
          {
            type: 'click',
            target_selector: 'button#checkout-btn',
            reason: 'Checkout button clicked'
          }
        ],
        task_complete: false,
        confidence: 0.95
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  mockServerUrl = `http://127.0.0.1:${server.address().port}/api/plan`;
});

test.after(() => {
  if (server) server.close();
});

// Setup mock chrome API before importing background.js
let messageListeners = [];
let installedListeners = [];
let startupListeners = [];
let storedData = {};

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
        return {
          success: true,
          skeleton: {
            tag: 'body',
            children: [{ tag: 'button', id: 'checkout-btn', text: 'Checkout' }]
          },
          viewport: { width: 1280, height: 720 }
        };
      }
      return { success: false };
    }
  },
  offscreen: undefined
};

globalThis.createImageBitmap = async () => ({
  width: 1920,
  height: 1080,
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

// Now import background module
const bg = await import('./background.js');

test('background.js exports transport and planning utilities', () => {
  assert.equal(typeof bg.sendPayloadToServer, 'function');
  assert.equal(typeof bg.buildPayload, 'function');
  assert.equal(typeof bg.captureAndSendPlan, 'function');
  assert.equal(typeof bg.executePipeline, 'function');
  assert.equal(typeof globalThis.sendPayloadToServer, 'function');
  assert.equal(typeof globalThis.captureAndSendPlan, 'function');
  assert.equal(typeof globalThis.executePipeline, 'function');
});

test('background.js handles SEND_PLAN_PAYLOAD message', async () => {
  const listener = messageListeners[0];
  assert.ok(listener, 'onMessage listener must exist');

  const payload = {
    task: 'Test task',
    dom_skeleton: [{ tag: 'button', id: 'submit' }],
    image_base64: 'fake-image-base64',
    viewport: { width: 1024, height: 768 },
    redaction_map: []
  };

  const responsePromise = new Promise((resolve) => {
    const isAsync = listener(
      {
        type: 'SEND_PLAN_PAYLOAD',
        payload,
        serverUrl: mockServerUrl
      },
      {},
      resolve
    );
    assert.equal(isAsync, true);
  });

  const res = await responsePromise;
  assert.equal(res.success, true);
  assert.ok(res.plan);
  assert.equal(res.plan.actions.length, 1);
  assert.equal(res.plan.actions[0].type, 'click');
});

test('background.js handles CAPTURE_AND_SEND_PLAN end-to-end', async () => {
  const listener = messageListeners[0];

  const responsePromise = new Promise((resolve) => {
    const isAsync = listener(
      {
        type: 'CAPTURE_AND_SEND_PLAN',
        task: 'Click checkout button',
        serverUrl: mockServerUrl
      },
      {},
      resolve
    );
    assert.equal(isAsync, true);
  });

  const res = await responsePromise;
  assert.equal(res.success, true);
  assert.ok(res.plan);
  assert.ok(res.payload);
  assert.equal(res.payload.task, 'Click checkout button');
  assert.deepEqual(res.payload.viewport, { width: 1280, height: 720 });
  assert.equal(res.plan.actions[0].type, 'click');
});
