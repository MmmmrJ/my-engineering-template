# Visual Verification: <功能名称>

- 设计版本：`方案 Vn` / design.md 最后更新日期
- 资产版本：`assets Vn`
- 资产一致性检查：`pass` | `fail`
- 实现提交：`<git commit>`
- 运行环境：浏览器、版本、操作系统、设备模拟方式、测试数据/夹具版本、权限状态
- 验收日期：YYYY-MM-DD

## 验收矩阵

| 场景 / 状态 | 视口 | 测试数据 / 权限 | 原型图 | 实现截图 | 比较方法 | 对比结论 |
|---|---:|---|---|---|---|---|
| 桌面默认 | 1440 × 900 | `<fixture Vn> / 已授权` | ![桌面原型](prototypes/desktop-main.png) | ![桌面实现](verification/desktop-main.png) | 固定环境人工逐项比对：布局、间距、文字、颜色、图标、背景裁切 | `pass` / 偏差编号 |
| 移动默认 | 390 × 844 | `<fixture Vn> / 已授权` | ![移动原型](prototypes/mobile-main.png) | ![移动实现](verification/mobile-main.png) | 固定环境人工逐项比对：响应式、状态、资产与无障碍 | `pass` / 偏差编号 |

## 资产一致性

| 检查项 | 结果 | 证据 / 备注 |
|---|---|---|
| 资产清单版本与 design.md 一致 | `pass` / `fail` | `assets/manifest.md` |
| 冻结文件与运行时引用一致 | `pass` / `fail` | `<资产 ID / 路径或图标包版本>` |
| 图标尺寸、颜色、状态与无障碍名称一致 | `pass` / `fail` | |
| 背景图裁切、焦点、叠层与文字对比度一致 | `pass` / `fail` | |
| 无外链图片或未锁定版本的图标包 | `pass` / `fail` | |

## 偏差记录

- 是否存在偏差：`yes` | `no`

| 编号 | 级别（P0/P1/P2） | 状态（resolved/accepted/open） | 场景 | 原型表现 | 实际实现 | 原因 | 影响 | UI 确认人 | 设计版本 | 资产版本 |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |

- P0/P1 必须为 `resolved`；存在 P0/P1 或任意 `open` 偏差时，结论不得为 `pass`。
- P2 只有在影响已说明、状态为 `accepted` 且有具名 UI 确认人时，才可在 `pass` 结论中保留。

## 验收结论

- 结论：`pass` | `blocked` | `fail`
- 覆盖范围：所有 `design.md` 视口与状态矩阵中的场景，使用同一测试数据/权限与资产版本。
- 未覆盖项与剩余风险：
- QA：
