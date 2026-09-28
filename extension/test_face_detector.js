/**
 * Test Verification Suite for Ticket 11: CV-Level Face Detector.
 * 
 * Verifies:
 * 1. BlazeFace ONNX model exists and meets <5MB size constraint
 * 2. WebGPU detection and WASM fallback logic
 * 3. loadFaceModel() loads session with correct inputs/outputs into memory
 * 4. Image preprocessing produces valid CHW normalized [1, 3, 128, 128] tensor
 * 5. Face detection on synthetic canvas / ImageData with face geometry:
 *    - Schema: [{ bbox: [x,y,w,h], category: 'face', source: 'cv', confidence: float }]
 * 6. Face detection on Base64 encoded face image
 * 7. IoU calculation and Non-Maximum Suppression (NMS) deduplication
 * 8. Non-face negative test (blank / geometric shapes without skin/features)
 * 9. Offscreen message listener integration for LOAD_FACE_MODEL and RUN_FACE_DETECTION
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  MAX_FACE_MODEL_SIZE_BYTES,
  DEFAULT_FACE_MODEL_DIMS,
  detectBackend,
  loadFaceModel,
  getFaceSession,
  resetFaceSession,
  parseImageInput,
  preprocessFaceImage,
  calculateIoU,
  nonMaxSuppression,
  extractFacialProposals,
  detectFaces
} from './face_detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates a PNG base64 string for testing.
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

/**
 * Creates synthetic face ImageData canvas.
 * Draws skin-tone oval face with eyes, eyebrows, nose, and mouth.
 */
function createSyntheticFaceImage(width = 240, height = 240, faceCenter = { x: 120, y: 120 }, faceRadius = { rx: 50, ry: 65 }) {
  const data = new Uint8ClampedArray(width * height * 4);
  // Neutral background (light gray)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 230;
    data[i + 1] = 230;
    data[i + 2] = 230;
    data[i + 3] = 255;
  }

  const { x: fcx, y: fcy } = faceCenter;
  const { rx, ry } = faceRadius;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - fcx) / rx;
      const dy = (y - fcy) / ry;
      const distSq = dx * dx + dy * dy;

      if (distSq <= 1.0) {
        const idx = (y * width + x) * 4;
        // Warm skin tone: R=220, G=165, B=130
        data[idx] = 220;
        data[idx + 1] = 165;
        data[idx + 2] = 130;
        data[idx + 3] = 255;

        // Left Eye: around (fcx - 20, fcy - 15)
        const dEyeL = Math.hypot(x - (fcx - 20), y - (fcy - 15));
        if (dEyeL <= 6) {
          data[idx] = 40; data[idx + 1] = 30; data[idx + 2] = 25; // Dark brown/black
        }

        // Right Eye: around (fcx + 20, fcy - 15)
        const dEyeR = Math.hypot(x - (fcx + 20), y - (fcy - 15));
        if (dEyeR <= 6) {
          data[idx] = 40; data[idx + 1] = 30; data[idx + 2] = 25;
        }

        // Eyebrows
        if (Math.abs(y - (fcy - 26)) <= 2) {
          if ((x >= fcx - 28 && x <= fcx - 12) || (x >= fcx + 12 && x <= fcx + 28)) {
            data[idx] = 35; data[idx + 1] = 25; data[idx + 2] = 20;
          }
        }

        // Nose bridge / tip
        if (Math.abs(x - fcx) <= 3 && y >= fcy && y <= fcy + 12) {
          data[idx] = 190; data[idx + 1] = 135; data[idx + 2] = 105;
        }

        // Mouth / lips: around (fcx, fcy + 30)
        if (Math.abs(x - fcx) <= 18 && Math.abs(y - (fcy + 30)) <= 4) {
          data[idx] = 170; data[idx + 1] = 70; data[idx + 2] = 65; // Reddish lips
        }
      }
    }
  }

  return { width, height, data };
}

async function runAllTests() {
  console.log('--- Running Ticket 11 CV-Level Face Detector Tests ---\n');

  // Test 1: Model file verification & <5MB constraint
  console.log('Test 1: Verifying BlazeFace ONNX model bundle & size constraint...');
  const modelPath = path.join(__dirname, 'models/blazeface.onnx');
  assert(fs.existsSync(modelPath), `Face model file must exist at ${modelPath}`);

  const stat = fs.statSync(modelPath);
  const sizeMB = stat.size / 1024 / 1024;
  console.log(`  Model file size: ${(stat.size / 1024).toFixed(2)} KB (${sizeMB.toFixed(3)} MB)`);
  assert(stat.size < MAX_FACE_MODEL_SIZE_BYTES, `Face model size must be < 5MB (actual: ${sizeMB.toFixed(3)} MB)`);
  console.log('✓ Model bundle exists and is strictly under 5MB limit.\n');

  // Test 2: WebGPU detection and WASM fallback
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
  console.log('Test 3: Loading BlazeFace model session into memory...');
  resetFaceSession();
  assert.equal(getFaceSession(), null);

  const sessionMeta = await loadFaceModel({ backend: 'wasm' });
  assert(sessionMeta.session, 'Session must be created');
  assert.equal(sessionMeta.backend, 'wasm');
  assert(sessionMeta.modelSize > 0 && sessionMeta.modelSize < MAX_FACE_MODEL_SIZE_BYTES);
  assert(sessionMeta.inputNames.includes('images'));
  assert(sessionMeta.outputNames.includes('boxes'));
  assert(sessionMeta.outputNames.includes('scores'));
  assert.equal(getFaceSession(), sessionMeta);
  console.log(`✓ Face model loaded successfully (input: ${sessionMeta.inputNames}, outputs: ${sessionMeta.outputNames}).\n`);

  // Test 4: Image preprocessing & tensor shapes
  console.log('Test 4: Verifying face image preprocessing into CHW tensor...');
  const testImg = {
    width: 200,
    height: 200,
    data: new Uint8ClampedArray(200 * 200 * 4).fill(128)
  };

  const preprocessed = await preprocessFaceImage(testImg, DEFAULT_FACE_MODEL_DIMS.width, DEFAULT_FACE_MODEL_DIMS.height);
  assert(preprocessed.inputTensor, 'Must produce inputTensor');
  assert.deepEqual(preprocessed.inputTensor.dims, [1, 3, 128, 128], 'Dims must match [1, 3, 128, 128]');
  assert.equal(preprocessed.inputTensor.type, 'float32', 'Type must be float32');
  assert.equal(preprocessed.origWidth, 200);
  assert.equal(preprocessed.origHeight, 200);

  const sampleVal = preprocessed.inputTensor.data[0];
  assert(sampleVal >= 0.0 && sampleVal <= 1.0, `Tensor value ${sampleVal} must be normalized [0, 1]`);
  console.log('✓ Face image preprocessing correctly generates planar normalized [1, 3, 128, 128] tensor.\n');

  // Test 5: Face detection on synthetic Canvas / ImageData
  console.log('Test 5: Detecting human face on synthetic Canvas / ImageData...');
  const faceImg = createSyntheticFaceImage(240, 240, { x: 120, y: 120 }, { rx: 45, ry: 60 });
  const detections = await detectFaces(faceImg, { confidenceThreshold: 0.25 });

  assert(Array.isArray(detections), 'Must return an array');
  assert(detections.length > 0, 'Must detect the face region');

  for (const det of detections) {
    // Check required schema: [{ bbox: [x,y,w,h], category: 'face', source: 'cv', confidence: float }]
    assert(Array.isArray(det.bbox) && det.bbox.length === 4, 'BBox must be array [x,y,w,h]');
    const [x, y, w, h] = det.bbox;
    assert(Number.isInteger(x) && x >= 0 && x < 240, `Invalid x coordinate: ${x}`);
    assert(Number.isInteger(y) && y >= 0 && y < 240, `Invalid y coordinate: ${y}`);
    assert(Number.isInteger(w) && w > 0 && w <= 240, `Invalid width: ${w}`);
    assert(Number.isInteger(h) && h > 0 && h <= 240, `Invalid height: ${h}`);

    assert.equal(det.category, 'face', `Category must be 'face' (got '${det.category}')`);
    assert.equal(det.source, 'cv', `Source must be 'cv' (got '${det.source}')`);
    assert(typeof det.confidence === 'number', 'Confidence must be a number');
    assert(det.confidence >= 0.0 && det.confidence <= 1.0, `Confidence ${det.confidence} must be between 0.0 and 1.0`);
  }

  console.log(`  Found ${detections.length} face detection(s):`);
  console.log('  Detection payload:', detections[0]);

  // Check face bounding box contains the synthetic face center (120, 120)
  const faceDet = detections[0];
  const [fx, fy, fw, fh] = faceDet.bbox;
  assert(120 >= fx && 120 <= fx + fw, 'Face bounding box must enclose horizontal center');
  assert(120 >= fy && 120 <= fy + fh, 'Face bounding box must enclose vertical center');
  console.log('✓ Face detected on canvas with exact schema [{ bbox, category, source, confidence }].\n');

  // Test 6: Face detection on Base64 image
  console.log('Test 6: Detecting human face on Base64 PNG image...');
  const base64Face = createTestPngBase64(160, 160, (x, y) => {
    // Skin oval around (80, 80)
    const dx = (x - 80) / 35;
    const dy = (y - 80) / 45;
    if (dx * dx + dy * dy <= 1.0) {
      // Eyes at (65, 70) and (95, 70)
      if (Math.hypot(x - 65, y - 70) <= 4 || Math.hypot(x - 95, y - 70) <= 4) {
        return [30, 20, 20, 255];
      }
      // Mouth at (80, 105)
      if (Math.abs(x - 80) <= 12 && Math.abs(y - 105) <= 3) {
        return [180, 60, 60, 255];
      }
      return [225, 170, 135, 255]; // Skin
    }
    return [240, 240, 240, 255]; // Background
  });

  const b64Detections = await detectFaces(base64Face, { confidenceThreshold: 0.25 });
  assert(Array.isArray(b64Detections) && b64Detections.length > 0, 'Base64 image must produce face detection');

  const b64FaceDet = b64Detections[0];
  assert.equal(b64FaceDet.category, 'face');
  assert.equal(b64FaceDet.source, 'cv');
  assert(b64FaceDet.confidence >= 0.0 && b64FaceDet.confidence <= 1.0);
  console.log(`  Base64 face detection:`, b64FaceDet);
  console.log('✓ Base64 face image detection operated cleanly.\n');

  // Test 7: Non-Maximum Suppression (NMS) & IoU
  console.log('Test 7: Testing IoU and Non-Maximum Suppression (NMS) for faces...');
  const iouDisjoint = calculateIoU([0, 0, 50, 50], [100, 100, 50, 50]);
  assert.equal(iouDisjoint, 0.0);

  const iouIdentical = calculateIoU([30, 30, 60, 80], [30, 30, 60, 80]);
  assert.equal(iouIdentical, 1.0);

  const faceOverlaps = [
    { bbox: [60, 50, 80, 100], category: 'face', source: 'cv', confidence: 0.94 },
    { bbox: [62, 52, 78, 98], category: 'face', source: 'cv', confidence: 0.88 },
    { bbox: [59, 49, 82, 102], category: 'face', source: 'cv', confidence: 0.72 }
  ];

  const nmsFaces = nonMaxSuppression(faceOverlaps, 0.35);
  assert.equal(nmsFaces.length, 1, 'Should suppress overlapping boxes down to 1');
  assert.equal(nmsFaces[0].confidence, 0.94, 'Should preserve highest confidence box');
  console.log('✓ NMS deduplication successfully preserved highest confidence face candidate.\n');

  // Test 8: Negative test - image with no faces
  console.log('Test 8: Negative test on non-face image (pure blue/gray geometry)...');
  const blankImg = {
    width: 160,
    height: 160,
    data: new Uint8ClampedArray(160 * 160 * 4)
  };
  // Draw blue rectangle (non-skin)
  for (let i = 0; i < blankImg.data.length; i += 4) {
    blankImg.data[i] = 30;
    blankImg.data[i + 1] = 60;
    blankImg.data[i + 2] = 200;
    blankImg.data[i + 3] = 255;
  }
  const proposals = extractFacialProposals(blankImg);
  assert.equal(proposals.length, 0, 'Non-skin image must produce zero facial proposals');
  console.log('✓ Non-face image produces 0 facial proposals.\n');

  // Test 9: Offscreen document message handling
  console.log('Test 9: Verifying offscreen message handling integration...');
  const offscreen = await import('./offscreen.js');
  assert(offscreen, 'offscreen.js must be importable');
  assert(typeof offscreen.detectFaces === 'function', 'offscreen must export detectFaces');
  assert(typeof offscreen.loadFaceModel === 'function', 'offscreen must export loadFaceModel');

  const offscreenDetections = await offscreen.detectFaces(faceImg, { confidenceThreshold: 0.25 });
  assert(Array.isArray(offscreenDetections) && offscreenDetections.length > 0);
  assert.equal(offscreenDetections[0].category, 'face');
  assert.equal(offscreenDetections[0].source, 'cv');
  console.log('✓ Offscreen integration successfully executed detectFaces.\n');

  console.log('🎉 All Ticket 11 CV-Level Face Detector tests passed successfully!');
}

runAllTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
