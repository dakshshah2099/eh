# Test Harness & Demo Page (Ticket 17)

Local static test environment for validating DOM-level and Vision-level PII detection and redaction pipelines.

## Contents
- `index.html`: Web page seeded with sensitive personal and financial data.
- `assets/styles.css`: Dashboard styling and highlight overlays.
- `assets/face.svg`: High-detail vector face portrait for computer vision face detection tests.
- `server.js`: Zero-dependency static server with mock `/api/telemetry` endpoint.

## Seeded PII Summary
- **Credentials:** Email (`type="email"`), Password (`type="password"`), Security PIN (`type="password"`).
- **Identity & Biometrics:** Human portrait (SVG / Canvas), Full Name, Phone (`type="tel"`), SSN (`987-65-4321`), DOB.
- **Financial:** Credit Card Number (`4532 0150 9823 8812`), Expiry, CVV (`842`), Bank Account, Routing Number.
- **Unstructured / Free Text:** Medical note with embedded names, emails, addresses, phones, and credit card numbers.
- **Manifest:** Exposed at `window.__PII_MANIFEST__` and `<script id="pii-manifest">` for automated test assertions (e.g. Playwright Ticket 19).

## Running the Server

### Option 1: Node.js (Built-in server)
```bash
node demo/server.js
# Or specify port:
PORT=3000 node demo/server.js
```

### Option 2: Python
```bash
python -m http.server 8080 --directory demo
```

Visit: [http://localhost:8080](http://localhost:8080)
