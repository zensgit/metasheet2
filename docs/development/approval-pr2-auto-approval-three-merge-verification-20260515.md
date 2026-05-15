# Approval PR2 Auto-Approval Three-Merge Verification 2026-05-15

Branch:

- `flow/auto-approval-three-merge-20260515`

Latest implementation commits:

- `30f0b7662 feat(approval): snapshot auto approval policy`
- `43ccfa59f test(approval): cover auto approval overrides`
- `298a939e1 test(approval): cover auto approval guardrails`
- `5d6395df2 feat(approval): handle parallel auto approval conflicts`

## Commands Run

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-product-service.test.ts --watch=false
```

Result:

- PASS
- 1 file
- 29 tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-graph-executor.test.ts --watch=false
```

Result:

- PASS
- 1 file
- 14 tests

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

- PASS

```bash
pnpm --filter @metasheet/core-backend test:unit
```

Result:

- PASS
- 165 files
- 2156 tests

```bash
pnpm type-check
```

Result:

- PASS
- `pnpm -r type-check`
- `apps/web type-check: Done`

## Coverage Notes

Covered in `approval-product-service.test.ts`:

- `mergeWithRequester` on initial node.
- node override disabled over template enabled.
- node override enabled over template disabled.
- deterministic precedence: requester > adjacent > historical.
- `empty-assignee` does not double-emit with requester merge.
- old runtime graphs with no `policy.autoApproval` behave unchanged.
- all-mode requester auto-merge leaves remaining human assignees pending.
- adjacent transitive chain semantics.
- policy version-freeze regression: advance reads policy from instance-bound `published_definition_id`.
- max auto-step guard: `APPROVAL_AUTO_STEP_LIMIT_EXCEEDED` rolls back.
- independent parallel branch auto-merge without duplicate active assignments.
- cross-branch duplicate adjacent merge refuse-and-warn with `skipReason`.
- publish-time `autoApproval` is snapshotted into `runtime_graph`.

## Migration And Rollback

No migration was added.

PR2 stores `autoApproval` inside existing `approval_published_definitions.runtime_graph.policy`.
Migration rollback is N/A.

## Known Gaps

- Full integration suite remains subject to the baseline DB environment issue recorded before PR1.
- PR2 intentionally adds no frontend policy authoring UI.
- PR2 intentionally adds no `approval_template_versions.auto_approval_policy` authoring column.
- Normal template authoring still rejects duplicate approvers across parallel branches. The runtime duplicate refuse-and-warn path is a defensive compatibility path for historical or otherwise pre-existing runtime snapshots.
