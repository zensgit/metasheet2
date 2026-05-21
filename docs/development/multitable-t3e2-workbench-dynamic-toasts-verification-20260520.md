# T3E-2 Workbench Dynamic Toast i18n Verification

Date: 2026-05-20
Branch: docs/multitable-t3e2-workbench-dynamic-toasts-design-20260520
Status: implementation verified locally; not pushed

## 1. Definition Of Done

T3E-2 is complete when:

1. Workbench script-level dynamic toasts, fallback errors, and `window.confirm(...)` text use `workbench-labels.ts`.
2. `toast.formSubmitted` is retired and replaced by explicit `formSubmitSuccess(mode, isZh)`.
3. Dynamic count helpers use pluralized English and stable zh-CN count copy.
4. Raw runtime values remain raw: `e.message`, `workbench.error.value`, `grid.error.value`, `commentsState.error.value`, `result.firstError`, row indexes, record IDs, and template/user content.
5. Deferred surfaces remain untouched: `MetaBulkEditDialog.vue`, `ConditionalFormattingDialog.vue`, automation/T3D, and final audit.
6. Targeted tests, type-check, build, and diff hygiene pass; any known baseline failures are documented separately.

## 2. Scope Verified

Implementation files:

| File | Verification |
| --- | --- |
| `apps/web/src/multitable/utils/workbench-labels.ts` | Added T3E-2 fallback/confirm keys and 6 helpers; retired `toast.formSubmitted` |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | Replaced script-level hard-coded fallback/confirm/toast strings with `wb(...)` or dynamic helpers |

Test/doc files:

| File | Verification |
| --- | --- |
| `apps/web/tests/multitable-workbench-i18n.spec.ts` | Lockstep `ALL_KEYS` update; helper coverage for `formSubmitSuccess`, import/delete count helpers, failed-row formatting, and raw record ID |
| `apps/web/tests/multitable-workbench-import-flow.spec.ts` | Updated expected English import-count copy from `record(s)` to pluralized helper output |
| `apps/web/tests/multitable-workbench-view.spec.ts` | Added zh-CN sentinel for import success toast and updated English import-count baseline |
| `docs/development/multitable-t3e2-workbench-dynamic-toasts-design-20260520.md` | Approved design and scope gate |

## 3. Preflight And Residual Grep

Command:

```bash
rg -n "Failed to update timeline dates|Failed to update hierarchy parent|Form submit failed|Failed to update comment|Failed to add comment|Failed to resolve comment|Failed to delete comment|Failed to update linked records|Failed to create field|Failed to update field|Failed to delete field|Failed to create view|Failed to update view|Failed to delete view|Failed to refresh sheet access|Sheet creation requires|Created sheet but failed|Failed to create sheet|Failed to load base|Discard unsaved changes before leaving|Discard unsaved record changes|Leave the multitable while|Discard unsaved multitable changes|Failed to sync workbench context|Host multitable context|Base creation requires|Failed to create base|record\\(s\\) imported|duplicate row\\(s\\)|Import cancelled|Import failed|Excel export failed|record\\(s\\) deleted|Bulk delete failed|Record not found:|Failed to initialize workbench|toast\\.formSubmitted" \
  apps/web/src/multitable apps/web/tests docs/development/multitable-t3e2-workbench-dynamic-toasts-design-20260520.md
```

Classification:

| Category | Result |
| --- | --- |
| T3E-2 Workbench call-sites | Rewired to `wb(...)` or helper functions in `MultitableWorkbench.vue` |
| Label definitions | Expected hits in `workbench-labels.ts` |
| Test baselines | Expected hits in updated specs for English baseline and helper assertions |
| Raw lower-layer errors | Expected hits remain in `useMultitableComments.ts`, `useMultitableWorkbench.ts`, and `bulk-import.ts`; Workbench keeps `raw ?? localizedFallback` semantics |
| Adjacent manager surfaces | `meta-permission-labels.ts` field/view permission errors are already owned by T3C-2a and out of scope |
| Retired key | No source call-site remains for `toast.formSubmitted`; `ALL_KEYS` was updated lockstep |

## 4. Test Evidence

### Targeted Vitest

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-workbench-i18n.spec.ts \
  tests/multitable-workbench-import-flow.spec.ts \
  --watch=false
```

Result:

```text
✓ tests/multitable-workbench-i18n.spec.ts  (13 tests)
✓ tests/multitable-workbench-import-flow.spec.ts  (7 tests)

Test Files  2 passed (2)
Tests       20 passed (20)
```

The import-flow spec still emits existing `router-link` resolution warnings from the mock harness; exit code is 0.

### zh-CN Sentinel Render

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-workbench-view.spec.ts \
  -t "localizes workbench import success toast in zh-CN" \
  --watch=false
```

Result:

```text
✓ tests/multitable-workbench-view.spec.ts  (57 tests | 56 skipped)

Test Files  1 passed (1)
Tests       1 passed | 56 skipped (57)
```

### Known Workbench-View Baseline

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench-view.spec.ts --watch=false
```

Result:

```text
Test Files  1 failed (1)
Tests       1 failed | 56 passed (57)

FAIL tests/multitable-workbench-view.spec.ts > MultitableWorkbench view wiring > opens workflow designer with multitable context when automation is enabled
expected "spy" to be called with arguments: [ { name: 'workflow-designer', ... } ]
Number of calls: 0
```

This is a current baseline issue unrelated to T3E-2. The test sets `canManageAutomation = true`, but `apps/web/src/stores/featureFlags.ts` defaults `workflow: false`, and `MultitableWorkbench.vue` gates navigation with `featureFlags.hasFeature('workflow')`.

## 5. Type Check And Build

### Type Check

Command:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

```text
exit 0 / no output
```

### Build

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

```text
✓ 2412 modules transformed.
✓ built in 6.28s
```

Vite emitted existing chunk-size and mixed dynamic/static import warnings; no build failure.

## 6. Raw Boundary Checks

| Boundary | Verification |
| --- | --- |
| Runtime errors | `e.message`, `workbench.error.value`, `grid.error.value`, and `commentsState.error.value` remain first-choice raw strings |
| Import failures | `result.firstError` stays raw; row chrome is localized around the raw error |
| Row numbers | Import failure helper receives UI row numbers; code comment documents `rowIndex + 2` as 0-based row plus header offset |
| Record IDs | `recordNotFound(recordId, isZh)` localizes only surrounding chrome and keeps `recordId` raw |
| Confirm dialogs | Native browser dialogs remain browser-rendered; only their text is localized |
| Accessibility | T3E-2 modifies script-level `showSuccess`, `showError`, and `window.confirm` calls only; no new `aria`, `title`, or `placeholder` attributes were added |

## 7. Dependency Note

This was a fresh worktree. `pnpm install --frozen-lockfile` was required for local tools and touched tracked plugin/tool `node_modules` symlinks, matching previous metasheet2 worktree behavior. Those files are not part of this slice and must remain unstaged/uncommitted.

## 8. Deferred Surfaces

Deferred exactly as design-scoped:

| Deferred | Reason |
| --- | --- |
| `MetaBulkEditDialog.vue` and parent `bulkEditDialog.*` messages | T3E-3 owns bulk edit dialog copy and parent-generated dialog result strings together |
| `ConditionalFormattingDialog.vue` | T3E-3 owns condition-formatting rule/operator/color dialog chrome |
| T3D automation | Larger automation rule-domain surface; design MD required first |
| Final audit | Best after T3D and remaining T3E residual slices complete |

## 9. Closeout

T3E-2 local implementation meets the approved design gate. Remaining push/PR gate:

```bash
git diff --check origin/main..HEAD
```

Run after committing the targeted T3E-2 files only, excluding local `node_modules` install noise.
