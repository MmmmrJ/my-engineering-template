# Loop Engineering Harness Template

面向 **Codex** 与 **Cursor** 的跨平台 Loop Engineering 模板：外层 Loop 持续发现、分诊、记忆和复盘工程工作，内层 delivery harness 继续用「方案确认、路径所有权、独立验证和验收证据」安全完成每一次行动。

本模板默认运行在 **L1 report-only**，具备升级到 **L2 assisted** 所需的治理契约；不提供 L3、自动 push 或自动 merge。

## 它解决什么

普通 agent 会话依赖人不断给出下一条 prompt。本模板把这个过程变成可重复运行的控制系统：

```text
触发 → 约束/预算预检 → 分诊 → 持久状态 → 隔离行动
     → 独立验证 → 机械门禁 → 记录结果 → 下一轮或升级给人
```

现有 harness 并未被替换：当 Loop 找到值得行动的工作时，仍必须进入唯一 active task，经用户明确确认当前方案后，才能修改受治理路径。

## 前置条件

- Node.js `>=20.19 <25`
- Git

不依赖 Bash、WSL 或 Git Bash。Windows、macOS 与 Linux 均通过 Node CLI 运行。

## 5 分钟启用

```sh
git clone <this-repo> my-app
cd my-app
node scripts/harness/cli.mjs init --project
# 填写 harness.config.json 的 governedPaths 与 full/ci 检查
node scripts/harness/cli.mjs loop init daily-main --pattern daily-triage
node scripts/harness/cli.mjs loop sync --write
node scripts/harness/cli.mjs doctor --project --strict
node scripts/harness/cli.mjs loop validate --strict
node scripts/harness/cli.mjs loop doctor
node scripts/harness/cli.mjs loop run prepare daily-main
# 执行只读分诊后，以结构化真实结果结束本轮
node scripts/harness/cli.mjs loop run finish <run-id> --result path/to/run-result.json
node scripts/harness/cli.mjs loop doctor --strict
node scripts/harness/cli.mjs loop status
```

`init --project` 初始化 delivery harness、团队状态、Git hooks 和 lock；`loop init <id> --pattern <pattern> [--dry-run]` 从内置 pattern 添加实例。L1 实例默认 enabled/manual，L2 实例默认 disabled；enabled 不等于启用 schedule，安装不会创建 cron。初始化不会猜测业务检查命令。

## 两层闭环

| 层 | 责任 | 主要产物 |
|---|---|---|
| 外层 Loop | 周期触发、发现、分诊、预算、熔断、状态与运行日志 | `LOOP.md`、`loop.config.json`、`STATE.md`、`loop-run-log.md` |
| 行动内环 | 方案、明确批准、角色实施、独立 QA、完成证据 | `docs/plans/active/<task-id>/`、`governance.json`、`docs/team/STATUS.md` |

状态不得混用：`STATE.md` 是跨轮工作记忆与 Human Inbox；`docs/team/STATUS.md` 是当前角色活动；task governance 是一次交付的范围、批准和验收记录。

## 成熟度

| 等级 | 行为 | 默认权限 |
|---|---|---|
| L0 Draft | 只有 Loop 目的和配置，尚无可信运行 | 不执行 |
| L1 Report | 发现、分诊、更新状态和日志 | 不修改 governed paths |
| L2 Assisted | 隔离生成最小 patch，由独立 verifier 复核 | 仅提案；仍需用户批准和人工合并 |

新安装固定从 L1 开始。升级 L2 需要真实 L1 运行记录、可接受的分诊质量、预算与 kill switch、worktree、attempt ledger、独立 verifier 和全部安全 gate。详见 [成熟度与状态契约](docs/loops/concepts.md)。

## 内置 Pattern

模板提供三个纵向场景，均可独立启用：

- `harness-health`：检查 harness、agent 同步、密钥护栏和项目检查，模板自身用它做 L1 dogfood。
- `daily-triage`：汇总工程信号，维护 High Priority、Watch List 与 Human Inbox；L1 默认可手动运行，但不自动设置 cadence。
- `ci-sweeper`：分诊失败检查；具备 L2 契约但默认禁用，显式晋级后才可在隔离 worktree 产出 patch 提案。

Pattern 的目标、输入、输出、人工门禁和退出规则见 [Pattern 规格](docs/loops/patterns.md)。

## 安全默认值

- L1 禁止修改 `governedPaths`。
- `.env`、凭据、认证、支付、生产基础设施等路径默认拒绝自动行动。
- 没有当前方案批准、锁冲突、预算超限、kill switch、verifier 拒绝或最大尝试次数命中时 fail-closed。
- Connector 默认只读或 proposal-only；模板不自动扩大 GitHub、Slack、Linear 或数据库权限。
- Worktree 是 Git 隔离，不是 OS 或网络沙箱。

完整规则见 [安全与权限](docs/loops/safety.md)。

## 调度

仓库定义可重复运行的命令和证据契约，真正的调度器由运行环境负责：

- Codex Automation：推荐本地 checkout 或后台 worktree。
- Cursor：使用其可用的后台 agent/automation；能力缺失时保留手动命令。
- GitHub Actions：模板只提供 `workflow_dispatch` 手动入口；业务仓显式选择后才添加 cron。

安装模板绝不会静默开启定时任务。详见 [调度指南](docs/loops/scheduling.md)。

## 项目配置与业务目录

`harness.config.json` 继续描述技术栈无关的治理路径、检查和依赖边界；`loop.config.json` 描述 Loop pattern、级别、状态、预算和运行策略。两者各有唯一职责，CLI 会检查漂移和无效引用。

| 路径 | 说明 |
|---|---|
| `apps/frontend/` | 前端（空，自行搭建） |
| `apps/backend/` | 后端（空，自行搭建） |
| `packages/contracts/` | 共享契约（空，可选） |

项目模式必须配置 `full` 与 `ci`，否则本地门禁和 CI 失败。旧的 `scripts/project-checks.env` 不会被执行。

## 接到已有业务仓

```sh
node scripts/harness/cli.mjs install --dry-run --merge /path/to/your-app
node scripts/harness/cli.mjs install --merge /path/to/your-app
# 在目标仓执行
node scripts/harness/cli.mjs init --project
node scripts/harness/cli.mjs loop init daily-main --pattern daily-triage
node scripts/harness/cli.mjs loop sync --write
node scripts/harness/cli.mjs doctor --project --strict
node scripts/harness/cli.mjs loop doctor
```

- 默认 `--merge` 只安装缺失治理文件；受管区块采用合并策略。
- `upgrade --dry-run` 报告安全更新与冲突，保留目标仓已有 Loop 配置和运行状态。
- 不复制 `apps/` 与 `packages/`。
- 棕地仓库先使用 `$onboard-repository`，确认提案后再安装。

## 最小验收清单

- [ ] `node scripts/harness/cli.mjs doctor --project --strict` 通过
- [ ] `node scripts/harness/cli.mjs loop doctor --strict` 通过
- [ ] `node scripts/harness/cli.mjs sync-agents --check` 通过
- [ ] `node scripts/harness/cli.mjs guard-secrets --tracked` 通过
- [ ] `node scripts/harness/cli.mjs verify --profile ci` 通过且未假通过
- [ ] 一次 L1 run 只更新允许的状态/日志，无 governed path 修改
- [ ] kill switch、预算、deny path、锁冲突和 verifier 拒绝均 fail-closed

## 文档入口

- [Loop 运行契约](LOOP.md)
- [Loop 文档地图](docs/loops/README.md)
- [Harness 原则](docs/HARNESS.md)
- [交付与 Loop 工作流](docs/WORKFLOW.md)
- [架构边界](docs/ARCHITECTURE.md)
