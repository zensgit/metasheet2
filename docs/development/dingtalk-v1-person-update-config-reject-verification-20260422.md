# DingTalk V1 Person Update Config Reject Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-person-update-config-reject-20260422`
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

- Route integration test: passed, 19 tests.
- Link validation unit test: passed, 12 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Parallel read-only agent review: confirmed the config-shape and missing-template route-level gap and payloads.
- Claude Code CLI read-only review: no blockers.

## Expected Assertions

The new integration coverage confirms that invalid V1 `send_dingtalk_person_message` action configs are rejected on update before persistence:

- non-object config returns `DingTalk action config must be an object`
- blank title template returns `DingTalk titleTemplate is required`
- `automationService.getRule` is called to validate the merged next state
- `automationService.updateRule` is not called

## Claude Code CLI Review Summary

Claude verified:

- PATCH with `actions` triggers `getRule` and config validation before `updateRule`
- `config: null` exercises `DingTalk action config must be an object`
- whitespace-only `titleTemplate` exercises `DingTalk titleTemplate is required`
- only tests and documentation changed

## Residual Risk

This is a test-only patch. It verifies existing route validation behavior but does not change runtime logic.
