---
name: team-orchestrator
description: "Orchestrate approval-gated product delivery across product management, UI design, frontend, backend, and QA subagents: produce a versioned product, design, technical implementation, and test plan; wait for explicit user approval; then implement and run final acceptance. Use automatically when a request asks to add, change, fix, implement, refactor, migrate, or test product behavior, UI, APIs, application code, data, or automated tests, including natural-language requirements without a special prefix. Do not use for ordinary questions, explanations, status inquiries, or read-only reviews unless the user explicitly requests the team workflow."
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
- 强制分阶段推进：先形成方案并等待用户明确确认，确认前不得进入实现；确认后自动完成开发和最终验收。
- 不得从沉默、超时、模糊回复、旧方案确认或“继续看看”等表达推断批准。只有用户明确确认当前最新方案版本，才解除开发门禁。
- 保留用户和其他角色的无关改动；多个角色可能写同一文件时改为顺序执行并指定唯一所有者。

## 使用固定角色与 Skills

| Codex / Cursor 类型 | 默认共享 Skill | 适用任务 | 默认写入边界 |
|---|---|---|---|
| `product_manager` / `product-manager` | `product-management` | 需求、范围、优先级、验收标准、风险与依赖 | 产品和需求文档 |
| `ui_designer` / `ui-designer` | `ui-design` | 用户流程、页面/组件状态、响应式、无障碍、设计规范 | UI 文档和设计资产 |
| `frontend_engineer` / `frontend-engineer` | `frontend-engineering` | 客户端实现、接口接入、前端测试 | 前端代码及相关测试 |
| `backend_engineer` / `backend-engineer` | `backend-engineering` | API、数据、业务逻辑、迁移、后端测试 | 后端代码及相关测试 |
| `qa_engineer` / `qa-engineer` | `quality-engineering` | 测试计划、自动化测试、回归和验收 | 测试、夹具和测试文档 |

委派时把所选共享 skill 的路径写进提示，要求 subagent 完整读取后执行。再根据 `docs/team/SKILL_MATRIX.md` 选择平台增强：只在能力存在且触发条件满足时使用；增强缺失时回退共享 skill，不得阻塞或扩大角色边界。Cursor 委派中不得注入 Codex plugin URI、Codex 专属 skill 名称或本机绝对路径。

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

产品和 UI 可在边界清楚时并行；前后端可在方案阶段只读检查并提出 API、数据、文件影响和实施计划；QA 可提前制定测试计划。所有实现与最终验收必须等待用户确认最新方案。

### 3. 初始化并发布状态

在委派前由父 Agent 更新 `docs/team/STATUS.md`：参与角色设为 `已排队`，不参与角色设为 `跳过`。在父任务中发布同版简表，再开始委派。

固定字段：

`角色 | 当前任务 | 状态 | 产出/进度 | 阻塞 | 下一步 | 更新时间`

状态只能使用：`待命`、`已排队`、`进行中`、`待用户确认`、`阻塞`、`待验收`、`完成`、`跳过`。`待用户确认` 专用于方案审核门禁，`待验收` 专用于实现后的 QA 阶段。时间使用项目时区 `Asia/Shanghai`，格式为 `YYYY-MM-DD HH:mm +08:00`。

### 4. 产出待审核方案

在方案阶段只允许检查现状，以及编写需求、设计、契约、实施计划和测试计划文档。禁止修改生产代码、迁移、运行配置、测试实现或以“原型”为名写入将直接进入产品的实现代码。

按需委派产品、UI、前端、后端和 QA 进行方案工作，并明确标注 `planning_only=true` 和 `方案阶段：未获用户确认，禁止实施`。父 Agent 收敛为带版本号的 `方案 Vn`，至少直接向用户呈现：

- 目标、范围、非目标和关键假设。
- 用户流程、页面/组件状态；若新增或改变页面、交互、响应式或视觉设计，必须附 `docs/design/<feature>/design.md` 与本地原型图，或明确说明不涉及 UI。
- API、数据、兼容、迁移和回滚设计，或不涉及后端的明确说明。
- 前后端实施步骤、文件影响、依赖顺序和责任角色。
- 测试计划、验收标准、风险和待决项。

把实际承担并完成方案任务的角色设为 `待用户确认`；这可以包含产品、UI，也可以包含提供技术计划的前端、后端或 QA。仅被选中但未承担方案任务的后续实现/验收角色保持 `已排队`。总控状态使用精确枚举值 `待用户确认`，把 `方案 Vn` 写入当前任务或产出/进度字段，然后停止开发并请求用户审核。不得把方案交付表述为需求已完成。

### 5. 执行用户审核循环

- 只有用户明确表达“确认”“同意”“按此执行”“开始开发”或语义等价的批准，并且指向当前最新 `方案 Vn`，才记录确认版本和时间。
- 用户提出不满意、修改意见或新约束时，识别受影响角色，保持所有开发角色不启动，回到方案阶段修订；递增版本号并列出相对上一版的变更，再提交用户审核。
- 用户只确认部分内容时，记录已认可部分，但整个方案仍保持门禁，直到用户明确确认完整最新版本。
- 回复含义不清时只澄清是否批准，不得开始开发。
- 用户确认后，将确认版本、确认时间和范围摘要写入 `STATUS.md`；把所需实现角色（无论此前为 `待用户确认` 或 `已排队`）统一转为 `已排队`，实际启动时再更新为 `进行中`。QA 保持 `已排队`，直到所有实现角色完成。
- 确认后若范围、交互、API/数据契约或验收标准发生实质变化，立即暂停受影响实现，生成新方案版本并重新请求确认。仅修复不改变已确认行为的实现缺陷无需重新确认。

### 6. 分批实施

每个实现委派提示都写明：`用户已确认：方案 Vn`、确认范围、目标、依赖、默认共享 skill 路径、允许和禁止修改的路径、预期交付物、必须运行的验证、完成标准、可选平台增强及其触发条件，以及最终状态行格式。缺少明确确认记录时，前端、后端和 QA 不得执行实现或最终验收。启动后立即把该角色更新为 `进行中`。

涉及页面、用户流程、交互、响应式或视觉设计时，委派 UI 角色创建 `docs/design/<feature>/design.md` 与 `prototypes/` 下的本地原型图；委派前端时必须给出设计目录并要求先运行 `validate-design`；委派 QA 时必须把设计目录作为视觉和交互验收基线。Feature Spec 如确实不涉及 UI，必须明确标注 `设计交付：not-applicable`。

最终 UI 验收还必须要求 QA 创建 `verification.md` 与 `verification/` 下的实现截图：每个原型场景映射固定视口、测试数据和实现截图；任何偏差写明原因、影响、UI 确认人和设计版本。只有 `validate-visual` 通过，才能把相关 UI 验收标为通过。

优先按以下波次推进：

1. 已确认方案中的 API、数据和共享契约。
2. 前后端实现及相关单元/集成测试。
3. 实现收敛和缺陷修复。
4. QA 最终回归、真实流程和验收。

每次启动、完成、阻塞、重派、进入待验收或验收结束后，都由父 Agent同步状态文件和父任务简表。

### 7. 处理阻塞和失败

- `阻塞` 必须记录原因、解除条件、责任人和下一次重派顺序。
- subagent 异常退出或未返回合格交付物时，把角色映射为 `阻塞`；修正提示后最多重试一次，再重派或由父 Agent 接管。
- 需求语义缺口按“产品确认 → 契约更新 → 实现修正 → QA 复验”处理。
- 文件冲突改为顺序执行；不得让后完成者覆盖已确认成果。
- 实现结果偏离已确认方案时先按缺陷返工；若修正需要改变方案，则回到用户审核循环。

### 8. 收敛和最终验收

等待所有实现角色完成后才启动最终验收。QA 必须以用户确认的方案版本为基线，检查越界修改、契约一致性和验收标准，并运行与风险相称的格式、静态检查、构建、自动化和真实流程测试。无法运行的检查必须记录原因、替代证据和剩余风险。

最终验收发现缺陷时，父 Agent 将缺陷交回责任角色修复，再由 QA 复验；修复不改变已确认设计时自动推进，改变设计时回到用户审核循环。

只有在所有参与角色为 `完成`，或剩余项已被用户明确接受时，才能关闭需求。最终回复包含实际交付内容、交付物路径、逐项验收结果、测试证据、遗留风险和下一步，并确保 `STATUS.md` 与父任务状态一致。不得只回复“已完成”“已生成方案”之类的完成摘要；必须直接呈现用户所需的方案或结果正文。

## 移植到其他项目

由父 Agent 执行迁移并写入目标项目的状态文件；subagent 只辅助检查或返回建议。优先使用 `node scripts/harness/cli.mjs install --merge <target>`；不要覆盖目标项目已有的 `AGENTS.md`，只合并 `team-orchestrator:start` 与 `team-orchestrator:end` 标记之间的路由区块。棕地仓库先用 `onboard-repository` 产出提案并经用户确认。重置状态表为五个角色 `待命`，然后在 Codex 和 Cursor 中分别启动新任务验证发现、角色名称映射与自动触发。运行 `node scripts/harness/cli.mjs doctor --strict` 做安装后体检。
