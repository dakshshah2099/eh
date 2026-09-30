# 04 — C4: Implement `navigate` properly (or remove it entirely)

**What to build:** `validateAction` in `action_executor.js` lists `'navigate'` in `allowedTypes` and the VLM system prompt in `vlm_planner.py` advertises it as a valid action. However, `executeAction`'s `switch` has no `case 'navigate':` — the action is validated and accepted then falls through to the `default` branch, which throws "Unsupported action type". The VLM therefore proposes navigation steps that silently fail. Choose one path:

**Option A — Implement it:** Add `case 'navigate':` that (a) validates the URL against an allowlist (`http:`, `https:` only; explicitly rejects `javascript:`, `data:`, `file:`, `chrome:`, `chrome-extension:`) in a single shared validation function called by both the validator and the executor, then (b) invokes `chrome.tabs.update({url})` or equivalent. Scheme validation must live in exactly one place.

**Option B — Remove it:** Delete `'navigate'` from `allowedTypes`, remove the `navigate` example from the VLM system prompt, and remove the `url` field from `ActionItem` in `vlm_planner.py`. Tests confirm no code path advertises or validates `navigate`.

The agent must pick one option and implement it completely; do not leave it partially in either state.

**Blocked by:** None — can start immediately.

**Status:** closed

- [x] If implemented: a URL with scheme `javascript:`, `data:`, `file:`, `chrome:`, or `chrome-extension:` is rejected before reaching the executor, at validation time.
- [x] If implemented: scheme validation exists in exactly one place (not duplicated in validator + executor).
- [x] If implemented: the VLM system prompt lists `navigate` and its required fields accurately.
- [ ] If removed: `validateAction` does not list `'navigate'` in `allowedTypes`.
- [ ] If removed: `vlm_planner.py` system prompt and `ActionItem` schema contain no reference to `navigate` or `url`.
- [x] A test covers either the blocked-scheme rejection (if implemented) or the "navigate produces a validation error" case (if removed).
- [x] Existing tests pass.
