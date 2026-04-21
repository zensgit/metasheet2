# DingTalk Automation Service Link Validation Verification

Date: 2026-04-21

## Environment

- Worktree: `.worktrees/dingtalk-action-service-link-validation-20260421`
- Branch: `codex/dingtalk-action-service-link-validation-20260421`
- Base: `82217450de80d2fecc110b653e751bd8fe5bbcd7`

## Commands

```bash
pnpm install --frozen-lockfile
```

Result: passed.

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
```

Result: passed.

Summary:

- `tests/unit/automation-v1.test.ts`: 119 tests passed.
- Added service-level create/update coverage for invalid DingTalk public form links.

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-automation-link-validation.test.ts tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false
```

Result: passed.

Summary:

- `tests/unit/dingtalk-automation-link-validation.test.ts`: 12 tests passed.
- `tests/integration/dingtalk-automation-link-routes.api.test.ts`: 9 tests passed.
- Total: 21 tests passed.

```bash
pnpm --filter @metasheet/core-backend build
```

Result: passed.

## Notes

- Vitest emitted the existing Vite CJS Node API deprecation warning.
- `pnpm install` emitted the existing ignored-build-scripts warning.
- No live DingTalk webhook delivery was required because this change protects persistence-time link validation.

## Main-target cherry-pick verification

Date: 2026-04-21

The original PR branch was stacked on `codex/dingtalk-action-service-link-validation-base-20260421`, so this change was cherry-picked onto the latest `main` to avoid re-merging already-promoted DingTalk automation validation commits.

- Worktree: `/private/tmp/metasheet2-dingtalk-service-link-main`
- Branch: `codex/dingtalk-action-service-link-validation-main-20260421`
- Base: `4476e40b85bd04cd9781f58c9b88c92aebf623a6`
- Cherry-picked source commit: `dd6cee4a5fe1fcbc98474ff3decf7b1c13508cdd`
- Main-target commit: `7e5bc38047edefb0861bbca15f0ea9c821a8f01f`

Commands rerun after the cherry-pick:

```bash
pnpm install --frozen-lockfile
```

Result: passed.

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
```

Result: passed.

Summary:

- `tests/unit/automation-v1.test.ts`: 119 tests passed.

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-automation-link-validation.test.ts tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false
```

Result: passed.

Summary:

- `tests/unit/dingtalk-automation-link-validation.test.ts`: 12 tests passed.
- `tests/integration/dingtalk-automation-link-routes.api.test.ts`: 9 tests passed.
- Total: 21 tests passed.

```bash
pnpm --filter @metasheet/core-backend build
```

Result: passed.

```bash
git diff --check HEAD~1..HEAD
```

Result: passed.
