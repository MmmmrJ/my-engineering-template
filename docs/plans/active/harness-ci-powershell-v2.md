# Exec Plan: Harness CI 与 PowerShell Guard V2

- 状态：in_progress
- 创建：2026-07-28
- 负责人：父 Agent
- 关联方案：方案 V2
- 用户确认：是 — 确认时间：2026-07-28 16:35 +08:00

## 目标

补齐 Windows PowerShell 风险命令拦截，并以 GitHub Actions 的六组合矩阵取得真实跨平台验证证据。

## 范围

- 包含：PowerShell 广域递归删除、`.env` 写入/暂存和绕过 hooks 的拦截；对应 Node 单测；推送后 GitHub Actions 验证。
- 不包含：应用发布、部署、安装包、通用 PowerShell 策略执行或任意命令白名单。

## 步骤

| # | 步骤 | 负责角色 | 状态 | 笔记 |
|---|---|---|---|---|
| 1 | 定义最小 PowerShell 拦截规则与例外 | 后端开发 | completed | 仅拦截广域目标，不阻止项目内受控删除 |
| 2 | 加入 Windows 字符串、stdin JSON 与回归用例 | 测试工程师 | completed | 在所有 CI 平台运行 |
| 3 | 运行本地验证并提交、推送当前分支 | 父 Agent | in_progress | 用户已授权；首轮 Actions 发现 Node 24 不接受目录测试入口，正在改为原生 Node 测试发现器后重跑 |
| 4 | 监控 GitHub Actions 六组合并记录结果 | 测试工程师 | in_progress | 首轮 run `30321120776` 的六个 job 均在 `npm test` 失败，修复后重新验证 |

## 验证清单

- [x] `npm test`
- [x] `node scripts/harness/cli.mjs doctor --strict`
- [x] `node scripts/harness/cli.mjs verify`
- [ ] GitHub Actions: Windows/macOS/Linux × Node 20/24 全绿

## 完成标准

- 广域 PowerShell 危险命令被稳定拦截，正常项目目录删除不被误拦截。
- GitHub Actions 六个 job 均通过，并将 run URL 与结论记录在本计划。

## 阻塞记录

- 2026-07-28：本地沙箱安全策略拒绝将提交 `86dec77` 推送到 `https://github.com/MmmmrJ/my-subagent.git`，因为缺少针对该远端与代码载荷的明确用户授权。解除条件：用户明确授权此推送。
- 2026-07-28：用户已授权推送；首轮 GitHub Actions run `30321120776` 已启动并暴露 Node 24 的目录测试入口兼容性问题。该问题不改变 V2 的既定行为，正在以跨平台 Node 测试发现器修复。
