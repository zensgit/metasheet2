# Multitable Open-API Token Auth — OAPI-4 Per-Base/Sheet Scoped Tokens Design-Lock (PROPOSED)

> Status: **PROPOSED 2026-06-29.** Extends the **RATIFIED** canonical lock
> `multitable-openapi-token-auth-designlock-20260619.md` (§2.3 **Option B**, named there as OAPI-4) and the
> shipped OAPI-2a/2b write runtime (#3365). Design only — no runtime, no migration mounted until §9 ratifies;
> the build is a separate opt-in. Grounding: `origin/main` after #3365 (`multitable_api_tokens` has `id`,
> `scopes jsonb`, `created_by`; **no base/sheet columns**). Owner-gated: this **narrows** a mutating surface
> (strictly tightening), but the enforcement is security-critical and shared with the read path.

## 0. Why scope before more surfaces
OAPI-2 opened token **writes** (Option A: a token acts as its creator, capability-scoped, creator-wide). The
highest-value next move is **narrowing the blast radius**: let an `mst_` token be confined to specific
base(s)/sheet(s), so a leaked/over-broad `records:write` token can't touch the creator's *entire* workspace.
Landing this stable least-privilege base FIRST makes the later higher-risk surfaces (OAPI-3 webhooks; `/lock`,
`/restore`, comment edit/delete) safer to open. This lock adds a **third authorization dimension** on top of
Option A: effective access = `min(token capability scope, token base/sheet scope, creator live RBAC)`.

## 1. Data model
Add to `multitable_api_tokens` (nullable, additive migration):
- `base_ids text[]` — allowed base ids (whitelist).
- `sheet_ids text[]` — allowed sheet ids (whitelist).

**Unscoped = NULL/empty** (back-compat, §4). A scoped token sets one or both. No change to `scopes` (the
capability dimension stays records:write etc.). `ApiToken` / `ApiTokenCreateInput` gain optional `baseIds` /
`sheetIds`. `ApiTokenService.createToken` persists them; `validateToken` returns them so the request guard can
read them (alongside the existing scopes).

## 2. Enforcement — uniform on read AND write
Every token-accepting route resolves the request's **target sheet → its base** and checks it against the
token's `base_ids`/`sheet_ids` BEFORE the handler mutates/reads. A single shared guard (after `apiTokenAuth`,
keyed on `req.apiTokenId` so it is a **no-op for session requests**): given the resolved `{sheetId, baseId}`,
reject when out-of-scope. This covers — with the SAME check — `POST /records`, `PATCH /records/:id`,
`POST /patch`, `DELETE /records/:id`, `POST /api/comments`, AND the OAPI-1 read routes (`/records`, `/view`,
`/view-aggregate`, `/records-summary`, `/fields`, comments read). One resolver, one rule, no per-route drift.

**Exact write-route chain (LOCKED — prevents replaying the OAPI-2 rate-limit/audit bypass):**
`apiTokenAuth → oapiWriteAuditBoundary → apiTokenWriteRateLimit → oapiScopeGuard → requireScope →
[rbacGuard (comments)] → handler`. The order is load-bearing: the **audit boundary FIRST** (its
`res.on('finish')` listener captures every outcome, including an out-of-scope 403); the **rate-limiter BEFORE
the scope guard** (so out-of-scope token attempts are themselves rate-limited — within cap → 403, beyond → 429
— and cannot hammer 403s unbounded; this is exactly the OAPI-2a P1 fix, not to be undone); then `oapiScopeGuard`
(base/sheet) and `requireScope` (capability). Read routes carry no write audit, but the same
`apiTokenAuth → oapiScopeGuard → requireScope` relative ordering applies. **Invariant: a write route's
out-of-scope 403 MUST be both rate-limited and recorded as a denied audit row** (§5).

The single-guard model requires each route to expose a **resolvable target `{sheetId, baseId}` set BEFORE the
handler runs**. Routes whose target is implicit or multi-valued — an aggregate/summary read, or a `/patch`
batch spanning sheets — must surface their *full* target set to the guard. **Comment routes are a specific
trap:** they take a client `spreadsheetId`/`containerId`/`rowId`/`targetId`, which MUST NOT be trusted as the
base/sheet — the guard resolves sheet→base **server-side from the comment's container / target row**, and a
resolution miss returns a **uniform 404/403 shape** (never an existence oracle distinguishing "no such
comment/row" from "out of scope"). If any route genuinely cannot resolve its target pre-handler, it gets an
**explicit, named carve-out** (enforced inside the handler, audited), NOT a silent bypass (§9.7).

## 3. Scope composition (the rule)
A target sheet `S` in base `B` is **in-scope** iff:
- `base_ids` empty **AND** `sheet_ids` empty → **unscoped** → allowed; else
- (`base_ids` empty **OR** `B ∈ base_ids`) **AND** (`sheet_ids` empty **OR** `S ∈ sheet_ids`).

i.e. each whitelist, *if set*, must be satisfied (AND when both set — narrowest). **Cross-base / multi-target:**
an operation that touches more than one base/sheet (a cross-base mirror write; a `/patch` batch spanning
sheets) is in-scope only if **every** base/sheet it touches is in-scope — the check runs over the full target
set, not just the primary sheet (ties into the existing cross-base mirror write-gate).

## 4. Back-compat (legacy tokens) — the load-bearing story
Existing tokens have `base_ids = sheet_ids = NULL` → **unscoped → creator-wide**, exactly today's OAPI-2
behavior. So OAPI-4 is **opt-in per token**: legacy tokens are unchanged; only newly-minted scoped tokens are
constrained. The migration is additive (nullable columns, no backfill). No token's behavior changes on deploy.

## 5. Out-of-scope → 403 + audit
A wrong-base/wrong-sheet token request → **403** (a new `OUT_OF_SCOPE` code, distinct from `INSUFFICIENT_SCOPE`)
and, for writes, a **denied** `oapi_write_audit` row. **Locked interface (the boundary cannot infer the reason
on its own):** the OAPI-2 route-boundary writer derives `outcome` from the status code ONLY (429→rate_limited,
403→denied, 5xx→error), so it cannot tell OUT_OF_SCOPE from INSUFFICIENT_SCOPE. Therefore `oapiScopeGuard`
(and `requireScope`) MUST set a scrubbed `req.oapiAuditReason` (e.g. `out_of_base_sheet_scope` /
`insufficient_scope`) before sending the 403; the boundary writer reads `req.oapiAuditReason` and persists it
into the audit `detail.reason` (value-scrubbed). Without this wiring a build silently writes a bare 403-denied
row with no reason — so it is part of the §7 acceptance, not optional. No mutation occurs (the guard runs before
the handler). Reads simply 403 (no audit table for reads in this lock). The 403 must not leak whether the
base/sheet exists vs. is merely out-of-scope (uniform message).

## 6. Session writes — strict no-op
The scope guard fires only when `req.apiTokenId` is set. Session/grid requests (no token) skip it entirely →
ordinary user edits and reads are byte-for-byte unchanged. (Same discipline that kept OAPI-2 session-safe.)

## 7. Phased implementation (each a separate opt-in after ratification)
1. **OAPI-4a** — migration + `ApiTokenService`/type plumbing + the shared scope guard mounted on the **records**
   routes (read + write). Real-DB goldens.
2. **OAPI-4b** — the comments routes (read + write) through the same guard. **Comment target resolution is
   server-side**: the guard derives `sheet → base` from the comment's **container / target row**, never from the
   client-supplied `spreadsheetId`/`containerId`; a resolution miss returns the uniform 404/403 shape (§2), not
   an existence oracle.
3. **OAPI-4c (UI)** — token-create UI gains base/sheet pickers. (Tokens are mint-able via API meanwhile.)
Real-DB goldens (per slice): in-scope → allowed; out-of-scope base → 403 + denied audit + no mutation;
out-of-scope sheet → 403; cross-base touching an out-of-scope base → 403; **legacy (unscoped) token →
unchanged**; **session request → unaffected**; scoped token still bounded by capability scope + creator RBAC
(the 3-way min).

**Test-infra invariant (non-negotiable):** every real-DB golden MUST be added to `plugin-tests.yml`'s
"Run multitable real-DB integration" file list. `describeIfDatabase` tests silently **skip and still show
green** if omitted — this bit OAPI-2a *twice*. Acceptance for each OAPI-4 slice is "the golden file appears in
the step's test output with passing counts" (verify it RAN), not merely "CI is green".

## 8. Security invariants (must hold)
- A scoped token can NEVER act outside its `base_ids`/`sheet_ids`, on any route, read or write.
- Scoping only **tightens**: it never grants access the creator's RBAC or the capability scope wouldn't already
  allow (it's an additional AND-constraint, never an OR-widen).
- The guard resolves the target's base from the **sheet→base** mapping server-side per request (never trusts a
  client-supplied baseId).
- Revoking/scoping takes effect next request (no cached token scope beyond the request).

## 9. Decisions for the owner (ratify before any build)
1. **Granularity model:** `base_ids[]` + `sheet_ids[]` whitelists with the §3 AND-composition — *or* simpler
   "a token is scoped to bases XOR sheets, not both"? *(Recommend both-as-whitelists; it subsumes the simpler case.)*
2. **Cross-base/multi-target rule:** require **every** touched base/sheet in-scope (§3)? *(Recommend yes — fail-closed.)*
3. **Legacy default = unscoped (creator-wide), additive nullable migration, no backfill?** *(Recommend yes — zero-deploy-risk back-compat.)*
4. **403 code `OUT_OF_SCOPE`** (distinct from `INSUFFICIENT_SCOPE`) + denied write audit with a scrubbed reason? *(Recommend yes.)*
5. **Enforcement seam:** one shared guard after `apiTokenAuth` covering read + write uniformly (no-op for session)? *(Recommend yes.)*
6. **Phasing:** OAPI-4a records → OAPI-4b comments → OAPI-4c UI, each a separate opt-in? *(Recommend yes.)*
7. **Pre-handler target resolution:** confirm every token route (incl. `/view-aggregate`, `/records-summary`, and multi-sheet `/patch`) can resolve its full target base/sheet set before the handler so the one shared guard applies uniformly; any route that genuinely can't gets an explicit, audited carve-out — never a silent bypass. *(Recommend: resolve pre-handler everywhere; enumerate any carve-outs at OAPI-4a build.)*

## 10. Out of scope (stay gated / separate slices)
OAPI-3 (`webhooks:manage` — SSRF / secret-redaction / delivery-retry / signature surface, intentionally AFTER
scoping); `/records/:id/lock`, `/restore`, comment edit/delete (higher-risk write faces — open only after
scoping lands); export/import/automation/dashboard/permission/token-management/attachments (session-only). The
OAPI-4 **build** itself is a separate opt-in after this lock ratifies.

## Net
OAPI-2 made tokens write as their creator (Option A, creator-wide). OAPI-4 adds the **least-privilege**
dimension — per-base/sheet whitelists enforced by one shared guard on every token route (read + write),
fail-closed on cross-base, **no-op for session**, and **opt-in per token** so no legacy token changes on
deploy. Ratify §9, then OAPI-4a (records) is a separate build opt-in. Webhooks (OAPI-3) and the high-risk write
faces stay gated until this least-privilege base is in place.
