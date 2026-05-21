# T3E-3 Bulk Edit + Conditional Formatting i18n Verification

Date: 2026-05-21
Branch: `frontend/multitable-t3e3-bulk-formatting-i18n-20260521`
Status: implementation verified locally; not pushed

## 1. DoD

PASS criteria:

- Bulk edit dialog chrome is locale-aware via new `meta-bulk-edit-labels.ts`.
- Workbench bulk edit parent result/error messages use bulk helper fallbacks and keep record ids/reasons raw.
- Conditional formatting dialog chrome is locale-aware via `meta-manager-labels.ts` `formatting.*` keys/helpers.
- Existing aria/placeholder text is localized where present; no new a11y attributes or selector-bearing data attributes are introduced.
- Targeted specs, `vue-tsc`, build, and `git diff --check` pass.

## 2. Local Verification

Targeted specs:

```text
✓ tests/meta-bulk-edit-labels.spec.ts  (6 tests)
✓ tests/conditional-formatting-dialog-i18n.spec.ts  (4 tests)
✓ tests/multitable-bulk-edit-dialog.spec.ts  (15 tests)
✓ tests/multitable-manager-panels-i18n.spec.ts  (5 tests)

Test Files  4 passed (4)
Tests       30 passed (30)
```

Type check:

```text
pnpm --filter @metasheet/web exec vue-tsc --noEmit
exit=0
```

Build:

```text
pnpm --filter @metasheet/web build
✓ built in 6.00s
```

Diff check:

```text
git diff --check
exit=0
```

Build warning note: Vite reported the existing WorkflowDesigner dynamic/static import chunking warning and large chunk warnings. These are pre-existing build warnings and not T3E-3 regressions.

## 3. Preflight / Reachability Evidence

Manager reuse-key reachability:

```text
apps/web/src/multitable/utils/meta-manager-labels.ts:11:  | 'action.configure' | 'action.conditionalFormatting' | 'action.rename'
apps/web/src/multitable/utils/meta-manager-labels.ts:14:  | 'action.cancel' | 'action.reloadLatest' | 'action.dismiss'
apps/web/src/multitable/utils/meta-manager-labels.ts:15:  | 'action.add' | 'action.addOption' | 'action.save' | 'action.remove'
apps/web/src/multitable/utils/meta-manager-labels.ts:72:  | 'view.discardFormattingConfirm'
apps/web/src/multitable/utils/meta-manager-labels.ts:101:  'action.conditionalFormatting': { en: 'Conditional formatting', zh: '条件格式' },
apps/web/src/multitable/utils/meta-manager-labels.ts:108:  'action.cancel': { en: 'Cancel', zh: '取消' },
apps/web/src/multitable/utils/meta-manager-labels.ts:114:  'action.remove': { en: 'Remove', zh: '移除' },
apps/web/src/multitable/utils/meta-manager-labels.ts:248:  'view.discardFormattingConfirm': { en: 'Discard unsaved formatting rules?', zh: '放弃未保存的格式规则吗？' },
```

Residual source-string grep classification:

| Residual | Classification |
| --- | --- |
| Bulk edit source strings under `meta-bulk-edit-labels.ts` | Expected label definitions |
| Conditional formatting source strings under `meta-manager-labels.ts` | Expected label definitions |
| Bulk/formatting source strings under tests | Expected EN baseline assertions |
| `record(s)` under `meta-import-labels.ts` / import modal tests | Pre-existing import-modal surface, out of T3E-3 scope |
| `does not contain` under `useMultitableGrid.ts` | Pre-existing grid filter operator surface, out of T3E-3 scope |

## 4. Design Fidelity

Bulk edit:

- Added `apps/web/src/multitable/utils/meta-bulk-edit-labels.ts`.
- Did not add bulk edit keys to `meta-core-labels.ts` or `meta-manager-labels.ts`.
- `MetaBulkEditDialog.vue` now uses `useLocale()` and `bulkEditLabel(...)`.
- The clear hint keeps `<strong>{{ selectedField.name }}</strong>` in the template; no HTML helper or `v-html`.
- `bulkClearHintPrefix/Suffix` preserve intentional whitespace and are byte-exact tested.
- `bulkFailure(...)` and `bulkVersionConflict(...)` conditionally omit parentheses when raw details are empty.

Conditional formatting:

- Extended `meta-manager-labels.ts` with `formatting.*` keys plus `formattingOperatorLabel(...)` and `formattingPickColor(...)`.
- Reused `managerLabel('action.cancel')`, `managerLabel('action.remove')`, and `managerLabel('view.discardFormattingConfirm')`.
- Operator render spec covers number, text, select, multiSelect, boolean, and date field types with representative labels.
- Select option values, field names, and color hex values remain raw.
- `▲ Up` / `▼ Down` keep the glyph and localize the visible word; no new aria-label was needed because the button text is still readable.

## 5. A11y Boundary

T3E-3 localizes existing aria/placeholder text:

- `MetaBulkEditDialog.vue`: dialog aria label, close aria label, field select aria label.
- `ConditionalFormattingDialog.vue`: dialog aria label, close aria label, min/max placeholders, color swatch aria labels.

T3E-3 does not add new aria/title/placeholder attributes. The conditional-formatting render spec locks the current aria-bearing node count for the 6-rule fixture at `50` (dialog + close + 6 rules * 8 palette swatches).

## 6. Raw Boundary

Preserved raw:

- Bulk field names through mustache rendering.
- Bulk failure record ids and reasons in `sampleFailures`.
- Bulk runtime/backend `e?.message` for non-version-conflict errors.
- Conditional formatting field names.
- Conditional formatting select option values, including user-authored Chinese values.
- Conditional formatting color hex values and `#RRGGBB` format token.
- Persisted operator enum values and rule ids.

## 7. Worktree Note

This alt-worktree initially had no `node_modules`, so `pnpm --filter @metasheet/web exec vitest ...` failed before tests with:

```text
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found
```

I ran `pnpm install` in this worktree to enable local verification. It produced tracked `node_modules` symlink noise under plugin/tool package folders. Those paths are not part of the T3E-3 slice and must not be staged; use targeted `git add` for the T3E-3 files only.
