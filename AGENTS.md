# Stock Learn Agent 路由规则

<!-- team-orchestrator:start -->
## 自动团队路由

当用户要求新增、修改、修复、实现、重构、迁移或测试产品行为、UI、API、数据、应用代码或自动化测试时，必须读取并使用 `.agents/skills/team-orchestrator/SKILL.md`，无需用户提供特殊前缀。

以下请求默认不启动团队：普通问答、概念解释、状态查询、仅讨论想法、只读检查或评审。用户显式输入 `$team-orchestrator`、`/team-orchestrator`、`启动需求：` 或明确要求使用团队工作流时，始终启动。

采用端到端自动模式：完成需求澄清、角色选择、实现和测试，只在不可逆操作、权限升级、会改变产品方向的重大歧义或真实阻塞时暂停询问。

## 固定角色

| Agent 类型 | 角色 | 责任范围 |
|---|---|---|
| `product_manager` | 产品经理 | 需求、范围、优先级、验收标准、风险与依赖 |
| `ui_designer` | UI设计 | 用户流程、页面/组件状态、响应式、无障碍、设计规范 |
| `frontend_engineer` | 前端开发 | 客户端实现、接口接入和前端测试 |
| `backend_engineer` | 后端开发 | API、数据、业务逻辑、迁移和后端测试 |
| `qa_engineer` | 测试工程师 | 测试计划、自动化测试、回归、缺陷和验收 |

Codex 角色定义位于 `.codex/agents/`；Cursor 角色定义位于 `.cursor/agents/`。按需选择角色，不得为形式启动全部角色。

## 不可违反的协作约束

- 当前父 Agent 是唯一总控和最终交付责任人。
- 同时运行不超过 3 个直接 subagent；平台限制更低时遵守更低限制。
- subagent 不得生成下级 agent。
- 只有父 Agent 可以修改 `docs/team/STATUS.md`；subagent 只返回状态行。
- 多个角色可能修改同一文件时，改为顺序执行并明确唯一所有者。
- 保留用户和其他角色的无关改动，不得静默改变已确认范围或契约。
<!-- team-orchestrator:end -->

## 项目状态

`docs/team/STATUS.md` 是跨 Codex/Cursor 的持久状态来源。各工具原生的 subagent 活动界面仅作为实时补充。
