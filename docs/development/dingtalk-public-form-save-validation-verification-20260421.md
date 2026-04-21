# DingTalk Public Form Save Validation Verification 2026-04-21

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-automation-link-validation.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
pnpm --filter @metasheet/web build
pnpm --filter @metasheet/core-backend build
```

## Results

- Initial targeted test runs failed because this fresh worktree had no installed dependencies and `vitest` was not available.
- Ran `pnpm install --frozen-lockfile`.
- Back-end helper tests passed:
  - `tests/unit/dingtalk-automation-link-validation.test.ts`: 8 tests passed.
- Front-end targeted tests passed:
  - `tests/dingtalk-public-form-link-warnings.spec.ts`: 6 tests passed.
  - `tests/multitable-automation-rule-editor.spec.ts`: 41 tests passed.
  - `tests/multitable-automation-manager.spec.ts`: 44 tests passed.
  - Total: 3 files, 91 tests passed.
- First `pnpm --filter @metasheet/core-backend build` failed on a TypeScript tuple inference issue in the new helper.
- Fixed the helper by building explicit `[string, Record<string, unknown>]` entries.
- Re-ran `pnpm --filter @metasheet/core-backend build`: passed.
- Re-ran the back-end helper tests after the fix: 8 tests passed.
- `pnpm --filter @metasheet/web build` passed.
- Front-end test output included a `WebSocket server error: Port is already in use` message, but all tests completed successfully.
- Web build produced the existing Vite warnings about mixed dynamic/static import of `WorkflowDesigner.vue` and large chunks; no new build failure was introduced.

## Coverage Notes

- Helper tests cover legacy payloads, multi-action payloads, active public form links, fully public advisory allowance, DingTalk-protected advisory allowance, missing/non-form/disabled/missing-token/expired public form errors, and missing internal view errors.
- Front-end tests cover current-sheet public form option filtering.
- Builds cover `univer-meta.ts` route integration with the shared helper.
