# Exec Plan: Loop Engineering 模板补强

- 状态：`planning`
- 方案版本：`V1`
- 设计交付：`not-applicable`

## 目标

把当前“控制面较完整、执行面不足”的模板补强为可真实运行的 L1 Loop，并让 L2 提案链具备可验证、并发安全的门禁。

## 范围

1. 修复 Cursor Hook 协议、干净安装状态、配置执行一致性、预算和原子 lease。
2. 实现 pattern runner，打通 harness-health 与 daily-triage 的真实 L1 闭环。
3. 重构 L2 前置/后置 gate、检查 receipt、独立 verifier 和恢复清理。
4. 让 Golden 清单驱动真实执行，并按 pattern 报告观测成熟度。
5. 补齐 Loop 路由入口、registry 元数据和运维文档。

## 非目标

- 不实现 L3、自动 push/merge 或 autoMergeAllowlist。
- 不复制参考仓的 npm 发布矩阵、网站、starter 全矩阵、swarm 或营销资产。
- 不以新增 pattern 数量替代现有三个纵向场景的真实闭环。

## 验收标准

- Harness/Loop 全量测试和 manifest-driven Golden cases 通过。
- 新安装目标仓从 observed L0 开始，真实 L1 run 后才晋级。
- 同 slot 并发 prepare 只有一个 owner；重叠路径锁不能双持有。
- daily-triage 可生成、去重、更新和清理持久化分诊项。
- L2 proposal 绑定批准 task、worktree、锁、真实 check receipt 和独立 verifier。
- push/merge 始终被拒绝。
