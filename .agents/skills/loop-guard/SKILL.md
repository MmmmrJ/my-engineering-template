---
name: loop-guard
description: Record Loop attempts and enforce deny paths, task approval, locks, iteration limits, and no-progress circuit breakers.
---

# Loop Guard

1. For L2, create the run and worktree before the maker acts.
2. Record every attempt with `loop run attempt`; never retry after exit code 2.
3. Run `loop gate` before any proposal or write boundary.
4. A write requires an approved current task, a run ledger, a held worktree lock, and independent passing verification.
5. Denylist, file-count, budget, lock, and breaker failures are fail-closed human escalations.
