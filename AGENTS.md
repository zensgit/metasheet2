# Repository Guidelines

## Project Structure & Module Organization
- PNPM workspace: root `package.json` + `pnpm-workspace.yaml` manage all packages.
- Frontend lives in `apps/web` (Vue 3 + Vite + Pinia); app entry at `src/main.ts`, routed views in `src/views`, shared utilities in `src/utils`, and UI/unit specs in `tests`.
- Backend core is `packages/core-backend` (Express + PostgreSQL + Redis). Runtime code under `src`, plugin hosts in `plugins`, DB migrations in `migrations`, and Vitest suites in `tests/{unit,integration}`.
- API contracts and generated SDKs sit in `packages/openapi`; sample/experimental plugins are under top-level `plugins/`.
- Ops assets: `docker/` for compose files, `scripts/` for automation (Phase 5 validation, staging checks), and `docs/`/`claudedocs/` for deep-dives and reports.

## Build, Test, and Development Commands
- Install deps: `pnpm install`.
- Frontend dev server: `pnpm dev` (serves `apps/web` on port 8899).
- Backend dev: `pnpm --filter @metasheet/core-backend dev` (API/WebSocket on port 8900); run migrations with `pnpm --filter @metasheet/core-backend migrate`.
- Build all packages: `pnpm build`; backend-only: `pnpm --filter @metasheet/core-backend build`; frontend-only: `pnpm --filter @metasheet/web build`.
- Tests: workspace-wide `pnpm test`; targeted backend suites with `pnpm --filter @metasheet/core-backend test:unit` or `test:integration`; frontend specs via `pnpm --filter @metasheet/web exec vitest run --watch=false`.
- Quality gates: `pnpm lint` and `pnpm type-check`; use `pnpm validate:all` before PRs.

## Coding Style & Naming Conventions
- TypeScript-first; prefer type-only imports (ESLint enforced) and avoid `any` unless documented. Prefix intentionally unused params with `_`.
- Formatting: 2-space indent, single quotes, trailing commas per existing code; keep modules ESM (`type: "module"`).
- Backend: routes in `src/routes` use kebab-case file names; services/classes are PascalCase; migration files are sequentially numbered to avoid collisions.
- Frontend: components PascalCase in `src/components`/`src/views`; composables `useX` in `src/composables`; store modules in `src/stores` with camelCase keys.

## Testing Guidelines
- Vitest is the shared runner. Backend configs live in `packages/core-backend/vitest*.config.ts`; integration tests spin up the Express app—mock external services instead of hitting real infra.
- Frontend tests run in `jsdom` (see `apps/web/vite.config.ts`); prefer `.spec.ts` naming there and `.test.ts` under backend `tests`.
- Target coverage ≥80% lines/functions as outlined in `packages/core-backend/tests/README.md`; add focused tests for plugins, permissions, and data adapters when touching those areas.
- Keep fixtures in `tests/fixtures` or `tests/utils`; avoid writing to repo paths outside `artifacts/` or `tmp`.

## Commit & Pull Request Guidelines
- Follow conventional commit prefixes seen in history (e.g., `feat(data-adapters): ...`, `perf(phase11): ...`, `chore(deps): ...`, `docs: ...`); include a scope when possible.
- PRs should state what changed, why, and how to verify (commands run, coverage snippets). Link relevant issues or Phase docs; attach UI screenshots/GIFs for frontend changes and note migration/rollback steps for backend DB updates.
- In PR bodies, avoid bare GitHub closing keywords such as `closes #NNN` or `fixes #NNN` for issues that must outlive the PR, including umbrellas and staged follow-ups. Break keyword adjacency instead, such as `close umbrella #NNN` or `#NNN is then closed`; #3317 was accidentally auto-closed by #3491 this way and reopened on 2026-07-02.
- Keep branches small and single-purpose; update checklists in `trigger-checks.md` when relevant.

## Security & Configuration Tips
- Start from `.env.example` (and `.env.phase5.template` for observability); never commit secrets or tokens. Required envs include DB/Redis URLs and observability endpoints like `METRICS_URL` and `ALERT_WEBHOOK_URL`.
- Use `docker/` compose setups for local DB/Redis if you need a clean environment; clean caches with `pnpm clean` when dependencies shift.
- Plugins run inside the microkernel—validate manifests via `pnpm validate:plugins` and keep untrusted plugin code sandboxed during development.

---

# AI 协作章程（Claude / Codex）— 2026-08

> 每个 AI 助手（Claude、Codex 及后续 AI 窗口）开工前应读本节。它把 2026-08 备料接管期间形成的共识固化下来，防止跨会话回到"只产文档、不产可用东西"的循环。

## 当前唯一优先级
**把某大客户的生产备料系统接管进 MetaSheet。** 所有开发以"这个客户能用 / 客户能看到"为验收，不以"平台通用性"为验收。通用平台能力（同步表 / 主数据 / 蓝图 / 外部数据原语）只在该客户后续提出需求（CRM / 派工 / 项目）时从真实需求抽取，不预先建设。HR / 项目 / CRM / 排产等其它方向：已封存（parked）。接管路线：演示（合成数据）→ 只读窗口授权 → 历史迁移与双轨对账 → 按项目号切换上线 → 后续需求按需扩展。

## 产出形态
- Claude 的产出 = PR（代码 / 迁移 / 可运行 Demo / ADR），不再产出无代码伴随的设计散文。
- 每个自然周至少一个"可演示或可合并"的增量；没有就停平台侧、回到备料业务线。
- 设计文档冻结在《业务应用平台化总体设计 v9.1》；不再产出 v10/v11。

## 双 AI 分工
- Claude 建，Codex 审；Codex 的介入面 = review 一个 PR 或一份 ADR，不 review 散文。
- 两轮无新事实即收敛，不再逐版互审。
- 双方下否定性结论（"系统没有 X"）前必须亲读代码并给 `path:line`。
- 基线纪律：任何 `path:line` 在冻结的目标 commit 上成立；main 前进后合并前 rebase 重跑。

## 决策机制（去仪式化）
- 默认前进 + 24h 异步否决：技术负责人（T）层 Ratify-now 决策按推荐值执行、记入 Decision Register 标 `Ratified-by-default-<date>`，owner 24h 内可否决。
- 仅 owner（O）层"先批后动"、不可默认前进：① 真实客户数据（真实 PLM/K3 读）；② 生产写入（写客户生产主表 / autopersist 常开）；③ 任何外部系统写回（K3 Save/Submit/Audit，永久禁止）；④ 花钱 / 对外发布 / 发送（部署、公开、发邮件、开对外 PR）。
- 保留资产：Decision Register 留痕、fail-closed 默认、values-free 证据、owner-bound 一次性执行。去掉的是仪式（逐条勾选会议、申请-等待）。

## 安全红线
- values-free：issue / PR / 证据面不含主机 / IP / 口令 / authorityCode / appKey / 凭据，只指位置。
- 一切外部写默认 OFF，exact-literal `'true'` 才开；新增 env flag 必须登记（`scripts/ops/global-history-flag-manifest`）。
- 客户现系统已知暴露（匿名可达 `/erp/*` K3 写、明文凭据）默认视为已泄露：接管即封端点 + 轮换 + 重置。

## 同时进行的线：最多两条
备料接管（Demo/迁移/上线）+ 平台 P0/P1 基础。多一条都砍。

*最后更新：2026-08-21（备料接管启动）。修改本节是 T 层决策，走"默认前进 + 异步否决"。*
