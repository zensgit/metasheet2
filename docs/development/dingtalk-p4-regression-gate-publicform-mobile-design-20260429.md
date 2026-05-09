# DingTalk P4 Regression Gate Public Form/Mobile Design - 2026-04-29

## Goal

Increase local pre-release coverage for the real DingTalk P4 acceptance path
without introducing new live DingTalk or staging calls.

Before this slice, the P4 regression gate covered backend public-form flow and
several DingTalk admin UIs, but the `all` profile did not explicitly include:

- public multitable form runtime UI behavior;
- public-form mobile signoff tooling.

Those two areas are directly used by final 142 validation, so they should be
visible in the gate plan instead of relying on separate manual commands.

## Design

The gate now adds two existing tests:

- `ops-mobile-signoff` in the `ops` profile:
  `node --test scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs`
- `web-public-multitable-form` in the `product` profile:
  `pnpm --filter @metasheet/web exec vitest run tests/public-multitable-form.spec.ts --watch=false`

Because the `all` profile is defined as `ops + product`, it now includes both
checks automatically.

## Safety

This slice only changes local regression-gate planning/execution. It does not
call DingTalk, does not call 142, and does not store real webhook, signing
secret, access token, JWT, or public-form token values.

The runner keeps using the existing redacted summary/log pipeline.

## Files

- `scripts/ops/dingtalk-p4-regression-gate.mjs`
- `scripts/ops/dingtalk-p4-regression-gate.test.mjs`
- `docs/development/dingtalk-p4-regression-gate-publicform-mobile-design-20260429.md`
- `docs/development/dingtalk-p4-regression-gate-publicform-mobile-verification-20260429.md`
