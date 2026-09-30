# 04 — Background → popup live status stream

**What to build:** While the autonomous loop runs, the popup must receive real-time step-by-step status messages from the background so the user can see what the agent is doing. Each pipeline step that produces a meaningful event — action decided, action executed, loop done, loop exhausted — must be surfaced in the popup UI as a timestamped status line.

**Blocked by:** 01 — done action + clean loop exit (the `TASK_DONE` / `TASK_EXHAUSTED` message types must exist first)

**Status:** ready-for-agent

- [ ] The background sends a `AGENT_STATUS` message to the popup at each meaningful loop event: step started, action decided (with action type and target), action executed, task done, task exhausted, loop error
- [ ] The popup listens for `AGENT_STATUS` messages via `chrome.runtime.onMessage` and appends each event to a visible status log panel (scrollable, timestamped)
- [ ] `TASK_DONE` renders as a green "✓ Done — {reason}" entry; `TASK_EXHAUSTED` renders as an amber "⚠ Step limit reached" entry; errors render red
- [ ] The status log is cleared when a new task is started
- [ ] When the popup is closed and reopened mid-task, the status log is restored from the last N events stored in `chrome.storage.session` (so the user does not lose context)
- [ ] No status message contains raw PII from the page (action targets are reported as selector strings or element types, not field values)
