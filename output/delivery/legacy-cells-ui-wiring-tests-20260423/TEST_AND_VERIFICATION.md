# Test And Verification - Legacy Cells UI Version Wiring

Date: 2026-04-23

## Summary

Added view-level frontend coverage for the legacy spreadsheet cells optimistic-locking flow.

This verifies that the two legacy editors wired in PR #1092 actually send `expectedVersion` from real UI interactions and do not show success after a backend `VERSION_CONFLICT`.

## Files

- `apps/web/tests/spreadsheet-detail-cell-version-wiring.spec.ts`
- `apps/web/tests/grid-view-cell-version-wiring.spec.ts`
- `docs/development/legacy-cells-ui-wiring-tests-development-20260423.md`
- `docs/development/legacy-cells-ui-wiring-tests-verification-20260423.md`

## Verification

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/spreadsheet-detail-cell-version-wiring.spec.ts \
  tests/grid-view-cell-version-wiring.spec.ts \
  --reporter=dot
```

Passed: 5/5 tests.

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/spreadsheet-cell-versioning.spec.ts \
  --reporter=dot
```

Passed: 4/4 tests.

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Passed.

```bash
git diff --check
```

Passed.

## Conclusion

The frontend optimistic-locking contract is now covered at both helper level and view wiring level:

- Helper tests validate version cache and payload construction.
- New view tests validate real component save flows.
- Live/staging API smoke from PR #1096 validates backend conflict behavior against the deployed service.
