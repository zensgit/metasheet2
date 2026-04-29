# DingTalk Public Form Bind CTA Verification - 2026-04-29

## Scope

This document verifies the frontend recovery path for `DINGTALK_BIND_REQUIRED`
on public multitable forms.

Changed files:

- `apps/web/src/views/PublicMultitableFormView.vue`
- `apps/web/tests/public-multitable-form.spec.ts`
- `docs/development/dingtalk-public-form-bind-cta-design-20260429.md`
- `docs/development/dingtalk-public-form-bind-cta-verification-20260429.md`

## Commands

```bash
cd apps/web
../../node_modules/.bin/vitest run tests/public-multitable-form.spec.ts --watch=false
cd ../..
git diff --check
git diff -- apps/web/src/views/PublicMultitableFormView.vue apps/web/tests/public-multitable-form.spec.ts docs/development/dingtalk-public-form-bind-cta-design-20260429.md docs/development/dingtalk-public-form-bind-cta-verification-20260429.md \
  | rg -v "rg -n" \
  | rg -n "(access_token=[A-Za-z0-9]|SEC[0-9a-fA-F]{8,}|Authorization:|Bearer [A-Za-z0-9._-]{20,}|https://oapi\\.dingtalk\\.com/robot/send|JWT_SECRET|DINGTALK_APP_SECRET|publicToken=[A-Za-z0-9._~+/=-]{12,})" || true
```

## Results

- Public multitable form frontend spec: passed, `4` tests.
- `git diff --check`: passed.
- Diff secret scan: no matches for DingTalk webhook, signing secret, JWT,
  bearer token, public-token, or app-secret patterns.

## Regression Coverage

The frontend spec now covers:

- anonymous public form context load and submit with public token;
- anonymous DingTalk-protected form launching DingTalk sign-in;
- signed-in but unbound DingTalk user seeing a bind CTA;
- bind CTA calling `GET /api/auth/dingtalk/launch?intent=bind&redirect=...`;
- bind redirect state showing `Redirecting to DingTalk binding...`;
- selected-user/member-group rejection still showing the allowlist error copy.

## Manual Acceptance

For a DingTalk-protected public form:

- Anonymous user: still redirects to DingTalk sign-in.
- Signed-in local user without DingTalk binding: sees the bind CTA and returns
  to the same public form URL after successful DingTalk binding.
- Bound user outside allowlist: still sees the selected-user/member-group
  rejection copy.
