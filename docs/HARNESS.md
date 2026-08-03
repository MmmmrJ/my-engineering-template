# Harness 原则

本仓库是面向 Codex 与 Cursor 的工程 harness：用结构与脚本约束 agent，而不是把一切写进超长提示。

## 九条原则

1. **薄入口**：根目录 `AGENTS.md` 是地图（目标 ≤120 行），不是百科。细节放在 `docs/`。
2. **Repo 真源**：产品、设计、计划、决策、状态都以仓库文件为准；聊天记录不是权威来源。
3. **方案确认门禁**：产品行为变更走 `team-orchestrator`：先方案 Vn，用户明确确认后再实现与验收。
4. **机械强制**：危险命令、密钥路径、完成门禁由 `scripts/` + 平台 hooks / git hooks 强制；提示只能建议。
5. **失败反馈进 harness**：同一类错误出现两次以上时，应加规则、hook 或检查脚本，而不是只口头提醒。
6. **设计可追溯**：页面与交互设计必须将本地原型图、冻结资产清单、`design.md`、实现截图和 `verification.md` 入库；用户点名能力只能产生可追溯候选输入，外部设计链接或运行时外链资产不能成为唯一实现依据。
7. **任务可证明**：每个实施需求必须具有唯一 active task、明确确认版本、角色路径所有权、阶段状态与验收证据。
8. **检查不假通过**：项目模式必须配置 full/ci 检查；本地 hooks 与 CI 对治理缺口采用阻断模式。
9. **规则单一真源**：角色和平台映射以 `.agents/team.config.json` 为准，Codex/Cursor agent 文件由 CLI 生成并检查漂移。

## 分层职责

| 层 | 位置 | 职责 |
|---|---|---|
| 路由 | `AGENTS.md` | 何时启动团队、角色表、硬约束 |
| 编排 | `.agents/skills/team-orchestrator/` | 方案 → 确认 → 实施 → 验收 |
| 角色 | `.agents/skills/*` + `.codex/agents` + `.cursor/agents` | 有界专职工作 |
| 知识 | `docs/` | 架构、产品、计划、决策 |
| 护栏 | `scripts/` + hooks | 拦截危险操作、完成前验证 |
| 状态 | `docs/team/STATUS.md` | 跨会话角色状态 |

## 自治理边界

Harness 负责需求生命周期、subagent 职责、用户确认、文件所有权、安全门禁、检查调度和交付证据。业务系统的技术栈、架构、API、数据、部署和运维规则由业务仓自行定义，并通过 `governedPaths` 与检查命令接入。

## 业务仓如何演进 harness

- 改业务约束：更新 `docs/ARCHITECTURE.md`、角色 skill 中的领域条款。
- 改流程：更新 `docs/WORKFLOW.md` 与 `team-orchestrator`（需谨慎，保留确认门禁语义）。
- 改护栏：改 `scripts/harness/`，并用 `doctor --template --strict`、`sync-agents --check` 和 harness 测试检出。
