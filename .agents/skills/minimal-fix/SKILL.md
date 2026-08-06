---
name: minimal-fix
description: Produce the smallest isolated patch for one explicit, low-risk, verifiable problem without unrelated refactoring.
---

# Minimal Fix

Use this skill only for one explicit L2 fix target after intake and triage have established a verifiable goal.

## Preconditions

- Apply `loop-constraints` and `loop-guard` first.
- Require the current human-approved task, authorized paths, isolated worktree, held lock, and prepared attempt ledger.
- Confirm the exact failure, reviewer finding, or acceptance mismatch and the checks that prove it fixed.
- If the target is ambiguous, consequential, denylisted, or outside configured size limits, stop and escalate.

## Process

1. Reproduce or confirm the failure without changing governed files.
2. Identify the narrow root cause and record the intended files before editing.
3. Change only what is required for that cause; do not perform drive-by cleanup, dependency upgrades, formatting sweeps, or contract changes.
4. Run the smallest relevant checks, then every check required by governance for the affected surface.
5. Record the diff, commands, exit codes, risks, and remaining uncertainty in the attempt evidence.
6. Hand the patch to a distinct `loop-verifier`; never approve, push, merge, or mark your own fix complete.

## Stop Rules

- Record every failed attempt through `loop-guard`; never retry after a fail-closed exit.
- Stop on repeated error, no progress, budget threshold, path expansion, lock loss, or a required test that cannot run.
- A needed scope, contract, data-model, interaction, or acceptance change requires a new plan version and human confirmation.

## Output Contract

Return the target, files changed, minimal diff rationale, verification commands and results, risk, and the independent verifier handoff.
