# 09 - Vision Model Inference

**What to build:** Load a small, quantized (int8) vision model (e.g., YOLO-lite or CLIP-lite) via Transformers.js. Run inference on the downscaled canvas image to extract UI element bounding boxes and labels.

**Blocked by:** 02 - Screen Capture & Downscale, 08 - ONNX Web Runtime Setup

**Status:** completed

- [x] Quantized model loads into browser memory (<50MB)
- [x] Inference successfully returns bounding boxes for UI elements
