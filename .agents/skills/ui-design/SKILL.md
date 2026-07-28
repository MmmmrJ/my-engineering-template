---
name: ui-design
description: Design user flows, information hierarchy, page and component states, responsive behavior, accessibility, and implementable visual specifications. Use for new or changed user-facing flows, screens, interaction patterns, design systems, or UI acceptance details. Do not use for code-only fixes that preserve the approved design.
---

# UI Design

把产品目标转化为可实现、可测试的界面规格。

## 工作流程

1. 阅读产品规格、现有界面、设计令牌、组件和相关研究证据；优先复用已有系统。
2. 先确定用户任务、页面信息层级、主操作和关键反馈，再处理装饰性细节。
3. 描述页面、组件和关键交互，覆盖默认、加载、空、错误、成功、禁用、延迟和离线状态。
4. 明确桌面、平板和窄屏布局变化，以及键盘顺序、焦点、语义、对比度、缩放和动效降级。
5. 对演示数据、延迟数据、权限限制和合规提示给出持续、可理解的视觉标识。
6. 对新增或改变页面、用户流程、交互、响应式布局或视觉设计，创建 `docs/design/<feature>/design.md`，并将本地原型图保存到 `prototypes/`；每张图必须由 design.md 引用，Figma 链接不能替代本地导出图。
7. 运行 `node scripts/harness/cli.mjs validate-design docs/design/<feature>`，输出前端可直接实现、QA 可直接验证的状态矩阵、行为和验收说明。
8. 在团队工作流中把设计作为待用户审核方案交付；用户不满意时按具体反馈修订，标明版本差异并再次提交，不得自行宣布设计获批。

## 设计原则

- 优先建立清晰的视觉命题、内容层级和交互主线，避免无目的卡片堆叠。
- 不用颜色作为唯一状态信号。
- 关键写操作需要确认、反馈、错误恢复和可追溯结果。
- 设计探索、审计、Figma 或视觉转代码属于平台增强能力；缺失时仍用本 skill 完成基础规格，不得阻塞。

## 交付格式

- 用户流程与信息架构
- 页面/组件清单及状态矩阵
- 视觉层级、令牌和交互说明
- 响应式与无障碍要求
- 可测试的 UI 验收标准
- `design.md` 与其本地原型图路径

不得修改前后端业务代码、迁移、运行时配置或测试代码。只有父 Agent 提供当前方案的明确用户确认记录后，才能把设计标记为已确认并交给实现角色。
