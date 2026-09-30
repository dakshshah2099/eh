# 09 — C9: Nonce-based replay protection

**What to build:** `main.py` rejects requests whose `timestamp` is more than 60 seconds old. But within that 60-second window, an attacker who intercepts a valid signed request can replay it an unlimited number of times. Add `nonce` to `PlanRequest` and maintain a short-lived nonce cache on the server. A nonce seen a second time — even within its TTL — is rejected with HTTP 400.

Implementation notes:
- The nonce cache can be an in-memory `dict[str, float]` (nonce → first-seen timestamp).
- TTL for the cache entries should match the timestamp window (60 s) so entries can be evicted lazily on each request.
- The extension (`transport.js` / `buildPayload`) must generate and attach a nonce per request.
- Nonce is a random string (e.g. 16-byte hex); server does not need to validate its format beyond being a non-empty string.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] `PlanRequest` includes an optional `nonce: Optional[str]` field.
- [x] When `nonce` is present, the server rejects a second request carrying the same `nonce` value within the TTL window with HTTP 400.
- [x] The nonce cache evicts entries older than 60 s (lazy or scheduled).
- [x] `buildPayload` / `transport.js` attaches a fresh random nonce to every request.
- [x] A pytest test replays an identical valid request within the timestamp window and asserts the second attempt receives HTTP 400.
- [x] Existing `test_security.py` tests pass.

