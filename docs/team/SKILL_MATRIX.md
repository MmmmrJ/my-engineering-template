# 五角色 Skill 与平台兼容矩阵

本项目采用“共享基础 skill + 平台可选增强”结构。`.agents/skills/` 是 Codex 与 Cursor 的共同能力来源；任何增强缺失都必须回退到共享 skill，不得阻塞基础工作。

## 角色映射

| 角色 | 默认共享 Skill（双平台） | Codex 可选增强 | 触发条件 | Cursor 策略 |
|---|---|---|---|---|
| 产品经理 | `product-management` | `product-design:index` | 用户显式要求 Product Design、UX 研究或产品体验研究 | 使用共享 skill；已安装的研究能力可按需增强，不写 Codex 名称或 URI |
| UI设计 | `ui-design` | `product-design:index` → `audit` / `ideate`；`frontend-skill`；Figma skills | 分别用于明确的体验审计、视觉变体、选定方向后的生产级艺术指导、Figma 交付物 | 使用共享 skill；Cursor 本地设计/浏览器/Figma 能力只在可用且明确匹配时使用 |
| 前端开发 | `frontend-engineering` | `frontend-skill`；`playwright`；`product-design:image-to-code` / `url-to-code`；`security-best-practices` | 已选视觉方向的生产级实现；真实浏览器验证；已选视觉目标/明确 URL 克隆；显式安全审查 | 使用共享 skill 与项目测试；可使用 Cursor 自带浏览器或已安装等价能力 |
| 后端开发 | `backend-engineering` | `security-best-practices` | 用户或总控明确要求专项安全审查/安全加固，且语言受支持 | 使用共享 skill；安全能力按当前 Cursor 安装态选择，不作为普通 API 开发前提 |
| 测试工程师 | `quality-engineering` | `playwright`；`product-design:index` → `audit`；`security-best-practices` | 真实浏览器/E2E；明确 UX/无障碍体验审计；显式安全审查 | 使用共享 skill、项目测试和人工清单；平台增强缺失时记录证据缺口 |
| 入职（可选） | `onboard-repository` | — | 将 harness 适配到棕地仓库、生成入职提案 | 只读提案；确认前不写入 |
| 入职审计（可选） | `audit-onboarding-proposal` | — | 审查入职提案是否越界或缺验证命令 | 只输出审计结论 |

## 严格触发边界

- Product Design 是设计探索/审计/视觉目标工作流，不是所有 UI 修改的默认依赖。
- `frontend-skill` 只用于视觉方向已选定后的生产级艺术指导、新页面或重设计，不用于方向发散、普通业务逻辑、CSS 小修或既有规格实现。
- `playwright` 只在需要真实浏览器交互、截图、调试或 E2E 证据时使用；纯单元/API 测试不调用。
- Figma skills 只在任务明确涉及 Figma 时使用；创建或写入 Figma 属于外部状态变更，必须符合对应 skill 的前置规则。
- `security-best-practices` 只在明确的安全审查或安全加固请求中使用，不能因为“后端/前端开发”而自动触发。
- `onboard-repository` 默认只读；未确认提案不得覆盖 `AGENTS.md` 或业务代码。
- 所有增强都继承角色原有写入边界，不能授权 subagent 生成下级 agent 或修改 `docs/team/STATUS.md`。
- 用户点名 skill 或插件时，父 Agent 必须登记请求能力、适用角色、输入、候选产物、预期设计交付与降级方式；其产物不构成实施批准，也不能免除本地资产、设计冻结和视觉验收要求。

## 页面与交互设计交付门禁

- 新增或改变页面、用户流程、交互、响应式布局或视觉设计时，UI 角色必须创建 `docs/design/<feature>/design.md`，将本地原型图放入同目录 `prototypes/`，并创建可追溯的 `assets/manifest.md` 与冻结资产；三者共同构成实施契约。外部链接只能作为补充，运行时图片不得依赖外链。
- 前端角色必须在实现前阅读该 `design.md`、原型图和资产清单，确认设计/资产冻结并运行 `node scripts/harness/cli.mjs validate-design <design-directory>`；缺失或校验失败时不得自行补猜视觉/交互细节、替换图标/背景图或重设计，应交回父 Agent。
- QA 必须以该设计目录作为 UI 验收基线，检查关键页面、状态、交互、资产版本、响应式与无障碍；实现偏离设计时按缺陷或方案变更处理。
- 不涉及用户可见 UI 的需求，Feature Spec 必须显式标记 `设计交付：not-applicable` 并说明原因。
- 最终 QA 必须把固定视口、测试数据、原型图、资产版本、实现截图与结论写入 `verification.md`，并运行 `validate-visual`。P0/P1 偏差未修复、P2 偏差无具名 UI 确认、缺失截图或结论非 `pass` 时不得通过。

## 用户确认门禁

- 每次团队工作流先产出带版本号的产品、UI、技术实施与测试方案；父 Agent 直接展示完整方案并等待用户确认。
- 方案阶段前后端只能只读检查和规划，QA 只能制定测试计划；不得修改生产代码、迁移、配置、依赖或测试实现。
- 开发委派必须包含 `用户已确认：方案 Vn`。沉默、模糊回复、部分确认或同时附带修改要求均不解除门禁。
- 用户不满意时重派受影响角色，递增方案版本并重新审核；完整最新版本明确获批后才开始开发。
- 最终 QA 只在实现角色完成后启动，并以确认版本为基线；需要改变设计或契约的修复必须返回方案审核。
- `待用户确认` 表示方案门禁，`待验收` 表示实现后的 QA 阶段，两者不得混用。

## 兼容性说明

- 共享层：`SKILL.md` 位于 `.agents/skills/<name>/`，名称只用小写字母、数字和连字符，并与目录名一致。
- Codex 层：`.codex/agents/*.toml` 可以引用当前 Codex 安装态中的插件/个人 skills；迁移后应重新检查可用性。
- Cursor 层：`.cursor/agents/*.md` 使用连字符名称与 `model: inherit`；不得包含 `plugin://`、Codex 用户目录或 Codex 专属 skill 标识。
- `agents/openai.yaml` 是 Codex 展示元数据，Cursor 可忽略，不能作为 Cursor 执行前提。
- 机械护栏：`node scripts/harness/cli.mjs guard` + `.cursor/hooks.json` / `.codex/config.toml` / `.githooks/`。

## 推荐验收用例

1. “定义新功能的目标用户、范围和验收标准”只选择产品 skill。
2. “探索三个页面视觉方向”选择 UI skill；Codex 有 Product Design 时可进入 ideate。
3. “修复既有 CSS 断点，设计不变”只选择前端 skill，不启动 UI 或 Product Design。
4. “新增业务 API、幂等规则和迁移”选择后端 skill；普通开发不触发专项安全审查。
5. “自动化验证登录、主路径和错误提示”选择 QA skill，并在可用时使用真实浏览器能力。
6. “把 harness 装进这个旧仓库”选择 `onboard-repository`，确认后再写入。
7. 在 Cursor 中执行跨前后端需求，确认所有角色只依赖 `.agents/skills/`，且缺少 Codex 插件不会阻塞。
8. 输入新需求后确认只产出 `方案 V1` 且不修改实现；反馈“不满意”后确认生成 V2 并再次等待；明确批准 V2 后才启动开发和最终 QA。
9. `node scripts/harness/cli.mjs guard "git push --force"` 被拦截；`node scripts/harness/cli.mjs doctor --strict` 通过。
