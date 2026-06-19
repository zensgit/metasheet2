# Multitable Global History & Point-in-Time Restore Center -- Design Lock

Status: DESIGN / OWNER-RATIFY BEFORE RUNTIME. No code changes are authorized by this document. The first implementation PR must start from T1/T4 in the companion TODO only after this design is accepted.

Grounding: drafted on 2026-06-19 against the completed multitable history / restore / trash line on `origin/main` (record history, per-field restore, readable trash titles, actor display names, and rule-deny-aware trash/restore are already shipped). This design intentionally starts a new product arc: a global history center and restore workflow that goes beyond per-record history. **This is the canonical design-lock for the arc:** it converges the earlier draft and **folds in the four locks** (delete-state at T, Revert/Reset semantics, ordering determinism, batch boundary) refined in the now-superseded PR #2949 (closed); no runtime was lost.

## 0. Goal

Build a global multitable history and recovery center that surpasses the external mature-product baseline (capability comparison kept in internal research, per the formal-docs principle) by combining:

- global timeline and filtering across sheets / records / actors / sources;
- batch-level change understanding, not only raw revision rows;
- permission-safe search, totals, and details;
- field-level diff drilldown;
- restore preview before mutation;
- scoped restore of selected records / fields / changes;
- restore-as-forward-revision auditability;
- point-in-time read-only view before any point-in-time rollback.

The north-star user promise:

> A user can understand who changed what, why it changed, how much would be affected by restore, and which parts cannot be restored because of permission, schema, deletion, or conflict rules before any data is changed.

## 1. Baseline And Differentiation

Baseline capability to match:

- filter history by time;
- filter history by operator;
- filter history by data;
- view history details;
- restore a specified historical version.

Acceptance bar for this center:

- batch-level operation grouping;
- actor / source explanation (`manual`, `api`, `automation`, `import`, `ai`, `restore`, `system`);
- visible-only history with no hidden-record, hidden-field, or total-count leak;
- restore preview before mutation;
- selected-record and selected-field restore;
- restore as a forward change that is itself visible in history;
- point-in-time read-only reconstruction before point-in-time restore;
- conflict report for schema drift, deleted records, stale versions, and field write gates.

## 2. Non-Goals For The First Program

- No database engine rewrite.
- No row-capacity target in this arc.
- No formula-engine performance target in this arc.
- No permanent purge UI unless separately approved.
- No silent full-base rollback.
- No config/schema restore in the first runtime slice.
- No direct exposure of raw revision tables as the public API.
- No restore endpoint that bypasses preview for multi-record or multi-field actions.

## 3. Locked Principles

### LOCK-1: History Is A Read Model, Not The Source Of Truth

The canonical sources remain the existing record revisions, trash records, field metadata, permission rules, and operation provenance. This center may build a queryable projection over those sources, but it must not introduce a parallel write primitive or bypass the existing restore/write gates.

### LOCK-2: Batch Is The Primary UX Unit

The global timeline shows operation batches first, not individual field cells. A batch groups changes produced by one user/API/automation/import/AI/restore/system action.

A batch can contain:

- record creates;
- record updates;
- record deletes;
- record restores / undeletes;
- field-level value sets / unsets;
- link sync changes;
- later slices: config/view/permission changes.

### LOCK-3: Permission Filtering Applies Before Counts, Search, And Detail

A user must not infer denied records or hidden fields from:

- event count;
- total count;
- search result count;
- filter option presence;
- field names;
- diff payloads;
- restore preview conflicts;
- missing-vs-forbidden response shape.

Rule-denied records are invisible unless the route has an explicit admin-bypass contract. Field-hidden / field-read-denied values never appear in history detail or restore preview.

### LOCK-4: Restore Is Always Forward-Writing

Restore never rewinds storage in place. It creates new revisions / changes that appear in the history center and can themselves be understood and, where applicable, undone by a later restore.

### LOCK-5: Multi-Record Or Multi-Field Restore Requires Preview

Batch restore and point-in-time restore require a dry-run preview first. The preview must be permission-filtered and must report:

- affected records;
- affected fields;
- denied records / fields;
- missing or deleted targets;
- schema drift;
- field write conflicts;
- expected-version conflicts;
- link / formula side effects that will be recomputed or rejected.

Runtime restore must require a preview token or equivalent server-verifiable preview identity. A client must not be able to skip preview for the high-risk restore modes.

### LOCK-6: Point-In-Time View Comes Before Point-In-Time Restore

The first point-in-time feature is a read-only reconstruction: "show the table as of time T" for visible data. Full restore-to-time is deferred until read-only reconstruction is proven under permissions, pagination, deleted records, and schema drift.

### LOCK-7: Config History Is Separate From Data History

Record data history ships first. Field/schema/view/permission history may be captured and displayed later, but restore of config changes is a separate product decision and must not be mixed with data restore in the first runtime slices.

### LOCK-8: Source Attribution Is Part Of The Product Contract

Every batch should carry enough provenance to answer "why did this happen?":

- actor id and display name snapshot when available;
- source kind;
- request / trace id when available;
- automation / import / AI action id when available;
- source batch id for restore-created batches.

Missing provenance must degrade gracefully, not block history display.

### LOCK-9: Point-In-Time Reconstruction Excludes Deleted Records (folded from #2949)

A record's state at time T is the latest revision with `created_at <= T` (deterministic order per LOCK-11). **If that latest revision is `action='delete'`, the record does NOT exist at T and must be excluded from the reconstruction** — a delete revision stores the *pre-delete* snapshot, so a naive "latest snapshot" would resurrect deleted records and poison both the point-in-time view and any Revert/Reset baseline. Only when the latest `<= T` revision is `create`/`update` is its snapshot the record's value at T.

### LOCK-10: Restore Delete-Semantics Are Named; The Destructive Mode Is All-Or-Nothing (folded from #2949)

Restore-to-T distinguishes two modes, never silently:

- **Revert-to-T (default, non-destructive):** revert post-T changes, undelete post-T deletions; **records created after T are kept** (flagged in preview). Result = "data as of T, plus anything new since." Zero data loss.
- **Reset-to-T (explicit, destructive, admin-gated):** the above **plus delete records created after T** -> the table exactly as of T. Requires a full dry-run enumerating every delete/update/undelete.

Both go preview -> confirm -> single atomic txn -> forward revisions. **Reset additionally requires a full all-or-nothing permission preflight:** every record/field to be deleted/updated/undeleted is permission-checked in the dry-run, and **any failure blocks the entire Reset** (no partial skip, no fail-halfway). Revert may partial-skip; Reset's destructiveness forces all-or-nothing.

### LOCK-11: Revision Ordering Is Deterministic; The Existing Table Has No `sequence` (folded from #2949)

- **New projection tables** (`history_batches`/`history_changes`) order by their **monotonic `id`** (bigserial) -- that `id` *is* the replay order.
- **The existing `meta_record_revisions` has a `uuid` PK and NO `sequence` column.** Any reader (latest-<=T, replay) MUST order by **`created_at DESC, version DESC, id DESC`** as the deterministic fallback and MUST NOT assume a `sequence`/monotonic column. A strict same-millisecond causal order on that table would need its own migration to add a sequence -- do not assume it exists in P1.

### LOCK-12: A Batch Is One User Action, Bounded By Request/Trace/Transaction Provenance (folded from #2949 + Sec.5 risk)

A history batch (LOCK-2) groups exactly the changes produced by **one** user/API/automation/import/AI/restore/system action, bounded by a stable **request id / trace id / transaction / provenance** key. Batch grouping must not **split** one user action into misleading many batches, nor **merge** unrelated actions into one. Where no reliable boundary key exists, fall back to a conservative single-actor + time-window heuristic AND mark the provenance quality (never present a synthetic boundary as authoritative).

## 4. Proposed Read Model

The exact migration shape is a later implementation decision, but the design assumes an append-only projection with two logical layers.

### `history_batches`

- `id`
- `base_id`
- `sheet_id` nullable
- `actor_id` nullable
- `actor_name_snapshot` nullable
- `source`: `manual | api | automation | import | ai | restore | system`
- `action`: `create | update | delete | restore | bulk_update | config_change`
- `created_at`
- `affected_record_count`
- `affected_field_count`
- `trace_id` nullable
- `request_id` nullable
- `metadata jsonb`

### `history_changes`

- `id`
- `batch_id`
- `sheet_id`
- `record_id`
- `field_id` nullable
- `change_kind`: `value_set | value_unset | record_create | record_delete | record_restore | link_sync | config_change`
- `before jsonb` nullable
- `after jsonb` nullable
- `before_version` nullable
- `after_version` nullable
- `field_type_snapshot` nullable
- `created_at`

The public API must return permission-filtered projections of these rows, not raw internal rows.

## 5. API Shape

### `GET /api/multitable/bases/:baseId/history/events`

Query:

- `sheetId?`
- `actorId?`
- `source?`
- `action?`
- `from?`
- `to?`
- `recordQuery?`
- `fieldIds?`
- `limit`
- `cursor`

Returns permission-filtered batch summaries. Totals and cursors must be computed after permission filtering.

### `GET /api/multitable/history/events/:batchId`

Returns:

- batch summary;
- grouped records;
- grouped field diffs;
- visible-only detail;
- source explanation when available.

Denied and missing batches must share the same not-found shape unless an admin-bypass contract explicitly applies.

### `POST /api/multitable/history/restore-preview`

Body:

- `batchId?`
- `targetTime?`
- `sheetId?`
- `recordIds?`
- `fieldIds?`
- `changeIds?`
- `mode: batch | point_in_time | selected_changes`

Returns:

- allowed changes;
- denied changes;
- conflicts;
- schema drift;
- expected effects;
- preview token / identity.

### `POST /api/multitable/history/restore`

Requires a preview token or equivalent server-verifiable preview identity. Creates forward revisions only. Restore-created batches must link back to the source batch / target time where applicable.

## 6. UI Shape

### Global History Center

Entry point: multitable toolbar / more menu. The first screen is a timeline of batches with dense filters:

- time range;
- actor;
- source;
- action;
- sheet;
- visible record title / data search;
- field.

### Batch Detail

Batch detail shows:

- action summary;
- actor and source;
- affected record count;
- affected field count;
- grouped record list;
- field-level before/after diffs;
- hidden/denied items summarized only when doing so does not leak existence.

### Restore Flow

Restore is a three-step flow for multi-record or multi-field actions:

1. choose scope;
2. preview effects and conflicts;
3. confirm and execute.

The confirm screen must name the scope in human terms and must not rely on raw record ids when a visible title exists.

## 7. Verification Strategy

Every runtime slice must include real-DB security goldens for:

- hidden record is absent from list and total;
- hidden field is absent from filters, detail, and preview;
- denied vs missing batch detail has the same external shape;
- admin-bypass works only where explicitly allowed;
- restore preview writes nothing;
- restore execution requires preview identity;
- restore creates a forward batch / revision;
- restore event is visible as `source=restore`.

Frontend tests are not sufficient for permission claims. UI slices need component tests for behavior and at least one route/integration proof for API contract and masking.

## 8. Open Decisions Before Runtime

These decisions must be ratified before the first runtime slice:

1. Is `history_batches` materialized at write time, backfilled from revisions, or initially projected from revisions on read?
2. Is the first MVP scoped to one base, one sheet, or all sheets inside a base?
3. Which sources are in the first source enum: manual/API/import/automation/AI/restore/system, or a smaller subset?
4. What is the retention promise for the global history read model?
5. Should restore preview tokens be persisted rows, signed payloads, or short-lived cache entries?
6. What is the maximum batch restore size before requiring async execution?
7. Are config/view changes captured in the first projection but hidden from UI, or fully deferred?

## 9. First Program Recommendation

Start with read-only confidence before mutation:

1. T0 design-lock ratification.
2. T1 batch projection.
3. T4 permission-safe query hardening.
4. T2 global history center read-only UI.
5. T3 batch detail.
6. T5 restore preview.
7. T6 scoped restore.
8. T7 point-in-time read-only view.
9. T8 point-in-time restore.
10. T9 config history.

The smallest useful release is T1 + T4 + T2 + T3: a read-only, permission-safe global history center with batch detail. Restore should not ship until preview exists.
