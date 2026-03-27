# PLM Workbench Filter-Field Deep-Link Normalization Verification

## Focused Verification

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts
```

Result:

- Passed
- `1` file / `30` tests

Covered assertions:

- collaborative snapshot 会剥掉 field-only `bomFilterField / whereUsedFilterField`
- local route snapshot 会剥掉 field-only `bomFilterField / whereUsedFilterField`
- workbench share URL 不会再携带没有 filter value 的 `whereUsedFilterField`
- `buildPlmWorkbenchRoutePath(...)` 不会再把 field-only 状态写进 return path
- 有真实 filter value 时，`bomFilterField` 仍然继续保留

## Full Verification

Commands:

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Results:

- frontend type-check passed
- full frontend Vitest passed
- `60` files / `466` tests passed
