# DingTalk Staging Evidence Mobile Signoff Gate Verification - 2026-04-29

## Scope

This document verifies that final DingTalk staging evidence packets can require
strict real-mobile public-form signoff evidence before release handoff.

Changed files:

- `scripts/ops/export-dingtalk-staging-evidence-packet.mjs`
- `scripts/ops/validate-dingtalk-staging-evidence-packet.mjs`
- `scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`
- `scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs`
- `docs/development/dingtalk-staging-evidence-mobile-signoff-gate-design-20260429.md`
- `docs/development/dingtalk-staging-evidence-mobile-signoff-gate-verification-20260429.md`

## Commands

```bash
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs
```

End-to-end packet smoke with generated redaction-safe fixtures:

```bash
node --input-type=module <<'NODE'
// Generates a finalized P4 session fixture and a strict mobile signoff fixture,
// then exports and validates a packet with both gates enabled.
NODE
```

Repository hygiene:

```bash
git diff --check
git diff -- scripts/ops/export-dingtalk-staging-evidence-packet.mjs scripts/ops/validate-dingtalk-staging-evidence-packet.mjs scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs docs/development/dingtalk-staging-evidence-mobile-signoff-gate-design-20260429.md docs/development/dingtalk-staging-evidence-mobile-signoff-gate-verification-20260429.md \
  | rg -v "rg -n" \
  | rg -n "(access_token=[A-Za-z0-9]|SEC[0-9a-fA-F]{8,}|Authorization:|Bearer [A-Za-z0-9._-]{20,}|https://oapi\\.dingtalk\\.com/robot/send|JWT_SECRET|DINGTALK_APP_SECRET|publicToken=[A-Za-z0-9._~+/=-]{12,})" || true
```

## Results

- Exporter test suite: passed, `18` tests.
- Validator test suite: passed, `14` tests.
- Mobile signoff regression suite: passed, `15` tests.
- End-to-end packet smoke: passed with `includedEvidenceCount=1`,
  `includedMobileSignoffCount=1`, `secretFindings=0`, and `failures=0`.
- `git diff --check`: passed.
- Diff secret scan: no matches for DingTalk webhook, signing secret, JWT,
  bearer token, public-token, or app-secret patterns.

## Regression Coverage

Exporter tests cover:

- default packet exports with mobile signoff script included but no mobile gate;
- successful strict mobile signoff inclusion when the gate is required;
- rejection of non-strict mobile signoff evidence;
- rejection of raw editable mobile signoff kit directories;
- rejection when `--require-mobile-signoff-pass` is used without an included
  mobile signoff directory.

Validator tests cover:

- final packet validation with strict mobile signoff evidence;
- rejection of non-strict copied mobile signoff evidence;
- rejection of raw copied `mobile-signoff.json`;
- rejection when the mobile gate is required but no entry is registered;
- rejection of unregistered `mobile-signoff/` directories.

## Release Handoff

For the real 142/staging handoff, operators should:

1. Complete the existing P4 smoke final session and strict handoff.
2. Complete the real DingTalk mobile public-form signoff with
   `dingtalk-public-form-mobile-signoff.mjs`.
3. Re-export the final packet with both `--require-dingtalk-p4-pass` and
   `--require-mobile-signoff-pass`.
4. Run `validate-dingtalk-staging-evidence-packet.mjs` and attach its JSON
   report to the release evidence.

The final packet must include only redacted mobile signoff artifacts.
