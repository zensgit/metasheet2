# DingTalk PR1 Review Design

Date: 2026-04-10
PR: `#725`
Branch: `codex/dingtalk-pr1-foundation-login-20260408`

## Scope

This review pass covers only the PR1 DingTalk login foundation:

- backend launch/callback routing
- DingTalk OAuth state storage
- local-user resolution and auto-provision behavior
- login page launch flow
- callback page session handoff

Out of scope:

- PR2 directory sync behavior
- PR3 attendance, robot notifications, delegated admin controls
- production feature expansion beyond PR1 login

## Review Gates

PR1 stays on the existing public contract:

- `GET /api/auth/dingtalk/launch`
- `POST /api/auth/dingtalk/callback`
- `/login/dingtalk/callback`

This review only fixes blocking correctness or security issues found inside those flows.

## Review Findings

### 1. Launch probing consumed real OAuth state

The login page mounted by probing `GET /api/auth/dingtalk/launch`, which created and stored a real one-time state on every page visit. Under repeated login page traffic this could churn Redis or in-memory state capacity and evict legitimate pending logins.

Design response:

- keep the route path unchanged
- add a lightweight `probe=1` mode on `/api/auth/dingtalk/launch`
- update the login page probe to use that mode

### 2. Redis `multi().exec()` tuple errors were treated as success

The state store only handled thrown Redis errors. It did not inspect per-command `[error, result]` tuples returned by `exec()`, so partial command failures could be treated as successful persistence or successful validation.

Design response:

- inspect `exec()` results in both write and validation paths
- invalidate the Redis client on tuple errors
- fall back to in-memory storage on write failures
- fail closed on validation failures

### 3. Auto-provision could reuse an existing email when auto-link was disabled

`createProvisionedUser()` used `INSERT ... ON CONFLICT (email) DO UPDATE`, which let the provisioning path silently reuse an existing local account by email. That bypassed the intended distinction between explicit email linking and account provisioning.

Design response:

- remove the email upsert behavior from provisioning
- reject provisioning when a local account already exists with the same email
- preserve the existing explicit email-link path as the only place where email reuse can happen

### 4. Logged-in sessions could be overwritten from the callback page

The callback view accepted a DingTalk callback even when a valid local session already existed in the browser, which allowed token replacement in the current tab.

Design response:

- mark the callback route as guest-only in route metadata
- add a defensive callback-view guard that keeps the current authenticated session and redirects home instead of exchanging the DingTalk callback

### 5. DingTalk login could bypass disabled or inactive local-user gates

The PR1 user-resolution path only selected `id`, `email`, `name`, and `role` from `users`. It did not read or enforce `is_active`, so a DingTalk-linked account that had been disabled in the local system could still receive a fresh session from `/api/auth/dingtalk/callback`.

Design response:

- extend resolved local-user rows to include `is_active`
- enforce the same deny rule already used by password login and token verification:
  - `role === 'disabled'`
  - `is_active === false`
- apply the check to both external-identity matches and email auto-link matches before grant evaluation or identity upsert
- keep the existing public error string: `DingTalk login is disabled for this user`

### 6. Auto-provision did not satisfy the current `users` schema

PR1 kept `DINGTALK_AUTH_AUTO_PROVISION` as a supported code path, but the implementation inserted into `users` without `password_hash`. The current schema requires `password_hash TEXT NOT NULL`, so the first real auto-provision attempt would fail at the database layer.

Design response:

- keep auto-provision support in PR1
- do not change the schema in this fix
- generate a random one-time secret server-side and hash it with the existing bcrypt runtime configuration
- write that hash into `users.password_hash` during auto-provision
- do not expose any generated password to the caller; the hash only satisfies the current local-auth schema

### 7. Corp-scoped identity lookups could fall back to a bare open id

When `DINGTALK_CORP_ID` is configured, PR1 writes external identities using a corp-scoped key (`corpId:openId`). However, the fallback lookup still accepted bare `provider_open_id` / `provider_union_id` matches with no corp guard. That could let a stale row from another corp or a legacy binding without the current corp key resolve the wrong local user.

Design response:

- keep `external_key` as the primary lookup key
- when `corpId` is not configured, preserve the legacy bare `openId` / `unionId` fallback
- when `corpId` is configured, require `identity.corp_id = configuredCorpId` on the fallback path
- do not change the callback contract; only tighten internal user-resolution semantics

### 8. Callback status codes conflated local policy rejection with DingTalk upstream failure

The callback route previously mapped every `exchangeCodeForUser()` failure to `502`. That hid local admission denials behind an upstream-failure status and made it impossible for clients or operators to distinguish:

- DingTalk transport or token-exchange failures
- local user disabled / inactive rejections
- explicit grant-denied rejections
- auto-provision email conflicts

Design response:

- introduce a dedicated local policy error type inside the DingTalk OAuth module
- keep DingTalk upstream request errors mapped to `502`
- map local admission denials to `403`
- map auto-provision email conflicts to `409`
- preserve the existing public route path and response body shape

### 9. Enabling `DINGTALK_CORP_ID` requires a rollout gate for legacy bindings

The corp-scoped fallback fix is intentionally strict. Once `DINGTALK_CORP_ID` is enabled, legacy `user_external_identities` rows written before corp scoping may stop matching if they only contain bare `provider_open_id` / `provider_union_id` values and `corp_id IS NULL`.

Design response:

- treat corp-scoped lookup hardening as correct-by-default behavior
- do not weaken the runtime lookup to auto-accept ambiguous legacy rows
- require a one-time rollout backfill before enabling `DINGTALK_CORP_ID` in production
- document the backfill requirement and verification gate in the PR1 review docs

### 10. Email auto-link remained enabled by default

The runtime still treated `DINGTALK_AUTH_AUTO_LINK_EMAIL` as enabled when the environment variable was unset. That would let PR1 on its own auto-link DingTalk identities to existing local accounts by email before the later explicit-grant controls from PR3 are merged.

Design response:

- change the runtime fallback for `DINGTALK_AUTH_AUTO_LINK_EMAIL` from enabled to disabled
- keep explicit opt-in behavior unchanged when the environment variable is set to a truthy value
- update `.env.example` so the documented default matches the safer runtime behavior

### 11. Unknown local callback failures still looked like DingTalk upstream outages

The callback route already split local policy denials from DingTalk transport failures, but every other unexpected local failure still returned `502`. That would misclassify local database, session, or permission-loading faults as DingTalk upstream issues.

Design response:

- keep `DingTalkRequestError` mapped to `502`
- keep local policy errors on their explicit `403` / `409` codes
- map all other unexpected callback failures to `500`
- preserve the existing route path and response body shape

## Non-Blocking Notes

- Duplicate auth payload helpers between `LoginView.vue` and `DingTalkAuthCallbackView.vue` remain a refactor candidate, but they are not blocking for PR1 merge.
- `DINGTALK_AUTH_AUTO_LINK_EMAIL` remains a configuration choice, but it is now safe-by-default and must be explicitly enabled.
