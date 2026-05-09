# DingTalk Public Form Member Group Allowlist Verification - 2026-05-05

## Goal

Verify the DingTalk public-form allowlist path that grants access through a platform member group, not only through direct `allowedUserIds`.

## Live 142 Setup

Target:

- Deployment: `142.171.239.56`
- Form view: latest DingTalk P4 protected form
- Access mode: `dingtalk_granted`
- Direct allowed users: `1`
- Allowed member groups: `1`

Temporary member group:

- Name: `P4 DingTalk Form Allowed Test`
- Member: account 2, `王松松 / wss142`
- Created for this verification only.

Safety:

- The previous form config was backed up on 142 at `/tmp/metasheet-p4-member-group-allowlist-backup-20260505T003933Z.json`.
- No public form token, JWT, webhook, or DingTalk secret is recorded in this document.

## Implementation Notes

The first probe after direct DB update still denied account 2. Data inspection showed the membership row and allowlist config were correct, so the mismatch was caused by the backend view-config cache retaining the previous `allowed_groups=0` state.

Action taken:

- Restarted only `metasheet-backend` to clear the in-memory `metaViewConfigCache`.
- Health check passed after restart.

Health summary:

```text
status=ok
success=true
plugins.total=13
plugins.active=13
dbPool.waiting=0
```

## Probe Results

The probes used short-lived server-signed JWTs to simulate the post-DingTalk-auth public-form policy check. Tokens were not printed or stored.

| Scenario | Expected | Actual |
| --- | --- | --- |
| Anonymous request | Requires DingTalk auth | `401 DINGTALK_AUTH_REQUIRED` |
| Account 1 direct allowlist user | Allowed | `200 OK` |
| Account 2 member-group user | Allowed through group | `200 OK` |
| Account 3 not in allowlist | Denied by allowlist | `403 DINGTALK_FORM_NOT_ALLOWED` |

## Conclusion

The member-group allowlist path works on 142 after the backend cache is refreshed. Account 2 can be granted access through a platform member group even though ordinary platform navigation still requires password change.

## Manual Follow-Up

Use account 2 in DingTalk to open the current P4 public-form link. Expected result:

- It should no longer show "not in authorized user group".
- It should enter the form flow because the user is now in the allowed member group.

Use account 3 to open the same link. Expected result:

- It should still fail before or at authorization, depending on whether the DingTalk identity is linked.
- It must not gain access through the temporary group.

