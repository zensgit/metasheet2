# Approval Phase 2 AssigneeResolver Verification 2026-05-23

Branch: `codex/approval-assignee-resolver-impl-20260523`
Base: `origin/main@675afd560`
Commit under verification: local working tree before final commit

## Verification Summary

PASS. The implementation satisfies the resolver scope gate and the review NITs with unit, build, diff, and scratch PostgreSQL coverage.

## Commands Run

### Focused Unit Tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/approval-assignee-resolver.test.ts \
  tests/unit/approval-graph-executor.test.ts \
  tests/unit/approval-product-service.test.ts
```

Result:

```text
Test Files  3 passed (3)
Tests       56 passed (56)
```

After updating admin-jump metadata expectations:

```bash
pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/approval-admin-jump-service.test.ts \
  tests/unit/approval-assignee-resolver.test.ts \
  tests/unit/approval-graph-executor.test.ts \
  tests/unit/approval-product-service.test.ts
```

Result:

```text
Test Files  4 passed (4)
Tests       63 passed (63)
```

### Full Backend Unit Suite

```bash
pnpm --filter @metasheet/core-backend test:unit
```

Result:

```text
Test Files  176 passed (176)
Tests       2290 passed (2290)
```

### Build

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

```text
PASS
```

### Scratch PostgreSQL Integration

Scratch database:

```text
ms2_approval_resolver_1779544135
```

Command:

```bash
DATABASE_URL=postgres://localhost/ms2_approval_resolver_1779544135 \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/approval-pack1a-lifecycle.api.test.ts \
      tests/integration/approval-wp1-parallel-gateway.api.test.ts \
  --reporter=dot
```

Result:

```text
Test Files  2 passed (2)
Tests       7 passed (7)
```

The scratch database was dropped after the run.

### Diff Hygiene

```bash
git diff --check origin/main..HEAD
git diff --check origin/main...HEAD
git diff --check
```

Result:

```text
PASS
```

## Test Coverage Map

| Scope test | Coverage |
|---|---|
| T1 legacy static assignments | Resolver unit test keeps legacy static user/role assignments metadata-free. Existing approval unit and integration tests remain green. |
| T2 old runtime graph compatibility | Full unit and scratch approval integration pass with legacy graphs. |
| T3 requester source | Product-service unit test persists requester-source metadata on created assignments. |
| T4 empty requester with `error` | Graph executor unit test returns `APPROVAL_ASSIGNEE_EMPTY`. |
| T5 empty requester with `auto-approve` | Graph executor unit test emits empty-assignee auto path. |
| T6 string `form_field_user` | Resolver unit test resolves string user id. |
| T7 object `form_field_user` | Resolver unit test resolves object `{ id }`. |
| T8 invalid form field source | Resolver and product-service validation tests reject non-user/missing fields with `APPROVAL_ASSIGNEE_INVALID_SOURCE`. |
| T9 hidden/pruned/missing form value | Resolver unit test returns empty assignments for missing dynamic values, leaving policy decision to executor. |
| T10 dedupe | Resolver unit test dedupes duplicate resolved assignments and keeps first source metadata. |
| T11 static role semantics | Resolver unit test keeps `static_role` as `assignment_type='role'`; no role expansion is implemented. |
| T12 PR2 requester auto-merge composition | Existing PR2 unit and integration coverage remains green; requester assignments are normal `user` assignments and flow through existing auto-approval logic. |
| T13 PR2 historical dedupe composition | Existing PR2 historical dedupe coverage remains green; dynamic user assignments share the same runtime shape. |
| T14 dynamic parallel duplicate | Product-service tests cover create-time and advance-time duplicate requester collisions with rollback. |
| T15 version freeze | Dispatch unit test asserts dynamic-source advance reads the instance-bound runtime graph and does not query active template tables. |
| T16 admin jump composition | Admin-jump unit tests remain green with resolver wiring and metadata parameter. |
| T17 metadata | Resolver and product-service tests assert `metadata.resolvedFrom` for dynamic sources and no metadata for legacy static path. |
| T18 no schema change | File diff contains no migrations or bootstrap changes. |

## Review NIT Evidence

| NIT | Evidence |
|---|---|
| NIT-1 | `approval-product-service.test.ts` includes both create-time and advance-time dynamic parallel conflict tests. |
| NIT-2 | `normalizeApprovalAssigneeSources()` rejects `assigneeSources: []`; product-service unit tests pin the validation. |
| NIT-3 | Dispatch version-freeze test asserts no `approval_templates`, `approval_template_versions`, or `active_version_id` query is made while advancing a dynamic-source instance. |

## Scope Control

Changed runtime/test files are limited to:

- `packages/core-backend/src/types/approval-product.ts`
- `packages/core-backend/src/services/ApprovalAssigneeResolver.ts`
- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/tests/unit/approval-assignee-resolver.test.ts`
- `packages/core-backend/tests/unit/approval-graph-executor.test.ts`
- `packages/core-backend/tests/unit/approval-product-service.test.ts`
- `packages/core-backend/tests/unit/approval-admin-jump-service.test.ts`

No migrations, routes, UI, automation, Workflow Designer, SLA, breach, trigger-binding, backwrite, event-bridge, or add-sign/countersign files changed.

## Known Notes

The first ad hoc integration attempt was not counted because it did not use the integration Vitest config. The recorded DB signal above is the later `vitest.integration.config.ts` run against scratch PostgreSQL.

Two local dependency symlinks were created only so this isolated worktree could reuse the main checkout dependencies:

- `node_modules`
- `packages/core-backend/node_modules`

They are not part of the PR and must remain unstaged/removed before commit.
