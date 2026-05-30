# F0a — `GET /records` (cursor list) authorization + field mask · verification

**Date:** 2026-05-29
**Design-lock:** `docs/development/multitable-record-egress-fieldperm-inventory-20260529.md` (#2106), §3 F0a + §4.
**Scope:** F0a **only** — a single PR, no F0b/F1/F2 bundled. Authorization is added to **one endpoint** (`GET /api/multitable/records`); central RBAC/auth untouched (K3 Stage-1 lock).

## The hole

`GET /records` (cursor list) had **no authorization** — no sheet `canRead`, no record-permission filter, no field mask — and served from a **subject-less response cache**. Any authenticated user could read any sheet's full records (every field, every row) by `sheetId`; `filter.*`/`sortField` over a denied field was a value/ordering **oracle** a data mask alone would not close. (#2028 fixed the *single*-record `GET /records/:recordId`; this cursor **list** was untouched.)

## The fix — all five together (GET /records handler only)

1. **`canRead`** — `resolveSheetReadableCapabilities` → `if (!access.userId) 401` → `if (!capabilities.canRead) sendForbidden(403)`.
2. **Field mask** — `loadSheetFields` → `filterVisiblePropertyFields` → `loadFieldPermissionScopeMap` → `deriveFieldPermissions(visiblePropertyFields, caps, { hiddenFieldIds: [], fieldScopeMap })` → `allowedFieldIds` (layer-2 ∧ layer-3, the #2015 composite shared with GET /view); `filterRecordDataByFieldIds(r.data, allowedFieldIds)` per row.
3. **Selection gate** — any `filter.*` key or `sortField` ∉ `allowedFieldIds` → **400**. One **generic** message (`"Field not permitted for filter/sort"`) that **names no field** and is **identical for denied vs non-existent**, so it cannot probe field existence (anti-oracle).
4. **Cache disabled** — the entire records-query-cache subsystem is removed (sole consumer was this endpoint): `getRecordsCache`/`setRecordsCache`/`buildRecordsCacheKey`-usage/`recordsQueryCache`/`invalidateRecordsCacheForSheet` + the realtime-invalidator wiring. A subject-scoped mask cannot ride a subject-less cache key without cross-subject poisoning; this is not the grid hot path (the grid uses GET /view), so dropping the cache is smaller/safer than a subject-aware key. (`buildRecordsCacheKey` stays defined + unit-tested in `query-service.ts`; `realtime-publish` `_invalidateCache` defaults to a no-op, so removing the wiring is crash-safe.)
5. **Record-permission filter** — verbatim parity with GET /view: `hasRecordPermissionAssignments` → `loadRecordPermissionScopeMap` → drop `!deriveRecordPermissions(id, caps, map).canRead`. Read is grant-additive today (golden: record-read is a non-gate), so this is defense-in-depth keeping GET /records' record posture identical to GET /view.

**Non-existent `sheetId`**: the `canRead` gate runs before the query, so a **non-reader gets 403 whether or not the sheet exists** (T8) — existing-but-denied and missing are indistinguishable, no existence oracle, and the resolver does not throw (no 500). A caller that *does* hold read capability instead reaches `queryRecordsWithCursor` → `loadSheetAndFields`, which throws `NOT_FOUND` for a missing sheet → the handler's catch maps it to **404** (a `filter.*`/`sortField` on a missing sheet returns **400** first, since `allowedFieldIds` is empty). Disclosing existence to an already-authorized reader is not a meaningful oracle; the per-sheet read model is GET /view parity, unchanged by F0a.

## Fail-first (real DB)

`tests/integration/multitable-records-list-authz.test.ts` (wired into `.github/workflows/plugin-tests.yml` real-DB step). Seed non-negotiable: `FLD_SECRET.property = {}` (property.hidden UNSET) so the deny is **solely** layer-3 `field_permissions.visible=false`.

| Test | Pre-fix (origin/main) | Post-fix |
|---|---|---|
| T1 non-reader (`perms:[]`) | **200 + data** (leak) | **403** |
| T2 unauthenticated | **200** (no check) | **401** |
| T3 field mask | **SECRET_CANARY in data** | omitted (+ FLD_VISIBLE present, canary nowhere; no `linkSummaries`/`attachmentSummaries`) |
| T4 `filter.<denied>` | **200** (oracle) | **400** · readable filter → 200 |
| T4b `filter.<non-existent>` | **200** | **400, same status+message as T4** |
| T5 `sortField=<denied>` | **200** (oracle) | **400** · readable sort → 200 |
| T6 per-subject (same query) | n/a (no mask → both full) | A omits / B includes |
| T7 record-perm present | 200 (inert) | 200 (granted subject still sees record) |
| T8 non-reader + non-existent sheet | n/a | **403** (= T1; no existence oracle, no 500) |

- **Pre-fix RED proven**: 7 failed / 2 passed against unmodified origin/main on a freshly-migrated DB (T1 `200→403`, T2 `200→401`, T3 canary present, T4/T4b/T5 `200→400`, T6 canary present; sentinel + T7 pass).
- **Post-fix GREEN**: 9/9.
- **T6 cache-vector demonstrated RED** at the intermediate "mask added, subject-less cache **kept**" state: subject B received `undefined` for `FLD_SECRET` — i.e. subject A's cached masked body — proving the cache was a real cross-subject leak vector; GREEN once removed. (origin/main itself cannot RED the cache vector: with no mask pre-fix both subjects get identical full data. T6 stands as the forward regression guard.)

## Regression / type

- `tsc --noEmit` → **exit 0**.
- `multitable-records-read-field-mask` + `multitable-view-aggregate` → **23/23** (same handler family + mask helpers).
- `multitable-cursor-pagination` + `multitable-query-service` → **17/17** (`buildRecordsCacheKey` intact in `query-service.ts`).
- Admin `GET /records` (e2e `multitable-public-form-smoke`, not run here — needs a live stack): admin → `canRead`, `allowedFieldIds` = all visible fields, no denied filter/sort → records returned with data; shape unchanged (`{ records: [{id,version,data}], nextCursor, hasMore }`).

## Local DB note

The stale local `metasheet_v2` 500s this query (missing `modified_by` column) and lacks `record_permissions`, masking the leak. Verification used a **throwaway** DB (`metasheet_f0a_test`) migrated to current schema (mirrors CI's `metasheet_test`), leaving the dev DB untouched. CI runs the test against `metasheet_test` in the dedicated `plugin-tests.yml` step (DATABASE_URL hard guard, non-skip sentinel).

## Diff scope

`packages/core-backend/src/routes/univer-meta.ts` (+54/−43), the new test, and the one-line `plugin-tests.yml` wiring + this doc. No central RBAC/auth, no other endpoint.
