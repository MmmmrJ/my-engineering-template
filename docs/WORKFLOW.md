# Workflow

## 1. Preflight

Install Node.js 22, then run:

```powershell
npm ci
npm run cartoon -- doctor
```

The normal `npm ci` path installs optional portable FFmpeg/ffprobe binaries. `doctor` reports whether it selected an explicit, environment, managed, or system toolchain. For enterprise, container, offline, or remote-render deployment, see [FFmpeg deployment](FFMPEG_DEPLOYMENT.md).

Proceed only with an original IP controlled by the user or an IP proven public domain for the intended use. Confirm the theme, audience, language, and distribution intent. Voice cloning is disabled by default and requires separate consent evidence plus explicit confirmation.

## 2. Start

```powershell
npm run cartoon -- start --ip "Paper Lantern Town" --theme "Courage means asking for help"
npm run cartoon -- start --ip "Paper Lantern Town" --theme "Courage means asking for help" --review-mode quick
```

Retain the returned `<task-id>`. Use these recovery commands at any time:

```powershell
npm run cartoon -- status <task-id>
npm run cartoon -- status <task-id> --json
npm run cartoon -- resume <task-id>
```

For the current G1-G3 stage, generate the validated baseline revision:

```powershell
npm run cartoon -- generate <task-id> --metadata @rights-metadata.json
```

Rights metadata is required for G1. In strict mode, generated revisions stop at `awaiting_review`. In quick mode, validated `concept` and `script` revisions receive auditable `quick-policy` approvals and the workflow stops at `storyboard` to review the complete creative bundle.

## 3. Run the gated sequence

| Gate | Stage | Review focus |
| --- | --- | --- |
| G1 | `concept` | IP basis, premise, theme, audience, scope |
| G2 | `script` | Story, dialogue, timing, safety, feasibility |
| G3 | `storyboard` | 8-12 shots, duration, framing, continuity |
| Freeze | providers | Health, capability coverage, model/profile selection |
| G4 | `assets` | Character/environment/prop/style consistency and rights |
| G5 | `keyframes` | Shot composition and continuity anchors |
| G6 | `clips` | Motion, duration, identity, artifacts, handles |
| G7 | `audio` | Performance, pronunciation, mix, sync, captions, rights |
| G8 | `edit` | Pacing, transitions, subtitle safety, delivery draft |
| G9 | `qc` | Creative, technical, accessibility, and compliance evidence |

In strict mode, present every current revision and wait for one explicit decision. In quick mode, present the complete bundles at G3, G5, and G9; non-checkpoints remain individually versioned and policy-audited:

```powershell
npm run cartoon -- review <task-id> --stage <stage-id> --decision approve
npm run cartoon -- review <task-id> --stage <stage-id> --decision revise --feedback "<feedback>" --targets "<ids>"
npm run cartoon -- review <task-id> --stage <stage-id> --decision regenerate --feedback "<feedback>" --targets "<ids>"
npm run cartoon -- review <task-id> --stage <stage-id> --decision abort --feedback "<reason>"
```

Record all feedback and apply it to the named targets. Do not infer a decision from silence. Run `resume` after recording a decision that permits more work. If it returns `resume-provider-job`, `poll-provider-job`, `cancel-provider-job`, or `import-provider-output`, complete that durable action before submitting another request. Provider attempts are bound to the next stage revision; obsolete nonterminal attempts must be cancelled, never imported into a later revision.

For a browser/desktop platform handoff, complete the queued attempt without editing task ledgers:

```powershell
npm run cartoon -- providers complete-manual <task-id> --attempt <attempt-id> --result @result.json
```

## 4. Freeze providers before G4

After G3 approval and before creating assets:

```powershell
npm run cartoon -- providers list
npm run cartoon -- providers check
npm run cartoon -- providers select <task-id> --provider manual --mode manual
```

Use explicit repeated `--binding` values for a mixed route and bind `render.timeline` to `local-ffmpeg:api` when local rendering is healthy. Add the optional `quality.inspect=local-ffmpeg:api` binding in that same initial selection when G9 QC should run through provider jobs. These routes create G4/G5 contact sheets, G6 proxy assemblies, the G8 timeline, and G9 QC evidence through provider `estimate`/`submit`/`poll` commands. Each new local submit needs an explicit known zero-cost confirmation.

Do not fail over after selection. V1 does not mutate a frozen binding; preserve the blocked task and offer retry, wait, the already-selected manual route, or a replacement task.

## 5. Import external results

For a successful API, MCP, or manual provider attempt, import the entire verified output set through its ledger identity:

```powershell
npm run cartoon -- providers import-output <task-id> --attempt <attempt-id> [--attempt <attempt-id> ...] --contract @stage-contract.json --metadata @metadata.json
```

Use ordinary `cartoon import` only for files that do not claim a durable provider job. Repeat `--attempt` to combine complete successful output sets for the same stage revision in one atomic import. When archive basenames collide, metadata `fileNames` assigns unique contract basenames by source path. The strict stage contract records required IDs, timing, upstream coverage, file references, automatic checks, and blocking issues. Metadata must provide rights for every file, either through one `rights` record or `fileRights`; provider/model/job identity is derived from the ledger for provider outputs. Import does not approve an artifact.

## 6. Export

After the user approves G9:

```powershell
npm run cartoon -- export <task-id>
```

Verify the delivery video, burned-in captions, SRT sidecar, manifest/provenance, and review record in `output/<task-id>/final/v001/` (or its later approved revision). Outputs are ignored by Git; publish or archive them through an intentional external process.
