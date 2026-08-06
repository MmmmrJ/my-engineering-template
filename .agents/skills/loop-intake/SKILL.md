---
name: loop-intake
description: Clarify an ambiguous Loop item into one bounded, testable goal before triage or action, and escalate instead of guessing.
---

# Loop Intake

Use this skill before triage or action when an item lacks a verifiable definition of done, exact scope, required evidence, or a decision-critical value.

## Intake Process

1. Read the complete item, prior `STATE.md` context, `loop.config.json`, and `loop-constraints.md`; do not re-ask facts already recorded.
2. Identify the single most decision-blocking gap and ask one behavior-focused question at a time.
3. Require concrete scope, values, and observable acceptance evidence. Do not turn a vague product goal into an implementation choice.
4. Stop when the goal can be expressed as one testable sentence with bounded paths or systems and an objective completion check.
5. Hand a clarified item to `loop-triage`; do not approve a task, start a maker, or infer human consent.

## Escalation

- If the answer remains ambiguous, record the open question through the configured Human Inbox flow and mark the item `needs-human`.
- If clarification changes product scope, contracts, interactions, data, or acceptance criteria, return it for a new human-approved plan version.
- Respect `loop-constraints` and `loop-budget`; intake never authorizes denylisted or over-budget work.

## Output Contract

Return:

- `Goal`: one testable sentence.
- `Done when`: observable evidence and required checks.
- `Scope`: repository, branch, paths, and external systems in bounds.
- `Open questions`: unresolved decisions with `needs-human`, or `none`.

When no blocking gap exists, state that intake is complete and pass the unchanged item to triage.
