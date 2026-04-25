# DingTalk P4 Evidence Record Autorefresh Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Base: `origin/main` at `8d2d3e1b0`
- Scope: shorten the last-mile manual evidence loop after a remote DingTalk P4 session already exists

## Problem

The DingTalk P4 session tooling already produced:

- `workspace/evidence.json`
- `smoke-status.json`
- `smoke-status.md`
- `smoke-todo.md`
- `dingtalk-p4-smoke-session.mjs --finalize`

But the operator loop was still split:

1. record one manual check with `dingtalk-p4-evidence-record.mjs`
2. rerun `dingtalk-p4-smoke-status.mjs`
3. inspect whether finalize was now safe
4. run `dingtalk-p4-smoke-session.mjs --finalize`

That left unnecessary command churn in the last part of the workflow.

## Changes

- Extended `scripts/ops/dingtalk-p4-evidence-record.mjs` so that successful `--session-dir` writes now refresh:
  - `smoke-status.json`
  - `smoke-status.md`
  - `smoke-todo.md`
- Added `--no-refresh-status` for cases where the operator wants a pure evidence write without post-update orchestration.
- Added `--finalize-when-ready`:
  - refreshes smoke status first;
  - only attempts finalize when the refreshed smoke status reaches `finalize_pending` with no remaining required TODO items;
  - prints the next final handoff command when finalization succeeds.
- Added test-only override env vars so recorder-side orchestration can be unit-tested without real DingTalk or staging access:
  - `DINGTALK_P4_EVIDENCE_RECORD_STATUS_SCRIPT`
  - `DINGTALK_P4_EVIDENCE_RECORD_FINALIZE_SCRIPT`
- Updated `dingtalk-p4-smoke-status.mjs` TODO notes and operator docs so they no longer instruct operators to rerun smoke-status after every evidence update.
- Updated the offline handoff chain test so the last evidence-record write triggers auto-finalize instead of requiring a separate explicit finalize command.

## Operator Flow

Normal evidence update:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id authorized-user-submit \
  --status pass \
  --source manual-client \
  --operator qa \
  --summary "Allowed DingTalk-bound user opened the group link and submitted one record." \
  --artifact artifacts/authorized-user-submit/authorized-submit.png
```

Expected effect:

- `workspace/evidence.json` is updated.
- `smoke-status.json` / `smoke-status.md` / `smoke-todo.md` are refreshed automatically.

Final manual evidence update:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id no-email-user-create-bind \
  --status pass \
  --source manual-admin \
  --operator qa-admin \
  --summary "Admin created and bound a no-email DingTalk-synced local user; temporary password is redacted." \
  --artifact artifacts/no-email-user-create-bind/admin-create-bind-result.png \
  --artifact artifacts/no-email-user-create-bind/account-linked-after-refresh.png \
  --finalize-when-ready
```

Expected effect:

- smoke status refresh happens first;
- finalize only runs if the session is actually ready;
- on success, the recorder prints the next `dingtalk-p4-final-handoff.mjs --session-dir ...` command.

## Out Of Scope

- No real staging/admin token was added.
- No DingTalk webhook or SEC secret was stored in tracked files.
- No live 142/staging smoke evidence was created by this slice alone.
