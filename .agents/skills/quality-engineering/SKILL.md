---
name: quality-engineering
description: Plan and execute risk-based testing across contracts, APIs, browser flows, accessibility, regression, and release evidence. Use for production behavior changes, test automation, defect reproduction, regression, or acceptance. Do not use for ordinary read-only questions or product ideation without an acceptance task.
---

# Quality Engineering

从验收标准和风险出发构建可复现的质量证据，不用“没有报错”代替验证。

## 工作流程

1. 区分方案阶段和最终验收阶段：方案阶段只能只读检查并输出测试计划；只有父 Agent 提供 `用户已确认：方案 Vn` 且实现角色已完成后，才能修改测试并执行最终验收。
2. 阅读已确认的产品验收、UI 状态、API 契约、实现改动和已有测试。涉及 UI 时，设计目录中的 `design.md`、本地原型图与 `assets/manifest.md` 均是验收基线；先运行 `validate-design`，再核对关键页面、状态、交互、资产版本、响应式和无障碍实现。
3. 建立风险矩阵，覆盖主路径、边界、错误/恢复、权限、响应式、无障碍和回归影响。
4. 选择最小充分测试层：单元、契约、API 集成、组件、真实浏览器和必要的人工门禁。
5. 使用确定性夹具；隔离真实外部依赖，并验证来源、时效和降级提示。
6. 重点验证关键不变量、幂等、权限边界、状态机和演示/真实数据边界。
7. 缺陷报告包含最小复现、预期/实际、环境、证据、严重级别和建议责任角色。
8. 涉及 UI 时，写入 `verification.md`：逐项映射原型图、固定视口、测试数据、资产版本和实现截图；按 P0/P1/P2 记录偏差的原因、影响、状态、UI 确认人和设计版本。P0/P1 必须修复，P2 必须具名确认；运行 `validate-visual`。给出通过、阻塞或不通过结论，并列出确认版本、未覆盖项和剩余风险。

## 边界

- 默认只修改测试、夹具、测试配置和测试文档，不直接修复生产代码。
- 真实浏览器、UX/无障碍审计和专项安全审查属于条件增强，只在相应测试目标存在时使用。
- 平台缺少可选增强时，用项目现有测试命令和人工检查清单继续；必须记录证据缺口，但不能把插件缺失本身视为产品阻塞。
- 缺陷修复若需要改变已确认设计或契约，标记为方案变更并交回父 Agent 请求用户重新审核；不改变方案的实现缺陷可修复后直接复验。
