# Run 5 Approvals And Nav Hotfix Design

## Context

`multitable-onprem-run4-20260403` still had two platform-shell regressions:

1. `/api/approvals/pending` returned `401 APPROVAL_USER_REQUIRED` for ordinary authenticated users because the approvals router did not read `req.user.id`.
2. The platform shell showed a duplicate plugin-contributed `Attendance` entry (`/p/plugin-attendance/attendance`) alongside the canonical `/attendance` shell route.

## Decisions

### Approvals actor resolution

Use a single helper in `packages/core-backend/src/routes/approvals.ts` that resolves the authenticated actor from:

1. `req.user.id`
2. `req.user.userId`
3. `req.user.sub`

This matches the current JWT middleware/runtime, where the verified user record exposes `id`.

### Attendance shell navigation

The platform shell owns `/attendance`. The raw plugin-contributed `plugin-attendance:attendance` main-nav item is therefore legacy and should not render in the shell nav.

We keep backward compatibility for old deep links by redirecting `/p/plugin-attendance/attendance` to `/attendance`.

## Non-goals

- Reworking the whole approvals product surface.
- Fixing logout-time stray `403` requests.
- Building a full standalone approval center with create/detail/history subroutes.
