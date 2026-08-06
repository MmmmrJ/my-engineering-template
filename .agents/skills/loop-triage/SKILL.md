---
name: loop-triage
description: Run a bounded, report-only scan for one configured Loop pattern and write structured findings without changing governed paths.
---

# Loop Triage

1. Read `loop.config.json`, `STATE.md`, `loop-constraints.md`, and the selected pattern.
2. Call `loop run prepare <pattern>` before scanning. A duplicate run is a successful no-op.
3. L1 may read and report only. Never modify governed paths, approve a task, push, or merge.
4. Separate actionable findings, watch items, and noise. Ambiguous or consequential work goes to `loop inbox add`.
5. Finish every prepared run with exact counts and one allowed outcome.
6. Stop immediately on exit code 2 and preserve the escalation reason.
