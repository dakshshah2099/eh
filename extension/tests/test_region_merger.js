/**
 * @fileoverview Comprehensive unit tests for Ticket 13 — Region Merger.
 * Tests pure function mergeSensitiveRegions against all required deduplication,
 * overlap metrics, hierarchy resolution, source combination, confidence adjustment,
 * and sorting constraints.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeSensitiveRegions,
  normalizeBBox,
  computeBBoxMetrics,
  computeUnionBBox,
  computeEnclosingBBox,
  resolveCategory,
  combineSources,
  combineConfidences,
  shouldMerge,
  DEFAULT_CATEGORY_PRIORITY,
  DEFAULT_SOURCE_ORDER,
  normalizeUIElements
} from '../src/region_merger.js';

test('Region Merger: Helper normalizeBBox handles all supported formats', () => {
  assert.deepEqual(normalizeBBox([10, 20, 100, 50]), [10, 20, 100, 50]);
  assert.deepEqual(normalizeBBox({ x: 10, y: 20, w: 100, h: 50 }), [10, 20, 100, 50]);
  assert.deepEqual(normalizeBBox({ x: 10, y: 20, width: 100, height: 50 }), [10, 20, 100, 50]);
  assert.deepEqual(normalizeBBox({ left: 10, top: 20, width: 100, height: 50 }), [10, 20, 100, 50]);
  assert.deepEqual(normalizeBBox({ x0: 10, y0: 20, x1: 110, y1: 70 }), [10, 20, 100, 50]);
  assert.equal(normalizeBBox(null), null);
  assert.equal(normalizeBBox(undefined), null);
  assert.equal(normalizeBBox('invalid'), null);
});

test('Region Merger: computeBBoxMetrics calculates IoU and containment accurately', () => {
  // Box A and Box B identical
  const mSame = computeBBoxMetrics([0, 0, 100, 100], [0, 0, 100, 100]);
  assert.equal(mSame.iou, 1.0);
  assert.equal(mSame.containment, 1.0);

  // Box B completely inside Box A (containment = 1.0, low IoU)
  const mContained = computeBBoxMetrics([0, 0, 200, 200], [50, 50, 50, 50]);
  assert.equal(mContained.containment, 1.0);
  assert.equal(mContained.intersectionArea, 2500);
  assert.equal(mContained.unionArea, 40000);
  assert.equal(mContained.iou, 2500 / 40000);

  // Disjoint boxes
  const mDisjoint = computeBBoxMetrics([0, 0, 50, 50], [100, 100, 50, 50]);
  assert.equal(mDisjoint.iou, 0);
  assert.equal(mDisjoint.containment, 0);
  assert.equal(mDisjoint.intersectionArea, 0);

  // Partial overlap with IoU ~ 0.33
  const mPartial = computeBBoxMetrics([0, 0, 100, 100], [50, 0, 100, 100]);
  assert.equal(mPartial.intersectionArea, 5000);
  assert.equal(mPartial.unionArea, 15000);
  assert.equal(Number(mPartial.iou.toFixed(3)), 0.333);
});

test('Region Merger: computeUnionBBox covers bounding envelope of overlapping boxes', () => {
  const union = computeUnionBBox([10, 20, 50, 50], [30, 40, 80, 60]);
  // minX = 10, minY = 20, maxX = 30 + 80 = 110, maxY = 40 + 60 = 100
  // w = 110 - 10 = 100, h = 100 - 20 = 80
  assert.deepEqual(union, [10, 20, 100, 80]);
});

test('Region Merger: resolveCategory adheres to hierarchy (password > card > ssn > email > phone > face)', () => {
  assert.equal(resolveCategory(['password', 'card']), 'password');
  assert.equal(resolveCategory(['card', 'ssn']), 'card');
  assert.equal(resolveCategory(['ssn', 'email']), 'ssn');
  assert.equal(resolveCategory(['email', 'phone']), 'email');
  assert.equal(resolveCategory(['phone', 'face']), 'phone');
  assert.equal(resolveCategory(['face', 'card']), 'card');
  assert.equal(resolveCategory(['face', 'password']), 'password');
  assert.equal(resolveCategory(['pin', 'email']), 'pin');
  assert.equal(resolveCategory(['unknown', 'face']), 'face');

  // Custom priority override
  const customPriority = ['face', 'password', 'card'];
  assert.equal(resolveCategory(['password', 'face'], customPriority), 'face');
});

test('Region Merger: combineSources combines and deduplicates sources canonically', () => {
  assert.equal(combineSources(['dom', 'ocr']), 'dom+ocr');
  assert.equal(combineSources(['ocr', 'dom']), 'dom+ocr');
  assert.equal(combineSources(['dom', 'cv']), 'dom+cv');
  assert.equal(combineSources(['dom', 'face']), 'dom+face');
  assert.equal(combineSources(['dom+ocr', 'face']), 'dom+ocr+face');
  assert.equal(combineSources(['dom', 'dom']), 'dom');
  assert.equal(combineSources(['ocr', 'ocr']), 'ocr');
});

test('Region Merger: combineConfidences calculates corroboration score', () => {
  // Single score
  assert.equal(combineConfidences([0.8]), 0.8);

  // Probabilistic combination of two 0.8 scores: 1 - (1 - 0.8)*(1 - 0.8) = 0.96
  assert.equal(combineConfidences([0.8, 0.8]), 0.96);

  // Probabilistic combination with 1.0 caps at 1.0
  assert.equal(combineConfidences([1.0, 0.7]), 1.0);

  // Max strategy
  assert.equal(combineConfidences([0.7, 0.9], { confidenceStrategy: 'max' }), 0.9);

  // Average strategy
  assert.equal(combineConfidences([0.6, 0.8], { confidenceStrategy: 'average' }), 0.7);
});

test('Region Merger: Deduplicates DOM and OCR overlapping email input', () => {
  const domRegions = [
    { bbox: [100, 200, 300, 40], category: 'email', source: 'dom', confidence: 1.0 }
  ];
  const ocrRegions = [
    { bbox: [105, 208, 180, 24], category: 'email', source: 'ocr', confidence: 0.92 }
  ];

  const merged = mergeSensitiveRegions(domRegions, [], ocrRegions);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    bbox: [100, 200, 300, 40],
    category: 'email',
    source: 'dom+ocr',
    confidence: 1.0
  });
});

test('Region Merger: Resolves category priority when DOM and OCR categories conflict', () => {
  // DOM element identified as generic card/input, but OCR detects password text
  const domRegions = [
    { bbox: [50, 100, 250, 45], category: 'card', source: 'dom', confidence: 1.0 }
  ];
  const ocrRegions = [
    { bbox: [60, 110, 140, 25], category: 'password', source: 'ocr', confidence: 0.85 }
  ];

  const merged = mergeSensitiveRegions(domRegions, [], ocrRegions);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    bbox: [50, 100, 250, 45],
    category: 'password', // password beats card
    source: 'dom+ocr',
    confidence: 1.0
  });
});

test('Region Merger: Deduplicates multiple overlapping face detections', () => {
  // Two candidate bounding boxes for the same face from CV detector
  const faceRegions = [
    { bbox: [400, 150, 80, 80], category: 'face', source: 'cv', confidence: 0.78 },
    { bbox: [410, 155, 80, 85], category: 'face', source: 'cv', confidence: 0.82 }
  ];

  const merged = mergeSensitiveRegions([], faceRegions, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].category, 'face');
  assert.equal(merged[0].source, 'cv');
  // Union bbox: minX=400, minY=150, maxX=490, maxY=240 -> w=90, h=90
  assert.deepEqual(merged[0].bbox, [400, 150, 90, 90]);
  // Probabilistic confidence: 1 - (1 - 0.78)*(1 - 0.82) = 1 - 0.22*0.18 = 0.9604
  assert.equal(merged[0].confidence, 0.9604);
});

test('Region Merger: Merges multiple OCR word fragments inside a single DOM region', () => {
  // Credit card DOM input with multiple tokenized OCR snippets inside
  const domRegions = [
    { bbox: [50, 300, 320, 50], category: 'card', source: 'dom', confidence: 1.0 }
  ];
  const ocrRegions = [
    { bbox: [60, 310, 60, 25], category: 'card', source: 'ocr', confidence: 0.9 },
    { bbox: [130, 310, 60, 25], category: 'card', source: 'ocr', confidence: 0.9 },
    { bbox: [200, 310, 60, 25], category: 'card', source: 'ocr', confidence: 0.9 }
  ];

  const merged = mergeSensitiveRegions(domRegions, [], ocrRegions);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    bbox: [50, 300, 320, 50],
    category: 'card',
    source: 'dom+ocr',
    confidence: 1.0
  });
});

test('Region Merger: Preserves non-overlapping distinct regions in sorted reading order', () => {
  const domRegions = [
    { bbox: [100, 500, 200, 30], category: 'password', source: 'dom', confidence: 1.0 }
  ];
  const faceRegions = [
    { bbox: [50, 50, 100, 100], category: 'face', source: 'face', confidence: 0.85 }
  ];
  const ocrRegions = [
    { bbox: [100, 250, 150, 25], category: 'phone', source: 'ocr', confidence: 0.90 }
  ];

  const merged = mergeSensitiveRegions(domRegions, faceRegions, ocrRegions);
  assert.equal(merged.length, 3);

  // Sorted by y asc, then x asc (reading order)
  // 1: Face at y=50
  assert.equal(merged[0].category, 'face');
  assert.deepEqual(merged[0].bbox, [50, 50, 100, 100]);

  // 2: OCR Phone at y=250
  assert.equal(merged[1].category, 'phone');
  assert.deepEqual(merged[1].bbox, [100, 250, 150, 25]);

  // 3: DOM Password at y=500
  assert.equal(merged[2].category, 'password');
  assert.deepEqual(merged[2].bbox, [100, 500, 200, 30]);
});

test('Region Merger: Supports flexible call signatures and options', () => {
  // Signature 1: Single combined array with options
  const allInOne = [
    { bbox: [10, 10, 100, 100], category: 'phone', source: 'ocr', confidence: 0.6 },
    { bbox: [15, 15, 90, 90], category: 'ssn', source: 'dom', confidence: 0.9 }
  ];
  const res1 = mergeSensitiveRegions(allInOne, { iouThreshold: 0.2 });
  assert.equal(res1.length, 1);
  assert.equal(res1[0].category, 'ssn'); // ssn > phone
  assert.equal(res1[0].source, 'dom+ocr');

  // Signature 2: Wrapped object { dom, face, ocr }
  const res2 = mergeSensitiveRegions({
    dom: [{ bbox: [0, 0, 50, 50], category: 'email' }],
    face: [{ bbox: [200, 200, 60, 60], category: 'face' }]
  });
  assert.equal(res2.length, 2);

  // Signature 3: Empty / null safety
  assert.deepEqual(mergeSensitiveRegions(), []);
  assert.deepEqual(mergeSensitiveRegions(null, undefined, []), []);
  assert.deepEqual(mergeSensitiveRegions([{ bbox: [0, 0, 0, 0] }]), []); // 0 area skipped
});

test('Region Merger: Sort options (confidence, category, reading-order)', () => {
  const regions = [
    { bbox: [10, 300, 50, 50], category: 'phone', source: 'ocr', confidence: 0.5 },
    { bbox: [10, 100, 50, 50], category: 'password', source: 'dom', confidence: 0.99 },
    { bbox: [10, 200, 50, 50], category: 'card', source: 'ocr', confidence: 0.75 }
  ];

  // Sort by confidence descending
  const byConf = mergeSensitiveRegions(regions, { sortBy: 'confidence' });
  assert.equal(byConf[0].category, 'password');
  assert.equal(byConf[1].category, 'card');
  assert.equal(byConf[2].category, 'phone');

  // Sort by category priority
  const byCat = mergeSensitiveRegions(regions, { sortBy: 'category' });
  assert.equal(byCat[0].category, 'password');
  assert.equal(byCat[1].category, 'card');
  assert.equal(byCat[2].category, 'phone');

  // Sort by reading order (y asc)
  const byReading = mergeSensitiveRegions(regions, { sortBy: 'reading-order' });
  assert.equal(byReading[0].bbox[1], 100);
  assert.equal(byReading[1].bbox[1], 200);
  assert.equal(byReading[2].bbox[1], 300);
});

test('Ticket 01 / C1: normalizeUIElements formats vision detections into ui_elements structure', () => {
  // Empty / invalid input safety
  assert.deepEqual(normalizeUIElements(), []);
  assert.deepEqual(normalizeUIElements(null), []);
  assert.deepEqual(normalizeUIElements([]), []);

  const inputVisionDetections = [
    { bbox: [10, 20, 100, 40], label: 'button', confidence: 0.95 },
    { bbox: { x: 50, y: 150, width: 200, height: 35 }, label: 'input', confidence: 0.8 },
    { bbox: [0, 0, 0, 0], label: 'zero-area-icon' }, // Degenerate: should be skipped
    { bbox: [30, 40, -10, 20], label: 'negative-dim' }, // Degenerate: should be skipped
    { bbox: [120, 80, 24, 24], category: 'icon', element_id: 'settings-cog' }
  ];

  const result = normalizeUIElements(inputVisionDetections);
  assert.equal(result.length, 3);

  // First element: button
  assert.deepEqual(result[0].bbox, [10, 20, 100, 40]);
  assert.equal(result[0].category, 'button');
  assert.equal(result[0].label, 'button');
  assert.equal(result[0].source, 'vision');
  assert.equal(result[0].confidence, 0.95);

  // Second element: input with object bbox format
  assert.deepEqual(result[1].bbox, [50, 150, 200, 35]);
  assert.equal(result[1].category, 'input');
  assert.equal(result[1].label, 'input');
  assert.equal(result[1].source, 'vision');
  assert.equal(result[1].confidence, 0.8);

  // Third element: icon preserving extra fields
  assert.deepEqual(result[2].bbox, [120, 80, 24, 24]);
  assert.equal(result[2].category, 'icon');
  assert.equal(result[2].label, 'icon');
  assert.equal(result[2].source, 'vision');
  assert.equal(result[2].confidence, 1.0);
  assert.equal(result[2].element_id, 'settings-cog');
});

test('Ticket 01 / C1: mergeSensitiveRegions only ingests DOM, face, OCR regions and rejects UI vision regions', () => {
  const domRegions = [
    { bbox: [10, 10, 100, 30], category: 'password', source: 'dom', confidence: 1.0 }
  ];
  const faceRegions = [
    { bbox: [150, 50, 80, 80], category: 'face', source: 'face', confidence: 0.9 }
  ];
  const ocrRegions = [
    { bbox: [10, 200, 120, 25], category: 'phone', source: 'ocr', confidence: 0.85 }
  ];
  const uiRegions = [
    { bbox: [10, 10, 100, 30], category: 'button', source: 'vision', confidence: 0.95 },
    { bbox: [300, 300, 50, 50], category: 'ui_element', source: 'vision', confidence: 0.9 }
  ];

  // Call with uiRegions passed as 4th arg - must be ignored!
  const merged = mergeSensitiveRegions(domRegions, faceRegions, ocrRegions, uiRegions, { preserveExtraFields: true });
  assert.equal(merged.length, 3);
  for (const r of merged) {
    assert.notEqual(r.source, 'vision');
    assert.equal(r.source.includes('vision'), false);
    assert.notEqual(r.category, 'button');
    assert.notEqual(r.category, 'ui_element');
  }

  // Passing array containing vision elements directly - vision elements must be filtered out
  const directVisionInput = [
    { bbox: [10, 10, 50, 50], category: 'button', source: 'vision' },
    { bbox: [60, 60, 50, 50], category: 'ui_element', source: 'unknown' },
    { bbox: [100, 100, 50, 50], category: 'password', source: 'dom' }
  ];
  const mergedDirect = mergeSensitiveRegions(directVisionInput);
  assert.equal(mergedDirect.length, 1);
  assert.equal(mergedDirect[0].category, 'password');
  assert.equal(mergedDirect[0].source, 'dom');
});

