# Time Machine Recovery UX

## Authority and Baseline

Owner requested implementation of the three prioritized recovery UX improvements
on 2026-09-14. Base main: `c13e40769690a4ed51b3f3a7ac2f8026638f3e88`.
The previously verified configuration-history presentation at Draft #5704
(`e92e462b84e74aa242382c2f31eab326ceb60854`) is preserved by true merge.
This is a Draft-only development window: no Ready, merge, runtime flag change,
deployment, production or real customer data.

## Contract

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
