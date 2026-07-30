# Attendance issue #4556 W4C-3a locked-race lock-set amendment

Status: **PROPOSED - owner RATIFY required**

Date: 2026-07-30

Authority proposed against:

- RATIFIED durable-plan amendment merge SHA
  `e6c536fe7a201ca0466b2dc776b15fbdb23aa890`;
- RATIFIED byte-parity amendment merge SHA
  `ab752d722327f11887e3884a23ed4f6304faa3c5`,
  with owner decision `OD-W4C-57=(a)`;
- historical unmerged implementation inventory snapshot
  `602d1dd7879aa0c1bb086d16f73c04913b98059c`, originally authored on
  `codex/attendance-4556-w4c3a-durable-plan-20260730` before later rebases;
- the same contradiction independently reverified at Draft PR #4688 exact head
  `7a0d49eb155610078e5a27fab21e5acfa03f905c`. That head is evidence only and
  must be reverified again at the final code gate.

This document is a narrow correction to the W4C-3a `locked_race` class-`10`
contract. It does not authorize W4C-3a merge or caller cutover, the separate
group-precondition amendment, W4C-3b or later slices, staging soak, a flag
change, deployment, production/customer data, or issue closure.

## 1. Blocking contradiction

The RATIFIED durable-plan amendment currently requires both:

1. after source planning, acquire one complete, globally sorted class-`10`
   set containing the normal draft's batch/item identities and canonical
   legacy-idempotency key, then perform the final locked legacy-batch recheck;
2. if that recheck selects `locked_race`, only the batch/job identity and
   legacy-idempotency key take class-`10`; no item lock exists.

Those requirements cannot both hold when the normal draft has item identities.
The final selector is not known until after the complete set has been acquired.
PostgreSQL transaction-scoped advisory locks cannot be released after the
selector pivots.

Acquiring batch/idempotency first and item locks later is not an equivalent
repair. Class-`10` keys are signed bigint hashes and may interleave in numeric
order. Splitting one sorted set into two acquisitions can invert lock order
against a transaction acquiring the complete sorted set and create a
deadlock. Treating the additional locks as harmless without changing the
contract would instead make the implementation contradict the explicit
replay statement.

The `locked_race` implementation remains paused until this amendment is
RATIFIED. `precheck_hit` is unaffected because that branch is selected before
source planning and has no item identities.

## 2. Decision `OD-W4C-59`

### Option (a) - retain the already-acquired complete set (recommended)

Keep the one complete, globally sorted class-`10` acquisition. A normal draft
that pivots to `locked_race` retains its batch/item/idempotency class-`10`
locks until the reservation transaction ends, but discards all unpersisted
item, record, group, source, and result intent as sections 3-5 specify.

This is the smallest correction and preserves the existing deadlock-avoidance
invariant. The retained item locks are serialization only; they are not
evidence that item effects were selected or persisted.

### Option (b) - redesign the selector lock protocol

Keep the current no-item-lock replay statement and pause `locked_race` until a
new lock protocol is designed, RATIFIED, and applied to every competing
class-`10` path. The redesign must prove one global order across selector,
batch, item, and idempotency domains rather than splitting the existing
hashed set ad hoc.

Option (b) is safe but does not complete the accepted locked-race behavior in
W4C-3a.

An owner RATIFY must name the merged SHA of this PROPOSED amendment and
`OD-W4C-59=(a|b)`.

## 3. Exact correction under option (a)

The durable-plan replay bullet that currently says only batch/job identity
and the canonical legacy-idempotency key take class-`10` is replaced by:

1. `precheck_hit` acquires one complete globally sorted set containing only
   the batch/job identity and canonical legacy-idempotency key. It has no
   planned item identities.
2. A normal planned draft acquires exactly once the complete globally sorted
   set containing its branch-authorized batch/item identities and, when
   present, the canonical legacy-idempotency key.
3. If the final locked recheck selects `locked_race`, the transaction retains
   that already-acquired set until commit or rollback. It performs no second
   class-`10` acquisition and cannot release or reinterpret individual keys.
4. The pivot replaces the effective job and manifest with the closed
   `operational_only_idempotent_replay` observation. It persists zero item
   identities, chunks, record writes, group effects, W4 operations, W4
   sources, or W4 results.
5. The pivot acquires no class-`11` target lock and no record/group revision
   lock. It executes no record/group precondition read or effect adapter.
6. Only an already-opened `uploaded_csv` source may retain its frozen cleanup
   identity. Every other source freezes `artifactCleanup.kind='none'`.
7. A missing, multiple, non-committed, hidden, or incongruent legacy batch
   fails closed with zero V1 reservation residue.

The complete-set acquisition remains before operation/job reservation
rechecks and the final legacy-batch recheck. Route-idempotency and private
executor replay keep their existing precedence. No new lock namespace, lock
class, or two-stage lock acquisition is introduced.

## 4. Required evidence

### 4.1 Exact branch and persistence gates

- a one-item normal draft whose final recheck sees a congruent committed
  legacy batch freezes `locked_race` with zero chunks and zero item,
  record, group, W4 source, W4 result, and W4 operation rows;
- the persisted job and manifest have zero item/distinct-target counts,
  canonical empty item fingerprints/proof vector, the exact locked replay
  precondition, and `replaySelector='locked_race'`;
- a non-upload source strips cleanup; an uploaded source retains only its
  already-derived org-bound cleanup identity;
- `precheck_hit` has no item identities and remains byte-for-byte unchanged.

### 4.2 Lock gates

- a deterministic query trace proves one and only one class-`10` acquisition
  for a normal draft and that the input set includes batch, every planned
  item, and the canonical legacy-idempotency key;
- that trace includes at least one negative advisory key and asserts exact
  signed-bigint numeric order, not string, hexadecimal, or unsigned order;
- the same trace proves the locked legacy-batch recheck occurs after that
  complete acquisition and before class-`11` or revision locking;
- a `locked_race` pivot produces no class-`11`, record-precondition, or
  group-precondition query;
- a `precheck_hit` trace contains only batch/job and legacy-idempotency
  class-`10` keys.

### 4.3 Concurrency and failure gates

- a real two-connection test covers a candidate-miss request racing one
  congruent committed legacy batch and proves exactly one replay reservation;
- multiple, non-committed, count-incongruent, engine-incongruent, strategy-
  incongruent, and metadata-incongruent observations each fail with zero V1
  residue;
- rollback after a successful pivot leaves no job, manifest, chunk, cleanup,
  or W4 effect residue.

### 4.4 Required mutations

Each mutation must turn its named leg red:

1. omit the planned item identities from the normal draft's complete
   class-`10` set;
2. sort a negative class-`10` key as a string or unsigned integer;
3. split class-`10` acquisition into batch/idempotency then items;
4. perform the final legacy-batch recheck before the complete set;
5. continue into class-`11` or revision locks after `locked_race`;
6. persist any pre-pivot item, record, group, source, result, or chunk intent;
7. retain uploaded cleanup for a non-upload source;
8. accept an incongruent replay observation.

### 4.5 CI and review

- the targeted unit and real-DB suites are named in the unconditional
  attendance integration run list on both Node matrix legs;
- a fresh exact-head independent review must report 0 P1 and 0 P2;
- the review must inspect the advisory-key set and rerun the two-connection
  race, not infer compliance from zero persisted effect rows.

## 5. Resume boundary

If `OD-W4C-59=(a)` is RATIFIED:

1. discard or reduce any experimental implementation that performs more than
   one class-`10` acquisition or lacks the one-item lock-set proof;
2. implement sections 3-4 on the current W4C-3a branch;
3. rerun all earlier W4C-3a tests and mutations;
4. continue group-effect runtime only after the separate
   group-precondition amendment is RATIFIED;
5. complete caller cutover only after the full W4C-3a exact-head gate.

The RATIFY does not authorize merge of the W4C-3a code PR. The lane must still
stop at its owner merge gate.
