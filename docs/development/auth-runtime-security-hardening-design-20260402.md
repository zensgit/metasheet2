# Auth Runtime Security Hardening Design

Date: 2026-04-02

## Goal

Close the remaining production auth configuration gaps tracked in issue `#594` without expanding scope into unrelated auth refactors.

## Problems

1. Production runtime still tolerated weak or missing `JWT_SECRET` in multiple paths by silently falling back to development secrets or generated secrets.
2. `BCRYPT_SALT_ROUNDS` was still effectively optional in on-prem deployment scripts, and some scripts validated it before `app.env` was even loaded.
3. On-prem packaged env templates did not pin the production bcrypt baseline, so packaging and deployment checks were not aligned with runtime guidance.

## Changes

### 1. Centralize auth runtime validation

Add `packages/core-backend/src/security/auth-runtime-config.ts` as the single place for:

- production detection
- weak/default JWT secret rejection
- production/non-production JWT secret resolution
- bcrypt default resolution
- production auth security issue reporting

### 2. Remove insecure production fallbacks

Use the runtime helper in:

- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/src/auth/jwt-middleware.ts`
- `packages/core-backend/src/routes/auth.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/config.ts`
- `packages/core-backend/src/config/index.ts`
- `packages/core-backend/src/auth/invite-tokens.ts`

Result:

- production startup now rejects weak or missing `JWT_SECRET`
- invite-token signing/verifying can no longer bypass the stronger production JWT policy
- bcrypt hashing paths consistently share the same rounds resolution

### 3. Align on-prem scripts and package gates

Harden:

- `scripts/ops/attendance-onprem-env-check.sh`
- `scripts/ops/attendance-preflight.sh`
- `scripts/ops/attendance-onprem-bootstrap-admin.sh`
- `scripts/ops/attendance-onprem-package-verify.sh`

Rules:

- `JWT_SECRET` must be at least 32 chars and not one of the known weak defaults
- `BCRYPT_SALT_ROUNDS` must exist and be `>= 12`
- package verify must confirm both attendance on-prem env templates ship with `BCRYPT_SALT_ROUNDS=12`

### 4. Update packaged env templates and deployment docs

Update:

- `docker/app.env.attendance-onprem.template`
- `docker/app.env.attendance-onprem.ready.env`
- `docs/deployment/attendance-onprem-app-env-template-20260306.md`

So the shipped examples match what runtime and deploy scripts now enforce.

## Non-goals

- No changes to token shape, auth routes, or password policy semantics beyond config hardening.
- No change to development-mode fallback behavior.
- No attempt to retrofit every historical doc that references `dev-secret` for local-only workflows.
