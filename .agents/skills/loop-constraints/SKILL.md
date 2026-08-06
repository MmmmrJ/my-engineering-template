---
name: loop-constraints
description: Load and enforce the repository Loop constraints before triage, proposals, writes, pushes, or completion decisions.
---

# Loop Constraints

Apply this skill at the start of every Loop run and again before crossing a write, proposal, push, or completion boundary.

## Source And Precedence

1. Read `loop.config.json` as the machine source, then read `loop-constraints.md` and the selected pattern.
2. Run `loop validate --strict` when the contract or generated projection may be stale.
3. Apply the stricter rule when pattern, budget, governance, and repository constraints overlap.
4. Human overrides require named, current evidence and cannot be inferred from silence or a previous task.

## Enforcement

- Stop immediately for a kill switch, denylisted path, missing approval, budget hard cap, lock conflict, exhausted breaker, or failed verification.
- L1 is report-only and cannot modify governed paths.
- L2 requires an approved current task, allowed paths, isolated worktree, held lock, attempt ledger, and a distinct verifier before a proposal may advance.
- Never touch secrets, credentials, auth, payments, billing, or migrations through a Loop.
- Never disable tests, hide evidence, auto-push, auto-merge, or treat verifier approval as user approval.

Before editing, re-check path ownership and deny rules. Before proposing, re-check scope, file-count, checks, budget, and verifier evidence. Before push or merge, stop unless the existing human-controlled workflow explicitly authorizes that exact action.

## Failure Mode

Missing or unreadable constraint sources are fail-closed: record the reason, finish the prepared run with an allowed escalated outcome when possible, and hand off to a human. Do not substitute remembered defaults for the repository contract.

Report the loaded sources and any blocking rule in the run evidence.
