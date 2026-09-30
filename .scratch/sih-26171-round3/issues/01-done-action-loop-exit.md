# 01 — `done` action type + clean loop exit

**What to build:** The LLM planner must be able to signal that a task is complete by returning a `done` action. The autonomous loop in the background must recognise this action, stop cleanly, and notify the popup that the task finished (not just exhaust the step counter). The server prompt must instruct the VLM to emit `done` when it determines the task goal has been achieved.

**Blocked by:** None — can start immediately

**Status:** completed

- [x] `done` is a valid action type in the shared action schema (alongside `click`, `type`, `scroll`, `wait`, `navigate`)
- [x] The server-side planner prompt instructs the VLM to return `{ action: "done", reason: "<why task is complete>" }` when the visible page state satisfies the original task goal
- [x] The background autonomous loop exits immediately when it receives a `done` action, without waiting to exhaust `maxSteps`
- [x] On `done`, the background sends a `TASK_DONE` message to the popup with the step count and the reason string
- [x] On step-count exhaustion (no `done` received), the background sends a `TASK_EXHAUSTED` message instead — distinct from `TASK_DONE`
- [x] Existing action schema tests still pass; a new test covers the `done` action round-trip
