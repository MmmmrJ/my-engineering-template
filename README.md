# Harness Engineering Template

面向 **Codex** 与 **Cursor** 的跨平台自治理工程 harness：一个父 Agent 统筹多个专职 subagent，以结构化任务、确认门禁、路径所有权、分档检查和验收证据完成高质量交付。它不预设也不判断业务技术栈。

## 前置条件

- Node.js `>=20.19 <25`
- Git

不依赖 Bash、WSL 或 Git Bash。Windows、macOS 与 Linux 均通过 Node CLI 运行 harness。

## 5 分钟启用

```sh
git clone <this-repo> my-app
cd my-app
node scripts/harness/cli.mjs init --project
# 在 harness.config.json 中填写 governedPaths 与 full/ci 检查
node scripts/harness/cli.mjs doctor --project --strict
node scripts/harness/cli.mjs verify --profile full
```

`init --project` 会初始化项目模式、干净团队状态与 `harness.lock.json`，并设置当前仓库的 Git hooks 路径；它不会猜测业务检查命令。Cursor 信任工作区后 `.cursor/hooks.json` 生效；Codex 若提示，仍须手动执行一次 `/hooks` trust。

## 项目配置

配置 schema V2 使用 `mode`、`governedPaths` 与 `checks.fast/full/ci`。每条检查使用安全的 `program`、`args`、`cwd`、`timeoutMs`；模板不关心这些命令背后的技术栈。`project` 模式必须配置 `full` 与 `ci`，否则本地门禁和 CI 都会失败。旧 schema 使用 `config migrate --dry-run` 预览，再显式迁移。

旧的 `scripts/project-checks.env` 已弃用且不会被执行；CLI 会给出迁移提示，避免通过 shell 字符串执行命令。

## 业务目录（空）

| 路径 | 说明 |
|---|---|
| `apps/frontend/` | 前端（空，自行搭建） |
| `apps/backend/` | 后端（空，自行搭建） |
| `packages/contracts/` | 共享契约（空，可选） |

业务技术栈就绪后，更新 `harness.config.json` 与 `docs/ARCHITECTURE.md`。

## 接到已有业务仓（仅 harness）

```sh
node scripts/harness/cli.mjs install --merge /path/to/your-app
node scripts/harness/cli.mjs install --dry-run --merge /path/to/your-app
node scripts/harness/cli.mjs upgrade --dry-run /path/to/your-app
# 然后进入目标仓执行：node scripts/harness/cli.mjs init --project
```

- 默认 `--merge`：按 manifest 安装缺失治理文件；`AGENTS.md` 与 `.gitignore` 只合并受管区块。
- `upgrade --dry-run` 按 `harness.lock.json` 报告安全更新与冲突；`--apply` 只替换用户未修改的文件。
- 不复制 `apps/` 与 `packages/`。
- 棕地映射先使用 `$onboard-repository`；确认提案后再安装。

## 目录说明

| 路径 | 作用 |
|---|---|
| `AGENTS.md` | Agent 薄入口与团队路由 |
| `.agents/skills/` | 跨平台共享 skills |
| `.codex/` / `.cursor/` | 平台 agents 与 hooks |
| `docs/` | 知识真源、规格与计划 |
| `scripts/harness/` | 跨平台 CLI、护栏、安装与诊断 |
| `.githooks/` | 调用 Node CLI 的 Git 门禁 |
| `.github/workflows/` | Harness CI |

## 规格驱动工作流

`task create → plan → explicit approval → implement → accept → task complete`

父 Agent 用 `task create <task-id>` 建立唯一 active task，`governance.json` 记录方案版本、确认、角色、允许路径、能力与验收证据。只有明确用户确认后才能运行 `task approve`。阶段与完成门禁由 `task validate` / `task complete` 机械校验。

新增或改变页面、用户流程、交互、响应式布局或视觉设计时，必须额外保存 `docs/design/<feature>/design.md`、`prototypes/` 下的本地原型图和 `assets/manifest.md` 中的冻结本地资产。用户点名的 skill 或插件只提供可追溯候选输入，不能绕过确认、资产冻结或验收。前端实现前及 QA 验收前运行 `node scripts/harness/cli.mjs validate-design docs/design/<feature>`。

最终 UI 验收还必须保存 `verification/` 下的实现截图和 `verification.md`。该报告把每个原型场景映射到固定视口、测试数据、资产版本和实现截图；P0/P1 偏差必须修复，P2 需具名 UI 确认。运行 `node scripts/harness/cli.mjs validate-visual docs/design/<feature>` 作为通过门禁。

## 最小验收清单

- [ ] `node scripts/harness/cli.mjs doctor --project --strict` 通过
- [ ] `node scripts/harness/cli.mjs sync-agents --check` 通过
- [ ] `node scripts/harness/cli.mjs guard-secrets --tracked` 通过
- [ ] `node scripts/harness/cli.mjs guard "git push --force"` 被拦截
- [ ] `node scripts/harness/cli.mjs verify --profile ci` 通过且未假通过
- [ ] GitHub Actions 的 Harness workflow 通过

## 原则与流程

见 [docs/HARNESS.md](docs/HARNESS.md)、[docs/WORKFLOW.md](docs/WORKFLOW.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
