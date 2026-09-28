# 14 - Canvas Image Redaction

**What to build:** Implement a pure function that takes the merged sensitive region list and mutates the image canvas. Draw solid black boxes over passwords and apply a Gaussian blur filter over faces/text.

**Blocked by:** 02 - Screen Capture & Downscale, 13 - Region Merger

**Status:** completed

- [x] Pure function `redactCanvas(canvasOrContext, sensitiveRegions, options)` implemented in `extension/image_redaction.js`
- [x] Sensitive regions on the canvas are visually obscured:
  - Solid black box (`ctx.fillRect`) applied to authentication/secrets (`password`, `pin`, `otp`) with optional text labels
  - Multi-pass separable Gaussian blur, box blur, and strong pixelation (mosaic) applied to faces, emails, phones, cards, and SSNs
- [x] Both standard browser `CanvasRenderingContext2D` / `HTMLCanvasElement` and Service Worker `OffscreenCanvas` supported
- [x] Obscured image is correctly converted back to base64 Data URL or raw base64 string via `redactCanvas(..., { returnType: 'dataUrl' })` and `redactCanvasToDataUrl(...)`
- [x] Comprehensive unit test suite in `extension/test_image_redaction.js` passing with 12/12 tests verifying pixel-level obscuration
