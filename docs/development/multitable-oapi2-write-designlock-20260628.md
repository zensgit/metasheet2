# Multitable Open-API Token Auth — OAPI-2 Write Slice Design-Lock (RATIFIED)

> Status: **RATIFIED 2026-06-28** (owner-signed; see **Ratification** below). The §10 decisions are settled;
> this doc is read-only post-ratification. Extends the **RATIFIED** canonical lock
> `multitable-openapi-token-auth-designlock-20260619.md` (do **not** reopen it). This is the **write slice
> (OAPI-2)** of that lock: it does **not** re-decide the ratified §2.1 route matrix, §2.3 Option A, §2.4
> token-wins + 600/min, or §3 invariants — it specifies **how** they are implemented for writes.
> Grounding: `origin/main` @ `33fde1347` (validation anchor; the token-auth / OAPI allowlist / write-route
> surface was re-confirmed **unchanged** on later main through `c179dc078` — intervening hunks are unrelated
> T9-W / date-reminder changes). Owner-gated: enables a **mutating** public API surface.
> **Ratifying this lock does NOT start the build.** The OAPI-2a runtime is a **separate opt-in GO** after this
> (read-only-first phasing, canonical §4); no `apiTokenAuth` is mounted on any write route until that GO.

## Ratification (owner-signed 2026-06-28)
The §10 decisions are ratified as the recommended defaults; the P2 §6 audit fix (two-layer + failure posture)
landed before sign-off:
1. **DELETE staged** — OAPI-2a = create / update / batch-upsert + comment-create first; **OAPI-2b = DELETE** after (DELETE stays in scope per the canonical matrix; this is sequencing).
2. **Idempotency** — v1 ships **at-least-once create**; `Idempotency-Key` is a fast-follow (scoped to `POST /records`, + `/patch` iff blind-insert).
3. **Denied writes are audited** too, via the §6 **two-layer** model (route-boundary captures every attempt; post-commit enriches committed only), value-scrubbed.
4. **Provenance** = `createdBy: creator` (acts-as-creator); token-origin is distinguished **only** in the audit event.
5. **Allowlist** generalizes to anchored method-bound `(method, path)` entries in **lockstep** with mounted `requireScope` + the §2 trap set.
6. **Rate limit** keyed **per-token-id** (not per-creator); 600 req/min/token.
7. **Audit-failure posture** — committed writes **fail-closed** (audit in the same DB txn → rollback on audit failure); denied / error / rate-limited attempts **best-effort + mandatory alert**.

> The runtime build (OAPI-2a) remains a **separate GO** and is not authorized by this ratification.

## 0. Why a write slice needs its own lock
The read slice's blast radius was bounded — a leak over-exposes data. A write slice can **mutate or destroy**
the creator's data under an ambiguous actor. Two write-specific hazards drive this doc: (a) the allowlist is
the auth boundary and today it is **GET-only**, so extending it to writes removes a real protection unless the
extension is exact and lockstepped; (b) writes are where **ambiguous auth-precedence** turns into "wrong actor
mutated data." Both are pinned below from current code, not assumed.

## 1. Write surface — literal to the ratified §2.1 matrix
Token-exposed writes are **exactly** these (anything else stays session-only and rejects `Bearer mst_…`):

| Route | Method | Scope |
|---|---|---|
| `/api/multitable/records` (create) | POST | `records:write` |
| `/api/multitable/records/:recordId` (update) | PATCH | `records:write` |
| `/api/multitable/patch` (batch upsert) | POST | `records:write` |
| `/api/multitable/records/:recordId` (delete) | DELETE | `records:write` — staged, §4 |
| `/api/comments` (comment **create**) | POST | `comments:write` |

**Explicitly NOT token-exposed (stay session-only — not in the ratified matrix):**
`POST /records/:recordId/lock`, `POST /sheets/:sheetId/records/:recordId/restore`, **comment update/delete**
(`PATCH`/`DELETE /api/comments/:id`), and (per canonical) export/import/automation/dashboard/permission/
attachments. *(The ratified §2.1 lists comment **create** only; this slice does not widen it. Lock and restore
are collaboration/undelete primitives outside the matrix.)*

## 2. The auth boundary — method-bound allowlist (the crux)
**Current state (verified):** `oapi-read-allowlist.ts` exposes `isOapiReadAllowlistRequest(method, path,
authHeader)` which returns true only for an `mst_` bearer **with `method === 'GET'`** on an anchored read path;
it is consulted in `index.ts` (~L1001) **before** the JWT gate — a match skips JWT to reach the route's
`requireScope`; a non-match falls through to `jwtAuthMiddleware` → **401** for an `mst_` bearer. So today
**no `mst_` token can reach any write route.** Extending to writes removes that blanket protection for the
exact pairs in §1, and nothing else.

**Decision:** generalize the predicate to anchored **`(method, path)` entries** (e.g. an `OAPI_WRITE_PATHS`
table consulted with method binding, or fold method into the existing structure). The write entries, in exact
lockstep with the mounted guards:

```
POST    ^/api/multitable/records$
PATCH   ^/api/multitable/records/[^/]+$
POST    ^/api/multitable/patch$
DELETE  ^/api/multitable/records/[^/]+$        # only once §4 (2b) is ratified
POST    ^/api/comments$
```

**Lockstep invariant (the load-bearing rule):** an allowlist `(method, path)` entry exists **iff** that route
mounts `apiTokenAuth → requireScope(<scope>)`. No entry without a guard (else `requireScope` fail-opens →
silent no-auth bypass — the canonical "half-authorized entry point"); no guard without an entry (dead route).

**Method-binding traps (must DENY → 401, asserted in the allowlist unit test):**
`GET` on a write path; `POST`/`PATCH` on a **read** path (`POST /records-summary`, `POST /view`); the
adjacent write siblings `/records/:id/lock` and `/records/:id/restore`; comment `PATCH`/`DELETE`; the form
path `POST /views/:id/submit` (§3); and — until 2b — `DELETE /records/:id`.

## 3. Auth-precedence on writes (verified disjoint — lock it)
**Verified:** the public-form bypass (`isPublicFormAuthBypass`) fires only for a request carrying a per-form
**`publicToken`** on `GET /api/multitable/form-context` or `POST /api/multitable/views/:viewId/submit`
(`PUBLIC_FORM_SUBMIT_PATH = /^\/api\/multitable\/views\/[^/]+\/submit$/`, route at univer-meta L8701). That
path and token type are **disjoint** from every §1 write route → there is **no 3-way precedence ambiguity** on
token-exposed writes.

**Locked invariant:** keep them disjoint. The form-submit / form-context paths MUST NOT enter the OAPI write
allowlist, and OAPI write entries MUST NOT match them. On a token-exposed write route, precedence is
**token-wins over session** (canonical §2.4); the `publicToken` form path is never reachable there. Trap test:
an `mst_` bearer on `/views/:id/submit` is **not** treated as `records:write` (it falls to the form/JWT path).

## 4. Destructive write (DELETE) — controls + sequencing
DELETE is **already ratified** token-accessible (§2.1) — this is **not** a re-decision. What token-DELETE
**requires** (the substance):
- **Audit on attempt — success AND denied.** A denied DELETE (403) is the abuse signal; it must be recorded
  (§6), value-scrubbed.
- **No bulk-by-filter delete over a token.** Single `:recordId` only — the matrix has no bulk-delete endpoint;
  keep it that way (no query-filtered mass delete reachable by `records:write`).
- **Soft-delete semantics only.** Token DELETE goes through the same `RecordService.deleteRecord` as the
  session path (soft/restoreable). Any hard-purge stays session/admin-only and out of the token surface.
- **No extra per-request confirmation token** — scope + creator-RBAC + soft-delete + audit match the session
  path's own guarantees; adding a confirm step would diverge token from session without raising the floor.

**Sequencing (phasing only, DELETE stays in scope):** **OAPI-2a** = create / update / batch-upsert +
comment-create (non-destructive) lands and proves the allowlist + audit mechanics in staging first;
**OAPI-2b** = `DELETE` follows once 2a is green.

## 5. Composition & inherited invariants (token write ≡ session write downstream)
**Mount order — records:** `apiTokenAuth → requireScope('records:write') →` *handler's existing*
`resolveSheetCapabilities` (resolves the **creator's live** caps) → `RecordService` / `RecordWriteService`
full stack. **Comments:** `apiTokenAuth → requireScope('comments:write') → rbacGuard('comments','write')`
(creator's live RBAC) → `CommentService`. Neither the capability resolution nor `rbacGuard` is replaced.

`min(token scope, creator live RBAC)`: `requireScope` supplies the **token-scope** half; the existing
capability/RBAC resolution supplies the **creator-live-permission** half. A token whose creator lacks write
RBAC still 403s.

**Inherited unchanged (canonical §3 — token only changes *who* + *scopes*, never downstream authz):** field
mask, row-level write-deny, record/field/sheet permissions, **and** the mirror / cross-base / twoWay
write-gates (`evaluateCrossBaseWrite`, `collectMirrorInvalidation`, `maskDerivedMirrorFieldIds`) — because the
token path uses the **same `RecordWriteService`**. A token cannot write a cross-base mirror it could not write
via session. This is an explicit test obligation (§9), not an assumption.

**Provenance (conscious decision):** a token-created/updated record attributes `createdBy`/`updatedBy` = the
**creator** (acts-as-creator, the ratified Option A). Only the **audit event** distinguishes token-origin from
session-origin.

## 6. Audit (extends §2.4 "tokenId + actorId")
Audit **every** token write attempt and its final outcome — `committed | denied | error | rate_limited` —
because the **denied** attempt is the abuse signal §4 depends on, and a denial **never commits**. A single
post-commit hook therefore **cannot** be the audit point: a 403/422/permission-denial has no commit, so a
post-commit emitter would silently record only successes and drop exactly the signal we need. Two layers:

- **Layer 1 — route-boundary audit (authoritative for the *attempt*).** A token-write wrapper (middleware or a
  handler `try/finally` that runs on every exit path, including thrown denials and the rate-limit 429) records
  the outcome of **every** attempt:
  `{ event: 'oapi.write', tokenId, actorId (creator), operation: create|update|upsert|delete, sheetId,
  target: recordId | batchCount, outcome: committed|denied|error|rate_limited, statusCode, requestId, ts }`.
  This layer **guarantees** denied / error / rate-limited attempts are captured — they never reach a commit hook.
- **Layer 2 — post-commit enrichment (committed only).** For a *committed* write, the `RecordWriteService`
  post-commit hook supplies the **real written result** (created/updated record ids, `batchCount`, mirror
  invalidations) to enrich the Layer-1 row. It supplements committed outcomes; it **does not and cannot** cover
  denials, and no part of the design may claim it does.

**Value-scrub:** carry the F1 invariant on both layers — key-name redaction is insufficient; scrub secret-shaped
**values** (conn-string / JDBC / ODBC in error/detail text) via the shared `payload-redaction` before persisting
any audit/error detail.

**Audit-failure posture (locked — see §10.7):**
- **Committed writes → fail-closed.** The committed-write audit row is written **in the same DB transaction** as
  the mutation; if the audit insert fails, the transaction **rolls back** and the request 5xx's. No committed
  mutation escapes its audit, at no availability coupling to an external store (same DB, same txn).
- **Denied / error / rate-limited attempts → best-effort + mandatory alert.** These have no data transaction to
  roll back (the request already failed); if the Layer-1 write fails, emit a high-severity **alert** + a
  structured app-log fallback — **never silently drop**. A denial cannot be "rolled back"; the mitigation for a
  lost abuse-signal is alerting, not blocking.

## 7. Rate limit (extends §2.4 "600/min/token")
Bucket key = **token id**, not creator user id (a creator may mint several tokens; the canonical says
"per token"). `apiTokenAuth` currently attaches `apiTokenScopes` + `apiTokenUserId`; **add `req.apiTokenId`**
so the limiter can key on it. 600 req/min/token default; **429** on exceed; reuse the existing limiter infra.

## 8. Idempotency (CREATE-specific — decision)
Only `POST /records` double-creates under retry; `PATCH`-by-id is naturally idempotent. **`/patch` depends on
its semantics** — if it upserts by a stable client key it is idempotent; if it blind-inserts it shares
`POST /records`' risk (to confirm at build). **Proposed:** v1 = documented **at-least-once create** (no
`Idempotency-Key`); `Idempotency-Key` header = fast-follow. The owner ratifies "at-least-once create"
knowingly; the deferral is scoped to `POST /records` (+ `/patch` iff blind-insert).

## 9. Test plan (E2E through the full server — mirrors #2955)
**Per write route:** valid scope + creator-RBAC → 200/201; wrong scope → **403**; revoked/expired/no-token →
**401**; **creator-RBAC-lacks-write → 403** (the `min` spine — not a happy-200 only); **mirror/cross-base
write-gate still fires on the token path** (token can't write a cross-base mirror it couldn't via session);
**Layer-1 audit row emitted for every outcome** — committed, **denied (403)**, error, and **rate_limited (429)** —
tokenId + creator, value-scrubbed; committed rows additionally carry the real record ids / `batchCount`; a forced
audit-insert failure on a **committed** write **rolls back** the mutation (fail-closed, §6); **429** after 600/min.
**Allowlist unit (extend `multitable-oapi-read-allowlist.test.ts`):** ALLOW the exact §2 write `(method,path)`
pairs; DENY every §2 trap (GET-on-write, write-method-on-read-path, `/lock`, `/restore`, comment edit/delete,
`/views/:id/submit`, and — until 2b — `DELETE /records/:id`).

## 10. Decisions — RATIFIED 2026-06-28 (all at the recommended default; see Ratification, top)
1. **DELETE sequencing:** 2a (create/update/upsert + comment-create) first, **2b (DELETE)** after — *or* include DELETE in 2a now? *(Recommend 2a-first. DELETE stays in scope either way — ratified.)*
2. **Idempotency:** ship v1 **at-least-once create** (`Idempotency-Key` as fast-follow), scoped to `POST /records`? Confirm `/patch` upsert-vs-blind-insert. *(Recommend defer.)*
3. **Audit denied writes** too (not just success), value-scrubbed, via the **two-layer** model of §6 (route-boundary captures every attempt incl. denials; post-commit only enriches committed)? *(Recommend yes.)*
4. **Provenance** = `createdBy: creator`, token distinguished only in the audit event? *(Recommend yes — the ratified acts-as-creator.)*
5. **Allowlist generalization** to method-bound entries in lockstep + the §2 trap set — approach OK? *(Recommend yes.)*
6. **Rate-limit bucket** = per-**token-id** (not per-creator)? *(Recommend yes — matches "600/min/token".)*
7. **Audit-failure posture (§6):** committed writes **fail-closed** (audit in the same DB txn → rollback on audit failure); denied/error/rate-limited attempts **best-effort + mandatory alert** (no txn to roll back). *(Recommend this split — vs. the stricter "all-audit fail-closed", which would block writes during any audit-store outage.)*

## 11. Out of scope (stay gated / separate slices)
OAPI-3 (`webhooks:manage`); OAPI-4 (Option B per-base/sheet scoping); `/lock`, `/restore`, comment
update/delete; `send_webhook` runtime (its own D-GATE/D-SSRF/D6/payload/value-scrub gate); and **the OAPI-2
build itself** — a separate opt-in after this lock ratifies.

## Net
The ratified canonical already decided *which* writes are token-exposed and the Option-A/min/token-wins frame.
This slice locks the **write-specific** mechanics the canonical left to the slice: the **method-bound
allowlist as the auth boundary** (GET-only today → exact `(method,path)` lockstep, no over-match), the
**disjoint form-bypass precedence**, the **inherited mirror/cross-base/field/row write-gates** (token ≡ session
downstream), **two-layer audit** (route-boundary captures every attempt incl. denials; post-commit enriches
committed; fail-closed on committed) **with value-scrub**, **per-token rate limiting**, **CREATE-only
idempotency**, and **DELETE staged behind destructive controls**. Ratify §10, then OAPI-2a is a separate build opt-in.
