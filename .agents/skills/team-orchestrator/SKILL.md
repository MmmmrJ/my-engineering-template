---
name: team-orchestrator
description: Orchestrate end-to-end product delivery across product management, UI design, frontend, backend, and QA subagents. Use automatically when a request asks to add, change, fix, implement, refactor, migrate, or test product behavior, UI, APIs, application code, data, or automated tests, including natural-language requirements without a special prefix. Do not use for ordinary questions, explanations, status inquiries, or read-only reviews unless the user explicitly requests the team workflow.
---

# Team Orchestrator

把自然语言需求转化为可验证的端到端交付。由父 Agent 统一拆分、委派、收敛和验收；按需使用专职 subagent，不为凑齐角色而启动全员。

## 判断是否启动

遇到以下任一意图时启动完整流程：新增或修改产品能力、UI、API、数据、应用代码、自动化测试；修复缺陷；实施重构或迁移；显式输入 `$team-orchestrator`、`/team-orchestrator` 或 `启动需求：`。

普通问答、概念解释、状态查询、仅讨论想法以及只读检查默认不启动。若用户明确要求使用团队工作流，则始终启动。

## 遵守总控约束

- 让当前父 Agent 成为唯一总控和最终交付责任人。
- 同时运行不超过 3 个直接 subagent；平台限制更低时遵守更低限制。
- 禁止 subagent 生成下级 agent。即使平台支持嵌套委派，也只允许父 Agent 委派。
- 只让父 Agent 修改 `docs/team/STATUS.md`；subagent 只在最终回复中返回状态行。
- 默认端到端自动推进。仅在不可逆操作、权限升级、会改变产品方向的重大歧义或无法自行解除的真实阻塞时暂停询问。
- 保留用户和其他角色的无关改动；多个角色可能写同一文件时改为顺序执行并指定唯一所有者。

## 使用固定角色

| Agent 类型 | 适用任务 | 默认写入边界 |
|---|---|---|
| `product_manager` | 需求、范围、优先级、验收标准、风险与依赖 | 产品和需求文档 |
| `ui_designer` | 用户流程、页面/组件状态、响应式、无障碍、设计规范 | UI 文档和设计资产 |
| `frontend_engineer` | 客户端实现、接口接入、前端测试 | 前端代码及相关测试 |
| `backend_engineer` | API、数据、业务逻辑、迁移、后端测试 | 后端代码及相关测试 |
| `qa_engineer` | 测试计划、自动化测试、回归和验收 | 测试、夹具和测试文档 |

若平台未注册所需自定义类型，使用平台通用 worker 并在委派提示中注入对应角色、边界和状态格式；若平台无法委派，则由父 Agent 完成该有界工作并在状态中标记降级执行。

## 执行工作流

### 1. 建立事实和交付定义

先检查仓库、现有规范、代码、测试、工作树状态和可用工具。推导需求名称、用户目标、范围、非目标、验收标准、风险、依赖和合理假设。非关键缺口记录假设后继续；重大产品方向歧义标记阻塞。

### 2. 选择角色并形成依赖图

只选择交付所需角色：

- 产品行为或验收标准不明确时使用产品经理。
- 新页面、交互变化、响应式或无障碍要求时使用 UI 设计。
- 客户端代码变化时使用前端开发。
- API、业务逻辑、数据或迁移变化时使用后端开发。
- 任何生产行为变化都安排测试工程师；纯文档或只读工作可跳过。

产品和 UI 可在边界清楚时并行；后端先明确 API/数据契约；契约稳定后前后端可并行；QA 可提前制定计划，最终验收等待实现完成。

### 3. 初始化并发布状态

在委派前由父 Agent 更新 `docs/team/STATUS.md`：参与角色设为 `已排队`，不参与角色设为 `跳过`。在父任务中发布同版简表，再开始委派。

固定字段：

`角色 | 当前任务 | 状态 | 产出/进度 | 阻塞 | 下一步 | 更新时间`

状态只能使用：`待命`、`已排队`、`进行中`、`阻塞`、`待验收`、`完成`、`跳过`。时间使用项目时区 `Asia/Shanghai`，格式为 `YYYY-MM-DD HH:mm +08:00`。

### 4. 分批委派

每个委派提示都写明：目标、范围、已确认输入、依赖、允许和禁止修改的路径、预期交付物、必须运行的验证、完成标准，以及最终状态行格式。启动后立即把该角色更新为 `进行中`。

优先按以下波次推进：

1. 产品/设计规格。
2. API、数据和实现契约。
3. 前后端实现及相关单元/集成测试。
4. QA 回归、缺陷复现和验收。

每次启动、完成、阻塞、重派、进入待验收或验收结束后，都由父 Agent同步状态文件和父任务简表。

### 5. 处理阻塞和失败

- `阻塞` 必须记录原因、解除条件、责任人和下一次重派顺序。
- subagent 异常退出或未返回合格交付物时，把角色映射为 `阻塞`；修正提示后最多重试一次，再重派或由父 Agent 接管。
- 需求语义缺口按“产品确认 → 契约更新 → 实现修正 → QA 复验”处理。
- 文件冲突改为顺序执行；不得让后完成者覆盖已确认成果。

### 6. 收敛和验收

等待所有已启动角色完成，检查越界修改、契约一致性和验收标准。运行与风险相称的格式、静态检查、构建和测试。无法运行的检查必须记录原因、替代证据和剩余风险。

只有在所有参与角色为 `完成`，或剩余项已被用户明确接受时，才能关闭需求。最终回复包含实际交付内容、交付物路径、逐项验收结果、测试证据、遗留风险和下一步，并确保 `STATUS.md` 与父任务状态一致。不得只回复“已完成”“已生成方案”之类的完成摘要；必须直接呈现用户所需的方案或结果正文。

## 移植到其他项目

由父 Agent 执行迁移并写入目标项目的状态文件；subagent 只辅助检查或返回建议。复制 `.agents/skills/team-orchestrator`、`.codex/agents`、`.cursor/agents` 和 `docs/team/STATUS.md`。不要覆盖目标项目已有的 `AGENTS.md`；只合并 `team-orchestrator:start` 与 `team-orchestrator:end` 标记之间的路由区块。重置状态表为五个角色 `待命`，然后在 Codex 和 Cursor 中分别启动新任务验证发现与自动触发。
