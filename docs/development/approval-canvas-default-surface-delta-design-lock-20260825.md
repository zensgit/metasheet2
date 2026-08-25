# Approval canvas default-surface delta design lock (2026-08-25)

**Status: RATIFIED — owner direction on 2026-08-25: Canvas is the authoring surface; the ordinary-user legacy entry is retired.**

## 1. Delta

This delta supersedes only the ordinary-user fallback-entry clause in
`approval-canvas-v2-interaction-design-lock-20260721.md`.

1. Approval flow authoring opens directly on Canvas V2.
2. The `画布视图 / 辅助编辑模式` switch is not rendered. Authors configure selected nodes in the
   right inspector; no normal workflow depends on the structured list.
3. `APPROVAL_CANVAS_V2_ENABLED=false` retains the structured renderer for one release as an
   operator-only rollback. It is not an in-product authoring choice.
4. The rollback renderer is removed only after merged-main browser UAT confirms Canvas create,
   edit, save, publish validation, keyboard operation, and screen-reader navigation.

No graph contract, persistence shape, command algebra, or approval runtime semantics change.

## 2. Gates

| Gate | Required evidence |
|---|---|
| D1 | Unset flag opens Canvas; explicit `false` opens only the rollback renderer. |
| D2 | Ordinary UI contains no legacy view toggle or `辅助编辑模式` entry. |
| D3 | Condition and parallel configuration used by save tests is performed through the Canvas inspector. |
| D4 | Undo/redo, edge insertion, semantic drag, keyboard operation, inspector edits, and save payload tests remain green. |
| D5 | Required Web Tests, approval web guard, frontend typecheck, owner UAT smoke, and real-browser desktop/mobile smoke pass on the exact head. |

## 3. Rollback and removal

During the one-release fallback window, rollback means setting the flag to the exact literal
`false` and restarting the application. Invalid non-empty flag values also fail closed to the
rollback renderer; only unset or exact `true` selects Canvas. This does not reintroduce a
user-visible switch. After D5 is accepted in staging, removal of the structured renderer is a
separate deletion-only change with a search proof that no production route references it.
