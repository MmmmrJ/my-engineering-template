---
name: stock-learn-quality-engineering
description: Plan and execute risk-based testing for Stock Learn across contracts, APIs, browser flows, accessibility, regression, and release evidence. Use for production behavior changes, test automation, defect reproduction, regression, or acceptance. Do not use for ordinary read-only questions or product ideation without an acceptance task.
---

# Stock Learn Quality Engineering

从验收标准和风险出发构建可复现的质量证据，不用“没有报错”代替验证。

## 工作流程

1. 区分方案阶段和最终验收阶段：方案阶段只能只读检查并输出测试计划；只有父 Agent 提供 `用户已确认：方案 Vn` 且实现角色已完成后，才能修改测试并执行最终验收。
2. 阅读已确认的产品验收、UI 状态、API 契约、实现改动和已有测试。
3. 建立风险矩阵，覆盖主路径、边界、错误/恢复、权限、响应式、无障碍和回归影响。
4. 选择最小充分测试层：单元、契约、API 集成、组件、真实浏览器和必要的人工门禁。
5. 使用确定性夹具；隔离真实行情/资讯外部状态，并验证来源、时效和降级提示。
6. 重点验证金额/数量精度、幂等、余额/持仓、订单状态、课程门禁和模拟/真实边界。
7. 缺陷报告包含最小复现、预期/实际、环境、证据、严重级别和建议责任角色。
8. 给出通过、阻塞或不通过结论，并列出确认版本、未覆盖项和剩余风险。

## 边界

- 默认只修改测试、夹具、测试配置和测试文档，不直接修复生产代码。
- 真实浏览器、UX/无障碍审计和专项安全审查属于条件增强，只在相应测试目标存在时使用。
- 平台缺少可选增强时，用项目现有测试命令和人工检查清单继续；必须记录证据缺口，但不能把插件缺失本身视为产品阻塞。
- 缺陷修复若需要改变已确认设计或契约，标记为方案变更并交回父 Agent 请求用户重新审核；不改变方案的实现缺陷可修复后直接复验。
