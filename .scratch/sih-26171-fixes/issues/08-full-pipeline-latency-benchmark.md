# 08 — B6: Real Full-Pipeline Latency Benchmark

**What to build:** Comprehensive end-to-end latency profiler that instruments every stage of execution on actual hardware with live models, reporting mean, p50, p95, and p99 timings against the target latency budget.

**Blocked by:** 01 — B1: Real VLM Planner Backend, 02 — B2: UI Vision Model Pipeline Integration, 03 — B3: Operational Default OCR

**Status:** ready-for-agent

## Context & Details
- Target files: `extension/src/profiler.js`, `extension/src/pipeline.js`, `extension/tests/test_latency_profiling.js`
- Stages to instrument with `performance.now()`:
  1. Capture & downscale
  2. DOM skeleton extraction
  3. DOM sensitivity detection
  4. UI element vision model inference
  5. Face model inference
  6. OCR detection
  7. Region merger
  8. Image canvas redaction
  9. DOM text substitution
  10. Payload serialization & transport
  11. VLM planner response
  12. Action execution in DOM
- Must generate verifiable benchmarking summary from live browser executions, not synthetic stubs.

## Acceptance Criteria
- [ ] Profiler instruments all 12 stages cleanly without skewing pipeline execution.
- [ ] Telemetry logs breakdown per step and aggregate task stats (mean, p50, p95, p99).
- [ ] Automated benchmark test runs a full multi-step loop and outputs real hardware measurements.
- [ ] Alerts or flags any stage exceeding its allocated budget.
