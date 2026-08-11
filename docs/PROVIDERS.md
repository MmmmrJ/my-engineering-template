# Providers

Provider routing is capability-based and provider-neutral. The committed `config/providers.example.json` declares safe example metadata; the ignored `config/providers.local.json` holds machine-local overrides. Neither file may contain resolved secrets.

## Included routes

| ID | Role | Environment reference | Notes |
| --- | --- | --- | --- |
| `local-ffmpeg` | Task-scoped contact sheets, timeline rendering, and delivery QC | none | Enabled by default; automatically discovers explicit, environment, npm-managed, or system executables |
| `manual` | Durable fallback import | none | Enabled by default; requires file plus metadata import |
| `jimeng-manual` | 即梦 AI China Chrome handoff | none | Versioned `jimeng-cn.v1` playbook; task-local hash-bound uploads and originals |
| `kling-manual` | 可灵 AI China Chrome handoff | none | Versioned `kling-cn.v1` playbook; retain model/mode/task identity and originals |
| `liblib-manual` | LibLibAI hosted workflow handoff | none | Records workflow version, model/LoRA, seed, and generation UUID when available |
| `jianying-manual` | 剪映 editable timeline handoff | none | Exports MP4 plus SRT/ASS and returns to a separate `quality.inspect` route |
| `minimax` | MiniMax image, video, and TTS API | `MINIMAX_API_KEY` | Disabled until explicitly configured; image/TTS use official synchronous endpoints and video uses durable async routes |
| `alibaba-wan` | Alibaba Wan through DashScope | `DASHSCOPE_API_KEY` | Disabled until explicitly configured; current example declares image generation/editing and t2v/i2v/r2v routes |
| `comfyui` | Advanced local/remote ComfyUI workflows | `COMFYUI_CLIENT_ID` | Requires versioned workflow JSON; availability and rights depend on installed workflows/checkpoints |

An enabled provider is not automatically healthy, funded, authorized for commercial use, or capable of every stage. Run health and capability checks.

The v1 freeze must bind `image.generate`, `video.i2v`, `audio.tts`, `audio.music`, `audio.sfx`, and `render.timeline`. Prefer `local-ffmpeg` for `render.timeline`; it also provides `quality.inspect`. A manual binding may satisfy an unavailable automated route only when its import/provenance contract is ready before selection.

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

`local-ffmpeg` is task-scoped by the provider execution manager. Requests contain only versioned data and task-relative paths; they cannot pass raw FFmpeg flags or address files outside `output/<task-id>/`. The route returns immutable MP4, PNG, or JSON outputs with size and SHA-256 evidence. Its estimate is mechanically known as zero, but every new submission still records the standard explicit zero-cost confirmation.

Tool precedence is explicit `ffmpegPath`/`ffprobePath`, environment overrides, pinned optional npm packages, then commands on `PATH`. Most users only run `npm ci`. Use `npm ci --omit=optional` for a system/container toolchain, or set `AI_CARTOON_DISABLE_MANAGED_FFMPEG=1` to ignore installed managed binaries. Full deployment and GPL redistribution considerations are in [FFmpeg deployment](FFMPEG_DEPLOYMENT.md).

## API, MCP, and manual durability

Use the most durable available mode:

1. **Task-scoped local**: preserves versioned input, exact command plan, output hashes, and executor receipts without transferring data off-machine.
2. **Direct API**: preserves idempotency keys, request IDs, polling states, model parameters, structured failures, and retry decisions.
3. **MCP**: useful for tool access, but preserve its server/tool, resource ID, model, arguments, and returned files through the task import boundary.
4. **Manual**: acceptable when a user must operate an external UI. Preserve exported files and metadata before review.

The order is about recovery and auditability, not creative quality. All modes enter the same artifact contract and the task's strict or quick review policy.

Platform handoff providers do not claim unofficial APIs and do not embed browser automation in the Node adapter. `providers prepare-handoff` writes a tailored request package plus a hash-bound manifest under `output/<task-id>/manual/<provider-id>/`; `$execute-cartoon-platform-handoff` operates the declared Chrome origin or macOS 剪映 application and records observations only through CLI/MCP. `confirm-handoff` binds one exact upload set and credit ceiling to the attempt. `complete-manual` safely verifies and archives task-local downloads; then `providers import-output` enters the artifact/review surface. Share pages, login-only URLs, and expiring links are not deliverables.

Example completion input:

```json
{
  "outputs": [
    { "kind": "image", "sourcePath": "D:/exports/SHOT_01.png" },
    { "kind": "video", "sourcePath": "D:/exports/SHOT_01.mp4", "expectedSha256": "<64 hex characters>" }
  ]
}
```

Omit `expectedSha256` when the external platform does not provide one; the workflow still calculates and persists its own SHA-256 after validating size, signature, and file kind.

Import a successful attempt only through its durable ledger record:

```powershell
npm run cartoon -- providers import-output <task-id> --attempt <attempt-id> [--attempt <attempt-id> ...] --contract @stage-contract.json --metadata @metadata.json
```

The command derives provider, capability, observed model, job identity, prompt hash, seed, and safe provider receipt metadata from `provider-jobs.jsonl`. It requires every named attempt to target the current stage revision, imports each complete output set atomically, and rechecks task-local paths, sizes, and hashes. The metadata file supplies stage rights and any per-file `fileRights`; it must not override `provider`. Repeat `--attempt` after several terminal attempts when one request cannot produce a complete stage bundle. Only one attempt may be nonterminal at a time; finish, fail, or cancel it before submitting another.

Provider archives can reuse generic basenames across attempts. In that case, add a unique logical filename map to metadata and use those values in the stage contract:

```json
{
  "fileNames": {
    "/absolute/task/provider-downloads/attempt-a/output-001.png": "hero-reference.png",
    "/absolute/task/provider-downloads/attempt-b/output-001.png": "location-reference.png"
  }
}
```

## Select and freeze

After storyboard approval, verify required capabilities and freeze a selection:

```powershell
npm run cartoon -- providers select <task-id> --provider manual --mode manual
```

For a mixed explicit map, bind deterministic rendering locally with `--binding render.timeline=local-ffmpeg:api`. Also include `--binding quality.inspect=local-ffmpeg:api` in the same initial selection when G9 QC should use the provider-job surface; `quality.inspect` is optional rather than one of the six required freeze capabilities. Here `api` means the direct provider adapter surface; the FFmpeg process and all media remain local.

Platform handoffs are capability-specific, so freeze them with a complete mixed map rather than `--provider <platform>` for all routes. For example, use `--binding image.generate=jimeng-manual:manual`, `--binding video.i2v=kling-manual:manual`, generic/manual audio bindings, and either `render.timeline=jianying-manual:manual` or `render.timeline=local-ffmpeg:api`. Keep `quality.inspect=local-ffmpeg:api` when 剪映 performs the edit so the returned MP4 is independently checked.

Do this before G4 (`assets`). Selection may be accumulated only until all six required capabilities are present; the runtime then records one explicit profile-freeze event and rejects every later addition or replacement. Include optional bindings such as `quality.inspect` before adding the last required capability. The task retains the selected provider/profile, advertised provider metadata, and concrete models. On outage or quota exhaustion, stop and show the user retry, wait, use the already-selected manual path, or create a replacement task; never switch a paid provider silently.

The freeze is not payment approval. Before each new potentially chargeable submission, show the provider/model/capability, current estimate (or `unknown`), currency, and data-transfer mode, then record the user's explicit confirmation. Polling, downloading, or resuming that same durable job does not need another confirmation; creating a replacement paid job does.

## Optional upstream tools

HyperFrames and the ElevenLabs skills are optional external integrations, not bundled runtime dependencies. If installed separately, retain their own license/terms and route their outputs through `import`. See [`skills.lock.json`](../integrations/skills.lock.json) and [`THIRD_PARTY_NOTICES.md`](../integrations/THIRD_PARTY_NOTICES.md) for pinned upstream references.
