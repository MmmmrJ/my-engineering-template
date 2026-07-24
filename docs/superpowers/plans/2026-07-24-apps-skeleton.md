# 空 Apps 骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 harness 上搭建可安装、可类型检查、可测试的空业务骨架（`apps/frontend` + `apps/backend` + `packages/contracts`），并接通 `project-checks.env` 与架构边界文档，使「在此模版上开发业务」有明确落点。

**Architecture:** npm workspaces monorepo。共享契约在 `packages/contracts`；`apps/backend`（Fastify）与 `apps/frontend`（React + Vite）只依赖 contracts，互不直接引用。不实现业务功能，只提供健康检查 / 占位页与最小测试。

**Tech Stack:** Node.js 24 LTS、TypeScript、npm workspaces、Vitest、Fastify、React 19 + Vite。不引入数据库、鉴权、UI 组件库。

## Global Constraints

- 不改动 `team-orchestrator` 确认门禁语义与五角色边界。
- 骨架必须「空」：无业务领域模型、无真实 CRUD、无行情/交易等残留概念。
- `apps/frontend` 不得 import `apps/backend` 源码；`packages/contracts` 不得依赖 apps。
- 目录命名固定：后端 `apps/backend`，前端 `apps/frontend`（不用 `api` / `web`）。
- 根目录提供统一脚本：`typecheck` / `test` / `build` / `dev`。
- 接通 `scripts/project-checks.env.example`（模版提交已填好的 `project-checks.env` 便于开箱）。
- 本轮不做 CI、MCP、数据库迁移。

---

## 目标结构

```text
/
├── package.json                 # workspaces + scripts
├── package-lock.json
├── tsconfig.base.json
├── apps/
│   ├── backend/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts         # 启动入口
│   │   │   ├── app.ts           # Fastify 工厂
│   │   │   └── routes/health.ts # GET /health
│   │   └── src/app.test.ts      # 最小集成测试
│   └── frontend/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx            # 占位页：品牌名 + 健康状态拉取说明
│       │   └── App.test.tsx
│       └── public/
└── packages/
    └── contracts/
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.ts           # 导出 HealthResponse 等
            └── health.ts
```

依赖方向：

```text
apps/frontend ──► packages/contracts ◄── apps/backend
```

---

## Task 1: 根 workspaces 与 TS 基座

**Files:**
- Create: `package.json`、`tsconfig.base.json`
- Modify: `.gitignore`（如需 `*.tsbuildinfo`）、`.env.example`（`API_PORT`、`VITE_API_BASE_URL`）
- Modify: `README.md`（增加「业务骨架」小节）

- [ ] **Step 1:** 写根 `package.json`：`workspaces: ["apps/*", "packages/*"]`，scripts：
  - `dev` / `dev:backend` / `dev:frontend`
  - `typecheck`、`test`、`build`
- [ ] **Step 2:** 写 `tsconfig.base.json`（strict、ES2022、module nodenext/bundler 分层由子包覆盖）
- [ ] **Step 3:** `.env.example` 增加 `API_PORT=3001`、`VITE_API_BASE_URL=http://127.0.0.1:3001`
- [ ] **Step 4:** README 补充骨架目录、启动命令、与 harness 的关系

---

## Task 2: `packages/contracts` 空契约包

**Files:**
- Create: `packages/contracts/package.json`（name: `@harness/contracts`）
- Create: `packages/contracts/tsconfig.json`、`src/health.ts`、`src/index.ts`

- [ ] **Step 1:** 定义 `HealthResponse`：`{ status: "ok"; service: string; time: string }`
- [ ] **Step 2:** 导出类型；包 `exports` 指向 `src/index.ts`
- [ ] **Step 3:** 确认无对 apps 的依赖

**选定实现：** 契约包只导出类型与常量；runtime 由 backend/frontend 各自编译。`package.json` 使用 `"type": "module"` + `exports` 到 `./src/index.ts`，通过 workspace 协议 `"@harness/contracts": "*"` 引用。

---

## Task 3: `apps/backend` 空 Fastify 服务

**Files:**
- Create: `apps/backend/package.json`、`tsconfig.json`、`src/app.ts`、`src/index.ts`、`src/routes/health.ts`、`src/app.test.ts`

- [ ] **Step 1:** Fastify app 工厂注册 `GET /health`，响应符合 `HealthResponse`
- [ ] **Step 2:** `index.ts` 监听 `API_PORT`（默认 3001）
- [ ] **Step 3:** Vitest 测 `/health` 返回 200 + schema 形状
- [ ] **Step 4:** CORS 允许本地 Vite 源（`http://127.0.0.1:5173`）

---

## Task 4: `apps/frontend` 空 React + Vite 页

**Files:**
- Create: `apps/frontend/package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`src/main.tsx`、`src/App.tsx`、`src/App.test.tsx`

- [ ] **Step 1:** 占位页：标题「Harness App」、一行说明「在此替换为业务 UI」
- [ ] **Step 2:** 按钮「检查 API」调用 `${VITE_API_BASE_URL}/health` 并展示结果（冒烟用，不算业务功能）
- [ ] **Step 3:** Vitest + Testing Library 测标题渲染
- [ ] **Step 4:** 确认无直接 import `apps/backend`

---

## Task 5: 接通 harness 检查与架构文档

**Files:**
- Modify: `scripts/project-checks.env.example`
- Create: `scripts/project-checks.env`（模版默认提交已填值）
- Modify: `docs/ARCHITECTURE.md`
- Modify: `AGENTS.md` 命令占位
- **选定：** `install-harness.sh` 不复制 apps；apps 随整仓 clone

- [ ] **Step 1:** `project-checks.env.example` 填入：
  ```bash
  TYPECHECK_CMD="npm run typecheck"
  TEST_CMD="npm run test"
  LINT_CMD=
  PRECOMMIT_CMD="npm run typecheck"
  ```
- [ ] **Step 2:** 复制为 `scripts/project-checks.env`
- [ ] **Step 3:** `ARCHITECTURE.md` 启用：
  ```text
  apps/frontend/** must-not-import apps/backend/**
  packages/contracts/** must-not-import apps/**
  ```
- [ ] **Step 4:** 更新 README「5 分钟启用」：加上 `npm install`、`npm run dev`

---

## Task 6: 安装依赖与终验

- [ ] **Step 1:** `npm install`（Node 24）
- [ ] **Step 2:** `npm run typecheck` 通过
- [ ] **Step 3:** `npm run test` 通过（backend + frontend）
- [ ] **Step 4:** `npm run build` 通过
- [ ] **Step 5:** `./scripts/verify.sh` 与 `./scripts/doctor.sh` 通过
- [ ] **Step 6:** `./scripts/check-boundaries.sh` 无违规时 PASS；故意在 frontend 加对 backend 的 import 应失败（抽查后还原）

---

## 明确不做

- 数据库、ORM、鉴权、Docker Compose
- UI 设计系统 / 路由业务页
- GitHub Actions（可后续单独立项）
- 把 apps 打进 `install-harness.sh`

---

## 验收标准

1. `npm run typecheck && npm run test && npm run build` 全绿  
2. `GET /health` 与占位页可本地 `npm run dev` 联调  
3. `scripts/project-checks.env` 接通后 `./scripts/verify.sh` PASS  
4. 边界规则已写入并生效（`frontend` ↛ `backend`）  
5. 无业务领域代码；目录名为 `apps/backend` 与 `apps/frontend`  

## 实施顺序

`Task 1 → 2 → 3 → 4 → 5 → 6`
