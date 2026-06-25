# T9-R3 — config history READ API — design-lock — 2026-06-24

> **Design-lock (PROPOSED).** T9-R1 (#3126, merged) + T9-R2 (#3130, approved) RECORD an
> append-only `meta_config_revisions` table (`entity_type ∈ {field, permission, view,
> sheet_config}`). R3 exposes a READ API over those rows. This doc locks the **gate口径** (the
> security core) and the endpoint shape **before any code**. Grounded on current `main`.

## The one rule (gate口径)

**Symmetric access: the read gate for an entity's config history is the EXACT capability that
gates WRITING that config. NEVER the record-history mask / record-field projection.** Config
history is schema/config, not record values — there are no per-record permissions and no
field-mask here; the manage-capability *is* the access control.

### Mapping (history rows → read gate = write gate), grounded on current main

| history rows | read gate (= the write gate) | write route guard (univer-meta.ts) |
|---|---|---|
| `field` config | `canManageFields` | field create/patch/delete (`!canManageFields → 403`) |
| `view` config | `canManageViews` | view create/patch/delete (`!canManageViews → 403`) |
| `sheet_config` (row-deny, conditional-rules) | `canManageSheetAccess` | PUT row-level-read-deny / conditional-rules |
| `permission` — **sheet** subtype | `canManageSheetAccess` | PUT `/sheets/:id/permissions/...` |
| `permission` — **view** subtype | **`canManageViews`** | PUT `/views/:id/permissions/...` |
| `permission` — **field** subtype | **`canManageFields`** | PUT `/sheets/:id/field-permissions/...` |

**Load-bearing finding (grounding):** the three permission subtypes do **not** share a gate.
View-permission history is gated by `canManageViews` and field-permission history by
`canManageFields` — mirroring their write routes, NOT `canManageSheetAccess`. A blanket
"`canManageSheetAccess` for all permission rows" would be **wrong both ways**: it would hide
view-perm history from a view editor entitled to it, and expose sheet-perm history to a
field-only manager who is not. Symmetry with the write gate is the invariant.

## The gate predicate (ONE place, fail-closed)

All gating goes through a single source of truth, exhaustively unit-tested:

```
configHistoryRequiredCapability(row): Capability | DENY
  switch (row.entity_type):
    'field'        → canManageFields
    'view'         → canManageViews
    'sheet_config' → canManageSheetAccess
    'permission'   → scope = parseScope(row.entity_id):   // R2 writes `${scope}:${JSON.stringify(parts)}`
                       'sheet' → canManageSheetAccess
                       'view'  → canManageViews
                       'field' → canManageFields
                       else    → DENY                      // FAIL CLOSED
    else           → DENY                                  // FAIL CLOSED (unknown entity_type)
```

- `parseScope` = the substring before the first `:` (scope ∈ `field|sheet|view`, a fixed enum
  written by R2's `permissionConfigEntityId`). It **must fail closed**: an unrecognized or
  unparseable scope → `DENY`, never a default-allow. A malformed `entity_id` → denied (tested).
- Gating by parsing `entity_id` is acceptable *only* because the scope prefix is a controlled
  enum + the parse fails closed. (If R-future adds a permission scope, it lands here as an
  explicit case, else it is denied by default — safe.)

## Endpoint shape — LOCKED: per-entity-type (v1)

Per-type endpoints, each a **single structural capability gate** (no row-level filtering):

```
GET /sheets/:sheetId/config-history/fields                  → canManageFields
GET /sheets/:sheetId/config-history/views                   → canManageViews
GET /sheets/:sheetId/config-history/sheet-config            → canManageSheetAccess
GET /sheets/:sheetId/config-history/permissions/sheet       → canManageSheetAccess
GET /sheets/:sheetId/config-history/permissions/view        → canManageViews
GET /sheets/:sheetId/config-history/permissions/field       → canManageFields
```

Each handler: resolve capabilities → the one gate check (via the predicate's required cap) →
query `meta_config_revisions WHERE sheet_id=$1 AND entity_type=$2 [AND scope]` ordered
deterministically → enrich actor names → return.

**Rationale:** a structurally-enforced per-endpoint gate (one `if`) is much harder to get wrong
than a per-row filter — a row-filter bug is a silent leak. Mirrors the write-side route
organization. Uses the `(sheet_id, entity_type, entity_id, created_at DESC)` index directly.

**DEFERRED (NOT v1, separate opt-in):** a unified sheet-level timeline (all entity types in one
list). It would gate **row-by-row** through the *same* `configHistoryRequiredCapability`
predicate (drop rows whose required cap the caller lacks). The predicate is authored v1-ready so
the timeline can be added later without re-deriving the gate口径.

## Structural parallel — reuse record-history's SHAPE, not its gating

Reuse from the record-history read API: access resolution (`resolveSheet…Capabilities`),
deterministic pagination (`created_at DESC, id DESC`), actor-name enrichment
(`resolveUserDisplayNames`). Do **NOT** reuse: `canRead`, per-record permission scope, or
`redactRecordRevisionEntry` (the RECORD field-mask) — those are for record *values*, of which
config history has none. **`loadAllowedFieldIds` IS reused**, but only to drive the view-payload
projection below (NOT as a record mask).

## Payload projection — no RECORD-mask, but VIEW filter literals ARE redacted

> **One-line rule:** the access gate controls every payload **EXCEPT `view` rows'
> `filterInfo` filter literals, which are redacted per-requester** (the LOCKED exception below).
> Config history is NOT returned `before`/`after` in full to anyone with the manage capability —
> view filter literals are field-read-sensitive and masked.

For most rows the capability gate is the complete control: `before`/`after` hold CONFIG (field
schema, permission grants, sheet rules) and a caller who holds the manage capability is entitled
to see them in full **— with the sole exception of view filter literals (the LOCKED exception
immediately below)**. There is no per-record-value field-mask here (config history holds no
record values); the view exception is a targeted filter-literal redaction, not a record mask.

**Exception — `entity_type='view'` (LOCKED).** A view's `filterInfo.conditions[].value` literals
are already classified as **field-read-sensitive**. The live view read redacts them per-requester
via `redactViewConfigFilterLiterals(view, allowedFieldIds)` at *every* serialization site (#2052;
proven by `multitable-viewconfig-filter-literal-redaction.test.ts` / R9 — a `canManageViews`
caller who is field-DENIED must NOT see the denied field's literal). Since `canManageViews` does
**not** imply field-read, returning historical `before`/`after.filterInfo` raw would **bypass that
protection and leak the denied literal through history.** Therefore R3 MUST, for view rows, redact
filter literals inside **both** `before` and `after` using the requester's `loadAllowedFieldIds(…)`
+ the exact `redactViewConfigFilterLiterals` semantics, BEFORE returning the row.

This is a PAYLOAD projection layered on the access gate, and **distinct from it**: the gate decides
*which rows* a caller sees; this decides *which filter literals within a view row*. All other entity
types (`field`, `permission`, `sheet_config`) are returned in full to the endpoint's cap-holder.

## Read-side locks

- **L-R1 fail-closed gating** — unknown `entity_type` or unparseable permission scope → DENY.
- **L-R2 deterministic pagination** — `(sheet_id, created_at DESC, id DESC)`; stable cursor/offset.
- **L-R3 read-only** — R3 never mutates. Restore/rollback is the *parked* Global History write-side, NOT R3.
- **L-R4 actor enrichment read-only** — display names only; no PII beyond the existing record-history read.
- **L-R5 view filter-literal redaction** — view rows' `before`/`after.filterInfo` literals are redacted per-requester via `loadAllowedFieldIds` + `redactViewConfigFilterLiterals` (#2052/R9) before return; the manage gate alone is NOT sufficient for view payloads.

## Scope

**IN R3:** the per-type read endpoints above (backend), gated symmetrically, paginated,
actor-enriched, with view-row filter-literal redaction (L-R5); real-DB goldens for each entity
type + each permission subtype + the fail-closed DENY cases + the view-literal redaction (a
field-denied view-manager reads view history WITHOUT the denied literal; a fully-allowed viewer
sees it; field/sheet/permission payloads unmasked except by their cap gate).

**OUT (later / separate gated opt-in):** the unified timeline; any FE surface; cross-sheet /
cross-base config history; and all write-side restore/rollback.

## TODO (gated)

- 🔒 **R3-0** design-lock (this doc) — review + approve the gate口径 + endpoint shape before impl.
- ⬜ **R3-1** `configHistoryRequiredCapability` predicate + unit tests (incl. fail-closed on unknown type / malformed permission scope).
- ⬜ **R3-2** per-type read endpoints (fields / views / sheet-config) — cap gate + pagination + actor enrichment.
- ⬜ **R3-2b** view-payload projection (L-R5) — redact `before`/`after.filterInfo` literals via `loadAllowedFieldIds` + `redactViewConfigFilterLiterals` in the view-history endpoint.
- ⬜ **R3-3** permission-subtype endpoints (sheet / view / field) — each its own gate per the table.
- ⬜ **R3-4** real-DB goldens: each surface returns only its rows; cap-X reads X-rows + is 403'd on the others; malformed `entity_id` → DENY; pagination stable; AND view-history filter-literal redaction (field-denied view-manager does NOT see the denied literal; fully-allowed sees it; field/sheet/permission payloads unmasked except by the cap gate).
- ⬜ **R3-5** register the real-DB test in `plugin-tests.yml`.

> Dependency: R3 reads what R2 records — **#3130 (T9-R2) is merged on `main` (5defc2f9), so this is
> satisfied.** (#3138 backfills R2's rollback goldens — test-only, lands independently, does not gate
> the design.) Deferred items (unified timeline, FE) are each a separate explicit opt-in after R3 ships.
