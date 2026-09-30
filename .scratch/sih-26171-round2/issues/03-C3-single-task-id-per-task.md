# 03 — C3: Single `task_id` per task, not per step

**What to build:** Inside `startLoop` in `background.js`, the line `const taskId = opts.taskId || opts.task_id || \`task_${Date.now()}\`` sits inside the `while` loop, so each step generates a new timestamp-based ID. The server's `_step_history` composite key therefore sees a fresh key every step, fragmenting step tracking and preventing any server-side task-level session state from accumulating correctly. The fix moves the ID generation above the loop — once per `startLoop` call — and threads the same `sessionId`/`taskId` pair into every `captureAndSendPlan` call within that task's lifetime.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `taskId` is derived / generated exactly once, before the `while` loop in `startLoop`.
- [x] Every `captureAndSendPlan` call within the loop receives the same `task_id` value.
- [x] A test drives a 3-step loop and asserts that every outbound `planResult.payload.task_id` is identical across all steps.
- [x] `sessionId` is also derived once per `startLoop` call (not regenerated per step).
- [x] Existing loop tests pass.
