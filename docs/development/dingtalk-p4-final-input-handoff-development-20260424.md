# DingTalk P4 Final Input Handoff Development

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Base commit: `8205f0d10`
- Scope: add an operator handoff for the final private inputs needed before real P4 smoke

## Context

The safe automated readiness work has been exhausted. Token, allowlist, person target, and authorized user target are prepared in the ignored env. The remaining blockers are private DingTalk robot webhooks plus manual validation identities that cannot be fabricated from the current repo or local sandbox.

## Changes

- Added `docs/development/dingtalk-p4-final-input-handoff-20260424.md`.
- Listed the exact remaining env keys to collect.
- Added safe `--set-from-env` commands so private values can be written without echoing them into docs.
- Added the readiness command to run after final inputs are supplied.
- Added the smoke launch command and API reachability caveat.
- Added stop conditions for placeholder webhooks, reused users, invented no-email ids, and accidental artifact commits.
- Added the final closeout command that should produce the real release-ready development and verification notes.

## Out Of Scope

- No real webhook, robot secret, unauthorized user, or no-email DingTalk external id was supplied in this slice.
- No smoke session was started.
- No generated output artifact was committed.
