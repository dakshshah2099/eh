# 02 — B2: UI Vision Model Pipeline Integration

**What to build:** Integrate the on-device quantized UI element vision detector (`vision_inference.js`) into the primary perception pipeline (`pipeline.js`) so UI bounding boxes (buttons, inputs, icons) are detected on every frame and unified into the canonical region map before redaction and planning.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Context & Details
- Target files: `extension/src/pipeline.js`, `extension/src/vision_inference.js`, `extension/tests/test_pipeline.js`
- Currently, `runVisionInference()` is never invoked in `pipeline.js`.
- Vision-detected UI elements must be run on the captured canvas and merged alongside DOM regions, face regions, and OCR regions.
- Detected UI elements must be assigned `source: "vision"` and carried forward to server payload for grounding.

## Acceptance Criteria
- [ ] `runVisionInference` is called on every captured frame in `pipeline.js`.
- [ ] Vision-detected UI elements are mapped across downscale coordinates.
- [ ] UI regions are merged with DOM, face, and OCR detections prior to canvas redaction.
- [ ] Payload sent to server includes `ui_elements` / `source: "vision"` regions.
- [ ] Unit test spies on `runVisionInference` and asserts it is called once per pipeline iteration.
- [ ] Fixture test with a visible button/icon confirms presence of `source: "vision"` in merged results.
