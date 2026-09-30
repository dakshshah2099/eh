# 07 — C7: Action-risk policy (classify + confirmation gate)

**What to build:** There is currently no step between planner output and executor dispatch that classifies action risk or halts for confirmation. A VLM can propose a "submit payment" click and it executes immediately. Add a policy-validator layer between `generate_plan` returning and `executeAction` running. Classify actions into three tiers based on action type + contextual signals from the task description and target element semantics:

- **low**: `scroll`, `wait`, `read` — pass through.
- **medium**: `type`, `navigate` — log and pass through (or require soft confirmation in interactive mode).
- **high**: actions whose target selector, element text, task string, or reason field matches payment/purchase/delete/send-message/change-password patterns — must be gated behind an explicit confirmation callback before execution.

Add `risk` and `requires_confirmation` fields to the action schema. The confirmation gate is a caller-supplied async callback (`opts.onConfirmAction`) that receives the classified action; absence of callback for a high-risk action is a hard block.

**Blocked by:** 04 (C4) — `navigate` risk tier depends on whether navigate is live or removed. 01 (C1) — the policy validator must read `ui_elements` (not redaction map) for element semantics.

**Status:** done

- [x] A `classifyActionRisk(action, context)` function exists and returns `{risk, requires_confirmation}`.
- [x] The executor (or a pre-executor wrapper) calls `classifyActionRisk` and adds the fields to the action before dispatch.
- [x] High-risk actions without a confirmation callback throw a `ConfirmationRequired` error before `executeAction` is called.
- [x] A test fixture simulating a "Submit Payment" click action is blocked pending confirmation.
- [x] A `scroll` action passes through without confirmation.
- [x] `risk` and `requires_confirmation` appear in the action object returned from the classification step.
- [x] Existing executor tests pass.
