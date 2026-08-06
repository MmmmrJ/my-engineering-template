# Loop 测试与 Eval

本页定义 Loop Engineering 模板的最小充分质量门禁。结构 readiness 只能证明文件存在，不能替代行为测试、独立验证或真实运行证据。

## 质量结论规则

- P0 安全场景必须 `100%` 通过；任何跳过、超时、未执行或证据缺失均按失败处理。
- `exit 0` 表示成功或确定性 no-op，`exit 1` 表示配置/执行错误，`exit 2` 表示策略阻断或需要人工处理。
- L1 只能产生报告、状态投影和证据，不得修改 governed paths。
- L2 只表示能力就绪；必须显式 promote，且仍受用户确认、gate、worktree、独立 verifier 和现有 QA 门禁约束。
- L3、自动 push/merge 和生产写 connector 不属于 V1；任何相应请求都必须被拒绝。

## 风险矩阵

| 风险 | 级别 | 最小测试层 | 必须证明 |
|---|---|---|---|
| 非法或不完整配置被当作可运行 | P0 | schema + CLI 集成 | strict validate/doctor 以配置错误 exit 1 阻断，且不生成 runtime 状态 |
| STATE.md 与机器真源漂移 | P0 | sync 黑盒 | `--check` 以配置错误 exit 1 检出且不写；`--write` 只重建投影并可重复执行 |
| pause/kill switch 后仍运行 | P0 | run E2E | prepare 被阻断，无 run/evidence/业务副作用 |
| 单次或每日预算超限后仍运行 | P0 | run E2E | exit 2、记录原因、无后续 actor 调用 |
| no-op 重试生成重复运行记录 | P0 | 幂等集成 | 同 run ID 重放不重复计数、不重复 inbox、不重复证据 |
| L1、deny path 或未经批准任务发生写入 | P0 | gate + 临时 git repo | 100% 阻断，工作树和 governed paths 保持不变 |
| inbox 重放造成重复升级 | P0 | inbox 集成 | 相同稳定键仅一个 open item，resolve 可重复 |
| 无证据 resume/promote 或直接 L3 | P0 | 生命周期集成 | exit 2，状态和 level 不变 |
| 并发 attempt 修改同一路径 | P0 | worktree/lock 集成 | 第二 owner 被阻断；过期/清理行为有审计记录 |
| maker 自证或 verifier 失败后放行 | P0 | finish + gate E2E | session 必须不同，verifier=pass 才能进入 proposal/write gate |
| 日志损坏被静默忽略 | P0 | parser + metrics | 报出精确坏行并 exit 2，不得产出误导指标 |
| 日志或 JSON 输出泄密 | P0 | redaction eval | token、authorization、secret/key 字段不出现在 stdout/stderr/evidence |
| 指标按活动量制造虚假成功 | P1 | metrics golden | 分离 no-op、report、proposal、verified success、failed、escalated，并保持守恒 |
| 安装/升级覆盖业务仓 Loop 配置 | P0 | distribution 集成 | merge 保留目标配置；冲突 fail-closed 且原文件字节不变 |
| 平台差异导致门禁绕过 | P1 | CI 矩阵 | Windows/macOS/Linux、Node 20/24 使用同一测试入口和检查 ID |

## Golden suite

机器可读清单位于 `evals/golden/loop-safety-v1.json`，固定输入位于 `evals/golden/fixtures/`。测试运行器必须逐个执行清单中的场景，并校验：

1. 命令退出码和 JSON `ok`/策略字段；
2. 运行前后的文件快照，证明没有未授权副作用；
3. run、ledger、inbox、lock 与 metrics 的计数守恒；
4. stdout、stderr 和持久证据均经过敏感字段检查；
5. 所有 P0 case 被执行且通过，不能用过滤、重试或降级阈值获得绿色结果。

## 测试入口与证据

统一回归入口：

```text
node scripts/harness/run-tests.mjs
```

Loop 黑盒测试使用临时 git 仓、固定时钟语义、显式 run ID 和本地假数据，不访问真实 connector。CI 证据至少记录 Node/OS、命令、exit code、测试数量、失败 case ID 和 commit SHA。原始输出应作为 CI artifact 保存，治理记录只引用摘要和 artifact 标识。

## 分级验收

- L0：schema、doctor、sync 和全部 P0 golden eval 通过。
- L1：在 L0 基础上，连续 10 次计划 dry-run 证据完整率 100%，无 governed path 修改、无重复 run/inbox、无未解释状态漂移。
- L2-ready：在 L1 基础上，worktree/lock、maker-verifier 独立、gate 与失败恢复场景全部通过；默认仍 disabled。
- L2 promoted：至少 10 个合格 L1 runs、覆盖至少 5 个不同日期、evidence 完整率 100%、未授权动作 0、false-positive rate ≤20%、kill-switch drill 通过，并由具名人提供证据后，才可针对单个 pattern 提升；任一 P0 回归立即 pause 并降级为 report-only。

批准的兼容命令 `loop inbox decide`、`loop gate check` 与 `loop run finish --result` 必须与各自主接口共享同一策略、证据和退出码，不能形成较弱的旁路。

## 缺陷分级

- P0：越权写、泄密、预算/kill/gate 绕过、maker 自证、证据伪绿、安装覆盖目标配置。
- P1：主路径不可用、状态或指标错误、跨平台失败、无法恢复但无越权副作用。
- P2：不影响判定的诊断、文案或非关键可观测性问题；必须具名接受后才能保留。
