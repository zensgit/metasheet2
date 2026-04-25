# DingTalk P4 Final Input Gates Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Scope: prevent final 142 smoke sessions from starting with inputs that cannot satisfy required strict evidence

## Problem

`delivery-history-group-person` is a required P4 smoke check, but final input docs and preflight behavior still treated person-message recipients as optional. That allowed a final session to bootstrap without `DINGTALK_P4_PERSON_USER_IDS`, leaving person delivery pending in a way manual screenshots cannot fully repair.

The release-readiness handoff also launched `smoke-session --env-file`, but `smoke-session` merges process environment over env-file values. A parent shell with stale `DINGTALK_P4_*` variables could make the smoke session use inputs different from the env file that release-readiness just checked.

## Changes

- `dingtalk-p4-env-bootstrap.mjs` now fails readiness when `DINGTALK_P4_PERSON_USER_IDS` is missing.
- `dingtalk-p4-smoke-preflight.mjs` adds `--require-person-user` for final gates while preserving API-only debug flexibility.
- `dingtalk-p4-smoke-session.mjs` always forwards `--require-person-user` to preflight and documents person user as a final input.
- `dingtalk-p4-release-readiness.mjs` clears DingTalk smoke input env vars before launching the smoke-session child so the checked env file is the source of truth.
- `dingtalk-p4-release-readiness.mjs` now treats an exit-0 smoke-session without a valid `session-summary.json` as `fail` instead of defaulting to `pass`.
- Remote smoke checklist and final plan/TODO now describe `DINGTALK_P4_PERSON_USER_IDS` as required for final release smoke.

## Operator Impact

The final path now fails fast until these private inputs are complete:

- admin/table-owner token;
- two canonical group robot webhooks;
- at least one allowlisted local user or member group;
- at least one person-message local user ID;
- manual target identities for authorized, unauthorized, and no-email admin evidence.

`dingtalk-p4-remote-smoke.mjs` still allows omitting `--person-user` for isolated API debugging, but that output is not a final release-ready run.

## Out Of Scope

- No real 142/staging smoke was executed.
- No real token, webhook, SEC secret, cookie, temporary password, or public form token was added to tracked files.
