# 设计交付物

凡是新增或改变页面、用户流程、交互、响应式布局或视觉设计的功能，都必须在方案阶段创建 `docs/design/<feature>/`：

```text
docs/design/<feature>/
├── design.md
└── prototypes/
    ├── desktop-main.png
    └── mobile-main.png
├── verification.md
└── verification/
    ├── desktop-main.png
    └── mobile-main.png
```

原型图必须作为仓库中的本地 PNG、WebP、JPG、JPEG 或 SVG 文件保存。可额外记录 Figma 链接，但外部链接不能替代本地导出图。每张图必须在 `design.md` 的“原型图清单”中以 Markdown 图片引用。

从 [design 模板](templates/design.md) 复制开始。完成后运行：

```text
node scripts/harness/cli.mjs validate-design docs/design/<feature>
```

Feature Spec 的“设计交付”标记为 `required` 时，`validate-spec` 会继续校验此目录。前端必须以该设计为实现基线；QA 必须以原型图和 `design.md` 为 UI 验收基线。

实现完成后，QA 将固定视口、测试数据和浏览器环境下的真实页面截图保存到 `verification/`，并在 `verification.md` 中把每张原型图映射到实现截图、记录偏差及确认人。最终运行：

```text
node scripts/harness/cli.mjs validate-visual docs/design/<feature>
```

只有验收结论为 `pass`、所有原型场景都有实现截图且偏差已受控记录时，该命令才会通过。
