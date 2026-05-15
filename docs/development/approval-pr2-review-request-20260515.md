# Approval PR2 Review Request 2026-05-15

Claude should review PR2 according to the Phase 1 §7.2 protocol.

## PR Scope

PR:

- `auto-approval-three-merge`

Branch:

- `flow/auto-approval-three-merge-20260515`

Base:

- `9501d990c docs(approval): track phase1 followups`

## Diff Summary

Implemented:

- Extended `RuntimePolicy` with `autoApproval?: AutoApprovalPolicy`.
- Snapshotted publish-time `autoApproval` into `approval_published_definitions.runtime_graph.policy`.
- Added node-level `autoApprovalPolicy` override.
- Implemented three merge rules:
  - `mergeWithRequester`
  - `mergeAdjacentApprover`
  - `dedupeHistoricalApprover`
- Added deterministic precedence:
  - requester
  - adjacent
  - historical
- Added per-dispatch guard:
  - `APPROVAL_MAX_AUTO_STEPS = 50`
  - error code `APPROVAL_AUTO_STEP_LIMIT_EXCEEDED`
  - transaction rollback verified.
- Kept `ApprovalGraphExecutor` graph-local.
- Added audit taxonomy:
  - `empty-assignee`
  - `auto-merge-requester`
  - `auto-merge-adjacent`
  - `auto-dedupe-historical`
- Added required metadata:
  - `policySource`
  - `originalApprover`
  - `matchedAgainst` where applicable
  - `actorMode`
- Implemented parallel branch cascade for independent auto approvals.
- Implemented duplicate cross-branch adjacent refuse-and-warn for historical runtime snapshots.
- Absorbed PR1 follow-ups:
  - `APPROVAL_TERMINAL_STATUSES`
  - delete guard OR predicate comment.

## Changed Files

- `packages/core-backend/src/types/approval-product.ts`
- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/tests/unit/approval-product-service.test.ts`
- `docs/development/approval-pr2-auto-approval-three-merge-development-20260515.md`
- `docs/development/approval-pr2-auto-approval-three-merge-verification-20260515.md`
- `docs/development/approval-pr2-scope-gate-response-20260515.md`
- `docs/development/approval-pr2-review-request-20260515.md`

## Migration Summary

No migration.

`autoApproval` is stored in existing `runtime_graph.policy` JSONB snapshots.
`down()` migration verification is N/A.

## Tests Run

See `docs/development/approval-pr2-auto-approval-three-merge-verification-20260515.md`.

Summary:

- `approval-product-service.test.ts`: PASS, 29 tests.
- `approval-graph-executor.test.ts`: PASS, 14 tests.
- backend build: PASS.
- backend full unit suite: PASS, 165 files / 2156 tests.
- workspace type-check: PASS.

## Known Gaps

- Full integration suite is not re-run because the local DB baseline issue is pre-existing.
- No frontend policy authoring UI.
- No editable `approval_template_versions.auto_approval_policy` column.
- Normal template authoring still rejects duplicate parallel assignees; the runtime duplicate warning path is defensive compatibility only.

## Review Focus Requested

Please review:

1. Policy source of truth: no advance-time read from `approval_templates` or `approval_template_versions`.
2. Auto-approval audit metadata and reason taxonomy.
3. Rule precedence and chain semantics.
4. `all`/`any`/parallel behavior.
5. Cross-branch duplicate refuse-and-warn semantics.
6. Loop guard rollback behavior.
7. Backward compatibility with pre-PR2 runtime graphs.
8. Scope: no automation, SLA, breach, admin-jump, add-sign, UI, or new routes.

## Expected Claude Output

```text
Verdict:
Blocking correctness issues:
Security/permission issues:
Missing tests:
Scope creep:
Naming/maintainability:
Merge gate:
```
