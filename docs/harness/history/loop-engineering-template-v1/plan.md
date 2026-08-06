# Exec Plan: Loop Engineering 模板工程改造

- 状态：`awaiting_approval`
- 方案版本：`V1`
- 设计交付：`not-applicable`（本需求不涉及页面、交互或视觉设计）

## 目标

保留现有 approval-gated delivery harness 作为行动内环，新增可持续触发、持久状态、预算熔断、隔离执行、独立验证和运行复盘的外层 Loop。首版达到 L2 能力就绪、L1 默认运行。

## 范围

- 恢复 generated agents、strict doctor 与 CI 的绿色基线。
- 新增独立 `loop.config.json`、标准 Loop 文件、pattern registry 和结构化状态/证据契约。
- 扩展现有 Node CLI，交付 L1 init/validate/doctor/status/sync/run/inbox/metrics。
- 交付 L2 gate、attempt ledger、worktree/lock、独立 verifier 和 governance V2 关联。
- 补齐共享 skills、跨平台调度文档、GitHub Actions dogfood、测试与 golden evals。

## 非目标

- 不实现 L3、自动 push/merge、policy-preapproved patch 或生产写 connector。
- 不复制参考项目的全部 npm 工具、网站、示例和 starter。
- 不改变业务技术栈，不削弱现有用户确认、QA、secret guard 和视觉验收门禁。

## 验收标准

- 现有回归测试无退化，新增 Loop 单元、CLI 集成和安全 eval 全部通过。
- `doctor --template --strict`、`sync-agents --check`、`guard-secrets --tracked`、`verify --profile ci` 和 `loop doctor --strict` 全部通过。
- L1 不得修改 governed paths；kill switch、预算、deny path、无批准任务、锁冲突和 verifier 失败均 fail-closed。
- 安装/升级保留目标仓已有 Loop 配置；Node 20/24 与 Windows/macOS/Linux CI 保持兼容。
- 模板自身具备只读 `harness-health` dogfood，安装到业务仓时只提供手动 workflow，不自动开启 cron。

## 实施顺序

1. 恢复绿色基线并冻结术语、状态所有权和 schema。
2. 实现 L1 控制器、状态、日志、预算、同步、readiness 与调度适配。
3. 实现 L2 gate、worktree、锁、maker/verifier 证据和 governance V2。
4. 完成测试/evals/CI、dogfood 验证和任务归档。
