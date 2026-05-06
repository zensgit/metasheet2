# Multitable Feishu RC 142 UI Smoke Hardening Verification - 2026-05-06

## Local Static Checks

```bash
node --check scripts/verify-multitable-live-smoke.mjs
```

Result: passed.

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result: passed.

```bash
git diff --check
```

Result: passed.

## Focused Tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/comment-service-formal-scope.test.ts \
  --reporter=verbose
```

Result: `1/1` passed.

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/comment-service.test.ts \
  tests/unit/comment-service-formal-scope.test.ts \
  tests/integration/comment-flow.test.ts \
  --reporter=dot
```

Result: `93/93` passed.

```bash
node --test scripts/verify-multitable-live-smoke.test.mjs
```

Result: `1/1` passed.

## 142 Staging Smoke Evidence

All 142 runs used:

```bash
AUTH_TOKEN="$(cat /tmp/metasheet-142-main-admin-72h.jwt)" \
API_BASE="http://142.171.239.56:8081" \
WEB_BASE="http://142.171.239.56:8081" \
OUTPUT_ROOT="output/playwright/multitable-feishu-rc-142-ui-smoke/<timestamp>" \
HEADLESS=true \
ENSURE_PLAYWRIGHT=false \
TIMEOUT_MS=45000 \
pnpm verify:multitable-pilot:staging
```

The token value was not printed or committed.

### Baseline Failure

Output:

```text
output/playwright/multitable-feishu-rc-142-ui-smoke/20260506-050740/report.md
```

Result:

- Overall: `FAIL`
- Checks before failure: `31`
- Failure: retry import button stayed disabled because the retry import path did not force the Title field mapping.

### After Import Mapping Fix

Output:

```text
output/playwright/multitable-feishu-rc-142-ui-smoke/20260506-051110/report.md
```

Result:

- Overall: `FAIL`
- Checks before failure: `54`
- Confirmed fixed: `ui.import.failed-retry` passed.
- Next failure: attachment field locator waited on a substring-based `Files` field match.

### After Exact Attachment Field Locator

Output:

```text
output/playwright/multitable-feishu-rc-142-ui-smoke/20260506-051451/report.md
```

Result:

- Overall: `FAIL`
- Confirmed fixed: attachment upload path progressed past the previous file-name wait.
- Next failure: strict mode conflict between Comment Inbox and record comment buttons.

### After Scoped Comment Button

Output:

```text
output/playwright/multitable-feishu-rc-142-ui-smoke/20260506-051605/report.md
```

Result:

- Overall: `FAIL`
- Checks before failure: `58`
- Confirmed fixed: record comment drawer opened.
- Next failure: submitted comment text did not appear.

### After Scoped Comment Submission Helper

Output:

```text
output/playwright/multitable-feishu-rc-142-ui-smoke/20260506-051845/report.md
```

Result:

- Overall: `FAIL`
- Checks before failure: `58`
- Failure: comment thread was not created.

## 142 Comment API Probe

A direct API probe used the same redacted admin token and cleaned up its temporary record.

Result:

```text
createRecord 200 true rec_...
createComment 500 false null INTERNAL_ERROR Failed to create comment
listComments 200 0 false
deleteRecord 200 true
```

Conclusion: the final 142 blocker is a backend comment-create failure, not a Playwright selector issue.

## Final Status

- Local code fix: verified.
- 142 deployment status: not verified after fix because this branch is not yet deployed.
- Required follow-up after merge: deploy this commit to 142 and rerun `pnpm verify:multitable-pilot:staging`.
