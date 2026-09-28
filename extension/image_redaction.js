/**
 * @fileoverview Canvas Image Redaction utility for Privacy Lens Agent.
 * Ticket 14 — Pure function to redact sensitive regions on an image canvas.
 *
 * Supported features:
 * - Solid black box redaction (ctx.fillRect) for passwords, PINs, and OTPs, with optional labels.
 * - Strong Gaussian blur filter, separable box blur, and pixelation (mosaic) for faces, emails,
 *   phone numbers, card numbers, SSNs, and other sensitive PII.
 * - Supports both browser CanvasRenderingContext2D and OffscreenCanvas.
 * - Configurable output formats: mutated canvas, base64 Data URL, or raw base64 string.
 */

import { blobToBase64 } from './downscale.js';

/**
 * Sensitive categories that require solid black box redaction by default.
 * These represent authentication credentials and high-risk secrets.
 */
export const DEFAULT_SOLID_CATEGORIES = new Set(['password', 'pin', 'otp']);

/**
 * Standard categories that use Gaussian blur or pixelation.
 */
export const DEFAULT_BLUR_CATEGORIES = new Set([
  'face',
  'email',
  'phone',
  'card',
  'ssn',
  'tax'
]);

/**
 * Normalizes bounding box representation to integer [x, y, w, h] clamped to canvas bounds.
 * Accepts [x, y, w, h] array or objects with {x, y, w, h}, {x, y, width, height},
 * {left, top, width, height}, or {x0, y0, x1, y1}.
 *
 * @param {Array<number>|object} bbox
 * @param {number} [canvasWidth]
 * @param {number} [canvasHeight]
 * @returns {[number, number, number, number]|null} [x, y, w, h] or null if invalid
 */
export function normalizeBBox(bbox, canvasWidth, canvasHeight) {
  if (!bbox) return null;

  let x = NaN;
  let y = NaN;
  let w = NaN;
  let h = NaN;

  if (Array.isArray(bbox) && bbox.length >= 4) {
    x = Math.round(Number(bbox[0]));
    y = Math.round(Number(bbox[1]));
    w = Math.round(Number(bbox[2]));
    h = Math.round(Number(bbox[3]));
  } else if (typeof bbox === 'object') {
    x = Math.round(Number(bbox.x ?? bbox.left ?? bbox.x0));
    y = Math.round(Number(bbox.y ?? bbox.top ?? bbox.y0));
    w = Math.round(Number(bbox.w ?? bbox.width));
    h = Math.round(Number(bbox.h ?? bbox.height));

    if (Number.isNaN(w) && typeof bbox.x1 === 'number') {
      w = Math.round(bbox.x1 - x);
    }
    if (Number.isNaN(h) && typeof bbox.y1 === 'number') {
      h = Math.round(bbox.y1 - y);
    }
  }

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return null;
  }

  // Handle negative dimensions by normalizing top-left corner
  if (w < 0) {
    x += w;
    w = Math.abs(w);
  }
  if (h < 0) {
    y += h;
    h = Math.abs(h);
  }

  // Clamp to canvas boundaries if dimensions are provided
  if (typeof canvasWidth === 'number' && canvasWidth > 0) {
    const x0 = x;
    const x1 = Math.min(canvasWidth, x0 + w);
    x = Math.max(0, Math.min(canvasWidth, x0));
    w = Math.max(0, x1 - x);
  }
  if (typeof canvasHeight === 'number' && canvasHeight > 0) {
    const y0 = y;
    const y1 = Math.min(canvasHeight, y0 + h);
    y = Math.max(0, Math.min(canvasHeight, y0));
    h = Math.max(0, y1 - y);
  }

  if (w <= 0 || h <= 0) {
    return null;
  }

  return [x, y, w, h];
}

/**
 * Draws an optional text label inside or over a redacted region.
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {object} region
 * @param {object} options
 */
export function drawRedactionLabel(ctx, x, y, w, h, region = {}, options = {}) {
  if (w < 20 || h < 10) return;

  const category = (region.category || 'REDACTED').toUpperCase();
  const labelText = options.labelText || region.label || `[${category}]`;

  if (typeof ctx.save === 'function') ctx.save();

  const fontSize = Math.min(13, Math.max(9, Math.floor(h * 0.4)));
  if (ctx.font !== undefined) {
    ctx.font = options.labelFont || `bold ${fontSize}px sans-serif, monospace`;
  }
  if (ctx.textAlign !== undefined) ctx.textAlign = 'center';
  if (ctx.textBaseline !== undefined) ctx.textBaseline = 'middle';
  ctx.fillStyle = options.labelTextColor || '#FFFFFF';

  if (typeof ctx.fillText === 'function') {
    ctx.fillText(labelText, x + w / 2, y + h / 2, Math.max(10, w - 4));
  }

  if (typeof ctx.restore === 'function') ctx.restore();
}

/**
 * Draws a solid fill box over a sensitive region.
 * Used for passwords, PINs, and OTPs.
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {[number, number, number, number]} bbox - [x, y, w, h]
 * @param {object} [options={}]
 * @param {object} [region={}]
 */
export function applySolidMask(ctx, bbox, options = {}, region = {}) {
  const [x, y, w, h] = bbox;
  if (w <= 0 || h <= 0) return;

  if (typeof ctx.save === 'function') ctx.save();

  ctx.fillStyle = options.solidFillColor || '#000000';
  ctx.fillRect(x, y, w, h);

  const showLabel = options.showLabels === true ||
    region.showLabel === true ||
    (options.showLabels !== false && options.labelText !== undefined);

  if (showLabel) {
    drawRedactionLabel(ctx, x, y, w, h, region, options);
  }

  if (typeof ctx.restore === 'function') ctx.restore();
}

/**
 * Applies strong pixelation (mosaic filter) to a bounding box region.
 * Groups neighboring pixels into blocks and replaces each block with its average color.
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {[number, number, number, number]} bbox - [x, y, w, h]
 * @param {object} [options={}]
 */
export function applyPixelation(ctx, bbox, options = {}) {
  const [x, y, w, h] = bbox;
  if (w <= 0 || h <= 0 || typeof ctx.getImageData !== 'function' || typeof ctx.putImageData !== 'function') {
    return;
  }

  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;
  const blockSize = Math.max(
    2,
    options.pixelSize ?? options.blockSize ?? Math.max(4, Math.min(16, Math.floor(Math.min(w, h) / 4)))
  );

  for (let by = 0; by < h; by += blockSize) {
    const bh = Math.min(blockSize, h - by);
    for (let bx = 0; bx < w; bx += blockSize) {
      const bw = Math.min(blockSize, w - bx);
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      const count = bw * bh;

      for (let dy = 0; dy < bh; dy++) {
        const rowOffset = (by + dy) * w;
        for (let dx = 0; dx < bw; dx++) {
          const idx = (rowOffset + (bx + dx)) * 4;
          rSum += data[idx];
          gSum += data[idx + 1];
          bSum += data[idx + 2];
          aSum += data[idx + 3];
        }
      }

      const rAvg = Math.round(rSum / count);
      const gAvg = Math.round(gSum / count);
      const bAvg = Math.round(bSum / count);
      const aAvg = Math.round(aSum / count);

      for (let dy = 0; dy < bh; dy++) {
        const rowOffset = (by + dy) * w;
        for (let dx = 0; dx < bw; dx++) {
          const idx = (rowOffset + (bx + dx)) * 4;
          data[idx] = rAvg;
          data[idx + 1] = gAvg;
          data[idx + 2] = bAvg;
          data[idx + 3] = aAvg;
        }
      }
    }
  }

  ctx.putImageData(imageData, x, y);
}

/**
 * Internal 1D separable box blur with running sum.
 * Clamps out-of-boundary lookups to edge pixels.
 *
 * @param {Uint8ClampedArray} src
 * @param {Uint8ClampedArray} dst
 * @param {number} w
 * @param {number} h
 * @param {number} r - Blur radius
 * @param {boolean} horizontal
 */
function boxBlur1D(src, dst, w, h, r, horizontal) {
  const strideX = horizontal ? 1 : w;
  const strideY = horizontal ? w : 1;
  const length = horizontal ? w : h;
  const lineCount = horizontal ? h : w;
  const windowSize = 2 * r + 1;

  for (let l = 0; l < lineCount; l++) {
    const lineOffset = l * strideY * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) {
        const clampedIdx = Math.max(0, Math.min(length - 1, i));
        sum += src[lineOffset + clampedIdx * strideX * 4 + c];
      }

      for (let i = 0; i < length; i++) {
        dst[lineOffset + i * strideX * 4 + c] = Math.round(sum / windowSize);
        const leftIdx = Math.max(0, Math.min(length - 1, i - r));
        const rightIdx = Math.max(0, Math.min(length - 1, i + r + 1));
        sum += src[lineOffset + rightIdx * strideX * 4 + c] - src[lineOffset + leftIdx * strideX * 4 + c];
      }
    }
  }
}

/**
 * Applies a separable box blur to a bounding box region.
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {[number, number, number, number]} bbox - [x, y, w, h]
 * @param {object} [options={}]
 */
export function applyBoxBlur(ctx, bbox, options = {}) {
  const [x, y, w, h] = bbox;
  if (w <= 0 || h <= 0 || typeof ctx.getImageData !== 'function' || typeof ctx.putImageData !== 'function') {
    return;
  }

  const radius = Math.max(
    1,
    Math.min(
      Math.max(1, Math.floor(Math.min(w, h) / 2)),
      options.blurRadius ?? 10
    )
  );

  const imageData = ctx.getImageData(x, y, w, h);
  const src = imageData.data;
  const temp = new Uint8ClampedArray(src.length);
  const dst = new Uint8ClampedArray(src.length);

  boxBlur1D(src, temp, w, h, radius, true);
  boxBlur1D(temp, dst, w, h, radius, false);

  imageData.data.set(dst);
  ctx.putImageData(imageData, x, y);
}

/**
 * Applies a strong Gaussian blur to a bounding box region.
 * Uses a 3-pass separable box-blur which, by the Central Limit Theorem,
 * closely approximates a true Gaussian blur kernel with standard deviation
 * sigma ≈ sqrt((radius^2 + radius) / 3).
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {[number, number, number, number]} bbox - [x, y, w, h]
 * @param {object} [options={}]
 */
export function applyGaussianBlur(ctx, bbox, options = {}) {
  const [x, y, w, h] = bbox;
  if (w <= 0 || h <= 0 || typeof ctx.getImageData !== 'function' || typeof ctx.putImageData !== 'function') {
    return;
  }

  const radius = Math.max(
    1,
    Math.min(
      Math.max(1, Math.floor(Math.min(w, h) / 2)),
      options.blurRadius ?? 12
    )
  );

  const imageData = ctx.getImageData(x, y, w, h);
  let current = imageData.data;
  const passes = Math.max(1, Math.min(5, options.passes ?? 3));

  let bufA = new Uint8ClampedArray(current);
  let bufB = new Uint8ClampedArray(current.length);

  for (let p = 0; p < passes; p++) {
    boxBlur1D(bufA, bufB, w, h, radius, true);
    boxBlur1D(bufB, bufA, w, h, radius, false);
  }

  imageData.data.set(bufA);
  ctx.putImageData(imageData, x, y);
}

/**
 * Converts a canvas element (HTMLCanvasElement or OffscreenCanvas) to a base64 Data URL.
 * Works uniformly across browser Window, Service Worker, and test mocks.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|object} canvas
 * @param {object} [options={}]
 * @returns {Promise<string>|string} Base64 Data URL or Promise resolving to one
 */
export function canvasToDataUrl(canvas, options = {}) {
  const format = options?.format === 'png' ? 'png' : 'jpeg';
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = typeof options?.quality === 'number' ? options.quality : 0.85;

  // 1. Browser HTMLCanvasElement synchronous toDataURL
  if (typeof canvas.toDataURL === 'function') {
    const dataUrl = canvas.toDataURL(mimeType, quality);
    if (options.returnType === 'base64') {
      return dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    }
    return dataUrl;
  }

  // 2. OffscreenCanvas convertToBlob (asynchronous)
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mimeType, quality }).then((blob) => {
      return blobToBase64(blob).then((dataUrl) => {
        if (options.returnType === 'base64') {
          return dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        }
        return dataUrl;
      });
    });
  }

  // 3. Fallback for mock canvas or objects containing dataUrl
  if (canvas.dataUrl) {
    const dataUrl = canvas.dataUrl;
    if (options.returnType === 'base64') {
      return dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    }
    return dataUrl;
  }

  throw new Error('Unsupported canvas format: unable to convert to data URL');
}

/**
 * Resolves context and canvas handles from the provided input.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|CanvasRenderingContext2D|object} canvasOrContext
 * @returns {{ canvas: object, ctx: CanvasRenderingContext2D, width: number, height: number }}
 */
function resolveCanvasAndContext(canvasOrContext) {
  if (!canvasOrContext) {
    throw new Error('redactCanvas requires a canvas or 2D rendering context');
  }

  let canvas = null;
  let ctx = null;

  if (typeof canvasOrContext.getContext === 'function') {
    // Canvas element (HTMLCanvasElement or OffscreenCanvas)
    canvas = canvasOrContext;
    ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D rendering context from canvas');
    }
  } else if (canvasOrContext.canvas && typeof canvasOrContext.fillRect === 'function') {
    // 2D rendering context with .canvas property
    ctx = canvasOrContext;
    canvas = canvasOrContext.canvas;
  } else if (typeof canvasOrContext.fillRect === 'function') {
    // Mock context without .canvas
    ctx = canvasOrContext;
    canvas = canvasOrContext.canvas || {
      width: canvasOrContext.width || 0,
      height: canvasOrContext.height || 0
    };
  } else {
    throw new Error('Unsupported canvas or context: must provide Canvas or 2D context');
  }

  const width = canvas?.width ?? ctx?.canvas?.width ?? 0;
  const height = canvas?.height ?? ctx?.canvas?.height ?? 0;

  return { canvas, ctx, width, height };
}

/**
 * Redacts sensitive regions on a canvas image.
 *
 * Strategy:
 * - 'password', 'pin', 'otp' (or configured solid categories):
 *   Draws solid black box (ctx.fillRect) with optional label.
 * - 'face', 'email', 'phone', 'card', 'ssn', etc.:
 *   Applies strong Gaussian blur, box blur, or pixelation.
 *
 * Output:
 * - By default: returns the mutated canvas element.
 * - If options.returnType === 'dataUrl' or options.asDataUrl: returns base64 Data URL.
 * - If options.returnType === 'base64': returns raw base64 string.
 * - If options.returnType === 'both': returns { canvas, dataUrl, base64 }.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|CanvasRenderingContext2D|object} canvasOrContext
 * @param {Array<object>} [sensitiveRegions=[]]
 * @param {object} [options={}]
 * @returns {HTMLCanvasElement|OffscreenCanvas|string|object|Promise<string|object>}
 */
export function redactCanvas(canvasOrContext, sensitiveRegions = [], options = {}) {
  const { canvas, ctx, width, height } = resolveCanvasAndContext(canvasOrContext);

  const solidCategories = options.solidCategories instanceof Set
    ? options.solidCategories
    : new Set(
        Array.isArray(options.solidCategories)
          ? options.solidCategories.map((c) => String(c).toLowerCase())
          : DEFAULT_SOLID_CATEGORIES
      );

  const blurStyle = options.blurStyle || 'gaussian'; // 'gaussian' | 'pixelate' | 'box_blur'

  const regions = Array.isArray(sensitiveRegions) ? sensitiveRegions : [];

  for (const region of regions) {
    if (!region) continue;

    const bbox = normalizeBBox(region.bbox, width, height);
    if (!bbox) continue;

    const category = String(region.category || '').toLowerCase().trim();
    const redactionType = region.redactionType || region.type;

    // Determine whether to use solid box or blur/pixelation
    const isSolid = options.maskType === 'solid' ||
      redactionType === 'solid' ||
      solidCategories.has(category);

    if (isSolid) {
      applySolidMask(ctx, bbox, options, region);
    } else {
      const activeStyle = redactionType === 'pixelate'
        ? 'pixelate'
        : redactionType === 'box_blur'
          ? 'box_blur'
          : redactionType === 'gaussian'
            ? 'gaussian'
            : blurStyle;

      if (activeStyle === 'pixelate') {
        applyPixelation(ctx, bbox, options);
      } else if (activeStyle === 'box_blur') {
        applyBoxBlur(ctx, bbox, options);
      } else {
        // Default: Gaussian blur filter
        applyGaussianBlur(ctx, bbox, options);
      }
    }
  }

  // Handle return format
  const returnType = options.returnType || (options.asDataUrl ? 'dataUrl' : 'canvas');

  if (returnType === 'dataUrl' || returnType === 'base64') {
    return canvasToDataUrl(canvas, options);
  }

  if (returnType === 'both') {
    const dataUrlOrPromise = canvasToDataUrl(canvas, { ...options, returnType: 'dataUrl' });
    if (typeof dataUrlOrPromise?.then === 'function') {
      return dataUrlOrPromise.then((dataUrl) => ({
        canvas,
        dataUrl,
        base64: dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
      }));
    }
    return {
      canvas,
      dataUrl: dataUrlOrPromise,
      base64: dataUrlOrPromise.includes(',') ? dataUrlOrPromise.split(',')[1] : dataUrlOrPromise
    };
  }

  // Default: Return the mutated canvas
  return canvas;
}

/**
 * Convenience helper that guarantees returning a base64 Data URL.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|CanvasRenderingContext2D|object} canvasOrContext
 * @param {Array<object>} [sensitiveRegions=[]]
 * @param {object} [options={}]
 * @returns {Promise<string>} Base64 Data URL
 */
export async function redactCanvasToDataUrl(canvasOrContext, sensitiveRegions = [], options = {}) {
  const result = redactCanvas(canvasOrContext, sensitiveRegions, {
    ...options,
    returnType: 'dataUrl'
  });
  return await Promise.resolve(result);
}
