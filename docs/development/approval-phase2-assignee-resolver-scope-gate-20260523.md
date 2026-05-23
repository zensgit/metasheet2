# Approval Phase 2 AssigneeResolver Scope Gate 2026-05-23

Base: `origin/main@66394a167` (`docs(workflow): record yida benchmark implementation status (#1793)`)
Scope: Phase 2 first slice, `ApprovalAssigneeResolver` only
Verdict: **CONDITIONAL GO for design/implementation after this gate is accepted**

This is the first business-closure slice after the YiDA benchmark status appendix. It does not restart PR4 add-sign and does not unlock generic trigger bindings. The goal is to make approval-node assignee resolution extensible while preserving the existing static user/role behavior.

## 1. Code Facts

| ID | Fact | Evidence |
|---|---|---|
| F1 | Approval nodes currently support only static `assigneeType: 'user' | 'role'` plus `assigneeIds[]`. | `packages/core-backend/src/types/approval-product.ts:45-51` |
| F2 | Empty-assignee policy currently supports only `error` and `auto-approve`. | `packages/core-backend/src/types/approval-product.ts:14` |
| F3 | `ApprovalGraphExecutor` synchronously turns an approval node into active assignments in `resolveInitialState()` and return/advance paths. | `packages/core-backend/src/services/ApprovalGraphExecutor.ts:746-776`, `:1010-1038` |
| F4 | `ApprovalProductService.createApproval()` stores a frozen `runtime_graph` through `published_definition_id`, then inserts executor assignments. | `packages/core-backend/src/services/ApprovalProductService.ts:2351-2413` |
| F5 | `approval_assignments` supports `assignment_type` values `user`, `role`, and historical `source_queue`, but current product code inserts only `user` and `role`. | `packages/core-backend/src/db/migrations/zzzz20260404100000_extend_approval_tables_for_bridge.ts:85-96`, `ApprovalProductService.ts:3438-3456` |
| F6 | Active assignment uniqueness is `UNIQUE(instance_id, assignment_type, assignee_id) WHERE is_active = TRUE`; dynamic duplicate users across parallel branches cannot be represented safely. | `packages/core-backend/src/db/migrations/zzzz20260411120100_approval_templates_and_instance_extensions.ts:109-112` |
| F7 | Static duplicate approvers across parallel branches are already refused because of the active-assignment unique-index invariant. Dynamic sources need an equivalent runtime refusal. | `packages/core-backend/src/services/ApprovalProductService.ts:721-776` |
| F8 | User form fields are single-value in the current frontend picker; backend validation accepts string or object for `type: 'user'`. | `apps/web/src/views/ApprovalNewView.vue`, `ApprovalGraphExecutor.validateFieldType()` |
| F9 | YiDA benchmark Phase 2 names `ApprovalAssigneeResolver` as the first business-closure item, while trigger bindings, backwrite, automation start, and event bridge are separate later items. | `docs/research/yida-workflow-automation-benchmark-improvement-plan-20260515.md:956-966` |

## 2. Scope

### In Scope

- Add `packages/core-backend/src/services/ApprovalAssigneeResolver.ts`.
- Extend `ApprovalNodeConfig` with optional `assigneeSources?: ApprovalAssigneeSource[]`.
- Preserve legacy `assigneeType` / `assigneeIds` for backward compatibility.
- Resolve v1 sources:
  - `static_user`
  - `static_role`
  - `requester`
  - `form_field_user`
- Keep resolved runtime assignments as `assignment_type = 'user' | 'role'`.
- Add optional assignment metadata recording source-kind, field id, and source index.
- Wire resolver into approval node entry for create, approve/return, admin jump, and parallel branch entry.
- Add focused unit tests plus at least one integration/real-DB guard for assignment insertion and rollback semantics if implementation touches `insertAssignments()`.
- Add development and verification docs for the implementation PR.

### Out of Scope

- PR4 add-sign/countersign.
- `approval_trigger_bindings`.
- Public-form or multitable record trigger approval.
- Approval result backwrite.
- Automation `start_approval`.
- Approval event bridge (`approval.approved`, `approval.rejected`, `approval.returned`).
- New UI for configuring assignee sources.
- New DB table or migration.
- Supervisor chain, department/member group, dynamic role expansion, source queue, fallback/escalation, skip-node.
- Any change to Workflow Designer/BPMN mapping.

## 3. Required Decisions

### D1. Storage and Version Freeze

`assigneeSources` must live inside the published `runtime_graph` snapshot, not in active templates or a new mutable table. Existing instances must continue to resolve from `instance.published_definition_id`.

No new migration is expected for v1. The existing `approval_assignments.metadata JSONB` is sufficient for resolver audit metadata.

### D2. Backward Compatibility

If `assigneeSources` is absent, behavior must be byte-for-byte compatible with the current static `assigneeType` / `assigneeIds` path.

If both legacy fields and `assigneeSources` are present, implementation must pick one deterministic rule. Recommended rule:

1. `assigneeSources` is authoritative.
2. Legacy fields are kept only for compatibility/display.
3. Normalization can derive an equivalent `static_user` or `static_role` source when `assigneeSources` is absent.

### D3. Resolver Purity

The v1 resolver must be synchronous and DB-free. Inputs are:

- frozen runtime node config;
- frozen form schema;
- current instance `form_snapshot`;
- current instance `requester_snapshot`;
- node key/source step.

This keeps `ApprovalGraphExecutor` synchronous and prevents organization changes from mutating historical instance behavior.

### D4. Executor Boundary

`ApprovalGraphExecutor` should remain graph traversal code. It may receive an optional pure assignment-resolver callback, but must not query DB, active templates, users, roles, departments, or workflow designer data.

### D5. Source Semantics

Recommended v1 type shape:

```ts
type ApprovalAssigneeSource =
  | { kind: 'static_user'; userIds: string[] }
  | { kind: 'static_role'; roleIds: string[] }
  | { kind: 'requester' }
  | { kind: 'form_field_user'; fieldId: string };
```

Output:

```ts
type ResolvedApprovalAssignment = {
  assignmentType: 'user' | 'role';
  assigneeId: string;
  nodeKey: string;
  sourceStep: number;
  metadata?: {
    resolvedFrom: {
      kind: ApprovalAssigneeSource['kind'];
      sourceIndex: number;
      fieldId?: string;
    };
  };
};
```

### D6. Form Field User

`form_field_user` may only reference a field whose form schema type is `user`.

Accepted values:

- string user id;
- object with non-empty string `id`.

Rejected / empty values:

- missing value;
- empty string;
- object without `id`;
- array values in v1;
- non-`user` field type;
- field not present after hidden-field pruning.

Empty resolved result must flow through the existing `emptyAssigneePolicy` only:

- `error`: reject create/advance/return/jump with a deterministic service error;
- `auto-approve`: emit the existing `empty-assignee` auto-approval event.

Do not add `skip-node`, `escalate`, or `fallbackAssigneeSource` in this slice.

### D7. Role Semantics

`static_role` remains `assignment_type='role'` and `assignee_id=<role id>`. It must not expand to current role members.

Reason: current pending-count/actionability checks already use actor roles against active role assignments. Expanding role membership would create mutable membership snapshots and a new invalidation problem.

### D8. Deduplication

Within one node, duplicate resolved assignments must be deduped by `(assignmentType, assigneeId)` while preserving first-source order. Metadata should preserve the first source that produced the assignment.

### D9. Parallel Dynamic Collision

Static duplicate approvers across parallel branches are already rejected at template validation time. Dynamic sources can collide only at runtime.

V1 must detect duplicate active `(assignmentType, assigneeId)` produced across simultaneously active parallel branches before insert. If detected, the transaction must roll back and return a deterministic error code:

`APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT`

Do not let the database unique index be the first user-visible error.

### D10. PR2/PR3 Composition

Resolved `user` assignments participate in existing PR2 auto-approval policies. Examples:

- `requester` source plus `mergeWithRequester=true` auto-approves once with `auto-merge-requester`;
- `form_field_user` resolving to a historical approver can match `auto-dedupe-historical`;
- `static_role` does not auto-approve because PR2 rules intentionally ignore role assignments.

Admin jump must use the same resolver path as normal node entry, because PR3 intentionally composes node entry with PR2 auto-approval.

### D11. Runtime Graph Freeze

Every resolution during instance creation, approve/return, and admin jump must read the instance-bound `runtime_graph` through `published_definition_id`. It must not read `approval_template_versions`, `approval_templates.active_version_id`, or active template JSON after instance creation.

This is the Phase 2 continuation of the PR1 version-freeze invariant and PR2 policy-freeze invariant.

### D12. Error and Metadata Taxonomy

Implementation must use deterministic service errors rather than raw JavaScript errors or raw database unique-index failures for dynamic-assignee failures. Required error surfaces:

- `APPROVAL_ASSIGNEE_EMPTY` or an equally specific code for empty dynamic resolution when policy is `error`;
- `APPROVAL_ASSIGNEE_INVALID_SOURCE` for invalid `form_field_user` schema references;
- `APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT` for runtime duplicate active assignments across parallel branches.

Assignment metadata is for debugging/audit only. No existing consumer should need metadata to decide task actionability; actionability remains `(assignment_type, assignee_id, actor roles)`.

## 4. Expected Files

Implementation should stay inside this file set:

- `packages/core-backend/src/types/approval-product.ts`
- `packages/core-backend/src/services/ApprovalAssigneeResolver.ts` (new)
- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/tests/unit/approval-assignee-resolver.test.ts` (new)
- `packages/core-backend/tests/unit/approval-product-service.test.ts`
- `packages/core-backend/tests/unit/approval-graph-executor.test.ts` if executor constructor/output changes
- `packages/core-backend/tests/integration/approval-pack1a-lifecycle.api.test.ts` or a new approval integration spec if real DB coverage is needed
- `docs/development/approval-phase2-assignee-resolver-development-20260523.md`
- `docs/development/approval-phase2-assignee-resolver-verification-20260523.md`

No route, migration, automation, Workflow Designer, UI, SLA, or add-sign files should change in the first implementation PR.

## 5. Required Tests

| ID | Test | Risk covered |
|---|---|---|
| T1 | Legacy static `assigneeType/assigneeIds` graph creates identical assignments to pre-slice behavior. | Backward compatibility |
| T2 | Legacy runtime graph without `assigneeSources` advances through approve/return/admin jump unchanged. | Old instance compatibility |
| T3 | `requester` source resolves to requester snapshot id and writes a `user` assignment. | Requester source |
| T4 | `requester` source with missing requester id follows `emptyAssigneePolicy='error'`. | Empty-assignee error |
| T5 | `requester` source with missing requester id and `emptyAssigneePolicy='auto-approve'` writes one `empty-assignee` audit record. | Empty-assignee auto path |
| T6 | `form_field_user` resolves string user id from `form_snapshot`. | Form user source |
| T7 | `form_field_user` resolves object `{ id }` from `form_snapshot`. | Existing backend validation shape |
| T8 | `form_field_user` rejects field missing from schema or field type not `user` during graph normalization/publish. | Authoring validation |
| T9 | `form_field_user` whose value is hidden/pruned/missing follows existing empty-assignee policy. | Hidden field and snapshot correctness |
| T10 | Multiple sources dedupe duplicate `(type,id)` assignments deterministically. | Duplicate suppression |
| T11 | `static_role` remains role assignment and is actionable by actors with that role. | Role compatibility |
| T12 | Resolved `requester` assignment composes with PR2 `mergeWithRequester` and emits exactly one `auto-merge-requester` record. | PR2 composition |
| T13 | Resolved `form_field_user` assignment composes with PR2 historical dedupe when the same user approved earlier. | PR2 composition |
| T14 | Dynamic duplicate users across parallel active branches return `APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT` and roll back. | Unique-index invariant |
| T15 | Republish template with different assignee sources after instance creation; old instance advance reads only `published_definition_id` runtime graph. | Version freeze |
| T16 | Admin jump into a dynamic-assignee node uses the same resolver path and clears old assignments. | PR3 composition |
| T17 | `assignment.metadata.resolvedFrom` is present for dynamic sources and absent or stable for legacy static path. | Audit/debuggability |
| T18 | No migration/bootstrap changes are required; schema diff remains empty. | Scope control |

DB-required tests must not be silently skipped. If local DB is unavailable, mark them explicitly as DB-required in verification and do not report the target as PASS.

## 6. Do-Not-Cross Lines

- Do not implement add-sign/countersign.
- Do not create `approval_trigger_bindings`.
- Do not add public-form or multitable trigger flows.
- Do not add `start_approval` or approval automation events.
- Do not add UI controls for assignee sources.
- Do not add migrations unless implementation discovers an unavoidable schema blocker and re-opens this scope gate.
- Do not expand role membership to user snapshots.
- Do not read active template versions during instance advance.
- Do not make `ApprovalGraphExecutor` query DB.

## 7. Risk Register

| ID | Risk | Required control |
|---|---|---|
| R1 | Version freeze drift: dynamic resolver accidentally reads active template/source config after instance creation. | T15 plus negative SQL/mock assertions that dispatch does not read active template tables. |
| R2 | Executor boundary drift: `ApprovalGraphExecutor` becomes async or starts querying DB. | D3/D4 plus unit tests that construct executor with pure inputs only. |
| R3 | Empty-assignee semantics fork into new skip/escalate behavior. | D6 and T4/T5/T9 keep only `error` / `auto-approve` in v1. |
| R4 | Dynamic parallel duplicate hits database unique index after partially mutating state. | D9 and T14 require pre-insert refusal and rollback. |
| R5 | Metadata/audit consumers start depending on resolver metadata for authorization. | D12 keeps authorization based on assignment fields, not metadata. |
| R6 | Role source semantics accidentally expand to mutable user snapshots. | D7 and T11 keep `assignment_type='role'`. |
| R7 | Form field user values are ambiguous across UI/backend object shapes. | D6 and T6/T7/T8 reject unsupported shapes explicitly. |
| R8 | DB-required integration tests silently skip and report false PASS. | T14/T15/T16 verification must call out DB-required status; no silent skip can be counted as pass. |

## 8. Go / No-Go

**CONDITIONAL GO** for the implementation PR if these decisions are accepted:

- G1: `assigneeSources` is stored in the frozen runtime graph snapshot.
- G2: v1 resolver is synchronous and DB-free.
- G3: v1 supports only `static_user`, `static_role`, `requester`, and `form_field_user`.
- G4: missing dynamic assignees reuse only existing `error` / `auto-approve` empty-assignee semantics.
- G5: role assignments remain role assignments, not expanded users.
- G6: dynamic duplicate parallel assignees are refused before insert with `APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT`.
- G7: no migrations, UI, trigger bindings, automation, Workflow Designer, SLA, or add-sign files in the first implementation PR.
- G8: dispatch/admin-jump/return resolution reads only the instance-bound frozen runtime graph.

If any of G1-G8 changes, pause and update this gate before writing runtime code.

## 9. Forward Gate — Phase 2 Follow-Up Freeze Conditions

User opt-in recorded on 2026-05-23:

This scope gate **only unlocks** the first Phase 2 slice, `ApprovalAssigneeResolver`, as approval-kernel hardening.

The following Phase 2 follow-up items remain frozen under the K3 PoC stage-1 lock. Passing this gate does not unlock them:

- `approval_trigger_bindings` for multitable/public-form approval trigger binding;
- multitable/public-form approval trigger source-snapshot and trigger-event paths;
- approval result backwrite to multitable records;
- automation `start_approval`;
- approval completion event bridge (`approval.approved`, `approval.rejected`, `approval.returned`) for automation triggers.

Any of those follow-up items may start only if one of these conditions is true:

- the customer K3 GATE passes and the stage-1 lock is lifted;
- a named K3 PoC requirement identifies the item as a gate blocker;
- the user independently opts in to a specific item under the staged opt-in lineage discipline.

Each follow-up item still needs its own scope gate. The Resolver implementation PR must not carry any of them along opportunistically.
