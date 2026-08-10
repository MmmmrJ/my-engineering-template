# Provider profiles

`config/providers.example.json` is the safe, committed template. `config/providers.local.json` is the ignored machine-local override. Keep credentials in environment variables and reference them by name from a profile.

## Mode order

| Mode | Use when | Health evidence | Durability |
| --- | --- | --- | --- |
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

## Capability coverage

Before selection, verify that the chosen profile covers every required generation capability for the production. A profile can mix modes, but every route must preserve provider/tool identity, concrete model, request or resource ID when available, prompts/settings, output paths, and rights notes.

Treat ComfyUI as a provider endpoint, not as proof that the loaded checkpoint or workflow is licensed. Record checkpoint/workflow identifiers and their rights basis separately.

## Failure handling

- Missing secret: configure the named environment variable; do not request the value in chat.
- Missing MCP tool: configure the server or choose another declared route.
- Manual-only capability: document the handoff and validate metadata import before freezing.
- Outage or quota failure after freeze: stop, retain provider errors, and ask the user whether to wait, retry, use the already-frozen manual route, or create a replacement task. V1 does not mutate a frozen binding.
- Model drift: pin a concrete model/version when supported and record the observed model identifier in every result.
