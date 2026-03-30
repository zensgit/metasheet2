# PLM Panel-Scope Contract Unification — Verification

**Date:** 2026-03-30
**Design:** [plm-panel-scope-contract-unification-design-20260330.md](plm-panel-scope-contract-unification-design-20260330.md)

## Gap summary

`normalizePlmWorkbenchPanelScope` used a private duplicate of the panel key
list instead of the authoritative `PLM_PANEL_KEYS` from the contracts
module.  The duplicate created a drift risk: a panel key added to the
contract but missed in the local copy would be silently stripped from share
URLs and return paths.

## Files changed

| File | Change |
|------|--------|
| `apps/web/src/views/plm/plmWorkbenchViewState.ts` | Import `PLM_PANEL_KEYS` from contract; delete 9-line local duplicate |
| `apps/web/tests/plmWorkbenchViewState.spec.ts` | +1 test (3 assertions): authoritative key acceptance, individual key survival, canonical order preservation |

## Commands run

### 1. Focused test

```
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts
```

**Result:** 1 file, 43 tests — all passed.

### 2. Type-check

```
pnpm --filter @metasheet/web type-check
```

**Result:** Clean exit (0), no errors.

### 3. Full PLM test suite

```
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

**Result:** 68 files, 658 tests — all passed.

## Test counts

| Suite | Files | Tests | Status |
|-------|-------|-------|--------|
| Focused | 1 | 43 | PASS |
| Full PLM suite | 68 | 658 | PASS |
| Type-check | — | — | PASS |

## Verification checklist

- [x] `normalizePlmWorkbenchPanelScope(key)` accepts every `PLM_PANEL_KEYS` entry
- [x] Canonical order matches `PLM_PANEL_KEYS` declaration order
- [x] `normalizePlmWorkbenchPanelScope('unknown')` returns `undefined`
- [x] All 658 PLM tests pass
- [x] Type-check clean
