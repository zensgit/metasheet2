# Multitable Global History & Point-in-Time Restore Center -- TODO

Status: PLANNED / GATED. This TODO depends on `multitable-global-history-pit-restore-design-lock-20260619.md`. Runtime work is not authorized until the design-lock open decisions are ratified.

Grounding: created on 2026-06-19 after the multitable history / restore / trash line reached product-grade UX. This document is the implementation queue for the next arc: a global, permission-safe history center + point-in-time restore. (Canonical; converges the earlier draft + folds PR #2949's locks.)

## 0. Success Definition

The arc is complete when users can:

- open a global multitable history center;
- filter changes by time, actor, source, action, sheet, field, and visible record data;
- inspect a batch-level summary and field-level diff detail;
- trust that denied records and hidden fields do not leak through list, count, filters, detail, or preview;
- preview multi-record / multi-field restore before any mutation;
- restore a selected batch / record / field scope as a forward change;
- view a table as of time T in read-only mode before any point-in-time rollback feature is opened.

## 1. Slice Plan

### T0 - Design Lock Ratification

Status: TODO.

Deliverables:

- ratified design-lock;
- resolved open decisions from section 8 of the design doc;
- first-slice data model decision;
- explicit MVP boundary.

Verification:

- review only;
- no runtime diff;
- grep that no feature flag / API route / migration was introduced in T0.

### T1 - History Batch Projection

Status: TODO, blocked on T0.

Goal: create a queryable batch/change projection from existing write and revision paths.

Scope:

- record create;
- record update;
- record delete;
- record restore / undelete;
- per-field value set / unset;
- actor id and actor display name snapshot when available;
- source kind;
- source batch id for restore-created batches.

Out of scope:

- config history;
- restore UI;
- point-in-time reconstruction;
- purge / retention UI.

Tests:

- real-DB create creates one batch and one or more changes;
- real-DB update creates one batch with changed field ids;
- real-DB delete creates a delete batch;
- real-DB restore creates a restore batch linked to the source;
- bulk update creates one batch with many changes, not many unrelated batches;
- actor/source metadata preserved;
- tsc clean.

### T2 - Global History Center Read-Only UI

Status: split. **T2a SHIPPED (#2961); T2b FOLLOW-UP (read-only, in MVP envelope, not gated, not yet built).**
The original single T2 scope over-stated what shipped; this split records the actual line.

Goal: add a global history center entry and timeline UI.

Scope — T2a (SHIPPED, #2961):

- toolbar / more-menu entry (🕰);
- timeline list of batches;
- filters for actor, action, source;
- expandable per-batch detail (the T3 drilldown);
- empty, loading, error states.

Scope — T2b (FOLLOW-UP, read-only, NOT yet built — each a small slice, not gated):

- time-range (from/to) + sheet + field filters in the FE — backend already accepts `from`/`to`/`sheetId` (the FE just doesn't wire them); a **field** filter needs a new backend param;
- search by visible record title / data — needs a new backend data-search param (a separate slice);
- cursor pagination — the current backend is `offset`/`limit`; a cursor needs a new backend param.

Out of scope:

- restore;
- point-in-time view;
- config history restore.

Tests:

- component render for list, filters, empty, error;
- client contract test for query params;
- no raw record ids when a visible title exists;
- actor display name fallback;
- vue-tsc clean;
- browser Path A screenshot for dense timeline layout.

### T3 - Batch Detail And Diff Drilldown

Status: TODO, blocked on T1 + T4.

Goal: users can understand what one batch changed.

Scope:

- open batch detail from timeline;
- show actor/source/time;
- show affected record count and field count;
- group changes by record;
- show before/after field diffs;
- link to visible record drawer;
- show restore-created batch back-reference.

Tests:

- hidden fields are not rendered;
- denied records are not rendered;
- totals match visible records only;
- deleted-record changes show readable title when available;
- no raw JSON dumps for common scalar/link/person values;
- FE component tests + real-route API tests.

### T4 - Permission-Safe Query Hardening

Status: row layer SHIPPED in #2961; **field layer was MISSING there (the "hidden fields absent" locks + their
goldens below were specified but not implemented — #2961 shipped only the row-level goldens yet claimed LOCK-3
done). Field layer + the two field-mask goldens landed in the 2026-06-20 review-fix PR (see the MVP verification
MD §0).** Both layers now done; mutation-checked.

Goal: history queries cannot become a side channel.

Required locks:

- denied records absent from list;
- denied records absent from total;
- hidden fields absent from filters;
- hidden fields absent from detail;
- hidden fields absent from preview;
- missing and denied batch detail share not-found shape;
- admin bypass is explicit and tested;
- flag-off behavior is inert.

Tests:

- real-DB rule-denied record invisible from list and total;
- real-DB hidden field changed but not visible in field filters or detail;
- real-DB hidden-field-only batch does not leak through counts;
- same external response for missing vs denied detail;
- admin can see a rule-denied batch only where bypass is intentionally supported;
- real-DB allowlist / CI step confirms the file actually runs.

### T5 - Restore Preview

Status: TODO, blocked on T3 + T4.

Goal: dry-run restore without mutation.

Scope:

- preview a batch restore;
- preview selected records;
- preview selected fields;
- preview selected changes;
- accept `strategy: revert | reset` (default revert) and run that strategy's logic;
- report denied changes;
- report schema drift;
- report missing/deleted targets;
- report expected-version conflicts;
- report link/formula side effects where applicable;
- return preview token / identity.

Tests:

- preview writes nothing;
- preview excludes denied records from allowed changes;
- preview excludes hidden fields;
- preview reports field write conflicts;
- preview reports schema drift;
- preview token cannot be forged trivially;
- same-shape missing/denied where required;
- revert preview keeps post-T-created records;
- reset preview lists post-T-created records as delete candidates;
- reset: any delete/update/undelete permission failure blocks the entire preview/execute (all-or-nothing, no partial skip);
- preview token binds strategy — a revert preview token cannot execute reset (and vice versa);
- API returns visibleAffected{Record,Field}Count (post-filter), never the raw stored count.

### T6 - Scoped Restore

Status: TODO, blocked on T5.

Goal: execute restore for a selected safe scope.

Modes:

- restore selected record changes from a batch;
- restore selected fields;
- restore selected change ids;
- restore a permission-filtered batch subset.

Rules:

- preview identity required;
- restore writes forward revisions;
- restore creates a `source=restore` batch;
- per-field write gates apply;
- current rule-deny gates apply;
- restore event links back to source batch.

Tests:

- selected-field restore;
- partial-batch restore;
- hidden field cannot be restored;
- denied record cannot be restored;
- restore event appears in history;
- restore itself is inspectable in batch detail;
- restore can be followed by another restore without corrupting history.

### T7 - Point-In-Time Read-Only View

Status: TODO, blocked on T1/T4/T3 maturity.

Goal: open the table as of time T in read-only mode.

Scope:

- reconstruct visible records as of T;
- page large results;
- field masks apply;
- rule-denied records invisible;
- deleted records handled per LOCK-9 (latest <=T is delete => record absent at T);
- no editing.

Out of scope:

- one-click full table rollback;
- config/schema reconstruction unless T9 has landed.

Tests:

- record value at T reconstructed;
- later changes absent;
- hidden field masked;
- rule-denied record invisible;
- total count does not leak denied records;
- deleted-record policy tested;
- large-table pagination contract.

### T8 - Point-In-Time Restore

Status: OWNER-GATED, blocked on T7 and a new restore-specific ratification.

Goal: restore a sheet or subset to time T.

Prerequisites:

- point-in-time read-only view proven;
- restore preview proven;
- async limit / max size decided;
- owner ratifies rollback semantics.

Tests:

- full-sheet dry-run;
- subset dry-run;
- conflict handling;
- forward revisions created;
- restore batch created;
- no count/existence leaks;
- rollback can itself be understood in history.

### T9 - Config History

Status: OWNER-GATED, separate program after data history.

Goal: track and display schema/view/config changes.

Potential scope:

- field create/delete/rename/type-change;
- view filter/sort/group changes;
- permission rule changes;
- automation config changes later.

Restore:

- config restore is separate from data restore;
- no mixed config+data restore until explicitly designed.

Tests:

- schema change capture;
- view change capture;
- permission change capture;
- config detail visible to authorized users only;
- no restore until separate restore design exists.

## 2. Recommended MVP

MVP should be read-only:

1. T0 design-lock.
2. T1 batch projection.
3. T4 permission-safe query hardening.
4. T2 global timeline UI.
5. T3 batch detail.

Do not ship T6 restore before T5 preview exists.
Do not ship T8 point-in-time restore as part of the MVP. The first release must prove list/detail/query safety before any global rollback surface opens.

## 3. CI And Verification Rules

- Permission claims require real-DB tests, not only service mocks.
- API route contracts require route-level tests.
- Frontend-only tests may verify rendering, filters, and event wiring, but not permission safety.
- Any new real-DB test file must be added to the explicit multitable CI allowlist if the workflow uses one.
- Browser evidence is required for the global history center timeline before calling the UI slice complete.
- Each slice must include a "what is not covered" note in its PR.

## 4. Product Gates

The following require explicit owner opt-in:

- enabling batch restore beyond selected record/field restore;
- point-in-time restore;
- config restore;
- permanent purge UI;
- retention policy UI;
- async restore execution limits;
- exposing history to non-editors;
- cross-base history search.

## 5. Risks To Re-Review On Every Slice

- Count leaks through totals, filters, or pagination.
- Hidden field names leak through filter facets.
- Denied records leak through batch-level affected counts.
- Restore preview reveals more than the actor can write.
- Restore writes around current field permissions.
- Batch grouping accidentally splits one user action into misleading many actions.
- Backfill makes old revisions look like current-source events without marking provenance quality.
- Point-in-time view silently reconstructs config with today's schema.

## 6. Done Definition

The full Global History & Point-in-Time Restore arc is done only when:

- read-only global history is shipped and browser-verified;
- batch detail is permission-safe and real-DB-verified;
- restore preview is mandatory for scoped restore;
- scoped restore writes forward revisions and creates history batches;
- point-in-time read-only view works under permissions;
- docs distinguish shipped runtime from owner-gated point-in-time/config restore tails.
