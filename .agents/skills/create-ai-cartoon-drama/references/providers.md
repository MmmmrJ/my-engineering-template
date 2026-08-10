# Providers in production

Use `$configure-ai-cartoon-providers` for setup and diagnostics. Keep secrets in environment variables; provider JSON may name an environment variable but must never contain its value.

## Durability order

Prefer direct API, then MCP, then manual operation:

1. **API**: best for persistent request IDs, deterministic parameters, polling, retries, and machine-readable failures.
2. **MCP**: acceptable when the tool result is imported with provider/model, prompt/settings, request or resource ID, and output paths.
3. **Manual**: fallback for browser-only or human-operated tools. Import the file and a complete metadata JSON record before review.

A prettier result does not waive provenance or review requirements.

## Freeze rule

Run provider `list --json` and `check`, then show the user each candidate's capability, concrete model, region, price or `unknown`, and data-transfer mode. Ask the user to confirm the complete mapping and budget before calling `select <task-id>` with explicit `--binding` values after G3 and before G4. Bind `image.generate`, `video.i2v`, `audio.tts`, `audio.music`, `audio.sfx`, and `render.timeline`. Preserve the bindings and concrete model identifiers in task state. Never use a bare select command to infer the choice.

Do not fail over after the freeze. On provider outage, show the blocked capability and offer retry, wait, the already-frozen manual route, or a replacement task. V1 does not mutate a frozen binding.

## Paid request confirmation

Before every new request that may incur a charge, obtain a current estimate or state that pricing is unknown, show the capability, provider, model, estimated amount/currency, and data-transfer mode, then wait for the user's explicit confirmation of that request. Persist the estimate and confirmation timestamp or review-event reference with the request package before submission. A prior provider freeze is not payment approval.

Do not ask again when only polling, downloading, or resuming the same provider job and idempotency key. Retrying by creating a new paid job is a new chargeable request and requires a new confirmation.

## Import metadata

For MCP or manual artifacts, include at least:

- provider, profile, model/tool, capability, and mode;
- request/resource ID or a clear `not_available` reason;
- source path/URL, creation time, and file checksum when available;
- prompt and negative constraints or a prompt hash plus durable prompt path;
- relevant seed, duration, resolution, voice, or generation settings;
- rights/terms note and whether the result contains third-party input.
