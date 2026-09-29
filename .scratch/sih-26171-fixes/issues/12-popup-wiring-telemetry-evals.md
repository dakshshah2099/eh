# 12 — B12: Popup Settings Wiring, Multi-Tab & Telemetry Polish

**What to build:** Complete the user-facing integration: wire the popup UI model/provider selectors directly to the server planner, enable multi-tab agent workflows with tab isolation, surface failure telemetry, and expand evaluation scenarios beyond synthetic cases.

**Blocked by:** 01 — B1: Real VLM Planner Backend, 07 — B8: Session-Safe Planner State & History, 10 — B10: Server Security & Origin Hardening

**Status:** ready-for-agent

## Context & Details
- Target files: `extension/src/popup.js`, `extension/src/background.js`, `extension/src/pipeline.js`, `eval/`
- Wire LiteLLM / Ollama provider choices and custom model names in popup UI so changes take immediate effect in planning requests.
- Track distinct tabs independently without clobbering active tab context.
- Surface live telemetry (stage latency, redaction counts, step outcomes, errors) directly in popup and logs.
- Expand end-to-end evaluation suite with multi-step workflows across dynamic web pages.

## Acceptance Criteria
- [ ] Changing provider or model in popup immediately directs planner requests to the selected endpoint.
- [ ] Background agent loop supports operating on multiple tabs or switching tabs cleanly without session collision.
- [ ] Failure states and latency bottlenecks are reported clearly in the popup UI.
- [ ] End-to-end evaluation script runs multi-step tasks across real/mock sites and verifies task completion.
