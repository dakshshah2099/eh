/**
 * @fileoverview Automated Latency Profiling and Telemetry Benchmark for Privacy Lens Agent.
 * Ticket 18 — Benchmarks the full client-side perception & redaction pipeline across
 * multiple runs and rigorously asserts compliance against the strict <150ms budget target.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { executePipeline } from './pipeline.js';
import {
  LatencyProfiler,
  defaultProfiler,
  LATENCY_BUDGET_MS,
  PROFILING_PHASES
} from './profiler.js';
import { REDACTION_TOKENS } from './dom_redaction.js';

/**
 * Creates a mock canvas for benchmarking.
 * @param {number} width
 * @param {number} height
 */
function createBenchmarkCanvas(width = 768, height = 432) {
  const pixelCount = width * height * 4;
  const mockBuffer = new Uint8ClampedArray(pixelCount);

  return {
    width,
    height,
    getContext(type) {
      if (type !== '2d') return null;
      return {
        canvas: this,
        fillRect: () => {},
        clearRect: () => {},
        drawImage: () => {},
        getImageData: (sx, sy, sw, sh) => ({
          width: Math.round(sw),
          height: Math.round(sh),
          data: mockBuffer.slice(0, Math.round(sw) * Math.round(sh) * 4)
        }),
        putImageData: () => {},
        save: () => {},
        restore: () => {},
        fillText: () => {}
      };
    },
    toDataURL(format = 'image/png') {
      return `data:${format};base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`;
    }
  };
}

/**
 * Generates a representative DOM skeleton containing sensitive fields and generic controls.
 */
function createBenchmarkDomSkeleton() {
  return {
    tag: 'main',
    id: 'checkout-app',
    children: [
      {
        tag: 'section',
        id: 'user-profile',
        children: [
          {
            tag: 'input',
            id: 'cc-field',
            type: 'text',
            name: 'credit_card',
            value: '4532-1234-5678-9012',
            bbox: [100, 50, 280, 40]
          },
          {
            tag: 'input',
            id: 'pwd-field',
            type: 'password',
            value: 'SuperSecretToken!2026',
            bbox: [100, 110, 280, 40]
          },
          {
            tag: 'p',
            id: 'contact-info',
            text: 'Reach out to user.private@domain.org or call 555-123-4567',
            bbox: [100, 170, 400, 30]
          },
          {
            tag: 'button',
            id: 'checkout-submit',
            text: 'Place Order',
            bbox: [100, 220, 150, 45]
          }
        ]
      }
    ]
  };
}

test('Latency Profiler hooks track all 10 required pipeline phases and assert <150ms budget', async (t) => {
  const NUM_RUNS = 10;
  const profiler = new LatencyProfiler({ budgetMs: LATENCY_BUDGET_MS });

  // 1. Setup local mock server for transport timing phase
  let serverRequests = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      serverRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        actions: [{ type: 'click', target_selector: 'button#checkout-submit' }],
        task_complete: true,
        confidence: 0.98
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}/api/plan`;

  try {
    const rawDom = createBenchmarkDomSkeleton();
    const benchmarkCanvas = createBenchmarkCanvas(768, 432);

    const faceDetections = [
      { bbox: [30, 30, 60, 60], category: 'face', confidence: 0.96 }
    ];
    const ocrDetections = [
      { bbox: [100, 170, 200, 20], text: 'user.private@domain.org', category: 'email', confidence: 0.92 }
    ];

    // Benchmark loop across multiple runs
    for (let i = 0; i < NUM_RUNS; i++) {
      const result = await executePipeline({
        task: `Benchmark Run #${i + 1}`,
        canvas: benchmarkCanvas,
        domSkeleton: rawDom,
        viewport: { width: 1280, height: 720 },
        faceRegions: faceDetections,
        ocrRegions: ocrDetections,
        serverUrl,
        sendToServer: true,
        profiler,
        recordProfiling: true
      });

      assert.equal(result.success, true, 'Pipeline must succeed');
      assert.ok(result.timings, 'Result must contain timings object');

      // Verify presence of all 10 instrumented timing phases
      for (const phase of PROFILING_PHASES) {
        assert.ok(
          phase in result.timings,
          `Phase '${phase}' must be present in timings`
        );
        assert.equal(
          typeof result.timings[phase],
          'number',
          `Phase '${phase}' timing must be a number`
        );
        assert.ok(
          result.timings[phase] >= 0,
          `Phase '${phase}' timing must be non-negative (got ${result.timings[phase]})`
        );
      }

      // Assert per-run total client frame latency strictly complies with <150ms budget
      assert.ok(
        result.timings.total_client_ms < LATENCY_BUDGET_MS,
        `Run #${i + 1} total_client_ms (${result.timings.total_client_ms}ms) exceeded <${LATENCY_BUDGET_MS}ms budget!`
      );
    }

    // 2. Validate aggregated profiler telemetry
    const summary = profiler.getSummary();
    assert.equal(summary.count, NUM_RUNS, `Expected ${NUM_RUNS} recorded runs`);
    assert.equal(summary.budgetMs, LATENCY_BUDGET_MS);
    assert.equal(summary.budgetCompliant, true, 'Summary must confirm budget compliance');

    // Verify statistical summary for each phase
    for (const phase of PROFILING_PHASES) {
      const s = summary.phases[phase];
      assert.ok(s, `Phase stats for '${phase}' must exist`);
      assert.equal(s.count, NUM_RUNS);
      assert.ok(s.mean >= 0, `${phase} mean must be >= 0`);
      assert.ok(s.min >= 0, `${phase} min must be >= 0`);
      assert.ok(s.max >= s.min, `${phase} max must be >= min`);
      assert.ok(s.p50 >= s.min && s.p50 <= s.max, `${phase} p50 out of bounds`);
      assert.ok(s.p95 >= s.p50 && s.p95 <= s.max, `${phase} p95 out of bounds`);
    }

    // Assert aggregate total client latency (Mean and P95) is well under 150ms
    assert.ok(
      summary.total_client_ms.p95 < LATENCY_BUDGET_MS,
      `P95 latency (${summary.total_client_ms.p95}ms) exceeds budget (<${LATENCY_BUDGET_MS}ms)`
    );
    assert.ok(
      summary.total_client_ms.mean < LATENCY_BUDGET_MS,
      `Mean latency (${summary.total_client_ms.mean}ms) exceeds budget (<${LATENCY_BUDGET_MS}ms)`
    );

    // 3. Print telemetry report
    console.log('\n--- AUTOMATED PROFILING TELEMETRY REPORT ---');
    console.log(profiler.formatSummary());
    console.log('--------------------------------------------\n');

  } finally {
    server.close();
  }
});

test('Telemetry summary formatting and profiler methods operate accurately', () => {
  const customProfiler = new LatencyProfiler({ budgetMs: 150 });

  // Initial state check
  const emptySummary = customProfiler.getSummary();
  assert.equal(emptySummary.count, 0);
  assert.equal(emptySummary.total_client_ms, null);
  assert.ok(customProfiler.formatSummary().includes('No profiling records'));

  // Record mock timings
  customProfiler.record({
    capture_ms: 5.2,
    dom_extract_ms: 1.1,
    dom_detect_ms: 2.3,
    face_detect_ms: 12.4,
    ocr_detect_ms: 8.7,
    region_merge_ms: 0.8,
    image_redact_ms: 4.5,
    dom_redact_ms: 1.2,
    transport_ms: 15.0,
    total_client_ms: 51.2
  });

  customProfiler.record({
    capture_ms: 4.8,
    dom_extract_ms: 1.0,
    dom_detect_ms: 2.1,
    face_detect_ms: 10.9,
    ocr_detect_ms: 7.9,
    region_merge_ms: 0.6,
    image_redact_ms: 3.9,
    dom_redact_ms: 1.0,
    transport_ms: 12.0,
    total_client_ms: 44.2
  });

  const summary = customProfiler.getSummary();
  assert.equal(summary.count, 2);
  assert.equal(summary.budgetCompliant, true);
  assert.equal(summary.total_client_ms.min, 44.2);
  assert.equal(summary.total_client_ms.max, 51.2);
  assert.equal(summary.total_client_ms.mean, 47.7);

  const formatted = customProfiler.formatSummary();
  assert.ok(formatted.includes('capture_ms'));
  assert.ok(formatted.includes('total_client_ms'));
  assert.ok(formatted.includes('PASS'));

  // Clear records
  customProfiler.clear();
  assert.equal(customProfiler.getRecords().length, 0);
});

test('Background service worker exposes latency hooks and message dispatchers', async () => {
  // Test global profiler default instance
  defaultProfiler.clear();

  const mockTabId = 404;
  const mockCaptureDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const messageListeners = [];

  const mockChrome = {
    runtime: {
      getURL: (p) => `chrome-extension://mock-id/${p}`,
      getContexts: async () => [],
      sendMessage: () => {},
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: {
        addListener: (fn) => messageListeners.push(fn)
      }
    },
    storage: {
      local: {
        get: async () => ({ agentState: { isRunning: false } }),
        set: async () => {}
      }
    },
    tabs: {
      query: async () => [{ id: mockTabId, active: true }],
      get: async (id) => ({ id, active: true, windowId: 1 }),
      update: async () => {},
      captureVisibleTab: async () => mockCaptureDataUrl,
      sendMessage: async (tabId, msg) => {
        if (msg.type === 'EXTRACT_DOM_SKELETON') {
          return {
            success: true,
            skeleton: { tag: 'div', children: [{ tag: 'input', type: 'password', value: 'secret' }] },
            viewport: { width: 1280, height: 720 }
          };
        }
        return { success: true };
      }
    }
  };

  const origChrome = globalThis.chrome;
  globalThis.chrome = mockChrome;

  try {
    const bg = await import('./background.js');

    // Run pipeline through background helper
    const result = await bg.captureAndSendPlan({
      tabId: mockTabId,
      task: 'Background profiler test',
      canvas: createBenchmarkCanvas(768, 432),
      sendToServer: false
    });

    assert.equal(result.success, true);
    assert.ok(result.timings, 'timings must be attached to background plan result');
    assert.ok(result.timings.total_client_ms < LATENCY_BUDGET_MS, 'Must satisfy <150ms budget');

    // Check telemetry getter
    const summary = bg.getLatencySummary();
    assert.ok(summary.count >= 1, 'Records must be registered in background profiler');
    assert.equal(summary.budgetCompliant, true);

    const records = bg.getLatencyRecords();
    assert.ok(records.length >= 1);
    assert.ok('capture_ms' in records[0]);
    assert.ok('total_client_ms' in records[0]);

    // Test message dispatcher for GET_LATENCY_METRICS
    if (messageListeners.length > 0) {
      const listener = messageListeners[0];
      const getMetricsRes = await new Promise((resolve) => {
        listener({ type: 'GET_LATENCY_METRICS' }, {}, resolve);
      });
      assert.equal(getMetricsRes.success, true);
      assert.ok(getMetricsRes.summary);
      assert.equal(getMetricsRes.summary.budgetCompliant, true);

      // Test CLEAR_LATENCY_METRICS message handler
      const clearRes = await new Promise((resolve) => {
        listener({ type: 'CLEAR_LATENCY_METRICS' }, {}, resolve);
      });
      assert.equal(clearRes.success, true);
      assert.equal(bg.getLatencyRecords().length, 0);
    } else {
      bg.clearLatencyMetrics();
      assert.equal(bg.getLatencyRecords().length, 0);
    }
  } finally {
    globalThis.chrome = origChrome;
  }
});
