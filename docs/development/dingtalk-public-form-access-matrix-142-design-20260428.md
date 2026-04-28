# DingTalk Public Form Access Matrix 142 Design - 2026-04-28

## Goal

Make the public-form share configuration page explain the real DingTalk access matrix before operators publish a form link.

The runtime guard for public forms already enforces these modes:

| Case | Access mode | Local allowlist | Expected behavior |
| --- | --- | --- | --- |
| Fully public anonymous fill | `public` | Empty | Anyone with the link can open and submit without local login or DingTalk binding. |
| DingTalk login required | `dingtalk` | Empty | Any local user with a DingTalk binding can fill. Unbound users are rejected with `DINGTALK_BIND_REQUIRED`. |
| DingTalk login required for selected users/groups | `dingtalk` | Non-empty users or groups | User must be DingTalk-bound and included directly or through a selected member group. Users outside the allowlist are rejected with `DINGTALK_FORM_NOT_ALLOWED`. |
| DingTalk authorization required | `dingtalk_granted` | Empty | Any DingTalk-bound local user can fill only after the administrator enables the user's DingTalk form grant. Missing grant is rejected with `DINGTALK_GRANT_REQUIRED`. |
| DingTalk authorization required for selected users/groups | `dingtalk_granted` | Non-empty users or groups | User must pass DingTalk binding, DingTalk grant, and local allowlist checks. |

## Password-change Interaction

The deployed `origin/main` baseline already includes the narrow public-form password-change fix. A platform-created DingTalk user with `must_change_password = true` should not be forced through local password change when filling a DingTalk-protected public form through the public-form token flow.

The local password-change requirement still applies to normal application routes and local-password login flows.

## Implementation

Backend:

- Extend `PublicFormAllowedSubjectSummary` with DingTalk status fields:
  - `dingtalkBound`
  - `dingtalkGrantEnabled`
  - `dingtalkPersonDeliveryAvailable`
- Reuse `enrichFormShareCandidatesWithDingTalkStatus()` for configured `allowedUsers` and `allowedMemberGroups`, not only search candidates.
- Preserve existing allowlist ID ordering and fallback summaries for deleted or missing subjects.

Frontend:

- Add an access-rule card under the access-mode selector:
  - `public`: fully public anonymous form
  - `dingtalk`: all or selected DingTalk-bound users
  - `dingtalk_granted`: all or selected authorized DingTalk users
- Show per-subject DingTalk status for allowed users and candidate rows:
  - `DingTalk not bound`
  - `DingTalk bound`
  - `DingTalk bound and authorized`
  - `DingTalk authorization not enabled`
  - `DingTalk delivery linked`
  - `Members are checked individually`

## Deployment Position

The access-matrix change was first deployed to 142 with merge commit `1084f6ebb81f79423d33f25fb4baed8f28e98208`, which contains both:

- The existing public-form password-change bypass for DingTalk token-authenticated fill flows.
- The operator-facing public-form DingTalk access-matrix UI and config-response enrichment from PR #1212.

The final observed host state now runs a later mainline image, `1366cb7bf8728848bb743bfc57e43f907dd78efa`, which includes commit `1084f6ebb81f79423d33f25fb4baed8f28e98208`. The docs-only merge that records this evidence does not trigger a new Docker deploy because `.github/workflows/docker-build.yml` ignores `docs/**` changes.

Deployment happened through `.github/workflows/docker-build.yml` after the branch was merged to `main`.

The first deploy attempt failed during deploy-host file sync because the remote root filesystem was full. Old unused Docker images and one stale release image bundle were removed without touching Docker volumes, then the failed workflow jobs were re-run successfully.

The companion verification document records the exact post-deploy checks.
