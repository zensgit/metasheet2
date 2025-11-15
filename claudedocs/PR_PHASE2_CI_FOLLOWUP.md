# chore(v2-ci): migrate list fix + web typecheck (non-blocking) + report update

## Purpose
- Fix `migrate --list` undefined variables to align listing with execution flow and env filters.
- Add non-blocking web typecheck for `@metasheet/web` to surface TS health without blocking merges.
- Add minimal shims to keep strict `vue-tsc -b` green for third‑party modules.
- Append a “后续确认” section to Phase 2 CI Fix Report documenting these CI/observability alignments.

## Changes
- metasheet-v2/packages/core-backend/src/db/migrate.ts:204
  - Replace `migrationsDir/filesWithPath` usage in list branch with collected entries + include/exclude filters.
- .github/workflows/web-typecheck-v2.yml:1
  - New, runs `pnpm -F @metasheet/web exec vue-tsc -b`, `continue-on-error: true`, uploads logs on failure.
- metasheet-v2/apps/web/src/shims.d.ts:1
  - Add `x-data-spreadsheet` and `*.css` declarations.
- metasheet-v2/claudedocs/PHASE2_CI_FIX_REPORT.md: added “后续确认（2025-10-29）” documenting the above.

## Verification
1) Migration list parity
- Command: `pnpm -F @metasheet/core-backend db:list`
- Expect: List honors `MIGRATION_INCLUDE/EXCLUDE`; Summary shows accurate Total/Applied/Pending.

2) Web typecheck CI
- Trigger: open/sync PR that touches `metasheet-v2/apps/web/**`.
- Expect: `v2-web-typecheck` runs, executes `vue-tsc -b`, surfaces errors as logs (non-blocking).

3) Local build (optional)
- `pnpm -F @metasheet/web build` — ensures `vue-tsc -b && vite build` pass with added shim.

## Impact
- No runtime behavior change.
- CI observability improved; safer migration listing.

## Rollback
- Revert this PR; no data migrations included.

## Notes
- MIGRATION_EXCLUDE sets differ slightly between root and v2 workflows by design; keep as‑is unless policy changes.
- Consider making `v2-web-typecheck` Required once baseline stabilizes.

