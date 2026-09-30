# 15 — C15: Real end-to-end VLM + latency benchmark

**What to build:** The existing "5+ step novel task" server test in `test_plan.py` uses mocked VLM responses. It proves the request/response protocol is wired correctly but says nothing about real task-solving ability or actual latency. Build a separate benchmark harness using a real local VLM (Ollama + llama3.2-vision or equivalent), fixed public benchmark websites, and ground-truth action sequences. Measure and report:

- **Task success rate** (% of tasks where the correct final state is reached)
- **Step count** (actual vs. minimum steps)
- **Wrong-action rate**
- **Recovery rate** (% of tasks that recover from a wrong action)
- **PII leakage** (any raw PII in the payload sent to VLM)
- **Full-stack latency** broken into named phases: `capture → DOM → vision → face → OCR → merge → redact → serialize → network → VLM → validate → execute`, as mean / p50 / p95 / p99

The report must explicitly distinguish "client-side perception latency" from "true end-to-end task latency" so it cannot be confused with the existing ~35ms synthetic number.

**Blocked by:** 05 (C5) — the `planner.mode` field is required to confirm VLM (not fallback) results are being measured. 02 (C2) — vision must be on by default for the benchmark to reflect production behavior. 07 (C7) — risk classification must be wired so high-risk benchmark tasks are not accidentally auto-executed.

**Status:** ready-for-agent

- [ ] A benchmark harness script exists (e.g. `eval/e2e_benchmark.py` or `eval/e2e_benchmark.js`).
- [ ] The harness uses a real VLM via the configured server endpoint (not a mock).
- [ ] At least one fixed, publicly accessible website is used as a benchmark target.
- [ ] The report covers all 6 listed task-quality metrics.
- [ ] Latency is broken into the named phases (at minimum capture, VLM, and execute) as mean/p50/p95/p99.
- [ ] The report explicitly labels a "client-side perception latency" number and a separate "true end-to-end task latency" number, with definitions.
- [ ] The benchmark report file (`eval/e2e_benchmark_report.md`) confirms `planner.mode == "vlm"` for every measured run (i.e. not fallback).
- [ ] The harness is documented with setup instructions (VLM endpoint config, target URL, ground-truth format).
