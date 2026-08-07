# Codex、Cursor 与 GitHub 调度

## 通用调度契约

无论平台如何触发，每个 scheduler 都必须：

1. 指定唯一 pattern 和 scheduler owner。
2. L1 调用 `loop run execute <id>`，不得拆开生命周期或传入自报结果。
3. L2 才由父控制器调用 `prepare`，并顺序执行 maker gate、scope gate、独立 `run verify`、proposal gate 与 finish。
4. 成功、no-op、拒绝、升级或基础设施失败都必须形成终态证据，或保留可由 `run recover` 诊断的 incomplete run。
5. 不在 scheduler prompt 中放置 secret。
6. 安装模板后默认手动；cron 必须由仓库维护者显式启用。

同一 pattern 不应同时由多个平台周期触发。需要容灾时也必须共享 lease/lock，而不是各跑一份。

## Codex Automation

推荐设置：

- Environment：本地 checkout；L2 使用后台 worktree。
- 首次运行：手动 fire immediately，确认输出后再设置周期。
- Prompt：只描述调用 `loop run execute <pattern>`，不复制整份规则或要求模型自报 outcome。
- L1 示例语义：执行 `daily-triage`，由 runner 读取 prior state 和真实 adapter，report-only 或 no-op 后自动持久化证据。

Codex Automation 的 UI 配置不在仓库中，owner 应把 cadence、时区、环境和最后验证时间记录到 `loop.config.json` 对应 metadata 或运行手册。若平台不支持稳定后台调度，保留手动入口，不宣称 durable。

## Cursor

Cursor 能力随版本/环境不同。可用后台 agent 或 automation 时，仍调用同一 Node CLI；不可用时使用人工命令或 GitHub Actions，不另造不兼容状态格式。

- `.cursor/hooks.json` 继续负责 session/命令/stop 护栏，不等同于 scheduler。
- 不把 Codex 专属 skill URI 或本机绝对路径写入 Cursor 任务。
- L2 必须确认 Cursor 运行环境实际位于受管 worktree，并能执行项目检查。

## GitHub Actions

业务仓首版推荐 `workflow_dispatch`，不要在安装时自动启用 `schedule`：

```yaml
on:
  workflow_dispatch:
    inputs:
      pattern:
        required: true
        type: choice
        options: [harness-health, daily-triage]
```

Workflow 最小权限为 `contents: read`。如果未来需要提交状态更新或 draft comment，必须在已确认方案中逐项扩大权限，并对 fork PR、untrusted input 和 secret exposure 做独立评审。

模板仓可使用 `harness-health` 做 dogfood，但必须：

- L1 report-only。
- 不自动改 main、不自动修复失败。
- 失败形成 artifact、summary 或 Human Inbox，而不是无限 retry。
- 安装器不把模板仓的 cron 自动带入业务仓。

## Cadence 建议

| Pattern | 初始 cadence | 早退 | Off-hours |
|---|---|---|---|
| `harness-health` | 每日或 push 后 | 无变化立即 no-op | 可暂停 |
| `daily-triage` | 每工作日一次 | 无 actionable item 不启动 subagent | 生成次日 digest |
| `ci-sweeper` | 事件驱动优先 | 非 deterministic regression 立即升级 | 默认不运行 |

高频轮询不是成熟度。优先事件触发；若必须轮询，应设置 daily run cap、去重、backoff 和 empty-state 早退。

## 调度验收

- 首次手动 run 可完成 prepare/finish 且状态可见。
- 重复触发同一 item 不生成重复 Human Inbox。
- 两个 scheduler 同时触发时，只有一个获得行动 lease。
- Pause 后所有平台在外部写入前退出。
- Scheduler 失败留下 incomplete evidence，可由 doctor 发现。
- 时区、owner、cadence 和通知目的地有明确记录。
