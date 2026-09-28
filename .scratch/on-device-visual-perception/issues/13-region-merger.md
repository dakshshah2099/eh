# 13 - Region Merger

**What to build:** Implement a pure function to merge the DOM (10), Face (11), and OCR (12) sensitive region lists. Deduplicate overlapping bounding boxes (e.g., if DOM and OCR both flag an email) and assign a final confidence score.

**Blocked by:** 10 - DOM-Level Detector, 11 - CV-Level Face Detector, 12 - CV-Level OCR Detector

**Status:** completed

- [x] Pure function `mergeSensitiveRegions(domRegions, faceRegions, ocrRegions, options)` implemented in `extension/region_merger.js`
- [x] Function outputs a single, clean array of sensitive regions: `[{ bbox: [x,y,w,h], category: string, source: string, confidence: number }]`
- [x] Deduplicates overlapping bounding boxes using IoU (>= 0.3) and containment (>= 0.8) thresholds
- [x] Merging takes the union bounding box enclosing all overlapping boxes
- [x] Resolves category hierarchy/priority (`password > pin > otp > card > ssn > tax > email > phone > face`)
- [x] Combines detection sources canonically (e.g. `dom+ocr`, `dom+face`, `dom+ocr+face`)
- [x] Adjusts corroborating confidence scores probabilistically (`1 - prod(1 - c_i)`) or via configured strategy
- [x] Deterministic sorting by visual reading order (top-to-bottom, left-to-right), confidence, or category
- [x] Unit test suite in `extension/test_region_merger.js` passing with 13/13 tests
