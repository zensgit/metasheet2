# DingTalk V1 Person Link Reject Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-person-link-reject-20260422`
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

- Route integration test: passed, 14 tests.
- Link validation unit test: passed, 12 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Parallel read-only agent review: recommended the same placement, payload shape, and assertions used by this patch.
- Claude Code CLI read-only review: no blockers.

## Expected Assertions

The new integration coverage confirms that invalid V1 `send_dingtalk_person_message` links are rejected before persistence:

- invalid public-form links return `Selected public form view is not shared`
- invalid internal links return `Internal processing view not found`
- `automationService.createRule` is not called for either invalid request

## Claude Code CLI Review Summary

Claude verified:

- both new tests exercise V1 `actions[]` `send_dingtalk_person_message`
- `validateDingTalkAutomationLinks` runs before `automationService.createRule`
- validation messages match source behavior
- only tests and documentation changed

## Residual Risk

This is a test-only patch. It verifies the existing route validation behavior but does not change runtime logic.
