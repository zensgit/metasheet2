# T9-R3 — config-history READ API — design + verification — 2026-06-24

> Implements the read API over `meta_config_revisions` (recorded by R1/R2) per the design-lock
> `docs/development/multitable-t9-r3-config-history-read-api-design-lock-20260624.md`. Backend
> only; the unified timeline + any FE surface remain deferred (separate opt-ins).

## What shipped

- **Gate predicate** — `packages/core-backend/src/multitable/config-history-read.ts`:
  `configHistoryRequiredCapability(entityType, entityId)` → the config-manage capability that
  gates reading that row's history, or `null` = DENY. Pure, fail-closed, unit-tested.
- **Six read endpoints** — `packages/core-backend/src/routes/univer-meta.ts`, each a single
  structural capability gate, mirroring the record-history endpoint's shape (pagination
  `created_at DESC, id DESC`, actor-name enrichment via `resolveUserDisplayNames`):
  `GET /sheets/:sheetId/config-history/{fields,views,sheet-config}` and
  `GET /sheets/:sheetId/config-history/permissions/{sheet,view,field}`.
- **View payload redaction** — the `/views` endpoint redacts `before`/`after.filterInfo`
  literals via the requester's `loadAllowedFieldIds` + the existing `redactViewConfigFilterLiterals`.

## Design — the gate口径 (symmetric with the write routes)

The access gate (which ROWS a caller may read) is the EXACT capability that gates WRITING that
config — never the record-history mask. Grounded on current main:

| history rows | read gate = write gate |
|---|---|
| `field` | `canManageFields` |
| `view` | `canManageViews` |
| `sheet_config` | `canManageSheetAccess` |
| `permission` / scope `sheet` | `canManageSheetAccess` |
| `permission` / scope `view` | `canManageViews` |
| `permission` / scope `field` | `canManageFields` |

The permission subtype is parsed from `entity_id` (`${scope}:…`, scope ∈ field|sheet|view). The
predicate **fails closed**: an unknown `entity_type` or an unparseable permission scope → DENY.
Belt-and-suspenders: each returned row is re-checked against the predicate, so a mis-prefixed
permission row cannot slip an endpoint (the predicate is the single source of truth, also used by
the SQL scope filter).

> Capability note (grounding): `canManageFields == canManageViews == canWrite` (both derive from
> `multitable:write`), while `canManageSheetAccess` derives from `multitable:share`/admin. So the
> real separable axis is **write vs share vs read-only** — the cross-cap tests exercise exactly that.

## The view payload exception — proven END-TO-END (not fixture-deep)

A view's `filterInfo.conditions[].value` literals are field-read-sensitive (#2052/R9): the live
view read redacts them per-requester, and `canManageViews` does NOT imply field-read. R3 returns
historical view config, so it MUST redact those literals too. **Verified against R2's real
recorded shape**, not a hand-built fixture: a view filtered on a denied field is created+patched
through the real routes (so R2 records it), the raw recorded row is asserted to hold the secret
literal in `filterInfo.conditions[].value` (the path the redactor walks — R2's camelCase shape
matches), and a field-denied view-manager reading `/config-history/views` does NOT see it, while a
fully-allowed reader does; a non-filter key (the view name) survives.

## Verification (all green)

- **Unit** — `tests/unit/config-history-read.spec.ts` (9): every entity_type, all 3 permission
  subtypes, and fail-closed (unknown type → DENY; malformed/empty/unknown-scope permission id → DENY,
  including a COLONLESS scope-looking id like a bare `'field'` — a real `scope:` boundary is required).
- **Real-DB goldens** — `tests/integration/multitable-config-history-read-realdb.test.ts` (8):
  - each surface returns only its entity_type/scope rows;
  - **cross-cap 403**: a write-only user (no share) is 403 on `/sheet-config` + `/permissions/sheet`,
    200 on fields/views/perm-view/perm-field; a read-only user is 403 on every endpoint;
  - **view redaction (fixture)**: a field-denied view-manager doesn't see the secret literal, a
    fully-allowed reader does, VISIBLE stays;
  - **view redaction (END-TO-END, real recorder)**: as above but via the real view route → R2
    record → read, with a raw-recorded-row sanity check + a non-filter-key survival assertion;
  - **fail-closed**: a malformed `permission` entity_id is returned by no permission endpoint;
  - **deterministic pagination** (`created_at DESC, id DESC`).
- `tsc` 0; R1/R2 recording goldens unaffected (`multitable-config-revisions-realdb.test.ts` 20/20).
- Real-DB test registered in `.github/workflows/plugin-tests.yml`.

## Scope

**IN:** the six gated, paginated, actor-enriched read endpoints + view-row redaction + the goldens.
**OUT (deferred, separate opt-in):** a unified sheet-level timeline (row-gates via the SAME
predicate); any FE surface; cross-sheet/base history; and all write-side restore/rollback (parked).

## Commits (branch `claude/multitable-t9-r3-config-history-read-impl-20260624`)
- `e7a332a4b` feat — predicate + 6 endpoints + view redaction + unit + real-DB golden + CI registration
- `4251b84f0` test — end-to-end view-redaction golden against R2's real recorded shape
