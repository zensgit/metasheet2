# DingTalk Group Webhook Validation Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-group-webhook-validation-20260422`
- Status: passed local validation

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-destination-service.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
rg -n "normalizeDingTalkRobotWebhookUrl|DingTalk robot webhook URL must use HTTPS|DingTalk group webhook URL must include access_token|DingTalk robot secret must start with SEC|data-dingtalk-group-webhook-error|validateDingTalkGroupWebhookUrl|standard group robot webhook URLs|access_token" packages/core-backend/src/multitable/dingtalk-group-destination-service.ts packages/core-backend/src/routes/api-tokens.ts packages/core-backend/tests/unit/dingtalk-group-destination-service.test.ts apps/web/src/multitable/components/MetaApiTokenManager.vue apps/web/tests/multitable-api-token-manager.spec.ts docs/dingtalk-admin-operations-guide-20260420.md docs/dingtalk-capability-guide-20260420.md
git diff --check
claude -p --tools Read,Grep,Glob --max-budget-usd 0.75 "Read-only review. Inspect current git diff for DingTalk group robot webhook validation in backend/frontend/tests/docs. Do not modify files. Report concrete blockers only; if none, say no blocking issues and mention any small risks."
claude -p --tools Read,Grep,Glob --max-budget-usd 0.75 "Read-only re-review after fixes. Inspect current git diff for DingTalk group robot webhook validation and legacy edit compatibility. Do not modify files. Report concrete blockers only; if none, say no blocking issues."
```

## Expected Coverage

- Backend accepts valid DingTalk group robot webhook URLs.
- Backend rejects:
  - non-HTTPS robot URLs
  - non-DingTalk hosts
  - wrong paths
  - missing `access_token`
  - invalid signed robot secrets
- Backend trims valid `SEC...` secrets before persistence.
- Frontend disables save and shows inline errors for invalid webhook/secret inputs.
- Frontend does not resubmit unchanged legacy webhook/secret values during metadata-only edits.
- Docs describe the enforced standard webhook and secret rules.
- TypeScript builds pass for frontend and backend.

## Results

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-destination-service.test.ts --watch=false`: passed, 1 file and 16 tests.
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false`: passed, 1 file and 23 tests.
- `pnpm --filter @metasheet/core-backend build`: passed.
- `pnpm --filter @metasheet/web build`: passed with existing Vite chunk/dynamic import warnings.
- `rg -n "normalizeDingTalkRobotWebhookUrl|DingTalk robot webhook URL must use HTTPS|DingTalk group webhook URL must include access_token|DingTalk robot secret must start with SEC|data-dingtalk-group-webhook-error|validateDingTalkGroupWebhookUrl|standard group robot webhook URLs|access_token" ...`: passed, expected frontend/backend/test/doc references found.
- `git diff --check`: passed.
- Claude Code CLI re-review after the legacy edit fix: passed, no blocking issues.

## Claude Code CLI

- Local CLI check: `claude --version`
- Version observed: `2.1.117 (Claude Code)`
- Read-only review was executed with `Read,Grep,Glob` tools.
- Claude reported no blocking issues and noted a legacy edit compatibility risk. That risk was addressed by omitting unchanged webhook/secret fields from metadata-only edits and adding a regression test.
- A second read-only re-review after that fix reported no blocking issues.
