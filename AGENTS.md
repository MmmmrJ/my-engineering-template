# Harness Engineering Agent 路由规则

本仓库是面向 Codex 与 Cursor 的多人角色交付 harness 模版。克隆后替换业务上下文，即可按「方案 → 用户确认 → 实现 → 验收」搭建自己的系统。

## 如何用于新业务

- 保留 `.agents/`、`.codex/`、`.cursor/`、`docs/`、`scripts/` 与下方 `team-orchestrator` 路由区块。
- 空业务目录：`apps/frontend/`、`apps/backend/`、`packages/contracts/`；自行搭建技术栈后填写 `docs/ARCHITECTURE.md` 与 `harness.config.json`。
- 接到已有仓库：`node scripts/harness/cli.mjs install --merge <target>`（不复制 apps）；棕地扫描用 `$onboard-repository`。
- 首次启用：`node scripts/harness/cli.mjs init --project`；填写检查配置后运行 `node scripts/harness/cli.mjs doctor --project --strict`。Codex 若提示则执行一次 `/hooks` trust。
- 完整映射见 `docs/team/SKILL_MATRIX.md`；原则见 `docs/HARNESS.md`；流程见 `docs/WORKFLOW.md`。

## Loop Engineering 路由

- 用户要求周期性巡检、每日分诊、CI 扫描、持续观察或明确输入 `$loop-*` 时，先读 `LOOP.md`、`loop.config.json` 和对应 `.agents/skills/loop-*/SKILL.md`；Loop 是跨时间控制层，不替代下面的 task approval 交付内环。
- `harness-health` 与 `daily-triage` 的 L1 主入口是 `node scripts/harness/cli.mjs loop run execute <pattern>`。Runner 自行采集输入、执行声明检查并写入结构化状态与证据；调用者不得用自报 `--result` 伪造结果。
- 无 actionable item 时必须 no-op，不创建 task、不启动 maker/verifier。需要修改产品、应用代码或自动化测试时，转入 `team-orchestrator` 的“方案 → 用户确认 → 实现 → 验收”流程。
- L2 只允许已批准 task：maker 前置门禁 → 隔离 worktree 写入 → scope 门禁 → 独立 `loop run verify` → proposal 门禁。缺任一绑定 receipt 即 fail-closed；`push`/`merge` 继续由人控制。
- 调度安装后默认关闭。每个 pattern 只能有一个具名 scheduler owner；并发触发共享 slot lease、预算和路径锁。操作、恢复与成熟度解释见 `docs/loops/README.md`。

## 文档地图

- `docs/README.md` — 文档总览
- `LOOP.md` / `docs/loops/` — Loop 运行契约、patterns、调度、恢复、测试与成熟度
- `patterns/registry.json` — 内置 pattern 的 owner、cadence、输入 adapter、skills、checks、成本与人工门禁机器投影
- `docs/plans/active/` — 多会话 durable 计划
- `docs/team/STATUS.md` — 五角色持久状态
- `docs/ARCHITECTURE.md` — 分层与禁止依赖（业务仓填写）

## 自治理配置（业务仓填写）

`harness.config.json` schema V2 只描述治理，不规定技术栈：业务仓填写 `governedPaths`，并用 `program` + `args` 数组配置 `checks.fast/full/ci`。`project` 模式下 `full` 与 `ci` 为空必须失败；完成前运行 `node scripts/harness/cli.mjs verify --profile full`。不得使用或执行旧的 `scripts/project-checks.env`。

Never-touch：`.env` 及密钥文件不得写入或 `git add`。pre-commit 使用 `guard-secrets --staged`，CI 使用 `guard-secrets --tracked`；仅可在 `.harness-secret-allowlist` 中登记经过审查的例外。

<!-- team-orchestrator:start -->
## 自动团队路由

当用户要求新增、修改、修复、实现、重构、迁移或测试产品行为、UI、API、数据、应用代码或自动化测试时，必须读取并使用 `.agents/skills/team-orchestrator/SKILL.md`，无需用户提供特殊前缀。

以下请求默认不启动团队：普通问答、概念解释、状态查询、仅讨论想法、只读检查或评审。用户显式输入 `$team-orchestrator`、`/team-orchestrator`、`启动需求：` 或明确要求使用团队工作流时，始终启动。

采用“方案先行、用户确认、再实施验收”模式：父 Agent 先用 `task create` 在 `docs/plans/active/<task-id>/` 建立唯一 active task，由 `plan.md` 与 `governance.json` 共同记录方案和机械证据。用户明确确认当前版本后才可 `task approve`；实现、验收和完成分别通过 `task validate --phase implementation|acceptance|complete`。确认前禁止修改受治理路径。完成时使用 `task complete` 归档计划并自动复位团队状态。

新增或改变页面、用户流程、交互、响应式布局或视觉设计时，UI 角色必须将 `docs/design/<feature>/design.md`、`prototypes/` 下的本地原型图及 `assets/manifest.md` 入库；原型、资产清单与设计规格共同构成实施契约。用户点名的 skill 或插件只产生可追溯候选输入，不能绕过设计冻结、用户确认或视觉验收；外部链接不能替代本地原型或运行时资产。

最终 UI 验收必须将固定视口、测试数据下的实现截图保存至 `verification/`，在 `verification.md` 中逐项映射原型图、资产版本与实现截图，并按 P0/P1/P2 记录偏差及 UI 确认人；P0/P1 必须修复，P2 必须具名确认。只有 `node scripts/harness/cli.mjs validate-visual <design-directory>` 通过，才能将 UI 验收标记为通过。

## 固定角色与共享 Skill

| Codex 类型 | Cursor 类型 | 角色 | 默认共享 Skill |
|---|---|---|---|
| `product_manager` | `product-manager` | 产品经理 | `product-management` |
| `ui_designer` | `ui-designer` | UI设计 | `ui-design` |
| `frontend_engineer` | `frontend-engineer` | 前端开发 | `frontend-engineering` |
| `backend_engineer` | `backend-engineer` | 后端开发 | `backend-engineering` |
| `qa_engineer` | `qa-engineer` | 测试工程师 | `quality-engineering` |

`.agents/team.config.json` 是角色 ID、状态、共享 skill、平台名称和写入边界的机器真源；`.codex/agents/` 与 `.cursor/agents/` 是由 `sync-agents --write` 生成的产物，不得手工修改。跨平台共享 skills 位于 `.agents/skills/`。平台插件和个人 skills 只能作为可选 overlay，不能成为 Cursor 的硬依赖。CI 用 `sync-agents --check` 阻止平台漂移。完整映射见 `docs/team/SKILL_MATRIX.md`。按需选择角色，不得为形式启动全部角色。

## 不可违反的协作约束

- 当前父 Agent 是唯一总控和最终交付责任人。
- 只有父 Agent 可以运行 `task create/approve/phase/complete`；subagent 只能读取治理记录并返回证据，不能改变任务阶段。
- 同时运行不超过 3 个直接 subagent；平台限制更低时遵守更低限制。
- subagent 不得生成下级 agent。
- 只有父 Agent 可以修改 `docs/team/STATUS.md`；subagent 只返回状态行。
- 多个角色可能修改同一文件时，改为顺序执行并明确唯一所有者。
- 实现委派必须把角色、默认 skill、允许/禁止路径、必跑检查和用户点名能力写入 `governance.json`；任何越界写入都必须阻断并重新委派。
- 保留用户和其他角色的无关改动，不得静默改变已确认范围或契约。
- 可选增强能力不可用时回退到对应共享 skill；不得因为缺少插件、个人 skill 或平台连接而阻塞基础工作。
- 用户确认是硬门禁：不得从沉默、超时、模糊回复或历史方案推断同意；开发委派必须携带明确的“用户已确认：方案 Vn”记录。
- 已确认方案若发生范围、交互、契约、数据模型或验收标准变化，必须生成新版本并返回用户审核；仅修复不改变已确认行为的实现缺陷可直接返工并由 QA 复验。
- Agent Stop/pre-commit 运行 fast profile，pre-push/任务完成运行 full profile，CI 运行 ci profile；缺配置、缺证据或检查失败均不得放行。
<!-- team-orchestrator:end -->

## 项目状态

`docs/team/STATUS.md` 是跨 Codex/Cursor 的持久状态来源。各工具原生的 subagent 活动界面仅作为实时补充。
