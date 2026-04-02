# PLM Recommendation Filter Lost on focus-source — Verification

**Date:** 2026-04-01
**Design:** [plm-recommendation-filter-focus-source-design-20260401.md](plm-recommendation-filter-focus-source-design-20260401.md)

## Bug found: YES

**Reproduction:** Open audit → view recommendations with `recent-default`
filter → click a card (focusAuditTeamViewManagement) → share → click
`focus-source` in followup → filter resets to "all" instead of staying
on `recent-default`.

## Files changed

| File | Change |
|------|--------|
| `apps/web/src/views/PlmAuditView.vue` | Pass `sourceRecommendationFilter` in `focusAuditTeamViewManagement` handoff |
| `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts` | +2 tests: filter preserved through round-trip, omission defaults to `''` |

## Commands run

### 1. Focused test

```
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts
```

**Result:** 1 file, 57 tests — all passed.

### 2. Type-check

```
pnpm --filter @metasheet/web type-check
```

**Result:** Clean exit (0), no errors.

### 3. Full PLM test suite

```
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

**Result:** 68 files, 664 tests — all passed.

## Test counts

| Suite | Files | Tests | Status |
|-------|-------|-------|--------|
| Focused | 1 | 57 | PASS |
| Full PLM suite | 68 | 664 | PASS |
| Type-check | — | — | PASS |
