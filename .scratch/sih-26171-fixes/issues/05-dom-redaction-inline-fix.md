# 05 — B5: DOM In-Place Substring Redaction Fix

**What to build:** Fix DOM text redaction so sensitive tokens are substituted in place within text nodes instead of blanking out entire sentences and surrounding context.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Context & Details
- Target files: `extension/src/dom_redaction.js`, `extension/tests/test_dom_redaction.js`
- Current behavior: When sensitive text is detected, elements can have their full text content replaced by a single token, destroying context necessary for planning.
- Required behavior: In-place substring substitution (e.g. `"Contact admin@example.com for support"` -> `"Contact [REDACTED_EMAIL] for support"`).

## Acceptance Criteria
- [ ] Text nodes containing sensitive tokens retain all surrounding non-sensitive words and punctuation.
- [ ] Multiple distinct PII tokens in a single sentence are all replaced in place (e.g. email and phone).
- [ ] All existing and new DOM redaction tests pass without regressions.
- [ ] Regression test added for email-in-sentence: `"Contact admin@example.com for support"` -> `"Contact [REDACTED_EMAIL] for support"`.
- [ ] Regression test added for card-in-sentence: `"Card ending in 4532 0150 9823 8812 charged"` -> `"Card ending in [REDACTED_CARD] charged"`.
