# T3E-1 Presence + Template Residual i18n Verification

Date: 2026-05-20
Branch: docs/multitable-t3e1-residual-i18n-design-20260520
Status: implementation verified locally; not pushed

## 1. Definition Of Done

T3E-1 is complete when:

1. `MetaYjsPresenceChip` default label is locale-reactive and renders zh-CN as `正在协作`.
2. Explicit `label` props remain caller-controlled.
3. Workbench template-library load/install fallback strings use `workbench-labels.ts`.
4. User/data values remain raw: presence user IDs, template names, `e.message`, and `workbench.error.value`.
5. Targeted i18n specs, type-check, build, and diff hygiene pass.

## 2. Scope Verified

Implementation files:

| File | Verification |
| --- | --- |
| `apps/web/src/multitable/components/MetaYjsPresenceChip.vue` | Removed string default from `withDefaults()` and uses computed fallback via `metaCoreLabel('presence.collaboratingNow', isZh.value)` |
| `apps/web/src/multitable/utils/meta-core-labels.ts` | Added `presence.collaboratingNow` with explicit EN/ZH |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | Template-library fallback/toast strings now call `wb(...)` or `templateInstalled(...)` |
| `apps/web/src/multitable/utils/workbench-labels.ts` | Added `tpl.errorLoad`, 3 template-install toast keys, and `templateInstalled()` |

Test/doc files:

| File | Verification |
| --- | --- |
| `apps/web/tests/multitable-core-i18n.spec.ts` | Covers `presence.collaboratingNow` |
| `apps/web/tests/yjs-awareness-presence.spec.ts` | Covers zh-CN default label, explicit label preservation, and raw user IDs in title |
| `apps/web/tests/multitable-workbench-i18n.spec.ts` | Covers new Workbench keys and `templateInstalled()` raw template-name behavior |
| `docs/development/multitable-t3e1-presence-template-residual-i18n-design-20260520.md` | Includes preflight grep and event-time toast semantics |

## 3. Preflight Grep

Command:

```bash
rg -n "Collaborating now|Failed to load templates|Template installation requires|Installed template but failed|Installed |Failed to install template" apps/web/src/multitable apps/web/src/views apps/web/tests
```

Result:

```text
apps/web/src/multitable/views/MultitableWorkbench.vue:2156:    templateLibraryError.value = e.message ?? 'Failed to load templates'
apps/web/src/multitable/views/MultitableWorkbench.vue:2164:    showError('Template installation requires multitable write access.')
apps/web/src/multitable/views/MultitableWorkbench.vue:2175:    showError('Template installation requires multitable write access.')
apps/web/src/multitable/views/MultitableWorkbench.vue:2191:      showError(workbench.error.value ?? 'Installed template but failed to refresh workbench context')
apps/web/src/multitable/views/MultitableWorkbench.vue:2196:    showSuccess(`Installed ${result.template.name}`)
apps/web/src/multitable/views/MultitableWorkbench.vue:2198:    showError(e.message ?? 'Failed to install template')
apps/web/src/multitable/components/MetaYjsPresenceChip.vue:13:  label: 'Collaborating now',
```

Other `Installed` hits were under `AfterSalesView` and unrelated tests, so they are out of scope.

## 4. Test Evidence

### Targeted Vitest

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-core-i18n.spec.ts \
  tests/yjs-awareness-presence.spec.ts \
  tests/multitable-workbench-i18n.spec.ts \
  --watch=false
```

Result:

```text
✓ tests/multitable-workbench-i18n.spec.ts  (9 tests)
✓ tests/multitable-core-i18n.spec.ts  (23 tests)
✓ tests/yjs-awareness-presence.spec.ts  (3 tests)

Test Files  3 passed (3)
Tests       35 passed (35)
```

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
✓ built in 5.86s
```

Vite emitted existing chunk-size / mixed dynamic-static import warnings; no build failure.

## 5. Raw Boundary Checks

| Boundary | Verification |
| --- | --- |
| Explicit presence label | Existing `Editing now` spec remains and passes; default logic does not override caller-provided labels |
| Presence user IDs | zh-CN default spec asserts title `正在协作: user_alpha`; ID remains raw |
| Template names | `templateInstalled('CRM Pipeline', true)` returns `已安装 CRM Pipeline`; raw name preserved |
| Runtime errors | Workbench still uses `e.message ?? localizedFallback` and `workbench.error.value ?? localizedFallback` |
| Event-time toasts | `templateInstalled()` returns a string for the toast queue; later locale toggles do not retranslate old toasts, matching existing toast semantics |

## 6. Dependency Note

This was a fresh worktree without local `node_modules`, so the first Vitest attempt failed with:

```text
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found
```

`pnpm install --frozen-lockfile` fixed the local tool resolution. As in previous metasheet2 worktrees, install touched tracked plugin/tool `node_modules` symlinks. Those files are not part of this slice and must remain unstaged/uncommitted.

## 7. Deferred Surfaces

Deferred exactly as design-scoped:

| Deferred | Reason |
| --- | --- |
| T3E-2 Workbench dynamic toasts/fallbacks | Many interpolated strings; should be grep-classified separately |
| T3E-3 `MetaBulkEditDialog.vue` | Full dialog plus parent-generated messages belong together |
| T3E-3 `ConditionalFormattingDialog.vue` | Rule dialog/operator/color/confirm surface belongs together |
| T3D automation | Larger rule-domain surface; design MD required first |
| Final audit | Best after T3D/T3E residual slices complete |

## 8. Closeout

T3E-1 local implementation meets the design gate. Remaining push/PR gate:

```bash
git diff --check origin/main..HEAD
```

Run after committing the targeted T3E-1 files only, excluding local `node_modules` install noise.
