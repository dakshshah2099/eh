# 09 — B9: Capability-Based Secret Fill

**What to build:** Capability-based secret autofill protocol where the planner instructs the browser to fill fields using secret tokens (`FILL_FIELD(target, SECRET_ALIAS)`), while actual passwords/credentials are retrieved from a secure local vault in the extension and never leave the browser.

**Blocked by:** 01 — B1: Real VLM Planner Backend, 06 — B7: Stable Action Schema & Coordinate Space

**Status:** ready-for-agent

## Context & Details
- Target files: `extension/src/action_executor.js`, `extension/src/background.js`, `server/main.py`, tests
- Cleartext credentials (passwords, PINs, auth keys) must never be sent to the planning server, nor returned in actions.
- Client maintains local secure credential store (`chrome.storage.session` or vault).
- When a sensitive field requires typing, the planner emits an action like: `{"type": "fill_secret", "target": {"element_id": "pwd_input"}, "secret_key": "ACCOUNT_PASSWORD"}`.
- Extension resolves `ACCOUNT_PASSWORD` locally, focuses the element, and simulates human input directly.

## Acceptance Criteria
- [ ] Protocol supports `fill_secret` or capability-based fill action.
- [ ] Local credential vault stores secret mappings securely in extension memory/session storage.
- [ ] Cleartext secret strings never appear in `PlanRequest` or `PlanResponse` payloads.
- [ ] Safe typing simulator correctly populates input value and triggers input/change/blur events in page.
- [ ] Automated test asserts zero raw secret leakage in network traffic across a full login form task.
