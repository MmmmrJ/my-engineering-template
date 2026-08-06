# Exec Plan: 修复 Loop metrics --days 解析与窗口

- 状态：`awaiting_approval`
- 方案版本：`V1`

## 目标

修复已冻结公共接口 `harness loop metrics [<id>] [--days N] [--json]`：省略 Loop ID 时 `--days` 的参数值不得被误判为 ID，并按指定天数统计运行窗口。

## 范围

- 修复 `scripts/harness/lib/loop/runtime.mjs` 的参数解析与 metrics 时间窗口。
- 增加 CLI 黑盒回归，覆盖无 ID、指定 ID、无效天数和窗口过滤。

## 非目标

- 不改变 run log schema、预算、gate、L1/L2 策略或指标字段。
