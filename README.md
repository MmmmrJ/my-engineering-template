# Harness Engineering Template

面向 **Codex** 与 **Cursor** 的跨平台工程 harness 模板：五角色确认门禁、仓库知识真源与可验证的机械护栏。它不预设业务技术栈，`apps/` 与 `packages/` 保持为空。

## 前置条件

- Node.js `>=20.19 <25`
- Git

不依赖 Bash、WSL 或 Git Bash。Windows、macOS 与 Linux 均通过 Node CLI 运行 harness。

## 5 分钟启用

```sh
git clone <this-repo> my-app
cd my-app
node scripts/harness/cli.mjs init
node scripts/harness/cli.mjs doctor --strict
node scripts/harness/cli.mjs verify
```

`init` 会创建 `harness.config.json`（若缺失）并设置当前仓库的 Git hooks 路径。Cursor 信任工作区后 `.cursor/hooks.json` 生效；Codex 若提示，仍须手动执行一次 `/hooks` trust。

## 项目配置

把 `harness.config.example.json` 复制为 `harness.config.json`，再以安全的 `program` 与 `args` 数组填写项目检查命令。`projectChecksRequired: false` 适用于空模板；业务落地后设为 `true`，以确保 CI 不会跳过质量检查。

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
```

- 默认 `--merge`：不覆盖已有文件；`AGENTS.md` 仅合并 `team-orchestrator` 标记区块。
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

`spec → plan → tasks → implement → verify`

新功能从 [feature-spec 模板](docs/product/templates/feature-spec.md) 开始；确认后的执行计划存入 `docs/plans/active/`，完成后归档。运行 `node scripts/harness/cli.mjs validate-spec <file>` 可校验最低规格结构。

新增或改变页面、用户流程、交互、响应式布局或视觉设计时，必须额外保存 `docs/design/<feature>/design.md` 和 `prototypes/` 下的本地原型图。前端实现前及 QA 验收前运行 `node scripts/harness/cli.mjs validate-design docs/design/<feature>`。

最终 UI 验收还必须保存 `verification/` 下的实现截图和 `verification.md`。该报告把每个原型场景映射到固定视口、测试数据和实现截图；运行 `node scripts/harness/cli.mjs validate-visual docs/design/<feature>` 作为通过门禁。

## 最小验收清单

- [ ] `node scripts/harness/cli.mjs doctor --strict` 通过
- [ ] `node scripts/harness/cli.mjs guard "git push --force"` 被拦截
- [ ] `node scripts/harness/cli.mjs verify` 输出已执行或明确跳过的检查
- [ ] GitHub Actions 的 Harness workflow 通过

## 原则与流程

见 [docs/HARNESS.md](docs/HARNESS.md)、[docs/WORKFLOW.md](docs/WORKFLOW.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
