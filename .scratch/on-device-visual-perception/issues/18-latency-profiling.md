# 18 - Latency Profiling Hooks

**What to build:** Instrument performance.now() around the extension's capture, inference, and redaction phases. Provide a debug log to assert that the entire client-side processing loop takes <150ms per frame.

**Blocked by:** 16 - Redaction Pipeline Wiring

**Status:** completed

- [x] Execution time per major module is logged
- [x] Total frame latency is calculated and exposed
