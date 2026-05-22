# Multitable Calendar Holiday Sync Hint Verification - 2026-05-22

## Local Checks

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/calendar-holiday-notice.spec.ts \
  tests/multitable-calendar-view.spec.ts \
  tests/meta-view-render-labels.spec.ts \
  --watch=false
```

Result: PASS. `3` files, `21` tests.

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result: PASS.

```bash
pnpm --filter @metasheet/web build
```

Result: PASS. Vite completed with the existing large-chunk warning only.

```bash
git diff --check origin/main...HEAD
```

Result: PASS.

## Test Matrix

| Case | Coverage |
| --- | --- |
| Empty holiday data in a likely public-holiday range | `calendar-holiday-notice.spec.ts` returns a localized hint |
| Empty holiday data in July/August | `calendar-holiday-notice.spec.ts` returns `null` |
| Non-empty/ready holiday data | `calendar-holiday-notice.spec.ts` returns `null` |
| Calendar component notice rendering | `multitable-calendar-view.spec.ts` asserts `.meta-calendar__notice` and `role=status` |
| Bilingual label table completeness | `meta-view-render-labels.spec.ts` covers all label keys |

## Manual Entity-Machine Expectation

With 2026 holiday data synced, no notice should appear in May/June because
holiday chips are present.

If an operator clears or has not synced attendance holidays, May/June calendar
ranges should show the hint instead of silently displaying only lunar labels.

## Deployment Impact

Frontend-only. No migration, no package script change, no backend route change,
no integration-core change.

## Gate Impact

This does not affect #1709 / #1711. Customer GATE remains unchanged, and no K3
Save / Submit / Audit path is touched.
