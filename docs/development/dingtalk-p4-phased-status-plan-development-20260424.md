# DingTalk P4 Phased Status Plan Development

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Scope: make the remaining DingTalk remote-smoke work executable directly from generated status/TODO outputs

## Problem

The DingTalk P4 product and tooling chain is already implemented locally. The remaining blockers are the real remote-smoke steps on staging, but the generated status outputs were still too flat:

- `smoke-status.json` and `smoke-status.md` showed per-check pass/fail state, but not an ordered execution plan for the remaining remote-smoke work.
- `smoke-todo.md` was a flat checklist, which made the operator infer the intended sequence from the docs.
- Check-level evidence details already existed in `workspace/evidence.json`, but the generated status view did not surface the key IDs, delivery counts, or manual targets that explain what had already been bootstrapped.

## Changes

- Added an ordered remote-smoke execution plan to `dingtalk-p4-smoke-status.mjs`.
- Grouped the remaining work into four operator-facing phases:
  - bootstrap remote smoke workspace
  - capture DingTalk group message evidence
  - validate protected form access
  - validate delivery history and no-email admin flow
- Added `executionPlan` and `currentFocus` to the generated status JSON.
- Added `docSection`, `topLevelLabel`, `evidenceSnapshot`, and `firstIssueMessage` to `requiredChecks[]`.
- Added a `Top-level Remote Smoke Steps` table to `smoke-status.md` so checklist Smoke 1-7 steps map directly to check IDs and sanitized evidence snapshots.
- Changed `smoke-todo.md` from a flat list to an ordered phase plan with the current focus step and artifact folder hints.
- Updated the remote smoke checklist and the master DingTalk feature TODO to reflect the new generated plan view.

## Operator Impact

For a normal session such as:

```bash
node scripts/ops/dingtalk-p4-smoke-status.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session
```

the generated outputs now answer three practical questions directly:

1. Which remote-smoke phase should be worked on next?
2. Which check is the current focus?
3. What bootstrap evidence already exists for that check?

This reduces the need to cross-read `evidence.json`, checklist sections, and session summaries while collecting the final manual DingTalk evidence.

## Out Of Scope

- No real 142 staging smoke, DingTalk tenant, webhook, admin token, or user token was used.
- This does not change the remote smoke runner, strict evidence contract, finalization logic, handoff gate, or packet validation logic.
