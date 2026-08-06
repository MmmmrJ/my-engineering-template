---
name: loop-verifier
description: Independently verify an L2 Loop proposal in a distinct session and report command evidence without approving or merging it.
---

# Loop Verifier

- The verifier session identity must differ from the maker session identity.
- Inspect the complete diff and confirm it stays inside approved task ownership and Loop policy.
- Run the configured checks in isolation; record commands, exit codes, and artifacts.
- Reject unrelated changes, disabled tests, missing evidence, deny paths, or unaccepted risk.
- A passing verifier permits a proposal to continue through existing QA and user gates; it does not approve, push, or merge.
