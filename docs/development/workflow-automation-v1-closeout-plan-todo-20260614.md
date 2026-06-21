# Workflow Automation v1 Closeout Plan And TODO

Date: 2026-06-14

Originally grounded on: `origin/main@741810a15`; tracker status reconciled against current `origin/main` on 2026-06-20 by #2969.

Type: closeout plan + TODO ledger.

Scope: MetaSheet2 workflow automation v1 across multitable automation,
approval, and Workflow Designer/BPMN compile preview.

This document is not a broad roadmap. It defines the remaining work needed to
close the bounded v1 product loop, and it separates mandatory closeout work
from demand-gated follow-ups.

## 0. Closeout Decision

Workflow automation v1 is close to complete, but not fully closed.

The engine substrate is already in place:

- multitable automation run governance A0-A5;
- C1 WorkflowJob persistence and admin runs visibility;
- suspend/resume;
- exclusive condition branches;
- parallel `joinMode: 'all'`;
- approval completion events;
- automation `start_approval`;
- BPMN compile-preview core and read-only route.

The remaining mandatory work is now mostly product closure:

1. reconcile stale tracker text after #2577;
2. expose the BPMN compile-preview route in Workflow Designer UI;
3. run the W6 `start_approval` deployed/operator smoke (#2480);
4. implement W7 approval result backwrite only after #2480 PASS or explicit
   owner unlock;
5. record final UAT evidence and close the v1 ledger.

Do not treat "continue workflow automation" as authorization for the optional
graph/runtime expansions listed later in this file.

## 1. Current State On Main

| Area | Status |
|---|---|
| Run governance A0-A5 | Landed. Snapshot, redaction, read API, admin UI, retry, and response hardening are closed. |
| A6-1 WorkflowJob plane | Landed end-to-end. Rules can opt into C1 job persistence through API and admin UI. |
| A6-2 suspend/resume | Landed end-to-end. `wait_for_callback` + admin-gated resume are available and UAT passed. |
| A6-3 condition branches | Landed end-to-end. Runtime, editor, and admin runs readability are available. |
| A6-3 parallel join-all | Landed end-to-end. Runtime, editor, and admin runs readability are available for `joinMode: 'all'`. |
| W5 approval completion events | Landed. Terminal approval events are versioned, redacted, idempotent, and emitted post-commit. |
| W6 `start_approval` | Landed. Automation can start one approval, suspend the C1 job, and resume/fail from approval terminal events. |
| Approval authoring MVP | Landed and UAT accepted. Template create/edit/publish/start works for the MVP path. |
| A6-4a BPMN pure compiler | Landed #2568. Pure function and unit tests only. |
| A6-4b BPMN compile-preview route | Landed #2577 (`b5646fa71`). Read-only route calls the pure compiler without persistence or live BPMN runtime. |
| A6-4c BPMN compile-preview UI | Landed #2604. Read-only Workflow Designer dialog consuming the A6-4b route: source mode, supported status, redacted automation actions + approval graph (collapsible JSON), mapping/gap reports, warnings. No deploy/start/persist; stale-response guarded via a request-id composable. |

## 2. Definition Of Done For v1

Workflow automation v1 is DONE when all mandatory boxes below are checked.

- [x] Status docs are reconciled so no canonical tracker still marks A6-4b as
      unstarted after #2577.
- [x] Workflow Designer exposes a read-only compile-preview UI backed by
      `POST /api/workflow-designer/workflows/:id/compile-preview`. (Landed #2604.)
- [x] The compile-preview UI clearly separates:
      `automationPreview`, `approvalPreview`, `mappingReport`, `gapReport`, and
      warnings. (Automation actions and approval graph are shown read-only as
      backend-redacted collapsible JSON, not flattened to a count.)
- [x] The compile-preview UI contains no deploy/start/publish/save side effect,
      no live BPMN runtime entry, and no "run this workflow" affordance.
- [ ] W6 `start_approval` deployed/operator smoke (#2480) is PASS or explicitly
      accepted as deferred by the owner.
- [ ] If #2480 PASS and the product needs approval outcome fields on records,
      W7 result backwrite runtime and UI are implemented with explicit mapping,
      field guards, idempotency, redaction, and UAT.
- [ ] Final closeout updates this document and
      `workflow-automation-completion-plan-20260609.md`.

## 3. Mandatory TODO

### T0 - Tracker Reconciliation After #2577

Status: completed by this docs slice.

Why: #2577 has landed A6-4b, but several tracker documents still say the route
is not started. That is a footgun for future planning and review.

Files to update:

- `docs/development/workflow-automation-completion-plan-20260609.md`
- `docs/development/multitable-automation-run-governance-todo-20260527.md`
- `docs/development/multitable-automation-a6-execution-plan-20260601.md`
- `docs/development/run-governance-forward-plan-20260528.md`
- `docs/development/multitable-automation-a6-4-bpmn-compile-preview-scope-gate-20260612.md`
- `docs/development/multitable-automation-a6-4a-bpmn-compile-preview-implementation-plan-20260612.md`
- `docs/development/multitable-automation-a6-convergence-scout-20260529.md`

Acceptance:

- [x] A6-4b is marked LANDED #2577 / `b5646fa71`.
- [x] Remaining A6-4 work is renamed to A6-4c frontend compile-preview UI.
- [x] No canonical doc marks the A6-4b route as unstarted.
- [x] W7 result backwrite remains runtime-gated.

### T1 - A6-4c Workflow Designer Compile-Preview UI

Status: LANDED #2604.

Goal: make the landed compile-preview route usable from the Workflow Designer
without adding persistence or runtime execution.

Scope:

- Add a preview action in the Workflow Designer draft surface.
- Call `POST /api/workflow-designer/workflows/:id/compile-preview`.
- Render:
  - source mode and source version;
  - supported / not supported status;
  - automation preview;
  - approval preview;
  - mapping report;
  - deterministic gap report;
  - warnings.
- Show empty and error states that keep the draft editable.
- Keep the UI clearly read-only.

Hard no:

- no call to deploy/start/test execution;
- no creation or update of automation rules;
- no creation or update of approval templates;
- no persistence beyond the existing draft reads already done by the route;
- no live BPMN runtime wording.

Suggested implementation shape:

1. Add client API wrapper for compile preview.
2. Add typed view model for compile-preview response.
3. Add a panel or drawer in the existing Workflow Designer page.
4. Add focused tests for:
   - button calls the route;
   - visual draft preview renders mapping/gap sections;
   - BPMN XML source preview renders source mode correctly;
   - unsupported nodes render gaps, not silent success;
   - error state does not mutate the draft;
   - no deploy/start/test button is introduced by this panel.

Acceptance:

- [x] User can open compile-preview from Workflow Designer.
- [x] The response is readable enough to explain which automation/approval
      primitives would be used. (Mapping report + redacted action/approval JSON.)
- [x] Unsupported BPMN elements are visible as gaps with rung names where
      applicable.
- [x] Tests prove the panel is read-only and side-effect-free from the UI layer.

### T2 - W6 `start_approval` Deployed Operator Smoke

Status: open issue #2480. Runbook `/api` co-tenancy preflight hard-gate
formalized in #2608 (§2.1). The deployed smoke itself still waits on the
host-side `/api` routing fix before §3-§6 can run.

Goal: validate deployed UI, routing, auth, and admin runs readability for the
already-landed W6 bridge.

Runbook:

- `docs/development/automation-start-approval-operator-smoke-runbook-20260613.md`

Acceptance:

- [ ] Deployed UI and `/api` route point to the intended MetaSheet backend.
- [ ] One execution creates exactly one approval instance.
- [ ] `start_approval` is visible as suspended/waiting in Admin runs while the
      approval is pending.
- [ ] Approved completion resolves the C1 job and resumes the tail exactly once.
- [ ] Rejected/revoked/cancelled completion fails `start_approval` and skips the
      tail.
- [ ] Retry does not create a duplicate approval.
- [ ] Admin runs output remains redacted and operator-readable.

Decision after T2:

- PASS: W7-1 may start if result backwrite is still wanted.
- FAIL: fix the deployed/runtime issue before W7-1.
- Deferred by owner: W7-1 needs a separate named runtime unlock.

### T3 - W7-1 Approval Result Backwrite Runtime

Status: gated.

Entry condition: T2 PASS or explicit owner unlock naming the result-backwrite
use case.

Scope source:

- `docs/development/automation-approval-result-backwrite-scope-gate-20260611.md`

Goal: after an automation-created approval reaches a terminal outcome, write
selected result fields back to the original triggering multitable record through
explicit mapping.

Mandatory runtime properties:

- explicit `start_approval.config.resultBackwrite` mapping only;
- durable idempotency, preferably by bridge/event/mapping key;
- field-level validation before write;
- permission/actor model documented and tested;
- no full approval form/comment/profile dump;
- normal multitable record update events emitted for successful writes;
- no recursion loop or hidden trigger binding;
- redacted C1 job output.

Suggested split:

1. T3a backend model + idempotent attempt state.
2. T3b record write path + guards.
3. T3c automation editor mapping UI.
4. T3d admin runs readability and real-DB tests.
5. T3e deployed/operator UAT update.

Acceptance:

- [ ] Approved/rejected/revoked/cancelled can write configured safe values.
- [ ] Duplicate completion events do not write twice.
- [ ] Invalid fields fail closed before writing.
- [ ] Hidden/read-only/lookup/rollup or invalid option/link fields are rejected.
- [ ] Record update audit/realtime semantics are preserved.
- [ ] W6 retry duplicate guard remains intact.

### T4 - Final v1 Closeout

Status: not started.

Goal: freeze the v1 line as complete after T1/T2 and, if unlocked, T3.

Acceptance:

- [ ] `workflow-automation-completion-plan-20260609.md` updated with final
      status.
- [ ] This document updated from TODO to closeout result.
- [ ] Any remaining optional rungs are explicitly marked post-v1 / demand-gated.
- [ ] Final UAT evidence links are recorded.

## 4. Optional / Demand-Gated Follow-Ups

These are not required for v1 closeout unless a concrete scenario demands them.

| ID | Work | Gate |
|---|---|---|
| O1 | A6-3-3 nested branch (branch-local `wait_for_callback` LANDED #2626/#2702) | A named scenario needs *nested* branches beyond the shipped branch-local wait; the basic branch-local `wait_for_callback` already shipped. |
| O2 | A6-3-5 join-any / cancellation | A real workflow needs first-success or first-complete semantics; join-all is insufficient. |
| O3 | Public webhook token emitter | An external system needs to resume waits without an admin manually copying a token. Requires auth/replay/expiry design. |
| O4 | Delay/timer resume | A real workflow needs time-based waits. Requires durable scheduler, worker ownership, and restart semantics. |
| O5 | Approval richer authoring | Users need to author visibility rules, attachments, richer graph shapes, or policy controls beyond the MVP. |
| O6 | BPMN create-from-preview / apply-preview | Only after compile-preview UI proves useful. Must be separately scoped because it creates automation/approval definitions. |
| O7 | Live BPMN runtime | Out of scope for v1. Requires a separate product decision because it would introduce a fourth runtime surface. |

## 5. Recommended Execution Order

1. T0 tracker reconciliation - completed (#2592).
2. T1 A6-4c Workflow Designer compile-preview UI - LANDED #2604.
3. T2 W6 operator smoke - runbook preflight #2608; smoke pending host-side `/api` fix.
4. T3 W7 result backwrite only if T2 passes or owner explicitly unlocks.
5. T4 final closeout.

This order keeps the remaining read-only/productization work moving while
holding business-write changes until the existing W6 bridge is proven in the
deployed environment.

## 6. Review Rules For Remaining PRs

- Every implementation PR must include a focused test for its cross-surface
  seam, not only isolated fixtures.
- Any PR touching business writes must include real-DB or route-level coverage.
- UI PRs must prove unsupported shapes are visible as gaps/read-only states,
  never silently flattened or approximated.
- BPMN work must stay compile-preview only unless the owner explicitly opens a
  separate live-runtime product decision.
- After each landed PR, update exactly one status source and this closeout TODO
  if the item state changed.
