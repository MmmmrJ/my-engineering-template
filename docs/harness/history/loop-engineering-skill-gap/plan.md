# Exec Plan: 补齐 Loop skills 与角色映射

- 状态：`awaiting_approval`
- 方案版本：`V1`

## 目标

修复方案 V1 的实施漏项：补齐 `loop-intake`、`loop-constraints`、`minimal-fix` 三个共享 skill，并将七个 Loop overlays 接入角色真源、生成物、manifest 和回归测试。

## 范围

- `.agents/skills/`、`.agents/team.config.json`、生成的 Codex/Cursor agents。
- `harness.manifest.json` 与 Loop 分发/同步回归。

## 非目标

- 不改变 CLI、schema、运行策略、L1/L2 行为或用户确认门禁。

## 验收标准

- 七个 Loop skills 全部存在且进入 manifest。
- 产品、后端、QA 角色生成物明确引用适用 overlay。
- `sync-agents --check`、55+ 全量测试、strict doctor 和 QA 验收通过。
