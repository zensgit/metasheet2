# `/restore` Route — Row-Deny Bypass Closure 开发与验证 MD

> Owner review of #3023 ([P1] #2): the legacy `POST /sheets/:sheetId/records/:recordId/restore` route predates
> the row-level read-deny gate, so it bypassed the SR-2 protection that the history surfaces + the new
> `restore-execute` (T6-2) enforce. Closed here BEFORE T6-3 ships, so the FE's new preview→execute chain isn't
> undercut by an open legacy route. Additive gate — the shipped restore behavior is otherwise unchanged.

## The gap

`canEditRecord` (sheet-level write capability) and per-record row-read-deny are orthogonal: a sheet editor can
be row-read-denied on a specific record (e.g. a conditional rule denies `status='confidential'`). The `/restore`
route checked `canEditRecord` but NOT row-deny — so such an editor could restore (write) a record they cannot
read, via the legacy route, even though `restore-execute` and the read surfaces deny it.

## The fix

After the record-exists check and before the `expectedVersion` pre-check, `/restore` now applies the SAME seam
as everywhere else: when the per-sheet `row_level_read_permissions_enabled` flag is on and the actor is non-admin,
`loadDeniedRecordIds` (grant-deny ∪ 2b conditional read-deny) is consulted; a denied record → 404 (no-oracle).
Admin bypasses, parity with the other surfaces. The gate is **inert when the flag is off**, so existing behavior
is unchanged.

## Verification

- backend `tsc` 0; no migration.
- `/restore` real-DB goldens **35/35** — the existing **34 unchanged** (all flag-off, gate inert) + **1 new**:
  a row-read-denied record cannot be restored (404, record unchanged).
- **Mutation check (manual, local — NOT a CI gate)**: the new gate `if (denied.has(recordId)) return 404` was
  temporarily changed to `… && false`; the new row-deny golden then failed (`/restore` returned **200 instead of
  404**, restoring the denied record); reverted, no `MUTATION-PROBE` residue (grep-verified). Confirms the gate is
  load-bearing.

## Scope

Just the row-deny gate on `/restore` (the bypass). The route otherwise unchanged. The three restore surfaces
(`restore-preview`, `restore-execute`, legacy `/restore`) now all apply row-deny consistently. T6-3 (FE) is next.
