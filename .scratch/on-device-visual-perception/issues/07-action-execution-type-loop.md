# 07 — Action Execution (Type & Loop)

**What to build:** Implement the 	ype action in the content script. Crucially, include a safety check that refuses to type into fields marked as redacted/sensitive unless specifically authorized. Wire up the loop to trigger the next capture once the action finishes.

**Blocked by:** 05 — Client-to-Server Transport, 06 — Action Execution (Click & Scroll)

**Status:** completed

- [x] Extension safely simulates typing into input fields
- [x] After action completion, the system loops back to capture the next frame
