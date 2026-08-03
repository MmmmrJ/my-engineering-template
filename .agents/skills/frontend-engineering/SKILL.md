---
name: frontend-engineering
description: Implement frontend features from approved product, UI, and API contracts with accessible states, responsive behavior, client tests, and release evidence. Use when changing browser application code, client state, API integration, styling, or frontend tests. Do not use for backend domain logic or data migrations.
---

# Frontend Engineering

实现与产品、UI 和 API 契约一致的客户端纵向切片，并提供相称的验证证据。

## 工作流程

1. 检查父 Agent 是否提供 `用户已确认：方案 Vn`，并读取唯一 active task 的 `governance.json`。确认版本不一致、角色未登记、路径不在允许范围或命中禁止路径时，只能只读检查并报告父 Agent。
2. 阅读已确认的验收标准、UI 状态、公开 API 契约、现有架构和测试惯例。若涉及页面或交互，必须读取 `docs/design/<feature>/design.md`、本地原型图与 `assets/manifest.md`，确认设计和资产均已冻结并先运行 `validate-design`；缺失或未冻结时交回父 Agent，不得自行推断设计、替换资产或重新设计。
3. 明确客户端与服务端状态所有权；权威业务状态以服务端结果为准。
4. 用现有组件和令牌实现页面与交互，覆盖加载、空、错误、成功、离线和延迟状态。
5. 保证语义化结构、键盘操作、焦点管理、可读错误、窄屏布局和减少动效偏好。
6. 按契约展示数据来源、时效、演示/模拟边界与权限限制。
7. 增加或更新与风险相称的组件、集成或浏览器测试；涉及 UI 时按设计矩阵的固定视口和测试数据生成实现截图，确认渲染资产与清单版本一致，保存到 `docs/design/<feature>/verification/`，供 QA 验收；运行类型检查、测试和构建。
8. 报告确认版本、修改文件、验证结果、未执行检查和剩余风险。

## 边界

- 不修改后端业务逻辑、数据库模型或迁移；需要契约变化时先交给总控协调。
- 视觉创作、图像转代码、URL 克隆和真实浏览器自动化属于条件增强；缺失时使用现有设计与项目测试继续工作。
- 平台增强能力不得扩大写入范围，也不得替代项目契约和验收标准。
- 不得运行任务状态变更命令、自行修改治理记录、批准方案或接受风险；只向父 Agent 返回修改清单、检查结果和证据。
- 实现中发现必须改变已确认交互、范围、契约或验收标准时停止受影响工作并报告父 Agent，不得自行变更设计。
