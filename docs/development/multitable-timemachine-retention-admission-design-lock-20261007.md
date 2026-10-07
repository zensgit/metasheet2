# Time Machine G3 tombstone retention admission

Status: bounded source-writer closure fix. Baseline `24b3b880798247cb5787b45a3e9cb68d3b668ba2`,
prerequisite Draft #6232. G1/G2 ordinary exact-source CI, complete D-H2/D-L/D7 and owner stages remain OPEN.
This lock precedes implementation. Parent D-H2/D-I0 remains authoritative.

## Required result and minimum scope

The periodic retention task passes a pool-level query to field/link tombstone sweeps. Their grouped
and anchorless DELETEs do not acquire a canonical sheet fence or observe a committed archive block.
Owned archive capture includes all scoped tombstones, including old untagged rows. A claim followed
by the current janitor and then an RR capture can therefore capture already-pruned source.
Tagged history triggers/filters do not guard these untagged rows. Record/config revision sweeps are
outside this source projection and outside this slice.

Only the existing dual literal-true archiveSourceProtectionEnabled selector chooses the new path.
Retain retention's existing exact-'1' enable semantics, days floor, cadence and four independent chains.
All unselected SQL bytes, ordering, fallback/error behavior and outputs stay unchanged. No globally
normalized flag or legacy missing-column cache change, new flag, migration, provider/key operation,
restore-holder bypass or archive runtime composer is authorized here.

Put selected deletion in one single-purpose sibling. Add an optional owned transaction runner to
the two public tombstone sweeps and scheduler options; scheduler's default runner uses the existing
native database transaction adapter. An injected query never authorizes falling back to autocommit
deletion when a selected runner is absent. Keep mega-file changes to this branch and runner wiring.

The outer query may discover bounded anchor/id plus persisted tombstone sheet routing hints only.
Use one short owned transaction per selected sheet: SET and verify READ COMMITTED before any
snapshot-bearing statement, prove a real ongoing transaction, acquire its canonical sheet fence,
then directly read fresh durable state. Only one actual sheet row with NULL state admits deletion.
Recognized blocks including expired archiving skip that sheet; missing row/schema, unknown state,
isolation failure or a forged/autocommit runner refuse without deleting. Keep the fence through
fresh eligibility checks, DELETE and commit. Do not add a late fence, clear a block or retry a refused
transaction. Errors that escape the scheduler stay values-free codes/counts.

Preserve whole-anchor grouping across the entire table: max(created_at) and bool_and(operation_id
IS NULL) see every member. Never repartition an anchor into per-sheet deletion fragments. The schema
does not enforce single-sheet groups; selected routing conservatively skips a cross-sheet anchor,
and fresh deletion must also prove the anchor still belongs solely to the fenced sheet.
Fresh grouped eligibility includes exact candidate anchor, all-untagged/newest age and link live-trash
floor. Fresh loose eligibility includes exact candidate id, same sheet, NULL anchor, untagged status
and age. Initial discovery is never deletion authority. Legal drift tests insert tagged members or
replace untagged rows; operation_id UPDATE is already forbidden by the native immutable trigger.

Keep one sweep-level batchSize anchor budget and a separate batchSize anchorless-row budget.
Do not reset full batchSize for each sheet; groups larger than the row batch still delete whole.
Keep the link missing-delete_revision_id floorless fallback. A 42703 aborts a native transaction:
use a narrow savepoint/rollback-to around the optional floor statement or an equivalent fresh schema
branch; catch-and-continue in an aborted transaction is unacceptable. Missing tombstone table or
operation_id must keep the existing zero-delete deployment behavior without dropping eligibility guards.

The new canonical holder is metadata-only (DELETE tombstones, no meta_records.data write). Register
its exact discovered census key/count with a reason, retain every existing scanner/assertion/negative,
and prove an injected post-fence record-data write fails the metadata-only guard. No field-schema
recheck helper is needed on a tombstone-only janitor.

## Gates

| Gate | Required evidence | State |
| --- | --- | --- |
| Positive / existing semantics | Both field/link grouped and loose real rows prune; tagged/mixed/fresh/floor groups survive; whole groups and one global budget per category | OPEN |
| Genuine archive block | Real owned committed and expired archiving claims preserve the complete source and owner/catalog/reservation/pin/head snapshot | OPEN |
| Ordering / freshness | Actual claim-first and retention-first advisory waits; true inherited RR configured before BEGIN normalizes to fresh RC; owner after retention sees post-prune source | OPEN |
| Fresh eligibility | Legal new tagged member, fresh member, trash floor and loose identity/age/scope drift between discovery and fence cause zero stale deletion | OPEN |
| Closed trust / deployment fallback / OFF | Missing row/schema/unknown state/autocommit/isolation closes; actual missing floor column works under transaction; absent/unselected flags preserve exact legacy SQL/behavior | OPEN |
| Refutation / CI contract | Each load-bearing fence/state/RC/freshness/whole-group/tag/floor/budget guard has matching native or focused RED; exact restore PASS; whole native file wired and armed missing DB fails | OPEN |
| Source review / configured checks | Independent implementation review, focused new unit/native plus actual neighbors and field-holder guard, provenance and configured checks PASS | OPEN |
| Full D-H2 / D-L / D7 and owner stages | Complete owned bytes/crypto/finalize/abandonment/lifecycle, integrated fixed-source APFS, exact-SHA ratification, merge/flags/deploy/staging | OPEN |
