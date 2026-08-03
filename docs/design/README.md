# 设计交付物

凡是新增或改变页面、用户流程、交互、响应式布局或视觉设计的功能，都必须在方案阶段创建 `docs/design/<feature>/`。该目录中的 `design.md`、本地原型图和资产清单共同构成实施契约；外部 Figma、图片服务或插件链接只能作为补充，不能替代本地交付物。

```text
docs/design/<feature>/
├── design.md
├── prototypes/
│   ├── desktop-main.png
│   └── mobile-main.png
├── assets/
│   ├── manifest.md
│   ├── icons/
│   └── backgrounds/
├── verification.md
└── verification/
    ├── desktop-main.png
    └── mobile-main.png
```

从 [design 模板](templates/design.md)、[资产清单模板](templates/assets/manifest.md) 与 [视觉验收模板](templates/verification.md) 复制开始。`prototypes/` 和 `verification/` 中的图片必须为仓库本地 PNG、WebP、JPG、JPEG 或 SVG；每张原型图必须在 `design.md` 的“视口与状态矩阵”中引用。

`assets/manifest.md` 是图标、背景图、插画、纹理和照片的冻结清单。它记录来源/许可、冻结文件、运行时路径或图标包、视觉实现规则与替代方案。运行时不得依赖未锁定版本的外部图标或图片链接。

在用户明确确认当前方案版本前，设计和资产处于 `draft`；确认后必须一并标为 `frozen`。替换资产、变更裁切方式、图标库版本或重要视觉样式时，须更新资产版本；若影响确认过的视觉、交互或验收标准，也须更新方案版本并重新审核。

完成设计规格后运行：

```text
node scripts/harness/cli.mjs validate-design docs/design/<feature>
```

Feature Spec 的“设计交付”标记为 `required` 时，`validate-spec` 会继续校验此目录。前端必须以已确认并冻结的设计为实现基线；不得自行补猜视觉、交互或资产。

实现完成后，QA 使用设计矩阵中相同的固定视口、浏览器环境、状态、测试数据/权限和资产版本采集真实页面截图，保存到 `verification/`。在 `verification.md` 中逐项映射原型图与实现截图，记录比较方法、资产一致性、偏差等级/状态和 UI 确认人。最终运行：

```text
node scripts/harness/cli.mjs validate-visual docs/design/<feature>
```

只有验收结论为 `pass`、所有原型场景都有实现截图、资产一致性为 `pass`，且偏差已按 P0/P1/P2 门禁处理后，UI 验收才能通过。完整工作流见 [使用 Codex Product Design 生成原型并保持实现一致的方法](使用Codex%20Product%20Design生成原型并保持实现一致的方法.md)。
