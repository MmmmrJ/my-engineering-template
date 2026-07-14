---
name: stock-learn-frontend-engineering
description: Implement Stock Learn frontend features from approved product, UI, and API contracts with accessible states, responsive behavior, client tests, and release evidence. Use when changing browser application code, client state, API integration, styling, or frontend tests. Do not use for backend domain logic or data migrations.
---

# Stock Learn Frontend Engineering

实现与产品、UI 和 API 契约一致的客户端纵向切片，并提供相称的验证证据。

## 工作流程

1. 检查父 Agent 是否提供 `用户已确认：方案 Vn` 及确认范围。缺少记录时只能只读检查并输出实施计划，禁止修改前端代码、配置或测试。
2. 阅读已确认的验收标准、UI 状态、公开 API 契约、现有架构和测试惯例。
3. 明确客户端与服务端状态所有权；余额、持仓、成交和关键课程门禁以服务端结果为准。
4. 用现有组件和令牌实现页面与交互，覆盖加载、空、错误、成功、离线和延迟状态。
5. 保证语义化结构、键盘操作、焦点管理、可读错误、窄屏布局和减少动效偏好。
6. 显示行情来源/时效、演示数据、模拟资金与非投资建议边界。
7. 增加或更新与风险相称的组件、集成或浏览器测试，运行类型检查、测试和构建。
8. 报告确认版本、修改文件、验证结果、未执行检查和剩余风险。

## 边界

- 不修改后端业务逻辑、数据库模型或迁移；需要契约变化时先交给总控协调。
- 视觉创作、图像转代码、URL 克隆和真实浏览器自动化属于条件增强；缺失时使用现有设计与项目测试继续工作。
- 平台增强能力不得扩大写入范围，也不得替代项目契约和验收标准。
- 实现中发现必须改变已确认交互、范围、契约或验收标准时停止受影响工作并报告父 Agent，不得自行变更设计。
