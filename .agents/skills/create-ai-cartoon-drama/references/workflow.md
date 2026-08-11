# Workflow

Run the stages in order. Strict mode ends every stage in a user decision. Explicit quick mode retains every immutable stage revision but asks the user only at the `storyboard`, `keyframes`, and `qc` bundle checkpoints. `revise` changes the authored plan or text, `regenerate` replaces generated media, and `abort` stops the task without deleting its history.

| Gate | Stage | Folder | Outcome |
| --- | --- | --- | --- |
| G1 | `concept` | `01-concept/` | Approved premise, audience, theme, format, and rights basis |
| G2 | `script` | `02-script/` | Approved timed screenplay and dialogue |
| G3 | `storyboard` | `03-storyboard/` | Approved 8-12 shot plan with continuity and timing |
| Freeze | providers | `provider-bindings.json` | Checked provider/model bindings, frozen before G4 |
| G4 | `assets` | `04-assets/` | Approved character, environment, prop, and style assets |
| G5 | `keyframes` | `05-keyframes/` | Approved shot anchors and visual continuity |
| G6 | `clips` | `06-clips/` | Approved per-shot motion clips |
| G7 | `audio` | `07-audio/` | Approved dialogue, music, SFX, mix plan, and captions |
| G8 | `edit` | `08-edit/` | Approved assembled episode and subtitle timing |
| G9 | `qc` | `09-qc/` | Approved creative, technical, accessibility, and compliance report |
| Export | final | `final/` | Delivery media, subtitles, manifest, and review history |

## Durable loop

1. Inspect: `npm run cartoon -- status <task-id>`.
2. For G1-G3, run `cartoon generate`; otherwise author or generate the current structured contract.
3. Import successful provider outputs with `providers import-output --attempt`; use ordinary `import` only for non-job external files. Supply rights for every file.
4. Show evidence to the user and wait.
5. Record exactly one decision through `review`.
6. Apply feedback to the named targets.
7. Run `resume` and follow its one returned action. Resume, poll, or cancel an obsolete provider attempt, or import its already archived outputs, before considering any new paid request.

An interrupted task must resume from recorded state. Do not reconstruct approvals from chat history or rerun already approved stages unless the user explicitly invalidates them.

`resume-provider-job` reuses the exact request hash, confirmation, and idempotency key. `poll-provider-job` never asks for a new cost confirmation. `cancel-provider-job` prevents an attempt prepared for an obsolete revision from being reused. `import-provider-output` points only to existing task-local archived files and must be completed with the current stage contract before review. It may return several `attemptIds`; repeat `--attempt` so all complete output sets enter one atomic revision, and use metadata `fileNames` when generic archive basenames collide.

For 即梦、可灵、LibLibAI, or macOS 剪映, `resume` may return `execute-provider-handoff`, `confirm-provider-spend`, `poll-provider-handoff`, or `complete-provider-handoff`. Use `$execute-cartoon-platform-handoff`; never infer UI state from chat or a leftover page. The durable manifest, upload hashes, credit confirmation, and safe receipt are the recovery record.

For a manual platform attempt, never write `*.result.json` by hand. Complete it through `cartoon providers complete-manual <task-id> --attempt <attempt-id> --result @result.json`; the command checks the exported files, archives them inside the task, updates the provider ledger, and lets the next `resume` return `import-provider-output`. Fulfill that action with `cartoon providers import-output <task-id> --attempt <attempt-id> [--attempt <attempt-id> ...] --contract @stage-contract.json --metadata @metadata.json`.

## Provider checkpoint

Before `assets`, run:

```powershell
npm run cartoon -- providers list
npm run cartoon -- providers check
npm run cartoon -- providers select <task-id> --provider manual --mode manual
```

Resolve unavailable required capabilities before selection. After selection, keep the frozen profile and model identifiers. V1 rejects provider rebinding; if the selected path cannot recover, preserve the task and offer a replacement task rather than silently switching.
