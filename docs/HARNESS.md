# Loop Engineering Harness 原则

本仓库是面向 Codex 与 Cursor 的 Loop Engineering harness：外层 Loop 负责跨时间触发、分诊、状态、预算和复盘，内层 delivery harness 负责一次行动的方案确认、角色分工、实现和验收。二者都用仓库结构和脚本约束 agent，而不是把一切写进超长提示。

## 十二条原则

1. **薄入口**：根目录 `AGENTS.md` 是地图（目标 ≤120 行），不是百科。细节放在 `docs/`。
2. **Repo 真源**：产品、设计、计划、决策、状态都以仓库文件为准；聊天记录不是权威来源。
3. **方案确认门禁**：产品行为变更走 `team-orchestrator`：先方案 Vn，用户明确确认后再实现与验收。
4. **机械强制**：危险命令、密钥路径、完成门禁由 `scripts/` + 平台 hooks / git hooks 强制；提示只能建议。
5. **失败反馈进 harness**：同一类错误出现两次以上时，应加规则、hook 或检查脚本，而不是只口头提醒。
6. **设计可追溯**：页面与交互设计必须将本地原型图、冻结资产清单、`design.md`、实现截图和 `verification.md` 入库；用户点名能力只能产生可追溯候选输入，外部设计链接或运行时外链资产不能成为唯一实现依据。
7. **任务可证明**：每个实施需求必须具有唯一 active task、明确确认版本、角色路径所有权、阶段状态与验收证据。
8. **检查不假通过**：项目模式必须配置 full/ci 检查；本地 hooks 与 CI 对治理缺口采用阻断模式。
9. **规则单一真源**：角色和平台映射以 `.agents/team.config.json` 为准，Codex/Cursor agent 文件由 CLI 生成并检查漂移。
10. **渐进自治**：所有新安装和新 pattern 从 L1 report-only 开始；L2 依赖真实运行、隔离、独立 verifier、预算与熔断证据。本模板不提供 L3。
11. **状态分层**：`STATE.md` 记录跨轮工程记忆，`docs/team/STATUS.md` 记录当前角色活动，task governance 记录一次交付批准和验收；三者不得互相替代。
12. **可停止、可复盘**：每轮有 run evidence、成本和 outcome；kill switch、预算、锁、attempt 上限或 verifier 拒绝必须 fail-closed。

## 两层系统

```text
外层 Loop: trigger → preflight → triage → state → action decision → run evidence
                                              │
                                              ▼
交付内环:       plan → explicit approval → implement → independent acceptance
```

- Loop 可发现、分诊和升级工作，但不能自行批准 task。
- L1 只写允许的状态和运行证据，不修改 `governedPaths`。
- L2 只能在已批准 task、隔离 worktree、有效路径锁和独立 verifier 下产生 patch 提案。
- Verifier 的通过不等于用户批准、QA acceptance、push 或 merge 授权。

## 分层职责

| 层 | 位置 | 职责 |
|---|---|---|
| 路由 | `AGENTS.md` | 何时启动团队、角色表、硬约束 |
| Loop 控制 | `LOOP.md`、`loop.config.json`、`docs/loops/` | Pattern、成熟度、预算、调度、安全与操作契约 |
| 编排 | `.agents/skills/team-orchestrator/` | 方案 → 确认 → 实施 → 验收 |
| 角色 | `.agents/skills/*` + `.codex/agents` + `.cursor/agents` | 有界专职工作 |
| 知识 | `docs/` | 架构、产品、计划、决策 |
| 护栏 | `scripts/` + hooks | 拦截危险操作、完成前验证 |
| Loop 状态 | `STATE.md`、`.harness/runtime/`、`loop-run-log.md` | 跨轮优先级、Human Inbox、attempt 与运行证据 |
| 团队状态 | `docs/team/STATUS.md` | 当前交付角色状态 |

## 自治理边界

Harness 负责 Loop 生命周期、需求生命周期、subagent 职责、用户确认、文件所有权、安全门禁、检查调度和交付证据。业务系统的技术栈、架构、API、数据、部署和运维规则由业务仓自行定义，并通过 `governedPaths`、pattern 输入和检查命令接入。

`harness.config.json` 只治理项目路径、检查和架构边界；`loop.config.json` 只治理 pattern、level、enabled、状态、预算和运行策略。CLI 必须检查二者的路径引用和权限关系，避免形成冲突真源。

## 业务仓如何演进 harness

- 改业务约束：更新 `docs/ARCHITECTURE.md`、角色 skill 中的领域条款。
- 改流程：更新 `docs/WORKFLOW.md` 与 `team-orchestrator`（需谨慎，保留确认门禁语义）。
- 改 Loop：更新 `LOOP.md`、`docs/loops/`、机器 schema 与对应测试；不得只改人读文档或只改配置。
- 改护栏：改 `scripts/harness/`，并用 `doctor --template --strict`、`sync-agents --check` 和 harness 测试检出。
