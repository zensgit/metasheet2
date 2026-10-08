# Time Machine G2 foreign-sheet recovery admission

Status: bounded source-writer closure fix. Baseline `9a07ffd313a8463de59d329ac6901199c1f82f19`,
prerequisite Draft #6231. Parent D-H2/D-I0 remains authoritative. G1 has bounded local evidence;
G1 exact-source CI, G3 retention, complete composer/lifecycle and owner stages remain OPEN.

## Required result

An actual hot reset, synchronous archive recovery, or asynchronous archive restore chunk must not
change links owned by a foreign sheet while that sheet carries a committed archive writer block.
The current complete ordered fence set does not suffice: ordinary apply checks only the source;
async prelock checks no foreign block. A reset can delete an inbound foreign-owned edge.

Select the additional archive source protection only when both MULTITABLE_RECOVERY_ARCHIVE_ENABLED
and MULTITABLE_ENABLE_WRITER_FENCE are literal true, reusing archiveSourceProtectionEnabled.
Every unselected path retains the existing SQL, fence/block behavior, refusal shape and isolation.
Do not change the globally normalized legacy flags or missing-column cache. No new flag or migration.

For selected hot and archive-sync apply, establish and verify READ COMMITTED at the start of the
owned transaction before the existing xid probe or any snapshot-bearing statement. For async,
do so at the first prelock call before discovery, job/key/block locks or business reads; do not set
isolation again during the later apply. Inherited REPEATABLE READ must not hide a claim committed
while a recovery waits for its fence. An isolation/schema/unknown-state failure refuses closed with
a values-free error rather than silently admitting a write.

Discover source plus every declared/current inbound/outbound foreign participant; acquire the
complete deduplicated canonical fence set once in existing sorted order before any row lock.
Rediscover under those fences using fresh RC reads. A changed set refuses before token burn,
operation/seal/history/tombstone/record/link mutation, without adding a late fence or retrying in
the same transaction. Retain the acquired set for a later check that the actual locked authority
scope is covered. Correct the old discovery comment: NOWAIT protects against deadlock, not against
an unfenced foreign archive block. These checks must not authorize an actor or replace the existing
full-read, row/field/foreign-target permission and final authority-lease protocol.

After all fences and early set recheck, directly read each selected participant's durable state;
only a present row with NULL state admits an ordinary writer. All existing recognized blocks,
including expired archiving, refuse. A missing column/row or unknown state refuses; preserve the
canonical helper's legacy compatibility outside this selected path. Hot and sync check every
participant, including the source. Async prelock checks every foreign participant and keeps only
the existing source-specific restore-owner exception: later key/generation/job/block bindings,
full owner/fence/lease tuple and private execution receipt must still prove the source holder.
No caller input, DTO, forged lease or foreign sheet may inherit that source exception.

Bind the private async fence lease to the exact transaction query, source and frozen admitted set;
the later actual authority scope must be covered by that set before mutations. Keep current
private identity checks and source ownership validation. Do not create a public bypass switch.
Source block preservation and foreign refusal must both be proven through the actual async facade.

Reuse the normal values-free 409 RECOVERY_IN_PROGRESS response for recognized foreign blocks in
actual hot and sync HTTP routes. The sync mapper currently falls through to INTERNAL_ERROR;
only add the required block/refusal mapping. The worker keeps its existing retryable pause behavior
for a foreign block or admission drift, preserving the source-owned block and pending chunk state.
Do not convert a foreign busy condition into a permanent failed job or clear a foreign owner's block.
Unknown trust failures must also stay values-free, never echo identifiers, state values or locators.

New logic belongs in a single-purpose sibling module. Mega-file edits are limited to entry wiring,
private lease-set binding and the actual-scope coverage assertion. Preserve complete deterministic
acquisition before all row locks and existing hot/sync/async correctness checks. No provider/key
operation, archive publication, prune, schema refactor, real tenant or staging action in this slice.

## Gates

| Gate | Required evidence | State |
| --- | --- | --- |
| Positive control | Actual reset-preview/reset-execute without a foreign block succeeds, removes the inbound edge and commits the legitimate burn/seal | OPEN |
| Real HTTP refusal | Genuine Phase1 archiving on A, actual B hot reset and sync execute return closed values-free refusal; full links/tombstones/records/burns/operations/revisions/heads/pins snapshot unchanged | OPEN |
| Ordering | Claim-first actual advisory wait then commit/refuse; recovery-first actual claim wait then successful recovery and fresh claim view, in both lexical orders; self-link deduplicates | OPEN |
| Fresh participant/isolation | Participant C appears between first discovery and fence acquisition, no late lock/write; true native inherited RR independently set before BEGIN cannot hide a committed claim | OPEN |
| Async ownership | Actual facade with genuine accepted job/worker binding refuses foreign block before destructive work; source holder positive control still commits; forged/mismatched/expired ownership cannot bypass foreign protection; progress/chunk/receipt/seal unchanged on refusal | OPEN |
| Closed trust/flag parity | Unknown/missing schema/state refuses selected path; absent/unselected literals keep legacy SQL/refusal/isolation with no new queries | OPEN |
| Refutation/CI | Each load-bearing admission/isolation/fence/set/owner guard has a matching real native or focused assertion RED; exact source restored PASS; whole native spec wired and armed missing DB fails, focused neighbors and configured checks PASS | OPEN |
| Full writer closure | G3 retention and complete source/worker/deleter races | OPEN |
| Complete D-H2/D-L/D7 and owner stages | Owned bytes/crypto/finalize/abandonment, lifecycle, integrated fixed-source APFS, exact-SHA ratification, merge/flags/deploy/staging | OPEN |
