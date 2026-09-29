# 11 — B11: UI Detector Benchmark & Threshold Calibration

**What to build:** Calibrate vision model confidence thresholds and Non-Maximum Suppression (NMS) parameters against a labeled UI benchmark dataset, reducing false-positive detections on blank or uniform canvas areas to near-zero while maintaining high recall on actual buttons, inputs, and icons.

**Blocked by:** 02 — B2: UI Vision Model Pipeline Integration

**Status:** ready-for-agent

## Context & Details
- Target files: `extension/src/vision_inference.js`, `extension/tests/test_vision_inference.js`
- Current behavior: On uniform or gradient backgrounds, the quantized detector proposes low-confidence phantom UI boxes.
- Required behavior: Calibrate pre/post-processing, class-specific score thresholds, and IoU overlap limits against benchmark images.

## Acceptance Criteria
- [ ] False positive rate on blank, uniform, or pure gradient images drops to zero.
- [ ] Recall on standard UI components (buttons, text fields, icons) remains high (> 90% on benchmark set).
- [ ] NMS deduplication effectively eliminates double-counted elements.
- [ ] Benchmark test suite measures and asserts precision and recall targets across test fixtures.
