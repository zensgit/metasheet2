# DingTalk Form Link Save Validation Verification 2026-04-21

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Results

- Initial targeted test run failed because this fresh worktree had no installed dependencies and `vitest` was not available.
- Ran `pnpm install --frozen-lockfile`.
- Targeted Vitest run passed:
  - `tests/dingtalk-public-form-link-warnings.spec.ts`: 6 tests passed.
  - `tests/multitable-automation-rule-editor.spec.ts`: 39 tests passed.
  - `tests/multitable-automation-manager.spec.ts`: 41 tests passed.
  - Total: 3 files, 86 tests passed.
- `pnpm --filter @metasheet/web build` passed.
- Build produced the existing Vite warnings about mixed dynamic/static import of `WorkflowDesigner.vue` and large chunks; no new build failure was introduced.

## Coverage Notes

- Utility tests verify hard link errors are separated from advisory access warnings.
- Rule editor tests verify group and person saves are disabled when the selected public form link cannot work.
- Inline manager tests verify create calls are not sent when the selected public form link cannot work.
- Existing create/save tests still verify fully public advisory warnings do not block saving.
