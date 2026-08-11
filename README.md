# AI Cartoon Workflow

A clone-ready, provider-neutral workflow for producing a 60-90 second vertical AI cartoon drama. It starts from an original or proven-public-domain IP and a theme, runs nine sequential production stages, and exports traceable media artifacts. Strict review remains the default; an explicit quick mode reduces user interruptions to three bundled checkpoints without skipping structured validation.

V1 uses one durable sequential controller and no runtime subagents.

## Requirements

- Node.js 22 (the supported engine range is in `package.json`)
- npm
- Enough disk/network access for the optional portable FFmpeg packages, or trusted system/explicit FFmpeg executables
- An original IP controlled by you, or documented proof that the chosen IP is public domain for the intended use

Voice cloning is disabled by default and may never be activated implicitly. Do not use this template for copyrighted franchises, unauthorized likenesses, or style imitation of a living artist/director.

## Clone and verify

```powershell
git clone <repo-url> ai-cartoon-workflow
Set-Location ai-cartoon-workflow
npm ci
npm run cartoon -- doctor
```

`npm ci` installs pinned optional portable FFmpeg/ffprobe binaries for Windows, macOS, and Linux, so most users need no system-level media installation. Tool discovery is deterministic: explicit provider config, `AI_CARTOON_FFMPEG_PATH` / `AI_CARTOON_FFPROBE_PATH`, npm-managed binaries, then system `PATH`. Use `npm ci --omit=optional` when an organization supplies its own trusted build. See [FFmpeg deployment](docs/FFMPEG_DEPLOYMENT.md).

Run the full repository check when developing the template:

```powershell
npm run check
```

## Start a production

```powershell
npm run cartoon -- start --ip "Paper Lantern Town" --theme "Courage means asking for help"
npm run cartoon -- start --ip "Paper Lantern Town" --theme "Courage means asking for help" --review-mode quick
npm run cartoon -- status <task-id>
npm run cartoon -- resume <task-id>
npm run cartoon -- generate <task-id> --metadata @rights-metadata.json
```

The built-in replaceable generator creates validated G1-G3 contracts. In strict mode it never approves a revision. In quick mode the workflow records policy approvals for validated non-checkpoints; G1 still requires original-work or evidenced public-domain rights.

The stages run only in this order:

`concept` -> `script` -> `storyboard` -> provider freeze -> `assets` -> `keyframes` -> `clips` -> `audio` -> `edit` -> `qc` -> export

Strict mode stops at every stage. Quick mode stops for the G1-G3 creative bundle at `storyboard`, G4-G5 visual bundle at `keyframes`, and G6-G9 delivery bundle at `qc`. Provider freeze, cost confirmation, rights, and voice-clone consent remain separate explicit gates. Record approval or feedback through the CLI:

```powershell
npm run cartoon -- review <task-id> --stage concept --decision approve
npm run cartoon -- review <task-id> --stage storyboard --decision revise --feedback "Tighten S04 and preserve the lantern eyeline" --targets "S04"
```

Valid decisions are `approve`, `revise`, `regenerate`, and `abort`. Approval is never inferred from silence; quick-policy decisions and user decisions have distinct audit actors.

## Configure and freeze providers

The safe template is `config/providers.example.json`; local overrides belong in the ignored `config/providers.local.json`. Configuration stores environment-variable names, never secret values. 即梦、可灵、LibLibAI and 剪映 are available as durable platform-specific manual handoffs; their request packages live under the current task and downloaded outputs must be imported. ComfyUI remains the advanced versioned local-workflow route. The enabled `local-ffmpeg` profile provides task-scoped contact sheets, timeline rendering, and final QC when `ffmpeg`/`ffprobe` are healthy. See `.env.example` and [provider documentation](docs/PROVIDERS.md).

```powershell
Copy-Item config/providers.example.json config/providers.local.json
npm run cartoon -- providers list
npm run cartoon -- providers check
npm run cartoon -- providers select <task-id> --provider manual --mode manual
```

Select after storyboard approval and before G4 (`assets`). The selection then freezes for reproducibility. Use task-scoped local execution for deterministic media work; for generation, direct API is preferred, MCP is second, and manual import is the fallback because that order provides progressively less automatic recovery metadata. In a mixed explicit map, bind `render.timeline` to `local-ffmpeg:api` alongside the required generation routes and add `quality.inspect=local-ffmpeg:api` before the freeze when G9 QC should use provider jobs.

For an API or task-scoped manual request, keep prompts in a JSON file and use the durable job surface:

```powershell
npm run cartoon -- providers estimate <task-id> --provider <id> --request @request.json --json
npm run cartoon -- providers submit <task-id> --provider <id> --stage <stage-id> --request @request.json --confirmation @confirmation.json --json
npm run cartoon -- providers complete-manual <task-id> --attempt <attempt-id> --result @result.json --json
npm run cartoon -- providers jobs <task-id> --json
npm run cartoon -- providers poll <task-id> --attempt <attempt-id> --json
npm run cartoon -- providers resume-job <task-id> --attempt <attempt-id> --request @request.json --json
npm run cartoon -- providers import-output <task-id> --attempt <attempt-id> [--attempt <attempt-id> ...] --contract @stage-contract.json --metadata @metadata.json --json
npm run cartoon -- providers cancel <task-id> --attempt <attempt-id> --json
```

Every new `submit` obtains a fresh provider estimate and binds it to one explicit confirmation. Use one of these strict confirmation shapes:

```json
{
  "confirmedAt": "2026-08-10T01:02:03.000Z",
  "confirmedBy": "user",
  "confirmationReference": "review:assets:v001:cost-1",
  "pricingStatus": "known",
  "estimatedCost": 0.2,
  "maximumCost": 0.25,
  "currency": "USD"
}
```

```json
{
  "confirmedAt": "2026-08-10T01:02:03.000Z",
  "confirmedBy": "user",
  "confirmationReference": "review:assets:v001:unknown-price-1",
  "pricingStatus": "unknown",
  "unknownPricingAcknowledged": true,
  "maximumCost": 0,
  "currency": "USD"
}
```

Known pricing must exactly match the mechanically calculated estimate. Unknown pricing must omit `estimatedCost`; task-scoped Manual Import uses the unknown form with `maximumCost: 0`. Polling or resuming the same attempt does not request confirmation again.

Successful provider outputs are not stage artifacts yet. Temporary URLs are downloaded, MIME/size/hash checked, and archived under `output/<task-id>/provider-downloads/`; manual request/result packages live under `output/<task-id>/manual/`. Use `providers complete-manual` for user-exported platform files instead of writing result JSON by hand. Then bind the complete archived output set to its successful durable attempt so it becomes reviewable and recoverable:

```powershell
npm run cartoon -- providers import-output <task-id> --attempt <attempt-id> [--attempt <attempt-id> ...] --contract @stage-contract.json --metadata @metadata.json
```

Every production import requires the stage-specific structured contract and rights for every file (`rights` as a shared default or `fileRights` per file). Repeat `--attempt` to atomically assemble complete output sets from several terminal attempts prepared for the same stage revision. If provider archives reuse names such as `output-001.png`, supply metadata `fileNames` keyed by task-local source path to assign unique contract basenames. Provider job IDs cannot be asserted by ordinary import: `providers import-output` derives provider/model/job identity from `provider-jobs.jsonl` and verifies the archived paths, sizes, and hashes. `resume` returns the exact safe resume, poll, cancel-obsolete, or archived-output import action before a new request may be created.

See [structured stage contracts](docs/STAGE_CONTRACTS.md) for the exact G1-G9 evidence model and an import example.

## Export

After explicit QC approval:

```powershell
npm run cartoon -- export <task-id>
```

Task state, revisions, reviews, provenance, and deliverables live under `output/<task-id>/`. `output/` is intentionally ignored by Git; archive or publish final media explicitly.

## Skills and MCP

- Invoke `$create-ai-cartoon-drama` for the complete gated production loop.
- Invoke `$configure-ai-cartoon-providers` for provider setup, health checks, and selection.
- Run `npm run build` before using the MCP server declared in `.mcp.json`. The MCP surface uses the same workflow/state contracts as the CLI.
- Workflow MCP tools are `cartoon_start`, `cartoon_status`, `cartoon_resume`, `cartoon_generate_stage`, `cartoon_submit_review`, `cartoon_list_providers`, `cartoon_select_providers`, `cartoon_import_artifact`, `cartoon_list_artifacts`, and `cartoon_export`.
- Provider-job MCP tools are `cartoon_estimate_provider_job`, `cartoon_submit_provider_job`, `cartoon_complete_manual_provider_job`, `cartoon_resume_provider_job`, `cartoon_poll_provider_job`, `cartoon_cancel_provider_job`, and `cartoon_list_provider_jobs`.
- Edit only `.agents/skills/`. The root `skills/` directory is a generated plugin mirror; refresh and verify it with `npm run skills:sync` and `npm run skills:check`.

CI runs the compact offline fake-provider/media E2E on every supported OS through `npm run check`. Linux additionally sets `AI_CARTOON_FULL_MEDIA_E2E=1` and renders the full 1080x1920, 60-second delivery profile.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Workflow](docs/WORKFLOW.md)
- [Providers](docs/PROVIDERS.md)
- [FFmpeg deployment](docs/FFMPEG_DEPLOYMENT.md)
- [Output specification](docs/OUTPUT_SPEC.md)
- [Review policy](docs/REVIEW_POLICY.md)
- [Compliance](docs/COMPLIANCE.md)
- [Third-party notices](integrations/THIRD_PARTY_NOTICES.md)
