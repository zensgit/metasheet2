# Legacy permission grant/revoke routes — sheet FOR UPDATE lock (dev + verification)

**Date:** 2026-06-30  **Grounding:** `origin/main @ 352cac267`
**Branch:** `claude/legacy-perm-route-lock-20260630`
**Follow-up to:** #3402 (forward-route lock), which closed the three multitable forward permission routes and **explicitly deferred** the legacy `routes/spreadsheet-permissions.ts` grant/revoke routes as the *"remaining un-serialized writer."* This closes that residual the **same way** (one lock model — no second locking strategy).

> Flag status: `MULTITABLE_ENABLE_PERMISSION_REVERT` stays **default-off**. This change enables nothing; it completes the writer-set serialization that makes a future, separately-signed-off enablement safe.

---

## 1. Context

The permission-revert **execute** path reads the live grant and re-checks de-escalation **inside a txn under `meta_sheets … FOR UPDATE`**. #3402 made the three multitable forward grant/revoke routes take that **same** lock so they serialize against a concurrent revert. It left the legacy `routes/spreadsheet-permissions.ts` `POST …/permissions/grant` and `…/revoke` routes taking **no explicit sheet lock** — they wrote `spreadsheet_permissions` via **single auto-commit `pool.query` statements** (no transaction, so no row lock could be held across the write). #3402 flagged these collectively as the *"remaining un-serialized writer"*; §2 refines that characterization — grant was *incidentally* FK-serialized against the revert, so only revoke was actually un-serialized.

## 2. The grant vs revoke asymmetry (stated precisely — not overclaimed)

`spreadsheet_permissions.sheet_id REFERENCES meta_sheets(id)`. This FK changes the two routes' pre-existing exposure differently, and the guarantee must be stated exactly:

- **Grant (`INSERT`)** — an INSERT into the child implicitly takes **`FOR KEY SHARE`** on the parent `meta_sheets` row (FK enforcement). The revert holds **`FOR UPDATE`** on that row, and **`FOR UPDATE` conflicts with `FOR KEY SHARE`**, so a concurrent grant INSERT **was already serialized** against the revert (it blocks until the revert commits). Adding the explicit lock to grant is **uniformity** (one lock model, matching #3402) — **not** a new closure.
- **Revoke (`DELETE`)** — deleting the child row takes **no lock on the parent** `meta_sheets` row. So revoke was **not** FK-serialized against the revert and could interleave the revert's live-grant re-check and its apply. **Revoke is the genuine residual** this PR closes.

Both are locked (full writer-set uniformity, per #3402's all-routes approach), but only revoke was a real gap.

## 3. Fix

`packages/core-backend/src/routes/spreadsheet-permissions.ts`. Each DB write path (the `if (pool)` branch of grant and of revoke) is wrapped in a transaction that locks the owning sheet row **first**, then writes:

```
await transaction(async ({ query }) => {
  await query('SELECT 1 FROM meta_sheets WHERE id = $1 FOR UPDATE', [req.params.id])
  await query(/* the existing INSERT … ON CONFLICT DO NOTHING  /  DELETE … */)
})
```

Lock-acquisition order is `meta_sheets → spreadsheet_permissions`, **identical** to the revert and to #3402's forward routes (see §5). The in-memory fallback (`else` branch, no `pool`) is unchanged (dev-only, no DB, nothing to serialize). The rbac guard, request validation, audit call, and the post-write re-`SELECT` for the response are unchanged.

## 4. Verification

### 4.1 Real-DB golden (new) — `tests/integration/multitable-legacy-permission-route-lock-realdb.test.ts`

Added to the `plugin-tests.yml` real-DB allowlist. Two concurrency goldens using the **FK-aware discriminator** from #3402's `(m)`: an external txn HOLDS **`FOR KEY SHARE`** (not `FOR UPDATE`) on the sheet row, then the route is fired.

- **(a) grant parks** — the fixed grant requests `FOR UPDATE` (conflicts with the held `FOR KEY SHARE`) → it parks (not settled, no grant row) while held, then applies after release.
- **(b) revoke parks** — same, for the DELETE.

Why `FOR KEY SHARE` (not `FOR UPDATE`) is the correct discriminator: it is **compatible** with the FK key-share an unfixed grant INSERT needs (and a plain revoke DELETE takes no meta_sheets lock at all), so an **unfixed** route sails → the assertion fails (RED). It **conflicts** with the `FOR UPDATE` the **fixed** route now requests → the route parks (GREEN). Assertions are two-sided (state unchanged while held **and** applied after release), so a slow CI run cannot mask a missing lock.

### 4.2 Results (local, real Postgres)

- **With the fix:** `Tests 3 passed (3)` (sentinel + grant parks + revoke parks).
- **RED-pre-fix proof (non-negotiable):** reverting *only* the runtime change and re-running → **`2 failed | 1 passed`** — both concurrency goldens fail against the unfixed route (the grant/revoke sail under the held `FOR KEY SHARE`). The goldens therefore have teeth; they are not green-regardless.
- `tsc --noEmit` clean.

## 5. Deadlock analysis

The new locks take `meta_sheets … FOR UPDATE` **before** writing `spreadsheet_permissions` — the same `meta_sheets → permission-row` order as the revert (which locks `meta_sheets` first, then the grant rows) and #3402's forward routes. No code path locks a permission table and **then** `meta_sheets` (re-verified on current main). With a single consistent lock-acquisition order across every actor, there is no lock-order cycle → deadlock-free. (The sheet-delete FK cascade also locks `meta_sheets` first, same direction.)

## 6. Scope / non-goals

- Only the **user-subject** grant/revoke — the legacy route handles `subject_type='user'` exclusively (unchanged).
- The **in-memory fallback** path (no `pool`) is dev-only and takes no lock (there is no DB to serialize against); unchanged.
- Does **not** enable the flag, change rbac/validation, add a sheet-existence check, or alter the response shape — minimal, lock-only.
- Forward-vs-forward last-write-wins between two authorized permission writes is pre-existing and out of scope (as in #3402).

## 7. Outcome

With this change, **every** writer of `spreadsheet_permissions` — the multitable forward route (#3402), the permission-revert apply (under its own lock), and now the legacy grant/revoke route — serializes against the permission-revert under the same `meta_sheets FOR UPDATE`. The writer-set serialization #3402 began is complete; revoke's genuine residual is closed.
