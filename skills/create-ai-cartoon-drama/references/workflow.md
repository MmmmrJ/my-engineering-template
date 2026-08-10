# Workflow

Run the stages in order. Each stage ends in a user decision; approval opens the next stage. `revise` changes the authored plan or text, `regenerate` replaces generated media, and `abort` stops the task without deleting its history.

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
2. Author or generate the current contract.
3. Import external files with metadata when the CLI did not create them.
4. Show evidence to the user and wait.
5. Record exactly one decision through `review`.
6. Apply feedback to the named targets.
7. Run `resume` and repeat.

An interrupted task must resume from recorded state. Do not reconstruct approvals from chat history or rerun already approved stages unless the user explicitly invalidates them.

## Provider checkpoint

Before `assets`, run:

```powershell
npm run cartoon -- providers list
npm run cartoon -- providers check
npm run cartoon -- providers select <task-id> --provider manual --mode manual
```

Resolve unavailable required capabilities before selection. After selection, keep the frozen profile and model identifiers. V1 rejects provider rebinding; if the selected path cannot recover, preserve the task and offer a replacement task rather than silently switching.
