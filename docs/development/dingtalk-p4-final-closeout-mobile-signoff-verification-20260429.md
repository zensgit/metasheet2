# DingTalk P4 Final Closeout Mobile Signoff Verification - 2026-04-29

## Scope

This document verifies that the final P4 handoff and closeout wrappers can carry
strict mobile public-form signoff evidence into the final staging evidence
packet.

Changed files:

- `scripts/ops/dingtalk-p4-final-handoff.mjs`
- `scripts/ops/dingtalk-p4-final-closeout.mjs`
- `scripts/ops/dingtalk-p4-final-handoff.test.mjs`
- `scripts/ops/dingtalk-p4-final-closeout.test.mjs`
- `docs/dingtalk-remote-smoke-checklist-20260422.md`
- `docs/development/dingtalk-p4-final-closeout-mobile-signoff-design-20260429.md`
- `docs/development/dingtalk-p4-final-closeout-mobile-signoff-verification-20260429.md`

## Commands

```bash
node --test scripts/ops/dingtalk-p4-final-handoff.test.mjs
node --test scripts/ops/dingtalk-p4-final-closeout.test.mjs
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
git diff --check
git diff -- scripts/ops/dingtalk-p4-final-handoff.mjs scripts/ops/dingtalk-p4-final-closeout.mjs scripts/ops/dingtalk-p4-final-handoff.test.mjs scripts/ops/dingtalk-p4-final-closeout.test.mjs docs/dingtalk-remote-smoke-checklist-20260422.md docs/development/dingtalk-p4-final-closeout-mobile-signoff-design-20260429.md docs/development/dingtalk-p4-final-closeout-mobile-signoff-verification-20260429.md \
  | rg -v "rg -n" \
  | rg -n "(access_token=[A-Za-z0-9]|SEC[0-9a-fA-F]{8,}|Authorization:|Bearer [A-Za-z0-9._-]{20,}|https://oapi\\.dingtalk\\.com/robot/send|JWT_SECRET|DINGTALK_APP_SECRET|publicToken=[A-Za-z0-9._~+/=-]{12,})" || true
```

## Results

- Final handoff test suite: passed, `10` tests.
- Final closeout test suite: passed, `7` tests.
- Exporter regression suite: passed, `18` tests.
- Packet validator regression suite: passed, `14` tests.
- `git diff --check`: passed.
- Diff secret scan: no matches for DingTalk webhook, signing secret, JWT,
  bearer token, public-token, or app-secret patterns.

## Regression Coverage

Final handoff tests now cover:

- default final packet export without mobile signoff;
- final packet export with strict mobile signoff required;
- manifest `requireMobileSignoffPass=true`;
- publish validator `includedMobileSignoffCount=1`;
- handoff summary `mobileSignoff.required=true` and `includedCount=1`;
- rejection when `--require-mobile-signoff-pass` is used without an included
  mobile signoff directory;
- sanitized failure arrays for validator and preflight errors, including
  secret-like path fragments;
- existing failure-summary and secret-redaction behavior.

Final closeout tests now cover:

- default final closeout without mobile signoff;
- final closeout forwarding `--include-mobile-signoff` and
  `--require-mobile-signoff-pass` into the final handoff step;
- final handoff summary preserving mobile signoff pass state;
- closeout summary `final.mobileSignoffRequired=true` and
  `final.mobileSignoffCount=1`;
- existing finalize, release-ready, skip-docs, external-artifact, and failure
  behavior.

## Release Handoff

The preferred real 142 closeout command after strict P4 evidence and strict
mobile signoff evidence are both ready is:

```bash
node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir <finalized-session-dir> \
  --packet-output-dir <packet-dir> \
  --include-mobile-signoff <mobile-compiled-dir> \
  --require-mobile-signoff-pass
```

The resulting packet should then show:

- `handoff-summary.json.status=pass`;
- `handoff-summary.json.mobileSignoff.includedCount > 0`;
- `publish-check.json.includedMobileSignoffCount > 0`;
- `closeout-summary.json.final.mobileSignoffRequired=true`;
- `closeout-summary.json.final.mobileSignoffCount > 0`;
- `publish-check.json.secretFindings=[]`.

No raw mobile signoff kit or real DingTalk webhook/token value should be present
in the final release packet.
