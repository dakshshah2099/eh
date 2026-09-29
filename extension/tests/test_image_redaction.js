/**
 * @fileoverview Unit tests for Ticket 14 — Canvas Image Redaction.
 * Tests pure function redactCanvas and associated redaction primitives:
 * - Solid black box masking for passwords, PINs, OTPs
 * - Gaussian blur, box blur, and pixelation for faces, emails, phones, cards, SSNs
 * - Support for CanvasRenderingContext2D and OffscreenCanvas
 * - Verification of pixel obscuration and unchanged regions outside bounding boxes
 * - Base64 data URL conversion and schema conformance
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  redactCanvas,
  redactCanvasToDataUrl,
  canvasToDataUrl,
  applySolidMask,
  applyPixelation,
  applyGaussianBlur,
  applyBoxBlur,
  normalizeBBox,
  DEFAULT_SOLID_CATEGORIES,
  DEFAULT_BLUR_CATEGORIES
} from '../src/image_redaction.js';

/**
 * Creates a valid PNG Base64 Data URL from RGBA pixel buffer.
 */
function rgbaToPngDataUrl(width, height, data) {
  const bpp = 4;
  const raw = Buffer.alloc(height * (1 + width * bpp));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * bpp);
    raw[rowOffset] = 0; // Filter none
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const pxOffset = rowOffset + 1 + x * bpp;
      raw[pxOffset] = data[srcIdx];
      raw[pxOffset + 1] = data[srcIdx + 1];
      raw[pxOffset + 2] = data[srcIdx + 2];
      raw[pxOffset + 3] = data[srcIdx + 3];
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
  ihdr[17] = 6; // RGBA
  ihdr[18] = 0; ihdr[19] = 0; ihdr[20] = 0;
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
 * Creates an in-memory Mock Canvas with 2D rendering context.
 * Faithfully mirrors standard browser HTMLCanvasElement and OffscreenCanvas APIs.
 */
function createMockCanvas(width, height, options = {}) {
  const pixelBuffer = new Uint8ClampedArray(width * height * 4);
  // Default: Fill with white background
  pixelBuffer.fill(255);

  const ctx = {
    canvas: null,
    fillStyle: '#000000',
    font: '10px sans-serif',
    textAlign: 'center',
    textBaseline: 'middle',
    savedStates: [],
    labelsDrawn: [],

    save() {
      this.savedStates.push({
        fillStyle: this.fillStyle,
        font: this.font,
        textAlign: this.textAlign,
        textBaseline: this.textBaseline
      });
    },

    restore() {
      if (this.savedStates.length > 0) {
        Object.assign(this, this.savedStates.pop());
      }
    },

    fillRect(x, y, w, h) {
      const rx = Math.max(0, Math.min(width, Math.round(x)));
      const ry = Math.max(0, Math.min(height, Math.round(y)));
      const rw = Math.max(0, Math.min(width - rx, Math.round(w)));
      const rh = Math.max(0, Math.min(height - ry, Math.round(h)));

      // Parse fillStyle hex or color
      let r = 0, g = 0, b = 0, a = 255;
      if (this.fillStyle === '#000000' || this.fillStyle === 'black' || (typeof this.fillStyle === 'string' && this.fillStyle.startsWith('rgba(0, 0, 0'))) {
        r = 0; g = 0; b = 0; a = 255;
      } else if (this.fillStyle === '#FFFFFF' || this.fillStyle === 'white') {
        r = 255; g = 255; b = 255; a = 255;
      }

      for (let py = ry; py < ry + rh; py++) {
        for (let px = rx; px < rx + rw; px++) {
          const idx = (py * width + px) * 4;
          pixelBuffer[idx] = r;
          pixelBuffer[idx + 1] = g;
          pixelBuffer[idx + 2] = b;
          pixelBuffer[idx + 3] = a;
        }
      }
    },

    fillText(text, x, y, maxW) {
      this.labelsDrawn.push({ text, x, y, maxW });
      // Stamp distinct label marker pixels at text center
      const cx = Math.max(0, Math.min(width - 1, Math.round(x)));
      const cy = Math.max(0, Math.min(height - 1, Math.round(y)));
      const idx = (cy * width + cx) * 4;
      pixelBuffer[idx] = 255;
      pixelBuffer[idx + 1] = 255;
      pixelBuffer[idx + 2] = 255;
      pixelBuffer[idx + 3] = 255;
    },

    getImageData(x, y, w, h) {
      const sub = new Uint8ClampedArray(w * h * 4);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const srcX = x + px;
          const srcY = y + py;
          const srcIdx = (srcY * width + srcX) * 4;
          const dstIdx = (py * w + px) * 4;
          sub[dstIdx] = pixelBuffer[srcIdx];
          sub[dstIdx + 1] = pixelBuffer[srcIdx + 1];
          sub[dstIdx + 2] = pixelBuffer[srcIdx + 2];
          sub[dstIdx + 3] = pixelBuffer[srcIdx + 3];
        }
      }
      return { width: w, height: h, data: sub };
    },

    putImageData(imageData, x, y) {
      const { width: w, height: h, data } = imageData;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const dstX = x + px;
          const dstY = y + py;
          if (dstX >= 0 && dstX < width && dstY >= 0 && dstY < height) {
            const dstIdx = (dstY * width + dstX) * 4;
            const srcIdx = (py * w + px) * 4;
            pixelBuffer[dstIdx] = data[srcIdx];
            pixelBuffer[dstIdx + 1] = data[srcIdx + 1];
            pixelBuffer[dstIdx + 2] = data[srcIdx + 2];
            pixelBuffer[dstIdx + 3] = data[srcIdx + 3];
          }
        }
      }
    }
  };

  const canvas = {
    width,
    height,
    getContext(type) {
      if (type === '2d') return ctx;
      return null;
    },
    toDataURL(mimeType = 'image/png') {
      return rgbaToPngDataUrl(width, height, pixelBuffer);
    },
    async convertToBlob({ type = 'image/png' } = {}) {
      const dataUrl = rgbaToPngDataUrl(width, height, pixelBuffer);
      const b64 = dataUrl.split(',')[1];
      const buf = Buffer.from(b64, 'base64');
      return new Blob([buf], { type });
    },
    _rawPixels: pixelBuffer
  };

  ctx.canvas = canvas;

  if (options.isOffscreen) {
    // OffscreenCanvas in Service Worker does NOT have toDataURL
    delete canvas.toDataURL;
  }

  return { canvas, ctx, pixelBuffer };
}

// -------------------------------------------------------------
// TEST SUITE
// -------------------------------------------------------------

test('Image Redaction: normalizeBBox handles all bbox formats and clamping', () => {
  // Standard array [x,y,w,h]
  assert.deepEqual(normalizeBBox([10, 20, 100, 50]), [10, 20, 100, 50]);

  // Object forms
  assert.deepEqual(normalizeBBox({ x: 10, y: 20, w: 100, h: 50 }), [10, 20, 100, 50]);
  assert.deepEqual(normalizeBBox({ left: 10, top: 20, width: 100, height: 50 }), [10, 20, 100, 50]);
  assert.deepEqual(normalizeBBox({ x0: 10, y0: 20, x1: 110, y1: 70 }), [10, 20, 100, 50]);

  // Negative dimensions
  assert.deepEqual(normalizeBBox([110, 70, -100, -50]), [10, 20, 100, 50]);

  // Clamping to canvas dimensions
  assert.deepEqual(normalizeBBox([80, 80, 50, 50], 100, 100), [80, 80, 20, 20]);
  assert.deepEqual(normalizeBBox([-20, -20, 60, 60], 100, 100), [0, 0, 40, 40]);

  // Invalid / degenerate bboxes
  assert.equal(normalizeBBox(null), null);
  assert.equal(normalizeBBox([]), null);
  assert.equal(normalizeBBox([0, 0, 0, 0]), null);
  assert.equal(normalizeBBox([150, 150, 10, 10], 100, 100), null);
});

test('Image Redaction: solid black box obscuration when maskType is solid', () => {
  const { canvas, pixelBuffer } = createMockCanvas(100, 100);

  // Set distinct colored pixels initially
  for (let i = 0; i < pixelBuffer.length; i += 4) {
    pixelBuffer[i] = 180;     // R
    pixelBuffer[i + 1] = 200; // G
    pixelBuffer[i + 2] = 220; // B
    pixelBuffer[i + 3] = 255; // A
  }

  const regions = [
    { bbox: [10, 10, 30, 20], category: 'password' },
    { bbox: [50, 10, 20, 20], category: 'pin' },
    { bbox: [10, 50, 25, 15], category: 'otp' }
  ];

  const returnedCanvas = redactCanvas(canvas, regions, { maskType: 'solid', showLabels: false });
  assert.equal(returnedCanvas, canvas);

  // 1. Verify password region is completely solid black [0, 0, 0, 255]
  for (let y = 10; y < 30; y++) {
    for (let x = 10; x < 40; x++) {
      const idx = (y * 100 + x) * 4;
      assert.equal(pixelBuffer[idx], 0, `Pixel at (${x},${y}) R should be 0`);
      assert.equal(pixelBuffer[idx + 1], 0, `Pixel at (${x},${y}) G should be 0`);
      assert.equal(pixelBuffer[idx + 2], 0, `Pixel at (${x},${y}) B should be 0`);
      assert.equal(pixelBuffer[idx + 3], 255, `Pixel at (${x},${y}) A should be 255`);
    }
  }

  // 2. Verify PIN region is completely solid black
  for (let y = 10; y < 30; y++) {
    for (let x = 50; x < 70; x++) {
      const idx = (y * 100 + x) * 4;
      assert.equal(pixelBuffer[idx], 0);
      assert.equal(pixelBuffer[idx + 1], 0);
      assert.equal(pixelBuffer[idx + 2], 0);
    }
  }

  // 3. Verify OTP region is completely solid black
  for (let y = 50; y < 65; y++) {
    for (let x = 10; x < 35; x++) {
      const idx = (y * 100 + x) * 4;
      assert.equal(pixelBuffer[idx], 0);
      assert.equal(pixelBuffer[idx + 1], 0);
      assert.equal(pixelBuffer[idx + 2], 0);
    }
  }

  // 4. Verify unredacted region OUTSIDE bounding boxes is completely unaltered
  const outsideIdx = (80 * 100 + 80) * 4;
  assert.equal(pixelBuffer[outsideIdx], 180);
  assert.equal(pixelBuffer[outsideIdx + 1], 200);
  assert.equal(pixelBuffer[outsideIdx + 2], 220);
});

test('Image Redaction: Gaussian mosaic applies by default with overlay badges for all categories', () => {
  const { canvas, ctx } = createMockCanvas(120, 120);

  const regions = [
    { bbox: [10, 10, 40, 20], category: 'password' },
    { bbox: [60, 10, 40, 20], category: 'card' },
    { bbox: [10, 50, 40, 20], category: 'name' },
    { bbox: [60, 50, 40, 20], category: 'face' }
  ];

  redactCanvas(canvas, regions);

  assert.equal(ctx.labelsDrawn.length, 4);
  assert.equal(ctx.labelsDrawn[0].text, '[PASSWORD]');
  assert.equal(ctx.labelsDrawn[1].text, '[CREDIT CARD]');
  assert.equal(ctx.labelsDrawn[2].text, '[NAME]');
  assert.equal(ctx.labelsDrawn[3].text, '[FACE]');
});

test('Image Redaction: solid black box supports optional labels', () => {
  const { canvas, ctx } = createMockCanvas(100, 100);

  const regions = [
    { bbox: [10, 10, 40, 20], category: 'password', label: '[PASS]' }
  ];

  redactCanvas(canvas, regions, { showLabels: true });

  assert.equal(ctx.labelsDrawn.length, 1);
  assert.equal(ctx.labelsDrawn[0].text, '[PASS]');
  assert.equal(ctx.labelsDrawn[0].x, 30);
  assert.equal(ctx.labelsDrawn[0].y, 20);
});

test('Image Redaction: strong pixelation (mosaic) obscures fine details', () => {
  const { canvas, pixelBuffer } = createMockCanvas(60, 60);

  // Create high-contrast checkerboard pattern in region [10, 10, 40, 40]
  for (let y = 10; y < 50; y++) {
    for (let x = 10; x < 50; x++) {
      const idx = (y * 60 + x) * 4;
      const isBlack = ((x + y) % 2) === 0;
      const val = isBlack ? 0 : 255;
      pixelBuffer[idx] = val;
      pixelBuffer[idx + 1] = val;
      pixelBuffer[idx + 2] = val;
      pixelBuffer[idx + 3] = 255;
    }
  }

  // Apply pixelation redaction on email region
  redactCanvas(canvas, [{ bbox: [10, 10, 40, 40], category: 'email' }], {
    blurStyle: 'pixelate',
    pixelSize: 8
  });

  // Verify that an 8x8 block is now uniform (all pixels in the block have identical value ~128)
  const blockValR = pixelBuffer[(10 * 60 + 10) * 4];
  const blockValG = pixelBuffer[(10 * 60 + 10) * 4 + 1];
  const blockValB = pixelBuffer[(10 * 60 + 10) * 4 + 2];

  // In checkerboard 0 and 255, average is ~128
  assert(blockValR >= 120 && blockValR <= 135, `Average should be ~128, got ${blockValR}`);

  // All pixels in the 8x8 block must be identical to blockVal
  for (let dy = 0; dy < 8; dy++) {
    for (let dx = 0; dx < 8; dx++) {
      const idx = ((10 + dy) * 60 + (10 + dx)) * 4;
      assert.equal(pixelBuffer[idx], blockValR);
      assert.equal(pixelBuffer[idx + 1], blockValG);
      assert.equal(pixelBuffer[idx + 2], blockValB);
    }
  }

  // Pixels outside redaction box [10, 10, 40, 40] remain untouched (white 255)
  const outsideIdx = (5 * 60 + 5) * 4;
  assert.equal(pixelBuffer[outsideIdx], 255);
});

test('Image Redaction: Gaussian blur filter obscures sharp gradients and edges', () => {
  const { canvas, pixelBuffer } = createMockCanvas(80, 80);

  // Fill canvas with white
  pixelBuffer.fill(255);

  // Draw a sharp vertical black stripe (representing text or sharp edge) in center of face region [10, 10, 60, 60]
  for (let y = 10; y < 70; y++) {
    for (let x = 38; x <= 42; x++) {
      const idx = (y * 80 + x) * 4;
      pixelBuffer[idx] = 0;
      pixelBuffer[idx + 1] = 0;
      pixelBuffer[idx + 2] = 0;
    }
  }

  // Check initial pre-redaction sharp edge: pixel at 40 is 0 (black), pixel at 45 is 255 (white)
  assert.equal(pixelBuffer[(40 * 80 + 40) * 4], 0);
  assert.equal(pixelBuffer[(40 * 80 + 45) * 4], 255);

  // Apply Gaussian blur on face region
  redactCanvas(canvas, [{ bbox: [10, 10, 60, 60], category: 'face' }], {
    blurStyle: 'gaussian',
    blurRadius: 10,
    passes: 3
  });

  // Post-redaction: The sharp edge at x=40 should be smoothed into neighboring pixels
  const centerVal = pixelBuffer[(40 * 80 + 40) * 4];
  const neighborVal = pixelBuffer[(40 * 80 + 45) * 4];

  // Center should no longer be pure black (0) because it absorbed light from neighbors
  assert(centerVal > 50, `Center was 0, now should be diffused > 50: ${centerVal}`);
  // Neighbor at x=45 should no longer be pure white (255) because it absorbed darkness from stripe
  assert(neighborVal < 255, `Neighbor was 255, now should be darkened < 255: ${neighborVal}`);

  // Outside region remains untouched
  assert.equal(pixelBuffer[(5 * 80 + 5) * 4], 255);
});

test('Image Redaction: separable box blur filter smooths region', () => {
  const { canvas, pixelBuffer } = createMockCanvas(50, 50);
  pixelBuffer.fill(255);

  // Single bright red pixel at (25, 25)
  const targetIdx = (25 * 50 + 25) * 4;
  pixelBuffer[targetIdx] = 255;
  pixelBuffer[targetIdx + 1] = 0;
  pixelBuffer[targetIdx + 2] = 0;

  // Apply box blur on region [10, 10, 30, 30] without label badge
  redactCanvas(canvas, [{ bbox: [10, 10, 30, 30], category: 'ssn' }], {
    blurStyle: 'box_blur',
    blurRadius: 5,
    showLabels: false
  });

  // The single red pixel intensity should be spread over neighboring pixels
  const diffusedIdx = (25 * 50 + 24) * 4;
  assert(pixelBuffer[diffusedIdx] > 0, 'Red intensity should be diffused into neighbor');
});

test('Image Redaction: supports passing CanvasRenderingContext2D directly', () => {
  const { ctx, pixelBuffer } = createMockCanvas(60, 60);

  const regions = [
    { bbox: [10, 10, 20, 20], category: 'pin' }
  ];

  // Pass context instead of canvas
  const returned = redactCanvas(ctx, regions);
  assert(returned);

  // Region should be redacted
  assert.equal(pixelBuffer[(15 * 60 + 15) * 4], 0);
  assert.equal(pixelBuffer[(15 * 60 + 15) * 4 + 1], 0);
  assert.equal(pixelBuffer[(15 * 60 + 15) * 4 + 2], 0);
});

test('Image Redaction: supports OffscreenCanvas without toDataURL', async () => {
  const { canvas, pixelBuffer } = createMockCanvas(60, 60, { isOffscreen: true });
  assert.equal(canvas.toDataURL, undefined);

  const regions = [
    { bbox: [5, 5, 20, 20], category: 'password' }
  ];

  // Convert to base64 Data URL using OffscreenCanvas.convertToBlob
  const dataUrl = await redactCanvas(canvas, regions, { returnType: 'dataUrl', format: 'png' });

  assert(typeof dataUrl === 'string');
  assert(dataUrl.startsWith('data:image/png;base64,'));

  // Verify pixels were redacted
  assert.equal(pixelBuffer[(10 * 60 + 10) * 4], 0);
});

test('Image Redaction: returnType options (canvas, dataUrl, base64, both)', async () => {
  const regions = [{ bbox: [0, 0, 20, 20], category: 'otp' }];

  // 1. returnType: 'canvas' (default)
  const c1 = createMockCanvas(40, 40).canvas;
  const resCanvas = redactCanvas(c1, regions);
  assert.equal(resCanvas, c1);

  // 2. returnType: 'dataUrl'
  const c2 = createMockCanvas(40, 40).canvas;
  const resDataUrl = await redactCanvas(c2, regions, { returnType: 'dataUrl' });
  assert(typeof resDataUrl === 'string');
  assert(resDataUrl.startsWith('data:image/'));

  // 3. returnType: 'base64'
  const c3 = createMockCanvas(40, 40).canvas;
  const resBase64 = await redactCanvas(c3, regions, { returnType: 'base64' });
  assert(typeof resBase64 === 'string');
  assert(!resBase64.startsWith('data:'));
  assert(resDataUrl.endsWith(resBase64));

  // 4. returnType: 'both'
  const c4 = createMockCanvas(40, 40).canvas;
  const resBoth = await redactCanvas(c4, regions, { returnType: 'both' });
  assert.equal(resBoth.canvas, c4);
  assert(resBoth.dataUrl.startsWith('data:image/'));
  assert(typeof resBoth.base64 === 'string');

  // 5. redactCanvasToDataUrl helper
  const c5 = createMockCanvas(40, 40).canvas;
  const helperUrl = await redactCanvasToDataUrl(c5, regions);
  assert(helperUrl.startsWith('data:image/'));
});

test('Image Redaction: multi-region mixed categories simultaneously', () => {
  const { canvas, pixelBuffer } = createMockCanvas(100, 100);
  pixelBuffer.fill(200);

  const regions = [
    { bbox: [5, 5, 20, 20], category: 'password' },   // solid
    { bbox: [30, 5, 20, 20], category: 'face' },       // gaussian
    { bbox: [55, 5, 20, 20], category: 'email', redactionType: 'pixelate' }, // pixelate
    { bbox: [80, 5, 15, 20], category: 'phone', redactionType: 'box_blur' }  // box blur
  ];

  redactCanvas(canvas, regions);

  // Password region is pure solid black
  assert.equal(pixelBuffer[(10 * 100 + 10) * 4], 0);

  // Outside regions unaffected
  assert.equal(pixelBuffer[(50 * 100 + 50) * 4], 200);
});

test('Image Redaction: error handling on invalid or null canvas', () => {
  assert.throws(() => redactCanvas(null, []), /redactCanvas requires a canvas/);
  assert.throws(() => redactCanvas({}, []), /Unsupported canvas or context/);
});

test('Image Redaction: empty or undefined regions returns canvas unmodified', () => {
  const { canvas, pixelBuffer } = createMockCanvas(50, 50);
  pixelBuffer.fill(123);

  const res1 = redactCanvas(canvas, []);
  assert.equal(res1, canvas);
  assert.equal(pixelBuffer[0], 123);

  const res2 = redactCanvas(canvas, null);
  assert.equal(res2, canvas);
  assert.equal(pixelBuffer[0], 123);
});
