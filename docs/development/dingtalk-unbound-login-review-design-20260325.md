# DingTalk Unbound Login Review Design

## Goal

When a DingTalk user completes OAuth successfully but no MetaSheet user is bound, the system should not drop the identity on the floor. It should optionally capture that DingTalk identity into the existing directory review workflow so an administrator can provision or link the account.

## Scope

- Reuse existing `directory_accounts` and `directory_account_links`
- Add an integration-level setting: `captureUnboundLogins`
- When DingTalk login hits an unbound account and auto provisioning is disabled:
  - locate an active DingTalk directory integration by `corpId`
  - create or refresh a `directory_accounts` record
  - reconcile link candidates
  - keep unmatched users in `pending`
  - return a dedicated auth error code to the frontend
- Expose the setting in Directory Management
- Show a user-facing callback hint that the account is awaiting administrator review

## Non-Goals

- Automatic account creation for unbound DingTalk users
- New review tables or a parallel admin console
- Changing existing manual provision / authorize flows

## Backend Design

### Integration Config

`DirectoryIntegration.config` now includes:

- `captureUnboundLogins: boolean`

Default:

- `true` when the field is absent, so upgraded integrations immediately support admin review capture

### Capture Flow

On `/api/auth/dingtalk/exchange`:

1. Resolve DingTalk profile
2. Check existing external binding
3. If no binding and auto provisioning is disabled:
   - call `directorySyncService.captureUnboundLoginForReview(profile)`
   - upsert or refresh `directory_accounts`
   - run existing link reconciliation
   - if still pending, store review note `captured from DingTalk login; awaiting administrator review`
   - emit audit log
4. Return `409 DINGTALK_ACCOUNT_REVIEW_REQUIRED`

Returned details include:

- `integrationId`
- `accountId`
- `queuedForReview`
- `created`
- `linkStatus`
- `corpId`

### Data Model Reuse

No schema migration is needed. The captured identity is stored in:

- `directory_accounts`
- `directory_account_links`

`raw` is extended with:

- `loginCapture`
- `authProfile`

## Frontend Design

### Directory Management

Integration form adds a checkbox:

- `未开通钉钉用户登录时加入管理员待审核队列`

The selected integration chip row also shows whether this behavior is enabled.

### DingTalk Callback

When `DINGTALK_ACCOUNT_REVIEW_REQUIRED` is returned:

- error text explains the account is not yet provisioned
- hint text tells the user the account has entered the admin review queue

## Expected Admin Flow

1. User scans DingTalk login
2. MetaSheet captures the unbound identity into directory review
3. Admin opens Directory Management
4. Admin locates the pending account
5. Admin either:
   - links to an existing MetaSheet user
   - provisions a new local user
6. Admin authorizes DingTalk login
7. User retries login

## Risks

- Multiple integrations with the same `corpId` may require later refinement; current strategy chooses the most recently updated active integration with capture enabled
- Captured login users may have no department membership if they were not part of the synced directory scope
