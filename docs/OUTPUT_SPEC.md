# Output specification

Every task lives under `output/<task-id>/`. `output/` is ignored by Git except for its placeholder. Treat the task folder as local production data that may contain prompts, generated media, user feedback, and provider metadata.

## Fixed layout

```text
output/<task-id>/
|-- project.json
|-- state.json
|-- events.jsonl
|-- artifacts.jsonl
|-- provider-jobs.jsonl
|-- provider-bindings.json
|-- generation/
|-- reviews/
|-- 01-concept/v001/
|-- 02-script/v001/
|-- 03-storyboard/v001/
|-- 04-assets/v001/
|-- 05-keyframes/v001/
|-- 06-clips/v001/
|-- 07-audio/v001/
|-- 08-edit/v001/
|-- 09-qc/v001/
`-- final/v001/
```

The numbered stage directory names and order are stable. Revisions increase monotonically (`v002`, `v003`, ...); an approved revision is immutable.

## Task records

- `project.json`: immutable intake identity and production defaults, including IP and theme.
- `state.json`: current workflow projection used by `status` and `resume`.
- `events.jsonl`: append-only state-transition and invalidation history.
- `artifacts.jsonl`: append-only artifact inventory and provenance ledger.
- `provider-jobs.jsonl`: append-only prepared/submitted/polled provider attempt ledger used by unified resume.
- `provider-bindings.json`: checked provider/model selection frozen before G4.
- `generation/`: durable baseline G1-G3 review packets before their immutable revision copies.
- `reviews/`: stage/revision decisions, feedback, targets, and review evidence.

Each artifact record contains its ID, type, relative path, SHA-256 hash, MIME type, byte size, source, stage and revision, provider/model/job identity, prompt hash and seed when applicable, rights/provenance, timestamps, and cost when known. Use these records instead of discovering artifacts by filename.

For selective repair, artifact metadata may declare stable `targetIds` (the shots/assets represented) and `dependsOnIds` (IDs that invalidate an aggregate such as a contact sheet, proxy assembly, or final timeline). A scoped replacement revision copies forward only unaffected immutable artifacts and records `derivedFromArtifactId`; visual-only shot repair does not invalidate an already approved audio stage.

## Stage artifact rules

- Keep artifacts in the directory for the stage that owns them.
- Keep stable character, location, prop, shot, and revision IDs.
- Persist one validated `schemaVersion: 1` stage contract on every revision; imports without it are rejected before review.
- Never modify an approved revision. Write the replacement to the next revision directory and retain its lineage.
- Record provider/tool, concrete model, request/resource ID, prompt/settings, source, checksum when available, and rights notes for generated or imported files.
- Keep rejected candidates when needed to explain review/regeneration history; do not present them as approved.
- Use the CLI `import` command for files created outside the workflow.

## Delivery profile

| Property | Required value |
| --- | --- |
| Language | `zh-CN` |
| Aspect ratio | `9:16` |
| Duration | 60-90 seconds; target 75 seconds |
| Shot count | 8-12; default 10 |
| Frame size | 1080x1920 |
| Frame rate | 30 fps |
| Video | H.264 (`libx264`), `yuv420p` |
| Audio | AAC, 48 kHz |
| Subtitles | `zh-CN` SRT sidecar and burned-in captions |

## `final/vNNN/` contract

Export only after G9 approval. The final folder must make these deliverables discoverable:

- publishable episode video matching the delivery profile;
- burned-in subtitle version when separate from the master;
- SRT sidecar;
- delivery manifest with media properties and checksums;
- provider/provenance summary;
- complete stage review history and any explicit waivers.

Do not claim completion if a required delivery is missing or if QC lists an unresolved blocking issue.
