# DingTalk Public Form Access Matrix Verification

- Date: 2026-04-28
- Scope: access matrix, DingTalk binding/grant status display, password-change guard

## Commands

Passed:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/public-form-flow.test.ts tests/unit/jwt-middleware.test.ts --watch=false
```

Result:

- 2 test files passed
- 33 tests passed

Passed:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-form-share-manager.spec.ts tests/public-multitable-form.spec.ts tests/multitable-embed-route.spec.ts tests/multitable-phase4.spec.ts --watch=false
```

Result:

- 4 test files passed
- 33 tests passed
- Sandbox printed a non-gating Vite HMR socket `EPERM` warning and jsdom navigation warning; exit code was 0.

Passed:

```bash
pnpm --filter @metasheet/core-backend build
```

Passed:

```bash
pnpm --filter @metasheet/web build
```

Result:

- Build passed.
- Vite printed existing large-chunk warnings.

Passed:

```bash
git diff --check
```

## Coverage

- Public anonymous token context and submit still pass.
- Anonymous visitor on DingTalk-protected form gets `DINGTALK_AUTH_REQUIRED`.
- DingTalk-bound user can open `dingtalk` forms.
- Bound user without enabled grant is rejected by `dingtalk_granted` forms.
- Bound user outside local allowlist gets `DINGTALK_FORM_NOT_ALLOWED`.
- Bound user in allowed member group can open the form.
- Allowed-user share config returns DingTalk binding and grant status.
- The form-share UI displays the selected audience rule and per-user DingTalk status.
- Public-form optional auth allows `must_change_password` users to continue the DingTalk form path while normal app APIs still enforce password change.

