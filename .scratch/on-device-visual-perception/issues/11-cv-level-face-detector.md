# 11 - CV-Level Face Detector

**What to build:** Implement CV-level face detector in `extension/face_detector.js`. Load BlazeFace / lightweight ONNX face detector (<5MB) via ONNX Runtime Web / Transformers.js setup (using WebGPU with WASM fallback). Detect human faces on image canvas / base64 and return `[{ bbox: [x,y,w,h], category: 'face', source: 'cv', confidence: float }]`. Integrate with `offscreen.js`.

**Blocked by:** 02 - Screen Capture & Downscale, 08 - ONNX Web Runtime Setup

**Status:** completed

- [x] Lightweight BlazeFace ONNX model loads into browser memory (<5MB)
- [x] WebGPU backend initialization with automatic WASM fallback
- [x] Human face detection on canvas / ImageData and Base64 encoded images
- [x] Standardized sensitive detection output: `[{ bbox: [x,y,w,h], category: 'face', source: 'cv', confidence: float }]`
- [x] IoU computation and Non-Maximum Suppression (NMS) to eliminate duplicate face regions
- [x] Offscreen document integration and message routing (`LOAD_FACE_MODEL`, `RUN_FACE_DETECTION`, `DETECT_FACES`)
