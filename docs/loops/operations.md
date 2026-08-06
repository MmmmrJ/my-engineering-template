# Loop 操作手册

## 首次启用

```sh
node scripts/harness/cli.mjs loop init daily-main --pattern daily-triage
node scripts/harness/cli.mjs loop sync --write
node scripts/harness/cli.mjs loop validate --strict
node scripts/harness/cli.mjs loop doctor
node scripts/harness/cli.mjs loop status
```

`loop init <id> --pattern <pattern> [--dry-run]` 添加实例：id 表示本仓库中的 Loop 实例，pattern 表示复用定义。L1 实例默认为 enabled/manual，L2 实例默认为 disabled；任何实例都不会因 init 自动获得 schedule。Promote 只改变成熟度，不等于创建调度。Init 必须幂等并保留已有配置、状态、预算、约束和日志。

首次真实 L1 run 完成前，`loop doctor` 会报告 observed L0；此时不要使用 strict 假装通过。完成并持久化至少一次 evidence-complete L1 run 后，再以 `loop doctor --strict` 验证 observed L1。

## 一轮运行

运行分成 prepare 与 finish，确保外部 agent 或调度器失败时仍可识别未完成 run。

```sh
node scripts/harness/cli.mjs loop run prepare <id>
# 根据 prepare 输出执行该 pattern 允许的只读或 L2 工作
node scripts/harness/cli.mjs loop run finish <run-id> --result <json-file>
```

主接口的 result JSON 至少给出真实 `outcome`，并按实际情况提供指标和独立验证证据：

```json
{
  "outcome": "report-only",
  "tokens": 12000,
  "findings": 2,
  "actions": 0,
  "escalations": 1,
  "evidenceComplete": true,
  "unauthorizedWrites": 0,
  "falsePositives": 0,
  "killSwitchDrill": false,
  "checks": [
    { "id": "triage-contract", "status": "pass", "evidence": "2 findings classified; governed paths unchanged" }
  ],
  "evidence": [
    { "id": "triage-report-1", "type": "report", "subject": "STATE.md" }
  ]
}
```

`evidenceComplete: true` 要求至少一个带 evidence 的 passing check 和一个结构化 evidence。L2 有 action 或 `proposal`/`success` 时还必须提供互不相同的 `makerSession`、`verifierSession`、`verifierStatus: "pass"`，以及关联 `taskId`/`approvedVersion`。旧的 `--outcome`/metric flags 只作兼容入口，新集成使用 `--result`。

Prepare 必须：

- 验证 pattern 存在、enabled 和 level。
- 加载 constraints、budget、kill switch、prior state、locks 和 ledger。
- 在任何业务写入前拒绝预算超限、权限不足和冲突。
- 创建 `.harness/runtime/runs/<run-id>.json` 初始证据。
- 返回允许行为、必须检查、状态路径和完成所需字段。

Finish 必须：

- 校验 outcome 与实际证据一致。
- 更新 `STATE.md` 人读投影并追加 `loop-run-log.md`。
- 持久化动作、verdict、检查、成本与升级。
- 标记 run 为终态并安全释放应释放的锁。
- 失败或进程中断时保留可诊断的 incomplete/stale run。

## Outcome

至少支持以下语义：

| Outcome | 含义 |
|---|---|
| `no-op` | 已检查，无 actionable item |
| `report-only` | 更新了状态，没有代码行动 |
| `proposal` | L2 patch 与 verifier 证据已就绪，等待人 |
| `success` | 声明的运行目标和必需证据均完成 |
| `escalated` | 需要人澄清、批准、权限或风险判断 |
| `failed` | 运行基础设施或契约失败，未完成目标 |

CLI outcome 固定为 `no-op|report-only|proposal|success|failed|escalated`。Pause 是 Loop 实例状态，不伪装成已完成 run outcome；verifier/gate 拒绝使用 `failed` 或 `escalated`，并保存明确原因。

## Human Inbox

```sh
node scripts/harness/cli.mjs loop inbox list
```

每项应包含稳定 item id、来源、首次/最后出现时间、pattern、为何需要人、建议决定和恢复命令。相同根因不得每轮生成新 item。Resolved 项在下一轮从 active inbox 移除，但历史保留在 run evidence。

`loop inbox add` 用于写入稳定 finding；`loop inbox decide <finding-id> --decision accept|dismiss|defer --by <human>` 是人工决策主接口；`resolve` 用于附带 evidence 的兼容/关闭路径。重复 add/decide/resolve 应幂等。

## 暂停与恢复

```sh
node scripts/harness/cli.mjs loop pause <id> --reason "<reason>" --actor "<actor>"
node scripts/harness/cli.mjs loop resume <id> --by "<actor>" --evidence "<evidence>"
```

Pause 必须先于所有 agent、connector 和业务写入检查。Resume 需要具名操作者；若因 S2/S3、预算或越权暂停，恢复前还需防复发证据。Loop 不得自行 resume。

建议暂停条件：生产事故、大型迁移、关键 reviewer 不可用、预算失控、误报激增、相同错误重试或 verifier 不可靠。

## 晋级

```sh
node scripts/harness/cli.mjs loop promote <id> --to L2 --by "<actor>" --evidence "<evidence>"
```

Promote 必须机械检查：至少 5 天内 10 次有效 L1 run、100% evidence、零未授权写、false positives ≤20%、kill-switch drill、预算/约束/gate、worktree/lock、独立 verifier 和 `merge=never`，并记录具名操作者与证据。`ci-sweeper` 默认 disabled；promote/enable 不能由普通 run 自行触发。本模板不接受 `L3`。

`ci-sweeper` 的安全启用顺序是：`promote --to L1` → 人工审查后启用 manual trigger → 完成 L1 证据窗口 → `promote --to L2`。不得直接把 L2-ready 当作 observed L2。

## Worktree 与锁

```sh
node scripts/harness/cli.mjs loop worktree create --run-id <run-id> --pattern <pattern> --base HEAD
node scripts/harness/cli.mjs loop worktree mark --run-id <run-id> --status <status>
node scripts/harness/cli.mjs loop worktree list
node scripts/harness/cli.mjs loop worktree cleanup
node scripts/harness/cli.mjs loop worktree lock --owner <owner> --paths <path-a,path-b>
node scripts/harness/cli.mjs loop worktree locks
node scripts/harness/cli.mjs loop worktree unlock --owner <owner>
```

清理前必须验证目标位于受管 runtime/worktree 范围，且 patch 和 evidence 已持久化。不得清理未知 owner、用户工作树或仍在运行的 attempt。

## Gate

```sh
node scripts/harness/cli.mjs loop gate check <id> --action report --run-id <run-id>
node scripts/harness/cli.mjs loop gate check <id> --action proposal --paths <path-a,path-b> --task <task-id> --run-id <run-id> --maker-session <maker> --verifier-session <verifier> --verifier-status pass
```

Action 固定为 `report|proposal|write|push|merge`。V1 的 `push` 与 `merge` 必须被拒绝；`write` 仅在已批准 task、L2、允许路径、有效锁和独立 verifier 证据全部成立时通过。也可使用 `--paths-from git` 检查实际工作树，不得只相信声明路径。

## 日常观察

```sh
node scripts/harness/cli.mjs loop status
node scripts/harness/cli.mjs loop metrics
node scripts/harness/cli.mjs loop sync --check
node scripts/harness/cli.mjs loop doctor --strict
```

- `status`：当前 level、enabled patterns、last run、Human Inbox、预算和 pause 状态。
- `metrics`：按时间窗聚合运行质量、成本和安全指标。
- `sync`：检查机器配置、人读状态、pattern registry 和运行证据漂移。
- `doctor`：给出阻断项和最多三个优先修复建议；strict 用于 CI/晋级门禁。

## 停用 Pattern

1. Disable 调度和 pattern，确认没有 active run 或 lock。
2. 将未完成 item 送入 Human Inbox。
3. 保存最后一次状态、预算和运行指标。
4. 清理已捕获证据的临时 worktree。
5. 记录停用原因；若成本连续高于价值或产生 S2/S3，补充复盘。
