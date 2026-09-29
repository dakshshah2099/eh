# 03 — B3: Operational Default OCR

**What to build:** Make on-device OCR detection operational by default without missing dependencies or silent empty-array fallback, enabling visual text redaction across canvas elements, charts, and rendered images.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Context & Details
- Target files: `extension/package.json`, `extension/src/ocr_detector.js`, `extension/tests/test_ocr_detector.js`
- Currently, OCR falls back silently to `[]` if Tesseract / ONNX OCR is unconfigured.
- Must either bundle Tesseract.js cleanly into the extension vendor pipeline or integrate a lightweight ONNX OCR model (e.g. PaddleOCR / TrOCR / quantized text recognition) using the existing ONNX Runtime Web infra.
- Must scan canvas for sensitive text (emails, phones, cards, SSNs) and produce verified bounding boxes.

## Acceptance Criteria
- [ ] Dependencies cleanly installed via `npm install` without manual steps.
- [ ] OCR engine initializes and executes reliably in extension environment (offscreen / worker).
- [ ] Silent `catch (...) { return []; }` replaced with robust execution and fail-closed error propagation.
- [ ] Scanning a test fixture canvas with clear text extracts sensitive keywords and coordinates.
- [ ] Automated test asserts non-empty OCR regions returned for test image containing PII text.
