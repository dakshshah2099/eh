# 10 — C10: TTL-based eviction for in-memory step-history store

**What to build:** `_step_history` in `main.py` is an unbounded `dict[str, int]` that grows indefinitely with each unique `session_id:task_id` key received. It does not survive server restart and cannot be shared across workers. For SIH demo scale, add TTL-based eviction: each entry records its last-updated timestamp; entries older than a configurable TTL (default 30 minutes) are evicted lazily on each write and on a periodic sweep. Cap total store size (default 10 000 keys). A full external session store is out of scope.

**Blocked by:** 03 (C3) — the task_id stabilization from C3 is needed so that the composite key correctly tracks steps rather than creating one key per step.

**Status:** done

- [x] `_step_history` entries carry a `last_updated` timestamp alongside the step count.
- [x] On every write, entries older than the TTL are lazily evicted before inserting.
- [x] Total store entry count is capped; oldest entries are evicted when the cap is exceeded.
- [x] TTL and cap are configurable via env vars (`STEP_HISTORY_TTL_SECONDS`, `STEP_HISTORY_MAX_KEYS`).
- [x] A pytest test inserts an entry, advances `time` by TTL+1, triggers the eviction path, and asserts the entry is gone.
- [x] A load test (or equivalent test) drives 10 001 unique keys and asserts store size stays ≤ cap.
- [x] Existing server tests pass.
