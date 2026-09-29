/**
 * @fileoverview End-to-end integration tests for Ticket 16 — Redaction Pipeline Wiring.
 * Tests the complete on-device perception & redaction pipeline:
 *
 * 1. Capture tab & downscale (02)
 * 2. Extract DOM skeleton (03)
 * 3. Detect sensitive DOM elements (10)
 * 4. Run face detector on canvas (11)
 * 5. Run OCR detector on canvas (12)
 * 6. Merge all sensitive regions with region_merger.js (13)
 * 7. Redact image canvas with image_redaction.js (14)
 * 8. Redact DOM skeleton with dom_redaction.js (15)
 * 9. Construct sanitized payload
 * 10. Send ONLY sanitized payload via transport.js (05)
 *
 * Verifies that zero unredacted PII (text or image) is ever transmitted to the server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

import { executePipeline, assertPayloadSanitized } from '../src/pipeline.js';
import { REDACTION_TOKENS } from '../src/dom_redaction.js';

/**
 * Creates an in-memory test PNG Data URL.
 */
function createTestPngDataUrl(width = 64, height = 64, fillColor = [255, 255, 255, 255]) {
  const bpp = 4;
  const raw = Buffer.alloc(height * (1 + width * bpp));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * bpp);
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * bpp;
      raw[pxOffset] = fillColor[0];
      raw[pxOffset + 1] = fillColor[1];
      raw[pxOffset + 2] = fillColor[2];
      raw[pxOffset + 3] = fillColor[3];
    }
  }
  const compressed = zlib.deflateSync(raw);

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  const ihdrCrc = zlib.crc32(ihdr.subarray(4, 17));
  ihdr.writeUInt32BE(ihdrCrc, 21);

  const idat = Buffer.alloc(compressed.length + 12);
  idat.writeUInt32BE(compressed.length, 0);
  idat.write('IDAT', 4);
  compressed.copy(idat, 8);
  const idatCrc = zlib.crc32(idat.subarray(4, 8 + compressed.length));
  idat.writeUInt32BE(idatCrc, 8 + compressed.length);

  const iend = Buffer.alloc(12);
  iend.writeUInt32BE(0, 0);
  iend.write('IEND', 4);
  const iendCrc = zlib.crc32(iend.subarray(4, 8));
  iend.writeUInt32BE(iendCrc, 8);

  const pngBuffer = Buffer.concat([sig, ihdr, idat, iend]);
  return `data:image/png;base64,${pngBuffer.toString('base64')}`;
}

/**
 * Creates a mock canvas conforming to HTMLCanvasElement and OffscreenCanvas APIs.
 */
function createMockCanvas(width, height) {
  const pixelBuffer = new Uint8ClampedArray(width * height * 4);
  pixelBuffer.fill(255); // White background
  const filledRects = [];
  const textDrawn = [];

  const ctx = {
    canvas: null,
    fillStyle: '#000000',
    fillRect(x, y, w, h) {
      filledRects.push({ x, y, w, h, fillStyle: this.fillStyle });
      for (let py = Math.max(0, Math.round(y)); py < Math.min(height, Math.round(y + h)); py++) {
        for (let px = Math.max(0, Math.round(x)); px < Math.min(width, Math.round(x + w)); px++) {
          const idx = (py * width + px) * 4;
          pixelBuffer[idx] = 0;
          pixelBuffer[idx + 1] = 0;
          pixelBuffer[idx + 2] = 0;
          pixelBuffer[idx + 3] = 255;
        }
      }
    },
    getImageData(x, y, w, h) {
      const rx = Math.max(0, Math.round(x));
      const ry = Math.max(0, Math.round(y));
      const rw = Math.max(1, Math.min(width - rx, Math.round(w)));
      const rh = Math.max(1, Math.min(height - ry, Math.round(h)));
      const data = new Uint8ClampedArray(rw * rh * 4);
      for (let py = 0; py < rh; py++) {
        for (let px = 0; px < rw; px++) {
          const srcIdx = ((ry + py) * width + (rx + px)) * 4;
          const dstIdx = (py * rw + px) * 4;
          data[dstIdx] = pixelBuffer[srcIdx];
          data[dstIdx + 1] = pixelBuffer[srcIdx + 1];
          data[dstIdx + 2] = pixelBuffer[srcIdx + 2];
          data[dstIdx + 3] = pixelBuffer[srcIdx + 3];
        }
      }
      return { data, width: rw, height: rh };
    },
    putImageData(imgData, x, y) {
      const rx = Math.max(0, Math.round(x));
      const ry = Math.max(0, Math.round(y));
      const rw = imgData.width;
      const rh = imgData.height;
      for (let py = 0; py < rh; py++) {
        for (let px = 0; px < rw; px++) {
          if (rx + px < width && ry + py < height) {
            const srcIdx = (py * rw + px) * 4;
            const dstIdx = ((ry + py) * width + (rx + px)) * 4;
            pixelBuffer[dstIdx] = imgData.data[srcIdx];
            pixelBuffer[dstIdx + 1] = imgData.data[srcIdx + 1];
            pixelBuffer[dstIdx + 2] = imgData.data[srcIdx + 2];
            pixelBuffer[dstIdx + 3] = imgData.data[srcIdx + 3];
          }
        }
      }
    },
    fillText(text, x, y) {
      textDrawn.push({ text, x, y });
    },
    drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {},
    save() {},
    restore() {}
  };

  let callCount = 0;
  const canvas = {
    width,
    height,
    getContext(type) {
      if (type === '2d') return ctx;
      return null;
    },
    toDataURL(mime = 'image/png') {
      callCount++;
      // Sample pixel buffer to reflect mutations
      let sum = 0;
      for (let i = 0; i < pixelBuffer.length; i += 16) {
        sum = (sum + pixelBuffer[i]) & 0xFF;
      }
      return createTestPngDataUrl(width, height, [sum, (sum + 10) & 0xFF, (sum + 20) & 0xFF, 255]);
    },
    async convertToBlob() {
      return new Blob(['mock-png-blob'], { type: 'image/png' });
    },
    _pixelBuffer: pixelBuffer,
    _filledRects: filledRects,
    _textDrawn: textDrawn
  };

  ctx.canvas = canvas;
  return canvas;
}

test('Pipeline Step 1-10: End-to-end perception, redaction, and transport integration', async () => {
  let receivedServerRequest = null;

  // Spin up an ephemeral HTTP server to act as the planning server
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      receivedServerRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(body)
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        actions: [
          {
            type: 'click',
            target_selector: 'button#submit-btn',
            target_bbox: [50, 260, 100, 40],
            reason: 'Submit the sanitized transaction'
          }
        ],
        task_complete: true,
        confidence: 0.99
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}/api/plan`;

  try {
    const canvas = createMockCanvas(400, 300);

    // Unredacted raw DOM skeleton containing sensitive PII: password, SSN, and email
    const rawDomSkeleton = {
      tag: 'form',
      id: 'checkout-form',
      children: [
        {
          tag: 'input',
          id: 'user-password',
          type: 'password',
          name: 'password',
          value: 'UltraSecretPassword999!',
          bbox: [50, 50, 150, 30]
        },
        {
          tag: 'input',
          id: 'user-ssn',
          name: 'ssn',
          value: '123-45-6789',
          placeholder: 'Social Security Number',
          bbox: [50, 100, 180, 30]
        },
        {
          tag: 'div',
          id: 'contact-info',
          children: [
            {
              tag: 'span',
              id: 'email-label',
              text: 'Account email: admin@confidentialcorp.com',
              bbox: [50, 150, 250, 25]
            }
          ]
        },
        {
          tag: 'button',
          id: 'submit-btn',
          text: 'Confirm & Pay',
          bbox: [50, 260, 100, 40]
        }
      ]
    };

    // Simulated visual detections: face on canvas, and OCR sensitive region
    const faceRegions = [
      { bbox: [250, 50, 80, 80], category: 'face', source: 'cv', confidence: 0.94 }
    ];

    const ocrRegions = [
      { bbox: [50, 150, 240, 25], category: 'email', source: 'ocr', confidence: 0.91 }
    ];

    // Execute full 10-step pipeline
    const result = await executePipeline({
      task: 'Submit the checkout form securely',
      canvas,
      domSkeleton: rawDomSkeleton,
      viewport: { width: 400, height: 300 },
      faceRegions,
      ocrRegions,
      serverUrl,
      sendToServer: true
    });

    // 1. Verify Pipeline returned success and server plan response
    assert.equal(result.success, true);
    assert.ok(result.plan, 'Plan must be returned from server');
    assert.equal(result.plan.task_complete, true);
    assert.equal(result.plan.actions.length, 1);
    assert.equal(result.plan.actions[0].type, 'click');

    // 2. Verify Sensitive DOM detection (Step 3)
    assert.ok(result.domRegions.length >= 2, 'Should detect password and SSN in DOM');
    const domCategories = result.domRegions.map((r) => r.category);
    assert.ok(domCategories.includes('password'));
    assert.ok(domCategories.includes('ssn'));

    // 3. Verify Merged Regions (Step 6)
    assert.ok(result.mergedRegions.length >= 3, 'Merged regions should contain DOM + Face + OCR');
    const mergedCategories = result.mergedRegions.map((r) => r.category);
    assert.ok(mergedCategories.includes('password'));
    assert.ok(mergedCategories.includes('ssn'));
    assert.ok(mergedCategories.includes('email'));
    assert.ok(mergedCategories.includes('face'));

    // 4. Verify Image Redaction (Step 7)
    assert.ok(canvas._filledRects.length > 0, 'Canvas solid mask should be applied for password/ssn');
    assert.ok(result.redactedImage, 'Redacted image dataUrl must exist');

    // 5. Verify DOM Redaction (Step 8)
    const redactedDom = result.redactedDom;
    const passInput = redactedDom.children[0];
    const ssnInput = redactedDom.children[1];
    const emailSpan = redactedDom.children[2].children[0];
    const submitBtn = redactedDom.children[3];

    assert.equal(passInput.value, REDACTION_TOKENS.PASSWORD);
    assert.equal(ssnInput.value, REDACTION_TOKENS.SSN);
    assert.ok(emailSpan.text.includes(REDACTION_TOKENS.EMAIL));
    assert.equal(submitBtn.text, 'Confirm & Pay'); // Non-sensitive text intact

    // 6. STRICT VERIFICATION: Server received ONLY sanitized payload (Step 9 & 10)
    assert.ok(receivedServerRequest, 'Server must have received HTTP request');
    assert.equal(receivedServerRequest.method, 'POST');
    assert.equal(receivedServerRequest.url, '/api/plan');

    const sentPayload = receivedServerRequest.body;
    assert.equal(sentPayload.task, 'Submit the checkout form securely');
    assert.deepEqual(sentPayload.viewport, { width: 400, height: 300 });
    assert.ok(Array.isArray(sentPayload.redaction_map));
    assert.equal(sentPayload.redaction_map.length, result.mergedRegions.length);

    // Verify ZERO raw PII transmitted over network
    const rawPayloadJson = JSON.stringify(sentPayload);
    assert.equal(rawPayloadJson.includes('UltraSecretPassword999!'), false, 'Raw password MUST NOT be sent');
    assert.equal(rawPayloadJson.includes('123-45-6789'), false, 'Raw SSN MUST NOT be sent');
    assert.equal(rawPayloadJson.includes('admin@confidentialcorp.com'), false, 'Raw email MUST NOT be sent');

    // Verify Redaction tokens are in the transmitted DOM
    assert.ok(rawPayloadJson.includes(REDACTION_TOKENS.PASSWORD));
    assert.ok(rawPayloadJson.includes(REDACTION_TOKENS.SSN));
    assert.ok(rawPayloadJson.includes(REDACTION_TOKENS.EMAIL));
  } finally {
    server.close();
  }
});

test('Pipeline handles tab capture & mock Chrome tabs messaging seamlessly', async () => {
  let capturedTabId = null;
  let sentMessageTabId = null;
  let sentMessagePayload = null;

  const mockTabId = 202;
  const mockCaptureDataUrl = createTestPngDataUrl(128, 128);

  const mockChrome = {
    tabs: {
      query: async () => [{ id: mockTabId, active: true }],
      captureVisibleTab: async (winId, opts) => {
        capturedTabId = mockTabId;
        return mockCaptureDataUrl;
      },
      sendMessage: async (tabId, msg) => {
        sentMessageTabId = tabId;
        sentMessagePayload = msg;
        if (msg.type === 'EXTRACT_DOM_SKELETON') {
          return {
            success: true,
            viewport: { width: 1280, height: 720 },
            skeleton: {
              tag: 'div',
              children: [
                {
                  tag: 'input',
                  id: 'secret-key',
                  type: 'password',
                  value: 'SuperSecretKey_XYZ'
                }
              ]
            }
          };
        }
        return { success: false };
      }
    }
  };

  // Mock OffscreenCanvas and createImageBitmap for tab capture flow
  const originalChrome = globalThis.chrome;
  const originalOffscreenCanvas = globalThis.OffscreenCanvas;
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  globalThis.chrome = mockChrome;
  globalThis.createImageBitmap = async () => ({
    width: 1280,
    height: 720,
    close: () => {}
  });

  const mockCanvasInstance = createMockCanvas(768, 432);
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      return mockCanvasInstance;
    }
  };

  try {
    const res = await executePipeline({
      task: 'Extract and sanitize tab',
      tabId: mockTabId,
      sendToServer: false // Test payload construction without external network call
    });

    assert.equal(res.success, true);
    assert.equal(capturedTabId, mockTabId);
    assert.equal(sentMessageTabId, mockTabId);
    assert.equal(sentMessagePayload.type, 'EXTRACT_DOM_SKELETON');

    // Confirm DOM was sanitized
    const payloadDom = JSON.stringify(res.payload.dom_skeleton);
    assert.equal(payloadDom.includes('SuperSecretKey_XYZ'), false, 'Raw key must be redacted');
    assert.ok(payloadDom.includes(REDACTION_TOKENS.PASSWORD), 'Must contain password token');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.OffscreenCanvas = originalOffscreenCanvas;
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
});

test('Pipeline handles scaling factor between viewport and downscaled canvas', async () => {
  const originalViewport = { width: 1920, height: 1080 };
  const downscaledWidth = 768;
  const downscaledHeight = 432;
  const scale = 768 / 1920; // 0.4

  const canvas = createMockCanvas(downscaledWidth, downscaledHeight);

  // DOM node at (100, 200, 400, 100) in 1920x1080 viewport
  const domSkeleton = {
    tag: 'input',
    id: 'user-pin',
    type: 'password',
    value: '1234',
    bbox: [100, 200, 400, 100]
  };

  const res = await executePipeline({
    task: 'Test coordinate scaling',
    canvas,
    domSkeleton,
    viewport: originalViewport,
    faceRegions: [],
    ocrRegions: [],
    downscaleResult: {
      canvas,
      width: downscaledWidth,
      height: downscaledHeight,
      originalWidth: originalViewport.width,
      originalHeight: originalViewport.height,
      scale,
      dataUrl: 'data:image/png;base64,mock'
    },
    sendToServer: false
  });

  assert.equal(res.success, true);
  // Merged regions on canvas should have scaled coordinates: [100*0.4, 200*0.4, 400*0.4, 100*0.4] = [40, 80, 160, 40]
  assert.equal(res.mergedRegions.length, 1);
  const [sx, sy, sw, sh] = res.mergedRegions[0].bbox;
  assert.equal(sx, 40);
  assert.equal(sy, 80);
  assert.equal(sw, 160);
  assert.equal(sh, 40);

  // Redacted DOM node should have preserved redaction token
  assert.equal(res.redactedDom.value, REDACTION_TOKENS.PASSWORD);
});

test('Pipeline assertPayloadSanitized validates payload and flags unredacted content', () => {
  const validSanitizedPayload = {
    task: 'Test valid',
    dom_skeleton: { value: '[REDACTED_PASSWORD]' },
    image_base64: 'data:image/png;base64,redacted',
    viewport: { width: 100, height: 100 },
    redaction_map: []
  };

  // Should not throw
  assert.doesNotThrow(() => {
    assertPayloadSanitized(validSanitizedPayload, { value: 'secret' }, 'raw-image');
  });

  // Invalid payload structure throws
  assert.throws(() => {
    assertPayloadSanitized(null);
  }, /Invalid sanitized payload/);

  // Unredacted sensitive pattern in DOM skeleton throws SecurityError
  const leakyDomPayload = {
    task: 'Leaky DOM',
    dom_skeleton: { value: 'plaintext-secret-password-123' },
    image_base64: 'data:image/png;base64,redacted',
    viewport: { width: 100, height: 100 },
    redaction_map: []
  };
  assert.throws(() => {
    assertPayloadSanitized(leakyDomPayload, {}, '');
  }, /SecurityError/);

  // Raw image matches sanitized payload despite redactions throws SecurityError
  const leakyImagePayload = {
    task: 'Leaky Image',
    dom_skeleton: { value: '[REDACTED_PASSWORD]' },
    image_base64: 'data:image/png;base64,identical-raw-image-content-longer-than-50-chars-here',
    viewport: { width: 100, height: 100 },
    redaction_map: [{ bbox: [0, 0, 10, 10], category: 'password' }]
  };
  assert.throws(() => {
    assertPayloadSanitized(
      leakyImagePayload,
      {},
      'data:image/png;base64,identical-raw-image-content-longer-than-50-chars-here'
    );
  }, /SecurityError/);
});

test('Fail-Closed Privacy: Detector throws -> assert fetch never called and pipeline rejects', async () => {
  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCallCount++;
    return originalFetch(...args);
  };

  try {
    const canvas = createMockCanvas(200, 200);
    const domSkeleton = { tag: 'div', text: 'normal page' };

    await assert.rejects(
      async () => {
        await executePipeline({
          task: 'Detector failure test',
          canvas,
          domSkeleton,
          serverUrl: 'http://127.0.0.1:9999/api/plan',
          sendToServer: true,
          detectSensitiveDomElements: () => {
            throw new Error('Simulated DOM detector crash');
          }
        });
      },
      /Simulated DOM detector crash/
    );

    assert.equal(fetchCallCount, 0, 'Outbound fetch must NEVER be called when detector throws');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Fail-Closed Privacy: Canvas creation/redaction failure -> assert SecurityError thrown and fetch never called', async () => {
  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCallCount++;
    return originalFetch(...args);
  };

  try {
    const canvas = createMockCanvas(200, 200);
    const domSkeleton = { tag: 'div', text: 'normal page' };

    // Case 1: Redaction failure throws SecurityError
    await assert.rejects(
      async () => {
        await executePipeline({
          task: 'Redaction failure test',
          canvas,
          domSkeleton,
          serverUrl: 'http://127.0.0.1:9999/api/plan',
          sendToServer: true,
          redactCanvas: () => {
            throw new Error('Canvas 2D context failure during redaction');
          }
        });
      },
      /SecurityError/
    );

    assert.equal(fetchCallCount, 0, 'Outbound fetch must NEVER be called when redaction fails');

    // Case 2: Canvas creation failure throws SecurityError
    await assert.rejects(
      async () => {
        await executePipeline({
          task: 'Canvas creation failure test',
          image: 'invalid-non-image-source',
          serverUrl: 'http://127.0.0.1:9999/api/plan',
          sendToServer: true,
          downscaleResult: {
            canvas: null,
            dataUrl: '',
            width: 0,
            height: 0
          }
        });
      },
      /SecurityError/
    );

    assert.equal(fetchCallCount, 0, 'Outbound fetch must NEVER be called when canvas creation fails');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Fail-Closed Privacy: assertPayloadSanitized violation -> assert error thrown and fetch never called', async () => {
  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCallCount++;
    return originalFetch(...args);
  };

  try {
    const canvas = createMockCanvas(200, 200);
    // Unredacted sensitive cleartext value bypassing normal redaction
    const rawDom = {
      tag: 'input',
      type: 'text',
      id: 'custom-leaky-input',
      value: 'UnredactedSecretPassword12345!'
    };

    await assert.rejects(
      async () => {
        await executePipeline({
          task: 'Sanitization assertion failure test',
          canvas,
          domSkeleton: rawDom,
          serverUrl: 'http://127.0.0.1:9999/api/plan',
          sendToServer: true,
          // Custom domRedactionOptions or mock redactDomSkeleton that fails to redact
          domRedactionOptions: {
            customRules: []
          },
          detectSensitiveDomElements: () => [], // Intentionally simulate missed detection
          enableFaceDetection: false,
          enableOcrDetection: false
        });
      },
      /SecurityError/
    );

    assert.equal(fetchCallCount, 0, 'Outbound fetch must NEVER be called when assertPayloadSanitized fails');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UI Vision Integration: runVisionInference is invoked and produces source: "vision" in payload', async () => {
  let visionCalled = 0;
  const mockVisionInference = async (canvas, options) => {
    visionCalled++;
    return [
      {
        bbox: [15, 25, 120, 40],
        label: 'button',
        confidence: 0.95
      }
    ];
  };

  const canvas = createMockCanvas(300, 300);
  const domSkeleton = { tag: 'div', text: 'Safe UI page' };

  let capturedPayload = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        actions: [{ type: 'click', target_selector: 'button', reason: 'Click test' }],
        task_complete: true,
        confidence: 1.0
      })
    };
  };

  try {
    const result = await executePipeline({
      task: 'Test UI vision model integration',
      canvas,
      domSkeleton,
      serverUrl: 'http://127.0.0.1:9999/api/plan',
      sendToServer: true,
      runVisionInference: mockVisionInference,
      enableFaceDetection: false,
      enableOcrDetection: false
    });

    assert.equal(visionCalled, 1, 'runVisionInference must be called exactly once per pipeline run');
    assert.ok(capturedPayload, 'Sanitized payload should have been posted');
    
    // Assert presence of source: "vision" in redaction_map / merged regions
    const visionRegion = capturedPayload.redaction_map.find(r => r.source === 'vision' || r.source.includes('vision'));
    assert.ok(visionRegion, 'Payload redaction_map must include a region with source: "vision"');
    assert.deepEqual(visionRegion.bbox, [15, 25, 120, 40]);

    // Assert presence of ui_elements in payload
    assert.ok(Array.isArray(capturedPayload.ui_elements), 'Payload must include ui_elements array');
    assert.equal(capturedPayload.ui_elements[0].category, 'button');
    assert.equal(capturedPayload.ui_elements[0].source, 'vision');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UI Vision Integration: Fixture with visible button and icon produces source: "vision" in merged regions', async () => {
  const canvas = createMockCanvas(320, 240);
  const domSkeleton = {
    tag: 'div',
    children: [
      { tag: 'h1', text: 'Welcome Dashboard' }
    ]
  };

  const fixtureUIElements = [
    { bbox: [20, 30, 100, 35], label: 'button', confidence: 0.92 },
    { bbox: [200, 30, 32, 32], label: 'icon', confidence: 0.88 }
  ];

  const result = await executePipeline({
    task: 'Fixture UI elements test',
    canvas,
    domSkeleton,
    uiRegions: fixtureUIElements,
    enableFaceDetection: false,
    enableOcrDetection: false,
    sendToServer: false
  });

  assert.equal(result.success, true);
  assert.equal(result.mergedRegions.length, 2);
  const sources = result.mergedRegions.map(r => r.source);
  assert.ok(sources.every(s => s === 'vision' || s.includes('vision')));
  assert.deepEqual(result.mergedRegions[0].bbox, [20, 30, 100, 35]);
  assert.deepEqual(result.mergedRegions[1].bbox, [200, 30, 32, 32]);
});



