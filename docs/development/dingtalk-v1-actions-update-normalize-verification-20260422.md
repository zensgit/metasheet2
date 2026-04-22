# DingTalk V1 Actions Update Normalize Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-actions-update-normalize-20260422`
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

- Route integration test: passed, 28 tests.
- Link validation unit test: passed, 12 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Parallel read-only agent review: identified V1 `actions[]` update success normalization as the next uncovered route-level slice.
- Claude Code CLI read-only review: no blockers.

## Expected Assertions

The new integration coverage confirms that valid V1 DingTalk group updates normalize legacy template fields before persistence:

- response is HTTP 200 with `ok: true`
- `automationService.getRule` is called before merged-state validation
- `automationService.updateRule` receives `titleTemplate` and `bodyTemplate`
- response actions include the normalized templates
- `meta_views` is queried for valid public form and internal link validation

## Claude Code CLI Review Summary

- Confirmed the PATCH success test exercises route-level V1 `actions[]` normalization.
- Confirmed `automationService.updateRule` receives normalized `titleTemplate` and `bodyTemplate`.
- Confirmed the response includes normalized action config.
- Confirmed the success path reaches `meta_views` link validation.
- Confirmed no production source changed.

## Residual Risk

This is a test-only patch. It verifies existing route normalization behavior but does not change runtime logic.
