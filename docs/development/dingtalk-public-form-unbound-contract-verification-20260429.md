# DingTalk Public Form Unbound Contract Verification - 2026-04-29

## Scope

This document verifies backend access-matrix coverage for signed-in public-form
users without a bound DingTalk identity.

Changed files:

- `packages/core-backend/tests/integration/public-form-flow.test.ts`
- `docs/development/dingtalk-public-form-unbound-contract-design-20260429.md`
- `docs/development/dingtalk-public-form-unbound-contract-verification-20260429.md`

## Commands

```bash
cd packages/core-backend
../../node_modules/.bin/vitest run tests/integration/public-form-flow.test.ts --watch=false
cd ../..
git diff --check
git diff -- packages/core-backend/tests/integration/public-form-flow.test.ts docs/development/dingtalk-public-form-unbound-contract-design-20260429.md docs/development/dingtalk-public-form-unbound-contract-verification-20260429.md \
  | rg -v "rg -n" \
  | rg -n "(access_token=[A-Za-z0-9]|SEC[0-9a-fA-F]{8,}|Authorization:|Bearer [A-Za-z0-9._-]{20,}|https://oapi\\.dingtalk\\.com/robot/send|JWT_SECRET|DINGTALK_APP_SECRET|publicToken=[A-Za-z0-9._~+/=-]{12,})" || true
```

## Results

- `public-form-flow.test.ts`: passed, `22` tests.
- `git diff --check`: passed.
- Diff secret scan: no matches after excluding the documented scan command
  itself.

## Regression Coverage

The added cases verify:

- signed-in but unbound users are rejected with `DINGTALK_BIND_REQUIRED`;
- selected users still require DingTalk binding before grant or allowlist
  evaluation;
- submit requests from unbound users are rejected with `DINGTALK_BIND_REQUIRED`;
- rejected submit requests do not insert `meta_records`.

## Manual Acceptance

For a live DingTalk-protected public form:

- anonymous user should be sent to DingTalk sign-in;
- signed-in local user without DingTalk binding should be asked to bind
  DingTalk;
- selected but unbound local user should still be asked to bind DingTalk;
- bound but unauthorized selected-user/member-group user should continue to see
  the selected-user/member-group rejection.
