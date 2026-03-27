# PLM Workbench Autoload Identity Parity Verification

## Focused Verification

Commands:

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts
pnpm --filter @metasheet/web type-check
```

Results:

- focused Vitest passed
- `1` file / `31` tests passed
- frontend type-check passed

Covered:

- `matchPlmWorkbenchQuerySnapshot(...)` 继续忽略显式 `workbenchTeamView`
- `matchPlmWorkbenchQuerySnapshot(...)` 现在也忽略 `autoload`-only 差异
- `buildPlmWorkbenchRoutePath(...)` 仍继续保留 `autoload=true` transport

## Full Verification

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- full frontend Vitest passed
- `61` files / `470` tests passed
