---
name: audit-onboarding-proposal
description: Audit an onboard-repository proposal for scope creep, missing verification commands, and unsafe overrides. Use after an onboarding proposal is drafted and before applying it.
---

# Audit Onboarding Proposal

审查 `docs/plans/active/onboarding-proposal.md`（或用户指定路径），确保入职提案可安全执行。

## 检查清单

1. 是否仍为提案（未假装已批准）。
2. 是否要求覆盖整份 `AGENTS.md` 而非合并 `team-orchestrator` 区块。
3. 是否缺少 BUILD/TEST/LINT 或 `harness.config.json` 建议。
4. 是否触及密钥、生产凭据或无关大规模重构。
5. 是否保留确认门禁与五角色边界。
6. 验证步骤是否可执行、失败时是否有下一步。

## 输出

- 结论：通过 / 需修改 / 不通过
- 问题列表（含严重级别）
- 建议修订项

不得直接应用提案或修改业务代码；只输出审计结果。
