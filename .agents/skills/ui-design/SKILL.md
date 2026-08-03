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
6. 对新增或改变页面、用户流程、交互、响应式布局或视觉设计，创建 `docs/design/<feature>/design.md`，将本地原型图保存到 `prototypes/`，并创建 `assets/manifest.md` 与本地冻结资产；三者共同构成实施契约。每张图必须由 design.md 引用，外部链接不能替代本地原型或运行时资产。为每个验收场景明确固定视口、状态和测试数据。
7. 用户点名 skill 或插件时，记录能力、角色、输入、候选产物和不可用时的降级方式；其输出只能作为设计输入，必须经视觉方向选择、资产冻结和用户确认后才能交给实现。
8. 为图标记录批准库/本地 SVG、版本、图标名、尺寸、颜色、状态和无障碍名称；为背景图记录来源/许可、本地冻结文件、显示模式、裁切焦点、遮罩、对比度和响应式变体。不得以 emoji、临时 CSS 或未确认相似资产替换冻结资产。
9. 运行 `node scripts/harness/cli.mjs validate-design docs/design/<feature>`，输出前端可直接实现、QA 可直接验证的状态矩阵、行为和验收说明。
10. 在团队工作流中把设计作为待用户审核方案交付；用户不满意时按具体反馈修订，标明版本差异并再次提交，不得自行宣布设计获批。

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
- `design.md`、本地原型图及 `assets/manifest.md` 路径与冻结版本
- 允许偏差边界，以及最终 `verification.md` 所需的原型场景映射

不得修改前后端业务代码、迁移、运行时配置或测试代码。只有父 Agent 提供当前方案的明确用户确认记录后，才能把设计标记为已确认并交给实现角色。
