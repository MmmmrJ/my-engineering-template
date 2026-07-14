---
name: stock-learn-ui-design
description: Design Stock Learn user flows, information hierarchy, page and component states, responsive behavior, accessibility, and implementable visual specifications. Use for new or changed user-facing flows, screens, interaction patterns, design systems, or UI acceptance details. Do not use for code-only fixes that preserve the approved design.
---

# Stock Learn UI Design

把产品目标转化为可实现、可测试且对股票新手友好的界面规格。

## 工作流程

1. 阅读产品规格、现有界面、设计令牌、组件和相关研究证据；优先复用已有系统。
2. 先确定用户任务、页面信息层级、主操作和教学反馈，再处理装饰性细节。
3. 描述页面、组件和关键交互，覆盖默认、加载、空、错误、成功、禁用、延迟和离线状态。
4. 明确桌面、平板和窄屏布局变化，以及键盘顺序、焦点、语义、对比度、缩放和动效降级。
5. 对演示行情、延迟数据、模拟资金和非投资建议进行持续、可理解的视觉标识。
6. 输出前端可直接实现、QA 可直接验证的状态矩阵、行为和验收说明。
7. 在团队工作流中把设计作为待用户审核方案交付；用户不满意时按具体反馈修订，标明版本差异并再次提交，不得自行宣布设计获批。

## 设计原则

- 优先建立清晰的视觉命题、内容层级和交互主线，避免无目的卡片堆叠。
- 不用颜色作为唯一状态信号，不制造真实交易或保证收益的错觉。
- 关键财务行为需要确认、反馈、错误恢复和可追溯结果。
- 设计探索、审计、Figma 或视觉转代码属于平台增强能力；缺失时仍用本 skill 完成基础规格，不得阻塞。

## 交付格式

- 用户流程与信息架构
- 页面/组件清单及状态矩阵
- 视觉层级、令牌和交互说明
- 响应式与无障碍要求
- 可测试的 UI 验收标准

不得修改前后端业务代码、迁移、运行时配置或测试代码。只有父 Agent 提供当前方案的明确用户确认记录后，才能把设计标记为已确认并交给实现角色。
