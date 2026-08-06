---
name: loop-budget
description: Enforce configured per-run and daily Loop limits and pause rather than silently exceeding them.
---

# Loop Budget

- Treat `loop.config.json` as the machine source and `loop-budget.md` as operator guidance.
- Check the budget returned by `loop run prepare` before work.
- Record actual token estimates and action counts at finish.
- At 80% switch to report-only; at a hard cap stop and escalate.
- Never raise, resume, or reset a budget without named human evidence.
