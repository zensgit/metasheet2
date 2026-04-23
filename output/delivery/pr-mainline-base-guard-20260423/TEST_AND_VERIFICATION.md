# Test And Verification - PR Mainline Base Guard

Date: 2026-04-23

## Summary

Added a pre-merge guard for administrator PR promotion.

The guard prevents stacked PRs from being mistaken for mainline-ready PRs by explicitly checking `baseRefName`, `state`, `mergeStateStatus`, and check-rollup results before merge.

## Verification

```bash
node --test scripts/ops/check-pr-mainline-readiness.test.mjs
```

Passed: 8/8 tests.

```bash
git diff --check
```

Passed.

```bash
node scripts/ops/check-pr-mainline-readiness.mjs \
  --format markdown \
  --output output/pr-mainline-readiness-1063-1076-1099-20260423.md \
  1063 1076 1099
```

Expected result: failed with `EXIT 1` because all three sampled PRs do not target `main`.

```bash
node scripts/ops/check-pr-mainline-readiness.mjs \
  --base codex/dingtalk-person-delivery-skip-reasons-20260422 \
  1076
```

Expected result: passed with `EXIT 0` because the intentional stack base was explicitly provided.

## Operational Conclusion

Do not batch-admin-merge PRs based only on `CLEAN` and green checks. First run:

```bash
node scripts/ops/check-pr-mainline-readiness.mjs <pr-number>
```

Only proceed with mainline admin merge when this guard passes with the default `main` base.
