# 设计交付物

凡是新增或改变页面、用户流程、交互、响应式布局或视觉设计的功能，都必须在方案阶段创建 `docs/design/<feature>/`：

```text
docs/design/<feature>/
├── design.md
└── prototypes/
    ├── desktop-main.png
    └── mobile-main.png
```

原型图必须作为仓库中的本地 PNG、WebP、JPG、JPEG 或 SVG 文件保存。可额外记录 Figma 链接，但外部链接不能替代本地导出图。每张图必须在 `design.md` 的“原型图清单”中以 Markdown 图片引用。

从 [design 模板](templates/design.md) 复制开始。完成后运行：

```text
node scripts/harness/cli.mjs validate-design docs/design/<feature>
```

Feature Spec 的“设计交付”标记为 `required` 时，`validate-spec` 会继续校验此目录。前端必须以该设计为实现基线；QA 必须以原型图和 `design.md` 为 UI 验收基线。
