<!-- loop-config-sha256:211c88f2d4ad0437e1f2b6e91654a060a4dd1d3f901802ca11011d43935cae62 -->
# Loop Budget

`loop.config.json` is the machine source. This file explains the operator contract.

| Pattern | Runs/day | Tokens/run | Tokens/day | Attempts | Actions/day |
|---|---:|---:|---:|---:|---:|
| harness-health | 4 | 50,000 | 100,000 | 1 | 0 |
| daily-triage | 2 | 50,000 | 100,000 | 1 | 0 |
| ci-sweeper | 4 | 200,000 | 500,000 | 3 | 1 |

- At 80%, downgrade to report-only.
- At the hard cap, pause and write a human escalation.
- A controller cannot raise its own budget.
- Resume requires named human evidence.

<!-- loop-config-projection:start -->
# Loop Budget

| Pattern | Runs/day | Tokens/run | Tokens/day | Attempts | Actions/day |
|---|---:|---:|---:|---:|---:|
| harness-health | 4 | 50000 | 100000 | 1 | 0 |
| daily-triage | 2 | 50000 | 100000 | 1 | 0 |
| ci-sweeper | 4 | 200000 | 500000 | 3 | 1 |

At 80% the controller becomes report-only; at 100% it pauses.
<!-- loop-config-projection:end -->
