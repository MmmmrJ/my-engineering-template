# Loop 概念、状态与成熟度

## 产品目标

让仓库维护者设计一个跨会话重复运行的工程控制系统，而不是持续手工输入下一条 prompt。系统应能发现工作、记住历史、控制成本、隔离行动、独立验证，并在风险或不确定时把完整上下文交回人。

目标用户包括维护 AI-heavy 仓库的工程负责人、将模板安装到绿地或棕地仓库的平台工程师，以及需要 Codex/Cursor 共用治理规则的团队。

## 非目标

- 不提供 L3 无人值守或自动 merge。
- 不替代产品方案、用户明确确认和 QA acceptance。
- 不复制上游 Loop Engineering 的全部工具和生态。
- 不规定业务技术栈或部署平台。
- 不把 worktree 描述为 OS、网络或凭据沙箱。
- 不保证 token 估算等于供应商账单。

## Loop 与 Task

Loop 是跨时间重复运行的外层控制系统；task 是一次有边界的交付内环。

Pattern 是可复用行为定义；Loop id 是当前仓库中的配置实例。同一 pattern 可以有不同 owner、cadence 或状态实例，但 mutating 实例仍受单 active task 和路径锁约束。CLI 中的 `<id>` 指 Loop 实例，`--pattern` 指内置 pattern id。

```text
Loop: 触发 → 分诊 → 状态 → 选择 action ───────────────┐
                              │                        │
                              ▼                        │
Task:                 方案 → 确认 → 实现 → 验收       │
                              │                        │
                              └──── 结果/证据 ─────────┘
```

Loop 可以发现和提出 task，但不能自动批准 task。Task 完成后，Loop 在下一轮读取结果、清理过期条目并决定是否仍需关注。

## 状态分层

### `STATE.md`：跨轮工程记忆

回答：什么重要、什么在观察、什么等待人、上轮发生了什么。建议稳定分区：

- High Priority
- Watch List
- Human Inbox
- Recent Noise
- Last run / active pause

Loop 可更新这些分区，但必须保留人工 override，并校验外部对象是否仍有效。

### Pattern state：行动状态

回答：某个 pattern 正在处理哪个 item、当前 owner、attempt 和下一步。多个 mutating pattern 不得共同写一段无 schema 文本。

### `.harness/runtime/runs/*.json`：每轮证据

回答：一次 run 实际输入、决策、动作、检查和结果是什么。它是机器可读证据，根 `loop-run-log.md` 是面向人的追加摘要。

### `.harness/runtime/ledgers/<runId>.json`：尝试与熔断

回答：同一工作试过几次、错误是否重复、何时必须停止。它不能被清空来绕过最大尝试次数。

### `docs/team/STATUS.md`：当前角色活动

只回答父 Agent 和各专业角色正在做什么。它不是 Loop watchlist，也不是运行历史，只有父 Agent 可以修改。

### Task governance：一次交付事实

`docs/plans/active/<task-id>/governance.json` 保存方案版本、用户批准、角色路径、必跑检查和 acceptance。Loop 不得伪造或推断批准。

## 成熟度

### L0 — Draft

有目标和初始配置，但还没有可信的 report-only 闭环。允许验证配置，不允许宣称已投入运行。

进入 L1 必须满足：

- pattern、状态、约束、预算、日志路径通过 `loop validate`。
- `loop doctor --strict` 没有阻断项。
- 至少一个 L1 pattern 可手动 `run prepare` 并用真实结果 `run finish`。
- kill switch 和 fail-closed 路径已验证。

### L1 — Report

可重复发现、分诊、更新状态和追加日志；不得修改 governed paths、创建代码 patch 或启动 maker/verifier 链。

L1 是所有新安装和新 report-only pattern 的默认成熟度。`harness-health` 与 `daily-triage` 为 enabled/L1，但 trigger 默认 manual，不会自行调度；`ci-sweeper` 为 disabled/L2-ready。Enabled 决定是否可手动运行，trigger/cadence 决定是否调度，level 决定获准行为，三者不能互相替代。

### L2 — Assisted

只针对明确、低风险、可验证的单一问题，在隔离 worktree 生成最小 patch，并由独立 verifier 给出 verdict。L2 的 `APPROVE` 只表示可供人工评审，不能绕过 task approval、QA、push 或 merge 门禁。

## L1 → L2 晋级门槛

必须全部满足并由具名人显式执行 promote：

- 至少有真实、连续的 L1 运行证据，而非只复制结构文件。
- 至少 5 天内有连续 10 次有效 L1 run，证据完整率 100%，无 governed path 未授权写入、重复 run/inbox 或未解释漂移。
- False-positive rate 不高于 20%，且至少有一次 kill-switch drill 证据。
- 分诊输出经过人工抽样，误报和漏报处于团队接受范围。
- `loop-budget.md`、kill switch、80% 降级和 100% 停止已演练。
- `gate.yaml` denylist、最大文件数、禁止自动 push/merge 均机械生效。
- worktree create/mark/cleanup 与路径 lock 冲突流程通过测试。
- Maker 和 verifier 身份分离；verifier 能独立运行必需检查。
- attempt ledger 对相同错误、无进展和最多 3 次尝试 fail-closed。
- 目标 pattern 有明确输入、可验证完成条件、人工升级位置和 owner。
- 当前仓库的 harness full/ci 检查为绿。

不允许因单一 readiness 分数或文件存在直接晋级。`ci-sweeper` 虽然 L2-ready，初始仍是 disabled。

## 降级与暂停

以下任一发生时降回 L1 或暂停：

- S2/S3 事故、越权修改或错误 patch 被采用。
- verifier 无法复现或出现“实现者自我批准”。
- 预算失控、同错重试、无进展或误报率持续恶化。
- owner 无法响应 Human Inbox。
- 大型迁移、生产事故或关键 reviewer 不可用。

恢复前必须记录原因、已采取的防复发措施、验证证据和具名恢复人。
