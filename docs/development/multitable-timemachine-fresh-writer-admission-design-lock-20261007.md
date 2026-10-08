# Time Machine G4 fresh ordinary-writer admission

Status: bounded D-H1 source-writer closure fix, default-OFF. Baseline
`ee89609e5baa84319949483113c35fb2a0d8a4f8`, prerequisite Draft #6233.
Parent D-H1/D-H2 in `multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md`
remains authoritative. This lock precedes production edits. Full composer, lifecycle, D7 and owner
stages remain OPEN.

## Required result and scope

The shared `assertNoActiveWriterBlock` uses a process-wide missing-column cache. A false probe
before the real writer-state migration can survive that migration and skip every later state read.
Ordinary view PATCH reaches this entry, then updates captured meta_views and inserts untagged config
history without another durable-state check. The frozen source census identifies a conditional
break; actual native reproduction is required before reporting a runtime failure.

Only when both existing archive and writer-fence flags equal literal 'true', this common entry
must directly read fresh durable authority on the supplied transaction connection. It must not
consult, reset or update the legacy column cache. Admit only one actual sheet row whose state is
NULL. Recognized writer states, including expired archiving, refuse with the existing coarse,
values-free writer-block error; missing row/column/schema, unknown/malformed state and native query
errors close without exposing database errors or transaction IDs.

The selected entry requires actual READ COMMITTED and a real ongoing transaction, using the existing
native transaction guard. An already-running RR transaction refuses; this helper does not normalize
it after a snapshot or open a nested transaction. The caller retains its existing canonical fence
until commit/rollback. The unselected branch retains the original SQL bytes/order, legacy normalized
writer flag and cached missing-column behavior. No new flag, migration, runtime pool option, provider
operation, general flag normalization or owner exception is introduced.

Change only this shared assertion and its necessary import. Existing acquire/fence/bypass semantics,
dead legacy claim/set exports and owner-safe release functions stay outside the slice. The current
exact-anchor kernel already uses G2 direct participant admission; source census found no production
caller of the old claim/set exports or bypassWriterBlock=true. Do not invent a stale-owner defect or
refactor those paths without new evidence.

## Verification

Use real production migration ups and authority triggers. Reuse the existing missing-writer-state
deployment fixture, adding the real config-revision source migration needed by ordinary view PATCH.
In one router/module/process lifecycle, first run an archive-OFF, writer-literal-true pre-column view
PATCH that actually returns200 and commits its change/history, warming the real false cache. Apply
the remaining real migrations to the same database, verify the column now exists, enable both flags
literally, and commit a genuine nonempty owned claim. The next actual pinned-server view PATCH must
return the exact existing409 and preserve the full source/claim/reservation/pin/head snapshot.
Fresh owned RR capture must retain the original claimed view. Never reset modules/cache, substitute
DDL/results, disable guards or rebuild the router between warmup and refusal.

First reproduce the unchanged-source counterexample with actual200 plus changed source/capture
diagnostics and a matching named assertion failure. After the minimal fix, test unblocked200,
committed and expired genuine claims, same-process deployment, selected missing schema, actual
autocommit misuse, and a genuine inherited-RR fence-wait case. Maintain unselected HTTP/query parity.
Unknown/malformed state and the complete flag spelling matrix are focused unit evidence.

| Gate | Required evidence | State |
| --- | --- | --- |
| Native baseline counterexample | Same-process real migration/claim/view PATCH; actual source and later capture drift, not an infrastructure failure | OPEN |
| Selected positive/refusal | Real unblocked view PATCH200; committed/expired claims409 preserve full source and captured view | OPEN |
| Transaction/freshness/closed trust | Actual RC/ongoing transaction; inherited RR and autocommit refuse; missing authority closes | OPEN |
| Unselected parity | Original cache/SQL/query ordering and actual HTTP result; exact flag matrix | OPEN |
| Refutation/regression | Cache bypass, RC proof and transaction guard mutations have matching RED; exact restore; whole neighboring files | OPEN |
| Review/CI/configured checks | Independent bounded review, whole native union/exclusion/armed sentinel, official provenance, TypeScript and configured checks | OPEN |
| Full writer closure/composer/lifecycle/D7/owner | Remaining census and complete backup/restore/APFS; exact-SHA ratification, merge, flags, deploy/staging | OPEN |

Native PG and principals are newly isolated and synthetic; no previous cluster is restarted.
Initialized data and earlier failures remain preserved. This increment does not claim complete
Time Machine, current-source APFS, independent provider durability or KMS qualification.
