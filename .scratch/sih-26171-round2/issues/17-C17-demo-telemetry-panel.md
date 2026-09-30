# 17 — C17: Demo telemetry panel

**What to build:** During a live demo, judges and reviewers cannot see what the privacy firewall did, which planner generated the action, or what the agent is currently doing. Add a visible telemetry panel — either inside the extension popup or as a side panel — that updates live during a task run and shows three sections:

**Privacy Firewall checklist** — each component with a ✓/✗ status:
- DOM redaction
- Face detection & redaction
- OCR detection & redaction
- Screenshot redaction
- Payload verification (assertPayloadSanitized passed)

**Planner** — sourced from the C5 `planner` provenance field:
- Provider, model, planning latency, mode (vlm / fallback)

**Agent** — sourced from step loop telemetry:
- Current step number, last action type, confidence, task status

**Blocked by:** 05 (C5) — the `planner.mode` provenance field is required to populate the Planner section. 02 (C2) — vision telemetry fields (`vision_backend`, `vision_element_count`) must be present to show vision status. 01 (C1) — the privacy firewall checklist item "screenshot redaction (vision-only regions excluded)" is only meaningful after C1's separation is in place.

**Status:** ready-for-agent

- [ ] A telemetry panel renders in the extension popup or side panel while a task is running.
- [ ] The Privacy Firewall section shows a live ✓/✗ for each of the 5 listed components.
- [ ] The Planner section shows provider, model, mode (`vlm` or `fallback` from C5 `planner.mode`), and planning latency.
- [ ] The Agent section shows the current step count, last action type, confidence, and task status.
- [ ] The panel updates on every step without requiring a page reload.
- [ ] A manual test (or screenshot) confirms the panel renders correctly during a demo run.
