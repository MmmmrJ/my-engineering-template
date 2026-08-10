# Review policy

Human review is a state transition, not a courtesy notification. Each of the nine stages requires its own explicit user decision on the exact current revision.

## Required review packet

For every gate, provide:

1. stage and revision identifier;
2. direct artifact paths or practical previews;
3. contract checklist with evidence;
4. material creative, continuity, rights, cost, provider, or technical risks;
5. choices: `approve`, `revise`, `regenerate`, or `abort`.

Retain raw logs in the task workspace. Surface the facts needed for a decision without hiding failures or overwhelming the user.

## Decision semantics

- `approve`: accept only the reviewed revision and unlock the next transition.
- `revise`: change authored intent, selection, text, timing, or assembly; create and review a new revision.
- `regenerate`: replace generated output within approved intent; preserve lineage and review the replacement.
- `abort`: stop safely while keeping task state, artifacts, and the reason.

Use `--feedback` for the user's actionable wording and `--targets` for the affected shot, character, line, file, or other IDs. Ask a concise follow-up when a decision or target is ambiguous.

## Non-negotiable rules

- Do not infer approval from silence, enthusiasm, tool success, or prior-stage approval.
- Do not batch-approve stages or let an agent/provider approve on the user's behalf.
- Do not advance while requested changes remain unapplied.
- Do not overwrite the review history or omit rejected/regenerated lineage.
- Do not change a frozen provider silently.
- Do not waive a blocking rights, safety, or technical failure.

## Invalidation

Feedback can invalidate downstream work. A script change may reopen storyboard through QC; a character asset change may reopen keyframes through QC; an audio-only fix may reopen audio, edit, and QC. Explain the impact, obtain confirmation when upstream scope changes, mark affected approvals stale, then review each replacement stage again.

Provider selection is separate from creative review. V1 treats it as immutable after the freeze and requires a replacement task when a selected route cannot recover.

Payment confirmation is also separate: each new potentially chargeable generation job requires an explicit estimate acknowledgement. Reusing the same persisted provider job for polling, download, or crash recovery does not.
