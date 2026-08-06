# Loop 失败模式

## 严重度

| 级别 | 含义 | 默认响应 |
|---|---|---|
| S1 | 浪费时间/预算，无用户伤害 | 记录、调优、必要时降频 |
| S2 | 错误 patch、越界动作、告警疲劳或治理失效 | Pause mutating patterns，人工复盘 |
| S3 | 安全、数据损失、生产事故或凭据暴露 | 全局 pause，按事故流程处理 |

## Infinite Fix Loop

- 信号：同一 item 多次出现相同错误或 verifier 连续拒绝。
- 常见原因：错误分类、flake、同一上下文自证、未持久化 attempts。
- 控制：ledger、相同错误 fingerprint、最多 3 次、无进展提前熔断。
- 恢复：进入 Human Inbox；人明确根因或更新方案后才创建新 attempt。

## State Rot

- 信号：STATE 引用已关闭 task/PR，或 active run/lock 没有实际 owner。
- 常见原因：未在每轮校验对象、多个 writer、finish 中断。
- 控制：稳定 id、Last seen、prune、sync、stale run 检测。
- 恢复：保留历史证据，修正当前投影，不伪造过去运行记录。

## Verifier Theater

- 信号：verdict 为通过但没有命令证据，或 CI 随后失败。
- 常见原因：Maker 自验、模糊检查、无法运行时仍批准。
- 控制：角色分离、必需 check id、退出码、scope diff、默认拒绝。
- 恢复：暂停 L2，补 verifier fixture 并重放后再晋级。

## Token/Run Burn

- 信号：空 watchlist 仍启动 subagent，高频 run 没有 actionable 输出。
- 控制：no-op 早退、runs/day、tokens/day、spawns/run、80% 降级、100% 停止。
- 恢复：降频或事件驱动；连续两周成本高于价值则停用 pattern。

## Notification Fatigue

- 信号：团队忽略或静音 Loop 通知。
- 控制：仅 Human Inbox 通知，普通结果进 digest；稳定 id 去重。
- 恢复：收紧 High Priority，跟踪 actionable rate 和 muted/ignored 反馈。

## Scope Overreach

- 信号：改动无关模块、denylist、过多文件或改变产品契约。
- 控制：task allowedPaths、gate、maxFiles、一个 item 一个最小 patch、verifier scope check。
- 恢复：拒绝 patch、保存证据、升级给人；不得拆小 commit 绕过限制。

## Parallel Collision

- 信号：两个 run 操作同一路径、state 被覆盖、worktree/branch 冲突。
- 控制：路径锁、owner/TTL、一个 mutating loop、分 pattern state。
- 恢复：停止后启动者，保留双方证据，由人选择 owner；不得自动合并冲突修复。

## Approval Confusion

- 信号：verifier APPROVE 被当成 task approval 或 merge authorization。
- 控制：批准类型分离、governance version 校验、push/merge 永久人工门禁。
- 恢复：立即暂停并审计所有受影响 run/task。

## Scheduler Duplication

- 信号：Codex、Cursor 与 GitHub 同时按相同 cadence 运行同一 pattern。
- 控制：每个 pattern 一个 scheduler owner，run prepare 获取唯一 lease。
- 恢复：保留一个 owner，停用重复调度，合并 Human Inbox 而不重放动作。

## Evidence Loss

- 信号：run log 有摘要但无结构化 evidence，或 cleanup 删除未审 patch。
- 控制：finish 前持久化、清理前验证 evidence、append-only 历史。
- 恢复：标记 evidence-incomplete 并升级；不得补写不存在的测试结果。

