# 01 — C1: Separate UI-vision regions from privacy/redaction regions

**What to build:** Today `pipeline.js` feeds `uiRegions` (ONNX UI detector output, `source:'vision'`) into `mergeSensitiveRegions()` alongside DOM/face/OCR regions, and the merged blob goes directly into `redactCanvas()`. This causes buttons, inputs, and icons to be treated as redaction targets rather than planner inputs, silently degrading both privacy precision and UI grounding. The fix splits the pipeline into two named structures that never touch each other: `privacyRegions` (DOM + face + OCR only → `redactCanvas` + `redaction_map`) and `uiElements` (vision output only → planner payload's `ui_elements`, never `redactCanvas`). After this ticket the outbound payload carries `{redaction_map: [...privacy only], ui_elements: [...]}` and `source:'vision'` items are provably absent from the redaction path.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `mergeSensitiveRegions()` in `region_merger.js` / `pipeline.js` is called with only `domRegions`, `faceRegions`, `ocrRegions` — `uiRegions` is not passed.
- [x] A new `normalizeUIElements(uiRegions)` helper (or equivalent inline transform) prepares vision output for the planner payload.
- [x] `redaction_map` in the outbound payload contains zero items with `source:'vision'`.
- [x] `ui_elements` in the outbound payload contains the normalized vision detections, unredacted.
- [x] A unit test asserts: given non-empty `uiRegions`, the `redaction_map` returned by the pipeline contains no item where `source === 'vision'`, and `ui_elements` is non-empty.
- [x] Existing pipeline tests pass without regression.
