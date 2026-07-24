---
name: onboard-repository
description: Read-only brownfield scan that proposes how to adapt this harness to an existing repo. Use when installing or adapting the harness into another project. Never apply changes without explicit user approval of the onboarding proposal.
---

# Onboard Repository

把现有业务仓库映射为 harness 可用形态。默认只读；未获用户确认前禁止写入。

## 工作流程

1. 确认任务是入职/适配 harness，不是普通功能开发。
2. 只读扫描：技术栈、目录结构、测试/构建命令、现有 `AGENTS.md`/`README`、CI、密钥文件位置。
3. 对照模版缺口列出提案：文档骨架、命令写入 `scripts/project-checks.env`、架构边界、是否合并 `team-orchestrator` 区块。
4. 将提案写入 `docs/plans/active/onboarding-proposal.md`（若目录不存在则先说明需运行 `install-harness.sh`）。
5. 明确标注：`planning_only=true`；等待用户确认提案后，才允许父 Agent 执行选定写入。
6. 可选：请 `audit-onboarding-proposal` 审查提案是否越界。

## 禁止

- 未确认就修改业务代码、覆盖整份 `AGENTS.md`、改 CI 密钥或删除文件。
- 把猜测写成既定事实；不确定处列入「待确认」。

## 交付格式

- 技术栈与目录摘要
- 建议写入的 harness 文件清单
- 建议的 BUILD/TEST/LINT 命令
- 风险与待确认项
- 提案路径：`docs/plans/active/onboarding-proposal.md`
