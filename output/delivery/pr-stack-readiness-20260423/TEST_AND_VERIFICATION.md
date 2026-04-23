# Test And Verification - PR Stack Readiness

Date: 2026-04-23

## Summary

Added `scripts/ops/check-pr-stack-readiness.mjs` to validate stacked PR chains.

This complements `check-pr-mainline-readiness.mjs`: the mainline guard blocks accidental stacked PR merges into main, while the stack guard validates intentional stacked queues and identifies the first dirty or discontinuous node.

## Verification

```bash
node --test scripts/ops/check-pr-stack-readiness.test.mjs
```

Passed: 7/7 tests.

```bash
git diff --check
```

Passed.

Full DingTalk open queue:

```bash
node scripts/ops/check-pr-stack-readiness.mjs \
  --input-json output/pr-stack-dingtalk-open-1052-1100-20260423.json \
  --format markdown \
  --output output/pr-stack-readiness-dingtalk-1052-1100-20260423.md
```

Expected result: `EXIT 1`, because `#1052`, `#1065`, and `#1078` are not ready in this sampled queue.

DingTalk P4 substack:

```bash
node scripts/ops/check-pr-stack-readiness.mjs \
  --root-base codex/dingtalk-person-delivery-skip-reasons-20260422 \
  --format markdown \
  --output output/pr-stack-readiness-dingtalk-p4-1076-1100-20260423.md \
  1076 1078 1082 1083 1085 1086 1087 1089 1090 1093 1094 1095 1097 1099 1100
```

Expected result: `EXIT 1`, with `#1078` identified as the first dirty P4 node.

## Reports

- `output/pr-stack-dingtalk-open-1052-1100-20260423.json`
- `output/pr-stack-readiness-dingtalk-1052-1100-20260423.md`
- `output/pr-stack-readiness-dingtalk-p4-1076-1100-20260423.md`

## Operational Conclusion

Do not advance the DingTalk P4 stack until `#1078` is rebased or otherwise repaired against `codex/dingtalk-p4-smoke-evidence-runner-20260422`.
