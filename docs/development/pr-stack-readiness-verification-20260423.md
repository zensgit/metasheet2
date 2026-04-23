# PR Stack Readiness Verification - 2026-04-23

## Local Unit Tests

```bash
node --test scripts/ops/check-pr-stack-readiness.test.mjs
```

Result:

```text
tests 7
pass 7
fail 0
```

## Whitespace Check

```bash
git diff --check
```

Result:

```text
EXIT 0
```

## Live GitHub Stack Report - Full Open DingTalk Queue

Command:

```bash
gh pr list --state open --limit 80 \
  --json number,title,state,baseRefName,headRefName,mergeStateStatus,reviewDecision,statusCheckRollup,url \
  --jq '[.[] | select(.number >= 1052 and .number <= 1100)] | sort_by(.number)' \
  > output/pr-stack-dingtalk-open-1052-1100-20260423.json

node scripts/ops/check-pr-stack-readiness.mjs \
  --input-json output/pr-stack-dingtalk-open-1052-1100-20260423.json \
  --format markdown \
  --output output/pr-stack-readiness-dingtalk-1052-1100-20260423.md
```

Result:

```text
EXIT 1
Overall: FAIL
```

Key failures:

- `#1052`: `mergeStateStatus is DIRTY, expected CLEAN`
- `#1065`: base continuity mismatch in the open-list sample
- `#1078`: `mergeStateStatus is DIRTY, expected CLEAN`

## Live GitHub Stack Report - DingTalk P4 Substack

Command:

```bash
node scripts/ops/check-pr-stack-readiness.mjs \
  --root-base codex/dingtalk-person-delivery-skip-reasons-20260422 \
  --format markdown \
  --output output/pr-stack-readiness-dingtalk-p4-1076-1100-20260423.md \
  1076 1078 1082 1083 1085 1086 1087 1089 1090 1093 1094 1095 1097 1099 1100
```

Result:

```text
EXIT 1
Overall: FAIL
```

Key finding:

- `#1076` passes.
- `#1078` is the first failing P4 node because it is `DIRTY`.
- `#1082` through `#1100` are continuous and `CLEAN`.

## Conclusion

The stack guard is working as intended. It does not hide partial readiness: it shows which nodes are clean and names the first blocking PR that needs rebase/repair before the stack can advance.
