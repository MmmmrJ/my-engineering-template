# Architecture

This repository is a single-controller, review-gated production workflow. Node.js 22 runs the CLI and MCP surfaces; FFmpeg validates and assembles delivery media. Production is intentionally serial in v1. Runtime subagents are out of scope.

```text
user / coding agent
        |
        v
CLI or MCP surface
        |
        v
workflow state machine -----> review ledger
        |                           |
        v                           v
provider registry ----------> task workspace
  | local | API | MCP | manual       output/<task-id>/
        |
        v
generated/imported media ----> FFmpeg QC/export
```

## Components

- **CLI**: exposes `start`, `status`, `resume`, `generate`, `review`, `providers`, `import`, `export`, and `doctor` through `npm run cartoon -- ...`.
- **MCP server**: exposes the same domain operations for MCP-capable hosts after a build. It is a transport adapter, not a second workflow implementation.
- **Workflow state machine**: permits only the next named stage, retains validated structured contracts, revisions and decisions, and prevents approval from being inferred.
- **Default stage generator**: creates replaceable, deterministic G1-G3 baseline contracts from IP/theme and approved upstream contracts; media stages remain provider/manual work and are never fabricated.
- **Review ledger**: records the user decision, feedback, targets, time, and artifact revision for every gate.
- **Provider registry**: discovers capabilities and health without persisting resolved secrets. A checked selection is snapshotted before G4.
- **Task workspace**: keeps `project.json`, reducer state, append-only event/artifact ledgers, frozen provider bindings, reviews, revisioned stage artifacts, and final deliverables together under `output/`.
- **FFmpeg boundary**: the task-scoped `local-ffmpeg` adapter performs deterministic contact-sheet creation, media inspection, timeline/subtitle assembly, and delivery validation through the same durable provider-job surface as external providers.

## State and transitions

The fixed production order is `concept` -> `script` -> `storyboard` -> provider freeze -> `assets` -> `keyframes` -> `clips` -> `audio` -> `edit` -> `qc` -> export. Strict tasks need a user approval at every stage. Explicit quick tasks policy-approve only schema-valid non-checkpoints and require the user at G3/G5/G9; the actor is recorded so policy and human decisions cannot be confused. `revise` and `regenerate` create another review cycle; `abort` retains the task record.

Task files are the recovery boundary. `events.jsonl` is the durable transition history; `state.json` is its current projection. `artifacts.jsonl` inventories immutable approved revisions, and `reviews/` retains user decisions. After interruption, `status` and `resume` use recorded state plus `provider-jobs.jsonl`; resume surfaces an exact submit-resume, poll, or archived-output import action before new work. Do not edit task state by hand.

## Provider boundary

Provider configuration stores environment-variable names, endpoints, models, routes, and capability metadata. It must not store credential values. Direct API jobs are preferred because they can retain request IDs, polling state, retries, and structured errors. MCP and manual results enter through the same import/provenance boundary.

Provider selection is finalized after storyboard approval and before `assets`. The append-only `provider.profile_frozen` event, state projection, and explicit `frozen` marker in `provider-bindings.json` make completion distinguishable from a partial map. The freeze prevents silent model drift and cross-stage inconsistency. V1 rejects later additions or rebinding; an unrecoverable route requires a replacement task.

The provider execution manager scopes the global `local-ffmpeg` descriptor to the selected task before execution. Requests use strict versioned JSON and task-relative paths; raw executable arguments are never accepted. Output files are created immutably and recorded in `provider-jobs.jsonl` with hashes and executor receipts.

Rendering may be frozen to a remote API/MCP/manual route while final trust validation remains local. The local boundary resolves explicit, environment, npm-managed, then system FFmpeg tools. A remote QC report never bypasses inspection of the downloaded immutable MP4 and its current subtitle hashes.

## Trust boundaries

- User approval controls creative advancement; a provider or agent cannot approve.
- Rights evidence controls IP admission; uncertain material is rejected.
- The process environment or external secret manager controls credentials.
- Imported files are untrusted until metadata, integrity, rights, and stage checks pass.
- `output/` is local production data and is intentionally excluded from version control.
