# 02 — C2: Enable UI vision by default in production agent loop

**What to build:** `pipeline.js` step 5B guards `shouldRunVision` behind an explicit `enableVisionInference: true` option. A default invocation through `captureAndSendPlan` / `startLoop` in `background.js` therefore silently skips ONNX UI grounding, so the VLM receives no `ui_elements` array and relies only on the DOM skeleton. The fix makes `enableVisionInference: true` the hard default inside `executePipeline`; callers that genuinely cannot run the ONNX model (no GPU/WASM, test environment) must opt out explicitly with `enableVisionInference: false`. Three telemetry fields are added to every pipeline result: `vision_backend` (string), `vision_inference_ms` (already present as `vision_detect_ms`), and `vision_element_count`.

**Blocked by:** 01 (C1) — must land first so the default-on vision path feeds `ui_elements`, not `redaction_map`.

**Status:** done

- [x] `executePipeline` defaults `enableVisionInference` to `true` when the option is absent.
- [x] `captureAndSendPlan` in `background.js` does not override this default to false.
- [x] A test that calls `executePipeline({})` (no explicit vision option) with a mock `runVisionInference` confirms the mock is invoked.
- [x] The pipeline result includes `vision_backend`, `vision_detect_ms` (already exists), and `vision_element_count` fields in `timings` or a top-level telemetry object.
- [x] Existing tests that pass `uiRegions: []` or `enableVisionInference: false` still pass unchanged.
