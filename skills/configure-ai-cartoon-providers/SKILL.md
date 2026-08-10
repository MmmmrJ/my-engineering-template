---
name: configure-ai-cartoon-providers
description: Configure and diagnose environment-backed provider profiles for the AI cartoon workflow. Use when creating config/providers.local.json, choosing API/MCP/manual capability routes, setting MiniMax, DashScope, or optional ComfyUI environment names, resolving doctor or providers check failures, or freezing a checked provider selection before the assets stage.
---

# Configure AI Cartoon Providers

Configure durable capability routes without persisting secrets. Read [providers.md](references/providers.md) before editing a profile.

## Configure

1. Run `npm run cartoon -- doctor` and `npm run cartoon -- providers list`.
2. Copy `config/providers.example.json` to the ignored `config/providers.local.json` when local overrides are needed.
3. Select `api`, `mcp`, or `manual` for each capability. Prefer API, then MCP, then manual based on recoverability.
4. Store only environment-variable names such as `MINIMAX_API_KEY`, `DASHSCOPE_API_KEY`, or optional `COMFYUI_CLIENT_ID` in JSON. Set secret values in the process environment or an external secret manager.
5. Keep voice cloning disabled by default. Do not activate a clone-capable profile unless the task has separate consent evidence and explicit user confirmation.
6. Run `npm run cartoon -- providers check`; resolve every required capability failure.

Do not print, inspect, commit, import, or place secret values in feedback, metadata, provider JSON, or task artifacts.

## Select for a task

After storyboard approval and before G4 (`assets`):

```powershell
npm run cartoon -- providers list
npm run cartoon -- providers check
npm run cartoon -- providers select <task-id> --provider manual --mode manual
```

Selection freezes the profile for reproducibility. If a provider becomes unavailable later, report the blocked capability. V1 does not mutate the binding; offer retry, wait, the already-frozen manual route, or a replacement task.

## Validate manual and MCP paths

Confirm that each non-API route can return a file plus durable metadata. Import its result through:

```powershell
npm run cartoon -- import <task-id> --stage <stage-id> --file <path> --metadata @metadata.json
```

Do not mark a manual or MCP profile healthy if request provenance, model/tool identity, rights notes, or output files cannot be retained.
