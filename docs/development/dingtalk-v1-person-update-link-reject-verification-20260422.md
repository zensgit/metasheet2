# DingTalk V1 Person Update Link Reject Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-person-update-link-reject-20260422`
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

- Route integration test: passed, 16 tests.
- Link validation unit test: passed, 12 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Parallel read-only agent review: recommended this update-route V1 `actions[]` rejection slice.
- Claude Code CLI read-only review: no blockers.

## Expected Assertions

The new integration coverage confirms that invalid V1 `send_dingtalk_person_message` links are rejected on automation update before persistence:

- invalid public-form links return `Selected public form view is not shared`
- invalid internal links return `Internal processing view not found`
- `automationService.getRule` is called to validate the merged next state
- `automationService.updateRule` is not called for either invalid request

## Claude Code CLI Review Summary

Claude verified:

- both new PATCH cases send V1 `actions[]` with `send_dingtalk_person_message`
- the route loads and validates the merged next state before `updateRule`
- validation messages match the link validator source
- only tests and documentation changed

## Residual Risk

This is a test-only patch. It verifies existing route validation behavior but does not change runtime logic.
