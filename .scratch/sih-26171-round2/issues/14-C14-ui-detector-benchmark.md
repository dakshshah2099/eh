# 14 — C14: Real-world UI detector benchmark

**What to build:** The only UI ONNX model calibration so far is a blank-image false-positive sanity check. That does not establish whether the ~68 KB model generalizes to real pages. Build a benchmark harness that runs the detector against at least 4 real-page categories and reports precision, recall, mAP, average IoU, and false-positive-per-viewport counts. Page categories to cover: forms (signup/login/checkout), e-commerce product pages, dashboards (analytics/admin), and at least one of: banking UI, news site, social feed, modal dialogs, responsive/dark-mode/mobile viewports.

**Blocked by:** 01 (C1) — the benchmark must verify that `uiRegions` from the detector remain in the planner path and never enter the redaction path (C1 invariant).

**Status:** ready-for-agent

- [ ] A benchmark script exists (e.g. `eval/benchmark_ui_detector.js` or `eval/benchmark_ui_detector.py`).
- [ ] The benchmark runs against at least 4 of the named page categories using real (or publicly accessible) pages captured as screenshots — not synthetic blank images.
- [ ] Metrics reported per category: precision, recall, mAP (if ground-truth annotations are available), mean IoU, false-positives per viewport.
- [ ] A benchmark report (`eval/ui_detector_benchmark_report.md`) exists summarizing the results.
- [ ] The report explicitly notes that `source:'vision'` regions are passed to `ui_elements` and absent from `redaction_map` (C1 invariant check).
- [ ] The benchmark does not use mocked ONNX inference; it must run the actual packaged ONNX model.
