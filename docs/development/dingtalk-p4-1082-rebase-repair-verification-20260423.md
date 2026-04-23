# DingTalk P4 #1082 Rebase Repair Verification - 2026-04-23

## Local Targeted Tests

```bash
node --test \
  scripts/ops/dingtalk-p4-smoke-preflight.test.mjs \
  scripts/ops/dingtalk-p4-remote-smoke.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

Result:

```text
tests 17
pass 17
fail 0
```

## Diff Check

```bash
git diff --check origin/codex/dingtalk-p4-api-smoke-runner-20260422...HEAD
```

Result:

```text
EXIT 0
```

## Rebase Shape

```bash
git log --oneline origin/codex/dingtalk-p4-api-smoke-runner-20260422..HEAD
```

Result before adding these repair docs:

```text
105560b32 test(dingtalk): add P4 smoke preflight gate
```

This confirms the parent stack commits are no longer duplicated in `#1082` after rebase.

## Expected Remote Check After Push

After force-with-lease pushing the repaired branch:

```bash
node scripts/ops/check-pr-stack-readiness.mjs \
  --root-base codex/dingtalk-person-delivery-skip-reasons-20260422 \
  1076 1078 1082
```

Expected result:

```text
PR stack readiness: PASS
```

## Residual Risk

Updating `#1082` changes the base branch for `#1083`, so downstream PRs may need their own rebase pass before the full P4 stack is clean.
