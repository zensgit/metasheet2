# TEST AND VERIFICATION - DingTalk P4 Stack Rebase Repair

Date: 2026-04-23

## Outcome

The DingTalk P4 stacked PR segment was repaired and verified. All repaired child branches were rebased onto their current parent branch and pushed with `--force-with-lease`.

No DingTalk business PR was merged as part of this work.

## Verified Stack

```text
#1076 -> #1078 -> #1082 -> #1083 -> #1085 -> #1086 -> #1087 -> #1089 -> #1090 -> #1093 -> #1094 -> #1095 -> #1097 -> #1099 -> #1100
```

## Evidence

| Evidence | Result |
| --- | --- |
| Stack readiness report | `output/pr-stack-readiness-dingtalk-p4-after-repair-20260423.md` |
| Stack readiness result | PASS |
| GitHub merge state | all rows CLEAN |
| GitHub checks | all repaired PRs have passing `pr-validate` |
| Top-of-stack local tests | 71/71 passed |
| Whitespace/diff check | passed |

## Commands

```bash
node --test $(ls scripts/ops/*dingtalk-p4*.test.mjs scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs 2>/dev/null | sort)
git diff --check origin/codex/dingtalk-p4-smoke-status-report-20260423...HEAD
node scripts/ops/check-pr-stack-readiness.mjs --root-base codex/dingtalk-person-delivery-skip-reasons-20260422 --format markdown --output output/pr-stack-readiness-dingtalk-p4-after-repair-20260423.md 1076 1078 1082 1083 1085 1086 1087 1089 1090 1093 1094 1095 1097 1099 1100
```

## Result

The P4 substack is ready for normal review/merge sequencing. Larger DingTalk mainline readiness should still be evaluated separately because #1052 and neighboring non-P4 stack segments were not changed by this repair.
