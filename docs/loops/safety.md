# Loop 安全与权限

## 安全原则

Loop 会放大判断，因此安全规则必须由机械 gate、最小权限、隔离、预算和独立验证共同落实。Prompt 中的提醒不能替代这些控制。

## 默认权限

| 能力 | L1 | L2 |
|---|---|---|
| 读取仓库、状态和检查结果 | 允许 | 允许 |
| 更新 `STATE.md` 与 run evidence | 允许 | 允许 |
| 修改 governed paths | 禁止 | 仅已批准 task、允许路径和有效锁内 |
| 创建隔离 patch | 禁止 | 允许 |
| Connector 写入 | 默认禁止 | proposal/comment-only，需显式配置 |
| Push / merge | 禁止 | 禁止 |
| 提高预算 / resume | 禁止 | 禁止 |

## Denylist 与动作门禁

`gate.yaml` 是动作级机器策略。至少应拒绝：

- `.env`、`.env.*`、secrets、credentials、keys。
- auth、authorization、payments、billing、PII。
- 生产 Terraform/Kubernetes/部署和基础设施配置。
- migrations，除非存在专门已批准方案。
- 超过最大文件数、跨出 task allowedPaths 或包含无关重构的 patch。

路径匹配同时检查 staged、tracked 和 untracked 变更，不得只相信 Maker 的摘要。Denylist 命中时只能升级给人。

## 批准链

以下结论互不替代：

- `verifier APPROVE`：证据足够将 patch 交人评审。
- `task approval`：用户确认了当前方案版本和交付范围。
- `qa-acceptance pass`：实现满足已确认方案和必跑检查。
- repository review：具名人决定是否 push/merge。

Loop 不得从沉默、旧版本确认、历史成功或 allowlist 推断 task approval。

## 独立 Verifier

- Maker 与 verifier 必须是不同角色/上下文；实现者不能写自己的最终 verdict。
- Verifier 默认拒绝，直到亲自运行必需检查并确认 scope。
- Verdict 必须关联命令、退出码/结果、changed paths、run id 和 task id。
- 无法运行检查时必须 `ESCALATE_HUMAN`，不能用“看起来正确”代替。
- 禁止通过跳过测试、删除断言、忽略错误或盲目加 retry/timeout 获得通过。

## Worktree 与进程边界

Worktree 用于避免 Git 工作树冲突；每个 item/attempt 独立。它不限制进程访问仓库外文件、网络、凭据或外部系统，因此仍需平台 sandbox、connector scope 和 secret guard。

## Connector 最小权限

| Connector | 默认读权限 | 默认写权限 |
|---|---|---|
| GitHub | PR、issue、checks | 无；L2 可显式允许 draft comment/proposal |
| Linear/Jira | 指定团队 issue | 无；可显式允许 comment/status proposal |
| Slack/Teams | 指定频道历史 | 仅 Human Inbox 通知频道，且需显式配置 |
| 数据库 | 非生产只读且需明确用途 | 禁止生产写 |

Connector 不可用时，pattern 应降级为本地证据或 Human Inbox，不得扩大权限来“完成任务”。日志和状态不得写入 secret、完整敏感日志或个人数据。

## Fail-closed 条件

任一命中即停止代码行动：

- Kill switch、预算 100%、pattern disabled 或 level 不足。
- 缺少约束、gate、有效批准 task、owner 或必要检查。
- 锁冲突、stale/incomplete run 无法安全恢复。
- Denylist、文件数上限、跨路径或 unknown changes。
- Attempt 上限、重复错误、无进展。
- Verifier reject/escalate，或证据不完整。

## 事故响应

1. 立即 pause 全部 mutating patterns。
2. 保存 run、ledger、patch、logs 和关联 task，不先清理证据。
3. 由人处理 revert/恢复；Loop 不得自行掩盖事故。
4. 记录严重度、影响、根因和缺失 guardrail。
5. 将修复落实为 gate、检查、schema 或 skill，而不是只加提示。
6. QA 重放失败 fixture 后，具名人才能 resume；必要时长期降回 L1。

