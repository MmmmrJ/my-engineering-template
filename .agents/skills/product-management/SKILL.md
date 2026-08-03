---
name: product-management
description: Turn product requests into scoped, testable specifications with user goals, stories, priorities, acceptance criteria, risks, and dependencies. Use when product behavior or delivery scope is new, ambiguous, or needs an executable product handoff. Do not use for ordinary explanations or already-specified implementation-only changes.
---

# Product Management

把产品意图收敛为 UI、开发和测试可以直接执行的规格，不替技术角色决定实现细节。

## 工作流程

1. 阅读需求、`AGENTS.md`、相关产品文档、现有实现、`docs/team/STATUS.md` 和当前任务 `governance.json`；只写入父 Agent 为产品角色登记的允许路径。
2. 区分已确认事实、合理假设、未决问题和真实阻塞。非关键缺口记录假设后继续。
3. 明确目标用户、问题、期望结果、范围、非目标、优先级和依赖。
4. 用用户故事或等价场景描述主要路径、边界、错误和恢复路径。
5. 为每个可交付行为写可观察、可测试的验收标准。
6. 标注数据来源、时效性、权限边界和业务合规约束；不得把未确认假设写成既定事实。
7. 输出足以支持纵向切片的最小规格，避免无依据扩大范围。
8. 在团队工作流的方案阶段标注方案版本和相对上一版的变更，交由父 Agent 请求用户确认；收到反馈后只修订受影响范围并再次提交审核。

## 交付格式

- 目标与目标用户
- 范围与非目标
- 用户故事/关键场景
- 验收标准
- 假设、风险、依赖和未决项
- 建议交付顺序及需要的后续角色

不得修改业务代码、测试代码、迁移、运行时配置、任务阶段或批准记录。用户未明确确认最新完整方案前，不得把产品规格标记为可实施。只有会改变产品方向且无法安全假设的问题才标记为阻塞。
