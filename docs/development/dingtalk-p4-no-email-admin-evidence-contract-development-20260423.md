# DingTalk P4 No-Email Admin Evidence Contract Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Scope: make no-email admin evidence machine-verifiable before final closeout

## Problem

The no-email admin smoke step documented four structured facts:

- the DingTalk account email was blank;
- the created local user ID;
- the bound DingTalk external ID;
- the account row was linked after refresh.

The evidence template included these fields, but the recorder did not expose CLI flags for them and strict compile did not enforce them. That meant an operator could attach screenshots and still miss the structured contract until human review.

## Changes

- Added no-email admin flags to `dingtalk-p4-evidence-record.mjs`:
  - `--admin-email-was-blank`
  - `--admin-created-local-user-id`
  - `--admin-bound-dingtalk-external-id`
  - `--admin-account-linked-after-refresh`
- Recorder now writes `evidence.adminEvidence` with `temporaryPasswordRedacted: true`.
- Recorder rejects these admin flags for non-`no-email-user-create-bind` checks.
- Recorder requires all four flags when `no-email-user-create-bind` is recorded as `pass`.
- Strict compiler now requires:
  - `adminEvidence.emailWasBlank: true`
  - non-empty `adminEvidence.createdLocalUserId`
  - non-empty `adminEvidence.boundDingTalkExternalId`
  - `adminEvidence.accountLinkedAfterRefresh: true`
  - `adminEvidence.temporaryPasswordRedacted: true`
- Smoke-status TODO commands now include the structured admin flags.
- Final plan and remote smoke checklist now show the full command.

## Operator Impact

The final no-email evidence command now carries both screenshot artifacts and structured result fields:

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
  --admin-email-was-blank \
  --admin-created-local-user-id <local-user-id> \
  --admin-bound-dingtalk-external-id <dingtalk-external-id> \
  --admin-account-linked-after-refresh
```

This keeps the temporary password out of evidence while still proving that the admin create-and-bind flow completed.
