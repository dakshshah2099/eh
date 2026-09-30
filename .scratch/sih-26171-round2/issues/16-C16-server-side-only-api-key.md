# 16 — C16: Move provider API key to server-side-only config

**What to build:** The current flow sends the VLM provider API key from the extension popup through `buildPayload` → `PlanRequest.api_key` → `generate_plan(api_key=...)`. For the SIH demo deployment the API key should live only on the trusted server, not transit the browser. The fix has two parts: (1) server-side: read the provider credential from env at startup (`VLM_API_KEY`, already present) and stop accepting `api_key` from `PlanRequest` (drop the field or ignore it when a server-side key is set); (2) extension-side: the popup's LLM config UI should no longer ask for or store a raw provider API key — only a server auth token (`SERVER_API_KEY`) is needed by the extension.

**Blocked by:** 05 (C5) — C5 restructures `generate_plan` signatures; land first to avoid conflicts.

**Status:** done

- [x] When `VLM_API_KEY` is set on the server, `PlanRequest.api_key` from the client is ignored (server env takes precedence).
- [x] `PlanRequest.api_key` is removed or marked deprecated; the server logs a warning if a client supplies it while server env key is set.
- [x] The extension popup's LLM configuration form does not contain a field for the upstream provider API key.
- [x] `buildPayload` / `transport.js` does not include `api_key` in the outbound payload when the server-key mode is active.
- [x] A test confirms: with `VLM_API_KEY` set in server env, a request containing `api_key: "client-key"` uses the env key (not the client key) in the VLM call.
- [x] README / `.env.example` documents the server-key-only deployment pattern.
