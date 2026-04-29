# Wave M-Feishu-2 Verification - Formula / View Builder / Gantt

Date: 2026-04-29

Branch: `codex/mfeishu2-formula-view-gantt-20260429`

Base after final rebase: `origin/main@0635dc2a8`

## Automated Verification

### Focused Frontend Specs

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-formula-editor.spec.ts \
  tests/multitable-view-manager.spec.ts \
  tests/multitable-gantt-view.spec.ts \
  --reporter=verbose
```

Result:

```text
Test Files  3 passed (3)
Tests       19 passed (19)
```

Covered:

- Formula docs search and diagnostics.
- Formula field chips insert backend-compatible `{fld_xxx}` tokens.
- Formula save blocks unknown field references.
- View manager still persists timeline config and preserves conditional formatting.
- View manager persists visual filter / sort / group settings.
- Gantt resolver chooses sensible defaults.
- Gantt renders grouped task bars and emits record selection.
- Gantt toolbar emits persisted config and `groupInfo`.

### Frontend Type Check

Command:

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result:

```text
EXIT 0
```

### Diff Hygiene

Command:

```bash
git diff --check
```

Result:

```text
EXIT 0
```

### Final Rebase Verification

After #1228 (`fix(formula): add DATEDIFF runtime alias`) merged to main, this branch was rebased onto `origin/main@0635dc2a8` and the same focused gate was rerun.

Result:

```text
Focused frontend specs: 3 files / 19 tests passed
Frontend type check:    EXIT 0
Diff hygiene:           EXIT 0
```

## Manual Staging Checklist

After deployment, verify the following in a normal multitable sheet:

1. Create or edit a formula field.
2. Click a source field chip and confirm the expression uses `{fld_xxx}`, not `{Field Name}`.
3. Search a function such as `SUM` or `IF`; click the function card and confirm a snippet is inserted.
4. Save a formula with an unknown `{fld_missing}` reference and confirm the UI blocks save.
5. Open `Views -> Configure` for a grid view.
6. Add a filter, sort, and group rule; save; reload; confirm the settings hydrate back.
7. Create a `gantt` view.
8. Select start/end/title/progress/group fields and confirm task bars render.
9. Click a Gantt task and confirm the record drawer opens.

## Known Limits

- Gantt is a frontend record visualization, not a full project-management engine.
- Gantt does not support dependencies, hierarchy, critical path, drag-resize, or baseline tracking yet.
- Formula docs are editor-side guidance for the frontend editor. `DATEDIFF` runtime support is covered by companion #1228; other newly documented functions should stay aligned with backend formula-engine support before being exposed.
- View builder shares existing sort/filter operator semantics. It does not add nested filter groups.
