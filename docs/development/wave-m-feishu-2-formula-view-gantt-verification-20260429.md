# Wave M-Feishu-2 Verification - Formula / View Builder / Gantt

Date: 2026-04-29

Branch: `codex/mfeishu2-formula-view-gantt-20260429`

Base after rebase: `origin/main@6a99c117d`

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
- Formula docs are editor-side guidance only; unsupported backend functions still require backend formula-engine work.
- View builder shares existing sort/filter operator semantics. It does not add nested filter groups.
