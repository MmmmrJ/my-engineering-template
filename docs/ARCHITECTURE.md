# 架构边界（业务仓填写）

默认空目录占位：

```text
apps/frontend/     # 前端
apps/backend/      # 后端
packages/contracts # 共享契约（可选）
```

建议依赖方向（实现业务后写入下方规则并启用检查）：

```text
apps/frontend ──► packages/contracts ◄── apps/backend
```

## 依赖方向（机械检查）

未配置规则时 `harness.config.json` 中的 `boundaries` 可为空。业务落地后可启用文本级边界检查：

```json
"boundaries": [
  { "from": "apps/frontend/**", "forbidden": "apps/backend" },
  { "from": "packages/contracts/**", "forbidden": "apps/" }
]
```

该基础检查按文本引用匹配；选定语言和构建工具后，应把对应的静态依赖分析命令加入 `commands`，不要将文本扫描误认为完整的模块图验证。

## 验证命令

复制 `harness.config.example.json` 为 `harness.config.json` 并填写：

```json
{
  "schemaVersion": 1,
  "projectChecksRequired": true,
  "commands": {
    "typecheck": [{ "program": "npm", "args": ["run", "typecheck"] }],
    "lint": [{ "program": "npm", "args": ["run", "lint"] }],
    "test": [{ "program": "npm", "args": ["run", "test"] }],
    "precommit": []
  },
  "boundaries": []
}
```
