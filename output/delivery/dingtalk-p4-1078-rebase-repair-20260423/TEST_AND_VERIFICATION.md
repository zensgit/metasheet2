# Test And Verification - DingTalk P4 #1078 Rebase Repair

Date: 2026-04-23

## Summary

Rebased `#1078` (`test(dingtalk): add P4 API smoke runner`) onto the repaired `#1076` parent branch.

The rebase skipped already-applied parent commits and left `#1078` with only its API smoke runner slice plus repair documentation.

## Verification

```bash
node --test \
  scripts/ops/dingtalk-p4-remote-smoke.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

Passed: 12/12 tests.

```bash
git diff --check origin/codex/dingtalk-p4-smoke-evidence-runner-20260422...HEAD
```

Passed.

## Next Check

After pushing, run:

```bash
node scripts/ops/check-pr-stack-readiness.mjs \
  --root-base codex/dingtalk-person-delivery-skip-reasons-20260422 \
  1076 1078
```

Expected: `PASS`.

Then re-run the full P4 substack readiness report to identify the next dirty downstream node.
