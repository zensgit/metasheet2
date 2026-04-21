# DingTalk Internal Link Validation Verification 2026-04-21

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-internal-view-link-warnings.spec.ts tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
pnpm --filter @metasheet/web build
pnpm --filter @metasheet/core-backend build
```

## Results

- Initial targeted front-end test run failed because this fresh worktree had no installed dependencies and `vitest` was not available.
- Ran `pnpm install --frozen-lockfile`.
- Front-end targeted Vitest run passed:
  - `tests/dingtalk-internal-view-link-warnings.spec.ts`: 2 tests passed.
  - `tests/multitable-automation-rule-editor.spec.ts`: 41 tests passed.
  - `tests/multitable-automation-manager.spec.ts`: 43 tests passed.
  - Total: 3 files, 86 tests passed.
- Back-end targeted Vitest run passed:
  - `tests/unit/automation-v1.test.ts`: 111 tests passed.
- `pnpm --filter @metasheet/web build` passed.
- `pnpm --filter @metasheet/core-backend build` passed.
- Front-end test output included a `WebSocket server error: Port is already in use` message, but all tests completed successfully.
- Web build produced the existing Vite warnings about mixed dynamic/static import of `WorkflowDesigner.vue` and large chunks; no new build failure was introduced.

## Coverage Notes

- Utility tests cover missing internal processing view warnings.
- Rule editor tests cover stale group/person `internalViewId` save blocking.
- Manager tests cover current-sheet internal view filtering and stale edit warnings.
- Executor tests cover runtime group/person delivery failure before DingTalk send when `internalViewId` is missing.
