# Provider profiles

`config/providers.example.json` is the safe, committed template. `config/providers.local.json` is the ignored machine-local override. Keep credentials in environment variables and reference them by name from a profile.

## Mode order

| Mode | Use when | Health evidence | Durability |
| --- | --- | --- | --- |
| local | Deterministic FFmpeg rendering, contact sheets, or QC can run on this machine | Resolved `ffmpeg` and `ffprobe` version/feature probes | Strong: task-relative inputs, immutable outputs, hashes, and local receipts |
| `api` | A supported provider has stable programmatic access | Credential presence, endpoint reachability, capability/model availability | Strongest: request IDs, polling, structured errors, retries |
| `mcp` | An MCP tool exposes the needed capability | Server/tool discovery and an importable result contract | Good only when tool/resource IDs and outputs are persisted |
| `manual` | A human must operate a browser or external app | Explicit instructions plus import and metadata paths | Fallback; durability depends on complete import metadata |

Never claim that a credential check proves authorization, quota, commercial rights, or provider availability. Surface those as separate checks when the provider exposes them.

## Environment variables

The supplied profiles may refer to:

- `MINIMAX_API_KEY`
- `DASHSCOPE_API_KEY`
- `COMFYUI_CLIENT_ID` for the optional ComfyUI client identity

Leave optional credentials unset when the corresponding profile is not selected. Never put the secret value in either provider JSON file. `.env.example` documents names only; use the host environment or a secret manager appropriate to the execution context.

The enabled `local-ffmpeg` profile has no secret. Resolution order is explicit profile paths, `AI_CARTOON_FFMPEG_PATH` / `AI_CARTOON_FFPROBE_PATH`, pinned optional npm-managed binaries, then `ffmpeg` / `ffprobe` on `PATH`. Use `npm ci --omit=optional` or `AI_CARTOON_DISABLE_MANAGED_FFMPEG=1` only when a trusted system/container toolchain is available. The adapter never accepts raw command arguments from a request.

## Capability coverage

Before selection, verify that the chosen profile covers every required generation capability for the production. A profile can mix modes, but every route must preserve provider/tool identity, concrete model, request or resource ID when available, prompts/settings, output paths, and rights notes.

Treat ComfyUI as a provider endpoint, not as proof that the loaded checkpoint or workflow is licensed. Record checkpoint/workflow identifiers and their rights basis separately.

The example also enables task-scoped handoff profiles for 即梦 AI, 可灵 AI, LibLibAI, and macOS 剪映专业版. The Node runtime creates durable, hash-bound manifests but does not embed browser automation or claim an unofficial API. `$execute-cartoon-platform-handoff` uses Chrome or Computer Use as the external UI executor, records only safe receipts through the public CLI/MCP surface, downloads original outputs into task scope, and rejects expiring share links. Keep ComfyUI for advanced local reproducibility with `metadata.workflowVersion` or a versioned `*.vNNN.json` workflow.

Complete a queued manual attempt with `cartoon providers complete-manual <task-id> --attempt <attempt-id> --result @result.json`. This is the only supported way to create the matching manual result package; it verifies file size, signature, kind, and optional expected hash before copying outputs into task scope.

After completion, use `cartoon providers import-output <task-id> --attempt <attempt-id> [--attempt <attempt-id> ...] --contract @stage-contract.json --metadata @metadata.json`. The command atomically binds every named complete archived output set to the current stage revision and rejects provider/model/job overrides; metadata must provide rights for every imported file. Repeated generic archive basenames require unique metadata `fileNames` mappings.

`local-ffmpeg` exposes `render.timeline` and `quality.inspect`. Its versioned request contracts support timeline MP4 assembly, PNG contact sheets, and a hash-bound final-delivery QC report. Every path is relative to one task directory; outputs are immutable and cannot escape `output/<task-id>/`.

## Failure handling

- Missing secret: configure the named environment variable; do not request the value in chat.
- Missing FFmpeg: rerun normal `npm ci`, configure explicit executable paths, or install trusted system tools; do not mark local rendering healthy until both version and feature probes pass.
- Missing MCP tool: configure the server or choose another declared route.
- Manual-only capability: document the handoff and validate metadata import before freezing.
- Outage or quota failure after freeze: stop, retain provider errors, and ask the user whether to wait, retry, use the already-frozen manual route, or create a replacement task. V1 does not mutate a frozen binding.
- Model drift: pin a concrete model/version when supported and record the observed model identifier in every result.
- Existing attempt: finish, fail, or cancel the current nonterminal attempt before submitting another; successful attempts for the same revision may accumulate for one atomic import.
