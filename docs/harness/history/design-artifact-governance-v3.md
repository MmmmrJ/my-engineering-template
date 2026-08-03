# Exec Plan: 模板状态归档与设计交付约束 V3

- 状态：`completed`
- 创建：2026-07-28
- 负责人：父 Agent
- 关联方案：`方案 V3`
- 用户确认：是 — 确认时间：2026-07-28 17:30 +08:00

## 目标

让模板克隆后处于无遗留任务的待命状态；让每项页面或交互设计具备仓库内原型图和可实施、可验证的 `design.md`。

## 实施结果

- V2 已从 `docs/plans/active/` 归档至 `docs/plans/completed/`；V3 完成后同样归档，active 目录仅保留占位文件。
- 新增 `docs/design/templates/design.md` 与 `docs/design/README.md`，定义本地原型图、交互、响应式、无障碍与验收映射的设计产物链。
- 新增 `node scripts/harness/cli.mjs validate-design <directory>`；校验 `design.md` 必填章节、关联元数据、Markdown 原型图引用、本地 `prototypes/` 路径、图片格式和文件存在性。
- Feature Spec 新增“设计交付”。标记为 `required` 时，`validate-spec` 会联动校验设计目录；非 UI 需求必须显式标记 `not-applicable`。
- UI、前端、QA、编排规则、Codex/Cursor 角色定义及文档均已同步设计约束。

## 验收结果

- [x] 已完成计划均位于 `docs/plans/completed/`，`docs/plans/active/` 无已完成计划。
- [x] 设计目录缺失、缺章节或原型图引用失效时，`validate-design` 失败。
- [x] 完整设计目录及 `required` Feature Spec 通过校验。
- [x] `npm test`：9/9 通过。
- [x] `node scripts/harness/cli.mjs doctor --strict`：通过。
- [x] `node scripts/harness/cli.mjs verify`：通过。
