# OAPI-4a — per-base/sheet scoped-token runtime (records slice) — dev & verification (2026-06-29)

> Status: built + verified (real-DB, fail-first proven). Grounding: `origin/main` @ `8bb4a7573`. Builds to the
> RATIFIED design-lock `docs/development/multitable-oapi4-scoped-tokens-designlock-20260629.md` (#3370). Scope =
> **records routes only** (OAPI-4b comments / OAPI-4c UI are OUT). Default behavior unchanged on deploy
> (additive nullable migration, no backfill → legacy tokens stay creator-wide).

## 1. What shipped
A third authorization dimension on `mst_` tokens — `effective access = min(capability scope, base/sheet scope,
creator RBAC)` — enforced by one shared guard on every records route (read + write).

| Layer | File | Change |
|---|---|---|
| Migration | `db/migrations/zzzz20260629120000_add_api_token_base_sheet_scope.ts` | `ALTER TABLE multitable_api_tokens ADD COLUMN base_ids text[]` + `sheet_ids text[]` — **nullable, no default, no backfill**. `down()` drops both. |
| DB type | `db/types.ts` | `MultitableApiTokensTable` gains `base_ids: string[] \| null` + `sheet_ids: string[] \| null`. |
| Types | `multitable/api-tokens.ts` | `ApiToken` + `ApiTokenCreateInput` gain optional `baseIds` / `sheetIds`. |
| Service | `multitable/api-token-service.ts` | `normalizeScopeArray` (trim/dedupe/empty→NULL) + `readScopeArray` (NULL/empty→undefined); `createToken` persists; `rowToToken` maps back (so `validateToken` carries them); **`rotateToken` copies scope forward** (no silent widen). |
| Auth mw | `middleware/api-token-auth.ts` | `apiTokenAuth` attaches `req.apiTokenBaseIds`/`apiTokenSheetIds`; `Express.Request` gains those + `oapiAuditReason`; `requireScope` sets `req.oapiAuditReason='insufficient_scope'` before its 403. |
| **Guard** | `middleware/oapi-scope-guard.ts` (NEW) | the shared `oapiScopeGuard` (§2–§4). |
| Audit | `multitable/oapi-write-audit.ts` | the `res.on('finish')` boundary threads `req.oapiAuditReason` → `recordOapiWriteAttempt` → value-scrubbed `detail.reason`. |
| Routes | `routes/univer-meta.ts` | `oapiScopeGuard` mounted on all **10** reachable records routes at the locked positions (§2). |
| **REST mint** | `routes/api-tokens.ts` | `CreateTokenSchema` + the create route now accept/persist `baseIds`/`sheetIds` (review fix — Zod's unknown-key strip previously dropped them, so the supported minting API could only produce unscoped creator-wide tokens). |
| Golden | `multitable-oapi-scope-guard-realdb.test.ts` (NEW, 15 tests) + `multitable-oapi-token-create-scope.api.test.ts` (NEW, 6 tests) | §5. |
| CI | `.github/workflows/plugin-tests.yml` | both goldens added to the real-DB file list + step name (§5). |

## 2. Enforcement seam + route wiring (locked order)
`oapiScopeGuard` is a strict no-op unless `req.apiTokenId` is set, and a no-op (allow) for an unscoped token.
Mounted on all **10** mst_-reachable records routes (the read allowlist regex covers `/records` AND
`/records/:recordId`):
- **Writes** (4): `POST /records`, `PATCH /records/:recordId`, `DELETE /records/:recordId`, `POST /patch` —
  `apiTokenAuth → oapiWriteAuditBoundary → apiTokenWriteRateLimit → oapiScopeGuard → requireScope → handler`.
  Guard **after** the rate-limiter (out-of-scope attempts are themselves rate-limited) and **before**
  `requireScope`; the audit boundary's finish-listener captures the 403.
- **Reads** (6): `GET /records`, `/records/:recordId`, `/view`, `/sheets/:sheetId/view-aggregate`,
  `/records-summary`, `/fields` — `apiTokenAuth → oapiScopeGuard → requireScope`.

## 3. Scope composition (§3 of the lock)
Per resolved target sheet `S` in base `B`: in-scope iff `(base_ids empty OR B ∈ base_ids) AND
(sheet_ids empty OR S ∈ sheet_ids)`. **Every** touched sheet must resolve AND pass (fail-closed). The target
base is resolved **server-side** (`SELECT id, base_id FROM meta_sheets WHERE id = ANY(...)`) — never a
client-supplied baseId.

## 4. Two load-bearing decisions
- **recordId-authoritative resolution (no spoof):** for `:recordId` routes the guard resolves the sheet from
  the **record** (`SELECT sheet_id FROM meta_records WHERE id = $1`), NOT a body `sheetId`. A scoped token
  cannot declare an out-of-scope record into an in-scope sheet. (Soft-delete moves rows out of `meta_records`
  into a trash table — there is no `deleted_at` column — so a deleted/absent record resolves to no sheet → []
  → uniform 403; the no-oracle property holds. This was a build fix: an initial `AND deleted_at IS NULL` threw
  on the missing column and the fail-closed `catch` masked it on the out-of-scope cases — caught by the
  in-scope T-f assertion, then corrected.)
- **No-oracle uniform 403:** unresolvable target (missing record / no sheet id / unknown sheet) and out-of-scope
  return the **same** `403 OUT_OF_SCOPE` body — a scoped token cannot probe existence. Verified byte-identical
  (T-f NO-ORACLE: `missing.body` deep-equals `outOfScope.body`).

## 5. Verification (real DB) — `metasheet_oapi4a_test`, all migrations applied
**`multitable-oapi-scope-guard-realdb.test.ts` → 15/15 passed.** Coverage: in-scope allow (base / sheet / both
narrowest / read) · out-of-base 403 + **denied audit row with `detail.reason='out_of_base_sheet_scope'`** + no
mutation · out-of-sheet 403 · **out-of-scope READ 403** (uniform read+write, review add) · legacy-unscoped
unchanged (writes any base, reads any sheet) · session no-op (writes a sheet no scoped token could reach) ·
record-addressed allow/deny + **no-oracle byte-identical 403** · DELETE out-of-scope 403 + record present ·
**3-way min** (in-base but no write capability → 403 `INSUFFICIENT_SCOPE`) · **rotateToken preserves scope** ·
**/patch defense-in-depth** (below).
**`multitable-oapi-token-create-scope.api.test.ts` → 6/6 passed (review fix).** Proves the supported REST
minting surface: create with `baseIds`/`sheetIds` → persisted (DB row asserted) + returned + listed · the
REST-minted token is **enforced** (denied out-of-scope 403 `OUT_OF_SCOPE`) and allowed in-scope · `sheetIds`
accepted. Regression for the Zod-strip footgun (a "scoped" create silently minting an unscoped token).
**Adjacent OAPI suites (regression):** oapi1-token-read + oapi2a-token-write + oapi2a-ratelimit → all green
(**36/36 across the 4 suites**). **Typecheck:** `tsc --noEmit` exit 0, clean.

**Fail-first (the guard is load-bearing):** neutralizing `oapiScopeGuard` (early `next()`) turns exactly the 6
scope-enforcement tests RED — T-b (out-of-base), T-c (out-of-sheet), T-f PATCH / NO-ORACLE / DELETE, T-h
(rotated scope) — while the 8 non-scope tests (in-scope allow, legacy-unscoped, session, capability-min) stay
green. The enforcement is necessary for precisely the right assertions.

**CI wiring (test-infra invariant):** added to `.github/workflows/plugin-tests.yml`:
`tests/integration/multitable-oapi-scope-guard-realdb.test.ts \` in the "Run multitable real-DB integration"
file list (+ the step name). Acceptance = the file appears in the step output with passing counts (a
`describeIfDatabase` golden silently skips green if omitted).

## 6. /patch defense-in-depth (coordinator addendum — verified)
`/patch` is single-sheet (the body carries ONE `sheetId`; `changes[]` are `{recordId, fieldId, value}` with no
per-change sheet), so the guard's one resolved sheet IS the full target set. A scoped token could still pass an
in-scope `sheetId` yet name a `recordId` living in another sheet — but `RecordWriteService.patchRecords`
**confines every write to the declared sheet**: the UPDATE is `WHERE sheet_id = $2 AND id = $3`
(`record-write-service.ts:892–904`) and the load/existence SELECTs are all `WHERE sheet_id = $1 AND id …`
(731 / 855 / 1067). An out-of-sheet `recordId` matches zero rows → untouched. **Not a cross-sheet hole.**
Golden **T-patch confinement** asserts: in-scope `sheetId=A`, `changes[].recordId` = a SHEET-B record → that
record is unchanged. (No fix to `patchRecords` was needed or made.)

## 7. Security invariants (§8 of the lock) → evidence
- *A scoped token can NEVER act outside its base_ids/sheet_ids, any route, read or write* → T-a..T-c, T-f, the
  read tests, fail-first.
- *Scoping only tightens (AND-constraint, never OR-widen)* → 3-way min T-g (capability still required) +
  legacy-unscoped T-d (no new grant).
- *Target base resolved server-side from sheet→base* → guard resolves via `meta_sheets`, never a client baseId
  (recordId-authoritative resolution T-f).
- *Revoking/scoping takes effect next request* → `validateToken` reads scope per request; `rotateToken`
  preserves scope (T-h).

## 8. Out of scope / follow-ups
OAPI-4b (comments through the same guard, with server-side comment→container→sheet→base resolution + the
uniform 404/403 shape) and OAPI-4c (token-create UI base/sheet pickers) are separate opt-ins. `/patch` is
single-sheet today; if a multi-sheet batch is ever added, the guard's `resolveTargetSheetIds` must enumerate
the full set (it already iterates a set and fails closed on any unresolved/out-of-scope member).
