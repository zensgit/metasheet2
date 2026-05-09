# K3 WISE Setup Permission Gate Verification - 2026-04-30

## Scope

This verification covers the frontend permission gate for the K3 WISE setup
entry point.

It validates:

- `integration:write` can open the setup entry without `attendanceAdmin`.
- `attendanceAdmin` alone no longer exposes the ERP integration navigation link.
- `integration:write` implies `integration:read`.
- `integration:admin` and role `admin` satisfy integration setup checks.
- The route meta is enforced by the global router guard.

## Commands

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @metasheet/web exec vitest run \
  tests/useAuth.spec.ts \
  tests/k3WiseSetup.spec.ts \
  tests/platform-shell-nav.spec.ts \
  tests/App.spec.ts \
  --watch=false

pnpm --filter @metasheet/web run lint
pnpm --filter @metasheet/web run type-check
```

## Result

```text
Test Files  4 passed (4)
Tests       33 passed (33)
```

Additional checks:

```text
pnpm --filter @metasheet/web run lint        PASS
pnpm --filter @metasheet/web run type-check  PASS
git diff --check HEAD~1..HEAD                PASS
```

## Notes

- The isolated worktree did not have `node_modules`, so dependencies were
  installed locally before running Vitest.
- No customer K3 WISE credentials, customer tenant, SQL Server, or PLM endpoint
  were used.
- This is not a staging deployment signoff. Deployment signoff still requires
  authenticated K3 WISE postdeploy smoke against the target environment with
  `signoff.internalTrial=pass`.
