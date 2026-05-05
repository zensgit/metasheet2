# DingTalk Public Form Access Matrix Design

- Date: 2026-04-28
- Scope: public multitable form sharing, DingTalk protected access, local allowlists

## Product Rule

Public form sharing now has three effective audience modes:

| Scenario | Access mode | Local allowlist | Required identity | Fill behavior |
| --- | --- | --- | --- | --- |
| 1. Fully public anonymous fill | `public` | Not allowed | None | Anyone with the link can open and submit. |
| 2. User login required | `dingtalk` | Empty | DingTalk-bound local user | Anonymous visitors launch DingTalk sign-in. Bound users can fill. Unbound users see a binding-required message. |
| 2.1 User not DingTalk-bound | `dingtalk` | Empty | Missing binding | Rejected with `DINGTALK_BIND_REQUIRED`. |
| 2.2 User DingTalk-bound | `dingtalk` | Empty | Binding present | Allowed. |
| 3. Selected users or groups fill | `dingtalk` or `dingtalk_granted` | Non-empty users/groups | DingTalk-bound selected user, or selected group member | Users outside the local allowlist are rejected. |
| 3.1 Selected user not DingTalk-bound | `dingtalk` or `dingtalk_granted` | User/group selected | Missing binding | Rejected with `DINGTALK_BIND_REQUIRED`. |
| 3.2 Selected user DingTalk-bound | `dingtalk` | User/group selected | Binding present | Allowed. |
| 3.2 Selected user DingTalk-bound and authorization required | `dingtalk_granted` | User/group selected | Binding and enabled DingTalk grant | Allowed only when grant is enabled; otherwise `DINGTALK_GRANT_REQUIRED`. |

## Password-Change Rule

Users created from platform management or directory sync may have `must_change_password = true` until their first local-password login.

That flag should not block the DingTalk public-form filling path when the user authenticates through DingTalk. The form flow is an external-auth, narrow-scoped filling session, not full local account access. Therefore:

- Public-form requests with a valid public token can optionally hydrate that user and continue DingTalk binding/grant/allowlist checks.
- Normal authenticated app routes still return `PASSWORD_CHANGE_REQUIRED` and route the user to `/force-password-change`.
- Local password login and platform-wide navigation still require first password change.

## Implementation

Backend:

- Public form allowlist summaries now include DingTalk status fields for allowed local users:
  - `dingtalkBound`
  - `dingtalkGrantEnabled`
  - `dingtalkPersonDeliveryAvailable`
- Existing access checks remain the source of truth:
  - `public` bypasses DingTalk user checks.
  - `dingtalk` requires a DingTalk binding.
  - `dingtalk_granted` requires binding plus enabled DingTalk form authorization.
  - Non-empty `allowedUserIds` or `allowedMemberGroupIds` narrows access after DingTalk checks.

Frontend:

- The form-share dialog shows an explicit audience rule card:
  - Fully public anonymous form
  - All DingTalk-bound users
  - All authorized DingTalk users
  - Selected DingTalk-bound users
  - Selected authorized DingTalk users
- Allowed users and search candidates show their DingTalk status so operators can identify 3.1 and 3.2 before sharing.
- Member groups show that members are checked individually.

## Operational Guidance

For the user case described on 2026-04-28: a DingTalk user imported by platform management but not yet locally password-changed should be able to fill a DingTalk-protected public form after DingTalk sign-in, as long as they pass the binding/grant/allowlist rule. They should only be forced to change password when entering the main platform app or using local password login.

