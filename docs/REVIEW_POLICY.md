# Review policy

Human review is a state transition, not a courtesy notification. `strict` is the compatibility default and requires an explicit user decision on all nine stages. `quick` must be explicitly selected at task creation and uses three user bundle checkpoints: `storyboard` reviews G1-G3, `keyframes` reviews G4-G5, and `qc` reviews G6-G9.

In quick mode, every non-checkpoint revision still passes the same structured contract, rights, and dependency validation. The workflow then appends an immutable `review.recorded` event with actor `quick-policy`; it does not pretend the user approved it. `resume` names the complete bundle at each checkpoint, and the user may revise or regenerate any bundled stage. Legacy tasks and tasks without a mode are strict.

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
- In strict mode, do not batch-approve stages. In quick mode, only the declared policy may approve validated non-checkpoints; a provider or conversational agent cannot do so.
- Do not advance while requested changes remain unapplied.
- Do not overwrite the review history or omit rejected/regenerated lineage.
- Do not change a frozen provider silently.
- Do not waive a blocking rights, safety, or technical failure.

## Invalidation

Feedback can invalidate downstream work. A script change may reopen storyboard through QC; a character asset change may reopen keyframes through QC; an audio-only fix may reopen audio, edit, and QC. Explain the impact, obtain confirmation when upstream scope changes, mark affected approvals stale, then review each replacement stage again.

Provider selection is separate from creative review. V1 treats it as immutable after the freeze and requires a replacement task when a selected route cannot recover.

Payment confirmation is also separate: each new potentially chargeable generation job requires an explicit estimate acknowledgement. Reusing the same persisted provider job for polling, download, or crash recovery does not.
