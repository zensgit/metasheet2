# PR Mainline Base Guard Verification - 2026-04-23

## Local Unit Tests

```bash
node --test scripts/ops/check-pr-mainline-readiness.test.mjs
```

Result:

```text
tests 8
pass 8
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

## Live GitHub Guard - Expected Failure For Stacked PRs

```bash
node scripts/ops/check-pr-mainline-readiness.mjs \
  --format markdown \
  --output output/pr-mainline-readiness-1063-1076-1099-20260423.md \
  1063 1076 1099
```

Result:

```text
EXIT 1
Overall: FAIL
```

Observed reasons:

- `#1063` is merged and targets `codex/dingtalk-person-granted-form-guard-20260422`, not `main`.
- `#1076` is open and clean, but targets `codex/dingtalk-person-delivery-skip-reasons-20260422`, not `main`.
- `#1099` is open and clean, but targets `codex/dingtalk-p4-final-handoff-command-20260423`, not `main`.

The generated evidence report is:

- `output/pr-mainline-readiness-1063-1076-1099-20260423.md`

## Live GitHub Guard - Expected Pass For Explicit Stack Base

```bash
node scripts/ops/check-pr-mainline-readiness.mjs \
  --base codex/dingtalk-person-delivery-skip-reasons-20260422 \
  1076
```

Result:

```text
EXIT 0
PR mainline readiness: PASS
```

This confirms the tool can still support intentional stacked PR operations, but only when the operator explicitly names the stack base.

## Stack State After Repair

- `origin/main` remains on `b25a6aea6` at the time of this verification.
- `#1063` and `#1075` are merged into their configured stack bases, not into `main`.
- `#1076` is reopened, rebased onto its updated stack base, `CLEAN`, and passing `pr-validate`.
- No top-of-stack DingTalk P4 flattening was attempted because the top branch diff against `main` spans 182 files and includes real DingTalk feature/runtime changes, not only P4 smoke tooling.
