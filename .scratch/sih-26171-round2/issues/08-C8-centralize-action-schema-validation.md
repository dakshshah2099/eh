# 08 — C8: Centralize action schema validation

**What to build:** `validateAction` is defined in `action_executor.js` and used there. `content_script.js` contains its own validation logic that checks action type and target presence before forwarding messages. The two can drift independently — a new action type added to the executor's `allowedTypes` may not be reflected in the content script's guard, and vice versa. Extract a shared `action_schema.js` module that exports `validateAction` and the canonical `ALLOWED_ACTION_TYPES` set. Both `action_executor.js` and `content_script.js` import from it.

**Blocked by:** 04 (C4) — the canonical `ALLOWED_ACTION_TYPES` set must reflect the final navigate decision.

**Status:** done

- [x] A new `extension/src/action_schema.js` file exports `validateAction` and `ALLOWED_ACTION_TYPES`.
- [x] `action_executor.js` imports `validateAction` from `action_schema.js` instead of defining it locally.
- [x] `content_script.js` uses `ALLOWED_ACTION_TYPES` (or the shared `validateAction`) instead of its own inline type check.
- [x] A test that adds a new action type to `ALLOWED_ACTION_TYPES` in the shared module verifies that both the executor and the content script recognize the new type, without editing two test files.
- [x] Existing tests for both files pass.

