# DingTalk V1 Group Update Destination Reject Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-group-update-destination-reject-20260422`
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

- Route integration test: passed, 26 tests.
- Link validation unit test: passed, 12 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Parallel read-only agent review: identified the V1 group update missing-destination path as the next uncovered route-level slice.
- Claude Code CLI read-only review: no blockers.

## Expected Assertions

The new integration coverage confirms that invalid V1 DingTalk group update configs are rejected before persistence:

- missing group destination returns `At least one DingTalk destination or record destination field path is required`
- `automationService.getRule` is called before validation
- `automationService.updateRule` is not called
- no `meta_views` query is made after config validation fails

## Claude Code CLI Review Summary

- Confirmed route validation runs after `automationService.getRule` and before `automationService.updateRule`.
- Confirmed the failing config does not reach `meta_views` link validation.
- Confirmed assertion messages match the validator source.
- Confirmed no production source changed.

## Residual Risk

This is a test-only patch. It verifies existing route validation behavior but does not change runtime logic.
