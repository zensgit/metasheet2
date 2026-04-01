# Attendance v2.7.0 Routing and ID Semantics Design

## Goal

Close the two remaining low-noise `v2.7.0` issues after the admin reconnect and create-path compatibility slices:

- reduce the login-route flash for the home entry path
- lock Attendance admin resource semantics so valid-but-missing UUIDs stay `404` while malformed ids stay `400`

## Problem Statement

### Login flash

The current auth guard treats `/` as a protected route, normalizes it to the default post-login home, and redirects unauthenticated users to:

- `/login?redirect=/attendance`

After login, the app already falls back to `resolveHomePath()` when no redirect is present, so the query parameter adds noise without adding value for the home entry path.

### Resource ID semantics

External test feedback reported some "missing resource returns 400" cases. The current backend behavior is narrower and intentional:

- malformed ids should return `400`
- valid UUIDs that do not exist should return `404`

The risk here is not primarily runtime logic drift; it is that this distinction was not yet explicitly locked for all of the remaining approval-flow and rule-set mutate paths.

## Design

### Home login redirect cleanup

Introduce a narrow helper that decides when the pre-login redirect query should be omitted:

- omit it for `/`
- omit it for `/login`
- keep it for real in-app destinations such as `/attendance` or `/plm?...`

Use that helper in two places:

- the global router auth guard in `main.ts`
- `buildLoginRedirectUrl()` in `utils/api.ts`

This keeps existing protected-route behavior while reducing the visible route dance for the home path from:

- `/ -> /login?redirect=/attendance -> /attendance`

to:

- `/ -> /login -> /attendance`

### ID semantics hardening

Do not broaden runtime id behavior across the plugin.

Instead, add focused integration coverage for:

- approval-flow mutate routes
- rule-set mutate routes

The coverage locks:

- malformed ids => `400` / `VALIDATION_ERROR`
- valid-but-missing UUIDs => `404` / `NOT_FOUND`

This preserves the plugin’s existing contract and makes the distinction explicit for future hotfixes.

## Non-goals

This slice does not:

- redesign the auth bootstrap flow
- change how non-home protected routes preserve deep-link redirects
- convert malformed ids into `404`
- refactor the Attendance plugin’s path-param validation helpers
