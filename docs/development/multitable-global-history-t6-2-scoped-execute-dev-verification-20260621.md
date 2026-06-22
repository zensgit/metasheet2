# Global History — T6-2 Scoped Restore Execute 开发与验证 MD

> The FIRST write slice of the restore program (owner-ratified). `POST /sheets/:sheetId/records/:recordId/
> restore-execute` consumes a T6-1 preview identity and performs a single-record record-version restore by
> writing a forward revision. Built as a NEW route (not a change to `/restore`) so the identity is REQUIRED by
> construction and the shipped restore path + its 34 goldens are untouched.

## 1. Flow

1. Mint (now wired into T5-2): the `restore-preview` response returns a `previewIdentity` binding the MASKED diff
   the actor saw (T6-1).
2. Execute: `restore-execute { targetVersion, expectedVersion, previewIdentity }`:
   - `canEditRecord` + record exists;
   - **SR-2 row-deny** (NEW): `loadDeniedRecordIds` — a row-read-denied record → 404 (no-oracle), before any work;
   - `expectedVersion` pre-check (409);
   - recompute the MASKED diff (the same set T5-2 hashed) → `hashPreviewChanges` → **verify the identity** against
     claims computed FRESH at execute (`verifyRestorePreviewIdentity`); reject → 409 (410 if expired);
   - apply via the canonical `patchRecords` spine, `source='restore'` — which enforces the field write gate +
     `expectedVersion` (CAS in a `SELECT FOR UPDATE` txn) + writes the forward revision + Yjs/ formula recompute.

## 2. The locks (SR-* from the T6 design-lock)

- **SR-3 execution-matches-preview**: the identity binds the diff hash; the execute re-derives the diff fresh and
  rejects any mismatch. A stale diff (data / field-permissions moved since preview) re-hashes differently → reject.
- **SR-2 per-record permission re-application** (the NEW surface Layer-1 never had): sheet-level `canEditRecord`
  and per-record row-read-deny are orthogonal, so a sheet editor CAN be read-denied on a record — restoring it
  would write data they cannot read. The row-deny check closes that. **Mutation-checked**: drop it → the denied
  record restores (200 instead of 404).
- **idempotency (SR-6)**: at-most-once via the `expectedVersion` CAS — execute moves N→N+1, a replay carries
  `expectedVersion=N`, current is N+1 → 409. No dedupe table. (And the changesHash would also reject the replay:
  the post-restore diff is empty → hash mismatch.)
- **reveal-free by construction**: the verified/applied diff is the MASKED set the actor saw; T5-2 has no reveal
  path, so a reveal grant can never enter the writable set. Inherited from T6-1, not re-enforced here.
- **no silent partial restore under schema drift**: a snapshot field deleted from the current schema can't be
  faithfully reproduced. The preview WITHHOLDS an executable identity when `schemaDrift` (returns
  `previewIdentity: null`); `restore-execute` ALSO re-checks and rejects with `SCHEMA_DRIFT` (422) before any
  write — defense in depth, matching `/restore`'s behavior. Otherwise execute would silently restore only the
  surviving fields.
- **v1 scope-lock**: the identity binds ONE record-version; `restore-execute` is single-record only. Batch /
  field-subset scope is a later slice (a `scope` claim + scope hash).

## 3. Verification

- backend `tsc` 0; no migration; FE deferred to T6-3.
- **7 real-DB goldens**: **END-TO-END** (a real preview identity → execute → record restored — the drift guard
  across the three diff copies); identity required (missing → 400, tampered → 409, not written); **SR-2 row-deny**
  (denied → 404); replay → 409 (CAS); cross-record (an identity for one record can't execute another → 409);
  **schema-drift** (preview withholds the identity + execute → 422, record unchanged).
- **Mutation check (manual, local — NOT a CI gate)**: to confirm the SR-2 row-deny is load-bearing, the check
  `if (denied.has(recordId)) return 404` was temporarily changed to `… && false`; the *SR-2 row-deny* golden then
  failed (`execute` returned **200 instead of 404**, restoring the denied record); the change was reverted (no
  `MUTATION-PROBE` residue remains — verified by grep). This is a one-off manual verification, not an automated
  mutation gate.
- **Boundary / no-regression**: the existing `/restore` goldens **34/34 unchanged** (the route was not touched);
  T5-2 preview **6/6** (the `previewIdentity` addition is additive); unit suite green (1 pre-existing
  order-dependent flake, `data-source-scope`, passes 20/20 in isolation and is untouched by this diff).

## 4. Out of scope / separate findings

- **T6-3 FE restore panel** (preview → confirm → execute, showing changed / skipped / conflict reasons) — next.
- batch / multi-record / field-subset restore — a later slice (needs a `scope` claim, per the T6-1 [P2] lock).
- **`/restore` row-deny bypass — fixed in a follow-up BEFORE T6-3 (per owner review):** the direct `/restore`
  route predates SR-2 and lacks the row-level read-deny gate, so it bypasses the new chain. This slice keeps it
  out (the advisor's "don't touch the shipped write path in the same slice"), but it is NOT left open — the next
  PR adds the same row-deny gate to `/restore` (additive; the 34 goldens stay green + a new row-deny golden)
  before the FE (T6-3) ships, so the FE's new preview→execute chain isn't undercut by an open legacy route.
- the diff is computed in three places (`/restore`, T5-2 preview, T6-2 execute); the END-TO-END golden guards
  against drift. Unifying them behind one helper is a follow-up P3 (deferred — not a write-path refactor now).
