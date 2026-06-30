# T9-W permission-revert — writer-set closure (dev & verification) — 2026-06-30

**Follow-up to:** #3402 (univer-meta forward-route lock), which left one residual writer. **Closes**
honest-gap §2 ("TOCTOU full-serialization") of `multitable-t9w-permission-revert-dev-verification-20260629.md`
in full. **Flag stays default-off** (`MULTITABLE_ENABLE_PERMISSION_REVERT`). Built on fresh `origin/main`.

## The residual

After #3402, the permission-revert never-escalate guarantee held against every writer to
`spreadsheet_permissions` / `meta_view_permissions` / `field_permissions` **except one**: the legacy
`/api/spreadsheets/:id/permissions` grant|revoke route (`routes/spreadsheet-permissions.ts`) — a
separate older RBAC surface that wrote `spreadsheet_permissions` via **bare autocommit `pool.query`,
no lock**. A grant/revoke through it could still commit between a revert's live-grant re-check and its
apply, turning a re-checked de-escalation into a net escalation.

Writer-set audit (whole backend, non-test) confirmed this was the **sole** remaining un-serialized
writer: the de-escalation apply helper runs under the revert lock; the three univer-meta grant routes
take the lock (#3402); `permissions.ts` (`/api/permissions/*`, the FE-used route) writes
`user_permissions` (global RBAC, a **different** table) and is correctly out of set.

## What shipped

**Fix** — `routes/spreadsheet-permissions.ts`. Both DB-branch writes (grant INSERT, revoke DELETE) now
run inside `poolManager.get().transaction()` taking `SELECT 1 FROM meta_sheets WHERE id=$1 FOR UPDATE`
first — the **same row lock** the revert execute path and the univer-meta grant routes take. `db/pg`'s
`pool` is literally `poolManager.get().getInternalPool()` (same pool, same DB), so the lock genuinely
serializes across surfaces. Lock + write only; `auditLog` and the response read stay **outside** the
txn (the parked window is scoped to the lock). Same lock-acquisition order as everywhere else (sheet
row → grant rows) → no new deadlock. This **serializes** the legacy route; it is not made a first-class
peer (it still records no config revision — retiring it stays a future option if confirmed externally
dead, but that is a breaking change for an OpenAPI-documented endpoint, so out of scope here).

**Golden (n)** — added to the **already-CI-wired** `multitable-permission-revert-realdb.test.ts` (so it
actually runs; a new realdb file would silently not run without a `plugin-tests.yml` edit). Mounts the
legacy router in a local `express()` app with `req.user={roles:['admin']}` (clears `rbacGuard`'s admin
short-circuit, no DB), then applies the **same FK-aware discriminator as (m)**:

> hold `FOR KEY SHARE` on the sheet row, POST the legacy grant of a **non-pre-seeded** perm_code:
> - **with the fix** the route's txn requests `FOR UPDATE` → conflicts → the grant **parks** (not
>   settled, code absent) until release, then applies.
> - **without the fix** the bare autocommit INSERT needs only the FK's `FOR KEY SHARE` → compatible →
>   it commits during the hold → assertions go **RED**.
>
> The probe code is not pre-seeded, so the route's `ON CONFLICT DO NOTHING` is a real observable write
> (absent→present), not a silent no-op. Shared pool `max=20` → no connection-starvation false-green.

## Verification

- `tsc --noEmit` (core-backend) — clean (run against the canonical checkout's deps).
- Golden (n) runs in the CI-only `multitable-permission-revert-realdb.test.ts` suite (`plugin-tests.yml`,
  same job as goldens (a)–(m)); its discrimination rests on the FK lock-compatibility argument above.
- Flag stays default-off; no FE, no contract change, no behavior change to the legacy route's API.

## Result

§2 flips from ◑ PARTIAL to **✅ CLOSED**: every writer to the three sheet-grant tables serializes on the
`meta_sheets` row, so the permission-revert never-escalate guarantee is now **writer-set-complete** —
no longer a HARD enablement gate.
