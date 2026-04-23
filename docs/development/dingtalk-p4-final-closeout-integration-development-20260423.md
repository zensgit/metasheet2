# DingTalk P4 Final Closeout Integration Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Base: `origin/main` at `8d2d3e1b0`
- Scope: make the final closeout wrapper discoverable from existing session/status/packet entry points

## Problem

`dingtalk-p4-final-closeout.mjs` provided the one-command final chain, but some existing outputs still pointed primarily at the older lower-level commands:

- session summaries listed smoke-status, evidence-record, finalize, final-handoff, and packet export;
- smoke-status next commands suggested finalize/final-handoff directly;
- exported evidence packets did not yet include the final docs and final closeout helper scripts.

That meant the new wrapper existed, but operators could still miss it while following generated reports.

## Changes

- Added `dingtalk-p4-final-closeout.mjs` to `dingtalk-p4-smoke-session.mjs` next commands:
  - after bootstrap/manual-pending sessions;
  - after successful strict finalize;
  - after failed strict finalize as the preferred retry closeout path once evidence is fixed.
- Added `dingtalk-p4-final-closeout.mjs` to `dingtalk-p4-smoke-status.mjs` next commands for:
  - `manual_pending`
  - `finalize_pending`
  - `handoff_pending`
- Kept the lower-level finalize/final-handoff commands in next commands as debug fallbacks.
- Added `scripts/ops/dingtalk-p4-final-docs.mjs` and `scripts/ops/dingtalk-p4-final-closeout.mjs` to the exported staging evidence packet.
- Updated the packet README recommended order to prefer final closeout after manual evidence is complete, then list lower-level commands for debugging/manual recovery.

## Operator Impact

After this integration, the generated files themselves point to the faster path:

- `session-summary.json` / `session-summary.md`
- `smoke-status.json` / `smoke-status.md`
- exported packet `README.md`

The preferred final command remains:

```bash
node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --docs-output-dir docs/development \
  --date 20260423
```

## Out Of Scope

- No real staging credentials were introduced.
- No live DingTalk or 142/staging calls were made.
- The lower-level scripts remain available for troubleshooting and targeted reruns.
