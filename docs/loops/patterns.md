# 内置 Loop Patterns

Pattern 是可重复运行的产品契约，不只是 prompt。每个 pattern 必须定义目标、输入、输出、状态、预算、人工门禁、成功指标和停止条件。

## 总览

| ID | 目标 | 初始状态 | 建议触发 | 风险 |
|---|---|---|---|---|
| `harness-health` | 发现 harness 治理与检查漂移 | enabled / L1 | 手动、每日或 push 后 | 低 |
| `daily-triage` | 维护工程优先级和 Human Inbox | enabled / L1 | 默认手动；可显式设为每日 | 低 |
| `ci-sweeper` | 分诊 CI 失败并为明确小问题准备已验证 patch | disabled / L2-ready | CI failure 或手动 | 中 |

## `harness-health`

### 目标

尽早发现 harness 文件缺失、agent 生成物漂移、secret guard 失败、项目检查缺失或 Loop 契约不同步；不自动修复。

### 输入

- harness doctor、agent sync、secret guard、project verify 的结果。
- `loop validate`、`loop doctor` 与 `loop sync` 的结果。
- 上轮未解决的 harness-health 状态。

### 行为

1. 先做约束和预算预检。
2. 运行声明的只读检查。
3. 去重并按 blocking、warning、resolved 分类。
4. 阻断项写入 High Priority/Human Inbox；重复无变化的 warning 留在 Watch。
5. 追加 run evidence 和人读摘要，不修改治理文件或生成物。

### 人工门禁

任何 `sync-agents --write`、配置迁移、hook 修改、依赖更新或 CI workflow 修改均需要进入正常 task。

### 成功标准

- 每个发现都关联检查 id 和可复现命令。
- 无问题时 no-op 低成本退出，不制造通知。
- 模板仓 dogfood 不自动改 main，也不在安装到业务仓时自动开启 cron。

## `daily-triage`

### 目标

将近期检查、提交、任务和人工输入收敛为简洁、可行动的工程状态，减少维护者每天重复扫描的成本。

### 输入

- 当前 `STATE.md` 和 Human Inbox。
- 最近的 CI/项目检查结果。
- 可用 connector 提供的 issue/PR 信号；connector 不可用时只使用本地证据。
- 最近运行记录和已完成 task 摘要。

### 输出

- High Priority：今天值得关注且有证据的项。
- Watch List：需要观察但不应行动的项。
- Human Inbox：需要澄清、批准、权限或风险判断的项。
- Recent Noise：本轮检查并明确忽略的信号。
- 结构化 run evidence 和成本估算。

### 规则

- L1 不创建或批准 task，不修改业务代码。
- 输入不完整时记录数据来源和时效，不补猜结论。
- 每轮验证旧条目，清理已解决对象；人工 override 不得被静默覆盖。
- 没有 actionable item 时不启动 subagent。

### 成功标准

- 维护者无需阅读聊天记录即可知道当前优先级。
- 通知只针对需要人行动的项。
- 抽样可计算 actionable rate、误报率和 stale-item rate。

## `ci-sweeper`

### 目标

把失败检查分类为 deterministic regression、flake、environment/infra、ambiguous 或 risky；仅对明确、低风险、可复现的 regression 提供 L2 assisted patch。

### 初始状态

默认 `disabled/L2-ready`，表示结构能力存在，不表示可以直接行动。试运行时先由具名人将它 promote 到 L1 并显式启用，在 report-only 下完成至少 5 天/10 次有效 run、kill-switch drill 和质量门槛；随后才能 promote 回 L2。若只需要一般 CI 健康报告，应继续使用 `harness-health` 的 L1 能力。

### 输入

- 精确失败命令、退出码和必要日志。
- 相关 diff、受影响路径和已批准 task。
- attempt ledger、路径锁、预算和上轮 verifier verdict。

### L2 行为

1. 复现并分类；无法稳定复现则升级，不改代码。
2. 检查 task approval、路径、预算、锁和 attempt 上限。
3. 一个失败目标创建一个 worktree，Maker 只产出最小修复。
4. 独立 verifier 重新运行失败检查、相关回归与 scope check。
5. `APPROVE` 产出 patch 与证据供人审阅；`REJECT` 记录原因；`ESCALATE_HUMAN` 停止重试。
6. 不 push、不 merge、不禁用测试、不盲目增加 timeout。

### 必须升级给人

- Flake、infra、权限、依赖大版本、安全测试或生产配置。
- 命中 denylist、文件数上限或需改变产品/API/数据/验收标准。
- 没有已批准 task、锁冲突、预算不足、相同错误重复或第三次失败。
- Verifier 无法运行测试或实现/验证职责未分离。

### 成功标准

- 首次修复接受率、平均 attempts、误修率和人工 review 时间可度量。
- 每个 patch 可追溯到失败证据、批准 task、worktree、verifier verdict 和 run id。
- 不把 CI “变绿”当唯一成功指标；禁止通过削弱检查获得成功。

## 添加 Pattern

新增 pattern 必须：

1. 形成新的已确认方案版本。
2. 登记唯一 id、owner、level、enabled、输入、状态、预算和 gate。
3. 提供至少一个成功、no-op、模糊、预算停止和权限拒绝 fixture。
4. 默认 L1 或 disabled，不得默认为 L2。
5. 在真实 L1 运行稳定后再申请晋级。
