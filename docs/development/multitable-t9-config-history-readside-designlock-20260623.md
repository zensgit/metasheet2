# T9 — Config / Schema-Change History (READ-SIDE) — DESIGN-LOCK

> Status: **DESIGN-LOCK, docs-only. Read-side runtime GATED behind ratification of §6 (D1–D7) + an explicit owner
> opt-in per slice.** The next arc after the record-restore line (selected via the next-arc audit). This locks the
> READ half only — **record + display** the change history of config/schema entities. **Restore-config (mutating
> config back to a prior state) is explicitly OUT of this lock** — it is the write half (T9-W), deferred behind the
> read view + its own design-lock, exactly as the record line did read (T5/T7) before write (BS-1..BS-3).
>
> **FIX-FORWARD 2026-06-24 (post line-by-line review):** four corrections before ratification — (1) v1 scope pinned
> to **fields-only** (permissions → R2), resolving the D3↔TODO contradiction; (2) the read gate is split **per entity
> type** to match the existing author gates (field-perms are `canManageFields`, not a blanket `canManageSheetAccess`);
> (3) D6's "in-transaction recording" made an **explicit transaction-ization requirement** — view + field-permission
> writes are NOT transactional today, so recording them is not "just append a row"; (4) **cascade attribution**
> (T9-L7 / D7) pinned via a `batch_id` so a field-delete's derived view-config cleanup is explainable. The §5 LOCKS
> are renamed T9-L* to disambiguate from the §7 R-slices.

## 1. Scope — what the read-side records + displays (across the full arc, sliced in §7)

A per-sheet (and where relevant per-base) **append-only history of CONFIG/SCHEMA changes**, parallel to the record
data history (`meta_record_revisions`) but for structure rather than record values:

- **Fields** — create / delete / rename / retype / property change (link config, formula expression, options,
  rollup/lookup config, read-only, hidden).  **← v1 (R1)**
- **Permissions** — `field_permissions`, sheet access / role, view permissions, row-level deny / conditional-read
  rules.  **← R2** (needs transaction-ization + the per-type gate first; see D6 + §4).
- **Views** — create / delete / config change (filters, sorts, groups, hidden fields, view type, frozen columns).
  **← R2** (also needs transaction-ization).
- **Sheet / base config** — name, settings (retention, row-deny-enabled, similar toggles).  **← R2.**

Each entry answers: **what config entity changed, how (before→after), when, by whom.** READ-ONLY surfacing — a
timeline the actor can view; no action that mutates config.

**NOT in scope:** restore-config (T9-W, deferred) · record DATA history (the record line owns it) · destructive
table-level PIT (T8) · the general compliance `audit_logs` (separate concern — security/regulation, not a
user-facing config timeline).

## 2. Data model (parallels meta_record_revisions)

A new append-only table `meta_config_revisions`: `{ id, sheet_id, entity_type, entity_id, action, before, after,
changed_keys, batch_id, actor_id, created_at }`.
- `entity_type` ∈ { field, permission, view, sheet_config } — a fixed discriminator (T9-L2). **v1 (R1) writes only
  `field`.**
- `before` / `after` carry the **diff** (changed keys + the values needed to display), NOT a full snapshot (D2):
  create → `before` null / `after` the entity's own config; delete → `before` the config / `after` null; update →
  the changed keys only. An empty diff (a no-op PATCH that changed nothing) records **nothing** — never an empty
  revision.
- `batch_id` groups a mutation with its cascaded derived changes (T9-L7 / D7).
- **`meta_config_revisions` rows are NOT record data.** A future read API (R3) MUST apply its own config-manage gate
  (§4) and must NOT reuse the record-history projection / LOCK-3 record mask — that mask is for record values, this
  table holds config.

## 3. Recording (the capture half of "record + display")

A shared `recordConfigRevision(query, …)` helper appends one row **using the mutation's own transaction `query`**, so
the config change and its history row commit or roll back together — the history can never diverge from live config.

**Transaction-ization is part of the work, not a given (D6):** field create/update/delete are already transactional
(R1 wires the recorder into their existing `pool.transaction`). View create/update/delete and the field-permission
write are **direct `pool.query` today** — any slice that records them MUST first wrap that route in a transaction (or
route it through the shared in-transaction helper). R2+ carry this explicitly; R1 (fields) needs none.

Recording is append-only (T9-L4) — never restore (T9-L1).

## 4. Security model — the read gate is split PER ENTITY TYPE (matches existing author gates)

- **Config-manage gate (T9-L3), per entity type** — config-history visibility uses the SAME capability that already
  gates *seeing/authoring* that config, not one blanket gate:
  - field history → `canManageFields`
  - **field-permission history → `canManageFields`** (matches the existing `/field-permissions` GET/PUT gate — NOT
    `canManageSheetAccess`, which would be narrower than the current author)
  - sheet-access / role history → `canManageSheetAccess`
  - view + view-permission history → `canManageViews`
  - sheet-config history → sheet-admin
  Never admin-bypassed silently. (An actor who can author that config can see how it changed; one who cannot, cannot.)
- **No record-value leakage (T9-L5):** config history surfaces STRUCTURE/config only (field types, view configs,
  permission rules, formula expressions). It never carries record DATA values; a config change that references a
  value (a default, a conditional-rule threshold) shows the *config*, not record data.

## 5. Locks (T9-L*)

- **T9-L1 — READ-ONLY.** Records + displays; NEVER restores. Restore-config = T9-W (separate gated slice). Tripwire:
  any path that *writes config back to a prior revision* is T9-W, out of this lock.
- **T9-L2 — fixed entity-type taxonomy** (field / permission / view / sheet_config), extended only by an explicit slice.
- **T9-L3 — per-entity-type config-manage gate** (§4); never blanket; not admin-bypassed.
- **T9-L4 — append-only, in-transaction recording** at the mutation chokepoints; forward-only (history never edited/deleted).
- **T9-L5 — config-only, no record-value leakage.**
- **T9-L6 — deterministic order** (created_at DESC, id DESC tiebreak) + a retention decision (D4).
- **T9-L7 — cascade attribution.** A config mutation that cascades derived config changes (e.g. a field-delete that
  cleans view filter/sort/group/hidden-field-ids) records the derived change(s) under the **same `batch_id`** as the
  parent, so the user sees "field X deleted → view filter on X removed," not an unexplained view change. (The view
  side of the cascade is itself recorded only once view recording lands in R2; R1's field-delete already allocates
  the `batch_id` so R2 can group under it.)

## 6. Decisions to ratify (before any build)

- **D1 — table shape.** One `meta_config_revisions` + `entity_type` discriminator. **Recommend: one table.**
- **D2 — before/after = diff** (per §2), not a full snapshot. **Recommend: diff.**
- **D3 — v1 entity set = FIELDS ONLY (R1).** Permissions, views, sheet-config are R2 — they need transaction-ization
  (D6) + the per-type gate (§4) first. (Owner-delegated call: R1 = fields-only for a clean, already-transactional
  first slice; override to fields+field-permissions if you want them together, but then R1 carries the perm-write
  transaction-ization + the `canManageFields` gate.)
- **D4 — retention.** Unbounded vs a bounded window (aligned with the record-revision retention/aging policy).
  **Recommend: reuse the record-revision retention policy.**
- **D5 — read surface = a DEDICATED base/sheet-level config-history view**, NOT folded into the per-record history
  drawer (config history is sheet/base-level, not a single record's). **Recommend: dedicated view (R4).**
- **D6 — recording mode = synchronous, in the mutation transaction.** **Explicit requirement:** a slice recording a
  currently-non-transactional route (views, field-permission write) must transaction-ize it (or use the shared
  in-transaction helper) as part of that slice — recording is not "just append a row" there.
- **D7 — cascade representation.** `batch_id` grouping (recommended, mirrors the record-line batch discipline) vs a
  `parent_revision_id` pointer. **Recommend: `batch_id`.** At minimum, field-delete's view-config cleanup must be an
  explainable record (under R2 once view recording lands; R1 allocates the `batch_id`).

## 7. Gated TODO (read-side slices; each a separate opt-in)

- ⬜ **T9-R0 — ratify** this lock (D1–D7) + opt-in.
- 🔒 **T9-R1 — data model + FIELD recording (fields only):** `meta_config_revisions` (incl. `batch_id`) + the shared
  `recordConfigRevision` helper wired into the EXISTING field `pool.transaction`s (create/update/delete). Diff-first;
  empty-diff records nothing; per-request `batch_id`. Real-DB goldens (create/rename/retype/property/delete append the
  right rows; deterministic order; actor recorded; no record-value column) + a mutation-check (break the recorder →
  a field-create golden fails). **No read API, no gate, no permissions in R1.**
- 🔒 **T9-R2 — permissions + views + sheet-config recording:** FIRST transaction-ize the field-permission write +
  view create/update/delete (or shared helper), THEN record (recording the *changed* perm triple only). Field-delete
  → view-config cascade recorded here under the field-delete's `batch_id` (T9-L7).
- 🔒 **T9-R3 — read API:** config-history list, **per-entity-type config-manage gated** (§4), deterministic order,
  redaction-safe (its OWN gate, NOT the record mask — §2).
- 🔒 **T9-R4 — FE config-history view:** a DEDICATED sheet/base-level timeline (D5), entity-type filter, before→after.
- 🔒 **(separate) T9-W — restore-config** (the WRITE): its own design-lock + owner ratification; OUT of this lock.

## 8. Why read-side first

The history *view* is the high-leverage, low-risk half — net-new (no config history exists today), no destructive
path. The restore-config write is the heavy/risky half (mutating live schema back) and earns its own design-lock
behind a proven read view — the same read-before-write discipline that made the record line safe.
