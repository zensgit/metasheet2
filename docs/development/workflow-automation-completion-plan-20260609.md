# Workflow & Automation Completion Plan

Date: 2026-06-09

Grounded on: `origin/main@741810a15`

Scope: MetaSheet2 workflow, approval, and multitable automation as one product
target. This is a completion definition and execution ledger, not a sprint
schedule.

## 0. Decision

We can make "workflow and workflow automation" the primary development goal,
but completion must mean a bounded v1 product loop:

1. **Multitable automation** is the execution substrate for record-triggered
   side effects, retry, job provenance, suspend/resume, and simple branches.
2. **Approval** remains the source of truth for approval templates, runtime
   graphs, assignments, permissions, and approval task state.
3. **Convergence** connects the two through explicit actions/events:
   `start_approval`, approval completion events, and result backwrite.
4. **Workflow Designer/BPMN** is a modeling and preview surface for this
   substrate. It must not become a fourth production runtime in v1.

This prevents the line from drifting into "build a generic BPMN platform" while
still letting users test real workflow automation.

## 1. Current Main State

### 1.1 Multitable automation

Current main already contains the governance and first convergence slices:

| Area | Current status |
|---|---|
| Run governance A0-A5 | Landed: execution snapshots, redaction, runs API, admin UI, whole-execution retry, response redaction hardening. |
| A6-1 WorkflowJob plane | Landed: `multitable_automation_jobs`, rule-level `execution_mode`, editor toggle, C1 job views. |
| A6-2 suspend/resume | Landed end-to-end: `wait_for_callback`, `multitable_automation_suspensions`, admin resume route, editor config, admin runs resume UI, UAT recorded. |
| A6-3-1 condition branch runtime | Landed: `condition_branch`, exclusive first-match/default branch, C1 parent/child/downstream lineage. |
| A6-3-2 frontend and runs readability | Landed in code: editor builder in `MetaAutomationRuleEditor.vue` and `conditionBranchAuthoring.ts`; runs readability in `AutomationExecutionsView.vue`. |
| A6-3-4 parallel join-all | Landed end-to-end: backend `parallel_branch` / `joinMode: all` runtime (#2496), editor authoring (#2500), and admin runs readability (#2501). |
| Still missing | A6-3-3 branch-local wait runtime/frontend, join-any/cancellation, live BPMN runtime, public webhook token emitter. (A6-3-3 now has a docs-only scope gate; A6-4c read-only Workflow Designer compile-preview UI landed #2604.) |

### 1.2 Approval

Current main already contains substantial approval product runtime:

| Area | Current status |
|---|---|
| Template CRUD / publish | Existing backend endpoints create, update, publish, clone, list, and detail templates. |
| Runtime graph freeze | `publishTemplate` builds and stores `approval_published_definitions.runtime_graph`. |
| Dynamic assignee resolver | `ApprovalAssigneeResolver` supports `static_user`, `static_role`, `requester`, and `form_field_user`. |
| Template authoring UI | Landed: `/approval-templates/new` and `/approval-templates/:id/edit`, fail-closed on unsupported rich graphs, preserves unsupported field metadata. |
| Real DB authoring UAT guard | Landed integration test for create -> publish -> start -> resolve on real DB. |
| Deployed/browser UAT | Passed: #2318 and #2371 accepted UI-created template -> publish -> `/approvals/new/:templateId` -> `form_field_user` resolution, plus unsupported-template read-only/save-disabled safety. |
| Completion event contract | Landed: #2413 locked the W5 scope; #2414 emits typed, redacted, idempotent approval terminal completion events after commit. |
| Still missing | Field-visibility authoring UI, richer template constructs, trigger bindings, result backwrite. |

### 1.3 Workflow Designer / BPMN

Workflow Designer has a BPMN draft/edit/deploy baseline and hub/catalog work,
but it is not yet the unified workflow automation authoring layer.

| Area | Current status |
|---|---|
| BPMN draft API | Existing draft save/load/update/deploy support. |
| Designer hub/catalog | Existing list/template/team-view/hub improvements. |
| Runtime positioning | Must stay modeling/preview first. v1 must not route production execution through a separate BPMN runtime. |
| Still missing | Live BPMN runtime (out of scope for v1). A6-4/W8 scope is locked in `multitable-automation-a6-4-bpmn-compile-preview-scope-gate-20260612.md`; A6-4a pure compiler landed in #2568, A6-4b read-only route in #2577, and the A6-4c read-only Workflow Designer compile-preview UI in #2604. Deterministic gap report, side-effect-free preview, and no-live-runtime guards still apply. |

## 2. Definition of Complete v1

The v1 target is complete when an admin can build, run, inspect, and safely
operate a practical business workflow using existing product surfaces:

1. **Authoring**
   - Approval templates can be created, edited, published, and used to start
     approvals.
   - Automation rules can express linear actions, wait/resume, and exclusive
     condition branches from the UI.
   - Unsupported richer shapes open read-only or fail closed; they are never
     silently flattened.

2. **Execution**
   - Automation rules may opt into the C1 WorkflowJob plane.
   - Per-action jobs persist with C1 status vocabulary and redacted outputs.
   - Whole-execution retry uses current rule credentials plus stored trigger
     event and requires explicit side-effect confirmation.
   - Suspend/resume is admin-gated v1; public webhook emitter is a separate
     later decision.

3. **Cross-surface business closure**
   - Automation can start an approval through an explicit `start_approval`
     action.
   - Approval completion emits an event contract consumed by automation.
   - Approval result backwrite into multitable records is explicit, auditable,
     and configured by mapping, not hidden side effects.

4. **Designer**
   - BPMN/workflow designer can compile-preview a constrained subset into the
     automation/approval substrate.
   - Unsupported BPMN nodes produce a gap report.
   - Preview is side-effect-free and never starts live BPMN execution.

5. **Operations**
   - Admin runs view shows run/job detail, selected branch, suspended state,
     retry provenance, and redacted snapshots.
   - Real-DB integration tests cover every new seam.
   - Operator UAT issues/runbooks exist for deployed-browser smoke where CI
     cannot prove routing/auth/UI integration.

## 3. Remaining Development Ledger

| ID | Work | Status | Completion acceptance |
|---|---|---|---|
| W0 | Re-ground status docs against current main | Landed #2411/#2412 | Existing TODOs no longer say A6-3-2 is not started after #2339/#2348. |
| W1 | Approval authoring deployed-browser smoke | Done | #2318 PASS accepted: UI-created template published, `/approvals/new/:templateId` started, submitted user field resolved to expected assignee, unsupported rich template was read-only/save-disabled. #2375/#2371 reconfirmed current deployment. |
| W2 | Automation A6-3-3 branch-local wait/nesting | Scope-gate added; runtime/frontend not started | `wait_for_callback` can live inside selected branch with stable nested step cursor, rule-drift guard, resume tests, and no silent flattening in editor. `multitable-automation-a6-3-3-branch-local-wait-scope-gate-20260615.md` pins the high-amount review scenario and the nested cursor shape; implementation remains split into backend runtime then frontend/readability. |
| W3-0 | Automation parallel fan-out + join-all scope-gate | Landed before W3-1 | `multitable-automation-a6-3-parallel-join-all-scope-gate-20260611.md` locks fan-out/fan-in C1 graph shape, `join_all` only, fail/skip semantics, redaction, and tests. |
| W3-1 | Automation parallel fan-out + join-all runtime | Landed #2496/#2500/#2501 | Parallel branches persist independent job lineage; join-all waits for all branches; failures and skipped branches are audited; editor and admin runs detail expose the constrained shape. |
| W4 | Automation join-any / cancellation semantics | Not started; demand-gated after W3 | First completed branch continues; ignored/cancelled siblings are explicit in C1 jobs and audit. |
| W5-0 | Approval completion event contract scope-gate | Landed #2413 | Defines terminal approval event taxonomy, redacted payload, idempotency key, post-commit emission boundary, and test matrix without adding automation behavior. |
| W5-1 | Approval completion event contract implementation | Landed #2414 (`184f2293c`) | `approval.approved/rejected/revoked/cancelled` payload is versioned, redacted, idempotent, emitted post-commit, and tested without adding automation action yet. `return` remains a non-terminal rework transition. |
| W6-0 | Automation `start_approval` scope-gate | Scope-gate document added; runtime not started | `automation-start-approval-scope-gate-20260610.md` locks action config, idempotency, bridge persistence, waiting/resume semantics, redaction, and tests. |
| W6-1 | Automation `start_approval` runtime | Landed #2469; operator smoke pending #2480 | Starts one approval instance from a published template, persists the approval bridge, creates a suspended C1 job, resumes/fails from W5 terminal completion events, and guards retry duplicates. #2480 is the deployed/operator validation gate for approval-approved resume, approval-terminal fail/skip, retry duplicate guard, and redacted Admin runs output; `automation-start-approval-operator-smoke-runbook-20260613.md` is the values-free operator checklist. |
| W7-0 | Approval result backwrite scope-gate | Scope-gate document added; runtime not started | `automation-approval-result-backwrite-scope-gate-20260611.md` locks explicit mapping, idempotency, permission/field guards, redaction, and tests. |
| W7-1 | Approval result backwrite runtime | Not started; after #2480 PASS or named runtime unlock | Explicit mapping writes approved/rejected/revoked/cancelled outcomes to multitable record fields with audit and permission checks; `return` transition backwrite needs a separate named scope if required. |
| W8 | BPMN compile/preview adapter | A6-4a pure compiler landed #2568; A6-4b read-only route landed #2577; A6-4c read-only UI landed #2604 | `multitable-automation-a6-4-bpmn-compile-preview-scope-gate-20260612.md` locks the constrained subset, side-effect-free preview, gap report, and hard no-live-runtime boundary. The pure compiler landed in #2568, the read-only route in #2577, and the read-only Workflow Designer compile-preview UI in #2604 (no persistence/deploy/start/live runtime). Live BPMN runtime remains out of scope; BPMN create-from-preview needs a separate named scope. |
| W9 | Public webhook resume token emitter | Not started; use-case gated | External consumer can receive a token/callback URL safely; auth, expiry, replay, and redaction are locked before public route. |
| W10 | Field-visibility / richer approval authoring | Optional follow-up | Existing `visibilityRule` data can be authored, not only preserved; unsupported graph constructs remain fail-closed. |

## 4. Recommended Next Slice After Explicit Unlock

W6 **automation `start_approval`** landed after the dedicated W6-0 scope-gate:
`docs/development/automation-start-approval-scope-gate-20260610.md`.

Why:

1. **W1 is closed by issue evidence** (#2318 + #2371 + #2375).
2. **W2 is intentionally held** because #2367 found no concrete
   branch-internal wait/nesting demand for the current trial flow.
3. The v1 cross-surface start gap is now closed: automation can explicitly
   start an approval through `start_approval`, and W5-1 gives it a stable
   terminal completion signal.

The Workflow Designer/BPMN line has now taken its three low-risk code slices:
**W8/A6-4a BPMN compile-preview pure compiler** landed in #2568,
**A6-4b read-only compile-preview route** landed in #2577, and
**A6-4c read-only Workflow Designer compile-preview UI** landed in #2604.
Together they advance the Workflow Designer layer without writing business data
or starting a live BPMN runtime. Any further W8 work (live BPMN runtime, BPMN
create-from-preview) is out of v1 scope and needs a separate named decision,
keeping the no-persistence / no-live-runtime boundary.

**W7 approval result backwrite** remains the next cross-surface business-write
candidate. W7-0 has a scope-gate document, but W7-1 runtime remains separately
gated because it writes business data and changes record state. The normal W7-1
re-entry proof is #2480 PASS for W6 `start_approval`; otherwise the owner must
name a concrete result-backwrite use case. W7 should not preempt A6-4a by
default.

## 5. Non-goals for v1

- No generic JS/SQL/code node.
- No arbitrary public webhook endpoint without emitter/auth/replay design.
- No second status vocabulary outside C1.
- No second run/audit store outside automation jobs + approval records.
- No live BPMN production runtime for v1.
- No silent flattening of unsupported approval or automation shapes.
- No cross-surface coupling hidden behind "template save" or "record update";
  bridge behavior must be explicit and reviewable.

## 6. Tracker Maintenance Rule

Every runtime slice that lands must update exactly one status source and, when
needed, one verification/runbook:

- Automation status source: `multitable-automation-run-governance-todo-20260527.md`.
- Automation execution plan: `multitable-automation-a6-execution-plan-20260601.md`.
- Approval authoring status source:
  `approval-template-authoring-frontend-mvp-todo-20260604.md`.
- Cross-surface completion source: this document.
- W6 `start_approval` bridge scope:
  `automation-start-approval-scope-gate-20260610.md`.
- W6 deployed/operator smoke:
  #2480 and `automation-start-approval-operator-smoke-runbook-20260613.md`.
- W7 approval result backwrite scope:
  `automation-approval-result-backwrite-scope-gate-20260611.md`.
- A6-3-4 / W3 parallel join-all scope:
  `multitable-automation-a6-3-parallel-join-all-scope-gate-20260611.md`.
- A6-4 / W8 BPMN compile-preview scope:
  `multitable-automation-a6-4-bpmn-compile-preview-scope-gate-20260612.md`.
- A6-4a / W8 pure compiler implementation plan:
  `multitable-automation-a6-4a-bpmn-compile-preview-implementation-plan-20260612.md`.
- A6-4b / W8 read-only route:
  #2577 (`b5646fa71`).
- v1 closeout ledger:
  `workflow-automation-v1-closeout-plan-todo-20260614.md`.

If code lands but the tracker still says "not started", the tracker is wrong
and should be corrected before starting a new rung.
