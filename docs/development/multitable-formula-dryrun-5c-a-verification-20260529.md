# Multitable Formula Dry-run #5c-a — backend verification

- **Slice**: #5c-a — backend for real-record sampling in the formula dry-run endpoint. Implements the design-lock `multitable-formula-dryrun-5c-design-20260528.md` (#1995).
- **Status**: ✅ implemented + verified (this doc). Frontend **#5c-b is a separate explicit opt-in** (not in this slice).
- **Date**: 2026-05-29
- **Grounding**: worktree off `origin/main 01c753a6b`, branch `runtime/multitable-formula-5c-a-20260529`. Anchors below verified against that tip (the design-lock's `bb61fee2d` anchors are unchanged at `01c753a6b` for these regions).
- **Lock posture**: additive only. `src/formula/engine.ts` (K3-frozen, attendance-shared), RBAC/auth, and `plugin-integration-core` are NOT touched.

## What shipped (2 files)

1. **`packages/core-backend/src/routes/univer-meta.ts`**
   - `requireRecordReadable` (`:2190`): success return extended `{access}` → **`{access, capabilities}`** (`:2195`/`:2231`) — additive; the 3 existing callers (`:4212/:4247/:4273`) destructure only `{access}`.
   - `POST /sheets/:sheetId/formula/dry-run` (`:6020`): optional `recordId` in the body. When present → `requireRecordReadable` gate (yields access+capabilities) → `canManageFields` → RAW `SELECT data` → D3c field mask (`hiddenFieldIds: []`) → `effectiveSampleValues = { ...maskedData, ...sampleValues }` → unchanged no-DB `dryRunFormulaEngine.dryRun(...)`. Absent `recordId` → byte-identical to the prior #5b path.
2. **`packages/core-backend/tests/integration/multitable-formula-dryrun.test.ts`**
   - Extended with the #5c real-record cases (runs in `plugin-tests.yml:163-172`, real-DB, node 20.x).

## Verification results

| Check | Result |
|---|---|
| `tsc --noEmit` (whole core-backend) | ✅ exit 0, clean |
| Integration (real DB, local PG + `DATABASE_URL`) | ✅ **18/18** (`multitable-formula-dryrun.test.ts`) |
| Unit (`tests/unit/formula-dryrun.test.ts`, engine — unchanged) | ✅ 9/9 |
| `contracts (openapi)` parity gate | ✅ green (no spec change — see §"OpenAPI") |
| Adversarial multi-lens review (security / behavior / test-adequacy / frozen-lock) | ✅ 4× **pass-with-nits**, no leak vector, no blocking |

### Test → design matrix (what each case proves)

| Test | Proves |
|---|---|
| T1a | recordId not on sheet → **404** (record-gate existence) |
| T1b | valid recordId, user lacks sheet read → **403** (record-gate sheet `canRead`) |
| T1c | valid recordId, unauthenticated → **401** (record-gate no `userId`) |
| T1d *(review-added)* | recordId branch, `multitable:read` (canRead=true, canManageFields=false) → **403** — pins the `canManageFields` check to the recordId branch (`:6068`), not only the no-recordId path |
| T2 | field_permissions-denied field's value **never leaks** + `missing_sample`; also proves `userId` was resolved (else empty-map → leak) |
| T2b *(review-added)* | `property.hidden` field's value **never leaks** (second mask channel via `filterVisiblePropertyFields`) |
| T3 | visible record values are sampled (result from the record); explicit manual `sampleValues` override per-field (record-as-base) |
| T4 | lookup ref → `missing_sample` (RAW read, NOT materialized) — preview==production; not `unknown_field` |
| T5 | no recordId → unchanged #5b manual path (additive, not regressed) |

## Empirical refinements to the design-lock (recorded on-record)

The design-lock was authored against assumptions about the permission model; reading the code/schema during implementation refined three of them. None changes the chosen approach; they correct the test matrix and an item's framing.

### 1. Design §7-T1 ("record-scope-denied → 403") is a DEAD BRANCH under the current schema — reframed to T1a/T1b/T1c

`record_permissions.access_level` is `CHECK (access_level IN ('read','write','admin'))` (migration `zzzz20260413100000_create_record_permissions.ts:20`) — **no deny level**. `deriveRecordPermissions` (`permission-derivation.ts:130-142`) returns `canRead = capabilities.canRead && accessLevel ∈ {read,write,admin}`, i.e. `canRead = capabilities.canRead` for any stored row. And `loadRecordPermissionScopeMap` (`permission-service.ts:830`) returns only rows whose subject matches the requesting user, so a non-empty map can never describe a *non-granted* user. Therefore the deny branch in `requireRecordReadable` (`:2218-2225`, `recordScopeMap.size>0 && !deriveRecordPermissions(...).canRead`) is **unreachable for read** — record-read is **grant-additive** (consistent with the D3 permission-matrix golden "record-read is a non-gate" finding; the golden suite seeds no `record_permissions`).

Consequence: a "record-scope-denied → 403" test cannot be made to fail-then-pass. The record gate's *real* protections are **existence (404)** and **sheet-level `canRead` (403)** + `userId` (401), which T1a/T1b/T1c verify. `requireRecordReadable` is still the correct primitive (audited path, existence + sheet-read, and it auto-inherits any future record-read-deny level). The route comment at `:6052-6054` states this.

### 2. OpenAPI item T6 is a no-op (endpoint not modeled) — pre-existing, not a #5c regression

The dry-run endpoint (and now its `recordId` field) is absent from the OpenAPI source spec; the parity gate `scripts/ops/multitable-openapi-parity.test.mjs` is a curated allowlist that does **not** assert the dry-run path. So `#5c-a` requires **no OpenAPI change** and the `contracts (openapi)` gate stays green. This gap predates #5c-a (#5a/#5b also shipped the endpoint un-modeled). **Optional follow-up** (separate, non-blocking): model the dry-run path in the OpenAPI source.

### 3. View context = option B (locked) — display-consistency defer, NOT security

The mask passes `hiddenFieldIds: []` (sheet-scope). `deriveFieldPermissions` (`permission-derivation.ts:79-90`) computes `visible` as 3 ANDed layers: view.hiddenFieldIds (display) · static `property.hidden` · subject `field_permissions` (`scope.visible`, the real read gate). Option B omits only layer-1 (per-view display hiding) — layer-3 (the read gate) is fully enforced (proven by T2). The honest label (sheet-scope, permission-safe, raw-record sampling — **not** "mirror current view's columns") is carried by the design-lock §1.1; the frontend tooltip (#5c-b) must also carry it.

## Adversarial review outcome (4 lenses)

All four lenses returned **pass-with-nits**; no blocking/high.
- **Security / field-read leak**: NO leak vector across 6 attack surfaces (mask drops before engine; merge `{...maskedData,...sampleValues}` cannot surface the record's denied value; empty-scope-map trap closed by the `userId` 401 guard; diagnostics echo only field ids/types, never values; gate precedes eval; mask list consistent with the audited export-xlsx composite). Ship-as-is.
- **Behavior / contract**: no-recordId path identical; additive helper return backward-compatible; gate codes/ordering correct.
- **Test adequacy**: 2 LOW gaps → **folded in** as T1d (canManageFields on recordId branch) and T2b (property.hidden channel).
- **Frozen-core / lock safety**: `formula/engine.ts` untouched; engine still issues zero DB queries (route does the read); no RBAC/auth/integration-core; no dependency/lockfile change; only additive `requireRecordReadable` return.

## Out of scope / follow-ups (each a separate opt-in)

- **#5c-b frontend** — record picker + `recordId` passthrough + honest-label tooltip + C2/C4 (stale-drop on record swap, never gates save). NEXT opt-in.
- **Faithful lookup/rollup preview** (materialize) — deferred behind the #1971 Layer-2 fix.
- **OpenAPI modeling** of the dry-run endpoint (incl. `recordId`) — pre-existing gap, optional.
- **role / member-group field-deny** wire tests — covered by shared SQL (`loadFieldPermissionScopeMap`); user-subject + property.hidden channels are wire-proven (T2/T2b).
- **`GET /records/:recordId`** (`:7319`) lacks the record-scope gate AND uses static-only field masking — flagged, not fixed here.
