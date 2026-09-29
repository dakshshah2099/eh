# 10 — B10: Server Security & Origin Hardening

**What to build:** Harden the FastAPI server by restricting CORS to valid Chrome Extension origins, requiring API key or session token authentication, preventing payload replays, and enforcing TLS requirements for remote hosts.

**Blocked by:** 01 — B1: Real VLM Planner Backend, 07 — B8: Session-Safe Planner State & History

**Status:** ready-for-agent

## Context & Details
- Target files: `server/main.py`, `server/tests/test_security.py`
- Current behavior: CORS middleware allows wildcard `allow_origins=["*"]`, allowing arbitrary malicious web pages to ping the planner or inspect agent traffic. Endpoints lack authentication.
- Required behavior: Restrict CORS strictly to `chrome-extension://<EXTENSION_ID>` or localhost for local testing. Require Bearer token or API key header on all planner routes. Basic replay / timestamp expiry check.

## Acceptance Criteria
- [ ] CORS middleware restricts allowed origins to configured extension ID / localhost.
- [ ] Unauthorized requests without valid auth header receive HTTP 401 / 403.
- [ ] CORS preflight from unlisted browser origins is rejected.
- [ ] Timestamp / replay validation rejects expired requests (> 60s old).
- [ ] Clear documentation / guardrail enforcing HTTPS / TLS for non-localhost server deployments.
- [ ] Automated security tests verify rejection of unauthenticated and unauthorized origin requests.
