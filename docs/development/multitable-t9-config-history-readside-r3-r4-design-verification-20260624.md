# T9 config-history read side (R3 + R4) — design & verification

Status: **built and landing** — R3 read API (PR #3153), R4 FE view (PR #3155). This closes the **read side** of the
T9 config/schema-change history line. The **write side** (T9-W restore-config) stays gated behind its own design-lock.

Design-lock of record: `multitable-t9-config-history-readside-designlock-20260623.md` (R1=fields-only recording, gate
split per entity type, transaction-ization explicit, cascade via batch_id). This doc is the R3+R4 build's design +
verification, referencing — not re-deriving — that lock.

## 0. Where R3/R4 sit in the line

| Slice | What | Status |
|---|---|---|
| T9-R1 | `meta_config_revisions` table + field create/update/delete recording (+ order-shift) | shipped (#3126) |
| T9-R2 | permission / view / sheet-config recording, transaction-ized, field-delete→view cascade | shipped (#3130) |
| T9-R2 BAR-1 | per-entity rollback/transaction-consistency goldens | shipped (#3138) |
| **T9-R3** | **config-history read API (per-entity-type gate)** | **this delivery (#3153)** |
| **T9-R4** | **dedicated FE config-history view** | **this delivery (#3155)** |
| T9-W | restore-config (write side) | 🔒 gated — own design-lock |

The history rows are **config-only** (no record cell values). Reading them is gated by *who can manage that kind of
config*, never by the record-history mask.

## 1. T9-R3 — read API

`GET /api/multitable/sheets/:sheetId/config-history?limit=&offset=&entityType=` → `{ items: [...], limit, offset }`.
Each item: `{ id, entityType, entityId, action, before, after, changedKeys, batchId, actorId, createdAt }`.

### 1.1 The load-bearing property: per-entity-type gate, read-gate ≡ write-gate

A config-history list is **heterogeneous** — one sheet's revisions mix field, view, permission, and sheet_config
changes, each authored behind a *different* capability. The read gate must therefore mirror, per entity type, the
exact capability the mutation route checked when it wrote the row:

| entity_type | gated by | = mutation route check |
|---|---|---|
| `field` | `canManageFields` | createField / updateField / deleteField |
| `view` | `canManageViews` | view create/update/delete |
| `sheet_config` | `canManageSheetAccess` | row-level-read-deny / conditional-rules |
| `permission` | **routed by `entity_id` scope prefix** | the matching permission route |

`permission` rows are themselves heterogeneous (field / sheet / view permissions). Their kind is encoded in the
`entity_id` scope prefix (`field:…` / `view:…` / `sheet:…`), and each routes to the same capability that authored it:
`field:` → `canManageFields`, `view:` → `canManageViews`, `sheet:` → `canManageSheetAccess`.

In this codebase `canManageFields == canManageViews == canWrite` (`multitable:write`), while `canManageSheetAccess`
(`multitable:share`) is independent — so the *meaningful* deny boundary is **write-but-not-share** (sees field/view,
denied sheet_config/sheet-perm) and its inverse. The mapping is still expressed per entity type so it stays correct
if those capabilities ever decouple.

> Invariant: if the read gate and the recording gate ever disagree on an entity type, that is the bug. Same table,
> same per-entity capability.

### 1.2 The gate is in the WHERE clause (pagination correctness)

The allowed entity-types (and allowed permission-scopes) are derived from the actor's capabilities **up front** and
constrain the SQL `WHERE`. We do **not** select-then-filter-in-app: that would yield short pages and lying counts.
Condition strings are static (no user input); every value (`sheetId`, `entityType`, `limit`, `offset`) is
parameterized. An actor who can manage no config short-circuits to an empty list.

### 1.3 Other properties

Deterministic order (`created_at DESC, id DESC`); `limit` clamped 1–100 (default 50); optional `entityType` filter
**narrows within** the allowed set and **cannot bypass** the gate (it is `AND`-ed onto the WHERE, so an actor filtering
for a type they can't manage still gets empty). 401 if unauthenticated; 404 if the sheet doesn't exist.

## 2. T9-R4 — FE config-history view

A **dedicated** sheet-level **Config history** modal (`MetaConfigHistoryModal.vue`) — not folded into the per-record
history drawer (design-lock D5). Opened from a workbench toolbar button shown when a sheet is active.

- **Timeline** of revisions: action badge (created/updated/deleted), entity type, resolved entity label, and for
  updates a per-changed-key `before → after`.
- **Entity-type filter** chips (all / field / view / permission / sheet_config).
- **Faithful client** (the BS-4 wire-drift lesson): `client.getConfigHistory` renders exactly what R3 returns; the
  entity-type filter only **emits a re-fetch** so the **server** re-applies the gate — there is no client-side
  security filtering. The component never culls rows for visibility.
- 14 strict-zero i18n keys (EN+ZH) in `meta-record-labels`.

## 3. Verification

### 3.1 R3 — 8 real-DB goldens, ALLOW *and* DENY (not allow-only)

`multitable-config-history-api-realdb.test.ts` (allowlisted in `plugin-tests.yml`), seeding one revision per gated
bucket (field, view, sheet_config, and field/view/sheet permission), then listing as four actors:

| golden | proves |
|---|---|
| admin sees all six, deterministic order | happy path + ordering |
| **write-but-not-share** sees field/view(+perms), **NOT** sheet_config/sheet-perm | the deny boundary |
| **share-but-not-write** sees sheet_config/sheet-perm, **NOT** field/view | the inverse deny |
| read-only → empty list | no leak to a non-manager |
| `?entityType=field` → only the field rev | filter narrows |
| `?entityType=sheet_config` as writer → still empty | **filter cannot bypass the gate** |
| `limit/offset` → distinct full pages | pagination on the gated set (no short pages) |

**Mutation-proven**: dropping the `canManageSheetAccess` guard (so sheet_config is always allowed) makes the
write-but-not-share DENY golden fail — the deny assertion has teeth, it isn't allow-only-green.

### 3.2 R4 — 5 jsdom specs

`multitable-config-history-modal.spec.ts` (in the `multitable-web-guard`): faithful render (both rows kept, incl.
`before → after`), the entity-type filter **emits** a re-fetch (and does *not* client-cull the list), loading state,
empty state (an actor who manages no config), and close. `vue-tsc -b` clean.

### 3.3 The full T9 line under test

R1 16 recording goldens + R2 4 transaction-consistency rollback goldens + **R3 8 gate goldens** + **R4 5 FE specs** —
the recording side proves *what* is written and that it's bound to the mutation's transaction; the read side proves
*who* can see it, per entity type, with the gate in the query.

## 4. Out of scope (still gated)

- **T9-W** restore-config (revert a config/schema change) — the destructive write side, its own design-lock; nothing
  in R3/R4 writes config.
- T8 table-level PIT restore, BS-3.1 all-or-nothing batch restore, cross-base data-sync, dashboard polish — parked.

## 5. PRs

- R3 read API — #3153 (`multitable-config-history-api-realdb.test.ts`; route in `univer-meta.ts`).
- R4 FE view — #3155 (`MetaConfigHistoryModal.vue`, `getConfigHistory`, workbench wiring, i18n, spec).
- This doc — landed separately (docs-only).
