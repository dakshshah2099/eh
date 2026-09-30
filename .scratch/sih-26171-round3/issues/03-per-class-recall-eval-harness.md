# 03 — Per-class recall eval harness (global scope)

**What to build:** An evaluation harness that measures redaction recall and precision per sensitive-element class (face, password field, email address, free-text PII name) across arbitrary real-world pages — not just demo fixtures. The harness must be runnable as a single command and produce a machine-readable report. It must be designed to generalise: pages are fetched live or from a page-snapshot corpus, not hard-coded HTML.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] A corpus of at least 10 test pages is defined — a mix of live URLs and saved snapshots — covering the four sensitive classes. Each page has a ground-truth annotation file listing the expected sensitive regions (type + approximate bounding box or CSS selector)
- [ ] The harness drives the extension pipeline headlessly (via a test runner or puppeteer/playwright script) against each corpus page and collects the detected regions
- [ ] For each class the harness computes recall (missed detections penalise score) and precision (false positives noted but not primary metric, per PS guidance)
- [ ] Results are written to a machine-readable file (JSON) and a human-readable Markdown table, per-class and overall
- [ ] A single command (`npm run eval` or equivalent) runs the full harness and exits non-zero if overall recall falls below a configurable threshold (default 0.85)
- [ ] The harness is documented so a judge can run it independently on a new page set revealed at the finale
- [ ] The corpus and annotations are stored in the repo under `eval/corpus/`; live-URL entries include a fallback snapshot so the harness is not network-dependent at demo time
