# Task Plan: <标题>

- Task ID：`<task-id>`
- 阶段：`planning` | `awaiting_approval` | `approved` | `implementing` | `accepting` | `completed` | `blocked`
- 创建：YYYY-MM-DD
- 负责人：
- 关联方案：`方案 Vn`（如适用）
- 用户确认：是 / 否 — 确认人、时间与证据：

同目录必须包含机器可读的 `governance.json`；本文件只保存人类可读方案，不能替代确认、所有权或验收证据。

## 目标

一句话说明要交付什么。

## 范围

- 包含：
- 不包含：

## 关键假设

-

## 步骤

| # | 步骤 | 负责角色 | 状态 | 笔记 |
|---|---|---|---|---|
| 1 | | | pending | |

## 决策日志

| 日期 | 决策 | 理由 |
|---|---|---|
| | | |

## 验证清单

- [ ] 类型检查 / lint（如适用）
- [ ] 自动化测试（如适用）
- [ ] `node scripts/harness/cli.mjs task validate <task-id> --phase implementation`
- [ ] `node scripts/harness/cli.mjs verify --profile full`
- [ ] `node scripts/harness/cli.mjs task validate <task-id> --phase complete`
- [ ] 手动/浏览器验收（如适用）

## 完成标准

-

## 完成后

由父 Agent 运行 `node scripts/harness/cli.mjs task complete <task-id>`。命令在门禁通过后归档整个任务目录，并把 `docs/team/STATUS.md` 自动复位为待命；项目模式归档到 `docs/plans/completed/`，模板模式归档到 `docs/harness/history/`。不得手工只移动 `plan.md`。
