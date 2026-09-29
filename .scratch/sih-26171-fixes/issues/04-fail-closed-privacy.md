# 04 — B4: Fail-Closed Privacy & Transport Boundary

**What to build:** Enforce strict fail-closed privacy guarantees across perception and transport boundaries: abort the pipeline and block outbound network requests if any detector fails, canvas creation errors out, or `assertPayloadSanitized()` detects leakage.

**Blocked by:** None — can start immediately

**Status:** completed

## Context & Details
- Target files: `extension/src/pipeline.js`, `extension/tests/test_pipeline.js`
- Current behavior: When a detector (DOM, face, OCR) throws an error, it is caught and warned with `console.warn`, allowing unredacted screenshots to proceed to server. `assertPayloadSanitized()` only warns on console.
- Required behavior: Hard stop on any failure. Never transmit raw unredacted screenshots or DOM text if any safety stage fails.

## Acceptance Criteria
- [x] Any detector error (DOM, face, OCR) aborts pipeline execution immediately; `fetch()` to server is strictly never called.
- [x] Failure to create canvas or apply redaction throws a fatal `SecurityError`, with zero fallback to raw or unredacted downscaled images.
- [x] `assertPayloadSanitized()` throws an explicit error when sensitive tokens/patterns are detected in outbound payload instead of logging a console warning.
- [x] 3 automated tests added in `test_pipeline.js`:
  - Test 1: Detector throws -> assert `fetch` never called and pipeline rejects.
  - Test 2: Canvas creation/redaction failure -> assert `SecurityError` thrown and `fetch` never called.
  - Test 3: `assertPayloadSanitized` violation -> assert error thrown and `fetch` never called.

