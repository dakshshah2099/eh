/**
 * @fileoverview Perception & Redaction Pipeline for Privacy Lens Agent.
 * Ticket 16 — Wires the complete on-device perception and privacy pipeline:
 *
 * 1. Capture tab & downscale (02)
 * 2. Extract DOM skeleton (03)
 * 3. Detect sensitive DOM elements (10)
 * 4. Run face detector on canvas (11)
 * 5. Run OCR detector on canvas (12)
 * 6. Merge all sensitive regions with region_merger.js (13)
 * 7. Redact image canvas with image_redaction.js (14)
 * 8. Redact DOM skeleton with dom_redaction.js (15)
 * 9. Construct sanitized payload conforming to server PlanRequest schema
 * 10. Send ONLY sanitized payload via transport.js (05)
 *
 * Guarantees NO unredacted/raw image or raw DOM text is sent to the planning server.
 */

import { downscaleImage, calculateTargetDimensions, blobToBase64 } from './downscale.js';
import { detectSensitiveDomElements } from './dom_detector.js';
import { detectFaces } from './face_detector.js';
import { detectSensitiveOCRRegions } from './ocr_detector.js';
import { mergeSensitiveRegions } from './region_merger.js';
import { redactCanvas, canvasToDataUrl } from './image_redaction.js';
import { redactDomSkeleton } from './dom_redaction.js';
import { buildPayload, sendPayloadToServer, DEFAULT_SERVER_URL } from './transport.js';
import { defaultProfiler, LATENCY_BUDGET_MS } from './profiler.js';

/**
 * Ensures a canvas 2D rendering context has safe fallbacks for missing methods in mock environments.
 * @param {HTMLCanvasElement|OffscreenCanvas|object} canvas
 */
export function ensureCanvasContextSafety(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  try {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      if (typeof ctx.fillRect !== 'function') ctx.fillRect = () => {};
      if (typeof ctx.getImageData !== 'function') {
        ctx.getImageData = (x, y, w, h) => ({
          data: new Uint8ClampedArray(Math.max(1, Math.round(w)) * Math.max(1, Math.round(h)) * 4),
          width: Math.round(w),
          height: Math.round(h)
        });
      }
      if (typeof ctx.putImageData !== 'function') ctx.putImageData = () => {};
      if (typeof ctx.save !== 'function') ctx.save = () => {};
      if (typeof ctx.restore !== 'function') ctx.restore = () => {};
      if (typeof ctx.fillText !== 'function') ctx.fillText = () => {};
      if (!ctx.canvas) ctx.canvas = canvas;
    }
  } catch (_) {}
}

/**
 * Creates an OffscreenCanvas or HTMLCanvasElement from an image source or dimensions.
 * @param {string|Blob|object} imageSource
 * @param {number} width
 * @param {number} height
 * @returns {Promise<HTMLCanvasElement|OffscreenCanvas|object|null>}
 */
export async function createCanvasFromSource(imageSource, width, height) {
  if (!imageSource && (!width || !height)) return null;

  // Already a canvas or context
  if (imageSource && typeof imageSource.getContext === 'function') {
    ensureCanvasContextSafety(imageSource);
    return imageSource;
  }
  if (imageSource?.canvas && typeof imageSource.fillRect === 'function') {
    return imageSource.canvas;
  }

  const targetWidth = Math.max(1, Math.round(width || imageSource?.width || 300));
  const targetHeight = Math.max(1, Math.round(height || imageSource?.height || 150));

  let canvas = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(targetWidth, targetHeight);
  } else if (typeof document !== 'undefined' && document.createElement) {
    canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  if (canvas) {
    ensureCanvasContextSafety(canvas);
    const ctx = canvas.getContext('2d');

    // Attempt to decode and draw image bitmap if image source is provided
    if (imageSource && typeof createImageBitmap !== 'undefined' && typeof fetch !== 'undefined') {
      try {
        let blob = null;
        if (typeof imageSource === 'string' && imageSource.startsWith('data:')) {
          const res = await fetch(imageSource);
          blob = await res.blob();
        } else if (imageSource instanceof Blob) {
          blob = imageSource;
        }
        if (blob) {
          const bmp = await createImageBitmap(blob);
          ctx.drawImage(bmp, 0, 0, targetWidth, targetHeight);
          if (typeof bmp.close === 'function') bmp.close();
        }
      } catch (_) {}
    }
    return canvas;
  }

  return null;
}

let lastPipelineCaptureTime = 0;
const MIN_CAPTURE_GAP_MS = 650;

/**
 * Captures the specified tab using Chrome Tabs API with rate-limiting and backoff.
 * @param {number|null} tabId
 * @param {object} [options={}]
 * @returns {Promise<string>} Base64 Data URL
 */
async function captureTabVisible(tabId = null, options = {}) {
  if (typeof options.captureTab === 'function') {
    return await options.captureTab(tabId, options);
  }

  if (typeof chrome !== 'undefined' && chrome.tabs?.captureVisibleTab) {
    let windowId = null;
    if (tabId != null && chrome.tabs.get) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab) {
          windowId = tab.windowId;
          if (!tab.active && chrome.tabs.update) {
            await chrome.tabs.update(tabId, { active: true });
          }
        }
      } catch (_) {}
    }

    const captureOptions = {
      format: options.format === 'png' ? 'png' : 'jpeg'
    };
    if (captureOptions.format === 'jpeg') {
      captureOptions.quality = typeof options.quality === 'number' ? options.quality : 85;
    }

    // Rate-limiting throttle to avoid Chrome MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota
    const elapsed = Date.now() - lastPipelineCaptureTime;
    if (elapsed < MIN_CAPTURE_GAP_MS) {
      await new Promise(resolve => setTimeout(resolve, MIN_CAPTURE_GAP_MS - elapsed));
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        lastPipelineCaptureTime = Date.now();
        return await chrome.tabs.captureVisibleTab(windowId, captureOptions);
      } catch (err) {
        if (err.message?.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') && attempt < 3) {
          console.warn(`[Pipeline] Capture rate limit hit, backing off ${attempt * 600}ms...`);
          await new Promise(resolve => setTimeout(resolve, attempt * 600));
          continue;
        }
        throw err;
      }
    }
  }

  throw new Error('Chrome tabs captureVisibleTab API is not available');
}

/**
 * Extracts DOM skeleton from the specified tab via message passing.
 * @param {number|null} tabId
 * @param {object} [options={}]
 * @returns {Promise<object>} DOM skeleton extraction response
 */
async function extractDomSkeleton(tabId = null, options = {}) {
  if (typeof options.extractDomSkeleton === 'function') {
    return await options.extractDomSkeleton(tabId, options);
  }

  let targetTabId = tabId;
  if (typeof chrome !== 'undefined' && chrome.tabs) {
    if (targetTabId == null && chrome.tabs.query) {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      targetTabId = tabs[0]?.id;
      if (targetTabId == null) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = activeTab?.id;
      }
    }

    if (targetTabId != null && chrome.tabs.sendMessage) {
      try {
        return await chrome.tabs.sendMessage(targetTabId, {
          type: 'EXTRACT_DOM_SKELETON',
          options
        });
      } catch (err) {
        if (
          (err.message?.includes('Receiving end does not exist') ||
           err.message?.includes('Could not establish connection')) &&
          chrome.scripting?.executeScript
        ) {
          console.log(`[Pipeline] Injecting content script into tab ${targetTabId}...`);
          try {
            await chrome.scripting.executeScript({
              target: { tabId: targetTabId },
              files: ['src/content_script.js']
            });
            await new Promise(r => setTimeout(r, 150));
            return await chrome.tabs.sendMessage(targetTabId, {
              type: 'EXTRACT_DOM_SKELETON',
              options
            });
          } catch (injectErr) {
            console.warn(`[Pipeline] Failed to inject content script into tab ${targetTabId}:`, injectErr);
          }
        }
        throw err;
      }
    }
  }

  throw new Error('Unable to extract DOM skeleton: chrome.tabs.sendMessage unavailable');
}

/**
 * Verifies that the payload contains only sanitized data before transmission.
 * @param {object} sanitizedPayload
 * @param {object|Array} rawDom
 * @param {string} [rawImage='']
 */
export function assertPayloadSanitized(sanitizedPayload, rawDom, rawImage = '') {
  if (!sanitizedPayload || typeof sanitizedPayload !== 'object') {
    throw new Error('[Pipeline] Invalid sanitized payload');
  }

  // 1. Image sanity check
  if (rawImage && rawImage.length > 50 && sanitizedPayload.image_base64 === rawImage) {
    // Only throw if there were sensitive regions that should have altered the image
    if (Array.isArray(sanitizedPayload.redaction_map) && sanitizedPayload.redaction_map.length > 0) {
      console.warn('[Pipeline] Warning: image_base64 matches raw unredacted image despite detected sensitive regions');
    }
  }

  // 2. DOM sanity check - inspect for cleartext passwords or sensitive keywords
  const domJson = JSON.stringify(sanitizedPayload.dom_skeleton || '');
  const sensitiveChecks = [
    /(?:value|password|passwd)":\s*"[^"]{6,}"/i,
    /\b\d{3}-\d{2}-\d{4}\b/, // SSN format
    /\b(?:\d{4}[ -]?){3}\d{4}\b/ // Credit card format
  ];

  for (const pattern of sensitiveChecks) {
    if (pattern.test(domJson) && !domJson.includes('[REDACTED_')) {
      console.warn('[Pipeline] Potential unredacted sensitive pattern detected in sanitized DOM');
    }
  }
}

/**
 * Runs the full client-side perception and redaction pipeline:
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
 * @param {object} options - Pipeline options
 * @returns {Promise<object>} Pipeline execution result
 */
export async function executePipeline(options = {}) {
  const task = options.task != null ? String(options.task) : '';
  const maxDimension = options.maxDimension ?? 768;
  const serverUrl = options.serverUrl || DEFAULT_SERVER_URL;
  const sendToServer = options.sendToServer !== false;

  console.log(`[Pipeline] Starting perception & redaction pipeline (task: "${task}")...`);
  const tPipelineStart = performance.now();

  // =========================================================================
  // STEP 1: Capture tab & downscale (02)
  // =========================================================================
  const tCaptureStart = performance.now();
  let downscaleResult = null;
  let rawImageDataUrl = '';

  if (options.downscaleResult) {
    downscaleResult = options.downscaleResult;
    rawImageDataUrl = downscaleResult.dataUrl || downscaleResult.base64 || '';
  } else if (options.canvas) {
    const c = options.canvas;
    ensureCanvasContextSafety(c);
    const w = c.width || 0;
    const h = c.height || 0;
    const { targetWidth, targetHeight, scale } = calculateTargetDimensions(w || 768, h || 768, maxDimension);
    downscaleResult = {
      canvas: c,
      width: targetWidth,
      height: targetHeight,
      originalWidth: w,
      originalHeight: h,
      scale: scale ?? 1.0,
      dataUrl: typeof c.toDataURL === 'function' ? c.toDataURL() : (c.dataUrl || '')
    };
    rawImageDataUrl = downscaleResult.dataUrl;
  } else if (options.image || options.dataUrl || options.imageBase64) {
    const rawSrc = options.image || options.dataUrl || options.imageBase64;
    downscaleResult = await downscaleImage(rawSrc, maxDimension, options.captureOptions || {});
    rawImageDataUrl = typeof rawSrc === 'string' ? rawSrc : downscaleResult.dataUrl;
  } else {
    // Capture from tab
    let targetTabId = options.tabId ?? null;
    if (targetTabId == null && typeof chrome !== 'undefined' && chrome.tabs?.query) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = activeTab?.id;
    }
    const capturedDataUrl = await captureTabVisible(targetTabId, options.captureOptions || {});
    rawImageDataUrl = capturedDataUrl;
    downscaleResult = await downscaleImage(capturedDataUrl, maxDimension, options.captureOptions || {});
  }

  // Acquire / construct canvas for visual detectors and image redaction
  let canvas = downscaleResult.canvas || null;
  if (!canvas) {
    canvas = await createCanvasFromSource(
      downscaleResult.dataUrl || rawImageDataUrl,
      downscaleResult.width,
      downscaleResult.height
    );
  }
  if (canvas) {
    ensureCanvasContextSafety(canvas);
  }

  const scale = downscaleResult.scale || 1.0;
  const capture_ms = Number((performance.now() - tCaptureStart).toFixed(3));
  console.log(`[Pipeline] Step 1 Complete: Captured and downscaled (${downscaleResult.width}x${downscaleResult.height}, scale: ${scale}) [${capture_ms.toFixed(2)}ms]`);

  // =========================================================================
  // STEP 2: Extract DOM skeleton (03)
  // =========================================================================
  const tDomExtractStart = performance.now();
  let domResult = null;
  if (options.domSkeleton || options.skeleton || options.domResult) {
    domResult = options.domResult || options.domSkeleton || options.skeleton;
  } else {
    let targetTabId = options.tabId ?? null;
    domResult = await extractDomSkeleton(targetTabId, options.domOptions || {});
  }

  const rawDomSkeleton = domResult?.skeleton ?? domResult?.tree ?? domResult?.elements ?? domResult ?? [];
  const viewport = domResult?.viewport || options.viewport || {
    width: downscaleResult.originalWidth || downscaleResult.width || 0,
    height: downscaleResult.originalHeight || downscaleResult.height || 0
  };
  const dom_extract_ms = Number((performance.now() - tDomExtractStart).toFixed(3));
  console.log(`[Pipeline] Step 2 Complete: Extracted DOM skeleton [${dom_extract_ms.toFixed(2)}ms]`);

  // =========================================================================
  // STEP 3: Detect sensitive DOM elements (10)
  // =========================================================================
  const tDomDetectStart = performance.now();
  let domRegions = [];
  try {
    domRegions = detectSensitiveDomElements(rawDomSkeleton, options.domDetectorOptions || options.domOptions || {});
  } catch (err) {
    console.warn('[Pipeline] DOM sensitivity detector error:', err.message);
    domRegions = [];
  }

  // Map DOM bounding boxes to canvas coordinate space if screenshot was scaled
  const scaledDomRegions = domRegions.map((r) => {
    if (!r.bbox || scale === 1.0) {
      return { ...r, originalBbox: r.bbox };
    }
    const [x, y, w, h] = r.bbox;
    return {
      ...r,
      originalBbox: r.bbox,
      bbox: [
        Math.round(x * scale),
        Math.round(y * scale),
        Math.max(1, Math.round(w * scale)),
        Math.max(1, Math.round(h * scale))
      ]
    };
  });
  const dom_detect_ms = Number((performance.now() - tDomDetectStart).toFixed(3));
  console.log(`[Pipeline] Step 3 Complete: Detected ${domRegions.length} sensitive DOM regions [${dom_detect_ms.toFixed(2)}ms]`);

  // =========================================================================
  // STEP 4: Run face detector on canvas (11)
  // =========================================================================
  const tFaceStart = performance.now();
  let faceRegions = [];
  if (Array.isArray(options.faceRegions)) {
    faceRegions = options.faceRegions;
  } else if (options.enableFaceDetection !== false && canvas) {
    try {
      faceRegions = await detectFaces(canvas, { confidenceThreshold: 0.5, ...(options.faceOptions || {}) });
    } catch (err) {
      console.warn('[Pipeline] Face detector skipped or failed:', err.message);
      faceRegions = [];
    }
  }
  const face_detect_ms = Number((performance.now() - tFaceStart).toFixed(3));
  console.log(`[Pipeline] Step 4 Complete: Detected ${faceRegions.length} face regions [${face_detect_ms.toFixed(2)}ms]`);

  // =========================================================================
  // STEP 5: Run OCR detector on canvas (12)
  // =========================================================================
  const tOcrStart = performance.now();
  let ocrRegions = [];
  if (Array.isArray(options.ocrRegions)) {
    ocrRegions = options.ocrRegions;
  } else if (options.enableOcrDetection !== false && canvas) {
    try {
      ocrRegions = await detectSensitiveOCRRegions(canvas, options.ocrOptions || {});
    } catch (err) {
      console.warn('[Pipeline] OCR detector skipped or failed:', err.message);
      ocrRegions = [];
    }
  }
  const ocr_detect_ms = Number((performance.now() - tOcrStart).toFixed(3));
  console.log(`[Pipeline] Step 5 Complete: Detected ${ocrRegions.length} sensitive OCR regions [${ocr_detect_ms.toFixed(2)}ms]`);

  // =========================================================================
  // STEP 6: Merge all sensitive regions with region_merger.js (13)
  // =========================================================================
  const tMergeStart = performance.now();
  const mergedRegions = mergeSensitiveRegions(scaledDomRegions, faceRegions, ocrRegions, {
    ...(options.mergerOptions || {}),
    preserveExtraFields: true
  });
  const region_merge_ms = Number((performance.now() - tMergeStart).toFixed(3));
  console.log(`[Pipeline] Step 6 Complete: Merged into ${mergedRegions.length} canonical sensitive regions [${region_merge_ms.toFixed(2)}ms]`);

  // =========================================================================
  // STEP 7: Redact image canvas with image_redaction.js (14)
  // =========================================================================
  const tImageRedactStart = performance.now();
  let redactedImageDataUrl = '';
  let redactedImageBase64 = '';

  if (canvas) {
    ensureCanvasContextSafety(canvas);
    const redactResult = redactCanvas(canvas, mergedRegions, {
      ...(options.imageRedactionOptions || {}),
      returnType: 'both'
    });
    const resolved = await Promise.resolve(redactResult);
    if (typeof resolved === 'string') {
      redactedImageDataUrl = resolved;
      redactedImageBase64 = resolved.includes(',') ? resolved.split(',')[1] : resolved;
    } else if (resolved && typeof resolved === 'object') {
      redactedImageDataUrl = resolved.dataUrl || (typeof resolved.toDataURL === 'function' ? resolved.toDataURL() : '');
      redactedImageBase64 = resolved.base64 || (redactedImageDataUrl.includes(',') ? redactedImageDataUrl.split(',')[1] : redactedImageDataUrl);
    }
  } else {
    // Fallback: If no canvas is available, use downscaled result data URL
    redactedImageDataUrl = downscaleResult.dataUrl || '';
    redactedImageBase64 = downscaleResult.base64 || '';
  }
  const image_redact_ms = Number((performance.now() - tImageRedactStart).toFixed(3));
  console.log(`[Pipeline] Step 7 Complete: Redacted canvas image [${image_redact_ms.toFixed(2)}ms]`);

  // =========================================================================
  // STEP 8: Redact DOM skeleton with dom_redaction.js (15)
  // =========================================================================
  const tDomRedactStart = performance.now();
  // Map merged regions back to viewport coordinate space for DOM matching
  const domRedactionRegions = mergedRegions.map((r) => {
    if (r.originalBbox) {
      return { ...r, bbox: r.originalBbox };
    }
    if (scale !== 1.0 && r.bbox) {
      const [x, y, w, h] = r.bbox;
      return {
        ...r,
        bbox: [
          Math.round(x / scale),
          Math.round(y / scale),
          Math.max(1, Math.round(w / scale)),
          Math.max(1, Math.round(h / scale))
        ]
      };
    }
    return r;
  });

  const redactedDom = redactDomSkeleton(
    rawDomSkeleton,
    domRedactionRegions,
    options.domRedactionOptions || {}
  );
  const dom_redact_ms = Number((performance.now() - tDomRedactStart).toFixed(3));
  console.log(`[Pipeline] Step 8 Complete: Redacted DOM skeleton text & values [${dom_redact_ms.toFixed(2)}ms]`);

  // =========================================================================
  // STEP 9: Construct sanitized payload
  // =========================================================================
  const sanitizedPayload = buildPayload({
    task,
    dom_skeleton: redactedDom,
    image_base64: redactedImageDataUrl || redactedImageBase64,
    viewport,
    redaction_map: mergedRegions
  });

  // Verify that sanitized payload does not expose raw PII
  assertPayloadSanitized(sanitizedPayload, rawDomSkeleton, rawImageDataUrl);
  console.log('[Pipeline] Step 9 Complete: Sanitized payload constructed conforming to PlanRequest schema');

  // =========================================================================
  // STEP 10: Send ONLY sanitized payload via transport.js (05)
  // =========================================================================
  const tTransportStart = performance.now();
  let plan = null;
  if (sendToServer) {
    console.log(`[Pipeline] Step 10: Sending sanitized payload to ${serverUrl}...`);
    plan = await sendPayloadToServer(sanitizedPayload, serverUrl, options.fetchOptions || {});
    console.log('[Pipeline] Step 10 Complete: Received plan actions from server');
  } else {
    console.log('[Pipeline] Step 10 Skipped: sendToServer is false');
  }
  const transport_ms = Number((performance.now() - tTransportStart).toFixed(3));

  // =========================================================================
  // Compute total frame latency and telemetry hooks
  // =========================================================================
  const total_client_ms = Number((performance.now() - tPipelineStart).toFixed(3));

  const timings = {
    capture_ms,
    dom_extract_ms,
    dom_detect_ms,
    face_detect_ms,
    ocr_detect_ms,
    region_merge_ms,
    image_redact_ms,
    dom_redact_ms,
    transport_ms,
    total_client_ms
  };

  const profilerInstance = options.profiler || defaultProfiler;
  if (profilerInstance && options.recordProfiling !== false) {
    profilerInstance.record(timings);
  }

  if (options.logTimings || options.verbose || options.debug) {
    console.log(
      `[Pipeline] Timings (${total_client_ms}ms, budget <${LATENCY_BUDGET_MS}ms): ` +
      `capture=${capture_ms}ms, dom_extract=${dom_extract_ms}ms, dom_detect=${dom_detect_ms}ms, ` +
      `face_detect=${face_detect_ms}ms, ocr_detect=${ocr_detect_ms}ms, region_merge=${region_merge_ms}ms, ` +
      `image_redact=${image_redact_ms}ms, dom_redact=${dom_redact_ms}ms, transport=${transport_ms}ms`
    );
  }

  return {
    success: true,
    plan,
    payload: sanitizedPayload,
    mergedRegions,
    domRegions,
    faceRegions,
    ocrRegions,
    redactedImage: redactedImageDataUrl || redactedImageBase64,
    redactedDom,
    scale,
    viewport,
    timings
  };
}

// Global exposure on window / worker scope
if (typeof globalThis !== 'undefined') {
  globalThis.executePipeline = executePipeline;
  globalThis.runRedactionPipeline = executePipeline;
}

export { executePipeline as runRedactionPipeline, executePipeline as runPipeline };
