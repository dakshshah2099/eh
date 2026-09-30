# 06 — Risky action confirmation gate

**What to build:** Before the agent executes any action classified as risky — submitting a form, triggering a delete or destructive mutation, or navigating away from the current page — it must pause the loop and ask the user to approve or reject the action via the popup. The loop resumes only on approval; on rejection the loop is aborted and control returns to the user.

**Blocked by:** 05 — handover / takeback UX (the popup control-state model and message protocol must exist first)

**Status:** ready-for-agent

- [ ] A **risk policy** classifies each action as safe or risky before execution. At minimum: `submit` (any form submission), `navigate` (full page navigation away from current origin), and any `click` targeting an element whose accessible label or DOM content matches destructive keywords (delete, remove, cancel, logout) are classified as risky. `click`, `type`, `scroll`, and `wait` on non-destructive targets are safe.
- [ ] When the loop is about to execute a risky action, it sends a `CONFIRM_ACTION_REQUIRED` message to the popup containing the action type, the target description, and a plain-English summary of what is about to happen
- [ ] The popup displays a **confirmation modal** over the status log: action summary, **"Allow"** button, and **"Stop agent"** button. The loop is suspended until one is pressed.
- [ ] Clicking **"Allow"** sends `CONFIRM_ACTION_APPROVED` to the background; the loop executes the action and continues
- [ ] Clicking **"Stop agent"** sends `CONFIRM_ACTION_REJECTED` to the background; the loop exits with `TASK_STOPPED` and control returns to the user
- [ ] If the popup is closed while a confirmation is pending, the loop remains suspended (it does not auto-approve). Reopening the popup re-displays the pending confirmation
- [ ] The risk classification logic is unit-tested: at least one safe action and at least one action per risky category are verified
