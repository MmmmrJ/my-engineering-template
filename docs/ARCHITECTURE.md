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

未配置规则时 `scripts/check-boundaries.sh` 会跳过。业务落地后可启用：

```text
# FORBIDDEN_IMPORTS
# apps/frontend/** must-not-import apps/backend
# packages/contracts/** must-not-import apps/
```

## 验证命令

复制并填写 `scripts/project-checks.env`：

```bash
# TYPECHECK_CMD=
# TEST_CMD=
# LINT_CMD=
# PRECOMMIT_CMD=
```
