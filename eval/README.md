# Redaction Evaluation Suite (Ticket 19)

Automated end-to-end evaluation runner using Playwright and Google Chrome to validate zero PII leakage and 100% precision/recall on the demo test harness.

## Features
- **Test Harness Integration:** Spawns demo server and loads `demo/index.html` with seeded credentials, biometrics, financial info, and PII.
- **Client Perception Pipeline Execution:** Runs the complete 10-step on-device perception and privacy redaction pipeline (Ticket 16).
- **Network Interception:** Intercepts client-to-server payload transmitted to `/api/plan`.
- **Dual DOM and Pixel Inspection:** Programmatically inspects both the serialized DOM JSON and canvas image bounding boxes.
- **Zero Leakage Assertion:** Verifies 0% raw string token leakage from `window.__PII_MANIFEST__`.
- **Accuracy Reporting:** Automatically generates `eval_report.json` and `eval_summary.md`.

## Running the Evaluation
```bash
cd eval
npm test
# Or:
node run_redaction_eval.js
```
