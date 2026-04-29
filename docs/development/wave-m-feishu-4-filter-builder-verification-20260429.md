# Wave M Feishu 4 Filter Builder Verification - 2026-04-29

## Targeted Coverage

- `apps/web/tests/meta-toolbar-filter-builder.spec.ts`
  - Select fields render option dropdowns and update filter values without changing the rule shape.
  - Empty-value operators hide value controls and preserve `value: undefined`.
  - Add/retarget flows choose typed defaults for select and boolean fields.
  - Future `multiSelect` fields use option-backed filter controls instead of falling back to free text.
  - Dirty state shows explicit "Apply filter changes" copy.

## Commands

Run from `/tmp/ms2-mfeishu4-filter-polish-20260429`.

```bash
pnpm --filter @metasheet/web exec vitest run tests/meta-toolbar-filter-builder.spec.ts tests/multitable-grid.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
git diff --check
```

Final rebase verification:

- Rebased cleanly onto `origin/main@f76a105f7`.
- Reran target Vitest: 2 files passed, 38 tests passed.
- Reran `pnpm --filter @metasheet/web type-check`: passed.
- The first cleanup wrapper exited after successful tests because an existing
  `node_modules` directory required `rm -rf`; type-check was rerun separately
  and the worktree was left clean.

Forward-compatibility verification:

- Added a `multiSelect` fixture to the toolbar tests so the filter builder is merge-order safe with the parallel multi-select field PR.
- Reran target Vitest: 2 files passed, 39 tests passed.
- Reran `pnpm --filter @metasheet/web type-check`: passed.
- Reran `git diff --check`: passed.

Post-#1242 rebase verification:

- Rebased onto `origin/main@1bc4da47f` after the multi-select field PR landed.
- Updated the `multiSelect` toolbar assertion from fallback `is` to canonical `contains`.
- Reran target Vitest with the multi-select field spec included: 3 files passed, 43 tests passed.
- Reran `pnpm --filter @metasheet/web type-check`: passed.
- Reran `git diff --check`: passed.

## Notes

- The test scope is intentionally frontend-only; the change does not alter backend serialization or saved-view payloads.
- Full workspace validation remains out of scope for Lane C unless requested.
