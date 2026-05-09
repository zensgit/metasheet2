# DingTalk P4 Evidence Secret Assignment Spaces Verification

Date: 2026-04-30

## Scope

Verified secret-assignment blocking for `dingtalk-p4-evidence-record`.

## Local Checks

- `node --check scripts/ops/dingtalk-p4-evidence-record.mjs` passed.
- `node --check scripts/ops/dingtalk-p4-evidence-record.test.mjs` passed.
- `node --test scripts/ops/dingtalk-p4-evidence-record.test.mjs` passed: 27 tests, 27 passed.
- `git diff --check` passed.

## Assertions Added

- Summary input with `DINGTALK_CLIENT_SECRET = value` is rejected.
- Text artifact content with `client_secret = value` is rejected.
- Existing no-space secret assignment tests still reject the same class under the unified `dingtalk_secret_assignment` pattern.
- Error output does not echo the raw synthetic secret value.

## Secret Handling

The implementation and docs do not include real webhook URLs, robot secrets, bearer tokens, JWTs, SEC secrets, public tokens, or passwords. Test values are synthetic fixtures only.
