# DingTalk Person Granted Form Route Success Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-person-granted-form-guard-20260422`
- Scope: backend route-level integration and public form submit guard coverage

## Verification Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/public-form-flow.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-automation-link-validation.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
git diff --check
/Users/chouhua/.local/bin/claude -p --tools Read,Grep,Glob --max-budget-usd 1.5 "Read-only review current git diff ..."
```

## Results

- DingTalk automation route integration test: passed, 32 tests.
- Public form flow integration test: passed, 18 tests.
- Link validation unit test: passed, 12 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Parallel read-only agent review: identified the V1 `actions[]` granted-form route gap and the submit-time no-grant denial gap; both were covered in this patch.
- Claude Code CLI read-only review: no blockers.

## Expected Assertions

The new integration coverage confirms that valid DingTalk person automation creation accepts a DingTalk-authorized public form:

- response is HTTP 200 with `ok: true`
- `automationService.createRule` receives `actionType: send_dingtalk_person_message`
- persisted `actionConfig.userIds` includes the selected local user
- legacy `title` and `content` are normalized to `titleTemplate` and `bodyTemplate`
- persisted `actionConfig.publicFormViewId` references the granted form view
- `meta_views` is queried for route-level link validation

It also confirms the same granted form works through V1 `actions[]`:

- `automationService.createRule` receives `actionType: notify`
- persisted `actions[].type` is `send_dingtalk_person_message`
- persisted `actions[].config.publicFormViewId` references the granted form view
- `actions[].config.titleTemplate` and `bodyTemplate` are normalized from legacy input

The new public form coverage confirms that the submit route rejects bound but ungranted users:

- response is HTTP 403
- `error.code` is `DINGTALK_GRANT_REQUIRED`
- rejected submit does not execute `INSERT INTO meta_records`

## Residual Risk

This is a test-only patch. It verifies existing route validation behavior but does not change runtime logic.

## Claude Code CLI Review Summary

- Confirmed direct person and V1 `actions[]` automation tests correctly exercise `dingtalk_granted` public forms.
- Confirmed submit denial uses `hasDingTalkBinding: true` and `hasDingTalkGrant: false`, matching the `DINGTALK_GRANT_REQUIRED` branch.
- Confirmed the no-insert assertion is valid because the submit route returns before record creation.
- Confirmed docs accurately describe the test-only scope.
