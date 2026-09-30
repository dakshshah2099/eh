# 13 — C13: Real packaged-extension OCR test (fresh Chrome profile)

**What to build:** Existing OCR tests import `ocr_detector.js` as a Node module with a mocked Tesseract worker. They do not verify that a freshly-loaded, fully packaged Chrome extension can resolve Tesseract worker/core/lang assets (`eng.traineddata`) at the Chrome extension `chrome-extension://` URL scheme. A packed-asset path resolution bug would silently cause OCR to return empty results in production. Add a real packaged-extension test using Playwright's `--load-extension` flag: load the extension into a fresh Chrome profile, navigate to a page with known text, trigger OCR via the extension's background script, and assert a non-empty result.

**Blocked by:** 01 (C1) — the OCR region output feeds the privacy pipeline; the test should confirm `ocrRegions` reaches the correct (privacy) path after C1 lands.

**Status:** ready-for-agent

- [ ] A new test file (e.g. `eval/test_ocr_packaged_extension.js`) exists and is runnable with `npm test` or `npx playwright test`.
- [ ] The test loads the extension into a fresh ephemeral Chrome profile (not an existing profile).
- [ ] The test navigates to a page with a predictable text string (can be a local test server or `data:` page).
- [ ] The test confirms the OCR result contains the expected text (non-empty, or the specific known string).
- [ ] The test is labeled or documented as distinct from existing unit-level OCR tests and must not use mocked Tesseract workers.
- [ ] The test passes in a local run (CI note: may require `--headed` flag or Xvfb in CI; document the requirement).
