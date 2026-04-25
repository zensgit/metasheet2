# DingTalk P4 Final Closeout Integration Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Base: `origin/main` at `8d2d3e1b0`
- Scope: make the final closeout wrapper discoverable only when the generated next step is executable

## Problem

`dingtalk-p4-final-closeout.mjs` provided the one-command final chain, but some existing outputs still pointed primarily at the older lower-level commands:

- session summaries listed smoke-status, evidence-record, finalize, final-handoff, and packet export;
- smoke-status next commands suggested finalize/final-handoff directly;
- exported evidence packets did not yet include the final docs and final closeout helper scripts.

That meant the new wrapper existed, but operators could still miss it while following generated reports.

Follow-up hardening found two places where the closeout command was too early:

- `manual_pending` summaries should ask the operator to record manual evidence first, because final closeout would immediately fail strict finalize.
- failed strict-finalize summaries should keep evidence-record/finalize debug commands, but not recommend the one-command closeout until evidence is fixed.

## Changes

- Added `dingtalk-p4-final-closeout.mjs` to `dingtalk-p4-smoke-session.mjs` next commands after successful strict finalize.
- Kept bootstrap/manual-pending session summaries focused on smoke-status, evidence-record, finalize, and packet export.
- Kept failed strict-finalize summaries focused on evidence-record/finalize recovery instead of recommending closeout prematurely.
- Added `dingtalk-p4-final-closeout.mjs` to `dingtalk-p4-smoke-status.mjs` next commands for:
  - `finalize_pending`
  - `handoff_pending`
- Kept the lower-level finalize/final-handoff commands in next commands as debug fallbacks.
- Added `scripts/ops/dingtalk-p4-final-docs.mjs` and `scripts/ops/dingtalk-p4-final-closeout.mjs` to the exported staging evidence packet.
- Updated the packet README recommended order to prefer final closeout after manual evidence is complete, then list lower-level commands for debugging/manual recovery.
- Added a post-handoff `dingtalk-p4-smoke-status.mjs --handoff-summary ... --require-release-ready` refresh before final docs in the packet README manual chain.
- Hardened evidence-record secret detection/redaction for `client_secret=...`, `DINGTALK_CLIENT_SECRET=...`, and `DINGTALK_STATE_SECRET=...`.
- Made final-closeout `--skip-docs` summaries leave final docs outputs empty instead of advertising markdown files that were intentionally not generated.

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

For sessions still in `manual_pending`, the generated next command remains evidence recording first:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id authorized-user-submit \
  --status pass \
  --source manual-client \
  --operator qa \
  --summary "Allowed user submitted through DingTalk form link." \
  --artifact artifacts/authorized-user-submit/authorized-submit.png
```

## Out Of Scope

- No real staging credentials were introduced.
- No live DingTalk or 142/staging calls were made.
- The lower-level scripts remain available for troubleshooting and targeted reruns.
