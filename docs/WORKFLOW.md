# Workflow

## 1. Preflight

Install Node.js 22 and FFmpeg, then run:

```powershell
npm ci
npm run cartoon -- doctor
```

Proceed only with an original IP controlled by the user or an IP proven public domain for the intended use. Confirm the theme, audience, language, and distribution intent. Voice cloning is disabled by default and requires separate consent evidence plus explicit confirmation.

## 2. Start

```powershell
npm run cartoon -- start --ip "Paper Lantern Town" --theme "Courage means asking for help"
```

Retain the returned `<task-id>`. Use these recovery commands at any time:

```powershell
npm run cartoon -- status <task-id>
npm run cartoon -- status <task-id> --json
npm run cartoon -- resume <task-id>
```

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

At every stage, present the current revision and its evidence, then wait for one explicit decision:

```powershell
npm run cartoon -- review <task-id> --stage <stage-id> --decision approve
npm run cartoon -- review <task-id> --stage <stage-id> --decision revise --feedback "<feedback>" --targets "<ids>"
npm run cartoon -- review <task-id> --stage <stage-id> --decision regenerate --feedback "<feedback>" --targets "<ids>"
npm run cartoon -- review <task-id> --stage <stage-id> --decision abort --feedback "<reason>"
```

Record all feedback and apply it to the named targets. Do not batch approvals or infer a decision from silence. Run `resume` after recording a decision that permits more work.

## 4. Freeze providers before G4

After G3 approval and before creating assets:

```powershell
npm run cartoon -- providers list
npm run cartoon -- providers check
npm run cartoon -- providers select <task-id> --provider manual --mode manual
```

Do not fail over after selection. V1 does not mutate a frozen binding; preserve the blocked task and offer retry, wait, the already-selected manual route, or a replacement task.

## 5. Import external results

API-created work should retain job IDs automatically. MCP or manually generated results must be imported:

```powershell
npm run cartoon -- import <task-id> --stage <stage-id> --file <path> --metadata @metadata.json
```

Metadata should identify provider/tool, model, request/resource ID, prompt/settings, source, checksum when available, and rights/terms basis. Import does not approve an artifact.

## 6. Export

After the user approves G9:

```powershell
npm run cartoon -- export <task-id>
```

Verify the delivery video, burned-in captions, SRT sidecar, manifest/provenance, and review record in `output/<task-id>/final/v001/` (or its later approved revision). Outputs are ignored by Git; publish or archive them through an intentional external process.
