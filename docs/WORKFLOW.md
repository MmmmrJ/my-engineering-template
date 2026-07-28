# 工作流

先判断请求规模，再决定流程重量。不要把小改动套进完整团队编排。

## 四级流程

### 1. 只读问答

解释概念、查状态、读代码、评审现状。

- 不启动 `team-orchestrator`
- 不改生产代码、迁移、配置或测试实现
- 用最小权威文档回答，并给出证据路径

### 2. 有界小改

设计不变、契约不变的局部修复（文案、样式、明确 bugfix）。

- 可不启动完整团队；直接改相关文件
- 改完运行 `node scripts/harness/cli.mjs verify`（或业务仓配置的等价检查）
- 若发现需要改交互/契约/验收标准，升级到第 3 或第 4 级

### 3. 多会话或协调型变更

跨多模块、需跨会话跟踪、或多人角色协作的实现。

- 在 `docs/plans/active/` 创建 exec-plan（用 [templates/exec-plan.md](templates/exec-plan.md)）
- 涉及产品行为 / UI / API / 数据 / 自动化测试时启动 `team-orchestrator`
- 进度、决策、验证写进计划文件；完成后移到 `docs/plans/completed/`

### 4. 后果性歧义

会改变权限、数据兼容、用户可见行为或验收标准，但用户意图不清。

- **暂停修改**
- 给出具体选项与影响
- 需要产品方案时走 `team-orchestrator`，等待用户明确确认最新 `方案 Vn`

## 何时启动 team-orchestrator

启动：新增/修改/修复/实现/重构/迁移/测试产品行为、UI、API、数据、应用代码或自动化测试；或用户显式 `$team-orchestrator` / `启动需求：`。

不启动：普通问答、概念解释、状态查询、仅讨论想法、只读检查或评审。

流程摘要：`需求 → 方案 Vn → 用户明确确认 → 开发 → 最终 QA → 交付`。确认前禁止改生产代码、迁移、运行配置或测试实现。

## 状态与计划

- 团队角色状态：`docs/team/STATUS.md`（仅父 Agent 更新）
- Durable 计划：`docs/plans/active/*.md`
- 架构决策：`docs/decisions/`
