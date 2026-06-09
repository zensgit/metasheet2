# Multitable Automation A6 — Convergence Engine Execution Plan (2026-06-01)

> Type: **execution plan** (per-rung implementation detail), NOT a status tracker and
> NOT a schedule.
>
> **Status source-of-truth** is the checklist in
> `multitable-automation-run-governance-todo-20260527.md` (the A6 items). Rationale /
> demand-gate ledger is `run-governance-forward-plan-20260528.md`. Rung decomposition +
> per-rung test surface is `multitable-automation-a6-convergence-scout-20260529.md`
> (A6-0). Runtime detail for the landed first slice is
> `multitable-automation-a6-1-workflowjob-runtime-scout-20260530.md` +
> `…-verification-20260530.md` (#2130).
>
> This document adds ONLY execution detail and points back at those for status and
> rationale. Do not duplicate rung status here — update the TODO checklist instead.

## 0. Depth calibration (why this plan is deep in one place and shallow elsewhere)

The remaining ladder splits cleanly into two kinds of work, and they get different
treatment **on purpose**:

- **A6-1 enable-writer was the deep-planned slice because it only exposed capability
  that already existed.** That path is now complete end-to-end (#2130 runtime + #2191
  enable-writer + #2193 admin UI toggle). The deep section below is retained as the
  historical implementation plan and acceptance record, not as remaining work.
- **A6-2 has also landed end-to-end** (#2236 design-lock + #2237 backend + #2245
  frontend + #2257 UAT). Delay/timer resume remains separate because it forces durable
  scheduler/worker/leader semantics.
- **A6-3 … A6-5 ADD capability** (branch/parallel graph execution, modeling import,
  approval coupling). Their *shape* is undefined until a concrete use-case names it.
  A6-3's first runtime slice (A6-3-1 `condition_branch` / exclusive branch v1) **landed via #2321**;
  the A6-3-2 frontend/readability slice **landed via #2339 + #2348**; parallel/join +
  A6-3-3 stay deferred. A6-4/A6-5 remain plan-level only:
  scope boundary, dependency order, gate posture, and a pointer to the test surface the
  A6-0 scout already enumerated.

Dependency order is fixed (each rung is the next one's floor):
**A6-1 enable-writer → A6-2 suspend/resume → A6-3 branch/parallel DAG → A6-4 BPMN
compile/preview adapter → A6-5 approval-as-job.**

---

## 1. A6-1 enable-writer — BUILD-READY (deep; serves as its §7 scout)

**Goal:** let an automation rule opt into the already-landed persistent WorkflowJob
runtime through the normal create/update API (and, optionally, a minimal admin toggle),
so #2130 stops being dead code in production. No new runtime behavior — purely the
on-switch for behavior that already ships.

### 1.1 Reuse (verified on `origin/main` @ ea7938930 — no migration needed)

| Piece | Location | State |
|---|---|---|
| `execution_mode` column | migration `zzzz20260530120000_create_automation_jobs_and_execution_mode.ts` | present |
| DB row type | `db/types.ts:1247` (`execution_mode: string \| null`) | present |
| Domain field | `automation-service.ts:136` (`AutomationRule.execution_mode`) | present |
| DB→executor map | `automation-service.ts:218` (`toExecutorRule` → `executionMode`) | present |
| Runtime gate | `automation-service.ts:688` (`persistJobs = rule.executionMode === 'workflow_job_v1'`) | present |
| Job persistence | `AutomationJobService` + `multitable_automation_jobs` | present (#2130) |

So the runtime path DB→domain→executor→jobs is complete and tested. The on-switch is the
only missing link.

### 1.2 The gap (what is genuinely not done)

- `CreateRuleInput` / `UpdateRuleInput` (`automation-service.ts:168–190`) have **no**
  `executionMode` field.
- `createRule()` (`:351`) INSERT and `updateRule()` (`:455`) UPDATE do **not** write the
  `execution_mode` column.
- The rule create/update routes in `routes/univer-meta.ts` (which call
  `automationService.createRule` / `updateRule`) do **not** parse `execution_mode` from
  the request body.
- No UI affordance to set it.

### 1.3 Minimal change set

1. Add `executionMode?: string | null` to `CreateRuleInput` and `UpdateRuleInput`.
2. **Enum-strict validation in the service** (single source): accept only `'legacy'` and
   `'workflow_job_v1'`; an unrecognized value is **rejected** (caller surfaces 400), never
   silently coerced to a default. (Silent fallback to default is a contract bug — the
   exact class caught after the #1774 review and fixed in #1776.)
3. `createRule` INSERT writes `execution_mode`; `updateRule` UPDATE writes it when the
   field is present (absent = unchanged; explicit `null`/`'legacy'` = off).
4. `routes/univer-meta.ts` create/update handlers read `execution_mode` (or
   `executionMode`) off the body into the input.
5. Expose `execution_mode` on the rule GET/read response so a toggle can reflect current
   state (confirm it is not already projected away by a whitelist — see 1.5).
6. **UI: API-first.** A minimal admin toggle in the rule editor can ship in the same PR or
   as a thin follow slice; the backend on-switch is the load-bearing part.
7. **OpenAPI:** automation rules are not in the multitable OpenAPI parity surface
   (grep-empty in `packages/openapi/`). Confirm in impl; if they are spec'd, add
   `execution_mode` to the request/response schema and keep
   `verify:multitable-openapi:parity` green. If not, no spec delta.

### 1.4 Test surface

- **Unit:** `createRule` persists `execution_mode`; `updateRule` toggles it on/off; an
  unset rule stores `null` (→ no jobs); an **invalid** `execution_mode` value is rejected,
  not defaulted.
- **Integration / real wire (mandatory — wire-vs-fixture drift guard):** create a rule
  with `executionMode: 'workflow_job_v1'` through the **real HTTP app**, then trigger it
  and assert job rows are persisted; create a legacy/unset rule and assert **no** job rows
  and the unchanged execution/log shape. A unit test against a hand-built input does not
  prove the field survives route parsing → service INSERT → DB → `toExecutorRule` → the
  `persistJobs` gate. Any field added to an object serialized via field-by-field copying /
  whitelist / `pick` / `select` projection MUST be asserted to round-trip through the real
  wire.

### 1.5 Risks

- **Whitelist/projection drop:** if the rule INSERT/UPDATE or the read response builds
  columns explicitly, `execution_mode` can be silently dropped while unit tests pass. The
  1.4 wire test is the guard.
- **Accidental default-on:** the default for unset MUST remain `legacy` (no jobs).
  Existing fire-and-forget rules must be provably unaffected.

### 1.6 Gate posture & acceptance

- **Gate:** lowest on the ladder. Demand = owner asking to advance + an already-built
  runtime on-switch that was otherwise dead code. No third-party use-case required to
  finish wiring something already shipped.
- **Acceptance:** an opted-in rule persists jobs end-to-end through the real wire; a
  non-opted rule is byte-for-byte unchanged; invalid mode rejected; governance (A1
  redaction, A2 read boundary, fail-closed) inherited unchanged.

### 1.7 Open decisions for the impl PR body

1. UI toggle in the same PR, or API-first with a follow slice?
2. Read response exposes `execution_mode` (needed for a stateful toggle) — confirm shape
   impact on A2/A3.
3. Update semantics for an absent field: leave unchanged (recommended) vs reset to legacy.

---

## 2. A6-2 suspend/resume — ✅ LANDED (#2236 design-lock + #2237 impl + #2245 frontend + #2257 UAT)

> **✅ LANDED 2026-06-03 — PR #2237 (squash `c363a78db`); design-lock #2236.** Admin-gated v1, webhook-
> first (delay/timer + worker/claim still deferred/red-lined). As-built detail + the 2 review rounds live
> in `multitable-automation-a6-2-suspend-resume-{design,verification}-20260603.md` — **not re-derived
> here**. A6-2b frontend (admin Resume UI + `wait_for_callback` editor) **landed 2026-06-04 — PR #2245
> (squash `cee99c8e4`)**, frontend-only/no contract change. Operator UAT **PASS #2257** on the refreshed
> package from `b37ff906` after #2264/#2272/#2278 cleared the save, follow-up-shape, and `lock_record`
> footgun blockers. Original plan retained below for the record.

- **Adds:** the `suspended` C1 status, a resume token, and an **external-event/webhook
  resume endpoint first**; delay/timer resume (and the durable scheduler + worker/claim
  semantics it forces) come later, as a sub-step.
- **Must not (this rung):** no delay/timer or worker in the first slice; no branch/parallel;
  no approval bridge.
- **Depends on:** A6-1 live (a persisted job to suspend).
- **Gate:** a named human-in-the-loop demand — e.g. a pipeline that must pause for an
  external callback before continuing. The use-case decides webhook-vs-timer shape, so the
  schema/token mechanics are **not** designed here.
- **Test surface:** see A6-0 scout "Required Test Surface → A6-2" (suspended-with-token,
  duplicate-resume idempotent/rejected, resume-after-completion rejected, invalid/expired
  token rejected without leak, later: survives process restart).

## 3. A6-3 branch/parallel DAG — A6-3-1 runtime + A6-3-2 frontend/readability ✅ LANDED (#2321/#2339/#2348); rest deferred

Design-lock: `multitable-automation-a6-3-branch-parallel-design-20260605.md`.

> **✅ A6-3-1 `condition_branch` / exclusive-branch v1 runtime LANDED 2026-06-05 — PR #2321 (squash
> `127b29dd9`)**, owner-opted on its named trigger ("同一规则按条件走不同动作链"). Backend only: new
> `condition_branch` action + CHECK migration; **dual-layer fail-closed** (service
> `validateConditionBranchConfig` + executor) rejecting `wait_for_callback` and nested `condition_branch`
> inside branches; **exclusive** first-match-or-`defaultBranch` selection; **C1 parent/selected-child/
> downstream lineage** reusing the existing job plane (no 2nd status vocab). The real-DB lineage seam gates
> in CI via the blocking `plugin-tests.yml` targeted step (`multitable-automation-jobs.test.ts`, alongside
> automation-retry/suspend-resume).
>
> **✅ A6-3-2 frontend/readability LANDED 2026-06-06 — #2339 (squash `960ea9315`) + #2348 (squash
> `4b44f25c6`)**: the rule editor can author a minimal `condition_branch` config (flat branch
> conditions, `update_record` / `send_notification` branch action subset, default branch, read-only
> never-flatten guard for richer loaded shapes, `workflow_job_v1` auto-lock), and the admin runs detail
> shows selected branch `label (key)` plus branch child jobs. **Still deferred, each its own opt-in:**
> A6-3-3 `wait_for_callback` / nested-`condition_branch` inside branches; A6-3 parallel fan-out /
> join-all / join-any. Design-lock detail below retained for the record.

The design-lock pins the first runtime slice as **A6-3-1 `condition_branch` /
exclusive branch v1**, not full parallel DAG. Parallel fan-out, join-all, and
join-any stay separate follow rungs.

- **Adds:** graph fields (upstream/downstream edges, branch discriminator, join mode,
  branch result aggregation) and generalizes the linear executor into a DAG. This is the
  **largest single engine change** on the ladder.
- **Must not (this rung):** no BPMN import; no approval coupling.
- **Depends on:** A6-2 (job persistence + resume stable before fan-out/join).
- **Gate:** a named per-record branch/parallel demand with audit.
- **Test surface:** see A6-0 scout "→ A6-3" (branch picks exactly one, parallel fan-out
  independent, join-all waits, join-any cancels with explicit audit, branch failures
  isolated).

## 4. A6-4 BPMN compile/preview adapter — PLAN-LEVEL (design deferred to its scout)

- **Adds:** parse a constrained BPMN subset, compile-**preview** into automation/approval
  definitions, and return a gap report for unsupported nodes.
- **Must not — permanent positioning:** never execute BPMN, never a second status model,
  never a separate audit/log store, no side-effecting preview. BPMN is a modeling/preview
  input, never a fourth runtime.
- **Depends on:** A6-3 (gateways map onto branch/parallel; without it, gateways can only be
  reported as unsupported).
- **Gate:** a named modeling/preview demand.
- **Test surface:** see A6-0 scout "→ A6-4" (preview side-effect-free, deterministic gap
  report, gateway mappings backed by A6-3 tests, no live BPMN route).

## 5. A6-5 approval-as-job — PLAN-LEVEL (double-gated; last; design deferred)

- **Adds:** an automation job that starts an approval instance and resumes after the
  approval completes; approve/reject/return/cancel map to C1 statuses explicitly.
- **Must not:** fold approval state into automation tables; pull in approval trigger
  bindings or result backwrite implicitly. Approval remains source-of-truth for graphs,
  assignments, permissions, and version freezing; automation stores only the waiting job
  and resume linkage. The **approval-completion event contract lands first**, before any
  bridge.
- **Depends on:** A6-2 (suspend/resume) and the completion-event contract.
- **Gate:** **double-gated** — highest value + highest risk; explicitly last.
- **Test surface:** see A6-0 scout "→ A6-5" (start_approval creates suspended job + one
  instance, status mapping unambiguous, version-freezing stays with approval, completion
  resumes exactly one job, missing/deleted instance fails closed).

---

## 6. Execution discipline (every rung)

1. **One rung per explicit opt-in.** A rung landing does not auto-start the next. For
   A6-2+, the opt-in must NAME which rung and why A5/A3 cannot solve it (the A6-0 scout's
   "continue automation is not enough" rule).
2. **§7 standard entry:** fresh worktree off `origin/main` → scout reads real code and
   answers reuse / minimal-change / tests → design-review → owner confirms → gated impl PR
   (just-in-time rebase, CI green, admin-squash). A6-1 enable-writer's scout is §1 above.
3. **Governance inheritance (hard contract):** every rung reuses this line's
   run/job/status/provenance/redaction substrate (C1 statuses + `normalizeWorkflowJob`,
   A1 redaction, A2 read boundary). No second-class observability plane.
4. **Merge discipline:** runtime PRs hold for explicit owner approval, not CI-green alone;
   feature PRs that are BEHIND rebase → wait CI green → admin-squash.

## 7. Acceptance for this plan doc

- Docs-only.
- References the TODO checklist for status (does not re-derive or duplicate it) and the
  A6-0/A6-1 scouts for test surface and runtime rationale.
- A6-1 enable-writer **landed** (#2130/#2191/#2193) and A6-2 suspend/resume **landed**
  2026-06-03 (#2236 design-lock + #2237 impl, admin-gated v1); A6-3 … A6-5 remain
  design-deferred and demand-gated, with no schema/mechanics designed here.
