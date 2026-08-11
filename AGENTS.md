# Agent instructions

This repository implements a serial, review-gated AI cartoon workflow. Keep changes aligned with that product boundary.

## Environment

- Use Node.js 22 and npm.
- Install with `npm ci`; its optional managed packages provide portable FFmpeg and `ffprobe` by default.
- System tools or `AI_CARTOON_FFMPEG_PATH` / `AI_CARTOON_FFPROBE_PATH` may override the managed tools. Use `npm ci --omit=optional` only when a trusted external toolchain is already available.
- Before handoff, run `npm run check`; run `npm run cartoon -- doctor` when changing runtime or provider behavior.

## Production invariants

- Start every task with `--ip` and `--theme`.
- Admit only user-controlled original IP or IP with recorded public-domain proof.
- Run stages sequentially: `concept`, `script`, `storyboard`, `assets`, `keyframes`, `clips`, `audio`, `edit`, `qc`.
- Default to `strict`, which requires a user decision after every stage. An explicitly created `quick` task may policy-approve only validated non-checkpoints and must stop for user bundle review at `storyboard`, `keyframes`, and `qc`; never infer approval from chat silence.
- Apply all feedback to its recorded targets and create a new revision; approved revisions are immutable.
- Check and freeze provider bindings after storyboard approval and before `assets` (G4).
- Re-estimate every new provider submission and persist one strict confirmation: `known` pricing includes the exact `estimatedCost`; `unknown` pricing includes `unknownPricingAcknowledged: true` and no estimate. Polling or resuming the same durable job does not need another confirmation.
- Keep the production runtime single-controller and serial. Do not add runtime subagents, an agent team, or an orchestration loop in v1.
- Keep voice cloning disabled by default. Direct provider submit fails closed on clone/reference-voice intent. Only import an externally authorized audio result with separate, specific consent evidence and explicit user confirmation; reject unauthorized voice/likeness imitation.
- Never write resolved credentials to configuration, task state, artifacts, logs, reviews, or chat.
- Keep generated task data under `output/`; it is intentionally ignored by Git.

## Use the public surfaces

Use the CLI or its equivalent MCP operations. Do not edit `state.json`, ledgers, reviews, provider bindings, or approval flags by hand.

```powershell
npm run cartoon -- start --ip "<ip>" --theme "<theme>" [--review-mode strict|quick]
npm run cartoon -- status <task-id> [--json]
npm run cartoon -- resume <task-id>
npm run cartoon -- generate <task-id> [--stage concept|script|storyboard] [--metadata @metadata.json]
npm run cartoon -- review <task-id> --stage <id> --decision approve|revise|regenerate|abort [--feedback "..."] [--targets "..."]
npm run cartoon -- providers list
npm run cartoon -- providers check
npm run cartoon -- providers select <task-id> --provider manual --mode manual
npm run cartoon -- providers estimate <task-id> --provider <id> --request @request.json [--json]
npm run cartoon -- providers submit <task-id> --provider <id> --stage <id> --request @request.json --confirmation @confirmation.json [--json]
npm run cartoon -- providers complete-manual <task-id> --attempt <attempt-id> --result @result.json [--json]
npm run cartoon -- providers resume-job <task-id> --attempt <attempt-id> --request @request.json [--json]
npm run cartoon -- providers poll <task-id> --attempt <attempt-id> [--json]
npm run cartoon -- providers cancel <task-id> --attempt <attempt-id> [--json]
npm run cartoon -- providers jobs <task-id> [--json]
npm run cartoon -- providers import-output <task-id> --attempt <attempt-id> [--attempt <attempt-id> ...] --contract @stage-contract.json --metadata @metadata.json [--json]
npm run cartoon -- import <task-id> --stage <id> --file <path> --contract @stage-contract.json --metadata @metadata.json
npm run cartoon -- export <task-id>
npm run cartoon -- doctor [--json]
```

For production behavior, follow `.agents/skills/create-ai-cartoon-drama/`. For provider configuration, follow `.agents/skills/configure-ai-cartoon-providers/`.

Treat `.agents/skills/` as the canonical source. The root `skills/` directory is a generated, byte-identical plugin mirror required by the current Codex plugin package contract; never edit it directly. After changing a canonical Skill, run `npm run skills:sync` and verify with `npm run skills:check`.

## Durability and compatibility

- Preserve append-only event, artifact, and review history.
- Preserve `provider-jobs.jsonl`; import archived provider outputs from the task's `provider-downloads/` or `manual/` area before review.
- Persist provider/model/job identity, prompt hash, seed, file hash, the full rights/provenance chain, timestamps, and known or explicitly unknown pricing.
- Require rights on every production artifact. Concepts accept only `original` or fully evidenced `public-domain`; downstream artifacts use `original`, `public-domain`, `licensed`, `provider-terms`, or `workflow-derived` with valid source artifact IDs.
- Prefer direct API, then MCP, then manual import. All three routes must enter the same artifact and review contracts.
- Treat provider and model identifiers as external, changeable data; do not hide failover.
- Avoid changing fixed stage IDs, numbered folder names, decision names, or CLI syntax without a migration and documentation update.
- Keep `config/providers.example.json` secret-free and `config/providers.local.json` ignored.
