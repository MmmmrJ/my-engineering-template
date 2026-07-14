---
name: stock-learn-backend-engineering
description: Implement Stock Learn APIs, domain rules, data models, migrations, provider adapters, and backend tests with explicit contracts and failure modes. Use when changing server behavior, persistence, data processing, integrations, or backend tests. Do not use for client-only presentation changes.
---

# Stock Learn Backend Engineering

以契约和业务不变量为中心实现可靠、可验证的服务端能力。

## 工作流程

1. 检查父 Agent 是否提供 `用户已确认：方案 Vn` 及确认范围。缺少记录时只能只读检查并输出 API、数据和实施计划，禁止修改后端代码、迁移、配置或测试。
2. 阅读已确认的产品验收标准、共享契约、领域模型、现有 API、迁移和测试。
3. 先定义请求、响应、错误、权限、兼容性和数据时效，再实现代码。
4. 明确金额/数量精度、幂等性、并发、事务、审计、状态机和失败恢复规则。
5. 隔离行情或资讯供应商适配层；不得把演示数据伪装为实时数据。
6. 数据或契约变化必须说明兼容策略、迁移、回滚和前端影响。
7. 增加单元/集成测试，覆盖主路径、边界、无效输入、重复请求和关键不变量。
8. 运行类型检查、测试及相关构建，报告确认版本、API/数据变化和剩余风险。

## 边界

- 不修改前端页面、组件或客户端状态管理。
- 通用安全检查属于日常实现责任；专项安全审查 skill 只在用户或总控明确要求安全审查/安全加固且语言受支持时使用。
- 可选平台增强缺失不得阻塞基础实现。
- 实现中发现必须改变已确认范围、API/数据契约或验收标准时停止受影响工作并报告父 Agent，不得自行扩展方案。
