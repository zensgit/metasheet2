# Multitable Open-API Token Auth — Design-Lock (REVIEW BEFORE IMPLEMENTATION)

> Status: **PROPOSED design-lock — do NOT mount auth until ratified.**
> Grounding: `origin/main` (2026-06-19). Owner-gated: this enables a public data API surface; it is
> NOT a wiring bug-fix. Mounting token auth without the decisions below would create a **half-authorized
> entry point** (worse than today's "tokens authenticate nothing").

## 0. Problem

Token *management* is fully built — `mst_`-prefixed, SHA-256-hashed tokens with create/list/revoke/rotate,
optional expiry, last-used tracking, and 6 granular scopes (`records:read`, `records:write`, `fields:read`,
`comments:read`, `comments:write`, `webhooks:manage`). A middleware `apiTokenAuth` exists and attaches
`req.apiTokenScopes`. **But it is mounted on zero data routes** — so an `mst_` token currently
authenticates nothing; every data route is session-only. (The create-form scope drift was fixed
separately; that did NOT make the API consumable.)

This lock decides exactly **how** tokens become consumable, so the open API is *fully* authorized, not partly.

## 1. Goal / Non-goals

**Goal:** a token-authenticated, scope-enforced, owner-bounded read/write API over a defined set of
multitable data routes — at parity with the security the session path already enforces (field mask,
row-level read-deny, record/field/sheet permissions).

**Non-goals (this lock):** no new field types/views; no rate-limit redesign beyond what's specified; no
per-endpoint API versioning; no API for automation/dashboard/admin routes (session-only stays).

## 2. Decisions required (the gate)

Nothing is mounted until each of these is ratified.

### 2.1 Route matrix — which routes accept tokens
Proposed allowlist (everything else stays session-only and rejects `Authorization: Bearer mst_…`):

| Route | Method | Required scope |
|---|---|---|
| `/records` (list) | GET | `records:read` |
| `/records/:id` (single) | GET | `records:read` |
| `/records` / `/patch` / `/records/:id` (create/update) | POST/PATCH | `records:write` |
| `/records/:id` (delete) | DELETE | `records:write` |
| `/sheets/:sheetId/view` / `/view-aggregate` / `/records-summary` | GET | `records:read` |
| `/sheets/:sheetId/fields` (list/read) | GET | `fields:read` |
| comments list/get | GET | `comments:read` |
| comments create | POST | `comments:write` |
| webhook CRUD | * | `webhooks:manage` |

**Explicitly NOT token-accessible (session-only):** export-xlsx, import-xlsx, automation, dashboard/charts,
permission management, api-token management, attachments upload. (Rationale: bulk egress + side-effecting
+ privilege surfaces stay human-gated until a later lock.)

### 2.2 Scope → operation enforcement
- Every token-accepting handler calls a single `requireScope(req, '<scope>')` guard AFTER `apiTokenAuth`.
- Scope check is **deny-by-default**: a token missing the scope → 403, never a silent downgrade.
- A token does **not** widen capability beyond its creator: the effective permission is
  `min(token scopes, creator's resolved sheet/field/record permissions)` — see 2.3.

### 2.3 Scoping model — THE key data-model decision
`ApiToken` today has **no `baseId`/`sheetId`** → a token is creator-wide. Options:

- **Option A (creator-wide, capability-scoped) — recommended for v1.** The token acts AS its creator,
  limited to the granted scopes; per-request authorization still runs the full session permission stack
  (resolveSheetCapabilities + field mask + row-deny) for the creator. Smallest change; no schema migration;
  safe because it can never exceed the creator's own access. Downside: not least-privilege per base/sheet.
- **Option B (per-base / per-sheet scoping).** Add `base_id` / `sheet_id` (nullable) to `api_tokens`; a
  scoped token is rejected outside its base/sheet. Least-privilege, but a schema migration + UI + a
  back-compat story for existing tokens. Recommend as a **fast-follow (v2)**, not v1.

**Proposed:** ship **A** in v1 (consumable + safe), land **B** as the immediate next slice.

### 2.4 Auth precedence + safety
- If both a session and a `Bearer mst_…` are present, **token wins** on token-accepting routes (explicit
  API intent); the request authorizes as the token's creator with the token's scopes.
- `apiTokenAuth` runs only on the 2.1 allowlist; elsewhere a `Bearer mst_…` is ignored (route stays
  session-only and 401s without a session).
- Per-token **rate limit** (reuse the existing limiter infra) — proposed default 600 req/min/token.
- **Audit:** every token-authenticated write emits an audit event with `tokenId` + `actorId(creator)`.
- HTTPS-only in production (mirror the webhook rule).

## 3. Security invariants (must hold)
- A token NEVER exceeds its creator's live permissions (field mask, row-deny, record/sheet perms all still apply per-request).
- Scope is deny-by-default; an unknown/expired/revoked token → 401; a valid token missing the scope → 403.
- No token-accepting route bypasses the session path's masking/deny — token auth only changes *who* the actor is + *which* scopes, never the downstream authorization.
- Revoking/expiring a token takes effect on the next request (no caching of validation beyond the request).

## 4. Phased implementation (each a gated, separately-opted-in slice)
1. **OAPI-1** `requireScope` guard + mount `apiTokenAuth` on the **read** routes only (`records:read`, `fields:read`, `comments:read`) — read-only blast radius first. Real-DB golden: valid-scope 200, missing-scope 403, revoked 401, creator-permission-still-applies (denied row/field stays denied via token).
2. **OAPI-2** write routes (`records:write`, `comments:write`) + audit events + rate limit.
3. **OAPI-3** webhooks:manage.
4. **OAPI-4 (v2 scoping)** per-base/sheet `ApiToken` columns + UI + enforcement (Option B).

## 5. Open questions for the owner
1. Ratify the 2.1 route matrix (anything to add/remove? — esp. should export be token-accessible with a dedicated `records:export` scope, or stay session-only?).
2. Ratify **Option A for v1, Option B as fast-follow** (vs. requiring per-base scoping up front).
3. Confirm token-wins precedence + the 600/min default.
4. Confirm read-only-first phasing (OAPI-1) before any write route is token-exposed.

**Until this is ratified, no `apiTokenAuth` is mounted on any data route.**
