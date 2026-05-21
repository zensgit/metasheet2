# T3C-2b Form Share Manager i18n Verification

Date: 2026-05-20
Branch: `codex/multitable-t3c2b-form-share-i18n-20260520`
Base: `origin/main@62e179de3`

## DoD

T3C-2b is complete only if all of these hold:

- `MetaFormShareManager.vue` responds to `useLocale().isZh`.
- Shared `Remove` action comes from `meta-manager-labels.ts`.
- User/group names, subtitles, token values, access-mode enum values, and backend errors stay raw.
- Targeted specs pass.
- Frontend type-check and production build pass.
- `git diff --check` is clean.

## Verification Commands

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-form-share-labels.spec.ts \
  tests/multitable-form-share-manager.spec.ts \
  --watch=false

pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check
```

## Results

Targeted specs:

```text
✓ tests/meta-form-share-labels.spec.ts  (5 tests)
✓ tests/multitable-form-share-manager.spec.ts  (18 tests)

Test Files  2 passed (2)
Tests       23 passed (23)
```

Type-check:

```text
pnpm --filter @metasheet/web exec vue-tsc --noEmit
exit 0
```

Build:

```text
pnpm --filter @metasheet/web build
✓ built in 6.09s
```

Build warnings:

- Existing Vite chunk warning for `WorkflowDesigner.vue` dynamic/static import.
- Existing chunk-size warnings.
- No T3C-2b-specific build failure.

Diff check:

```text
git diff --check
exit 0
```

## Regression Matrix

| Area | Evidence |
| --- | --- |
| English form-share behavior | Existing `multitable-form-share-manager.spec.ts` cases still pass under explicit `en` locale. |
| zh-CN visible chrome | New render assertion covers title, toggle, status, access mode, audience rule, allowlist summary, DingTalk status labels, link/expiry/action text. |
| Raw subject values | zh-CN render assertion still sees `Authorized User` and `Ops`. |
| Shared action hub | `Remove` buttons render through `managerLabel('action.remove', isZh)`. |
| Backend error boundary | Component still prefers `err.message` before localized fallback errors. |
| API/contract scope | No backend, OpenAPI, migration, or API client changes. |

## Worktree Noise

This worktree required `pnpm install` before running `vitest/vue-tsc`. That created the known tracked `node_modules` symlink noise under plugin/tool workspaces. Those paths are not part of the T3C-2b PR and must not be staged.
