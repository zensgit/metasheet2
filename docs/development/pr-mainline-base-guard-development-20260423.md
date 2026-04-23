# PR Mainline Base Guard Development - 2026-04-23

## Context

During the DingTalk P4 PR queue review, several PRs looked merge-ready because they were `CLEAN` and had passing `pr-validate` checks. A closer inspection showed they were stacked PRs whose `baseRefName` was another feature branch, not `main`.

Two PRs were merged into their configured stack bases before that was detected:

- `#1063` into `codex/dingtalk-person-granted-form-guard-20260422`
- `#1075` into `codex/dingtalk-person-delivery-skip-reasons-20260422`

No `main` branch commit was created by those merges. The local `origin/main` remained at `b25a6aea6` during the stack inspection.

`#1076` was reopened after a failed mergeability attempt, rebased onto the updated stack base, force-with-lease pushed, and restored to `CLEAN` with `pr-validate` passing.

## Change

Added `scripts/ops/check-pr-mainline-readiness.mjs`.

The tool checks one or more PRs before an administrator merge and fails if:

- PR state is not `OPEN`
- PR base is not the expected branch, defaulting to `main`
- `mergeStateStatus` is not `CLEAN`
- any required check is pending or failing

It supports:

- live GitHub checks via `gh pr view`
- offline JSON input for deterministic testing
- `text`, `markdown`, and `json` output
- `--base <branch>` for intentional stack-base checks
- `--output <path>` for saving evidence reports

## Why This Shape

The key failure mode was not CI, test coverage, or mergeability. It was target-branch ambiguity.

The guard makes the intended merge target explicit. For normal mainline promotion the command should be:

```bash
node scripts/ops/check-pr-mainline-readiness.mjs <pr-number>
```

For an intentional stacked PR merge, the operator must state the stack base:

```bash
node scripts/ops/check-pr-mainline-readiness.mjs \
  --base codex/dingtalk-person-delivery-skip-reasons-20260422 \
  1076
```

That distinction prevents a stacked PR from being treated as a mainline-ready PR simply because it is `CLEAN`.

## Files

- `scripts/ops/check-pr-mainline-readiness.mjs`
- `scripts/ops/check-pr-mainline-readiness.test.mjs`
- `docs/development/pr-mainline-base-guard-development-20260423.md`
- `docs/development/pr-mainline-base-guard-verification-20260423.md`
- `output/delivery/pr-mainline-base-guard-20260423/TEST_AND_VERIFICATION.md`

## Non-Goals

- Does not replace branch protection.
- Does not approve or merge PRs.
- Does not flatten stacked PRs.
- Does not decide whether a stacked PR should be promoted to `main`.
