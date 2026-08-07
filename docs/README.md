# 文档地图

本目录是仓库知识真源。`AGENTS.md` 只做入口地图；细节以这里为准。

## 核心

| 文档 | 用途 |
|---|---|
| [HARNESS.md](HARNESS.md) | Harness 原则：薄入口、确认门禁、机械强制、失败反馈 |
| [WORKFLOW.md](WORKFLOW.md) | 请求分级与执行流程；何时启动团队编排 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 分层、依赖方向与边界（业务仓填写） |
| [../LOOP.md](../LOOP.md) | Loop 的简明运行契约与机器配置投影 |
| [loops/README.md](loops/README.md) | Loop 概念、patterns、操作、调度、安全、恢复、测试与成熟度 |

## Loop Engineering 快速入口

- 首次检查：`node scripts/harness/cli.mjs loop validate --strict`，再运行 `loop doctor` 查看 configured capability 与每个 pattern 的 observed maturity。
- L1 真实闭环：`node scripts/harness/cli.mjs loop run execute harness-health` 或 `daily-triage`。调用者不提交结果 JSON，证据由 runner 生成。
- L2 证据链：批准 task、创建 worktree/lock、通过 maker/scope gate、由独立 session 执行 `loop run verify`，最后才允许 proposal gate。
- 恢复中断运行：`node scripts/harness/cli.mjs loop run recover --stale-after <seconds>`；dirty patch 只保留并报告，不自动删除。
- `patterns/registry.json` 是由 `loop sync --write` 生成的 registry V2 投影；`loop validate --strict` 和 CI 会校验 owner、cadence、input adapters、skills、checks、cost、human gates 与 `loop.config.json` 一致。
- 新安装的 observed maturity 必须从 L0 开始；配置为 L1/L2 或复制模板文件都不构成真实运行证据。

## 业务与决策

| 路径 | 用途 |
|---|---|
| [product/](product/) | 产品规格、验收标准、非目标 |
| [product/templates/feature-spec.md](product/templates/feature-spec.md) | 功能规格模板与最低字段 |
| [design/](design/) | UI/UX 规格、本地原型图、冻结资产、实现截图和视觉验收报告；页面/交互变更必须使用 [design 模板](design/templates/design.md)、[资产清单模板](design/templates/assets/manifest.md) 与 [verification 模板](design/templates/verification.md) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | `apps/frontend`、`apps/backend`、`packages/contracts` 空目录与边界 |
| [plans/active/](plans/active/) | 业务仓当前唯一 active task；每个任务包含 `plan.md` 与 `governance.json` |
| [plans/completed/](plans/completed/) | 业务需求完成后的任务归档 |
| [harness/history/](harness/history/) | 模板自身演进记录；安装到业务仓时不作为业务任务状态 |
| [decisions/](decisions/) | 架构决策记录（ADR） |
| [templates/exec-plan.md](templates/exec-plan.md) | 执行计划模板 |

## 团队协作

| 路径 | 用途 |
|---|---|
| [team/STATUS.md](team/STATUS.md) | 五角色跨工具持久状态 |
| [team/SKILL_MATRIX.md](team/SKILL_MATRIX.md) | 角色 skill 与平台增强矩阵 |

## 实施计划（内部）

| 路径 | 用途 |
|---|---|
| [superpowers/plans/](superpowers/plans/) | 旧版模板演进输入；稳定记录归档到 `harness/history/` |
