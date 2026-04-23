# DingTalk P4 #1078 Rebase Repair Development - 2026-04-23

## Context

The DingTalk P4 substack readiness report identified `#1078` as the first dirty node:

- `#1076` was repaired and now passes against `codex/dingtalk-person-delivery-skip-reasons-20260422`.
- `#1078` targets `codex/dingtalk-p4-smoke-evidence-runner-20260422` but was still based on the pre-repair parent state.
- GitHub reported `mergeStateStatus = DIRTY` for `#1078`.

## Repair

Rebased `codex/dingtalk-p4-api-smoke-runner-20260422` onto the updated parent:

```bash
git rebase origin/codex/dingtalk-p4-smoke-evidence-runner-20260422
```

Result:

- skipped already-applied `docs(dingtalk): add P4 smoke runbook`
- skipped already-applied `test(dingtalk): add P4 smoke evidence compiler`
- replayed only `test(dingtalk): add P4 API smoke runner`
- no manual conflicts

The rebased PR diff is now limited to the API smoke runner slice plus this repair documentation.

## Files In Scope

Functional slice already present in `#1078`:

- `scripts/ops/dingtalk-p4-remote-smoke.mjs`
- `scripts/ops/dingtalk-p4-remote-smoke.test.mjs`
- related evidence compiler/export packet updates
- DingTalk P4 remote-smoke docs

Repair docs added in this update:

- `docs/development/dingtalk-p4-1078-rebase-repair-development-20260423.md`
- `docs/development/dingtalk-p4-1078-rebase-repair-verification-20260423.md`
- `output/delivery/dingtalk-p4-1078-rebase-repair-20260423/TEST_AND_VERIFICATION.md`

## Non-Goals

- Does not merge the DingTalk P4 stack.
- Does not rebase downstream PRs `#1082` and later.
- Does not run real DingTalk webhook delivery; this remains an operator/staging smoke step.
