---
name: create-ai-cartoon-drama
description: Create, resume, review, and export a short AI cartoon drama through this repository's durable nine-stage CLI or MCP workflow. Use when starting from an original or proven-public-domain IP and a theme, producing or importing concept/script/storyboard/media artifacts, applying user feedback at every gate, recovering an interrupted task, or exporting a reviewed vertical cartoon episode.
---

# Create AI Cartoon Drama

Run one durable, sequential production. Do not create runtime subagents, skip a review, infer approval, or place generated media outside the task workspace.

## Prepare

1. Read [rights-compliance.md](references/rights-compliance.md). A task may start from IP and theme alone, but G1 cannot be approved until the user supplies an original-work declaration or auditable public-domain evidence; block unsupported modern copyrighted IP at G1.
2. Read [workflow.md](references/workflow.md), [stage-contracts.md](references/stage-contracts.md), and [review-policy.md](references/review-policy.md).
3. Read [providers.md](references/providers.md) before provider selection or any external generation.
4. Start immediately from IP and theme using the repository defaults: `zh-CN`, 9:16, target 75 seconds and 10 shots. Do not require optional audience, tone, or distribution preferences before creating G1; let the user override defaults when they wish.
5. Run `npm run cartoon -- doctor` before external media generation or rendering. A missing renderer may pause G4+, but must not prevent creating the task and drafting G1-G3.

## Start or resume

Start with the two required creative inputs:

```powershell
npm run cartoon -- start --ip "<original-or-public-domain-ip>" --theme "<theme>"
```

Capture the returned task ID. Inspect an existing task with:

```powershell
npm run cartoon -- status <task-id>
npm run cartoon -- resume <task-id>
```

Treat the task state and task folder as the production record. Never edit state files to force a transition.

## Execute every stage

For `concept`, `script`, `storyboard`, `assets`, `keyframes`, `clips`, `audio`, `edit`, then `qc`:

1. Inspect status and the approved upstream artifacts.
2. Produce only the current stage's contract. For external generation, use a configured direct API first, MCP second, or a durable manual import last.
3. Preserve prompts, provider/model identifiers, request IDs, source paths, rights notes, and relevant settings with the artifact.
4. Present a compact review packet containing the artifact, evidence, risks, and exact decision choices.
5. Wait for the user's explicit `approve`, `revise`, `regenerate`, or `abort` decision.
6. Record the decision and all feedback through the CLI; never summarize away actionable feedback.
7. Resume only after the recorded decision permits it.

```powershell
npm run cartoon -- review <task-id> --stage <stage-id> --decision revise --feedback "<verbatim actionable feedback>" --targets "<artifact-or-shot-ids>"
npm run cartoon -- resume <task-id>
```

Before G4 (`assets`), run provider `list`, `check`, and `select`. Selection freezes the production provider profile; do not silently change it later.

Import externally created artifacts through the CLI so they remain recoverable:

```powershell
npm run cartoon -- import <task-id> --stage <stage-id> --file <path> --metadata @metadata.json
```

## Finish

Approve `qc` only when creative, continuity, technical, accessibility, rights, and provider checks pass. Then export:

```powershell
npm run cartoon -- export <task-id>
```

Report the final media, subtitle, manifest, and review-record paths. Keep `output/` local; it is intentionally ignored by Git.
