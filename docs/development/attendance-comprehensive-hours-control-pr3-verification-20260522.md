# Attendance Comprehensive Working Hours Control PR3 Verification

Date: 2026-05-22
Branch: `codex/attendance-comprehensive-hours-preview-ui-20260522`

## Verification Focus

| Focus | Evidence |
| --- | --- |
| Read-only UI | The section only calls `POST /api/attendance/comprehensive-hours/preview`; it has no Save, Apply, Enforce, Create, Edit, or Delete button. |
| Backend authority | The frontend does not duplicate formula or comprehensive-hours validation. Backend preview remains the active validator and period resolver. |
| Explicit scope | UI exposes only single user and explicit user-list modes. All-users batch is not present. |
| Admin navigation | Admin rail count and quick-jump behavior include the new Scheduling section. |
| No backend scope creep | No plugin, migration, or persistence file is touched in this slice. |

## Test Coverage

| Test | Coverage |
| --- | --- |
| `runs the read-only comprehensive hours preview without write controls` | Mounts admin page, opens the new section, fills `userId`, runs preview, asserts request body, read-only result rendering, violation row, and absence of write buttons. |
| `jumps to the comprehensive hours preview from the quick selector` | Locks the new section id, quick-jump selection, current-section label, and mounted panel. |
| Existing admin anchor count tests | Updated from 24 to 25 to prevent accidental nav deletion while adding this section. |

## Commands

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/attendance-admin-regressions.spec.ts \
  tests/attendance-admin-anchor-nav.spec.ts \
  --watch=false

pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web build
git diff --check
```

## Deferred

- PR4 weak-control warning on schedule save.
- PR5 strong-control block-save guard.
- PR6 reporting or multitable snapshot.
- Staging live UI evidence, after explicit staging credentials and sample users are provided.
