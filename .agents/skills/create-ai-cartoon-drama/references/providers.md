# Providers in production

Use `$configure-ai-cartoon-providers` for setup and diagnostics. Keep secrets in environment variables; provider JSON may name an environment variable but must never contain its value.

## Durability order

Prefer direct API, then MCP, then manual operation:

1. **Task-scoped local**: use the built-in `local-ffmpeg` provider for deterministic contact sheets, timeline rendering, subtitle burn-in, and QC when managed, explicit, or system `ffmpeg`/`ffprobe` are healthy.
2. **API**: best for persistent request IDs, deterministic parameters, polling, retries, and machine-readable failures.
3. **MCP**: acceptable when the tool result is imported with provider/model, prompt/settings, request or resource ID, and output paths.
4. **Manual**: fallback for browser-only or human-operated tools. Import the file and a complete metadata JSON record before review.

The bundled manual profiles tailor this handoff for 即梦 AI, 可灵 AI, LibLibAI, and 剪映. Use their provider IDs so request packages contain platform-specific export instructions and remain isolated under `manual/<provider-id>/`. ComfyUI remains the advanced local entry and requires a versioned workflow JSON; do not replace it with an opaque manual package when reproducibility matters.

After downloading original files from a manual platform, run `cartoon providers complete-manual <task-id> --attempt <attempt-id> --result @result.json`. Do not author a task ledger or matching `*.result.json` manually; the public command verifies and archives each file before completing the durable attempt.

A prettier result does not waive provenance or review requirements.

## Freeze rule

Run provider `list --json` and `check`, then show the user each candidate's capability, concrete model, region, price or `unknown`, and data-transfer mode. Ask the user to confirm the complete mapping and budget before calling `select <task-id>` with explicit `--binding` values after G3 and before G4. Bind `image.generate`, `video.i2v`, `audio.tts`, `audio.music`, `audio.sfx`, and `render.timeline`. Preserve the bindings and concrete model identifiers in task state. Never use a bare select command to infer the choice.

When selected, freeze `render.timeline` to `local-ffmpeg`. If G9 QC will use the provider-job surface, also freeze the optional `quality.inspect` capability to `local-ffmpeg` in the same initial selection. Use these routes for the G4/G5 contact sheets, G6 proxy assembly, G8 final timeline, and G9 inspection. A new local execution still records a known zero-cost estimate and explicit confirmation; polling or resuming the same local job does not ask again.

Do not fail over after the freeze. On provider outage, show the blocked capability and offer retry, wait, the already-frozen manual route, or a replacement task. V1 does not mutate a frozen binding.

## Paid request confirmation

Before every new request that may incur a charge, obtain a current estimate or state that pricing is unknown, show the capability, provider, model, estimated amount/currency, and data-transfer mode, then wait for the user's explicit confirmation of that request. Persist the estimate and confirmation timestamp or review-event reference with the request package before submission. A prior provider freeze is not payment approval.

Do not ask again when only polling, downloading, or resuming the same provider job and idempotency key. Retrying by creating a new paid job is a new chargeable request and requires a new confirmation.

Always run `cartoon resume <task-id>` before creating a replacement request. If it returns `resume-provider-job`, `poll-provider-job`, `cancel-provider-job`, or `import-provider-output`, complete that durable action first. Only one attempt may be nonterminal at a time. Several successful attempts targeting the same current stage revision may be imported atomically by repeating `--attempt`; use metadata `fileNames` when their archived basenames collide. A task-local archived output is not a stage revision until `cartoon providers import-output` imports the complete hash-checked output sets with a validated structured stage contract and per-file rights.

## Import metadata

Durable provider attempts derive provider/model/job identity, prompt hash, seed, request/resource IDs, and other allowlisted receipt fields from `provider-jobs.jsonl`; callers must not override them. For ordinary non-job MCP or manual artifacts, include at least:

- provider, profile, model/tool, capability, and mode;
- request/resource ID or a clear `not_available` reason;
- source path/URL, creation time, and file checksum when available;
- prompt and negative constraints or a prompt hash plus durable prompt path;
- relevant seed, duration, resolution, voice, or generation settings;
- rights/terms note and whether the result contains third-party input.
