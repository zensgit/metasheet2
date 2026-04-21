# DingTalk Test Run Feedback Verification

Date: 2026-04-21
Branch: `codex/dingtalk-test-run-feedback-20260421`

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

## Results

- Initial frontend test command failed because the new worktree had no installed dependencies: `Command "vitest" not found`.
- `pnpm install --frozen-lockfile` completed successfully with the repository's normal ignored-build-scripts warning.
- Targeted frontend tests passed: 2 files, 91 tests.
- Frontend production build passed.
- Build emitted existing Vite warnings for `WorkflowDesigner.vue` mixed dynamic/static imports and large chunks.

## Review-Fix Verification

Additional targeted rerun after the API error-envelope and duration fixes:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
git diff --check
```

Result:

- `multitable-automation-manager.spec.ts`: 48/48 passed.
- `multitable-automation-rule-editor.spec.ts`: 44/44 passed.
- Combined rerun: 2 files, 92/92 passed.
- `vue-tsc -b --noEmit`: passed.
- `git diff --check`: passed.

Expected assertions added or strengthened:

- Backend-shaped `{ error: "Automation service unavailable" }` is displayed as
  `Automation service unavailable`, not `API 500`.
- Backend-shaped `duration` renders in Test Run success feedback.
- Non-DingTalk automations show a generic `Running test.` message while the
  test request is pending.

## Coverage

- Unsaved rules cannot trigger Test Run.
- DingTalk rules show a real-send warning.
- Successful Test Run displays success feedback and refreshes stats.
- Failed Test Run displays execution step errors.
- Test Run API failures display errors instead of failing silently.
- Non-DingTalk Test Run pending feedback does not warn about DingTalk sends.
