# DingTalk P4 Regression Gate Public Form/Mobile Verification - 2026-04-29

## Scope

This document verifies that the P4 regression gate includes existing coverage
for public form runtime UI and mobile signoff tooling.

Changed files:

- `scripts/ops/dingtalk-p4-regression-gate.mjs`
- `scripts/ops/dingtalk-p4-regression-gate.test.mjs`
- `docs/development/dingtalk-p4-regression-gate-publicform-mobile-design-20260429.md`
- `docs/development/dingtalk-p4-regression-gate-publicform-mobile-verification-20260429.md`

## Commands

```bash
node --test scripts/ops/dingtalk-p4-regression-gate.test.mjs
node scripts/ops/dingtalk-p4-regression-gate.mjs --profile all --plan-only --output-dir output/dingtalk-p4-regression-gate/publicform-mobile-plan
node --test scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs
cd apps/web
../../node_modules/.bin/vitest run tests/public-multitable-form.spec.ts --watch=false
cd ../..
git diff --check
git diff -- scripts/ops/dingtalk-p4-regression-gate.mjs scripts/ops/dingtalk-p4-regression-gate.test.mjs docs/development/dingtalk-p4-regression-gate-publicform-mobile-design-20260429.md docs/development/dingtalk-p4-regression-gate-publicform-mobile-verification-20260429.md \
  | rg -v "rg -n" \
  | rg -n "(access_token=[A-Za-z0-9]|SEC[0-9a-fA-F]{8,}|Authorization:|Bearer [A-Za-z0-9._-]{20,}|https://oapi\\.dingtalk\\.com/robot/send|JWT_SECRET|DINGTALK_APP_SECRET|publicToken=[A-Za-z0-9._~+/=-]{12,})" || true
```

## Results

- Regression gate unit tests: passed, `6` tests.
- `--profile all --plan-only`: passed, `25` checks planned.
- Plan summary contains `ops-mobile-signoff`: yes.
- Plan summary contains `web-public-multitable-form`: yes.
- Mobile signoff tool tests: passed, `15` tests.
- Public multitable form frontend tests: passed, `3` tests.
- `git diff --check`: passed.
- Diff secret scan: no matches after excluding the documented scan command
  itself.
