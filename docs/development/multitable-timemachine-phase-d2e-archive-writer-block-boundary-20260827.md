# Time Machine Phase D2e archive writer-block boundary (2026-08-27)

- **Status:** Draft / HOLD. Default-OFF D-H1 owner/CAS substrate only.
- **Exact parent:** `8294dd6057fb269959e8bfdf48d86449d01d4580`.
- **Enablement:** no flag is added, changed, or enabled. Archive owner operations refuse unless both
  `MULTITABLE_RECOVERY_ARCHIVE_ENABLED` and `MULTITABLE_ENABLE_WRITER_FENCE` are exact raw `true`.

## Delivered

This slice evolves the existing `meta_sheets.recovery_writer_state` row; it does not create a second
writer block. The closed state set gains `archiving` and the same row gains a closed owner kind,
opaque owner id, PostgreSQL bigint fence, lease, and update stamp. Parent recovery states cannot
carry archive ownership. Release clears state/owner/lease but intentionally retains the positive
fence, so a later claim increments it in SQL without crossing the JavaScript number boundary.

The public mutation surface consists only of transaction-runner APIs. Inputs and both exact flags are
checked before entering the injected runner. Inside its callback the first SQL is the source-free
canonical advisory fence plus xid/isolation probe; a same-xid probe and exact owned-schema
fingerprint precede every clean/full-old-tuple takeover, heartbeat, or release CAS. The schema
projection names only the exact owned constraints, so a foreign same-prefix constraint is ignored
while a missing, renamed, unvalidated, or definition-drifted owned constraint refuses.

`checkArchiveWriterBlockOwnerExact` is deliberately a low-level check, not a D-H2 ordering claim.
Its caller owns the transaction and must invoke it before the source read/live write required by the
future capture/job protocol. No capture or job caller exists in this slice.

## Still Open

- The D-H1 source writer/deleter census and constructed race matrix remain a parallel mandatory
  gate. Archive creation does not exist here and must continue to refuse until that census closes.
- D-H2 claim allocation, RR capture, source pins, finalize, cleanup, whole-operation prune, D3 key
  registry, routes, jobs, provider/KMS calls, and flag enablement are not part of D2e.
- This substrate alone does not authorize an archive, prune hot evidence, or touch production.

## Verification Boundary

Focused unit and real-DB tests cover the dual exact-flag/input preflight, callback-first fence ordering,
same-xid/READ-COMMITTED checks, exact schema definitions, clean claim, expired full-tuple takeover,
ABA/stale heartbeat and release, low-level exact-owner/unexpired checks, rollback, ordinary writer
blocking, same-prefix non-owned constraints, owned-name/definition drift, persistent fences above
`2^53`, migration down refusal on any retained ownership surface, and values-free errors. The D2
real-DB roster remains two-point wired and fail-not-skip; migration replay advances from 17 to 18.
