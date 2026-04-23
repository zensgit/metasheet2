# DingTalk P4 #1082 Rebase Repair Development - 2026-04-23

## Context

After repairing `#1078`, the DingTalk P4 stack guard advanced to the next dirty node:

- `#1076`: `PASS`
- `#1078`: `PASS`
- `#1082`: `DIRTY`

`#1082` targets `codex/dingtalk-p4-api-smoke-runner-20260422`, which changed when `#1078` was rebased and force-pushed.

## Repair

Rebased `codex/dingtalk-p4-smoke-preflight-20260422` onto the updated `#1078` head:

```bash
git rebase origin/codex/dingtalk-p4-api-smoke-runner-20260422
```

Result:

- skipped already-applied runbook, evidence compiler, and API smoke runner commits
- replayed only `test(dingtalk): add P4 smoke preflight gate`
- no manual conflicts

## Scope

This repair keeps the `#1082` PR focused on the P4 preflight readiness gate:

- `scripts/ops/dingtalk-p4-smoke-preflight.mjs`
- `scripts/ops/dingtalk-p4-smoke-preflight.test.mjs`
- related evidence compiler and packet-export updates
- P4 preflight development/verification docs

## Non-Goals

- Does not merge the DingTalk P4 stack.
- Does not repair downstream PRs `#1083` and later.
- Does not run real DingTalk webhook delivery.
