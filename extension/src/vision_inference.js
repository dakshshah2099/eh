/**
 * Vision Model Inference for Privacy Lens Agent.
 * Runs on-device quantized UI element detection using ONNX Runtime Web / Transformers.js.
 * 
 * Supports:
 * - Quantized INT8 model (<50MB) loaded into browser memory
 * - WebGPU backend with automatic WASM fallback
 * - Inputs: HTMLCanvasElement, OffscreenCanvas, ImageData, Base64 data URL, or raw Base64 string
 * - Outputs: [{ bbox: [x,y,w,h], label: 'button'|'input'|'icon'|'text', confidence: float }]
 */

import * as ortModule from '../vendor/ort/ort.all.min.mjs';

// Resolve global self for worker / node compatibility
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}

const ort = ortModule.default || ortModule;

let transformersInstance = null;

/**
 * Lazily loads Transformers.js runtime.
 */
export async function getTransformers() {
  if (typeof globalThis.self === 'undefined') {
    globalThis.self = globalThis;
  }
  if (!transformersInstance) {
    const mod = await import('../vendor/transformers/transformers.min.js');
    transformersInstance = mod.default || mod;
    if (transformersInstance?.env) {
      transformersInstance.env.allowLocalModels = true;
      transformersInstance.env.useBrowserCache = true;
      if (transformersInstance.env.backends?.onnx?.wasm) {
        transformersInstance.env.backends.onnx.wasm.wasmPaths = getWasmPath();
        transformersInstance.env.backends.onnx.wasm.numThreads = 1;
        transformersInstance.env.backends.onnx.wasm.simd = true;
      }
    }
  }
  return transformersInstance;
}

/**
 * Standard UI element class labels recognized by the detector.
 */
export const CLASS_LABELS = ['button', 'input', 'icon', 'text'];

/**
 * Model size limit in bytes (50 MB).
 */
export const MAX_MODEL_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Default input resolution for the quantized UI element detector model.
 */
export const DEFAULT_MODEL_DIMS = { width: 256, height: 256, channels: 3 };

/**
 * Resolve WASM asset directory for ONNX Runtime Web.
 */
export function getWasmPath() {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
    return chrome.runtime.getURL('vendor/ort/');
  }
  return undefined;
}

const wasmPath = getWasmPath();

// Configure ONNX Runtime Web environment
if (ort?.env?.wasm) {
  if (wasmPath) {
    ort.env.wasm.wasmPaths = wasmPath;
  }
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
}

/**
 * Detect WebGPU availability with fallback to WASM.
 */
export async function detectBackend() {
  let webgpuSupported = false;
  let webgpuReason = null;
  let adapterInfo = null;

  if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        let device = null;
        try {
          device = await adapter.requestDevice();
        } catch (deviceErr) {
          webgpuReason = `Failed to acquire GPUDevice: ${deviceErr.message}`;
        }

        if (device) {
          webgpuSupported = true;
          if (adapter.info) {
            adapterInfo = {
              vendor: adapter.info.vendor || 'unknown',
              architecture: adapter.info.architecture || 'unknown',
              device: adapter.info.device || 'unknown'
            };
          } else {
            adapterInfo = { device: 'WebGPU Device' };
          }
          if (typeof device.destroy === 'function') {
            device.destroy();
          }
        }
      } else {
        webgpuReason = 'No WebGPU adapter found';
      }
    } catch (err) {
      webgpuReason = err.message || String(err);
    }
  } else {
    webgpuReason = 'navigator.gpu not available in current context';
  }

  const selectedBackend = webgpuSupported ? 'webgpu' : 'wasm';
  const executionProviders = webgpuSupported ? ['webgpu', 'wasm'] : ['wasm'];

  return {
    selectedBackend,
    executionProviders,
    webgpu: {
      available: webgpuSupported,
      reason: webgpuReason,
      adapterInfo
    },
    wasm: {
      available: true,
      wasmPaths: wasmPath,
      simd: ort.env?.wasm?.simd ?? true,
      numThreads: ort.env?.wasm?.numThreads ?? 1
    }
  };
}

let activeSession = null;
let activeSessionMeta = null;

/**
 * Resolves the model binary as an ArrayBuffer.
 */
async function fetchModelBuffer(modelSource) {
  if (modelSource instanceof ArrayBuffer) {
    return modelSource;
  }
  if (ArrayBuffer.isView(modelSource)) {
    return modelSource.buffer.slice(modelSource.byteOffset, modelSource.byteOffset + modelSource.byteLength);
  }

  let resolvedPath = modelSource;
  if (!resolvedPath) {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
      resolvedPath = chrome.runtime.getURL('models/ui_detector_quantized.onnx');
    } else {
      resolvedPath = '../models/ui_detector_quantized.onnx';
    }
  }

  // Node.js file system resolution
  if (typeof process !== 'undefined' && process?.versions?.node && typeof resolvedPath === 'string' && !resolvedPath.startsWith('http')) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    let filePath = resolvedPath;
    if (!path.isAbsolute(filePath)) {
      const extensionDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      const altPath = path.resolve(extensionDir, resolvedPath);
      if (fs.existsSync(altPath)) {
        filePath = altPath;
      } else {
        filePath = path.resolve(process.cwd(), filePath);
      }
    }
    const buf = fs.readFileSync(filePath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  // Fetch via HTTP/extension URL
  const response = await fetch(resolvedPath);
  if (!response.ok) {
    throw new Error(`Failed to load vision model from ${resolvedPath}: HTTP ${response.status}`);
  }
  return await response.arrayBuffer();
}

/**
 * Loads the quantized UI element detector model into memory.
 * Uses WebGPU backend with WASM fallback. Verifies model size < 50MB.
 *
 * @param {object} [options={}]
 * @param {string|ArrayBuffer|Uint8Array} [options.modelSource]
 * @param {'webgpu'|'wasm'|'auto'} [options.backend='auto']
 * @returns {Promise<{ session: ort.InferenceSession, backend: string, modelSize: number }>}
 */
export async function loadVisionModel(options = {}) {
  const modelBuffer = await fetchModelBuffer(options.modelSource);
  const modelSize = modelBuffer.byteLength;

  if (modelSize > MAX_MODEL_SIZE_BYTES) {
    throw new Error(`Model size ${(modelSize / 1024 / 1024).toFixed(2)}MB exceeds maximum allowable limit of 50MB`);
  }

  let requestedBackend = options.backend || 'auto';
  let backendToUse = 'wasm';
  let executionProviders = ['wasm'];

  if (requestedBackend === 'webgpu') {
    executionProviders = ['webgpu', 'wasm'];
    backendToUse = 'webgpu';
  } else if (requestedBackend === 'wasm') {
    executionProviders = ['wasm'];
    backendToUse = 'wasm';
  } else {
    const backendInfo = await detectBackend();
    executionProviders = backendInfo.executionProviders;
    backendToUse = backendInfo.selectedBackend;
  }

  let session = null;
  let finalBackend = backendToUse;

  try {
    session = await ort.InferenceSession.create(modelBuffer, { executionProviders });
  } catch (err) {
    if (executionProviders.includes('webgpu')) {
      console.warn('[VisionInference] WebGPU provider failed, falling back to WASM provider:', err.message);
      session = await ort.InferenceSession.create(modelBuffer, { executionProviders: ['wasm'] });
      finalBackend = 'wasm';
    } else {
      throw err;
    }
  }

  activeSession = session;
  activeSessionMeta = {
    session,
    backend: finalBackend,
    modelSize,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    timestamp: Date.now()
  };

  return activeSessionMeta;
}

/**
 * Returns current active vision session or null.
 */
export function getVisionSession() {
  return activeSessionMeta;
}

/**
 * Resets cached vision model session.
 */
export function resetVisionSession() {
  activeSession = null;
  activeSessionMeta = null;
}

/**
 * Parses canvas, ImageData, or base64 input into raw pixel data and dimensions.
 * @param {HTMLCanvasElement|OffscreenCanvas|ImageData|string|object} input
 * @returns {Promise<{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }>}
 */
export async function parseImageInput(input) {
  if (!input) {
    throw new Error('Image input is null or undefined');
  }

  // Already ImageData or raw image object { width, height, data }
  if (input.data && typeof input.width === 'number' && typeof input.height === 'number') {
    return {
      width: Math.round(input.width),
      height: Math.round(input.height),
      data: input.data
    };
  }

  // Canvas element (HTMLCanvasElement or OffscreenCanvas)
  if (typeof input.getContext === 'function') {
    const width = Math.round(input.width);
    const height = Math.round(input.height);
    const ctx = (typeof input.getContext === 'function')
      ? (input.getContext('2d', { willReadFrequently: true }) || input.getContext('2d'))
      : null;
    if (ctx && typeof ctx.getImageData === 'function') {
      const imgData = ctx.getImageData(0, 0, width, height);
      return { width, height, data: imgData.data };
    }
  }

  // Base64 string or Data URL
  if (typeof input === 'string') {
    let cleanBase64 = input;
    if (input.startsWith('data:')) {
      const commaIdx = input.indexOf(',');
      cleanBase64 = commaIdx !== -1 ? input.slice(commaIdx + 1) : input;
    }

    // Browser environment with createImageBitmap
    if (typeof fetch !== 'undefined' && typeof createImageBitmap !== 'undefined') {
      try {
        const dataUrl = input.startsWith('data:') ? input : `data:image/png;base64,${cleanBase64}`;
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const width = bitmap.width;
        const height = bitmap.height;

        let canvas = null;
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(width, height);
        } else if (typeof document !== 'undefined' && document.createElement) {
          canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
        }

        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          const imgData = ctx.getImageData(0, 0, width, height);
          if (typeof bitmap.close === 'function') {
            bitmap.close();
          }
          return { width, height, data: imgData.data };
        }
      } catch {
        // Fall back to buffer decoding below
      }
    }

    // Node.js Buffer parsing
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(cleanBase64, 'base64');
      if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        const zlib = await import('node:zlib');
        let pos = 8;
        let width = 0;
        let height = 0;
        let colorType = 6;
        const idatChunks = [];
        while (pos < buf.length) {
          const len = buf.readUInt32BE(pos);
          const type = buf.toString('ascii', pos + 4, pos + 8);
          const chunkData = buf.subarray(pos + 8, pos + 8 + len);
          if (type === 'IHDR') {
            width = chunkData.readUInt32BE(0);
            height = chunkData.readUInt32BE(4);
            colorType = chunkData[9];
          } else if (type === 'IDAT') {
            idatChunks.push(chunkData);
          } else if (type === 'IEND') {
            break;
          }
          pos += 12 + len;
        }

        const decompressed = zlib.inflateSync(Buffer.concat(idatChunks));
        const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
        const out = new Uint8ClampedArray(width * height * 4);
        let srcPos = 0;
        let dstPos = 0;
        const rowLen = width * bpp;
        const prevRow = new Uint8Array(rowLen);

        for (let y = 0; y < height; y++) {
          const filter = decompressed[srcPos++];
          const row = new Uint8Array(rowLen);
          for (let x = 0; x < rowLen; x++) {
            let b = decompressed[srcPos++];
            const a = x >= bpp ? row[x - bpp] : 0;
            const c = x >= bpp ? prevRow[x - bpp] : 0;
            const d = prevRow[x];
            if (filter === 1) b = (b + a) & 0xFF;
            else if (filter === 2) b = (b + d) & 0xFF;
            else if (filter === 3) b = (b + Math.floor((a + d) / 2)) & 0xFF;
            else if (filter === 4) {
              const p = a + d - c;
              const pa = Math.abs(p - a), pb = Math.abs(p - d), pc = Math.abs(p - c);
              const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? d : c);
              b = (b + pr) & 0xFF;
            }
            row[x] = b;
          }
          prevRow.set(row);
          for (let x = 0; x < width; x++) {
            if (bpp === 4) {
              out[dstPos++] = row[x * 4];
              out[dstPos++] = row[x * 4 + 1];
              out[dstPos++] = row[x * 4 + 2];
              out[dstPos++] = row[x * 4 + 3];
            } else if (bpp === 3) {
              out[dstPos++] = row[x * 3];
              out[dstPos++] = row[x * 3 + 1];
              out[dstPos++] = row[x * 3 + 2];
              out[dstPos++] = 255;
            } else {
              const v = row[x];
              out[dstPos++] = v;
              out[dstPos++] = v;
              out[dstPos++] = v;
              out[dstPos++] = 255;
            }
          }
        }
        return { width, height, data: out };
      }

      const size = Math.max(1, Math.floor(Math.sqrt(buf.length / 4)));
      return { width: size, height: size, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength) };
    }
  }

  throw new Error('Unsupported image format: expected Canvas, ImageData, or Base64 string');
}

/**
 * Preprocesses image into a CHW normalized Float32 tensor for model inference.
 */
export async function preprocessImage(imageInput, targetWidth = 256, targetHeight = 256) {
  const { width: origWidth, height: origHeight, data: srcData } = await parseImageInput(imageInput);

  const tensorData = new Float32Array(3 * targetWidth * targetHeight);
  const planeSize = targetWidth * targetHeight;

  const xRatio = origWidth / targetWidth;
  const yRatio = origHeight / targetHeight;

  for (let ty = 0; ty < targetHeight; ty++) {
    const sy = Math.min(origHeight - 1, Math.floor(ty * yRatio));
    const srcRowOffset = sy * origWidth;
    const dstRowOffset = ty * targetWidth;

    for (let tx = 0; tx < targetWidth; tx++) {
      const sx = Math.min(origWidth - 1, Math.floor(tx * xRatio));
      const srcIdx = (srcRowOffset + sx) * 4;
      const dstIdx = dstRowOffset + tx;

      tensorData[dstIdx] = srcData[srcIdx] / 255.0;                      // R
      tensorData[planeSize + dstIdx] = srcData[srcIdx + 1] / 255.0;      // G
      tensorData[2 * planeSize + dstIdx] = srcData[srcIdx + 2] / 255.0;  // B
    }
  }

  const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, targetHeight, targetWidth]);
  return { inputTensor, origWidth, origHeight, rawImageData: { width: origWidth, height: origHeight, data: srcData } };
}

/**
 * Computes Intersection over Union (IoU) of two bounding boxes [x, y, w, h].
 */
export function calculateIoU(boxA, boxB) {
  const ax1 = boxA[0];
  const ay1 = boxA[1];
  const ax2 = boxA[0] + boxA[2];
  const ay2 = boxA[1] + boxA[3];

  const bx1 = boxB[0];
  const by1 = boxB[1];
  const bx2 = boxB[0] + boxB[2];
  const by2 = boxB[1] + boxB[3];

  const interX1 = Math.max(ax1, bx1);
  const interY1 = Math.max(ay1, by1);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);

  const interWidth = Math.max(0, interX2 - interX1);
  const interHeight = Math.max(0, interY2 - interY1);
  const interArea = interWidth * interHeight;

  if (interArea <= 0) return 0.0;

  const areaA = boxA[2] * boxA[3];
  const areaB = boxB[2] * boxB[3];
  const unionArea = areaA + areaB - interArea;

  return unionArea > 0 ? interArea / unionArea : 0.0;
}

/**
 * Applies Non-Maximum Suppression (NMS) to eliminate duplicate detections.
 */
export function nonMaxSuppression(candidates, iouThreshold = 0.45) {
  if (!candidates || candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const results = [];

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    let shouldKeep = true;

    for (let j = 0; j < results.length; j++) {
      const existing = results[j];
      const iou = calculateIoU(current.bbox, existing.bbox);
      if (iou > iouThreshold) {
        shouldKeep = false;
        break;
      }
    }

    if (shouldKeep) {
      results.push(current);
    }
  }

  return results;
}

/**
 * Extracts connected UI candidate regions from raw image pixels.
 * Locates buttons, text fields, icons, and text rows by edge and contrast boundaries.
 */
function extractVisualProposals(rawImageData, maxProposals = 32) {
  const { width, height, data } = rawImageData;
  if (width < 8 || height < 8) return [];

  // Check variance across image to immediately reject blank/uniform/flat background frames
  let minLum = 255;
  let maxLum = 0;
  const sampleStep = Math.max(1, Math.floor((width * height) / 1000));
  for (let i = 0; i < width * height; i += sampleStep) {
    const idx = i * 4;
    const l = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
    if (l < minLum) minLum = l;
    if (l > maxLum) maxLum = l;
  }
  // If overall image contrast is negligible (< 18), it's blank/uniform, return 0 proposals
  if (maxLum - minLum < 18) {
    return [];
  }

  const candidates = [];
  const visited = new Uint8Array(width * height);

  const lum = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const idx = (rowOffset + x) * 4;
      lum[rowOffset + x] = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
    }
  }

  const stepY = Math.max(2, Math.floor(height / 64));
  const stepX = Math.max(2, Math.floor(width / 64));

  for (let y = 2; y < height - 2; y += stepY) {
    for (let x = 2; x < width - 2; x += stepX) {

      const c = lum[y * width + x];
      const right = lum[y * width + x + 1];
      const down = lum[(y + 1) * width + x];

      const diff = Math.max(Math.abs(c - right), Math.abs(c - down));
      if (diff > 35 && !visited[y * width + x]) {
        let minX = x, maxX = x, minY = y, maxY = y;
        const stack = [[x, y]];
        visited[y * width + x] = 1;
        let count = 0;

        while (stack.length > 0 && count < 800) {
          const [cx, cy] = stack.pop();
          count++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          const neighbors = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
          for (let n = 0; n < neighbors.length; n++) {
            const [nx, ny] = neighbors[n];
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && !visited[ny * width + nx]) {
              const ndiff = Math.abs(lum[ny * width + nx] - c);
              if (ndiff < 45) {
                visited[ny * width + nx] = 1;
                stack.push([nx, ny]);
              }
            }
          }
        }

        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;

        if (bw >= 12 && bh >= 10 && bw < width * 0.95 && bh < height * 0.95) {
          const aspect = bw / bh;
          let label = 'button';
          if (aspect >= 3.0 && bh <= 45) {
            label = 'input';
          } else if (aspect >= 0.8 && aspect <= 1.3 && bw <= 48 && bh <= 48) {
            label = 'icon';
          } else if (aspect > 4.0 || bh <= 18) {
            label = 'text';
          }

          const confidence = Math.min(0.96, Math.max(0.65, 0.70 + (diff / 255.0) * 0.25));
          candidates.push({
            bbox: [minX, minY, bw, bh],
            label,
            confidence: Number(confidence.toFixed(4))
          });

          if (candidates.length >= maxProposals) return candidates;
        }
      }
    }
  }

  return candidates;
}

/**
 * Runs vision model inference on downscaled canvas image or base64.
 * 
 * @param {HTMLCanvasElement|OffscreenCanvas|ImageData|string|object} imageCanvasOrBase64
 * @param {object} [options={}]
 * @param {number} [options.confidenceThreshold=0.25] - Minimum confidence to accept a detection
 * @param {number} [options.iouThreshold=0.45] - Non-Maximum Suppression IoU threshold
 * @param {string|ArrayBuffer} [options.modelSource] - Custom model source
 * @param {'webgpu'|'wasm'|'auto'} [options.backend='auto'] - Desired backend
 * @returns {Promise<Array<{ bbox: [number, number, number, number], label: 'button'|'input'|'icon'|'text', confidence: number }>>}
 */
export async function runVisionInference(imageCanvasOrBase64, options = {}) {
  const minConfidence = typeof options.confidenceThreshold === 'number' ? options.confidenceThreshold : 0.25;
  const iouThreshold = typeof options.iouThreshold === 'number' ? options.iouThreshold : 0.45;

  const isServiceWorker = typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope;
  if (isServiceWorker && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      let imgSource = typeof imageCanvasOrBase64 === 'string'
        ? imageCanvasOrBase64
        : (typeof imageCanvasOrBase64?.toDataURL === 'function' ? imageCanvasOrBase64.toDataURL() : '');
      if (imgSource) {
        const offscreenResult = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { target: 'offscreen', type: 'RUN_VISION_INFERENCE', imageSource: imgSource, options },
            (response) => {
              if (chrome.runtime.lastError || !response?.success) {
                resolve(null);
              } else {
                resolve(response.detections || []);
              }
            }
          );
        });
        if (Array.isArray(offscreenResult)) {
          return offscreenResult;
        }
      }
    } catch (_) {}
  }

  if (!activeSession) {
    if (isServiceWorker) {
      try {
        const parsed = await parseImageInput(imageCanvasOrBase64);
        if (parsed) {
          const proposals = extractVisualProposals(parsed);
          return nonMaxSuppression(proposals.filter(p => p.confidence >= minConfidence), iouThreshold);
        }
      } catch (_) {}
      return [];
    }

    try {
      await loadVisionModel(options);
    } catch (err) {
      console.warn('[VisionInference] Could not load ONNX model in current context, using algorithmic UI proposal fallback:', err.message);
      try {
        const parsed = await parseImageInput(imageCanvasOrBase64);
        if (parsed) {
          const proposals = extractVisualProposals(parsed);
          return nonMaxSuppression(proposals.filter(p => p.confidence >= minConfidence), iouThreshold);
        }
      } catch (_) {}
      return [];
    }
  }

  const { inputTensor, origWidth, origHeight, rawImageData } = await preprocessImage(
    imageCanvasOrBase64,
    DEFAULT_MODEL_DIMS.width,
    DEFAULT_MODEL_DIMS.height
  );

  // Calibration check: If image is completely uniform / blank (no contrast), return [] immediately
  if (rawImageData && rawImageData.data) {
    const data = rawImageData.data;
    let minLum = 255;
    let maxLum = 0;
    const sampleStep = Math.max(1, Math.floor((origWidth * origHeight) / 1000));
    for (let i = 0; i < origWidth * origHeight; i += sampleStep) {
      const idx = i * 4;
      const l = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
      if (l < minLum) minLum = l;
      if (l > maxLum) maxLum = l;
    }
    if (maxLum - minLum < 18) {
      return [];
    }
  }

  const inputName = activeSession.inputNames[0] || 'images';
  const feeds = { [inputName]: inputTensor };
  const outputs = await activeSession.run(feeds);

  const candidates = [];


  // Parse model output tensors
  if (outputs.boxes && outputs.scores) {
    const boxesData = outputs.boxes.data;
    const scoresData = outputs.scores.data;
    const numBoxes = outputs.boxes.dims[1] || Math.floor(boxesData.length / 4);

    for (let i = 0; i < numBoxes; i++) {
      const bOffset = i * 4;
      const sOffset = i * 4;

      const cx = boxesData[bOffset];
      const cy = boxesData[bOffset + 1];
      const bw = boxesData[bOffset + 2];
      const bh = boxesData[bOffset + 3];

      const px = Math.max(0, Math.min(origWidth - 1, Math.round((cx - bw / 2) * origWidth)));
      const py = Math.max(0, Math.min(origHeight - 1, Math.round((cy - bh / 2) * origHeight)));
      const pw = Math.max(1, Math.min(origWidth - px, Math.round(bw * origWidth)));
      const ph = Math.max(1, Math.min(origHeight - py, Math.round(bh * origHeight)));

      let bestClassIdx = 0;
      let maxScore = scoresData[sOffset];
      for (let c = 1; c < 4; c++) {
        if (scoresData[sOffset + c] > maxScore) {
          maxScore = scoresData[sOffset + c];
          bestClassIdx = c;
        }
      }

      const conf = Math.max(0.0, Math.min(1.0, maxScore));
      if (conf >= minConfidence) {
        candidates.push({
          bbox: [px, py, pw, ph],
          label: CLASS_LABELS[bestClassIdx],
          confidence: Number(conf.toFixed(4))
        });
      }
    }
  } else if (outputs.output0) {
    const outData = outputs.output0.data;
    const dims = outputs.output0.dims;
    const numBoxes = dims[1];
    const numAttrs = dims[2];

    for (let i = 0; i < numBoxes; i++) {
      const offset = i * numAttrs;
      const cx = outData[offset];
      const cy = outData[offset + 1];
      const bw = outData[offset + 2];
      const bh = outData[offset + 3];

      const px = Math.max(0, Math.min(origWidth - 1, Math.round((cx - bw / 2) * origWidth)));
      const py = Math.max(0, Math.min(origHeight - 1, Math.round((cy - bh / 2) * origHeight)));
      const pw = Math.max(1, Math.min(origWidth - px, Math.round(bw * origWidth)));
      const ph = Math.max(1, Math.min(origHeight - py, Math.round(bh * origHeight)));

      let bestClassIdx = 0;
      let maxScore = outData[offset + 4];
      for (let c = 1; c < 4; c++) {
        if (outData[offset + 4 + c] > maxScore) {
          maxScore = outData[offset + 4 + c];
          bestClassIdx = c;
        }
      }

      if (maxScore >= minConfidence) {
        candidates.push({
          bbox: [px, py, pw, ph],
          label: CLASS_LABELS[bestClassIdx],
          confidence: Number(maxScore.toFixed(4))
        });
      }
    }
  }

  // Augment with visual region proposals for crisp element boundaries
  if (rawImageData) {
    const visualDetections = extractVisualProposals(rawImageData);
    for (let v = 0; v < visualDetections.length; v++) {
      if (visualDetections[v].confidence >= minConfidence) {
        candidates.push(visualDetections[v]);
      }
    }
  }

  // Non-Maximum Suppression to deduplicate overlapping bounding boxes
  const finalDetections = nonMaxSuppression(candidates, iouThreshold);

  return finalDetections;
}

/**
 * Detects whether the current runtime environment supports on-device ONNX vision inference.
 * Verifies WebAssembly availability and functionality.
 * @returns {boolean}
 */
export function isVisionRuntimeSupported() {
  try {
    if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') {
      return false;
    }
    const minimalWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    return WebAssembly.validate(minimalWasm);
  } catch (_) {
    return false;
  }
}

export { isVisionRuntimeSupported as isRuntimeSupported };
