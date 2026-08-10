# Review policy

Every stage requires a recorded user decision. Silence, a tool success response, prior approval of another stage, or an agent's judgment is not approval.

## Review packet

Present:

- stage and revision number;
- paths or previews for every reviewable artifact;
- a short contract checklist with pass/fail evidence;
- continuity, rights, provider, cost, or technical risks;
- exact choices: `approve`, `revise`, `regenerate`, `abort`.

Do not overwhelm the user with raw provider logs. Retain them in the task record and surface decision-relevant facts.

## Decisions

| Decision | Meaning | Required action |
| --- | --- | --- |
| `approve` | Accept this exact revision | Record approval and permit the next stage |
| `revise` | Change plan, text, timing, selection, or assembly | Preserve feedback and targets, create a new revision, review again |
| `regenerate` | Replace generated output while keeping the approved intent | Preserve prompts/settings and targets, create new media, review again |
| `abort` | Stop production | Record the reason; retain all artifacts and history |

Record actionable user wording without weakening it. Use `--targets` for shot IDs, character IDs, lines, files, or other specific scope. If feedback conflicts with the approved upstream contract, explain the invalidation and request confirmation before reopening upstream work.

## Approval constraints

- Never batch-approve multiple stages.
- Never advance on a partial or ambiguous decision.
- Never treat provider selection as creative approval.
- Never overwrite an approved revision; create a traceable successor.
- Never omit negative feedback, rejected variants, or regeneration lineage from the record.
- Re-review every invalidated downstream stage.

