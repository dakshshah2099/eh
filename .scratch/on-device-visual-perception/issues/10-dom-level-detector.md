# 10 - DOM-Level Detector

**What to build:** Implement a pure function that scans the DOM skeleton. It applies rules (`type=password`, autocomplete matching `cc-*|email|tel`, `type=email,tel,number(if card/pin)`, and name/id/aria-label/placeholder regex for `ssn|social|card|cvv|cvc|otp|pan|pin|password|secret|tax`) to flag sensitive elements. Returns a list: `[{ bbox: [x,y,w,h], category: string, source: 'dom', confidence: 1.0, selector: string }]`.

**Blocked by:** 03 - DOM Skeleton Extraction

**Status:** completed

- [x] Pure function `detectSensitiveDomElements(domSkeleton)` implemented in `extension/dom_detector.js`
- [x] Function correctly flags password inputs (`type=password` -> category: 'password')
- [x] Autocomplete attributes correctly matched (`cc-*`, `email`, `tel`)
- [x] Input types correctly classified (`email`, `tel`, and `number` when named/labeled card or pin)
- [x] Attribute regex matching against `ssn|social|card|cvv|cvc|otp|pan|pin|password|secret|tax`
- [x] Standardized output schema with `[x,y,w,h]` bounding box, category, source='dom', confidence=1.0, and selector
- [x] Comprehensive test suite in `extension/test_dom_detector.js` and root `test_dom_detector.js` passing
