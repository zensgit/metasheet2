# DingTalk P4 #1078 Rebase Repair Verification - 2026-04-23

## Local Targeted Tests

```bash
node --test \
  scripts/ops/dingtalk-p4-remote-smoke.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

Result:

```text
tests 12
pass 12
fail 0
```

## Diff Check

```bash
git diff --check origin/codex/dingtalk-p4-smoke-evidence-runner-20260422...HEAD
```

Result:

```text
EXIT 0
```

## Rebase Shape

```bash
git log --oneline origin/codex/dingtalk-p4-smoke-evidence-runner-20260422..HEAD
```

Result before adding these repair docs:

```text
458aa8294 test(dingtalk): add P4 API smoke runner
```

This confirms the earlier stack layers are no longer duplicated in `#1078` after rebase.

## Expected Remote Check After Push

After force-with-lease pushing the repaired branch:

```bash
node scripts/ops/check-pr-stack-readiness.mjs \
  --root-base codex/dingtalk-person-delivery-skip-reasons-20260422 \
  1076 1078
```

Expected result:

```text
PR stack readiness: PASS
```

## Residual Risk

Updating `#1078` changes the base branch for `#1082`, so downstream PRs may need their own rebase pass before the full P4 stack is clean.
