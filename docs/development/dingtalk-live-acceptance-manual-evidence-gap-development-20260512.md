# DingTalk Live Acceptance Manual Evidence Gap Development - 2026-05-12

## Summary

This closeout slice records the remaining strict evidence gap for the 142 DingTalk live acceptance run after the production runtime was restored and the automated checks passed.

No runtime code changed in this slice. The change is intentionally documentation-only because the current blocker is evidence quality and target selection, not an application defect.

## Current Live Session

| Item | Value |
| --- | --- |
| 142 backend image | `ghcr.io/zensgit/metasheet2-backend:b88f6c243ce882c65dc794c188e8d0e677f6cb64` |
| 142 web image | `ghcr.io/zensgit/metasheet2-web:b88f6c243ce882c65dc794c188e8d0e677f6cb64` |
| Smoke session | `142-live-20260512-token` |
| Session status | `manual_pending` |
| Progress | `4/8` required checks complete |
| Current generated sheet | `sheet_9bb5ca3e-dbf9-4a8f-9bf4-5c3dc1047c97` |
| Current generated form view | `view_d7bfe0f1-0624-4370-97b8-40e07b1483c1` |

Completed checks:

- `create-table-form`
- `bind-two-dingtalk-groups`
- `set-form-dingtalk-granted`
- `delivery-history-group-person`

Pending checks:

- `send-group-message-form-link`
- `authorized-user-submit`
- `unauthorized-user-denied`
- `no-email-user-create-bind`

## Evidence Decision

The screenshots available in the local Downloads folder cannot be used as strict PASS evidence for the current 2026-05-12 live session.

Reason:

- Their file timestamps are 2026-05-10.
- They show the prior smoke sheet context, not the current `sheet_9bb5ca3e-dbf9-4a8f-9bf4-5c3dc1047c97` session.
- Strict closeout evidence must match the active smoke session and current generated form link.

This avoids incorrectly closing the matrix with stale screenshots.

## No-Email Target Finding

The generated no-email target in the active smoke session is not suitable for strict `no-email-user-create-bind` PASS evidence.

Live 142 directory inspection showed:

- The generated smoke target ending in `1174` is a blank-email DingTalk directory account, but it is already linked to the admin local user.
- The `ddzz` DingTalk directory account ending in `9104` is also blank-email and linked to a no-email local user.

Implication:

- The generated target cannot prove the required "create a local no-email user and bind the DingTalk identity" flow because the account is already linked to an existing admin user.
- The `ddzz` account can support an "existing no-email linked DingTalk user" proof, but it does not by itself satisfy the stricter "create-and-bind during this evidence run" semantics unless the admin flow is re-executed and captured.

## Required Strict Evidence

The code-level evidence contract requires `no-email-user-create-bind` PASS evidence to include all of the following:

- `emailWasBlank: true`
- `createdLocalUserId`
- `boundDingTalkExternalId`
- `accountLinkedAfterRefresh: true`
- `temporaryPasswordRedacted: true`
- Admin artifacts for create/bind result and refresh-after-bind state

The recorder also rejects admin evidence flags on non-`no-email-user-create-bind` checks and requires the admin flags when this check is marked PASS.

## Recommended Closeout Path

Use one of these two paths before flipping the final matrix to CLOSED.

Path A, preferred:

1. Pick a truly unbound DingTalk directory account with no email.
2. Put that external id into the private P4 env file as `DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID`.
3. Re-run the P4 smoke session so the generated target matches the planned admin evidence.
4. Create the local user from the synced DingTalk directory account in the admin UI.
5. Confirm the account remains linked after refresh.
6. Record `no-email-user-create-bind` with redacted artifacts and no temporary password in text.

Path B, acceptable only if the product owner agrees to narrowed semantics:

1. Use `ddzz` as a pre-existing no-email DingTalk-linked local user proof.
2. Record the evidence as "existing no-email linked identity verified" instead of "created during this session".
3. Keep `no-email-user-create-bind` marked pending in the strict release matrix unless the create-and-bind action is performed and captured.

## Manual Evidence Still Needed

For current session `142-live-20260512-token`, collect fresh 2026-05-12 evidence for:

- DingTalk group message with the current protected form link.
- Authorized user open and successful submit.
- Unauthorized user denial with zero record insert.
- No-email DingTalk directory account create/bind, or an explicitly approved narrowed proof.

## Recorder Commands

Use the generated session commands, with artifacts placed under `workspace/artifacts/<check-id>/`:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-live-20260512-token \
  --check-id send-group-message-form-link \
  --status pass \
  --source manual-client \
  --operator <operator> \
  --summary "<summary>" \
  --artifact artifacts/send-group-message-form-link/<file>
```

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-live-20260512-token \
  --check-id authorized-user-submit \
  --status pass \
  --source manual-client \
  --operator <operator> \
  --summary "<summary>" \
  --artifact artifacts/authorized-user-submit/<file>
```

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-live-20260512-token \
  --check-id unauthorized-user-denied \
  --status pass \
  --source manual-client \
  --operator <operator> \
  --summary "<summary>" \
  --artifact artifacts/unauthorized-user-denied/<file> \
  --submit-blocked \
  --record-insert-delta 0 \
  --blocked-reason "<visible denial reason>"
```

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-live-20260512-token \
  --check-id no-email-user-create-bind \
  --status pass \
  --source manual-admin \
  --operator <operator> \
  --summary "Admin created and bound a no-email DingTalk-synced local user; temporary password is redacted." \
  --artifact artifacts/no-email-user-create-bind/admin-create-bind-result.png \
  --artifact artifacts/no-email-user-create-bind/account-linked-after-refresh.png \
  --admin-email-was-blank \
  --admin-created-local-user-id <local-user-id> \
  --admin-bound-dingtalk-external-id <dingtalk-external-id> \
  --admin-account-linked-after-refresh
```

Finalize only after all four pending checks are recorded:

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --finalize output/dingtalk-p4-remote-smoke-session/142-live-20260512-token
```

## Security Notes

- Do not commit or paste webhook URLs, `SEC` values, bearer tokens, JWTs, app secrets, temporary passwords, or complete public form tokens.
- Screenshot artifacts must be reviewed before commit or upload to ensure no secrets are visible.
- Temporary password evidence should be a redacted note or masked screenshot only.
