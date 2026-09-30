# 02 — Redaction-aware VLM prompt

**What to build:** The server-side planner prompt must communicate the redaction scheme to the VLM. When the payload includes redacted regions, the prompt must describe each region's bounding box and its type (e.g. password field, face, email address, free-text PII) so the VLM can reason over the anonymised page structure rather than treating blank areas as absent content.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] The `PlanRequest` redacted regions list (already transmitted) is formatted into a human-readable section injected into the VLM system/user prompt, e.g. "The following regions have been redacted for privacy: [region descriptions with normalised coordinates and type]"
- [ ] The prompt instructs the VLM to treat redacted regions as present-but-hidden content and to still plan actions that target them (e.g. type into a password field even though its value is masked)
- [ ] The prompt section is omitted when the redacted regions list is empty, producing no prompt regression for unredacted pages
- [ ] A server unit test asserts that a payload with two redacted regions of different types produces a prompt string containing both region descriptions
- [ ] Existing server tests still pass
