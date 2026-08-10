# Providers

Provider routing is capability-based and provider-neutral. The committed `config/providers.example.json` declares safe example metadata; the ignored `config/providers.local.json` holds machine-local overrides. Neither file may contain resolved secrets.

## Included routes

| ID | Role | Environment reference | Notes |
| --- | --- | --- | --- |
| `manual` | Durable fallback import | none | Enabled by default; requires file plus metadata import |
| `minimax` | MiniMax image, video, and TTS API | `MINIMAX_API_KEY` | Disabled until explicitly configured; image/TTS use official synchronous endpoints and video uses durable async routes |
| `alibaba-wan` | Alibaba Wan through DashScope | `DASHSCOPE_API_KEY` | Disabled until explicitly configured; current example declares image generation/editing and t2v/i2v/r2v routes |
| `comfyui` | Optional local/remote ComfyUI workflows | `COMFYUI_CLIENT_ID` | Availability and capability depend on installed workflows/checkpoints |

An enabled provider is not automatically healthy, funded, authorized for commercial use, or capable of every stage. Run health and capability checks.

The v1 freeze must bind `image.generate`, `video.i2v`, `audio.tts`, `audio.music`, `audio.sfx`, and `render.timeline`. A manual binding may satisfy an unavailable automated route only when its import/provenance contract is ready before selection.

## Configure safely

```powershell
Copy-Item config/providers.example.json config/providers.local.json
$env:MINIMAX_API_KEY = "<set-outside-source-control>"
$env:DASHSCOPE_API_KEY = "<set-outside-source-control>"
$env:COMFYUI_CLIENT_ID = "<optional-client-id>"
npm run cartoon -- doctor
npm run cartoon -- providers list
npm run cartoon -- providers check
```

Prefer an OS/CI secret store for persistent credentials. Do not echo secret values, paste them into chat, or place them in `.env.example`, provider JSON, task metadata, or logs.

## API, MCP, and manual durability

Use the most durable available mode:

1. **Direct API**: preserves idempotency keys, request IDs, polling states, model parameters, structured failures, and retry decisions.
2. **MCP**: useful for tool access, but preserve its server/tool, resource ID, model, arguments, and returned files through the task import boundary.
3. **Manual**: acceptable when a user must operate an external UI. Preserve exported files and metadata before review.

The order is about recovery and auditability, not creative quality. All modes receive the same user review.

## Select and freeze

After storyboard approval, verify required capabilities and freeze a selection:

```powershell
npm run cartoon -- providers select <task-id> --provider manual --mode manual
```

Do this before G4 (`assets`). The task must retain the selected provider/profile and concrete models. V1 rejects replacement of a frozen binding. On outage or quota exhaustion, stop and show the user retry, wait, use the already-selected manual path, or create a replacement task; never switch a paid provider silently.

The freeze is not payment approval. Before each new potentially chargeable submission, show the provider/model/capability, current estimate (or `unknown`), currency, and data-transfer mode, then record the user's explicit confirmation. Polling, downloading, or resuming that same durable job does not need another confirmation; creating a replacement paid job does.

## Optional upstream tools

HyperFrames and the ElevenLabs skills are optional external integrations, not bundled runtime dependencies. If installed separately, retain their own license/terms and route their outputs through `import`. See [`skills.lock.json`](../integrations/skills.lock.json) and [`THIRD_PARTY_NOTICES.md`](../integrations/THIRD_PARTY_NOTICES.md) for pinned upstream references.
