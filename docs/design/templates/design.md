# Design: <功能名称>

- 状态：`draft` | `approved` | `implemented`
- 方案版本：`方案 Vn`
- 关联规格：`docs/product/<feature>.md`
- 关联计划：`docs/plans/active/<plan>.md`
- 创建：YYYY-MM-DD
- 最后更新：YYYY-MM-DD

## 视口与状态矩阵

| 场景 / 状态 | 视口 | 测试数据 / 权限 | 原型图 | 说明 |
|---|---:|---|---|---|
| 桌面默认 | 1440 × 900 | | ![桌面主状态](prototypes/desktop-main.png) | |
| 移动默认 | 390 × 844 | | ![移动主状态](prototypes/mobile-main.png) | |

## 原型图清单

- 每张原型图都必须在上方矩阵中声明场景、状态、视口和测试数据。

## 页面结构与视觉规范

- 信息层级、布局和区域：
- 颜色、字体、字号/行高、间距、圆角、阴影和图标：
- 可复用组件与变体：

## 交互流程与状态

- 主流程：
- 加载、空、错误、成功、禁用与权限状态：
- 键盘、焦点、动效与反馈：

## 响应式与无障碍

- 断点与重排规则：
- 语义、焦点顺序、对比度、缩放、减少动效和辅助技术说明：

## 参考规范

- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)：
- [Apple 组件规范](https://developer.apple.com/design/human-interface-guidelines/components/)：
- [Apple Design Resources（Figma / Sketch UI Kit）](https://developer.apple.com/design/resources/)：
- [App Review Guidelines](https://developer.apple.com/app-store/guidelines/)：
- 本设计与上述规范的适用范围、偏差及理由：

## 视觉验收基线与偏差

- 实现截图须使用“视口与状态矩阵”中的固定视口和测试数据，保存于 `verification/`。
- 未经 UI 确认的视觉或交互差异默认是缺陷，不得以“实现优化”名义跳过。
- 允许偏差及其约束：
- 偏差的确认人、设计版本和变更原因必须记录在 `verification.md`。

## 实施与验收关联

- 前端实现注意事项：
- 与 Feature Spec 验收标准的映射：
- QA 视觉/交互验收步骤：
