# DingTalk V1 Editor Stale Top-Level Coverage Verification - 2026-04-21

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

## Result

- Initial Vitest command before dependency install failed because `vitest` was not available in this new worktree.
- `pnpm install --frozen-lockfile`: passed.
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts --watch=false`: passed, 1 file / 50 tests.
- `pnpm --filter @metasheet/web build`: passed.
- `git diff --check`: passed.

## Notes

The frontend build emitted existing Vite warnings about `WorkflowDesigner.vue` being both statically and dynamically imported, plus large chunk warnings. These warnings are unrelated to this DingTalk editor coverage slice.

`pnpm install` updated local `node_modules` links in several workspace packages. Those generated dependency-directory changes must remain unstaged.
