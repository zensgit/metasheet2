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
`loadAllowedFieldIds` / `redactRecordRevisionEntry` (the field-mask). Those are for record
*values*; config history has none.

## No field-mask (why it's safe)

`before`/`after` hold CONFIG — field schema, view config, permission grants, sheet rules. A
caller who holds the manage capability for that entity manages that config and is entitled to
see it in full. There are no per-record values and no per-record permissions in these rows, so
there is nothing to field-mask; the capability gate is the complete control.

## Read-side locks

- **L-R1 fail-closed gating** — unknown `entity_type` or unparseable permission scope → DENY.
- **L-R2 deterministic pagination** — `(sheet_id, created_at DESC, id DESC)`; stable cursor/offset.
- **L-R3 read-only** — R3 never mutates. Restore/rollback is the *parked* Time-Machine write-side, NOT R3.
- **L-R4 actor enrichment read-only** — display names only; no PII beyond the existing record-history read.

## Scope

**IN R3:** the per-type read endpoints above (backend), gated symmetrically, paginated,
actor-enriched; real-DB goldens for each entity type + each permission subtype + the
fail-closed DENY cases.

**OUT (later / separate gated opt-in):** the unified timeline; any FE surface; cross-sheet /
cross-base config history; and all write-side restore/rollback.

## TODO (gated)

- 🔒 **R3-0** design-lock (this doc) — review + approve the gate口径 + endpoint shape before impl.
- ⬜ **R3-1** `configHistoryRequiredCapability` predicate + unit tests (incl. fail-closed on unknown type / malformed permission scope).
- ⬜ **R3-2** per-type read endpoints (fields / views / sheet-config) — cap gate + pagination + actor enrichment.
- ⬜ **R3-3** permission-subtype endpoints (sheet / view / field) — each its own gate per the table.
- ⬜ **R3-4** real-DB goldens: each surface returns only its rows; a caller with cap X reads X-rows and is 403'd on the others; malformed `entity_id` → DENY; pagination order stable.
- ⬜ **R3-5** register the real-DB test in `plugin-tests.yml`.

> Dependency: R3 reads what R2 records, so **#3130 (T9-R2) must be in `main` before R3 impl lands.**
> Deferred items (unified timeline, FE) are each a separate explicit opt-in after R3 ships.
