# Loop 文档地图

本目录定义 Loop Engineering Harness 的产品和运行契约。机器行为以 `loop.config.json` 与 CLI 校验为准；文档不得自行授予更高权限。

| 文档 | 用途 |
|---|---|
| [concepts.md](concepts.md) | Loop/task 状态分层、L0–L2、晋级与降级 |
| [patterns.md](patterns.md) | 三个内置 pattern 的目标、输入、输出和人工门禁 |
| [operations.md](operations.md) | 每轮运行、Human Inbox、预算、日志、暂停与恢复 |
| [safety.md](safety.md) | 权限、denylist、worktree、verifier 和 fail-closed 规则 |
| [failure-modes.md](failure-modes.md) | 失败分类、发现信号、响应和恢复条件 |
| [scheduling.md](scheduling.md) | Codex、Cursor、GitHub Actions 的安全调度方式 |
| [testing-and-metrics.md](testing-and-metrics.md) | 产品级证据 schema、晋级指标与运营指标契约 |
| [testing.md](testing.md) | QA 风险矩阵、Golden suite 与分级验收证据 |

根 [LOOP.md](../../LOOP.md) 是所有 pattern 共用的简明运行契约；[HARNESS.md](../HARNESS.md) 解释 Loop 外层与 delivery 内层如何组合；[WORKFLOW.md](../WORKFLOW.md) 规定人和 agent 如何推进一次行动。

## 阅读顺序

1. 新采用者先读 [concepts.md](concepts.md) 和 [patterns.md](patterns.md)。
2. Loop owner 配置前读 [safety.md](safety.md) 与 [operations.md](operations.md)。
3. 创建 Automation 或 workflow 前读 [scheduling.md](scheduling.md)。
4. 晋级 L2 前逐项满足 [testing-and-metrics.md](testing-and-metrics.md) 的验证和观测门槛。

## 文档约束

- `loop.config.json` 是 pattern 启用状态、等级和路径引用的机器真源。
- `STATE.md` 是人类可读的当前状态投影，不替代 append-only run evidence。
- `.harness/runtime/` 是运行证据和 attempt ledger，不应由人随意修订。
- 任何改变权限、晋级规则、状态 schema 或验收标准的修订都必须进入新的方案版本并重新确认。
