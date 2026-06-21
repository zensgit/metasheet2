# Multitable Global History — T9 Config History (DESIGN-LOCK)

> Status: **DESIGN-LOCK, docs-only. OWNER-GATED — a SEPARATE program after data history, not part of the
> data-restore line (T5–T8).** Runtime requires its own ratification + opt-in.
> Basis: the canonical global-history design-lock (which scopes T9 as "track and display schema/view/config
> changes", explicitly separate from data history, no mixed config+data restore until separately designed).

## 1. Problem + the hard boundary

Data history (T1–T8) tracks RECORD changes (`meta_record_revisions`). T9 tracks CONFIG changes — the schema and
settings around the data: field create/delete/rename/type-change, view filter/sort/group changes, permission
rule changes, (later) automation config. These are a DIFFERENT change stream with different semantics, blast
radius, and restore model.

**The hard boundary (load-bearing):** config history is SEPARATE from data history, and **config restore is
separate from data restore — there is NO mixed config+data restore until it is explicitly, separately designed.**
Restoring a field's old type while the data has moved on, or restoring a permission rule mid-flight, is a
different and more dangerous operation than restoring a record value; conflating them is the failure mode this
lock forbids.

## 2. Locks (T9; CH-* are config-history-specific)

- **CH-1 — Separate stream, separate store.** Config changes are recorded in their own append-only log (e.g.
  `meta_config_revisions` — entity_type ∈ {field, view, permission, …}, entity_id, action, before/after config
  snapshot, actor, source, created_at), NOT in `meta_record_revisions`. Data-history projections never read it
  and vice versa.
- **CH-2 — Read-only first.** The first T9 release is a config-history VIEW (who changed which field/view/rule,
  when, before→after) — no config restore. Restore is a later, separately-designed slice (CH boundary).
- **CH-3 — Permission-gated display.** Config detail is visible only to authorized users (the people who can
  manage schema/permissions for that base/sheet) — a config-change log is itself sensitive (it reveals the
  permission structure). Denied users see nothing; same LOCK-3 no-existence-oracle discipline.
- **CH-4 — No config value leak via the log.** A permission-rule change log must not become a side channel that
  reveals field values or restricted scopes; it records the CONFIG delta (rule shape), redacted of any embedded
  secrets/values, same redaction discipline as the audit logs.
- **CH-5 — Config restore (if ever) is its own design-lock.** No mixed config+data restore; a field-type revert
  with live data of the new type is a conflict that needs explicit semantics (block / coerce / refuse). Deferred.

## 3. Why this is gated + separate

T9 has no dependency on the T5–T8 data-restore line and a much larger design surface (every config-bearing
entity has its own change semantics). Building it as part of the data-history /goal would conflate two programs.
It is captured here so the program is fully PLANNED, and held for its own opt-in.

## 4. Test plan (when built, read-only first)

Real-DB: a field create/rename/type-change is captured as a config revision; a view filter/sort/group change is
captured; a permission-rule change is captured; config detail is visible only to authorized users (denied → not
found shape, CH-3); the log carries no field values / secrets (CH-4). No restore tests until a separate config-
restore design exists (CH-5).

## 5. Decisions to ratify (before any T9 build)

- **D1 — Which config entities in v1?** Recommend: **fields + views** first (highest-value, clearest semantics);
  permission rules + automation config as later slices.
- **D2 — Capture mechanism.** A chokepoint at the config-write paths (field/view CRUD) writing `meta_config_
  revisions`, mirroring the `recordRecordRevision` chokepoint. Recommend: yes, one chokepoint per entity family.
- **D3 — Who may view config history.** The base/sheet schema-admin (`canManageFields` / the structure
  managers). Recommend: gate on the manage capability for that entity.

## 6. Gated TODO

- ⬜ **T9-0 — ratify** this doc (D1–D3) + a SEPARATE opt-in (this is a new program, not a continuation of T5–T8).
- 🔒 **T9-1 — `meta_config_revisions` + capture chokepoint** for the v1 entities (D1). Real-DB goldens.
- 🔒 **T9-2 — config-history read-only view** (permission-gated, CH-3/CH-4). Goldens + browser evidence.
- 🔒 **T9-3+ — config restore** — its OWN design-lock first (CH-5); not part of T9 v1.

## 7. Out of scope / anti-goals

Any config RESTORE in v1 (CH-2/CH-5); mixed config+data restore (CH-5); recording config in
`meta_record_revisions` (CH-1); an ungated config-history surface (CH-3).
