import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { buildPayload, sendPayloadToServer, checkServerHealth, DEFAULT_SERVER_URL } from '../src/transport.js';

test('buildPayload normalizes input data conforming to FastAPI schema', () => {
  const input = {
    task: 'Search for laptops',
    domSkeleton: [{ tag: 'input', id: 'search-box', role: 'textbox' }],
    imageBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    viewport: { width: 1920, height: 1080, devicePixelRatio: 2 },
    redactionMap: [
      { bbox: [10, 20, 100, 30], category: 'email', source: 'regex', confidence: 0.98 }
    ]
  };

  const payload = buildPayload(input);

  assert.equal(payload.task, 'Search for laptops');
  assert.deepEqual(payload.dom_skeleton, [{ tag: 'input', id: 'search-box', role: 'textbox' }]);
  assert.equal(payload.image_base64, 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
  assert.deepEqual(payload.viewport, { width: 1920, height: 1080, devicePixelRatio: 2 });
  assert.deepEqual(payload.redaction_map, [
    { bbox: [10, 20, 100, 30], category: 'email', source: 'regex', confidence: 0.98 }
  ]);
});

test('buildPayload handles snake_case parameters and defaults', () => {
  const payload = buildPayload({
    task: 'Test default fallbacks'
  });

  assert.equal(payload.task, 'Test default fallbacks');
  assert.deepEqual(payload.dom_skeleton, []);
  assert.equal(payload.image_base64, '');
  assert.deepEqual(payload.viewport, { width: 0, height: 0 });
  assert.deepEqual(payload.redaction_map, []);
});

test('buildPayload accepts downscale result object as image source', () => {
  const downscaleResult = {
    dataUrl: 'data:image/jpeg;base64,abcdef123456',
    base64: 'abcdef123456',
    width: 768,
    height: 432
  };

  const payload = buildPayload({
    task: 'Click checkout',
    imageBase64: downscaleResult
  });

  assert.equal(payload.image_base64, 'data:image/jpeg;base64,abcdef123456');
});

test('sendPayloadToServer posts JSON and logs received mock actions', async () => {
  const mockPlanResponse = {
    actions: [
      {
        type: 'click',
        target_bbox: [10.0, 10.0, 50.0, 20.0],
        target_selector: 'button#submit',
        reason: 'Submit the search form'
      }
    ],
    task_complete: false,
    confidence: 0.95
  };

  let receivedRequest = null;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      receivedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(body)
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockPlanResponse));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    const payload = buildPayload({
      task: 'Click submit button',
      domSkeleton: [{ tag: 'button', id: 'submit', text: 'Submit' }],
      imageBase64: 'data:image/png;base64,fake-data',
      viewport: { width: 1280, height: 720 },
      redactionMap: []
    });

    const response = await sendPayloadToServer(payload, mockUrl);

    assert.equal(receivedRequest.method, 'POST');
    assert.equal(receivedRequest.url, '/api/plan');
    assert.equal(receivedRequest.headers['content-type'], 'application/json');
    assert.deepEqual(receivedRequest.body, payload);
    assert.deepEqual(response, mockPlanResponse);
    assert.equal(response.actions.length, 1);
    assert.equal(response.actions[0].type, 'click');
  } finally {
    server.close();
  }
});

test('sendPayloadToServer handles HTTP error status codes', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: [{ msg: 'Field required', loc: ['body', 'task'] }] }));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    await assert.rejects(
      async () => {
        await sendPayloadToServer({ invalid: true }, mockUrl);
      },
      /Failed to send payload \(422/
    );
  } finally {
    server.close();
  }
});

test('checkServerHealth returns true on 200 ok and false on failure', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const isHealthy = await checkServerHealth(`http://127.0.0.1:${port}/health`);
    assert.equal(isHealthy, true);

    const isNotHealthy = await checkServerHealth(`http://127.0.0.1:${port}/not-found`);
    assert.equal(isNotHealthy, false);
  } finally {
    server.close();
  }
});

test('Integration with live FastAPI planning server on http://127.0.0.1:8000/api/plan', async () => {
  const isUp = await checkServerHealth('http://127.0.0.1:8000/health');
  if (!isUp) {
    console.log('Live server not running at 127.0.0.1:8000, skipping live test');
    return;
  }

  const payload = buildPayload({
    task: 'Search for flights',
    domSkeleton: [
      {
        tag: 'input',
        id: 'origin',
        type: 'text',
        rect: { x: 50, y: 100, width: 200, height: 40 }
      },
      {
        tag: 'button',
        id: 'submit-search',
        text: 'Find Flights',
        rect: { x: 260, y: 100, width: 120, height: 40 }
      }
    ],
    imageBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
    redactionMap: []
  });

  let response;
  try {
    response = await sendPayloadToServer(payload, 'http://127.0.0.1:8000/api/plan');
  } catch (err) {
    if (err.message?.includes('404')) {
      console.log('Live server at 127.0.0.1:8000 does not implement /api/plan, skipping live test');
      return;
    }
    throw err;
  }
  assert.ok(response);
  assert.ok(Array.isArray(response.actions));
  assert.equal(response.task_complete, false);
  assert.equal(typeof response.confidence, 'number');
  assert.equal(response.actions[0].type, 'click');
});
