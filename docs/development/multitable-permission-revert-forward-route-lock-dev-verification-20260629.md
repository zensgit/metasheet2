# T9-W permission-revert — forward-route lock (dev & verification) — 2026-06-29

**Follow-up to:** the #3389 readiness-refresh review, which verified a real lock asymmetry in the
permission-revert line. **Narrows** (does not fully close) honest-gap §2 ("TOCTOU full-serialization")
of `multitable-t9w-permission-revert-dev-verification-20260629.md`: this lands the **univer-meta forward
routes**; the **full writer-set guarantee still depends on retiring-or-locking the legacy route** (below).
**Flag stays default-off**
(`MULTITABLE_ENABLE_PERMISSION_REVERT`). Built on fresh `origin/main`.

## The gap

The permission-revert **execute** path reads the live grant and re-checks de-escalation **inside a
`pool.transaction` that first takes `SELECT 1 FROM meta_sheets WHERE id=$1 FOR UPDATE`** — so reverts
serialize against each other. But the **forward** grant/revoke routes did **not** take that lock, so a
concurrent forward write could commit *between* a revert's live re-check and its apply, turning a
re-checked de-escalation into a **net escalation**. The revert code's own comment already tracked this
("the forward grant/revoke routes must take the same lock for full coverage").

## What shipped

**Fix** — `packages/core-backend/src/routes/univer-meta.ts`. The three forward grant/revoke write
handlers now take the **same `meta_sheets FOR UPDATE` row lock** as the first statement inside their
write transaction:
- sheet — `PUT /sheets/:sheetId/permissions/:subjectType/:subjectId`
- view — `PUT /views/:viewId/permissions/:subjectType/:subjectId` (locks the view's owning `sheetId`)
- field — `PUT /sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId`

Serialization is now **two-sided**: revert↔forward and forward↔forward both serialize on the sheet
row. Lock-acquisition order is identical to the revert (sheet row first, then the grant rows), so the
change introduces **no new deadlock cycle**. The revert-path comment is updated to record that the
forward routes now take the lock.

**Golden (m)** — `tests/integration/multitable-permission-revert-realdb.test.ts`. A deterministic,
**FK-aware** double-writer discriminator:

> `spreadsheet_permissions.sheet_id REFERENCES meta_sheets(id)`, so a forward INSERT implicitly takes
> `FOR KEY SHARE` on the parent `meta_sheets` row. The test therefore **holds `FOR KEY SHARE`** (not
> `FOR UPDATE`) on that row in an external txn and fires a concurrent forward grant write:
> - **with the fix** the forward route requests `FOR UPDATE` → **conflicts** with the held key-share →
>   the write **parks** (asserted: not settled, grant unchanged) until release, then completes (200,
>   grant applied).
> - **without the fix** the forward INSERT needs only the FK's `FOR KEY SHARE` → **compatible** with the
>   held key-share → it **sails through** during the hold → the "parked" assertions **fail** → RED.
>
> A `FOR UPDATE` holder could **not** discriminate the fix: the FK key-share alone would block the
> unfixed INSERT, so the test would pass with or without the lock. This is the teeth-establishing
> reasoning (the realdb suite is CI-only; see Verification).

## Completeness — writer-set audit

Writers to the three grant tables (`spreadsheet_permissions` / `meta_view_permissions` /
`field_permissions`), repo-wide:
- the de-escalation apply helper `applyPermissionDeEscalation` — runs **under the revert's lock**. ✓
- the three univer-meta forward routes — **now locked** (this PR). ✓
- migrations (`zzzz2026…`) — one-time DDL/backfill, not a runtime race. ✓
- **`routes/spreadsheet-permissions.ts`** — the legacy `/api/spreadsheets/:id/permissions` grant|revoke
  route (mounted at `index.ts`), a separate older RBAC surface using bare autocommit `pool.query` with
  **no lock and no transaction**. It can write managed `spreadsheet_permissions` codes, so it is a
  **remaining un-serialized writer**. ⚠ **Out of scope for this narrow PR** — closing it cleanly means
  retiring the route or converting it to a locked transaction. Flagged here and in the honest-gaps doc
  as retire-or-lock before relying on the never-escalate guarantee under that route.

`record_permissions` (row-level) is a different table the revert does not touch — correctly unaffected.

## Verification

- `tsc --noEmit` (core-backend) — clean on the edited router + test.
- **Golden (m) is CI-only** — the `*-realdb.test.ts` suite runs only with `DATABASE_URL` (no local
  Postgres here). Its discrimination is established by the FK lock-compatibility argument above
  (held `FOR KEY SHARE` ⟂ requested `FOR UPDATE`; ⟂̸ the FK key-share), not by a local red/green run.
  The assertion is two-sided (state unchanged while held **and** applied after release), so a slow CI
  run cannot mask a missing lock.

## Out of scope / deferred

Retiring/relocking the legacy `spreadsheet-permissions.ts` route (residual writer); flag enablement
(`MULTITABLE_ENABLE_PERMISSION_REVERT` stays off — a runbook step with flag-on smoke); the re-grant /
escalation direction (still deferred). No FE, no contract change.
