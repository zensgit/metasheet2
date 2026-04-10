# DingTalk PR2 Directory Sync Design

Date: 2026-04-08
Branch: `codex/dingtalk-pr2-directory-sync-20260408`
Scope: DingTalk directory integration CRUD, manual sync, sync runs/history, minimal admin UI

## Goal

PR2 adds a usable DingTalk directory integration slice on top of PR1 login foundation without importing the historical featureline wholesale.

The target for this slice is:

- create and update DingTalk directory integrations
- test DingTalk app credentials and root department reachability
- manually run a directory sync
- persist departments, accounts, account-department membership, and link suggestions
- expose recent sync runs to admins
- provide a minimal admin UI at `/admin/directory`

## Why not reuse the historical branch directly

The historical DingTalk directory branch contains a much larger surface:

- deprovision ledgers
- alert acknowledgement workflows
- template center
- scheduler and alerting combinations
- auth helper rewrites
- large frontend shell changes

Current main already has the required tables for directory sync. Pulling the full historical branch into current main would create unnecessary conflicts in `auth.ts`, router types, admin shell code, and generated OpenAPI artifacts.

This PR deliberately keeps the write set narrow:

- backend:
  - `packages/core-backend/src/integrations/dingtalk/client.ts`
  - `packages/core-backend/src/directory/directory-sync.ts`
  - `packages/core-backend/src/routes/admin-directory.ts`
  - `packages/core-backend/src/index.ts`
- frontend:
  - `apps/web/src/views/DirectoryManagementView.vue`
  - `apps/web/src/router/appRoutes.ts`
  - `apps/web/src/router/types.ts`
  - `apps/web/src/views/UserManagementView.vue`

## Backend design

### DingTalk client extension

`packages/core-backend/src/integrations/dingtalk/client.ts` is extended from PR1 OAuth support to also cover directory APIs:

- app access token
- list sub-departments
- list users in a department
- fetch user detail

This keeps DingTalk HTTP normalization in one place instead of duplicating it in attendance, auth, and directory modules.

### Directory service

`packages/core-backend/src/directory/directory-sync.ts` is the backend core for PR2.

Responsibilities:

- list integrations with lightweight stats
- create and update integration config
- test credentials against DingTalk APIs
- execute manual sync
- persist sync run history

The service uses existing tables from current main:

- `directory_integrations`
- `directory_departments`
- `directory_accounts`
- `directory_account_departments`
- `directory_account_links`
- `directory_sync_runs`

No new migration is introduced in PR2.

### Sync flow

Manual sync performs the following steps:

1. Load the integration and create a `directory_sync_runs` row with `running`.
2. Fetch the DingTalk app access token.
3. Walk departments from the configured root department.
4. List department users page by page.
5. Enrich unique users with DingTalk user detail.
6. Upsert departments and accounts.
7. Rebuild account-to-department membership.
8. Generate link suggestions:
   - `linked` if an existing `user_external_identities` record matches the DingTalk external key
   - `pending` if email or mobile matches a local user
   - `unmatched` if no local candidate exists
9. Mark stale accounts and departments inactive.
10. Complete the sync run with aggregated stats.

On failure:

- `directory_integrations.last_error` is updated
- the run is marked `failed`
- the service attempts to persist a lightweight `directory_sync_alerts` row when that table exists

### Security and access

The route layer requires an authenticated platform admin.

Access is allowed when either condition is true:

- request user already carries an admin claim
- RBAC `isAdmin(userId)` fallback returns true

PR2 intentionally does not add a new fine-grained `directory:*` permission family yet. This keeps the rollout aligned with the existing admin model.

## API surface

Mounted under `/api/admin/directory`.

Endpoints:

- `GET /integrations`
- `POST /integrations`
- `PUT /integrations/:integrationId`
- `POST /integrations/test`
- `POST /integrations/:integrationId/sync`
- `GET /integrations/:integrationId/runs`

PR2 keeps testing separate from saved integrations so admins can validate credentials before creating the record.

## Frontend design

`apps/web/src/views/DirectoryManagementView.vue` provides a minimal admin console.

Included:

- integration list
- create/update form
- credential test action
- manual sync action
- sync stats summary
- recent run list

Intentionally excluded from PR2:

- full org tree explorer
- account-by-account manual link review
- deprovision ledger UI
- alert acknowledgement UI
- scheduler editing UX beyond raw cron text

The page is routed at `/admin/directory` and linked from the existing user admin page for discoverability.

## Non-goals

PR2 does not include:

- automatic scheduled execution
- DingTalk deprovision rollback workflows
- directory-driven local user creation
- OpenAPI contract generation
- deep admin shell redesign

These remain better candidates for a later PR after the minimal sync slice is stable in a real tenant.

## Claude parallel role

Claude was used in a parallel review role during PR2 planning.

Its output was used to validate two implementation constraints:

- keep the minimal file set instead of replaying the historical featureline
- expect the biggest merge risks around `auth.ts`, router types, and large generated artifacts

Claude did not own the core implementation. The service, routes, UI, and tests in this PR were implemented directly in the current branch.
