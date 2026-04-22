# DingTalk V1 Person Create Config Reject Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-person-create-config-reject-20260422`
- Scope: backend route-level integration coverage

## Verification Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-automation-link-validation.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
git diff --check
/Users/chouhua/.local/bin/claude -p --tools Read,Grep,Glob --max-budget-usd 1.5 "Read-only review current git diff ..."
```

## Results

- Route integration test: passed, 21 tests.
- Link validation unit test: passed, 12 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Parallel read-only agent review: confirmed the current worktree contains the requested create-route V1 `actions[]` config coverage.
- Claude Code CLI read-only review: no blockers.

## Expected Assertions

The new integration coverage confirms that invalid V1 `send_dingtalk_person_message` action configs are rejected on create before persistence:

- non-object config returns `DingTalk action config must be an object`
- blank title template returns `DingTalk titleTemplate is required`
- `automationService.createRule` is not called

## Claude Code CLI Review Summary

Claude verified:

- both new POST cases exercise V1 `actions[]` `send_dingtalk_person_message`
- route validation returns before `automationService.createRule`
- config and template validation messages match the validator source
- only tests and documentation changed

## Residual Risk

This is a test-only patch. It verifies existing route validation behavior but does not change runtime logic.
