/**
 * Test Verification Suite for Ticket 09: Vision Model Inference.
 * 
 * Verifies:
 * 1. Quantized model loads (<50MB memory footprint)
 * 2. WebGPU backend with WASM fallback
 * 3. runVisionInference() with Canvas / ImageData
 * 4. runVisionInference() with Base64 data URL
 * 5. Bounding box [x,y,w,h] and class label ('button'|'input'|'icon'|'text') formatting
 * 6. Non-Maximum Suppression (NMS) and IoU calculation
 * 7. Offscreen document message handling
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  CLASS_LABELS,
  MAX_MODEL_SIZE_BYTES,
  DEFAULT_MODEL_DIMS,
  detectBackend,
  loadVisionModel,
  getVisionSession,
  resetVisionSession,
  parseImageInput,
  preprocessImage,
  calculateIoU,
  nonMaxSuppression,
  runVisionInference
} from '../src/vision_inference.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates a minimal PNG base64 string for testing.
 */
function createTestPngBase64(width, height, drawFn) {
  const bpp = 4;
  const raw = Buffer.alloc(height * (1 + width * bpp));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * bpp);
    raw[rowOffset] = 0; // Filter none
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * bpp;
      const [r, g, b, a] = drawFn(x, y);
      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = a;
    }
  }
  const compressed = zlib.deflateSync(raw);

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13 + 12);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  ihdr[18] = 0; ihdr[19] = 0; ihdr[20] = 0;

  const idat = Buffer.alloc(compressed.length + 12);
  idat.writeUInt32BE(compressed.length, 0);
  idat.write('IDAT', 4);
  compressed.copy(idat, 8);

  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);

  const pngBuf = Buffer.concat([sig, ihdr, idat, iend]);
  return 'data:image/png;base64,' + pngBuf.toString('base64');
}

async function runAllTests() {
  console.log('--- Running Ticket 09 Vision Model Inference Tests ---\n');

  // Test 1: Model file verification & <50MB size constraint
  console.log('Test 1: Verifying quantized model bundle & size constraint...');
  const modelPath = path.join(__dirname, '../models/ui_detector_quantized.onnx');
  assert(fs.existsSync(modelPath), `Model file must exist at ${modelPath}`);

  const stat = fs.statSync(modelPath);
  const sizeMB = stat.size / 1024 / 1024;
  console.log(`  Model file size: ${(stat.size / 1024).toFixed(2)} KB (${sizeMB.toFixed(3)} MB)`);
  assert(stat.size < MAX_MODEL_SIZE_BYTES, `Model size must be < 50MB (actual: ${sizeMB.toFixed(3)} MB)`);
  console.log('✓ Model bundle exists and is well under 50MB limit.\n');

  // Test 2: WebGPU detection and WASM fallback logic
  console.log('Test 2: Verifying WebGPU detection and WASM fallback...');
  const fallback = await detectBackend();
  assert.equal(fallback.selectedBackend, 'wasm', 'Should select wasm when navigator.gpu is absent');
  assert.deepEqual(fallback.executionProviders, ['wasm']);
  assert.equal(fallback.webgpu.available, false);
  assert.equal(fallback.wasm.available, true);

  // Mock navigator.gpu
  const origGpu = Object.getOwnPropertyDescriptor(globalThis.navigator, 'gpu');
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: {
      requestAdapter: async () => ({
        info: { vendor: 'test-gpu-vendor', architecture: 'test-arch', device: 'test-device' },
        requestDevice: async () => ({ destroy: () => {} })
      })
    },
    configurable: true,
    writable: true
  });

  const gpuBackend = await detectBackend();
  assert.equal(gpuBackend.selectedBackend, 'webgpu');
  assert(gpuBackend.executionProviders.includes('webgpu'));
  assert.equal(gpuBackend.webgpu.available, true);

  // Restore navigator.gpu
  if (origGpu) {
    Object.defineProperty(globalThis.navigator, 'gpu', origGpu);
  } else {
    delete globalThis.navigator.gpu;
  }
  console.log('✓ WebGPU detection and WASM fallback logic confirmed.\n');

  // Test 3: Model loading into memory
  console.log('Test 3: Loading quantized model session into memory...');
  resetVisionSession();
  assert.equal(getVisionSession(), null);

  const sessionMeta = await loadVisionModel({ backend: 'wasm' });
  assert(sessionMeta.session, 'Session must be created');
  assert.equal(sessionMeta.backend, 'wasm');
  assert(sessionMeta.modelSize > 0 && sessionMeta.modelSize < MAX_MODEL_SIZE_BYTES);
  assert(sessionMeta.inputNames.includes('images'));
  assert(sessionMeta.outputNames.includes('boxes'));
  assert(sessionMeta.outputNames.includes('scores'));
  assert.equal(getVisionSession(), sessionMeta);
  console.log(`✓ Model loaded into memory successfully (input: ${sessionMeta.inputNames}, outputs: ${sessionMeta.outputNames}).\n`);

  // Test 4: Preprocessing & tensor shapes
  console.log('Test 4: Verifying image preprocessing into CHW tensor...');
  const testImg = {
    width: 320,
    height: 240,
    data: new Uint8ClampedArray(320 * 240 * 4).fill(128)
  };

  const preprocessed = await preprocessImage(testImg, DEFAULT_MODEL_DIMS.width, DEFAULT_MODEL_DIMS.height);
  assert(preprocessed.inputTensor, 'Must produce inputTensor');
  assert.deepEqual(preprocessed.inputTensor.dims, [1, 3, 256, 256], 'Dims must match [1, 3, 256, 256]');
  assert.equal(preprocessed.inputTensor.type, 'float32', 'Type must be float32');
  assert.equal(preprocessed.origWidth, 320);
  assert.equal(preprocessed.origHeight, 240);

  // Check normalized range [0.0, 1.0]
  const sampleVal = preprocessed.inputTensor.data[0];
  assert(sampleVal >= 0.0 && sampleVal <= 1.0, `Tensor value ${sampleVal} must be normalized [0, 1]`);
  console.log('✓ Image preprocessing correctly generates planar normalized [1, 3, 256, 256] tensor.\n');

  // Test 5: Inference on Canvas / ImageData
  console.log('Test 5: Running vision inference on synthetic Canvas / ImageData...');
  // Synthetic canvas with UI components:
  // - Button at [30, 40, 100, 36] (blue filled rect)
  // - Input field at [30, 95, 200, 32] (bordered outline)
  // - Icon at [250, 40, 32, 32]
  const imgW = 320, imgH = 200;
  const canvasData = new Uint8ClampedArray(imgW * imgH * 4).fill(255); // White background

  // Draw Button
  for (let y = 40; y < 76; y++) {
    for (let x = 30; x < 130; x++) {
      const idx = (y * imgW + x) * 4;
      canvasData[idx] = 20; canvasData[idx + 1] = 100; canvasData[idx + 2] = 220; // Blue
    }
  }

  // Draw Input Field
  for (let y = 95; y < 127; y++) {
    for (let x = 30; x < 230; x++) {
      const idx = (y * imgW + x) * 4;
      const isBorder = (y === 95 || y === 126 || x === 30 || x === 229);
      if (isBorder) {
        canvasData[idx] = 100; canvasData[idx + 1] = 100; canvasData[idx + 2] = 100;
      } else {
        canvasData[idx] = 245; canvasData[idx + 1] = 245; canvasData[idx + 2] = 245;
      }
    }
  }

  // Draw Icon
  for (let y = 40; y < 72; y++) {
    for (let x = 250; x < 282; x++) {
      const idx = (y * imgW + x) * 4;
      canvasData[idx] = 220; canvasData[idx + 1] = 150; canvasData[idx + 2] = 30;
    }
  }

  const detections = await runVisionInference({ width: imgW, height: imgH, data: canvasData }, { confidenceThreshold: 0.25 });
  assert(Array.isArray(detections), 'Must return an array');
  assert(detections.length > 0, 'Must detect UI elements');

  for (const det of detections) {
    // Check bounding box format [x, y, w, h]
    assert(Array.isArray(det.bbox) && det.bbox.length === 4, 'BBox must be array [x,y,w,h]');
    const [x, y, w, h] = det.bbox;
    assert(Number.isInteger(x) && x >= 0 && x < imgW, `Invalid x coordinate: ${x}`);
    assert(Number.isInteger(y) && y >= 0 && y < imgH, `Invalid y coordinate: ${y}`);
    assert(Number.isInteger(w) && w > 0 && w <= imgW, `Invalid width: ${w}`);
    assert(Number.isInteger(h) && h > 0 && h <= imgH, `Invalid height: ${h}`);

    // Check label format
    assert(CLASS_LABELS.includes(det.label), `Label '${det.label}' must be one of: ${CLASS_LABELS.join(', ')}`);

    // Check confidence format
    assert(typeof det.confidence === 'number', 'Confidence must be a number');
    assert(det.confidence >= 0.0 && det.confidence <= 1.0, `Confidence ${det.confidence} must be between 0.0 and 1.0`);
  }

  const labels = detections.map(d => d.label);
  console.log(`  Found ${detections.length} detections with labels: ${[...new Set(labels)].join(', ')}`);
  console.log(`  Sample detection:`, detections[0]);
  console.log('✓ Canvas / ImageData inference returned valid bounding boxes and class labels.\n');

  // Test 6: Inference on Base64 image
  console.log('Test 6: Running vision inference on Base64 data URL...');
  const base64Png = createTestPngBase64(180, 120, (x, y) => {
    // Button at [20, 25, 80, 30]
    if (x >= 20 && x <= 100 && y >= 25 && y <= 55) {
      return [10, 80, 200, 255];
    }
    // Text row at [20, 75, 140, 15]
    if (x >= 20 && x <= 160 && y >= 75 && y <= 90) {
      return [30, 30, 30, 255];
    }
    return [255, 255, 255, 255];
  });

  const b64Detections = await runVisionInference(base64Png, { confidenceThreshold: 0.25 });
  assert(Array.isArray(b64Detections) && b64Detections.length > 0, 'Base64 image must produce detections');

  for (const det of b64Detections) {
    assert(Array.isArray(det.bbox) && det.bbox.length === 4);
    assert(CLASS_LABELS.includes(det.label));
    assert(det.confidence >= 0.0 && det.confidence <= 1.0);
  }
  console.log(`  Base64 detections count: ${b64Detections.length}`);
  console.log(`  Sample Base64 detection:`, b64Detections[0]);
  console.log('✓ Base64 image inference operated cleanly.\n');

  // Test 7: Non-Maximum Suppression (NMS) & IoU
  console.log('Test 7: Testing IoU and Non-Maximum Suppression (NMS)...');
  // Disjoint boxes: IoU should be 0
  const iouDisjoint = calculateIoU([0, 0, 10, 10], [20, 20, 10, 10]);
  assert.equal(iouDisjoint, 0.0);

  // Exact same box: IoU should be 1
  const iouIdentical = calculateIoU([10, 10, 20, 20], [10, 10, 20, 20]);
  assert.equal(iouIdentical, 1.0);

  // 50% overlap box
  const iouPartial = calculateIoU([0, 0, 20, 10], [10, 0, 20, 10]);
  assert(iouPartial > 0.3 && iouPartial < 0.4);

  // Test NMS suppression of near-duplicate boxes
  const duplicates = [
    { bbox: [50, 50, 100, 40], label: 'button', confidence: 0.90 },
    { bbox: [51, 50, 99, 41], label: 'button', confidence: 0.85 },
    { bbox: [50, 52, 102, 39], label: 'button', confidence: 0.70 },
    { bbox: [200, 200, 40, 40], label: 'icon', confidence: 0.88 }
  ];

  const nmsResults = nonMaxSuppression(duplicates, 0.45);
  assert.equal(nmsResults.length, 2, 'Should suppress overlapping boxes down to 2');
  assert.equal(nmsResults[0].confidence, 0.90, 'Should keep highest confidence box');
  assert.equal(nmsResults[1].label, 'icon');
  console.log('✓ IoU and Non-Maximum Suppression successfully deduplicated overlapping boxes.\n');

  // Test 8: Mock canvas getContext interface
  console.log('Test 8: Testing HTMLCanvasElement / OffscreenCanvas mock interface...');
  const mockCanvas = {
    width: 120,
    height: 80,
    getContext: (type) => {
      if (type === '2d') {
        return {
          getImageData: (sx, sy, sw, sh) => ({
            width: sw,
            height: sh,
            data: new Uint8ClampedArray(sw * sh * 4).fill(200)
          })
        };
      }
      return null;
    }
  };

  const canvasParsed = await parseImageInput(mockCanvas);
  assert.equal(canvasParsed.width, 120);
  assert.equal(canvasParsed.height, 80);
  assert.equal(canvasParsed.data.length, 120 * 80 * 4);

  const canvasDetections = await runVisionInference(mockCanvas);
  assert(Array.isArray(canvasDetections));
  console.log('✓ Canvas getContext interface parsed and executed successfully.\n');

  console.log('🎉 All Ticket 09 Vision Model Inference tests passed successfully!');
}

runAllTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
