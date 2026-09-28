import assert from 'node:assert/strict';
import {
  SENSITIVE_PATTERNS,
  CATEGORY_ORDER,
  normalizeBBox,
  normalizeConfidence,
  scanTextForSensitiveSpans,
  computeMatchBoundingBox,
  extractSensitiveRegionsFromOCR,
  detectCanvasTextRegions,
  detectSensitiveOCRRegions
} from './ocr_detector.js';

// Test 1: Regex pattern extraction for each category
{
  const emailSample = 'Reach us at contact@privacy-lens.org or support.team+dev@sub.company.io';
  const emailSpans = scanTextForSensitiveSpans(emailSample, ['email']);
  assert.equal(emailSpans.length, 2);
  assert.equal(emailSpans[0].category, 'email');
  assert.equal(emailSpans[0].text, 'contact@privacy-lens.org');
  assert.equal(emailSpans[1].category, 'email');
  assert.equal(emailSpans[1].text, 'support.team+dev@sub.company.io');

  const phoneSample = 'Call +1-800-555-0199 or (415) 555-2671 or direct 555-8765';
  const phoneSpans = scanTextForSensitiveSpans(phoneSample, ['phone']);
  assert.equal(phoneSpans.length, 3);
  assert.equal(phoneSpans[0].category, 'phone');
  assert.equal(phoneSpans[0].text, '+1-800-555-0199');
  assert.equal(phoneSpans[1].category, 'phone');
  assert.equal(phoneSpans[1].text, '(415) 555-2671');
  assert.equal(phoneSpans[2].category, 'phone');
  assert.equal(phoneSpans[2].text, '555-8765');

  const cardSample = 'Cards: 4111 2222 3333 4444, 5500-0000-0000-0004 and 1234567890123456';
  const cardSpans = scanTextForSensitiveSpans(cardSample, ['card']);
  assert.equal(cardSpans.length, 3);
  assert.equal(cardSpans[0].category, 'card');
  assert.equal(cardSpans[0].text, '4111 2222 3333 4444');
  assert.equal(cardSpans[1].category, 'card');
  assert.equal(cardSpans[1].text, '5500-0000-0000-0004');
  assert.equal(cardSpans[2].category, 'card');
  assert.equal(cardSpans[2].text, '1234567890123456');

  const ssnSample = 'Government ID: SSN 123-45-6789 confidential';
  const ssnSpans = scanTextForSensitiveSpans(ssnSample, ['ssn']);
  assert.equal(ssnSpans.length, 1);
  assert.equal(ssnSpans[0].category, 'ssn');
  assert.equal(ssnSpans[0].text, '123-45-6789');
}

// Test 2: Priority deduplication (Card and SSN prevent false-positive Phone matches)
{
  const mixedText = 'Confidential: Card 4111-2222-3333-4444 and SSN 987-65-4321 with phone +1-555-000-9999';
  const spans = scanTextForSensitiveSpans(mixedText);

  // Card should match '4111-2222-3333-4444' as card, not phone
  // SSN should match '987-65-4321' as ssn
  // Phone should match '+1-555-000-9999' as phone
  assert.equal(spans.length, 3);
  assert.equal(spans[0].category, 'card');
  assert.equal(spans[0].text, '4111-2222-3333-4444');
  assert.equal(spans[1].category, 'ssn');
  assert.equal(spans[1].text, '987-65-4321');
  assert.equal(spans[2].category, 'phone');
  assert.equal(spans[2].text, '+1-555-000-9999');
}

// Test 3: Normalization utilities (BBox and Confidence)
{
  // Array bbox
  assert.deepEqual(normalizeBBox([10.2, 20.8, 100.1, 50.4]), [10, 21, 100, 50]);

  // Object {x, y, w, h}
  assert.deepEqual(normalizeBBox({ x: 5, y: 15, w: 60, h: 25 }), [5, 15, 60, 25]);

  // Tesseract format {x0, y0, x1, y1}
  assert.deepEqual(normalizeBBox({ x0: 100, y0: 200, x1: 250, y1: 230 }), [100, 200, 150, 30]);

  // Confidence normalization
  assert.equal(normalizeConfidence(95), 0.95);
  assert.equal(normalizeConfidence(0.88), 0.88);
  assert.equal(normalizeConfidence(null), 0.85);
  assert.equal(normalizeConfidence(undefined), 0.85);
  assert.equal(normalizeConfidence(150), 1.0);
}

// Test 4: Bounding box computation with word-level union
{
  const line = {
    text: 'Billing Card: 4111 2222 3333 4444 Approved',
    bbox: [50, 100, 400, 30],
    confidence: 96,
    words: [
      { text: 'Billing', bbox: [50, 100, 60, 30], confidence: 98 },
      { text: 'Card:', bbox: [115, 100, 45, 30], confidence: 97 },
      { text: '4111', bbox: [165, 100, 40, 30], confidence: 95 },
      { text: '2222', bbox: [210, 100, 40, 30], confidence: 95 },
      { text: '3333', bbox: [255, 100, 40, 30], confidence: 95 },
      { text: '4444', bbox: [300, 100, 40, 30], confidence: 95 },
      { text: 'Approved', bbox: [345, 100, 80, 30], confidence: 99 }
    ]
  };

  const spans = scanTextForSensitiveSpans(line.text);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].category, 'card');

  const { bbox, confidence } = computeMatchBoundingBox(line, spans[0].start, spans[0].end);
  // Union of 4111, 2222, 3333, 4444: minX=165, minY=100, maxX=340, maxY=130 => w=175, h=30
  assert.equal(bbox[0], 165);
  assert.equal(bbox[1], 100);
  assert.equal(bbox[2], 175);
  assert.equal(bbox[3], 30);
  assert.equal(confidence, 0.95);
}

// Test 5: Bounding box proportional fallback when no word boxes
{
  const line = {
    text: 'Contact admin@domain.com now',
    bbox: [100, 200, 280, 25],
    confidence: 0.9
  };

  const spans = scanTextForSensitiveSpans(line.text);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].category, 'email');

  const { bbox, confidence } = computeMatchBoundingBox(line, spans[0].start, spans[0].end);
  assert.equal(bbox[1], 200);
  assert.equal(bbox[3], 25);
  assert(bbox[0] > 100);
  assert(bbox[2] > 0);
  assert.equal(confidence, 0.9);
}

// Test 6: Full OCR extraction matching schema [{ bbox, category, source, confidence }]
{
  const ocrData = {
    lines: [
      {
        text: 'User email is user.name@test.org',
        bbox: [10, 20, 250, 20],
        confidence: 90
      },
      {
        text: 'Direct hotline: +1 800 555 1234',
        bbox: [10, 50, 250, 20],
        confidence: 88
      },
      {
        text: 'Payment CC: 4000-1234-5678-9010',
        bbox: [10, 80, 250, 20],
        confidence: 92
      },
      {
        text: 'SSN on file: 000-11-2222',
        bbox: [10, 110, 250, 20],
        confidence: 94
      }
    ]
  };

  const results = extractSensitiveRegionsFromOCR(ocrData);
  assert.equal(results.length, 4);

  // Validate exact schema
  for (const item of results) {
    assert(Array.isArray(item.bbox));
    assert.equal(item.bbox.length, 4);
    item.bbox.forEach(num => assert(typeof num === 'number' && !Number.isNaN(num)));
    assert(['email', 'phone', 'card', 'ssn'].includes(item.category));
    assert.equal(item.source, 'ocr');
    assert(typeof item.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1);
  }

  assert.equal(results[0].category, 'email');
  assert.equal(results[1].category, 'phone');
  assert.equal(results[2].category, 'card');
  assert.equal(results[3].category, 'ssn');
}

// Test 7: Lightweight CV Canvas text detection
{
  // Create synthetic ImageData with a high contrast line stroke
  const width = 100;
  const height = 40;
  const data = new Uint8ClampedArray(width * height * 4);

  // Draw dark stroke on light background
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (y >= 10 && y <= 20 && x >= 15 && x <= 85) {
        // Dark text stroke
        data[idx] = 20;
        data[idx + 1] = 20;
        data[idx + 2] = 20;
        data[idx + 3] = 255;
      } else {
        // Light background
        data[idx] = 240;
        data[idx + 1] = 240;
        data[idx + 2] = 240;
        data[idx + 3] = 255;
      }
    }
  }

  const detectedBoxes = detectCanvasTextRegions({ width, height, data });
  assert(detectedBoxes.length > 0);
  assert(detectedBoxes[0].bbox[0] >= 10 && detectedBoxes[0].bbox[0] <= 20);
  assert(detectedBoxes[0].bbox[1] >= 8 && detectedBoxes[0].bbox[1] <= 12);
  assert(detectedBoxes[0].bbox[2] >= 60);
  assert(detectedBoxes[0].bbox[3] >= 8);
}

// Test 8: Main detectSensitiveOCRRegions with pluggable recognizer
{
  const mockImage = { width: 640, height: 480 };
  const mockRecognizer = async (_img) => [
    {
      text: 'Order confirmation: card 5412-7512-3412-3456 and email buyer@store.com',
      bbox: [40, 80, 500, 30],
      confidence: 0.93
    }
  ];

  const regions = await detectSensitiveOCRRegions(mockImage, { recognizer: mockRecognizer });
  assert.equal(regions.length, 2);
  assert.equal(regions[0].category, 'card');
  assert.equal(regions[0].source, 'ocr');
  assert.equal(regions[1].category, 'email');
  assert.equal(regions[1].source, 'ocr');
}

// Test 9: Main detectSensitiveOCRRegions with synthetic annotated canvas
{
  const syntheticCanvas = {
    width: 800,
    height: 600,
    __ocrTextLines: [
      {
        text: 'Tax Document SSN: 111-22-3333',
        bbox: [50, 50, 300, 25],
        confidence: 0.97
      }
    ]
  };

  const regions = await detectSensitiveOCRRegions(syntheticCanvas);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].category, 'ssn');
  assert.equal(regions[0].source, 'ocr');
  assert.equal(regions[0].confidence, 0.97);
}

console.log('All OCR detector tests passed successfully!');
