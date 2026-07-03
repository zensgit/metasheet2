# Approval line completion — Tier-1 arc A→B→C · design & verification (2026-07-03)

> `/goal`: develop + complete this line, deliver a design & verification MD. The corrected 钉钉/飞书 benchmark
> (#3529) ranked the remaining buildable work as **Tier-1 A→B→C**, built here as three parallel
> design-lock-first slices. All three built, verified, and PR-for-review.

## The arc + outcomes

| # | Slice | PR | Honest as-built |
|---|---|---|---|
| **A** | T3-6 projection base visibility hardening (security prereq) | **#3537** | Full runtime — admin-only read guard at all **4** read chokes (incl. the collab/Yjs/api-token resolver, review P1), per-path RED-before. |
| **B** | Approval analytics dashboard (differentiation payoff) | **#3535** | **Reorient:** SLA dashboard + endpoints already shipped; B *completes* it (adds requester/department sections — the only unsurfaced metric). |
| **C** | Delegation UX enhancement | **#3536** | **Reorient:** 委托 runtime already shipped; C adds the genuine gaps (self-service + audit visibility), did not rebuild. |

Two of three revealed that much was already shipped (B: the dashboard; C: the delegation engine) — grounded
first, scoped down honestly, filled only the real gaps. A was the one substantive new runtime.

## A — projection visibility (the security lynchpin) · #3537
The projection base `base_apr_projection` (materialized approval outcomes) had no per-sheet share → any global
`multitable:read` holder could read it. **Owner-default: admin-only** (per-row `visibility_scope` inheritance =
a separate later slice).
- **Guard at 4 read chokes** (admins bypass): `resolveSheetCapabilities` (single sheet + record read),
  `filterReadableSheetRowsForAccess` (base list + 3 sheet lists → also hides the base itself),
  `resolveReadableSheetIds`, and — **review P1, initially missed** — `resolveSheetCapabilitiesForUser`
  (`sheet-capabilities.ts`), which fronts the **collab room / Yjs record / api-token** auth paths (NOT
  REST-only; my earlier "no callers" claim was wrong — the leak survived via collab/Yjs). Now gated + locked by
  a resolver unit test, RED-before confirmed.
- **Side-effect-free constant module** so the permission hot path references `APPROVAL_PROJECTION_BASE_ID`
  without importing the projection service's `eventBus`/scheduler surface.
- **Verify:** real-DB `approval-projection-visibility` **6/6** (non-admin denied single-read + listings; admin
  allowed; ordinary base unaffected); **RED-before** (neutralize lookup → 4 fail, leak returns); `tsc` 0;
  T3-6 write/reconcile 14/14; **full unit 4169/4169**.
  - **Post-review correction:** the guard's new resolver lookup also broke **integration** mock-pools (the
    same resolver-SQL drift class, one layer over — my initial "verified" claim covered unit but not the CI
    integration suite). Swept the projection-lookup handler into the **10** affected integration files → the
    full integration run has **zero** `base_id` projection errors. The 3 files with non-`base_id` residual
    failures (attachments / record-form / sheet-permissions) were proven **pre-existing** — they fail
    identically at true `origin/main` base locally and pass on main's green CI (local-env-only, not this PR).
    #3537 verification is therefore complete only once its CI is green post-sweep; this MD should land **after**
    #3537 is green (merge order below).

## B — analytics dashboard · #3535
Grounding showed `ApprovalMetricsView.vue` (`/approvals/metrics`, `requiresAdmin`) + `/summary /report /people
/teams /breaches /instances` already ship. The only computed-but-unsurfaced metric was `getMetricsByDimension`.
- Added **按部门汇总** (`/teams`, `approvals:admin`) + **按发起人汇总** (`/people`, `approvals:analytics`)
  read-only sections + SLA breach-rate bars, wired to the shared date range. FE-only; backend/routes/nav
  untouched (existed).
- **Verify:** `vue-tsc` 0 · new spec **5/5**, RED-first (4/4 failing pre-change) · metrics-router 9/9 ·
  people-teams 3/3 real-DB · existing FE 61/61.
- **Honest:** the deeper T3-6-read-model "reuse multitable" payoff (views/charts *on the projection base*) is
  NOT this — a separate larger slice, and now gated behind A's admin-only scoping.

## C — delegation self-service + audit · #3536
The 委托 runtime is shipped (resolve-time frozen map + admin CRUD + guards). C adds the UX/governance gaps:
- **Self-service:** participant-gated `/api/approval-delegations/mine` — create **forces `delegator = actor`**
  (structural), disable is **403-not-404** on another's row; `MyDelegationView` at `/my-delegation`.
- **Audit:** `includeInactive` history + a per-delegator `routedApprovalCount` from the real `delegatedFrom`
  trail (efficiency-review fix: computed only in audit mode).
- Boundaries (self/overlap/chain) already guarded — documented, not rebuilt.
- **Verify:** real-DB self-service **5/5** (incl. forced-delegator + 403) · api **5/5** · unit 22 · regression
  118 · FE 20 · tsc/vue-tsc 0 · RED-before proven.

## Line-complete statement
With A/B/C the Tier-1 arc closes: the projection read-model is **scoped** (A), its aggregate analytics are
**usable + complete** (B), and delegation is **self-service + auditable** (C). Every approval/automation-line
item now has its runtime built and on-main or in-review. What remains is **Tier-2/3 — each its own future
ballot/design-lock**, not undone code on this arc:
- Form rich-controls / print templates / associated-approval / mobile form-fill (明细子表 already shipped).
- Mobile push / native (needs a Notification Hub).
- T3-3 signature **enforcement** (the declared-inert floor is shipped).
- The deeper T3-6 multitable-native reporting layer (views/charts on the now-scoped projection base).
- Connector breadth (or lean on the data-factory/ERP track's depth instead).

## Reviewer-decisions carried (flagged, not blockers)
- **A:** admin-only is the shipped default; per-row `visibility_scope` inheritance is the follow-up depth choice.
- **B:** the `approvals:analytics` FE gate is defense-in-depth (page is `requiresAdmin`); the real gate is the
  backend `rbacGuard`.
- **C:** `/mine` gate = `approvals:read` (participant floor) + self-ownership; routed attribution is
  per-delegator, not per-window.
