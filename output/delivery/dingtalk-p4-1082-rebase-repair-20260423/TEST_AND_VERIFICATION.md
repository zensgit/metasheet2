# Test And Verification - DingTalk P4 #1082 Rebase Repair

Date: 2026-04-23

## Summary

Rebased `#1082` (`test(dingtalk): add P4 smoke preflight gate`) onto the repaired `#1078` parent branch.

The rebase skipped already-applied parent commits and left `#1082` with only its preflight gate slice plus repair documentation.

## Verification

```bash
node --test \
  scripts/ops/dingtalk-p4-smoke-preflight.test.mjs \
  scripts/ops/dingtalk-p4-remote-smoke.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

Passed: 17/17 tests.

```bash
git diff --check origin/codex/dingtalk-p4-api-smoke-runner-20260422...HEAD
```

Passed.

## Next Check

After pushing, run:

```bash
node scripts/ops/check-pr-stack-readiness.mjs \
  --root-base codex/dingtalk-person-delivery-skip-reasons-20260422 \
  1076 1078 1082
```

Expected: `PASS`.
