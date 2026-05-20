# T3C2 - Base Picker i18n Verification

- **Date**: 2026-05-20
- **Scope**: `MetaBasePicker.vue` base switcher chrome.
- **Design packet**: `docs/development/multitable-t3c2-base-picker-i18n-design-20260520.md`
- **Status**: implemented and locally verified.

## Implementation Summary

- Added `meta-base-picker-labels.ts` with English/zh-CN labels and favorite aria helper.
- Rewired `MetaBasePicker.vue` to use `useLocale().isZh`.
- Updated `meta-base-picker.spec.ts` to assert:
  - English default badges are `Favorite` / `Recent`.
  - zh-CN chrome renders localized search/create placeholders, badges, favorite aria text, and empty/no-active-base states.
  - Base names stay raw in zh-CN.
  - Favorite toggle still does not emit a base selection.

## Boundary Check

| Area | Result |
|---|---|
| Backend/API/OpenAPI | Not touched |
| Migrations / `attendance_*` | Not touched |
| Direct `meta_*` writes | Not touched |
| Base persistence/order helpers | Not changed |
| Selection/create/favorite emits | Not changed |
| User-authored base names/icons | Preserved raw |

## Verification Commands

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/meta-base-picker.spec.ts \
  tests/multitable-base-local-state.spec.ts --watch=false
```

Result: PASS, 8 tests across 2 files.

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/meta-base-picker.spec.ts \
  tests/multitable-base-local-state.spec.ts --watch=false
```

Result: PASS, 8 tests across 2 files.

```bash
pnpm --filter @metasheet/web type-check
```

Result: PASS.

```bash
pnpm --filter @metasheet/web build
```

Result: PASS. Vite emitted the existing dynamic-import and large-chunk warnings only.

```bash
git diff --check
```

Result: PASS.

## Out-of-Scope Probe

I also probed `tests/multitable-workbench-view.spec.ts` as a broader adjacent suite. It currently fails locally on the existing `opens workflow designer with multitable context when automation is enabled` assertion because the workflow entry is gated by the `workflow` feature and the test searches the English `Workflow` button. That file mocks `MetaBasePicker`, so the failure is outside this slice and is not used as a BasePicker acceptance gate.

## Acceptance Notes

- The slice intentionally corrects a mixed-locale default: Chinese badges no longer appear in the English/default picker.
- The favorite aria helper interpolates raw base names; it only localizes surrounding action copy.
- This is independent from the broader field/view/permission manager i18n backlog.
