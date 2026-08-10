# AI Cartoon Workflow

A clone-ready, provider-neutral workflow for producing a 60-90 second vertical AI cartoon drama. It starts from an original or proven-public-domain IP and a theme, runs nine sequential production stages, records user feedback at every review gate, and exports traceable media artifacts.

V1 uses one durable sequential controller and no runtime subagents.

## Requirements

- Node.js 22 (the supported engine range is in `package.json`)
- npm
- FFmpeg and `ffprobe` available on `PATH`
- An original IP controlled by you, or documented proof that the chosen IP is public domain for the intended use

Voice cloning is disabled by default and may never be activated implicitly. Do not use this template for copyrighted franchises, unauthorized likenesses, or style imitation of a living artist/director.

## Clone and verify

```powershell
git clone <repo-url> ai-cartoon-workflow
Set-Location ai-cartoon-workflow
npm ci
npm run cartoon -- doctor
```

Run the full repository check when developing the template:

```powershell
npm run check
```

## Start a production

```powershell
npm run cartoon -- start --ip "Paper Lantern Town" --theme "Courage means asking for help"
npm run cartoon -- status <task-id>
npm run cartoon -- resume <task-id>
```

The stages run only in this order:

`concept` -> `script` -> `storyboard` -> provider freeze -> `assets` -> `keyframes` -> `clips` -> `audio` -> `edit` -> `qc` -> export

Each stage stops for one explicit user decision. Record approval or feedback through the CLI:

```powershell
npm run cartoon -- review <task-id> --stage concept --decision approve
npm run cartoon -- review <task-id> --stage storyboard --decision revise --feedback "Tighten S04 and preserve the lantern eyeline" --targets "S04"
```

Valid decisions are `approve`, `revise`, `regenerate`, and `abort`. Approval is never inferred or applied to more than one stage.

## Configure and freeze providers

The safe template is `config/providers.example.json`; local overrides belong in the ignored `config/providers.local.json`. Configuration stores environment-variable names, never secret values. See `.env.example` and [provider documentation](docs/PROVIDERS.md).

```powershell
Copy-Item config/providers.example.json config/providers.local.json
npm run cartoon -- providers list
npm run cartoon -- providers check
npm run cartoon -- providers select <task-id> --provider manual --mode manual
```

Select after storyboard approval and before G4 (`assets`). The selection then freezes for reproducibility. Direct API is preferred, MCP is second, and manual import is the fallback because that order provides progressively less automatic recovery metadata.

For an API or task-scoped manual request, keep prompts in a JSON file and use the durable job surface:

```powershell
npm run cartoon -- providers estimate <task-id> --provider <id> --request @request.json --json
npm run cartoon -- providers submit <task-id> --provider <id> --stage <stage-id> --request @request.json --confirmation @confirmation.json --json
npm run cartoon -- providers jobs <task-id> --json
npm run cartoon -- providers poll <task-id> --attempt <attempt-id> --json
npm run cartoon -- providers resume-job <task-id> --attempt <attempt-id> --request @request.json --json
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

Successful provider outputs are not stage artifacts yet. Temporary URLs are downloaded, MIME/size/hash checked, and archived under `output/<task-id>/provider-downloads/`; manual request/result packages live under `output/<task-id>/manual/`. Import the archived API result, MCP result, or completed manual result so it becomes reviewable and recoverable:

```powershell
npm run cartoon -- import <task-id> --stage assets --file <path> --metadata @metadata.json
```

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
- Workflow MCP tools are `cartoon_start`, `cartoon_status`, `cartoon_resume`, `cartoon_submit_review`, `cartoon_list_providers`, `cartoon_select_providers`, `cartoon_import_artifact`, `cartoon_list_artifacts`, and `cartoon_export`.
- Provider-job MCP tools are `cartoon_estimate_provider_job`, `cartoon_submit_provider_job`, `cartoon_resume_provider_job`, `cartoon_poll_provider_job`, `cartoon_cancel_provider_job`, and `cartoon_list_provider_jobs`.
- Edit only `.agents/skills/`. The root `skills/` directory is a generated plugin mirror; refresh and verify it with `npm run skills:sync` and `npm run skills:check`.

CI runs the compact offline fake-provider/media E2E on every supported OS through `npm run check`. Linux additionally sets `AI_CARTOON_FULL_MEDIA_E2E=1` and renders the full 1080x1920, 60-second delivery profile.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Workflow](docs/WORKFLOW.md)
- [Providers](docs/PROVIDERS.md)
- [Output specification](docs/OUTPUT_SPEC.md)
- [Review policy](docs/REVIEW_POLICY.md)
- [Compliance](docs/COMPLIANCE.md)
- [Third-party notices](integrations/THIRD_PARTY_NOTICES.md)
