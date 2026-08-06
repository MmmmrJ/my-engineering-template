<!-- loop-config-sha256:211c88f2d4ad0437e1f2b6e91654a060a4dd1d3f901802ca11011d43935cae62 -->
# Loop Constraints

- L1 is report-only and cannot modify governed paths.
- L2 may create an isolated proposal only after an approved task exists.
- Maker and verifier must have distinct session identities.
- Never auto-push or auto-merge.
- Never touch `.env`, secrets, credentials, auth, payments, billing, or migrations.
- Stop on budget exhaustion, repeated errors, no progress, lock conflict, or failed verification.
- Only a named human may resume a paused loop or promote its level.

<!-- loop-config-projection:start -->
# Loop Constraints

- L1 is report-only.
- L2 requires an approved task, isolated worktree, valid lock, attempt ledger, and distinct passing verifier.
- Never auto-push or auto-merge.
- Stop on budget, denylist, lock, breaker, or verification failure.
<!-- loop-config-projection:end -->
