# DingTalk P4 Evidence Record Auto Closeout Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Scope: reduce the final manual evidence to release-ready handoff from two commands to one operator command

## Problem

The evidence recorder already refreshed smoke status and could run strict finalize with `--finalize-when-ready`, but the normal release path now prefers `dingtalk-p4-final-closeout.mjs` because it handles strict finalize, final handoff, release-ready status, and final docs in one chain.

That left one extra manual hop after recording the last DingTalk-client/admin artifact.

## Changes

- Added `--closeout-when-ready` to `scripts/ops/dingtalk-p4-evidence-record.mjs`.
- Added closeout forwarding options:
  - `--closeout-packet-output-dir`
  - `--closeout-docs-output-dir`
  - `--closeout-date`
  - `--closeout-skip-docs`
- Kept the existing readiness gate: closeout runs only after the refreshed smoke status is `finalize_pending` with zero gaps and zero remaining TODO items.
- Rejected conflicting `--closeout-when-ready` and `--finalize-when-ready` usage so operators do not run two final chains.
- Updated the final plan and remote smoke checklist to prefer auto-closeout for the last manual evidence update.

## Operator Flow

Use this on the final evidence update only:

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
  --closeout-when-ready \
  --closeout-packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --closeout-docs-output-dir docs/development \
  --closeout-date 20260423
```

If the session is not ready, the recorder still records evidence and refreshes status, but it does not run closeout.

## Out Of Scope

- No real 142/staging call was made.
- No admin token, webhook, signing secret, temporary password, cookie, or raw public form token was added to tracked files.
