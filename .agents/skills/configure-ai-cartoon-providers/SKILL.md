---
name: configure-ai-cartoon-providers
description: Configure and diagnose provider profiles for the AI cartoon workflow. Use when creating config/providers.local.json, choosing local/API/MCP/manual capability routes, setting FFmpeg, MiniMax, DashScope, or optional ComfyUI environment names, resolving doctor or providers check failures, or freezing a checked provider selection before the assets stage.
---

# Configure AI Cartoon Providers

Configure durable capability routes without persisting secrets. Read [providers.md](references/providers.md) before editing a profile.

## Configure

1. Run `npm run cartoon -- doctor` and `npm run cartoon -- providers list`.
2. Run `npm ci`, then confirm `doctor` finds `ffmpeg` and `ffprobe`. It prefers explicit config, environment overrides, optional npm-managed binaries, then system `PATH`; keep `local-ffmpeg` for deterministic contact sheets, timeline assembly, and final QC.
3. Copy `config/providers.example.json` to the ignored `config/providers.local.json` when local overrides are needed.
4. Select local execution, `api`, `mcp`, or `manual` for each capability. Prefer task-scoped local execution for deterministic media work, then API, MCP, and manual based on recoverability. Use `jimeng-manual`, `kling-manual`, `liblib-manual`, or `jianying-manual` for tailored external-app packages; keep `comfyui` as the advanced versioned local-workflow entry.
5. Store only environment-variable names such as `MINIMAX_API_KEY`, `DASHSCOPE_API_KEY`, or optional `COMFYUI_CLIENT_ID` in JSON. Set secret values in the process environment or an external secret manager.
6. Keep voice cloning disabled by default. Do not activate a clone-capable profile unless the task has separate consent evidence and explicit user confirmation.
7. Run `npm run cartoon -- providers check`; resolve every required capability failure.

Do not print, inspect, commit, import, or place secret values in feedback, metadata, provider JSON, or task artifacts.

## Select for a task

After storyboard approval and before G4 (`assets`):

```powershell
npm run cartoon -- providers list
npm run cartoon -- providers check
npm run cartoon -- providers select <task-id> --provider manual --mode manual
```

Selection freezes the profile for reproducibility. If a provider becomes unavailable later, report the blocked capability. V1 does not mutate the binding; offer retry, wait, the already-frozen manual route, or a replacement task.

Freeze `render.timeline` to `local-ffmpeg` in an explicit binding map when local deterministic rendering is desired. Also include the optional `quality.inspect=local-ffmpeg:api` binding in that initial map when G9 QC will run through the provider-job surface; bindings cannot be added after production advances. The provider is zero-cost but still uses the normal known-price confirmation with `estimatedCost: 0`, `maximumCost: 0`, and the configured currency for each new submission.

## Validate manual and MCP paths

Confirm that each non-API route can return a file plus durable metadata. Import its result through:

```powershell
npm run cartoon -- import <task-id> --stage <stage-id> --file <path> --contract @stage-contract.json --metadata @metadata.json
```

Do not mark a manual or MCP profile healthy if request provenance, model/tool identity, rights notes, or output files cannot be retained.

Complete a queued manual request through the public surface rather than editing its result ledger file:

```powershell
npm run cartoon -- providers complete-manual <task-id> --attempt <attempt-id> --result @result.json
```

The strict result JSON contains `outputs[]` entries with `kind`, `sourcePath`, and optional `expectedSha256`. The runtime verifies size, file signature, kind, and hash, copies the result into task scope, and preserves the original provider attempt for `resume`.
