<!-- loop-config-sha256:211c88f2d4ad0437e1f2b6e91654a060a4dd1d3f901802ca11011d43935cae62 -->
# Loop 运行契约

本文件是模板的人类可读 Loop 总约定。机器可读配置以 `loop.config.json` 为准；CLI 必须检查两者引用的 pattern、级别和状态路径是否一致。

## 目标

让工程维护从一次性 agent 对话升级为可重复、可观察、可停止的闭环，同时保留现有用户确认、路径治理和独立验收门禁。

## Active Loops

Pattern 是可复用定义，Loop id 是安装到当前仓库的实例。以下名称是模板建议；实际 enabled、level 与 id 以 `loop.config.json` 为准。

| Pattern | 模板配置 | 触发 | 状态 | 是否可修改 governed paths |
|---|---|---|---|---|
| `harness-health` | enabled / L1 | 手动；模板仓可定时 dogfood | `STATE.md` 的对应分区 | 否 |
| `daily-triage` | enabled / L1 | 手动；维护者可显式配置每日调度 | `STATE.md` | 否 |
| `ci-sweeper` | disabled / L2-ready | 启用后由 CI 失败事件或手动触发 | pattern state + attempt ledger | 仍须已批准 task |

安装到业务仓后不得自动启用 cron。维护者必须明确选择 cadence、owner、通知位置和预算后，才能创建周期任务。

## 每轮执行顺序

1. 生成唯一 run id，加载 `loop-constraints.md`、`loop-budget.md`、`loop.config.json` 与上轮状态。
2. 检查 kill switch、预算、最大运行次数、锁与权限；任一不满足即停止或降为 report-only。
3. 获取 pattern 声明的输入，去重并分为 High Priority、Watch、Noise、Human Inbox。
4. 无 actionable item 时低成本退出，不生成 task，不启动 maker/verifier。
5. L1 只更新状态和运行日志。
6. L2 只处理明确、低风险、可验证的单一问题；一个 item 对应一个隔离 worktree 和 attempt。
7. Maker 产出最小 patch 后，由独立 verifier 重新运行检查并给出 `APPROVE`、`REJECT` 或 `ESCALATE_HUMAN`。
8. `APPROVE` 只表示 patch 可供人审阅，不等于方案已批准、任务完成或可以 merge。
9. 写入状态、attempt、预算和 append-only run log；释放锁或记录升级上下文。

## 状态所有权

| 状态 | 回答的问题 | 唯一写入者/规则 |
|---|---|---|
| `STATE.md` | 下一轮应知道什么、什么等待人 | Loop 控制器；保留人工 override |
| pattern state | 某一 loop 正在处理什么、尝试几次 | 对应 pattern；不得与其他 pattern 混写 |
| `docs/team/STATUS.md` | 当前产品/设计/开发/QA 角色在做什么 | 仅父 Agent |
| `governance.json` | 一次 task 的批准、路径、角色与验收证据 | 仅父 Agent 改阶段/批准；角色按授权返回证据 |
| `loop-run-log.md` | 每轮实际发生了什么 | 仅追加；不得用改写 STATE 代替历史 |

Loop 每轮开始读取 prior state，每轮结束移除已关闭或已失效条目，并记录 `Last run`。人工更正具有最高优先级，后续运行不得静默覆盖。

## Human Gates

以下情况必须升级给人：

- 输入模糊，无法写出可观察的完成条件。
- 命中 denylist、权限/安全/支付/隐私/生产基础设施或迁移。
- 需要改变产品范围、交互、API、数据契约或验收标准。
- 没有当前方案的明确用户批准。
- patch 超出文件数/路径范围，或出现无关重构。
- verifier 无法运行检查、给出拒绝，或相同 item 达最大尝试次数。
- 锁冲突、预算超限、kill switch 或 connector 权限不足。

## Worktrees 与锁

- L1 不创建代码修改 worktree。
- L2 每个 item、每次 attempt 使用一个隔离 worktree；主工作树已有无关修改必须保留。
- 行动前申请路径锁；重叠路径只允许一个 owner。
- `REJECT`、`ESCALATE_HUMAN` 和完成后均记录结果并释放锁；清理不得删除未捕获 patch 或用户工作。
- Worktree 只提供 Git 工作区隔离，不等价于容器、凭据或网络隔离。

## Budget 与熔断

- 预算按 pattern 配置最大 runs/day、估算 tokens/day 和 subagents/run。
- 达到 80% 预算：自动降为 L1 report-only。
- 达到 100% 或 kill switch 激活：在任何业务写入前退出。
- 无 actionable item：不得启动 subagent。
- 同一 item 最多 3 次 attempt；相同错误连续出现或无进展时提前熔断。
- Loop 不得自行提高预算或解除 kill switch。

## Push、PR 与 Merge

- 模板不自动 push 或 merge。
- L2 可以产出 patch、验证证据或 draft proposal；是否创建 PR 由显式配置和人工批准决定。
- verifier 的 `APPROVE` 不能替代用户方案确认、QA acceptance 或 repository review。

## 运行与观察

```sh
node scripts/harness/cli.mjs loop init <id> --pattern <pattern> [--dry-run]
node scripts/harness/cli.mjs loop validate --strict
node scripts/harness/cli.mjs loop doctor --strict
node scripts/harness/cli.mjs loop run prepare <id>
node scripts/harness/cli.mjs loop run finish <run-id> --result <json-file>
node scripts/harness/cli.mjs loop status
node scripts/harness/cli.mjs loop inbox list
node scripts/harness/cli.mjs loop inbox decide <finding-id> --decision <accept|dismiss|defer> --by <human>
node scripts/harness/cli.mjs loop metrics
node scripts/harness/cli.mjs loop sync --check
```

运行日志至少记录 run id、pattern、level、时间、输入数量、actionable 数、动作、升级、检查结论、成本估算和 outcome。指标定义见 [测试与指标契约](docs/loops/testing-and-metrics.md)。

## 晋级与降级

- L0→L1：配置和约束通过验证，至少一个 report-only pattern 可手动运行。
- L1→L2：满足 [成熟度契约](docs/loops/concepts.md) 的全部门槛，并由人显式修改 pattern level。
- 任何 S2/S3 事故、预算失控、误报率恶化或 verifier 不可靠：立即降回 L1 或暂停。
- 本模板不定义 L3；出现 L3 请求必须形成新方案并重新确认。

<!-- loop-config-projection:start -->
# Loop Runtime

Machine configuration: `loop.config.json`.

## Patterns

- `harness-health`: L1 / report-only / enabled
- `daily-triage`: L1 / report-only / enabled
- `ci-sweeper`: L2 / assisted / disabled
<!-- loop-config-projection:end -->
