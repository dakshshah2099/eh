# 16 - Redaction Pipeline Wiring

**What to build:** Intercept the payload right before the HTTP transport step (from Ticket 05). Pass the image through the Canvas Redaction (14) and the DOM through Text Substitution (15). Send ONLY the redacted payload to the server.

**Blocked by:** 05 - Client-to-Server Transport, 14 - Canvas Image Redaction, 15 - DOM Text Substitution

**Status:** completed

- [x] The final payload sent over the network contains zero raw PII
- [x] Server receives the redaction_map correctly
