# Approval Capability Ladder and Gates - 2026-06-16

Type: **development planning guardrail**.

Status: **proposal / scope router**. This document ranks approval product
follow-ups. It does not authorize implementation by itself.

Companions:

- `docs/development/workflow-approval-automation-engine-convergence-doctrine-20260616.md`
- `docs/development/approval-template-authoring-frontend-mvp-todo-20260604.md`
- `docs/development/workflow-automation-completion-plan-20260609.md`
- local research artifact:
  `artifacts/research/approval-benchmark-ladder-20260616.md`

## 0. Decision

Approval is no longer a blank slate. The core v1 runtime and authoring loop are
substantially built. The next useful work should not repeat core approval graph
or automation-bridge work.

The remaining approval backlog should be handled as independent capability
rungs:

1. **P0: trial-readiness validation** — prove the shipped authoring and
   start/act/terminal loop in the deployed environment.
2. **P1: high-frequency authoring gaps** — add the next most common approval
   configuration primitives without changing runtime ownership.
3. **P2: workflow completeness** — add richer runtime actions and node policies
   only after scope-gates.
4. **P3: operations and administration** — improve large-org governance,
   diagnostics, handover, and reporting.
5. **S: MetaSheet-native advantage** — connect approval data to multitable
   records intentionally, not by copying external sync models.

Each rung is independently demand-gated. The priority order is not an automatic
implementation queue.

## 1. Current Baseline To Preserve

The following are already present enough that follow-up work should extend, not
replace, them:

| Capability | Current MetaSheet basis | Guardrail |
|---|---|---|
| Approval graph runtime | `ApprovalGraphExecutor` handles approval runtime graph progression. | Do not reimplement approval graph traversal in automation. |
| Template authoring MVP | Template create/edit/publish, linear approval builder, fail-closed unsupported template handling. | Unsupported rich templates must remain read-only or save-blocked; never silently flatten. |
| Assignment sources v1 | `static_user`, `static_role`, `requester`, `form_field_user`. | New sources must extend the resolver contract, not bypass it. |
| Approval modes | `single`, `all`, `any`; parallel join modes exist in runtime types. | New modes need explicit semantics and migration/test coverage. |
| Empty assignee policy | `error`, `auto-approve`. | Do not overload this to cover unrelated self-approval or delegation policies. |
| Visibility rules | Existing form-field `visibilityRule` is data-driven field visibility. | Node-level field permissions are a separate axis. |
| Template-level SLA and metrics | `slaHours`, SLA scheduler/notifier, metrics service. | Node-level SLA is a separate rung. |
| Completion events | Typed/redacted terminal approval completion events. | Cross-runtime behavior must stay explicit and idempotent. |
| `start_approval` bridge | Automation can create and wait on approval. | Operational sign-off still depends on W6 deployed/operator smoke. |

## 2. P0 - Trial Readiness

These are not new product rungs. They are the fastest way to turn the shipped
approval MVP from "implemented" into "safe for small trial".

| Item | Acceptance |
|---|---|
| Approval terminal smoke | A manager-created template is published; requester starts; approver approves/rejects; requester sees the terminal state in their initiated list. |
| Authoring permission smoke | A non-manager cannot enter create/edit authoring routes in the deployed UI. |
| Unsupported template smoke | A richer unsupported template opens read-only or save-disabled; saving cannot flatten the graph or drop unknown metadata. |
| W6 bridge operator smoke | Deployed `start_approval` path passes approved and non-approved terminal flows, duplicate guard, redacted Admin runs output, and `/api` preflight. |

P0 should finish before advertising approval as broadly usable.

## 3. P1 - High-Frequency Authoring Gaps

### P1-A. Organization-Derived Assignees

**Goal:** support dynamic assignees derived from organizational structure, such
as direct manager, department owner, or a bounded chain of managers.

**Why first:** it is the highest-value extension to the existing assignment
resolver and should not require rewriting the approval executor.

**Likely contract:**

```ts
type ApprovalAssigneeSource =
  | ExistingSources
  | { kind: 'direct_manager'; of: 'requester' | { formFieldId: string } }
  | { kind: 'department_owner'; of: 'requester' | { formFieldId: string } }
  | {
      kind: 'manager_chain'
      of: 'requester' | { formFieldId: string }
      maxLevels: number
      stopAt?: { userId?: string; roleId?: string }
    }
```

**Hard gate:** do not build runtime until there is a real directory/reporting
line source. A fake hierarchy would only prove fixtures.

**First safe slice:** a scope-gate plus a read-only directory data-source scout:

- where manager / department-owner data lives;
- whether tenant scoping exists;
- how inactive users are handled;
- whether resolver results are stable across publish/runtime freeze;
- what happens on missing manager.

### P1-B. Add / Remove Signers

**Goal:** allow a running approval to add or remove approvers without corrupting
the current node state.

**Scope questions before code:**

- Is added approval before-current, after-current, or parallel-with-current?
- Does it inherit `single/all/any` semantics or carry its own mode?
- Who may add/remove signers?
- How is the action audited?
- How does it interact with existing auto-approval dedupe rules?

This is a runtime action rung. It needs a scope-gate before implementation.

### P1-C. Node-Level Field Permissions

**Goal:** let each approval node define field-level behavior: editable,
read-only, or hidden.

**Important distinction:** this is not the existing `visibilityRule`. Current
visibility rules are based on form data; node-level permissions are based on
where the instance is in the approval graph and who is acting.

**Minimum v1 contract:**

```ts
type NodeFieldPermission = 'editable' | 'readonly' | 'hidden'

type ApprovalNodeConfig = {
  fieldPermissions?: Record<string, NodeFieldPermission>
}
```

**Required guards:**

- client rendering must honor the permission;
- submit/action validation must re-check the permission server-side;
- hidden fields must not leak in action surfaces for actors without visibility;
- unsupported existing metadata must be preserved or blocked, never dropped.

This is a good development candidate if no organization directory source is
ready for P1-A.

### P1-D. Detail / Table Form Field

**Goal:** support repeatable row groups inside an approval form.

**Why it matters:** purchasing, reimbursement, inventory, and service workflows
often need line-item rows.

**Scope questions before code:**

- Are nested fields limited to the existing scalar field types?
- Does each row have a stable row id?
- Are row-level permissions needed?
- How do validation errors point to row + field?
- Can table fields participate in conditions or assignee resolution?

This is medium-to-large because it introduces nested form schema and recursive
validation.

## 4. P2 - Workflow Completeness

| Rung | Goal | Gate |
|---|---|---|
| P2-A Handler node | Add a node that performs a task/handling step without approval/rejection semantics. | Must first decide the boundary between approval graph state and automation side effects. |
| P2-B Self-approval and empty-assignee matrix | Extend empty/requester duplicate handling beyond `error` / `auto-approve`. | Must define deterministic audit reasons and invalidation rules. |
| P2-C Node-level SLA | Allow per-node timeout thresholds and actions. | Must define timeout effects: notify only, auto-close, escalate, or pause. |
| P2-D Related approval field | Let a form reference another approval instance. | Must define visibility and terminal-state constraints. |
| P2-E Sequence number field | Configurable request numbering beyond current request number. | Must define uniqueness scope and reset cycle. |
| P2-F Auto-approval invalidation matrix | Specify when historical approver dedupe stops applying after form edit, return, transfer, add-sign, or required signature. | Must be implemented as explicit policy, not implicit special cases. |

## 5. P3 - Operations And Administration

| Rung | Goal | Gate |
|---|---|---|
| P3-A Scoped approval administrators | Separate template admin, process admin, and data admin responsibilities. | Needs permission model design and migration. |
| P3-B Approval handover | Transfer pending and in-flight approval duties when a user leaves or changes role. | Needs data ownership and audit policy. |
| P3-C Delegation / proxy approval | Time-bounded delegate approvals to another user. | Needs actor attribution and conflict policy. |
| P3-D Efficiency diagnostics | Productize process/team/person views from existing metrics foundations. | Can start after P0 if product wants admin reporting. |
| P3-E Threshold voting / sequential approval | Support N-of-M and ordered approval inside one node. | Needs runtime semantics and tests. |

## 6. MetaSheet-Native Strategic Arc

The strongest long-term differentiation is **approval data as first-class
multitable data**, not periodic export/import.

Possible direction:

- approval form fields can reference multitable records;
- approval instances can be represented as governed records;
- approved terminal outcomes can write explicit mapped values back to records;
- formulas, dashboards, comments, and automation can operate on approval data
  without a sync layer.

This overlaps with W7 result backwrite but is broader. It must not be smuggled
into W7. W7 is a narrow bridge write from `start_approval` completion to a
triggering record; the strategic arc is a product model decision.

## 7. What To Build Next

Recommended sequence:

1. **Finish P0 trial readiness.**
   - It is the cheapest way to reduce uncertainty.
   - It also keeps W6/W7 honest.
2. **If a real org directory/reporting source exists, start P1-A scope-gate.**
   - This is the most valuable clean extension.
   - Do not implement against fake hierarchy data.
3. **If no org source exists, start P1-C node-level field permissions.**
   - It is self-contained and fits current template authoring.
   - It still needs server-side validation, not frontend-only hiding.
4. **Defer P1-B, P1-D, and all P2/P3 items until a named use case exists.**

## 8. PR Rules

Any PR derived from this ladder must:

- avoid external product names or screenshots;
- cite MetaSheet-owned requirements and code facts only;
- keep runtime ownership consistent with the convergence doctrine;
- include create + edit tests for authoring changes;
- include route or integration tests for runtime/permission changes;
- preserve unknown existing template metadata or block editing;
- avoid widening W7/backwrite without a concrete mapping use case;
- avoid live BPMN runtime expansion.

## 9. Explicit Non-Goals

- No generic one-shot "approval parity" epic.
- No direct three-engine merge.
- No live BPMN production runtime.
- No hidden approval-to-record writes.
- No fake organization hierarchy just to demo dynamic assignees.
- No silent flattening of richer templates into the MVP authoring shape.

