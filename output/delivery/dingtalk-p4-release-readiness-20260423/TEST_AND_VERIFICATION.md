# TEST AND VERIFICATION - DingTalk P4 Release Readiness

## Summary

Added a local release-readiness gate that composes private env readiness and local P4 regression results into one go/no-go report before the final 142/staging DingTalk smoke.

This does not replace the real smoke. It prevents starting that smoke when credentials, robot webhooks, manual target IDs, or local regression gates are not ready.

## Files

- `scripts/ops/dingtalk-p4-release-readiness.mjs`
- `scripts/ops/dingtalk-p4-release-readiness.test.mjs`
- `docs/development/dingtalk-p4-release-readiness-development-20260423.md`
- `docs/development/dingtalk-p4-release-readiness-verification-20260423.md`

## Verification

| Gate | Result |
| --- | --- |
| Release readiness Node tests | 5/5 passed |
| Release readiness + adjacent env/regression gate tests | 13/13 passed |
| Full DingTalk P4 ops regression suite | 95/95 passed |
| Default release readiness dry run | expected fail: env missing, ops regression pass |
| `git diff --check` | passed |

## Commands

```bash
node --test scripts/ops/dingtalk-p4-release-readiness.test.mjs

node --test \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-regression-gate.test.mjs

node --test $(ls scripts/ops/*dingtalk-p4*.test.mjs scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs 2>/dev/null | sort)

node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --output-dir /tmp/dingtalk-p4-release-readiness-default \
  --allow-failures

git diff --check
```

## Current Real Smoke Status

The current private env template is still not filled, so release readiness should fail until real inputs are added.

Run:

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs
```

Only if the report says `overallStatus: "pass"` should the operator run:

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --require-manual-targets \
  --output-dir output/dingtalk-p4-remote-smoke-session/142-session
```
