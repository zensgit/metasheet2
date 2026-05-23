# Approval Phase 2 AssigneeResolver Development 2026-05-23

Base: `origin/main@675afd560` (`docs(approval): scope phase2 assignee resolver (#1794)`)
Branch: `codex/approval-assignee-resolver-impl-20260523`
Scope gate: `docs/development/approval-phase2-assignee-resolver-scope-gate-20260523.md`

## Summary

This slice implements the first unlocked Phase 2 item: a pure approval assignee resolver for dynamic approval-node assignment sources.

It keeps the executor graph-local, stores source configuration in the frozen runtime graph, preserves legacy static assignment behavior, and does not unlock trigger bindings, start-approval automation, result backwrite, event bridge, UI, SLA, or add-sign/countersign work.

## Implemented Files

| File | Purpose |
|---|---|
| `packages/core-backend/src/types/approval-product.ts` | Adds `ApprovalAssigneeSource`, `ApprovalAssigneeResolutionMetadata`, and optional `ApprovalNodeConfig.assigneeSources`. Legacy `assigneeType` / `assigneeIds` remain optional for backward compatibility. |
| `packages/core-backend/src/services/ApprovalAssigneeResolver.ts` | New synchronous, DB-free resolver for `static_user`, `static_role`, `requester`, and `form_field_user`. |
| `packages/core-backend/src/services/ApprovalGraphExecutor.ts` | Accepts an injected pure assignment resolver and applies existing empty-assignee policy when dynamic resolution returns no assignment. |
| `packages/core-backend/src/services/ApprovalProductService.ts` | Normalizes and validates `assigneeSources`, wires resolver inputs from frozen runtime graph state, persists assignment metadata, and refuses dynamic parallel collisions before insertion. |
| `packages/core-backend/tests/unit/approval-assignee-resolver.test.ts` | Unit coverage for resolver source semantics, schema validation, empty dynamic values, and dedupe. |
| `packages/core-backend/tests/unit/approval-graph-executor.test.ts` | Executor coverage for injected resolver, empty-assignee `error`, and empty-assignee `auto-approve`. |
| `packages/core-backend/tests/unit/approval-product-service.test.ts` | Product-service coverage for normalization, schema validation, metadata persistence, version-freeze reads, and dynamic parallel collisions. |
| `packages/core-backend/tests/unit/approval-admin-jump-service.test.ts` | Existing admin-jump expectations updated for assignment metadata parameter. |

No route, migration, UI, automation, Workflow Designer, SLA, breach, trigger-binding, backwrite, event-bridge, or add-sign files changed.

## Resolver Contract

The resolver input is intentionally narrow:

- frozen approval node config;
- frozen form schema when available;
- current instance `form_snapshot`;
- current instance `requester_snapshot`;
- node key and source step.

The resolver is synchronous and does not query the database. It returns runtime assignments shaped as:

```ts
{
  assignmentType: 'user' | 'role',
  assigneeId: string,
  nodeKey: string,
  sourceStep: number,
  metadata?: {
    resolvedFrom: {
      kind: 'static_user' | 'static_role' | 'requester' | 'form_field_user',
      sourceIndex: number,
      fieldId?: string,
    },
  },
}
```

Legacy `assigneeType` / `assigneeIds` runtime graphs remain metadata-free.

## Source Semantics

| Source | Behavior |
|---|---|
| `static_user` | Resolves each configured user id into a `user` assignment. |
| `static_role` | Resolves each configured role id into a `role` assignment. It does not expand role membership. |
| `requester` | Resolves to `requester_snapshot.id` when present. Missing requester id produces no assignments and lets the node `emptyAssigneePolicy` decide. |
| `form_field_user` | Resolves a string value or object `{ id }` from `form_snapshot[fieldId]`. Missing, empty, or unsupported values produce no assignments and let `emptyAssigneePolicy` decide. |

When `formSchema` is available, `form_field_user` must reference an existing field whose type is `user`; otherwise the service throws `APPROVAL_ASSIGNEE_INVALID_SOURCE`.

Within one node, duplicate resolved `(assignmentType, assigneeId)` pairs are deduped and the first source metadata wins.

## Normalization and Validation

`assigneeSources` is authoritative when present. Legacy fields may coexist only if they are valid legacy fields; this keeps display/backward compatibility while avoiding ambiguous partial legacy config.

Validation rules added in `ApprovalProductService`:

- `assigneeSources` must be an array if present.
- `assigneeSources: []` is invalid at normalization time.
- `static_user.userIds` and `static_role.roleIds` must be non-empty string arrays.
- `form_field_user.fieldId` must be a non-empty string.
- create, update-version, and publish paths validate `form_field_user` against the form schema.

## Runtime Wiring

`ApprovalProductService` builds a pure resolver callback from:

- instance form snapshot;
- requester snapshot;
- form schema at instance creation time.

The resolver callback is injected into `ApprovalGraphExecutor` for:

- `createApproval`;
- `dispatchAction` advance/return path;
- `adminJump`.

`dispatchAction` and `adminJump` continue to load the instance-bound `runtime_graph` through `published_definition_id`. They do not read active template JSON or `approval_template_versions` for source configuration.

## Dynamic Parallel Collision Guard

The existing database invariant allows only one active assignment per `(instance_id, assignment_type, assignee_id)`. Static cross-branch duplicates are already prevented before runtime; dynamic sources can collide only after resolving against a specific instance.

This slice adds a pre-insert guard:

- detects duplicate dynamic assignments in the pending batch;
- detects dynamic assignments colliding with existing active assignments;
- throws `APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT`;
- rolls back before inserting assignments, audit rows, or committing the transaction.

The guard is metadata-sensitive. Legacy/static metadata-free paths avoid the extra active-assignment SELECT, preserving old-path behavior and performance.

## Scope Gate Mapping

| Gate | Result |
|---|---|
| G1 runtime graph snapshot | `assigneeSources` lives in `ApprovalNodeConfig` and is captured by the published runtime graph. |
| G2 sync DB-free resolver | `ApprovalAssigneeResolver` is pure and synchronous. |
| G3 v1 sources only | Only `static_user`, `static_role`, `requester`, and `form_field_user` are accepted. |
| G4 empty-assignee semantics | Empty dynamic resolution flows through existing `error` / `auto-approve` policy only. |
| G5 role assignment semantics | `static_role` remains `assignment_type='role'`; no role expansion. |
| G6 dynamic parallel conflict | `APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT` is thrown before assignment insert. |
| G7 no boundary crossing | No migrations, routes, UI, automation, Workflow Designer, SLA, breach, trigger, backwrite, event bridge, or add-sign files changed. |
| G8 frozen graph reads | dispatch/admin-jump paths use instance-bound `published_definition_id` runtime graph. |

## Review NIT Handling

| NIT | Handling |
|---|---|
| NIT-1 split T14 | Dynamic parallel conflict is covered at creation time and advance time. |
| NIT-2 empty `assigneeSources` | Empty source arrays are invalid during graph normalization and publish validation. |
| NIT-3 active-template negative read | Dispatch test asserts the advance path does not read active template tables for dynamic sources. |

## Forward Gate

This implementation keeps the PR #1794 forward gate intact.

The resolver slice is unlocked as approval-kernel hardening only. These items remain frozen and require K3 GATE PASS, a named K3 gate blocker, or separate explicit opt-in with a new scope gate:

- `approval_trigger_bindings`;
- multitable/public-form approval trigger source-snapshot and trigger-event paths;
- approval result backwrite to multitable records;
- automation `start_approval`;
- approval completion event bridge for automation triggers.

## Deployment Notes

No migration is included. Existing published runtime graphs without `assigneeSources` continue through the legacy static assignment path.

New dynamic-source templates can only be authored by API/internal config until a future UI slice is explicitly scoped. This PR intentionally does not add UI controls.
