import * as ort from '../vendor/ort/ort.all.min.mjs';
import * as transformers from '../vendor/transformers/transformers.min.js';
import { downscaleImage } from '../src/downscale.js';
import { runVisionInference, loadVisionModel, getVisionSession } from '../src/vision_inference.js';
import { detectFaces, loadFaceModel, getFaceSession } from '../src/face_detector.js';

export { runVisionInference, loadVisionModel, getVisionSession };
export { detectFaces, loadFaceModel, getFaceSession };

// Global references for debugging and external access
globalThis.ort = ort;
globalThis.transformers = transformers;

/**
 * Resolve base URL for WASM assets in extension context.
 */
export function getWasmPath() {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
    return chrome.runtime.getURL('vendor/ort/');
  }
  return '../vendor/ort/';
}

const wasmPath = getWasmPath();

// Configure ONNX Runtime Web environment
if (ort?.env?.wasm) {
  ort.env.wasm.wasmPaths = wasmPath;
  // numThreads = 1 prevents SharedArrayBuffer / COOP/COEP isolation errors in MV3
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
}

// Configure Transformers.js environment
if (transformers?.env) {
  transformers.env.allowLocalModels = true;
  transformers.env.useBrowserCache = true;
  if (transformers.env.backends?.onnx?.wasm) {
    transformers.env.backends.onnx.wasm.wasmPaths = wasmPath;
    transformers.env.backends.onnx.wasm.numThreads = 1;
    transformers.env.backends.onnx.wasm.simd = true;
  }
}

/**
 * Check WebGPU support with fallback to WASM.
 * Validates navigator.gpu, requests adapter and device.
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
              device: adapter.info.device || 'unknown',
              description: adapter.info.description || 'WebGPU Adapter'
            };
          } else if (adapter.requestAdapterInfo) {
            try {
              const info = await adapter.requestAdapterInfo();
              adapterInfo = {
                vendor: info.vendor || 'unknown',
                architecture: info.architecture || 'unknown',
                device: info.device || 'unknown',
                description: info.description || 'WebGPU Adapter'
              };
            } catch {
              adapterInfo = { description: 'WebGPU Device' };
            }
          } else {
            adapterInfo = { description: 'WebGPU Device' };
          }

          // Clean up test device
          if (device.destroy) {
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
    webgpuReason = 'navigator.gpu not available in current environment';
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

let runtimeState = {
  initialized: false,
  backend: null,
  executionProviders: [],
  details: null,
  error: null
};

/**
 * Initialize ONNX runtime and select WebGPU or WASM backend.
 */
export async function initRuntime() {
  try {
    const backendStatus = await detectBackend();
    runtimeState = {
      initialized: true,
      backend: backendStatus.selectedBackend,
      executionProviders: backendStatus.executionProviders,
      details: backendStatus,
      error: null
    };

    console.log(`[Offscreen] ONNX Web Runtime initialized. Backend: ${runtimeState.backend}`);
    return { success: true, ...runtimeState };
  } catch (err) {
    runtimeState = {
      initialized: false,
      backend: 'wasm',
      executionProviders: ['wasm'],
      details: null,
      error: err.message
    };
    console.error('[Offscreen] ONNX Web Runtime initialization failed:', err);
    return { success: false, error: err.message };
  }
}

export function getRuntimeState() {
  return runtimeState;
}

// Extension message listener
if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target && message.target !== 'offscreen') {
      return false;
    }

    switch (message.type) {
      case 'CHECK_RUNTIME':
      case 'INIT_ONNX': {
        (async () => {
          if (!runtimeState.initialized) {
            await initRuntime();
          }
          sendResponse({ success: true, state: runtimeState });
        })();
        return true; // Asynchronous sendResponse
      }

      case 'OFFSCREEN_DOWNSCALE': {
        (async () => {
          try {
            const result = await downscaleImage(
              message.imageSource,
              message.maxDimension ?? 768,
              message.options ?? {}
            );
            sendResponse({ success: true, ...result });
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
        })();
        return true;
      }

      case 'LOAD_VISION_MODEL': {
        (async () => {
          try {
            const meta = await loadVisionModel(message.options ?? {});
            sendResponse({ success: true, meta });
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
        })();
        return true;
      }

      case 'RUN_VISION_INFERENCE': {
        (async () => {
          try {
            const detections = await runVisionInference(
              message.image ?? message.imageSource,
              message.options ?? {}
            );
            sendResponse({ success: true, detections });
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
        })();
        return true;
      }

      case 'LOAD_FACE_MODEL': {
        (async () => {
          try {
            const meta = await loadFaceModel(message.options ?? {});
            sendResponse({ success: true, meta });
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
        })();
        return true;
      }

      case 'RUN_FACE_DETECTION':
      case 'DETECT_FACES': {
        (async () => {
          try {
            const detections = await detectFaces(
              message.image ?? message.imageSource,
              message.options ?? {}
            );
            sendResponse({ success: true, detections });
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
        })();
        return true;
      }

      case 'PING_OFFSCREEN': {
        sendResponse({ success: true, timestamp: Date.now() });
        return false;
      }

      default:
        if (message.target === 'offscreen') {
          sendResponse({ success: false, error: `Unknown offscreen message type: ${message.type}` });
        }
        return false;
    }
  });
}

// Auto-initialize when document loads in browser
if (typeof document !== 'undefined') {
  initRuntime().then(res => {
    const statusEl = document.getElementById('status');
    if (statusEl) {
      statusEl.textContent = `ONNX Runtime ready [Backend: ${res.backend}]`;
    }
  }).catch(err => {
    const statusEl = document.getElementById('status');
    if (statusEl) {
      statusEl.textContent = `ONNX Runtime init error: ${err.message}`;
    }
  });
}
