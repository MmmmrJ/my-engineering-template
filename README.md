# Harness Engineering Template

面向 **Codex** 与 **Cursor** 的工程 harness 模版：五角色确认门禁 + 知识底座 + 机械护栏。提供空业务目录占位，技术栈自选。

## 5 分钟启用

```bash
git clone <this-repo> my-app && cd my-app
chmod +x scripts/*.sh .githooks/*
git config core.hooksPath .githooks
cp scripts/project-checks.env.example scripts/project-checks.env
./scripts/doctor.sh
```

Cursor：信任工作区后 `.cursor/hooks.json` 生效。  
Codex：若提示，执行一次 `/hooks` trust；见 `.codex/config.toml`。

## 业务目录（空）

| 路径 | 说明 |
|---|---|
| `apps/frontend/` | 前端（空，自行搭建） |
| `apps/backend/` | 后端（空，自行搭建） |
| `packages/contracts/` | 共享契约（空，可选） |

在目录中放入所选技术栈后，把检查命令写入 `scripts/project-checks.env`，并更新 `docs/ARCHITECTURE.md`。

## 接到已有业务仓（仅 harness）

```bash
./scripts/install-harness.sh --merge /path/to/your-app
./scripts/install-harness.sh --dry-run --merge /path/to/your-app
```

- 默认 `--merge`：不覆盖已有文件；`AGENTS.md` 只合并 `team-orchestrator` 标记区块。
- **不复制** `apps/` / `packages/`。
- 棕地映射：`$onboard-repository`。

## 目录说明

| 路径 | 作用 |
|---|---|
| `AGENTS.md` | Agent 薄入口与团队路由 |
| `.agents/skills/` | 跨平台共享 skills |
| `.codex/` / `.cursor/` | 平台 agents 与 hooks |
| `docs/` | 知识真源 |
| `scripts/` | 护栏与安装/诊断脚本 |
| `.githooks/` | commit/push 门禁 |
| `apps/` / `packages/` | 空业务目录占位 |

## 最小验收清单

- [ ] `./scripts/doctor.sh` 通过
- [ ] `./scripts/guard-bash.sh 'git push --force'` 被拦截
- [ ] `docs/README.md` 文档地图可读

## 原则与流程

见 [docs/HARNESS.md](docs/HARNESS.md)、[docs/WORKFLOW.md](docs/WORKFLOW.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
