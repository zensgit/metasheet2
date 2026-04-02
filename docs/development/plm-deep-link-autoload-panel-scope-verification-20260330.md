# PLM Deep-Link autoload Panel-Scope Parity — Verification

**Date:** 2026-03-30
**Design:** [plm-deep-link-autoload-panel-scope-design-20260330.md](plm-deep-link-autoload-panel-scope-design-20260330.md)

## Gap summary

`buildDeepLinkParams` in `PlmProductView.vue` used a panel-scope-unaware
inline check to derive the `autoload` flag for return-path URLs.  When the
active panel was `cad` but product context was present from a prior
navigation, the return path incorrectly carried `autoload=true`, causing
the autoload hydration path to clear product/BOM/documents/approvals data
on return from audit.

## Files changed

| File | Change |
|------|--------|
| `apps/web/src/views/PlmProductView.vue` | Import `shouldAutoloadPlmWorkbenchSnapshot`; replace inline derivation with canonical call |
| `apps/web/tests/plmWorkbenchViewState.spec.ts` | +1 test (5 assertions): `shouldAutoloadPlmWorkbenchSnapshot` panel-scope-aware behavior |

## Commands run

### 1. Focused test

```
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts
```

**Result:** 1 file, 42 tests — all passed.

### 2. Type-check

```
pnpm --filter @metasheet/web type-check
```

**Result:** Clean exit (0), no errors.

### 3. Full PLM test suite

```
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

**Result:** 67 files, 618 tests — all passed.

## Test counts

| Suite | Files | Tests | Status |
|-------|-------|-------|--------|
| Focused (changed file) | 1 | 42 | PASS |
| All PLM specs | 67 | 618 | PASS |
| Type-check (vue-tsc) | — | — | PASS |

## Verification checklist

- [x] `shouldAutoloadPlmWorkbenchSnapshot({ panel: 'cad', productId: 'product-42' })` → `false`
- [x] `shouldAutoloadPlmWorkbenchSnapshot({ panel: 'cad', cadFileId: 'cad-main', productId: 'product-42' })` → `true` (cadFileId triggers it)
- [x] `shouldAutoloadPlmWorkbenchSnapshot({ panel: 'documents', productId: 'product-42' })` → `true`
- [x] `shouldAutoloadPlmWorkbenchSnapshot({ productId: 'product-42' })` → `true` (no panel = all panels)
- [x] `shouldAutoloadPlmWorkbenchSnapshot({ panel: 'cad', itemNumber: 'P-1001' })` → `false`
- [x] `buildDeepLinkParams(true)` now delegates to `shouldAutoloadPlmWorkbenchSnapshot` instead of inline check
- [x] All 618 PLM tests pass
- [x] Type-check clean
