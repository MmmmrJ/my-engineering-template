# Stock Learn Agent 路由规则

<!-- team-orchestrator:start -->
## 自动团队路由

当用户要求新增、修改、修复、实现、重构、迁移或测试产品行为、UI、API、数据、应用代码或自动化测试时，必须读取并使用 `.agents/skills/team-orchestrator/SKILL.md`，无需用户提供特殊前缀。

以下请求默认不启动团队：普通问答、概念解释、状态查询、仅讨论想法、只读检查或评审。用户显式输入 `$team-orchestrator`、`/team-orchestrator`、`启动需求：` 或明确要求使用团队工作流时，始终启动。

采用“方案先行、用户确认、再实施验收”模式：先完成产品/UI/技术设计与实施计划并提交用户审核；在用户明确确认最新方案版本前，禁止修改生产代码、迁移、运行配置或测试实现。用户不满意时按反馈修订并重复审核，确认后才进入开发，开发完成后才执行最终验收。

## 固定角色与共享 Skill

| Codex 类型 | Cursor 类型 | 角色 | 默认共享 Skill |
|---|---|---|---|
| `product_manager` | `product-manager` | 产品经理 | `stock-learn-product-management` |
| `ui_designer` | `ui-designer` | UI设计 | `stock-learn-ui-design` |
| `frontend_engineer` | `frontend-engineer` | 前端开发 | `stock-learn-frontend-engineering` |
| `backend_engineer` | `backend-engineer` | 后端开发 | `stock-learn-backend-engineering` |
| `qa_engineer` | `qa-engineer` | 测试工程师 | `stock-learn-quality-engineering` |

Codex 角色定义位于 `.codex/agents/`；Cursor 角色定义位于 `.cursor/agents/`；跨平台共享 skills 位于 `.agents/skills/`。委派时必须让角色加载自己的默认共享 skill。平台插件和个人 skills 只能按 `.codex/agents/` 中的触发条件作为 Codex 增强，不能成为 Cursor 的硬依赖。完整映射见 `docs/team/SKILL_MATRIX.md`。按需选择角色，不得为形式启动全部角色。

## 不可违反的协作约束

- 当前父 Agent 是唯一总控和最终交付责任人。
- 同时运行不超过 3 个直接 subagent；平台限制更低时遵守更低限制。
- subagent 不得生成下级 agent。
- 只有父 Agent 可以修改 `docs/team/STATUS.md`；subagent 只返回状态行。
- 多个角色可能修改同一文件时，改为顺序执行并明确唯一所有者。
- 保留用户和其他角色的无关改动，不得静默改变已确认范围或契约。
- 可选增强能力不可用时回退到对应共享 skill；不得因为缺少插件、个人 skill 或平台连接而阻塞基础工作。
- 用户确认是硬门禁：不得从沉默、超时、模糊回复或历史方案推断同意；开发委派必须携带明确的“用户已确认：方案 Vn”记录。
- 已确认方案若发生范围、交互、契约、数据模型或验收标准变化，必须生成新版本并返回用户审核；仅修复不改变已确认行为的实现缺陷可直接返工并由 QA 复验。
<!-- team-orchestrator:end -->

## 项目状态

`docs/team/STATUS.md` 是跨 Codex/Cursor 的持久状态来源。各工具原生的 subagent 活动界面仅作为实时补充。
