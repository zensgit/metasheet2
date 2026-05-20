# Multitable T3C Manager Panels I18n Verification

Date: 2026-05-20

Branch: `codex/multitable-t3c-manager-panels-i18n-20260520`

## Verification Summary

Status: PASS

This slice was verified with focused frontend tests, Vue type-checking, production build, and whitespace checks.

The branch was rebased onto the latest `origin/main` before final verification so it includes the already-merged T3B4/T3E/T3C2 slices and does not appear to delete their files.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-manager-panels-i18n.spec.ts tests/multitable-field-manager.spec.ts tests/multitable-view-manager.spec.ts tests/multitable-field-validation-panel.spec.ts tests/multitable-core-i18n.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web build
git diff --check
```

## Results

```text
tests/multitable-field-validation-panel.spec.ts  9 passed
tests/multitable-manager-panels-i18n.spec.ts     4 passed
tests/multitable-field-manager.spec.ts          18 passed
tests/multitable-view-manager.spec.ts           15 passed
tests/multitable-core-i18n.spec.ts              23 passed

Test Files  5 passed (5)
Tests       69 passed (69)
```

`pnpm --filter @metasheet/web type-check`: PASS

`pnpm --filter @metasheet/web build`: PASS

Build warning observed:

```text
WorkflowDesigner.vue is dynamically imported by appRoutes.ts but also statically imported by viewRegistry.ts and AttendanceWorkflowDesigner.vue.
```

This is an existing Vite chunking warning and is unrelated to the T3C manager-panel i18n slice.

`git diff --check`: PASS

## Install Noise Handling

The clean worktree did not have `node_modules`, so `pnpm install --frozen-lockfile` was required before tests. It rewrote tracked plugin/tool `node_modules` links as local install noise. Those generated changes were reverted with a targeted `git restore` before final status checks.

## Coverage Notes

The new i18n spec covers:

- Field manager zh-CN chrome.
- View manager zh-CN chrome.
- Field validation panel zh-CN chrome.
- Raw authored names in localized chrome.
- English default regression.

The existing manager-panel specs cover unchanged event payloads and config-save behavior.

`multitable-core-i18n.spec.ts` also covers the shared `fieldTypeLabel()` contract so T3C manager panels do not drift from T3A1 toolbar/filter/group labels.
