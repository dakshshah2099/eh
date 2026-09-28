## Problem Statement

Users need a browser agent capable of automating complex, multi-step web tasks (like logging into portals or filling out profiles) using the latest server-side Vision-Language Models (VLMs). However, sending raw screen captures and DOM trees to external servers exposes highly sensitive Personally Identifiable Information (PII) such as passwords, faces, credit card numbers, and emails.

## Solution

A local, privacy-preserving browser extension that acts as a secure "lens." It uses local, on-device vision models (via Transformers.js and WebGPU) and DOM heuristics to detect sensitive elements. It redacts these elements (blurring image regions, substituting text with tokens) *before* sending the sanitized payload to the server-side VLM. The server plans actions based on the redacted layout, and the extension executes them locally.

## User Stories

1. As a security-conscious user, I want the extension to run entirely local ML models for PII detection, so that my raw data never leaves the browser process.
2. As a user, I want password fields to be automatically black-boxed in screenshots, so that my credentials cannot be intercepted by the server.
3. As a user, I want faces to be blurred out locally, so that identity is preserved.
4. As a user, I want email, phone, and credit card texts in the DOM to be replaced with generic tokens, so the AI reasoner knows what the field is without knowing its value.
5. As a server-side AI model, I want to receive a clean schema mapping bounding boxes to redacted tokens, so that I can instruct the extension to click or type into the right fields.
6. As a developer, I want the extension to fallback to WASM if WebGPU is unavailable, so that the agent still runs on older hardware.

## Implementation Decisions

- **Browser Extension Platform:** Manifest V3 (Chrome/Firefox compatible).
- **Local Vision/ML Stack:** Transformers.js v4 running in a background service worker/offscreen document, utilizing ONNX Runtime Web with a WebGPU backend (fallback to WASM-SIMD).
- **Vision Models:** Quantized (int8) YOLO-style detector or CLIP-lite (<50MB) for UI element grounding. BlazeFace ONNX for local face detection.
- **OCR:** Local 	esseract.js for on-screen text parsing to catch PII not visible in the pure DOM tree.
- **Redaction Strategy:** 
  - Canvas-level: Draw black boxes (passwords) or Gaussian blur (faces, PII text) using bounding boxes.
  - DOM-level: Mutate a JSON skeleton of the DOM, replacing matched regex with [REDACTED_*] tokens.
- **CSP Workaround:** Bundle all WASM/ONNX helper files inside the extension to satisfy Manifest V3 CSP constraints.
- **Action Schema:** Strict JSON schema for server responses ({ "actions": [ { "type": "click", "target_bbox": [x,y,w,h] } ] }).

## Testing Decisions

- **Seams for Testing:**
  1. **Client Capture (Offline):** Assert capture + redaction logic completely sanitizes mock DOMs/images.
  2. **Server Planner:** Assert server logic correctly handles placeholder tokens without requesting raw data.
  3. **Client Executor:** Assert JSON payload perfectly translates to DOM interactions.
- **Eval Harness:** A local Playwright script running against a custom demo HTML form containing seeded PII. It will log the payload going to the server to guarantee 0% raw PII leakage (precision/recall metric).

## Out of Scope

- A massive server-side VLM implementation (we assume a stand-in cloud API or local open-weight model for the server side).
- Complex multi-tab management (restricted to active tab for now).
- CAPTCHA solving.

## Further Notes
The latency budget is strictly <150ms per frame for local inference on a mid-range laptop. Model quantization is mandatory.
