# 06 — B7: Stable Action Schema & Coordinate Space

**What to build:** Formalize the action schema and coordinate space protocol between server and extension: prioritize `element_id` over bboxes, validate actions strictly, and explicitly declare coordinate spaces to avoid scaling conflation.

**Blocked by:** 01 — B1: Real VLM Planner Backend

**Status:** ready-for-agent

## Context & Details
- Target files: `extension/src/transport.js`, `extension/src/action_executor.js`, `server/main.py`, tests
- Planner actions must target `element_id` primarily (e.g. `{"type": "click", "target": {"element_id": "ui_37"}}`); bounding box is fallback only.
- Payloads must explicitly declare `coordinate_space` (`"viewport"` vs `"canvas_scaled"`), `viewport: { width, height }`, and `image: { width, height, scale }`.
- Action executor must validate action types, target presence, bounding box bounds, confidence ranges, cap max-actions per response, and sanitize selectors to prevent script injection.

## Acceptance Criteria
- [ ] Schema validator rejects malformed actions (invalid bbox format/ranges, invalid type, missing target).
- [ ] Selector safety check prevents script/attribute injection in selector queries.
- [ ] Actions referencing valid `element_id` resolve to DOM elements directly without relying on fragile pixel coordinates.
- [ ] Coordinate conversion utility handles translation between image downscaled space and browser viewport accurately.
- [ ] Automated tests assert rejection of invalid actions and successful execution of `element_id`-targeted actions.
