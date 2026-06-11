# Workflow & Automation Completion Plan

Date: 2026-06-09

Grounded on: `origin/main@275644e81`

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
| Still missing | Branch-local wait/nesting, parallel fan-out/join, BPMN compile/preview mapping, public webhook token emitter. |

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
| Still missing | Compile/preview adapter into automation/approval definitions, deterministic gap report, no-live-runtime guard. |

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
| W2 | Automation A6-3-3 branch-local wait/nesting | Not started; demand-gated; no current unlock | `wait_for_callback` can live inside selected branch with stable nested step cursor, rule-drift guard, resume tests, and no silent flattening in editor. #2367 trial found A6-3 v1 sufficient for the tested flow, so do not start W2 without a new named scenario. |
| W3 | Automation parallel fan-out + join-all | Not started; demand-gated | Parallel branches persist independent job lineage; join-all waits for all branches; failures and skipped branches are audited. |
| W4 | Automation join-any / cancellation semantics | Not started; demand-gated after W3 | First completed branch continues; ignored/cancelled siblings are explicit in C1 jobs and audit. |
| W5-0 | Approval completion event contract scope-gate | Landed #2413 | Defines terminal approval event taxonomy, redacted payload, idempotency key, post-commit emission boundary, and test matrix without adding automation behavior. |
| W5-1 | Approval completion event contract implementation | Landed #2414 (`184f2293c`) | `approval.approved/rejected/revoked/cancelled` payload is versioned, redacted, idempotent, emitted post-commit, and tested without adding automation action yet. `return` remains a non-terminal rework transition. |
| W6-0 | Automation `start_approval` scope-gate | Scope-gate document added; runtime not started | `automation-start-approval-scope-gate-20260610.md` locks action config, idempotency, bridge persistence, waiting/resume semantics, redaction, and tests. |
| W6-1 | Automation `start_approval` runtime | Landed #2469 | Starts one approval instance from a published template, persists the approval bridge, creates a suspended C1 job, resumes/fails from W5 terminal completion events, and guards retry duplicates. |
| W7 | Approval result backwrite | Not started; after W5/W6 | Explicit mapping writes approved/rejected/revoked/cancelled outcomes to multitable record fields with audit and permission checks; `return` transition backwrite needs a separate named scope if required. |
| W8 | BPMN compile/preview adapter | Not started; after W3 minimum | Constrained BPMN subset compiles into automation/approval preview plus gap report; no live execution route. |
| W9 | Public webhook resume token emitter | Not started; use-case gated | External consumer can receive a token/callback URL safely; auth, expiry, replay, and redaction are locked before public route. |
| W10 | Field-visibility / richer approval authoring | Optional follow-up | Existing `visibilityRule` data can be authored, not only preserved; unsupported graph constructs remain fail-closed. |

## 4. Recommended Next Slice

W6 **automation `start_approval`** landed after the dedicated W6-0 scope-gate:
`docs/development/automation-start-approval-scope-gate-20260610.md`.

Why:

1. **W1 is closed by issue evidence** (#2318 + #2371 + #2375).
2. **W2 is intentionally held** because #2367 found no concrete
   branch-internal wait/nesting demand for the current trial flow.
3. The v1 cross-surface start gap is now closed: automation can explicitly
   start an approval through `start_approval`, and W5-1 gives it a stable
   terminal completion signal.

The next cross-surface candidate is **W7 approval result backwrite**, but it
must still start from a separate scope gate because it writes business data and
changes record state. Do not jump straight to BPMN before the remaining graph
prerequisites are named. BPMN gateway preview still needs branch/parallel
semantics to map to.

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

If code lands but the tracker still says "not started", the tracker is wrong
and should be corrected before starting a new rung.
