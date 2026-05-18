# Multitable Workbench Base Picker Quick Access Development

Date: 2026-05-18

Branch: `codex/multitable-workbench-base-picker-quick-access-20260518`

## Goal

Carry the `/multitable` home quick-access model into the Workbench base switcher so the primary in-product Base picker honors browser-local favorites and recent opens.

## Scope

In scope:

- Reuse `base-local-state.ts` for Workbench Base picker ordering.
- Render favorite and recent badges in `MetaBasePicker`.
- Let users toggle favorite state from the Workbench picker without selecting/switching the Base.
- Record recent opens after successful Workbench context loads, successful Base switches, and successful template installs.
- Add focused component and Workbench tests.

Out of scope:

- No backend routes, database migrations, OpenAPI changes, or permission changes.
- No server-side/cross-device favorites.
- No Data Factory, K3, DingTalk, Attendance, or Phase 3 TODO changes.

## Design

`MultitableWorkbench.vue` continues to keep raw API Bases in `bases`. It now derives `basePickerBases` through:

```ts
decorateAndSortBases(bases.value, favoriteBaseIds.value, recentBaseOpens.value)
```

This keeps sorting deterministic and aligned with the `/multitable` home entry:

- favorites first
- recent opens by newest `openedAt`
- untouched Bases in original API order
- stale localStorage IDs ignored

`MetaBasePicker.vue` remains presentational. It receives decorated Bases, renders badges, emits `toggle-favorite`, and uses `@click.stop` on the favorite button so toggling does not also emit `select`.

## Recent Recording

Recent-open state is updated only after successful context transitions:

- initial Workbench context load returns success and has an active Base
- `workbench.switchBase(baseId)` returns `true`
- `workbench.syncExternalContext(...)` returns `true` after template install

Failed switches or failed context loads do not update localStorage.

## Parallel Scout

A read-only scout inspected `MetaBasePicker.vue`, `MultitableWorkbench.vue`, and Workbench tests. Its main constraints were adopted:

- keep localStorage best-effort and non-blocking
- preserve sheet-anchored URL behavior
- use `@click.stop` for favorite toggles
- extend the existing Workbench stub rather than broadening the test harness

## Files

- `apps/web/src/multitable/components/MetaBasePicker.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/tests/meta-base-picker.spec.ts`
- `apps/web/tests/multitable-workbench-view.spec.ts`
- `docs/development/multitable-workbench-base-picker-quick-access-development-20260518.md`
- `docs/development/multitable-workbench-base-picker-quick-access-verification-20260518.md`

## Rollback

Revert this PR. No persistent backend state is introduced. Browser-local favorite/recent keys are harmless if the UI stops reading them.

