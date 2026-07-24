# Harness 模版补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留五角色确认门禁优势的前提下，补齐知识底座、机械护栏、可移植安装与验证闭环，使本仓库成为可直接装进业务仓的 Codex/Cursor Harness Engineering 模版。

**Architecture:** 保持现有 `.agents/skills` + 双平台 agents + `team-orchestrator` 不动；新增 `docs/` 知识骨架、`scripts/` 共享护栏、平台 hooks、安装/入职 skill。提示层指路，脚本层强制。

**Tech Stack:** Markdown、Bash、Cursor `hooks.json`、Codex `config.toml`、`.githooks/`。不引入编译器、SQLite 或 AHE。

## Global Constraints

- 不削弱现有 `team-orchestrator` 确认门禁与五角色边界。
- 只支持 Codex + Cursor；不扩其他 IDE。
- 不新增示例业务应用（`apps/`）；命令与架构用占位符，由业务仓填写。
- 护栏脚本纯 Bash；密钥只进 `.env`，配置用 `${VAR}`。
- `AGENTS.md` 保持薄入口（目标 ≤120 行），细节进 `docs/`。
- 若残留 `stock-learn-*` 目录，实施前先清除并核对引用为通用 skill 名。

---

## 目标结构

```text
my-harness/
├── README.md
├── AGENTS.md
├── .env.example
├── .gitignore
├── .agents/skills/
│   ├── team-orchestrator/              # 已有
│   ├── product-management/ ...         # 已有五角色
│   ├── onboard-repository/             # 新增
│   └── audit-onboarding-proposal/      # 新增
├── .codex/
│   ├── agents/                         # 已有
│   └── config.toml                     # 新增
├── .cursor/
│   ├── agents/                         # 已有
│   └── hooks.json                      # 新增
├── .githooks/
│   ├── pre-commit
│   └── pre-push
├── docs/
│   ├── README.md
│   ├── HARNESS.md
│   ├── WORKFLOW.md
│   ├── ARCHITECTURE.md
│   ├── product/.gitkeep
│   ├── design/.gitkeep
│   ├── plans/active|completed/.gitkeep
│   ├── decisions/.gitkeep
│   ├── templates/exec-plan.md
│   ├── team/                           # 已有
│   └── superpowers/plans/              # 本计划所在处
└── scripts/
    ├── install-harness.sh
    ├── guard-bash.sh
    ├── verify.sh
    ├── check-boundaries.sh
    ├── pre-commit-checks.sh
    ├── session-context.sh
    ├── doctor.sh
    └── project-checks.env.example
```

## 明确不做（本轮）

- 示例业务应用 / monorepo 脚手架
- Claude Code / 其他 IDE 适配
- AHE 自动演化、SQLite 控制平面
- 源码编译式多 IDE 同步
- 重度 domain skills（web-research、github-workflow）

---

## Task 0: 清理残留与基线核对

**Files:**
- Delete: 任何仍存在的 `.agents/skills/stock-learn-*`
- Verify: `AGENTS.md`、双平台 agents、通用 skill 引用一致

- [ ] **Step 1:** 运行 `find .agents/skills -type d -name 'stock-learn-*'`；若有则删除整目录
- [ ] **Step 2:** 运行 `rg 'stock-learn|Stock Learn' . --glob '!.git/**'`，确认为 0
- [ ] **Step 3:** 确认五角色 skill 目录存在：`product-management`、`ui-design`、`frontend-engineering`、`backend-engineering`、`quality-engineering`、`team-orchestrator`

---

## Task 1: 知识底座与文档地图（P0）

**Files:**
- Create: `docs/README.md`
- Create: `docs/HARNESS.md`
- Create: `docs/WORKFLOW.md`
- Create: `docs/ARCHITECTURE.md`
- Create: `docs/templates/exec-plan.md`
- Create: `docs/product/.gitkeep`、`docs/design/.gitkeep`、`docs/plans/active/.gitkeep`、`docs/plans/completed/.gitkeep`、`docs/decisions/.gitkeep`

- [ ] **Step 1:** 写 `docs/README.md` 文档地图，链到 HARNESS / WORKFLOW / ARCHITECTURE / product / design / plans / decisions / team / templates
- [ ] **Step 2:** 写 `docs/HARNESS.md`：薄入口、repo 真源、确认门禁、机械强制、失败→改 harness
- [ ] **Step 3:** 写 `docs/WORKFLOW.md`：四级流程（只读 / 有界小改 / 多会话写 exec-plan / 产品歧义需确认）；写明何时启动 `team-orchestrator`
- [ ] **Step 4:** 写 `docs/ARCHITECTURE.md` 占位分层与依赖方向，明确「业务仓填写」
- [ ] **Step 5:** 写 `docs/templates/exec-plan.md`（目标、范围、非目标、步骤、决策日志、验证、状态）
- [ ] **Step 6:** 创建空目录 `.gitkeep`
- [ ] **Step 7:** 验收：从 `docs/README.md` 可到达全部权威文档；空目录可被 git 跟踪

---

## Task 2: 机械护栏脚本（P0）

**Files:**
- Create: `scripts/guard-bash.sh`
- Create: `scripts/pre-commit-checks.sh`
- Create: `scripts/check-boundaries.sh`
- Create: `scripts/verify.sh`
- Create: `scripts/session-context.sh`
- Create: `scripts/doctor.sh`
- Create: `scripts/project-checks.env.example`

- [ ] **Step 1:** 实现 `guard-bash.sh`：拦截危险命令与 never-touch 写/暂存；失败打印下一步动作
- [ ] **Step 2:** 实现 `project-checks.env.example` + `pre-commit-checks.sh`（未配置命令时 skip + warn，exit 0）
- [ ] **Step 3:** 实现 `check-boundaries.sh`（未配置边界模式时 warn + exit 0）
- [ ] **Step 4:** 实现 `verify.sh`：boundaries → pre-commit-checks → 可选测试占位
- [ ] **Step 5:** 实现 `session-context.sh`：分支、`docs/plans/active`、`docs/team/STATUS.md` 指针
- [ ] **Step 6:** 实现 `doctor.sh`：关键路径、脚本可执行位、skill 名一致性
- [ ] **Step 7:** `chmod +x scripts/*.sh`
- [ ] **Step 8:** 验收：危险命令样例非 0；`./scripts/doctor.sh` 通过

**guard-bash 最小拦截清单：**
- `rm -rf /` 及对仓库外危险递归删除
- `git push --force` / `-f` / `+refspec`（允许 `--force-with-lease` 需文档说明是否放行）
- `--no-verify`
- `curl … | sh` / `wget … | sh`
- `sudo`、`chmod 777`
- 对 `.env`、`.env.*` 的写或 `git add`

---

## Task 3: 双平台 hooks + git hooks + 密钥骨架（P0）

**Files:**
- Create: `.cursor/hooks.json`
- Create: `.codex/config.toml`
- Create: `.githooks/pre-commit`
- Create: `.githooks/pre-push`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1:** 写 `.cursor/hooks.json`：`beforeShellExecution` → `scripts/guard-bash.sh`；`afterFileEdit` → 轻量检查或 `pre-commit-checks.sh`
- [ ] **Step 2:** 写 `.codex/config.toml`：`sandbox_mode = "workspace-write"`、`approval_policy = "on-request"`，挂 PreToolUse/PostToolUse/SessionStart/Stop 到共享脚本
- [ ] **Step 3:** 写 `.githooks/pre-commit` / `pre-push` 调用脚本子集
- [ ] **Step 4:** 写 `.env.example` 与 `.gitignore`（`.env`、`.trace/`、`.DS_Store`）
- [ ] **Step 5:** 在 README（Task 4）预留说明：`git config core.hooksPath .githooks`；Codex `/hooks` trust
- [ ] **Step 6:** 验收：`doctor.sh` 能检出 hooks 与脚本可执行位

---

## Task 4: 入口完善 — README + AGENTS.md（P1）

**Files:**
- Create: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1:** 扩展 `AGENTS.md`（保留 `<!-- team-orchestrator:start/end -->`）：
  - 文档地图指针
  - `BUILD/TEST/LINT` 占位注释块
  - 何时写 `docs/plans/active/*.md`
  - never-touch / 密钥一行
  - hooks 启用一行
- [ ] **Step 2:** 确认 `AGENTS.md` ≤120 行
- [ ] **Step 3:** 写 `README.md`：是什么、目录、5 分钟启用、接到业务仓、最小验收清单
- [ ] **Step 4:** 验收：只读 README 可完成启用；路由区块标记完整

---

## Task 5: 可移植安装与棕地入职（P1）

**Files:**
- Create: `scripts/install-harness.sh`
- Create: `.agents/skills/onboard-repository/SKILL.md`
- Create: `.agents/skills/onboard-repository/agents/openai.yaml`
- Create: `.agents/skills/audit-onboarding-proposal/SKILL.md`
- Create: `.agents/skills/audit-onboarding-proposal/agents/openai.yaml`

- [ ] **Step 1:** 实现 `install-harness.sh`：
  - 默认 `--merge`：只补缺失；对已有 `AGENTS.md` 仅合并 `team-orchestrator` 标记区块
  - `--override` 才整文件替换
  - `--dry-run` 预览
  - 复制 skills、agents、hooks、scripts、docs 骨架、`.githooks`
  - 结束打印 doctor 与下一步
- [ ] **Step 2:** 写 `onboard-repository` skill：只读扫描 → 提案写入 `docs/plans/active/onboarding-proposal.md`；禁止未确认改业务代码/覆盖 AGENTS
- [ ] **Step 3:** 写 `audit-onboarding-proposal` skill：检查提案是否越界、是否缺验证命令
- [ ] **Step 4:** 验收：`install-harness.sh --dry-run /tmp/demo` 列表合理；对已有 AGENTS 的假目标只合并标记区块

---

## Task 6: 验证闭环与矩阵更新（P1）

**Files:**
- Modify: `docs/team/SKILL_MATRIX.md`
- Modify: `docs/team/STATUS.md`（如需补充 plans 指针说明）
- Modify: `docs/HARNESS.md`（失败反馈原则若 Task 1 未写全则补）
- Optional: `scripts/trace.sh`

- [ ] **Step 1:** 更新 `SKILL_MATRIX.md`：加入 onboard/audit 触发；验收用例保持通用
- [ ] **Step 2:** `STATUS.md` / `HARNESS.md` 交叉引用 `docs/plans/active`
- [ ] **Step 3:** （可选）`trace.sh` → `.trace/tools.jsonl`，并 gitignore
- [ ] **Step 4:** 终验清单全部勾选：
  - `rg 'stock-learn|Stock Learn'` = 0
  - `./scripts/doctor.sh` 通过
  - 危险命令被拦截
  - `install-harness.sh --dry-run` 合理
  - `docs/README.md` 无死链

---

## 实施顺序

`Task 0 → 1 → 2 → 3 → 4 → 5 → 6`

**风险与缓解：**
- Cursor/Codex hooks 事件名可能随版本变化 → `doctor.sh` 做存在性检查；README 链官方文档与 trust 步骤。
- 业务仓已有复杂 `AGENTS.md` → 安装默认只合并标记区块，禁止静默整文件覆盖。
