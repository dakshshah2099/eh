# 05 — C5: Planner provenance field + `FAIL_ON_VLM_ERROR` flag

**What to build:** `generate_plan` in `vlm_planner.py` returns a `PlanResponse` that is identical whether it came from a live VLM or the heuristic `fallback_plan`. Callers — and evaluation harnesses — cannot distinguish the two, so benchmark runs silently report fallback results as VLM results. The fix adds a mandatory `planner` field to `PlanResponse`:

```python
class PlannerMeta(BaseModel):
    mode: Literal["vlm", "fallback"]
    provider: Optional[str] = None
    model: Optional[str] = None
    reason: Optional[str] = None   # populated only when mode=="fallback"
```

`generate_plan` sets `mode="vlm"` on success and `mode="fallback"` with a `reason` string when falling back. A new env var `FAIL_ON_VLM_ERROR=1` makes the `except` block in `generate_plan` re-raise instead of calling `fallback_plan`, returning an HTTP 500.

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] Every `/api/plan` response body includes a `planner` object with at least `mode` set.
- [x] VLM-generated responses carry `mode: "vlm"` with `provider` and `model` populated.
- [x] Fallback responses carry `mode: "fallback"` and a human-readable `reason`.
- [x] A response schema test (pytest) verifies the `planner` field is always present in both success and fallback paths.
- [x] With `FAIL_ON_VLM_ERROR=1` set and the VLM endpoint unreachable, the endpoint returns a non-200 error, not a fallback plan body.
- [x] The `PlanResponse` Pydantic model is updated; the existing `test_plan.py` tests pass.
