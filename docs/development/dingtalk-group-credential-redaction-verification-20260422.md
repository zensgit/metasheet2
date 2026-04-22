# DingTalk Group Credential Redaction Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-group-credential-redaction-20260422`

## Local Verification

Passed:

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-destination-response.test.ts tests/unit/dingtalk-group-destination-service.test.ts --watch=false`
  - 2 files passed
  - 19 tests passed
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false`
  - 1 file passed
  - 24 tests passed
- `pnpm --filter @metasheet/core-backend build`
  - passed
- `pnpm --filter @metasheet/web build`
  - passed
  - Vite reported existing chunk-size/dynamic-import warnings only
- `git diff --check`
  - passed

## Expected Assertions

- API response serializer masks DingTalk robot webhook query credentials.
- API response serializer omits the saved `SEC` secret and returns `hasSecret`.
- Existing service behavior for create/list/test-send remains intact.
- Frontend manager does not prefill a saved secret during edit.
- Frontend manager can explicitly clear a saved secret by sending `secret: ''`.
- Frontend manager still omits unchanged webhook/secret fields when editing metadata only.

## Claude Code CLI

Read-only review passed with no blockers.

The first run used a `0.75 USD` budget and exited with `Exceeded USD budget`. A second short-prompt run with a `1.5 USD` budget completed and confirmed:

- list/create/update DingTalk group destination API responses route through the redaction serializer
- raw `access_token`, `timestamp`, `sign`, URL password, and saved `SEC` secret are not reflected to the browser by those responses
- frontend editing does not prefill saved secrets
- frontend keep/replace/clear behavior is correctly encoded in the PATCH payload
