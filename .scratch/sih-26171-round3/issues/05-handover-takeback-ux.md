# 05 — Handover / Takeback UX

**What to build:** The popup must provide a clear "hand control to the agent" entry point and an equally clear "take back control" escape hatch. The user types a task, clicks a single button to hand over, watches the live status log while the agent works, and can stop the agent at any point with a second button. The popup must reflect the current control state (idle / agent-running / done) at all times, including across popup close/reopen.

**Blocked by:** 01 — done action + clean loop exit; 04 — live status stream

**Status:** completed

- [x] The popup has a **task input field** (multi-line, placeholder "Describe what the agent should do…") and a **"Hand over to agent"** button, visible only when the agent is idle
- [x] Clicking "Hand over to agent" sends `START_AUTONOMOUS_LOOP` to the background with the task string and transitions the popup to an **agent-running** state
- [x] In agent-running state: the task input and start button are replaced by a **"Take back control"** stop button and the live status log; the task description is shown read-only at the top
- [x] Clicking "Take back control" sends `STOP_AUTONOMOUS_LOOP` to the background; the background exits the loop at the next safe checkpoint (after the current action completes, not mid-action) and sends `TASK_STOPPED` back to the popup
- [x] On `TASK_DONE`, `TASK_EXHAUSTED`, or `TASK_STOPPED`, the popup transitions back to idle state with the outcome shown in the status log
- [x] The agent-running state survives popup close/reopen: reopening the popup during an active loop immediately shows the running state and live log (restored from `chrome.storage.session`)
- [x] The popup correctly shows idle state when no loop is active, even if the extension was just installed or the background was restarted
