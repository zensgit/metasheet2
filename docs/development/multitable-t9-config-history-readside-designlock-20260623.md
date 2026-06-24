# T9 — Config / Schema-Change History (READ-SIDE) — DESIGN-LOCK

> Status: **DESIGN-LOCK, docs-only. Read-side runtime GATED behind ratification of §6 (D1–D6) + an explicit owner
> opt-in per slice.** The next arc after the record-restore line (selected via the next-arc audit). This locks the
> READ half only — **record + display** the change history of config/schema entities. **Restore-config (mutating
> config back to a prior state) is explicitly OUT of this lock** — it is the write half (T9-W), deferred behind the
> read view + its own design-lock, exactly as the record line did read (T5/T7) before write (BS-1..BS-3).

## 1. Scope — what the read-side records + displays

A per-sheet (and where relevant per-base) **append-only history of CONFIG/SCHEMA changes**, parallel to the record
data history (`meta_record_revisions`) but for structure rather than record values:

- **Fields** — create / delete / rename / retype / property change (link config, formula expression, options,
  rollup/lookup config, read-only, hidden).
- **Views** — create / delete / config change (filters, sorts, groups, hidden fields, view type, frozen columns).
- **Permissions** — `field_permissions` changes, row-level deny / conditional-read-rule changes, view permissions,
  sheet access / role changes.
- **Sheet / base config** — name, settings (retention, row-deny-enabled, and similar sheet-level toggles).

Each entry answers: **what config entity changed, how (before→after), when, by whom.** READ-ONLY surfacing — a
timeline the actor can view; no action that mutates config.

**NOT in scope:** restore-config (T9-W, deferred) · record DATA history (the record line owns it) · destructive
table-level PIT (T8) · the general compliance `audit_logs` (separate concern — security/regulation, not a
user-facing config timeline).

## 2. Data model (parallels meta_record_revisions)

A new append-only table, e.g. `meta_config_revisions`: `{ id, sheet_id, base_id?, entity_type, entity_id, action,
before, after, changed_field_keys, changed_by, created_at }`.
- `entity_type` ∈ { field, view, permission, sheet_config } (a fixed, extensible discriminator — T9-R2).
- `before` / `after` carry the config diff (changed keys + values needed to display), NOT a full clone where a diff
  suffices (D2).
- One row per config mutation, appended **in the same transaction** as the mutation (D6) so the history can never
  diverge from the live config.

## 3. Recording (the capture half of "record + display")

Every config-mutation chokepoint appends a `meta_config_revisions` row: `createField` / `updateField` /
`deleteField`, `createView` / `updateView` / `deleteView`, the `field_permissions` + row-deny/conditional-rule
writes, and the sheet-config writes. Recording is an append to the history table — it is **not** restore (it never
mutates config). This is the only write the read-side introduces, and it is forward-only (T9-R4).

## 4. Security model

- **Config-manage gate (T9-R3):** config-history visibility is gated per entity type on the relevant manage
  capability the actor already needs to *see* that config — field history → `canManageFields`, view history →
  `canManageViews`, permission history → `canManageSheetAccess`/permission-manage, sheet-config → sheet-admin. Never
  admin-bypassed silently. (An actor who can see the current config can see how it changed; one who cannot, cannot.)
- **No record-value leakage (T9-R5):** config history surfaces STRUCTURE/config only (field types, view configs,
  permission rules, formula expressions = config). It never carries record DATA values; a config change that
  references a value (e.g. a default, a conditional-rule threshold) shows the *config*, not record data. The record
  line + its masking stay the sole surface for record values.
- **Permission-change history is itself permission-gated:** a permission change reveals a denied subject — only an
  actor who can manage permissions (and thus already sees the current denies) may view its history.

## 5. Locks (T9-R*)

- **T9-R1 — READ-ONLY.** The read-side records + displays; it NEVER restores. Restore-config is T9-W, a separate
  gated slice with its own design-lock. (The tripwire: any code path that *writes config back to a prior revision*
  is T9-W, out of this lock.)
- **T9-R2 — fixed entity-type taxonomy** (field / view / permission / sheet_config), extended only by an explicit
  slice, never ad-hoc.
- **T9-R3 — config-manage gate**, per entity type; not admin-bypassed.
- **T9-R4 — append-only recording** at the mutation chokepoints, in-transaction; forward-only (a config change is
  never edited/deleted from history).
- **T9-R5 — config-only, no record-value leakage.**
- **T9-R6 — deterministic order** (created_at DESC, id DESC tiebreak) + a retention decision (D4).

## 6. Decisions to ratify (before any build)

- **D1 — table shape.** One `meta_config_revisions` with an `entity_type` discriminator (recommended) vs per-type
  tables. Recommend: one table.
- **D2 — before/after representation.** Diff (changed keys + display values) vs full snapshot. Recommend: diff,
  mirroring the record value-diff.
- **D3 — v1 entity set.** Recommend: **fields first** (highest-value schema history) + permissions; views +
  sheet-config follow as slices.
- **D4 — retention.** Unbounded vs a bounded retention window (aligned with the record-revision retention/aging
  policy). Recommend: reuse the record-revision retention policy.
- **D5 — read API + UI shape.** A config-history timeline (per-sheet, filterable by entity type), and whether it
  lives in a sheet-admin surface vs the existing history drawer. Recommend: a sheet-level config-history view.
- **D6 — recording mode.** Synchronous in the mutation transaction (recommended, consistent with
  `meta_record_revisions`) vs async event.

## 7. Gated TODO (read-side slices; each a separate opt-in)

- ⬜ **T9-R0 — ratify** this lock (D1–D6) + opt-in.
- 🔒 **T9-R1 — data model + FIELD recording**: `meta_config_revisions` + append at the field mutation chokepoints.
  Contract + in-transaction recording + goldens (a field create/rename/retype/delete appends the right rows).
- 🔒 **T9-R2 — extend recording** to views + permissions + sheet-config.
- 🔒 **T9-R3 — read API**: config-history list, config-manage gated, deterministic order, redaction-safe.
- 🔒 **T9-R4 — FE config-history view**: timeline, entity-type filter, before→after display.
- 🔒 **(separate) T9-W — restore-config** (the WRITE): its own design-lock + owner ratification; OUT of this lock.

## 8. Why read-side first

The history *view* is the high-leverage, low-risk half — it is net-new (no config history exists today) and carries
no destructive path. The restore-config write is the heavy/risky half (mutating live schema back), and it earns its
own design-lock behind a proven read view — the same read-before-write discipline that made the record line safe.
