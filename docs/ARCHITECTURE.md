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
  | API  | MCP | manual          output/<task-id>/
        |
        v
generated/imported media ----> FFmpeg QC/export
```

## Components

- **CLI**: exposes `start`, `status`, `resume`, `review`, `providers`, `import`, `export`, and `doctor` through `npm run cartoon -- ...`.
- **MCP server**: exposes the same domain operations for MCP-capable hosts after a build. It is a transport adapter, not a second workflow implementation.
- **Workflow state machine**: permits only the next named stage, retains revisions and decisions, and prevents approval from being inferred.
- **Review ledger**: records the user decision, feedback, targets, time, and artifact revision for every gate.
- **Provider registry**: discovers capabilities and health without persisting resolved secrets. A checked selection is snapshotted before G4.
- **Task workspace**: keeps `project.json`, reducer state, append-only event/artifact ledgers, frozen provider bindings, reviews, revisioned stage artifacts, and final deliverables together under `output/`.
- **FFmpeg boundary**: performs deterministic media inspection, assembly, subtitle handling, and delivery validation.

## State and transitions

The fixed production order is `concept` -> `script` -> `storyboard` -> provider freeze -> `assets` -> `keyframes` -> `clips` -> `audio` -> `edit` -> `qc` -> export. A stage cannot advance until the user explicitly approves its current revision. `revise` and `regenerate` create another review cycle; `abort` retains the task record.

Task files are the recovery boundary. `events.jsonl` is the durable transition history; `state.json` is its current projection. `artifacts.jsonl` inventories immutable approved revisions, and `reviews/` retains user decisions. After interruption, `status` and `resume` use recorded state rather than conversation memory. Do not edit task state by hand.

## Provider boundary

Provider configuration stores environment-variable names, endpoints, models, routes, and capability metadata. It must not store credential values. Direct API jobs are preferred because they can retain request IDs, polling state, retries, and structured errors. MCP and manual results enter through the same import/provenance boundary.

Provider selection is frozen in `provider-bindings.json` after storyboard approval and before `assets`. The freeze prevents silent model drift and cross-stage inconsistency. V1 rejects later rebinding; an unrecoverable route requires a replacement task.

## Trust boundaries

- User approval controls creative advancement; a provider or agent cannot approve.
- Rights evidence controls IP admission; uncertain material is rejected.
- The process environment or external secret manager controls credentials.
- Imported files are untrusted until metadata, integrity, rights, and stage checks pass.
- `output/` is local production data and is intentionally excluded from version control.
