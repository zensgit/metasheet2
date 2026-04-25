# DingTalk P4 User Target Readiness Development

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Base commit: `12f6c9fac`
- Scope: reduce P4 private readiness blockers by filling safe user target fields from 142 data

## Context

After token readiness, release-readiness still failed on group webhooks, allowlist, person smoke input, and manual targets. The next safe step was to inspect 142 user and DingTalk identity data to determine which target fields could be filled without guessing or committing private values.

## Changes

- Queried 142 for users, DingTalk external identities, and DingTalk grants.
- Confirmed there is one active local user with a DingTalk identity and DingTalk grant.
- Wrote that local user id into the ignored P4 env as:
  - `DINGTALK_P4_ALLOWED_USER_IDS`
  - `DINGTALK_P4_PERSON_USER_IDS`
  - `DINGTALK_P4_AUTHORIZED_USER_ID`
- Re-ran release-readiness in regression-plan-only mode.
- Updated the current remaining-development TODO to show allowlist, person target, and authorized manual target readiness as complete.

## Remaining External Inputs

- Two real DingTalk group robot webhook URLs.
- Optional `SEC...` robot signing secrets if the robots require signing.
- A second DingTalk-bound local user for unauthorized-denial proof.
- A no-email DingTalk external identity for admin create-and-bind proof.

## Out Of Scope

- No real DingTalk group send was executed.
- No real 142 smoke session was started.
- No webhook URL, robot secret, user token, public form token, temporary password, or raw admin token was committed.
- The single existing DingTalk-bound user was not duplicated or mutated; this slice only filled the private ignored env.
