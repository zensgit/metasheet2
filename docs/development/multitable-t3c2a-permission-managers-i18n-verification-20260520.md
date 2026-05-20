# T3C-2a - Permission Managers i18n Verification

- **Date**: 2026-05-20
- **Branch**: `codex/multitable-t3c2a-permission-i18n-20260520`
- **Base**: `origin/main@27d82f99b`
- **Design**: `docs/development/multitable-t3c2a-permission-managers-i18n-design-20260520.md`
- **Design SHA256**: `a88463acdc2a63125e5ac94fef0814b3a91219fe4917ca5f13aa66ca68ae883d`

## Scope Verified

Implemented:

- New permission chrome label module:
  - `apps/web/src/multitable/utils/meta-permission-labels.ts`
- Localized permission manager components:
  - `apps/web/src/multitable/components/MetaRecordPermissionManager.vue`
  - `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
- Test coverage:
  - `apps/web/tests/meta-permission-labels.spec.ts`
  - `apps/web/tests/multitable-record-permission-manager.spec.ts`
  - `apps/web/tests/multitable-sheet-permission-manager.spec.ts`

Out of scope and not touched:

- `MetaFormShareManager.vue`
- `MetaApiTokenManager.vue`
- backend routes, migrations, OpenAPI, automation, K3, approval, attendance runtime
- new a11y structure or new close-button aria/title coverage

## Design Gates

| Gate | Result |
|---|---|
| EN baseline | PASS. Existing English chrome remains the default locale. |
| zh-CN chrome | PASS. Record, sheet, field, and view permission chrome localizes. |
| Raw preserve | PASS. Subject names, ids, field names, view names, raw field/view type ids, and ACL values stay raw. |
| Data-attr safety | PASS. `data-access-level` remains raw. Field permission badges use `hidden` / `readonly` raw values, not localized display text. |
| Helper redeclare | PASS. No new `fieldTypeLabel`, `accessLevelLabel`, `subjectType*Label`, or field-type map was introduced in the T3C-2a module/components. |
| Plural fork | PASS. `fieldStatusClearedOrphans` and `viewStatusClearedOrphans` keep the English `count === 1 ? '' : 's'` fork. |
| A11y boundary | PASS. Existing placeholders were localized; no new aria/title structure was added. |

## M1-Class Trap

The design review pre-caught the CSS-selector binding trap before implementation:

- Before: field permission badge `data-access-level` used display strings such as `Hidden` and `Read-only`.
- Risk: zh-CN localization could put localized strings into `data-access-level`, breaking CSS selectors.
- Fix: component now binds `data-access-level` to raw values from `fieldPermDraftValue(...)`; CSS selectors use `hidden` and `readonly`.

This is an M1-class literal-coupled UI trap caught during design, not during implementation review.

## Commands Run

Dependency setup for this isolated worktree:

```bash
pnpm install --frozen-lockfile --prefer-offline
```

Result: PASS. Reused local pnpm store, downloaded 0 packages. The install rewrote several tracked plugin/tool `node_modules` shims; those generated verification-environment changes were restored and are not part of this slice.

Targeted tests:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/meta-permission-labels.spec.ts \
  tests/multitable-record-permission-manager.spec.ts \
  tests/multitable-sheet-permission-manager.spec.ts
```

Result:

```text
Test Files  3 passed (3)
Tests       32 passed (32)
```

Type-check:

```bash
pnpm --filter @metasheet/web type-check
```

Result: PASS.

Build:

```bash
pnpm --filter @metasheet/web build
```

Result: PASS.

Note: Vite emitted the existing chunk-size warnings and the existing `WorkflowDesigner.vue` dynamic/static import warning. No T3C-2a-specific build error occurred.

Whitespace:

```bash
git diff --check
```

Result: PASS.

Focused helper/selector grep:

```bash
rg -n "fieldTypeLabel|function accessLevelLabel|function subjectType.*Label|FIELD_TYPE_LABELS|data-access-level='Hidden'|data-access-level='Read-only'|data-access-level=\"fieldPermDraftLabel" \
  apps/web/src/multitable/utils/meta-permission-labels.ts \
  apps/web/src/multitable/components/MetaRecordPermissionManager.vue \
  apps/web/src/multitable/components/MetaSheetPermissionManager.vue
```

Result: PASS, no matches.

Shared action placement grep:

```bash
rg -n "action\\.(save|remove|clear|apply)'" apps/web/src/multitable/utils/meta-permission-labels.ts
rg -n "action\\.(save|remove|clear|apply)'" apps/web/src/multitable/utils/meta-manager-labels.ts
```

Result: PASS. `meta-permission-labels.ts` has 0 matches; `meta-manager-labels.ts` owns the four shared manager actions (`save`, `remove`, `clear`, `apply`).

## Test Matrix Detail

| Test file | Added / verified coverage |
|---|---|
| `meta-permission-labels.spec.ts` | Static label mapping, access/state display helpers, subject badge helpers, orphan singular/plural helpers, field/view override summary helpers. |
| `multitable-record-permission-manager.spec.ts` | EN default chrome, zh-CN record chrome, raw user/email/group data preserve, raw `data-access-level`, raw select option values. |
| `multitable-sheet-permission-manager.spec.ts` | EN default chrome, zh-CN sheet/field/view tabs, raw subject/field/view data preserve, raw `data-access-level`, raw select option values for sheet/field/view ACL states. |

## Final State

The implementation is ready for review/push after a final `git fetch origin && git rebase origin/main` check. If the PR goes `BEHIND` during CI due to parallel i18n merges, update with `git push --force-with-lease`, not plain `--force`.
