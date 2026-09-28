# 08 - ONNX Web Runtime Setup

**What to build:** Add Transformers.js / ONNX Runtime Web to the extension (likely in an offscreen document for WebGPU access). Bundle the WASM helper files to bypass MV3 CSP restrictions. Confirm WebGPU initializes.

**Blocked by:** 01 - Extension Scaffolding

**Status:** completed

- [x] ONNX Runtime Web loads without CSP errors
- [x] WebGPU backend initializes successfully (with WASM fallback)
