# 文档地图

本目录是仓库知识真源。`AGENTS.md` 只做入口地图；细节以这里为准。

## 核心

| 文档 | 用途 |
|---|---|
| [HARNESS.md](HARNESS.md) | Harness 原则：薄入口、确认门禁、机械强制、失败反馈 |
| [WORKFLOW.md](WORKFLOW.md) | 请求分级与执行流程；何时启动团队编排 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 分层、依赖方向与边界（业务仓填写） |

## 业务与决策

| 路径 | 用途 |
|---|---|
| [product/](product/) | 产品规格、验收标准、非目标 |
| [product/templates/feature-spec.md](product/templates/feature-spec.md) | 功能规格模板与最低字段 |
| [design/](design/) | UI/UX 规格、本地原型图、实现截图和视觉验收报告；页面/交互变更必须使用 [design 模板](design/templates/design.md) 与 [verification 模板](design/templates/verification.md) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | `apps/frontend`、`apps/backend`、`packages/contracts` 空目录与边界 |
| [plans/active/](plans/active/) | 进行中的 durable exec-plan |
| [plans/completed/](plans/completed/) | 已完成计划归档 |
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
| [superpowers/plans/](superpowers/plans/) | 模版自身演进计划 |
