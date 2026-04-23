# DingTalk Person Create Config Reject Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-person-create-config-reject-20260422`
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

- Route integration test: passed, 23 tests.
- Link validation unit test: passed, 12 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Parallel read-only agent review: identified the top-level `send_dingtalk_person_message` create path as the next uncovered route-level slice.
- Claude Code CLI read-only review: no blockers.

## Expected Assertions

The new integration coverage confirms that invalid top-level `send_dingtalk_person_message` create configs are rejected before persistence:

- missing recipient source returns `At least one local userId, memberGroupId, record recipient field path, or member group record field path is required`
- blank title template returns `DingTalk titleTemplate is required`
- `automationService.createRule` is not called

## Claude Code CLI Review Summary

Claude verified:

- route validation runs before `automationService.createRule`
- the recipient test isolates the no-effective-recipient branch
- the template test isolates the `titleTemplate` validation branch
- assertion strings match the validator source
- only tests and documentation changed

## Residual Risk

This is a test-only patch. It verifies existing route validation behavior but does not change runtime logic.
