# Loop 与交付工作流

先判断来源和请求规模，再决定流程重量。人工请求与 Loop 发现最终共用同一 delivery harness；Loop 不得成为绕过方案确认的第二条实施通道。

## 外层 Loop 生命周期

```text
disabled / draft
  → L1 report-only
  → Human Inbox 或 no-op
  → （显式晋级后）L2 assisted
  → proposal / failed / escalated
  → 下一轮、降级或 paused
```

一轮固定执行：

`run prepare → 约束/预算/锁预检 → pattern 分诊/行动 → run finish → 状态与证据`

- `harness-health`、`daily-triage` 默认 L1。
- `ci-sweeper` 是 L2-ready，但默认 disabled。
- L1 不创建代码 patch，不修改 governed paths。
- L2 发现需要业务修改时，必须关联现有已批准 task；没有批准就进入 Human Inbox。
- 本模板不支持 L3、自动 push 或自动 merge。

成熟度、状态和晋级规则见 [loops/concepts.md](loops/concepts.md)，每轮操作见 [loops/operations.md](loops/operations.md)。

## 任务生命周期

每次实施只允许一个 active task。父 Agent 创建任务并维护其 `governance.json`；subagent 只能返回自己的状态和证据，不得改变任务阶段。

```text
planning → awaiting_approval → approved → implementing → accepting → completed / blocked
```

- `task create <id>`：创建 `docs/plans/active/<id>/plan.md` 与 `governance.json`。
- `task approve <id> --version Vn ...`：仅在用户明确确认当前版本后记录批准。
- `task phase`：按合法状态机推进；实现角色未完成时不能进入验收。
- `task complete`：验证全部参与角色、保留字 `qa-acceptance` 的 QA 通过结论、必跑检查证据和剩余风险后归档，并自动重置团队状态；业务任务归档到 `docs/plans/completed/`，模板模式的自身演进归档到 `docs/harness/history/`。

## Loop 发现如何进入 Task

1. Loop 为候选工作分配稳定 item id，并保存来源、时效、风险和建议动作。
2. L1 只写入 `STATE.md`/Human Inbox；父 Agent 或用户决定是否建立 task。
3. 父 Agent创建唯一 active task，收敛方案 Vn 并等待用户明确确认。
4. 只有当前方案批准后，L2 才能在 task `allowedPaths` 内申请锁、创建 worktree 和产出最小 patch。
5. 独立 verifier 的 `APPROVE` 把 patch 送入实施/验收流程，不改变 task phase。
6. Task 完成、拒绝或阻塞结果在下一轮回写 Loop 状态；关闭条目从 active 投影清理，历史留在 run evidence。

如果已有 active task，新的 mutating item 默认进入 Human Inbox 排队；多个 L1 报告 pattern 可继续运行，但不得争用同一 action state。

## 四级请求处理

### 1. 只读问答

解释概念、查状态、读代码、评审现状。

- 不启动 `team-orchestrator`
- 不改生产代码、迁移、配置或测试实现
- 用最小权威文档回答，并给出证据路径

来自定时 Loop 的 L1 分诊也属于只读/报告行为，但仍必须遵守预算、状态和 run evidence 契约。

### 2. 有界小改

设计不变、契约不变的局部修复（文案、样式、明确 bugfix）。

- 可不启动完整团队；直接改相关文件
- 若文件命中 `governedPaths`，仍必须创建任务、登记所有权并取得适用的确认；“小改”只减轻角色数量，不绕过机械门禁
- 改完运行 `node scripts/harness/cli.mjs verify --profile fast`
- 若发现需要改交互/契约/验收标准，升级到第 3 或第 4 级

Loop 不得使用“有界小改”绕过批准。L2 只能生成 patch 提案，task 阶段仍由父 Agent 推进。

### 3. 多会话或协调型变更

跨多模块、需跨会话跟踪、或多人角色协作的实现。

- 使用 `task create` 创建结构化 active task，并在 `plan.md` 中维护执行计划
- 涉及产品行为 / UI / API / 数据 / 自动化测试时启动 `team-orchestrator`
- 进度、决策、验证写进任务目录；通过完成门禁后由 `task complete` 归档到当前模式对应的历史目录
- 新增或改变页面、用户流程、交互、响应式布局或视觉设计时，UI 角色必须在方案阶段提交 `docs/design/<feature>/design.md`、`prototypes/` 下的本地原型图和 `assets/manifest.md`；用户确认后冻结资产与设计。前端实现前运行 `validate-design`，最终 QA 将同条件截图、资产版本和 P0/P1/P2 偏差记录写入 `verification.md` 后运行 `validate-visual`

### 4. 后果性歧义

会改变权限、数据兼容、用户可见行为或验收标准，但用户意图不清。

- **暂停修改**
- 给出具体选项与影响
- 需要产品方案时走 `team-orchestrator`，等待用户明确确认最新 `方案 Vn`

## 何时启动 team-orchestrator

启动：新增/修改/修复/实现/重构/迁移/测试产品行为、UI、API、数据、应用代码或自动化测试；或用户显式 `$team-orchestrator` / `启动需求：`。

不启动：普通问答、概念解释、状态查询、仅讨论想法、只读检查或评审。

流程摘要：`需求 → 方案 Vn → 用户明确确认 → task approve → 开发 → 最终 QA → task complete`。确认前修改 governed paths 会被本地 hooks 与 CI 阻断。

## 状态与计划

- Loop 当前状态：`STATE.md`（优先级、Watch、Human Inbox、Last run）
- Loop 机器证据：`.harness/runtime/runs/` 与 `.harness/runtime/ledgers/`
- Loop 人读历史：`loop-run-log.md`
- 团队角色状态：`docs/team/STATUS.md`（仅父 Agent 更新）
- Durable 计划：`docs/plans/active/<task-id>/{plan.md,governance.json}`
- 架构决策：`docs/decisions/`

## 失败与恢复

- Budget 80%：降为 L1；100% 或 kill switch：业务写入前退出。
- 相同错误、无进展或第三次失败：熔断并进入 Human Inbox。
- Lock 冲突：后启动者跳过或排队，不自动合并冲突。
- Verifier reject：保留 patch/证据，责任角色可在不改变方案时返工；若需改范围/契约则回到用户审核。
- S2/S3、越权或错误 patch：pause mutating patterns，人工复盘和 QA 重放后才能 resume。

详细分类见 [loops/failure-modes.md](loops/failure-modes.md)。
