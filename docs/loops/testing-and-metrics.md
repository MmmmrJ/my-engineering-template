# Loop 测试与指标契约

本文件定义产品级验收边界；具体测试实现和 fixture 由 QA/工程角色维护。

## 测试分层

### 配置与 schema

- 合法最小配置、三个内置 pattern 和所有状态路径可验证。
- 未知 level、pattern、outcome、重复 id、越界路径和不完整预算被拒绝。
- `loop.config.json` 与 LOOP/STATE 投影漂移可被 sync/doctor 发现。

### L1 行为

- Prepare 加载约束、预算、pause 和 prior state。
- No-op 不启动 subagent，不修改 governed paths。
- Report-only 只更新允许的状态和证据。
- Finish 幂等；重复 finish 不重复计数或追加冲突状态。
- 中断留下可诊断 incomplete run。

### L2 安全

- Disabled pattern、无 promote、无批准 task、denylist、maxFiles、预算、锁冲突均 fail-closed。
- Worktree 不污染主工作树，拒绝/升级保留 patch 和证据。
- Maker 与 verifier 证据来源分离。
- Verifier reject/escalate 不能生成 `proposal` outcome。
- 相同错误或第 3 次失败触发熔断。
- Push、merge 和 L3 请求始终拒绝。

### 平台与回归

- Node 20/24，Windows、macOS、Linux。
- 现有 task lifecycle、install/upgrade、secret guard、agent sync、visual validation 无回归。
- GitHub dogfood 是 L1，只读权限且不自动修改 main。

## 必需 Golden Fixtures

每个 pattern 至少覆盖：

1. 成功 report/proposal。
2. 无 actionable item。
3. 模糊输入进入 Human Inbox。
4. Budget 80% 降级和 100% 停止。
5. Kill switch。
6. Deny path / maxFiles。
7. 锁冲突。
8. Verifier reject。
9. 相同错误和最大 attempts。
10. Interrupted/stale run 恢复。

Golden 断言应比较结构化决策、允许动作和证据字段，不依赖自然语言逐字一致。

## Run Evidence 最低字段

| 字段 | 说明 |
|---|---|
| `runId` | 全局唯一、稳定 |
| `loopId` / `level` / `mode` | 本轮实际实例、成熟度和模式 |
| `trigger` / `slotKey` | 调度 actor、来源和幂等槽位 |
| `startedAt` / `finishedAt` | 可计算耗时 |
| `findings` / `actions` | 分诊量与实际动作数 |
| `checks` / `evidence` | check id、status、可复现证据和 subject |
| `verification` | L2 的 maker/verifier session 与 verdict；L1 不伪造 |
| `attempt` / `errorFingerprint` | 熔断依据 |
| `estimatedTokens` | 成本估算，注明不是账单 |
| `outcome` / `escalations` | 固定终态、升级数量与 escalation evidence |
| `humanDispositions` | Human Inbox 的 accept/dismiss/defer 决定 |
| `task.taskId` / `task.approvedVersion` | 发生 L2 行动时必需 |

Evidence 不得包含 secret、完整敏感日志或无必要个人数据。

## 运营指标

### 可靠性

- Run success/no-op/failed/escalated rate。
- Incomplete/stale run 数量和平均恢复时间。
- Gate、budget、lock、verifier 拒绝次数。
- 重复错误熔断率和平均 attempts/item。

### 信号质量

- Actionable rate：发现中经人工确认值得行动的比例。
- False-positive rate：被人标记为误报的比例。
- Stale-item rate：状态中已失效条目的比例。
- Human Inbox age：等待人工决定的时长。

### 交付价值

- L2 proposal acceptance rate。
- 从发现到人工可审 patch 的中位时间。
- 人工 review/triage 时间变化。
- 被拒 patch 的根因分布；不得只统计产出数量。

### 成本

- Runs/day、估算 tokens/run/day、subagent spawns/run。
- No-op 平均成本和高频 pattern early-exit 命中率。
- 连续两周成本/价值趋势。

## 晋级判定

Readiness score 只作摘要，不能单独授权 L2。晋级报告必须同时展示：

- 真实 L1 运行窗口和样本量。
- False-positive、stale、failed、escalated 指标。
- Budget/kill/deny/lock/verifier/attempt golden 结果。
- 当前 owner、通知通道和人工响应能力。
- Full/CI checks 与剩余风险。

任何缺失均保持 L1/disabled。V1 的机械最低门槛为：至少 5 天内 10 次有效 L1 run、100% evidence、零未授权写、false positives ≤20% 和一次 kill-switch drill。项目 owner 可以设定更严格阈值，不能降低这些安全下限；即使达到数值门槛，也仍需具名人批准。

## 发布验收命令

```sh
node scripts/harness/run-tests.mjs
node scripts/harness/cli.mjs doctor --template --strict
node scripts/harness/cli.mjs sync-agents --check
node scripts/harness/cli.mjs guard-secrets --tracked
node scripts/harness/cli.mjs verify --profile ci
node scripts/harness/cli.mjs loop validate --strict
node scripts/harness/cli.mjs loop doctor --strict
node scripts/harness/cli.mjs loop metrics
```

无法运行的检查必须记录原因、替代证据和剩余风险；不得标记为 pass。
