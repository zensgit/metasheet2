# Global History — T7 Point-In-Time Read-Only View 开发与验证 MD

> The second read-only leaf of the Global History program (after T5-1 the reconstructor), built ON the pinned
> `reconstructRecordsAtT`. `GET /sheets/:sheetId/point-in-time?asOf=<ISO>&limit&offset` — "open the table as of
> T, read-only." Reconstructs over `meta_record_revisions`; **writes nothing**.

## 1. The permission resolution (stated up front, so it isn't the next thing caught)

- **Row-deny = CURRENT-deny, via the SAME seam as every other history surface** (`loadDeniedRecordIds` =
  grant-deny ∪ 2b conditional read-deny, gated on non-admin + `loadRowLevelReadDenyEnabled`). **NOT as-of-T deny.**
  Reason: as-of-T deny would let a record that was `public` at T but is **denied now** show its historical
  contents → the PIT view becomes an **oracle** to read a currently-forbidden record. Current-deny never shows a
  currently-denied record, and matches events / batch-detail / #2968 (cross-surface consistency is the
  leak-preventing kind). Uses `loadDeniedRecordIds`, **not** `deriveRecordPermissions` (which would miss 2b
  conditional read-deny).
- **Field-mask** reuses the history allowed-field chain (`loadAllowedFieldIds` → `maskStoredRecordFieldIds`):
  visible ∧ field_permissions, formula-taint dropped. A field hidden NOW is masked from the T-data.
- **Reveal never composes** (field-audit LOCK-7 / PV-3): the T7 path has no reveal branch.

## 2. The v1 scope boundary (three points — a PRODUCT choice, not a safety deny)

1. **T7 v1 shows only records that CURRENTLY EXIST**, reconstructed to their T-state. Records **deleted since T**
   do **not** appear in the as-of-T view.
2. This is a **product-scope** decision (de-risk: ship the live-record as-of-T view first), **not a security
   deny** — a deleted-since-T record isn't "denied", it's simply out of v1.
3. Consumers must NOT infer from T7 v1's filtered result: a future undelete (T6/T8) must reconstruct the
   deleted set from revisions directly, **not** from "what T7 omitted." The deleted-record-at-T case gets its
   own slice with its own deny decision.

## 3. Verification

- backend `tsc --noEmit` **0**.
- **7 real-DB goldens** (`metasheet_test`), oracle-first:
  - **ORACLE-NEGATIVE (load-bearing)**: a record `public` at T but DENIED now is **absent** from the records AND
    excluded from `total`; a genuinely-readable record IS present (non-vacuous);
  - positive (a currently-readable record shows its **as-of-T** state, not current);
  - field-mask (a `field_permissions`-denied field is absent from the as-of-T record, visible field still there);
  - deleted-since-T **out of v1** (existed at T, deleted now → absent);
  - admin bypass (an admin sees the now-denied record — parity with the other surfaces);
  - validation (missing / invalid `asOf` → 400).
- **Mutation check**: disable the current row-deny skip → the oracle-negative golden **fails** (the now-denied
  record leaks its T-state into the view) → proves the current-deny is the load-bearing oracle closure.
- Boundary: history events goldens **22/22** + reconstructor **7/7** unchanged (T7 only adds a route). unit
  **3756/3756**. No migration.

## 4. What is NOT covered (next slices)

T5-2 restore-preview (the diff over T5-1 + revision snapshots) is the next read-only leaf (built after T7 so the
two leaves don't touch the permission root at once). The write/destructive slices (T6 scoped restore, T8 PIT
restore) + T9 config history are **design-locked, not built** (see their design-locks + the program roadmap),
each gated on its own ratification.
