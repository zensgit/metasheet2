# Design Lock — B: Approval Analytics Dashboard (审批效率看板 completion)

Date: 2026-07-03
Branch: `claude/approval-B-analytics-dashboard-20260703`
Status: design-lock (implement to this doc)

## 1. Goal

Close the 钉钉/飞书 "审批效率看板" gap by surfacing the approval analytics the
backend **already computes** but the front-end does not yet render.

## 2. Grounding — what already exists (verified in this branch)

The task brief assumed the metrics endpoints might not be exposed and no
dashboard existed. Neither is true on `origin/main`:

- **Service** `ApprovalMetricsService` exposes `getMetricsSummary`,
  `getMetricsByDimension('requester'|'department')` (+ the
  `getMetricsByRequester` / `getMetricsByDepartment` wrappers),
  `getMetricsReport`, `getInstanceMetrics`, `listActiveBreaches`.
- **HTTP routes** (`packages/core-backend/src/routes/approval-metrics.ts`,
  mounted in `index.ts` via `app.use(approvalMetricsRouter())`) already expose:
  - `GET /api/approvals/metrics/summary`  — `approvals:admin`
  - `GET /api/approvals/metrics/report`   — `approvals:admin`
  - `GET /api/approvals/metrics/people`   — `approvals:analytics` (person ranking = more sensitive; migration `zzzz20260630090000` grants it to the global `admin` role only)
  - `GET /api/approvals/metrics/teams`    — `approvals:admin`
  - `GET /api/approvals/metrics/breaches` — `approvals:admin`
  - `GET /api/approvals/metrics/instances/:instanceId` — `approvals:read` (participant-or-admin ACL)
  - All of these are **already permission-tested** in
    `tests/unit/approval-metrics-router.test.ts` and service-level real-DB
    tested in `tests/integration/approval-metrics-people-teams.test.ts`.
- **Front-end** `apps/web/src/views/approval/ApprovalMetricsView.vue` is
  **already routed** at `/approvals/metrics` (`requiresAdmin`) and nav-linked in
  `App.vue` (`审批 SLA`). It already consumes summary + report/TopN + breaches.

### The single gap

`getMetricsByDimension` (per-**requester** and per-**department** aggregation)
is the ONLY thing the backend computes that the FE never surfaces. The
`/people` and `/teams` endpoints exist and are gated/tested; the FE has **no
consumer** for them (`apps/web/src/approvals/api.ts` has no
`fetchApprovalMetricsPeople` / `fetchApprovalMetricsTeams`).

## 3. Decision — extend, do not duplicate; no new endpoint

- **No new backend endpoint.** The task's "add ONE if not exposed" is already
  satisfied. Backend source is untouched.
- **Extend the existing `ApprovalMetricsView.vue`**, not a parallel
  `ApprovalAnalyticsView.vue` — a parallel view would duplicate the
  summary/report/breach wiring. This is the reuse-over-duplication call.

## 4. Scope — files changed

1. `apps/web/src/approvals/api.ts`
   - Add `ApprovalMetricsDimensionRow` type (mirrors backend `MetricsDimensionRow`:
     `key`, `name`, `total`, `approved`, `rejected`, `revoked`,
     `avgDurationSeconds`, `slaBreachRate`).
   - Add `fetchApprovalMetricsTeams(query)` → `GET /teams`.
   - Add `fetchApprovalMetricsPeople(query)` → `GET /people`.
   - Both follow the existing `fetchApprovalMetricsReport` fetcher pattern
     (since/until/limit → `URLSearchParams`, `USE_MOCK` branch, `apiGet`).
2. `apps/web/src/views/approval/ApprovalMetricsView.vue`
   - Two new **read-only** sections wired into the existing `loadAll` (so they
     respect the shared date-range picker):
     - **按部门汇总** (department / `/teams`, `approvals:admin` — same gate as the page).
     - **按发起人汇总** (requester / `/people`, `approvals:analytics`).
   - Columns: 部门/发起人, 总量, 通过, 驳回, 撤回, 平均耗时, SLA 超时率 (with an
     inline CSS bar). `MetricsDimensionRow` carries `slaBreachRate` but NOT raw
     breach/candidate counts — surface the **rate** via the existing
     `formatPercent`, consistent with the `byTemplate` table.
3. `apps/web/tests/approvalMetricsView.spec.ts` (new — first test for this view).

## 5. Explicit judgment calls (reviewer can redirect)

- **Chart library:** `echarts` IS a dependency (used only by
  `multitable/MetaChartRenderer.vue`). The metrics endpoints return **aggregates,
  not time-series**, so there is no "trend" to chart. Chosen: **inline CSS
  breach-rate bars** in the tables (unit-testable, no canvas, consistent with the
  existing table-based dashboard). If a chart is ever wanted, reuse the
  tree-shaken `echarts/core` + `echarts.use([...])` pattern — do NOT reuse
  multitable's `MetaChartRenderer` (would couple approval FE to multitable).
- **Node breakdown:** OUT OF SCOPE. There is **no aggregate** node-breakdown in
  the service — only per-instance `node_breakdown` (via the instance endpoint).
  Building a cross-instance node aggregate = inventing new metrics math, which
  the brief forbids. Not added.
- **People-section FE gate:** the page is `requiresAdmin` and
  `hasPermission('approvals:analytics')` short-circuits `true` for any admin, so
  the FE gate is effectively always-true for page-reachers — the **real** gate is
  the backend `rbacGuard('approvals:analytics')`. The FE gate + a graceful
  `catch` on a 403 are kept as **defense-in-depth**; the test mocks
  `hasPermission` to exercise BOTH branches.

## 6. Constraints honored

- Read-only (GET only; no mutations).
- No new dependency.
- Tenant-scoped (server resolves tenant from `req.user`).
- Admin/metrics-permission gated (department = `approvals:admin`, requester =
  `approvals:analytics`) — matches existing route gating.
- **i18n:** the approval module has NO i18n infra; strings are hardcoded 中文,
  which is consistent with the rest of the module (and the existing
  `ApprovalMetricsView.vue`). Noted, not "fixed".

## 7. Verification plan

- Backend `tsc --noEmit` → 0 (untouched; confirm no regression).
- Backend: **no new integration test** (task's real-DB test is conditional on
  adding an endpoint; none added). PROVE existing
  `approval-metrics-router.test.ts` + `approval-metrics-people-teams.test.ts`
  still green.
- FE `vue-tsc -b` → 0.
- FE new spec `approvalMetricsView.spec.ts` (RED-first): department + requester
  sections render from mocked fetchers; people section present + fetched when
  `hasPermission('approvals:analytics')` is true, absent + NOT fetched when
  false; read-only (only read fetchers invoked; refresh re-reads).
- Prove existing approval FE specs (center/detail/mobile) still green.
