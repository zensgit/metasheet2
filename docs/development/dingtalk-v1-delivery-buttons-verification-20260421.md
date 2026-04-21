# DingTalk V1 Delivery Buttons Verification - 2026-04-21

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

## Expected Coverage

- Legacy DingTalk group delivery viewer behavior remains covered.
- V1 multi-action DingTalk group delivery viewer button is visible and opens the group delivery viewer.
- V1 multi-action DingTalk person delivery viewer button is visible and opens the person delivery viewer.
- Frontend production build succeeds.
- Diff whitespace check passes.

## Result

- `pnpm install --frozen-lockfile`: passed.
- Initial Vitest command before dependency install failed because `vitest` was not available in this new worktree.
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts --watch=false`: passed, 1 file / 49 tests.
- `pnpm --filter @metasheet/web build`: passed.
- `git diff --check`: passed.

## Rebase Verification

After rebasing onto the updated stacked base branch:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
git diff --check
```

Result:

- `multitable-automation-manager.spec.ts`: 50/50 passed.
- `vue-tsc -b --noEmit`: passed.
- `git diff --check`: passed.

## Notes

The frontend build emitted existing Vite warnings about `WorkflowDesigner.vue` being both statically and dynamically imported, plus large chunk warnings. These warnings are unrelated to this DingTalk delivery button slice.

`pnpm install` updated local `node_modules` links in several workspace packages. Those generated dependency-directory changes were intentionally left unstaged and are not part of the patch.
