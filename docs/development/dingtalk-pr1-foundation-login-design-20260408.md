# DingTalk PR1 Foundation + Login Design

Date: 2026-04-08
Branch: `codex/dingtalk-pr1-foundation-login-20260408`

## Scope

This PR1 slice restores the minimum DingTalk login foundation on top of current `origin/main` without replaying the older featureline wholesale.

Included:

- Shared DingTalk backend client for OAuth token exchange and current-user lookup
- Redis-first OAuth state store with in-memory fallback
- Backend launch/callback endpoints under `/api/auth/dingtalk/*`
- Frontend DingTalk login entry on the login page
- Frontend DingTalk callback route and callback view
- Unit tests for OAuth state handling, auth routes, and callback page behavior

Explicitly excluded from PR1:

- Directory sync UI and sync jobs
- Attendance DingTalk productionization
- DingTalk notification/webhook delivery
- Admin grant management UI
- Live DingTalk smoke scripts and ops rollout assets

## Why This Is Not a Cherry-pick

The historical DingTalk rollout branch contains a much larger surface than PR1 and drifts heavily from current `main`, especially around:

- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/auth/AuthService.ts`
- frontend router composition
- unrelated PLM/multitable/workflow churn

To avoid replaying stale conflicts, PR1 ports only the minimum DingTalk login files and grafts them onto the current auth/session stack.

## Backend Design

### Shared DingTalk client

File:

- `packages/core-backend/src/integrations/dingtalk/client.ts`

Responsibilities:

- Read DingTalk OAuth config from env
- Exchange auth code for user access token
- Fetch current DingTalk user profile from `/contact/users/me`
- Normalize DingTalk error handling

Supported env aliases:

- `DINGTALK_CLIENT_ID` or `DINGTALK_APP_KEY`
- `DINGTALK_CLIENT_SECRET` or `DINGTALK_APP_SECRET`
- `DINGTALK_REDIRECT_URI`
- `DINGTALK_CORP_ID` optional

### OAuth state store

File:

- `packages/core-backend/src/auth/dingtalk-oauth.ts`

State handling rules:

- State TTL is 5 minutes
- Redis is preferred when `REDIS_URL` or `REDIS_HOST` is configured
- Memory fallback is used when Redis is unavailable
- State is one-time use
- Redirect path is stored inside the state record so the frontend does not have to trust query echoing from DingTalk

### Local user resolution policy

PR1 resolves local users using current mainline tables instead of the old `users.dingtalk_open_id` approach.

Primary tables:

- `user_external_identities`
- `user_external_auth_grants`

Resolution order:

1. Existing external identity by `external_key`, `provider_open_id`, or `provider_union_id`
2. Email match if `DINGTALK_AUTH_AUTO_LINK_EMAIL=1` (default enabled)
3. Auto-provision if `DINGTALK_AUTH_AUTO_PROVISION=1` (default disabled)

Behavior details:

- Existing disabled grants block login
- Successful email-link and auto-provision paths create a grant row if missing
- External identity rows are upserted and `last_login_at` is refreshed

This keeps PR1 compatible with the current schema and leaves space for PR2 admin grant management.

### Auth route integration

File:

- `packages/core-backend/src/routes/auth.ts`

New endpoints:

- `GET /api/auth/dingtalk/launch`
- `POST /api/auth/dingtalk/callback`

Launch flow:

- Validate DingTalk config
- Normalize optional in-app redirect path
- Generate state with embedded redirect payload
- Return the final DingTalk authorize URL

Callback flow:

- Validate `code` and `state`
- Exchange DingTalk auth code for DingTalk user profile
- Resolve or provision local user
- Load current permissions
- Issue a normal MetaSheet session-backed JWT
- Return `user`, `token`, `features`, and `redirectPath`

Session behavior intentionally reuses existing MetaSheet session semantics:

- `sid` is generated locally
- `createUserSession(...)` is called
- `users.last_login_at` is updated

This means DingTalk login plugs into the current session center instead of bypassing it.

## Frontend Design

### Login page entry

File:

- `apps/web/src/views/LoginView.vue`

Behavior:

- Probe `/api/auth/dingtalk/launch` on mount
- Show DingTalk login button only when the backend reports availability
- Pass the safe post-login redirect to the launch endpoint
- Redirect the browser to DingTalk when launch succeeds

### Callback route

Files:

- `apps/web/src/router/types.ts`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/views/DingTalkAuthCallbackView.vue`

Behavior:

- Route path: `/login/dingtalk/callback`
- Read `code` and `state` from the query string
- POST them to `/api/auth/dingtalk/callback`
- Persist token, roles, permissions, feature flags
- Prime frontend auth session state
- Redirect to backend-provided `redirectPath` or resolved home fallback

## Config

Added to `.env.example`:

- `DINGTALK_CLIENT_ID`
- `DINGTALK_CLIENT_SECRET`
- `DINGTALK_REDIRECT_URI`
- `DINGTALK_CORP_ID`
- `DINGTALK_AUTH_AUTO_LINK_EMAIL`
- `DINGTALK_AUTH_AUTO_PROVISION`

Recommended production defaults:

- `DINGTALK_AUTH_AUTO_LINK_EMAIL=1` only if your email domain is already authoritative inside DingTalk
- `DINGTALK_AUTH_AUTO_PROVISION=0` until PR2 directory/admin flows are live

## Risks Left for PR2

- No admin-facing grant management yet
- No live DingTalk env smoke validation in this slice
- No directory sync or account review UI yet
- No DingTalk-specific observability counters or dashboards in this slice

Those are deferred to keep PR1 narrow and mergeable.
