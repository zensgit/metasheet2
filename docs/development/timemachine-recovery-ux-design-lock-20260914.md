# Time Machine Recovery UX

## Authority and Baseline

Owner requested implementation of the three prioritized recovery UX improvements
on 2026-09-14. Base main: `c13e40769690a4ed51b3f3a7ac2f8026638f3e88`.
The previously verified configuration-history presentation at Draft #5704
(`e92e462b84e74aa242382c2f31eab326ceb60854`) is preserved by true merge.
This is a Draft-only development window: no Ready, merge, runtime flag change,
deployment, production or real customer data.

## Contract

### Full Workbench Acceptance

The separate manual script
`packages/core-backend/scripts/verify-timemachine-workbench.mts` must start the
standard `MetaSheetServer`, the real Web Vite config and `index.html`/`src/main.ts`,
and enter `MultitableWorkbench` through `LoginView` and its actual router. No
component harness, synthetic JWT, fulfilled API interception or customer endpoint
may substitute for that path. Permit only the owned loopback database/API/Web
ports; browser request failures, non-success API responses and page errors fail
the gate. Configuration comes from a generated empty file and a scrubbed process
environment; plugins and optional external schedulers remain disabled.
Before creating the application or any fixture, require database ownership by the
connected role, no other database sessions and empty user/recovery data families;
only the migration-created unowned `base_legacy` base is allowed.

Perform retained-table deletion/recovery through navigation and the recycle bin,
record deletion/recovery through the grid and History, and column deletion/recovery
through Fields and Configuration History. Require independent database equality,
explicit restore confirmation, readable deletion details/actor/viewer-local time,
and a refreshed visible grid. A disabled restore-refresh event must make the
restored-row visibility assertion fail even if the database write succeeded.

Cleanup must close the browser, Vite, server/pool and its process-local guard and
messaging singletons, then exit naturally. Census all owned base/sheet/field/row/
view/session/user/revision/trash/tombstone families and independently drop the
dedicated database. Attempt every cleanup even when a sibling fails and fail the
run on any cleanup error. Invalidate old PASS evidence to a new RUNNING run id at
entry; publish PASS only after the full run and all cleanup pass. This is desktop synthetic acceptance, not a production
shutdown, archive-provider, mobile, tenant-UAT or enablement claim. It supplements,
not replaces, the negative and second-deletion-cycle component gates below.

### Authenticated Browser Acceptance

The manual harness `packages/core-backend/scripts/verify-timemachine-browser.mts`
must use canonical password login, persisted sessions, JWT middleware, the real
multitable router/client, `SheetTrashModal`, `HistoryCenterModal` and `MetaConfigHistoryModal`. No injected request user, minted
fixture token, intercepted API or fake restore result qualifies. Use a dedicated
loopback PostgreSQL test database; refuse general/shared database names and ports.
Compare retained field, record and view rows independently in PostgreSQL; a UI
success message alone is insufficient. Deny reader and anonymous restores while
the table is still deleted. Assert viewer-local time, close servers and pools,
and prove fixture/session cleanup. For records, delete through the canonical
client, select the resulting history entry, then restore its current tombstone
through the real confirmation. Independently compare the complete stored row
data/identity/timestamps and its untouched peer; reader/anonymous restores must
leave the tombstone unchanged.

For configuration history, delete a column through the canonical client, preview
the actual persisted delete revision, and execute through typed confirmation.
Test two consecutive deletions of the same field: captured values are restored
even with capture now disabled, while an uncaptured later deletion restores only
the definition and cannot reuse earlier tombstones. Compare field identity,
type/property/order, both records, an untouched field, trailing-field order and
view-reference cleanup. Restore must not silently re-add removed view references.
Verify the actual actor on configuration and value-restoration audit records.
With a valid preview token, the server must still refuse a disabled execute gate,
wrong/missing confirmation, authenticated reader and anonymous requests without
writes. Configuration flags may be enabled only inside the isolated test process
and must be restored in finally. Explicit cleanup includes config revisions and
value/link tombstones, which do not all cascade from the sheet.

Code `e8cadc2989b38d9d36975d22ff7451dbe2d3843a` supplies this manual
component-to-real-backend acceptance; see the exact-head verification section.
It is not a claim that full-workbench navigation, archive worker, staging or
production has passed. No new recovery authority is added.

### Product Behavior

1. Recycle bin lists soft-deleted sheets in the selected base, including name and
   deletion time. Listing admits only the same sheet lifecycle authority as the
   existing restore route. Hidden sheets and their counts must not leak. Restore
   uses the existing sheet endpoint and refreshes navigation, including an empty
   base after its last sheet was deleted. No permanent deletion is added.
2. Record history owns deleted-record recovery. A deleted history item selects a
   record ID, reloads the CURRENT server deleted-record list, and opens an explicit
   confirmation with its currently authorized visible details. Historical
   `before` is display evidence, never a synthetic recovery snapshot. Confirmation
   calls the existing deleted-record endpoint, not live version restore.
   Current server authority, read-deny, ID collision and missing-snapshot refusals
   remain authoritative; failures never appear as successful recovery.
3. The deleted-record list remains available from History, labeled as deleted
   records rather than a sheet recycle bin, so records remain recoverable even
   when the older history batch is unavailable. Preserve all existing masking.
4. Configuration history continues to handle columns/views/permissions through
   its existing preview and execute path. A saved definition is not a promise of
   saved cell values. Preserve server undelete/tombstone gates and show its scope
   note; never enable flags or manufacture missing historical values.
5. Deletion details use the historical before-side, visible field names and values;
   fallback identifiers remain honest when authorized metadata is unavailable.
   Canonical delete revisions may stamp no changed fields. The read projection
   unions existing ids with object-snapshot keys, then applies the existing
   field allow-set to details, names, counts and field filters in exact/estimate
   lists. It does not rewrite revisions or invent values when snapshots are
   missing. A delete's retained wire `after` snapshot is not a surviving value;
   the UI displays its values before-only.
   All recovery UI must handle loading, empty, error, cancellation and scope change
   without applying a stale response to a newly selected base or sheet.
6. Timestamps are stored and returned as before; these three surfaces format time
   using the viewer's browser timezone and selected UI locale. No hard-coded
   server/Taipei timezone or new account timezone setting is introduced. Actor
   display uses server-supplied names when present, with honest ID fallback.

## Authority and Pagination

- The only new backend route is `GET /api/multitable/bases/:baseId/trash`.
  It is read-only; existing table, record and config restore writers are reused.
- Require authenticated read plus sheet lifecycle authority. Base ownership alone
  and record-write permission alone do not grant lifecycle access. Preserve the
  shared resolver's user > member-group > role precedence and explicit read deny.
- Apply permission/protected-sheet filtering BEFORE LIMIT. No hidden count or
  cursor is emitted. Exclude system/People/plugin-managed projections. SQL
  permission/People marker normalization exactly matches ECMAScript trim,
  including BOM/NBSP and not treating NEL as ECMAScript whitespace.
- Read in one repeatable-read transaction and recheck selected/lookahead rows
  using the shared resolver. Use a base-bound canonical opaque ID cursor,
  default page size 20, maximum 100, and no total count.
- Current deleted records remain paginated; selecting a historical record searches
  current pages until found or exhausted. A missing/currently restored record is
  not silently re-created. Client and modal validate explicit restore identity.
- Serialize page loading with restore confirmation and ignore replies from closed,
  reopened or switched-scope dialogs. A failed next-page request preserves loaded
  rows and can retry its cursor.

## Boundaries

This adds a UI for existing soft-deleted-table recovery, not recovery of permanently
purged/hard-deleted tables. It does not introduce a new backup/archive store,
arbitrary live-record rollback, bulk restore, retention policy or purge operation.
Restoring a table exposes only what was retained with that table. Restoring a
deleted column remains the existing guarded config-undelete operation; missing
field tombstones/cell history and disabled capabilities stay explicit refusals.

OpenAPI documents the new list and existing table restore endpoint using official
generation. Shared frontend selectors take a strict union; no backend workflow,
provenance pin, migration, package dependency or runtime flag changes are needed.

## Verification

### Request Lifetimes

Configuration-history list requests belong to the open dialog's captured base,
sheet and request generation. Filtering starts a new generation; closing, changing
scope or unmounting invalidates the old one, including a switch away and back.
An obsolete success or error must not replace rows or finish a newer spinner.

Record-history list/page, expanded detail and deep-linked pin use independent
generations. Pages retain their original filter/cursor snapshot. A list reload
invalidates expanded detail; collapsing, closing and unmounting invalidate pending
detail. Changing only the deep-linked batch must not reload the list or collapse
an unrelated expanded row. Every asynchronous success, catch and finally may
update only its current generation. This changes presentation request ownership,
not the permission-filtered backend or any restore write authority.

### Gates

- Red-first focused frontend tests, adjacent history/config/trash/navigation tests.
- Isolated PostgreSQL tests for list authority, scoped access, pagination, restore
  fidelity and repeat/denied operations; no customer data.
- Mutations for lifecycle-list authorization, wrong recovery endpoint, stale scope,
  deletion detail and confirmation guards, restored before final tests.
- Existing frontend specs stay wired in both multitable guard and required-web;
  any new production module is added to their trigger union as needed.
- Web/core typecheck, targeted lint, diff-check, desktop/mobile synthetic browser
  screenshots. Browser mocks are presentation evidence, not real-login UAT.
- Design and verification reports state local, remote-CI and deployed evidence
  separately. No unqualified product-final claim.
