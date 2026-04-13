# Platform Shell Wave 1 Tenant Isolation And Installer Consistency Verification

Date: 2026-04-13

## Verified Behavior

### Tenant isolation hardening

- Authenticated requests without tenant scope no longer map to `workspace_id = 'default'`.
- `/api/platform/apps/:appId` returns `instance: null` and skips registry queries when tenant scope is absent.
- `GET /api/after-sales/projects/current` returns `401` when a user is authenticated but tenant scope is unresolved.
- `POST /api/after-sales/projects/install` returns `401` for the same missing-tenant condition.

### Installer consistency hardening

- When `platform_app_instances.upsertInstance()` throws during after-sales install:
  - install route returns `500`
  - error code is `platform-instance-write-failed`
  - install ledger row is rewritten with `status = failed`
  - ledger warnings include the registry failure reason

## Automated Verification

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/platform-apps-router.test.ts \
  tests/unit/after-sales-plugin-routes.test.ts
```

Result:

- `2` test files passed
- `122` tests passed

Coverage of the new regression paths:

- platform apps router no longer falls back to `default`
- after-sales current returns `401` without tenant scope
- after-sales install returns `401` without tenant scope
- after-sales install persists failed ledger state on registry write failure

Additional build verification:

```bash
pnpm --filter @metasheet/core-backend build
```

Expected result:

- backend package builds successfully after the installer and route changes
