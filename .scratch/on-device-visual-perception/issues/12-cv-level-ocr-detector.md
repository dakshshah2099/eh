# 12 - CV-Level OCR Detector

**What to build:** Implement CV-level OCR detector in `extension/ocr_detector.js`. Scan image/canvas/OCR output for sensitive text using regex (email, phone, credit card, SSN) and return sensitive bounding box regions `[{ bbox: [x,y,w,h], category: 'email'|'phone'|'card'|'ssn', source: 'ocr', confidence: float }]`.

**Blocked by:** 02 - Screen Capture & Downscale

**Status:** completed

- [x] Regex matching flags email, phone, credit card, and SSN
- [x] Priority ordering prevents false-positive phone matches inside cards/SSNs
- [x] Bounding box computation with word-level union and proportional fallback
- [x] Lightweight canvas foreground text segmentation and Tesseract/custom recognizer support
- [x] Standardized output schema with normalized confidence and [x,y,w,h] bboxes
