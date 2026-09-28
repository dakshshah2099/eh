# 19 - Redaction Eval Scripts

**What to build:** Write an automated test runner (e.g., Playwright) that runs the extension against the demo page (17). It must intercept the outgoing network requests and programmatically assert that 0% of the raw PII from the HTML page made it into the payload.

**Blocked by:** 16 - Redaction Pipeline Wiring, 17 - Test Harness & Demo Page

**Status:** completed

- [x] Playwright script runs the end-to-end flow
- [x] Test fails if any raw PII is found in the intercepted network payload
