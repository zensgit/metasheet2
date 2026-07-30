# Attendance issue #4556 W4C-3a result-slot amendment

Status: **PROPOSED - owner RATIFY required**

Date: 2026-07-30

Authority proposed against:

- durable-plan amendment merge SHA
  `e6c536fe7a201ca0466b2dc776b15fbdb23aa890`, RATIFIED by
  `OD-W4C-56=(a)`;
- byte-parity amendment merge SHA
  `ab752d722327f11887e3884a23ed4f6304faa3c5`, RATIFIED by
  `OD-W4C-57=(a)` in PR #4679 comment `5125993049`.

This is a narrow correction to the exact W4C-3a plan/result contract. It does
not authorize W4C-3a merge, W4C-3b or later slices, a flag change, deployment,
staging/soak, production or customer data, or issue #4556 closure.

## 1. Blocking contradiction

The RATIFIED durable-plan amendment says that execution-derived values such as
the actual inserted group-member count are represented as **named result
slots** and are not guessed at enqueue
(`attendance-issue-4556-w4c3a-durable-legacy-plan-amendment-20260729.md`,
section 4.2). It also forbids an opaque JSON leaf from selecting SQL structure
or silently dropping a verified legacy leaf (section 7.2, items 57 and 58).

The RATIFIED contract does not yet give exact schemas for those policies or
name those slots. The unmerged implementation foundation currently represents
that under-specification with placeholders:

- its normal batch plan has placeholder keys `itemReturnPolicy`,
  `skippedSamplePolicy`, and `resultSlots`, each parsed only as an opaque leaf;
- every record-write plan has another placeholder `resultSlots` key parsed the
  same way;
- no RATIFIED section gives an exact key set, value domain, inclusion rule, or
  mapping from those leaves to batch metadata and the compact terminal summary.

That is not enough to implement the batch/result adapter honestly. The retained
P07 path uses the skipped-sample limit to decide which rows enter persisted
metadata, and it uses actual group-effect row counts to build that metadata.
Allowing a worker to interpret the current opaque objects would violate the
same contract that the adapter is meant to implement.

The gap is limited. The frozen item union already carries every value needed by
`attendance_import_items`, and the frozen record-write union already carries
every value written to `attendance_records`. No new business calculation,
source read, or mutable-state lookup is needed.

## 2. Current behavior that must remain

The P07 commit payload is normalized before enqueue:

1. `returnItems` is always `false`;
2. `itemsLimit` is removed;
3. the skipped-sample limit is normalized to an integer in `0..500`, with the
   deployment default resolved before plan persistence;
4. first-execution normal batch metadata always contains `groupCreated`;
5. `groupMembersAdded` is present only when auto-assignment has at least one
   planned membership effect, and its value is the number of rows actually
   inserted by the conflict-ignore member writer;
6. first-execution normal batch metadata contains both `skippedCount` and
   `skippedRows` when at least one source row is skipped. `skippedRows` remains
   an empty array when the frozen sample limit is zero. The sample preserves
   source order, is first bounded by the frozen skipped-sample limit, then by
   the existing batch-metadata limit of 50;
7. async `processedRows` is the number of `apply` items, and `failedRows` and
   optional terminal-summary `skippedCount` are the number of `skip` items on
   first execution. A replay uses its locked existing batch counts instead of
   the replay plan's intentionally empty item set;
8. async `elapsedMs` remains an execution observation: zero for early replay
   and otherwise a measured non-negative duration. It is not an enqueue-plan
   value.

The compact terminal summary has a separate exact inclusion rule:
`summary.skippedCount` exists exactly when the normalized count is positive,
while `summary.skippedRows` exists exactly when the normalized bounded sample
is nonempty. Therefore a positive skip count with `limit=0` produces
`batch.meta.skippedRows=[]`, includes terminal `summary.skippedCount`, and omits
terminal `summary.skippedRows`.

P06 synchronous HTTP still owns its existing independent response serializer.
This amendment does not route P06 through the private queue processor or make
the async compact summary a synchronous response.

## 3. Proposed decision

### OD-W4C-60 - close result policy and result slots

Numbers 58 and 59 are already reserved by the still-PROPOSED group-precondition
and locked-race amendments in PRs #4685 and #4686. This numbering records only
ballot order; it does not imply either earlier amendment is merged or RATIFIED.

- **(a) Recommended:** apply the exact corrections in section 4 and continue
  W4C-3a only after the merged amendment is independently reviewed and
  RATIFIED.
- **(b):** retain the opaque leaves and stop W4C-3a before batch metadata,
  item sampling, and terminal-response construction.

Option (b) is fail-closed but leaves the slice incomplete. Interpreting the
opaque leaves without this correction is not an option.

## 4. Exact correction for option (a)

### 4.1 P07 item-return policy

The normal batch variant adds and closes the previously under-specified policy
as exactly:

```text
itemReturnPolicy = {
  returnItems: false,
  itemsLimit: null
}
```

Both keys are required. No additional key or value is accepted. This shape is
P07-specific and does not redefine P06's synchronous options.

### 4.2 Skipped-sample policy

The normal batch variant adds and closes the previously under-specified policy
as exactly:

```text
skippedSamplePolicy = {
  limit: integer 0..500
}
```

The value is resolved and frozen before enqueue. Worker execution never reads
an environment variable or request payload to change it. `limit=0` is distinct
from every positive limit and produces no sampled rows while retaining the
full skipped count.

### 4.3 Batch result-slot descriptors

The normal batch variant adds and closes the previously under-specified result
slot declaration as exactly:

```text
resultSlots = {
  groupCreated: 'ensure_group_returned_row_count',
  groupMembersAdded: 'ensure_member_inserted_row_count'
}
```

Both keys and both literal values are required. The object is a digest-bound
slot declaration, not a place to persist mutable result values.

The private effect executor produces one closed in-transaction result:

```text
legacy_effect_result = {
  groupCreated: non-negative safe integer,
  groupMembersAdded: non-negative safe integer
}
```

`groupCreated` counts rows returned by the exact retained
`INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` group effect, including a
conflict-update row. `groupMembersAdded` counts rows returned by the exact
conflict-ignore membership insert. No current group lookup, local counter, or
plan-provided number may replace either count.

When the frozen group map already contains a group, no `ensure_group` effect
exists and `groupCreated` remains zero. A frozen `ensure_group` effect that
executes and returns its conflict-update row contributes one. The executor
requires `groupCreated` to be no greater than the number of frozen
`ensure_group` effects and `groupMembersAdded` to be no greater than the number
of frozen `ensure_member` effects.

### 4.4 Record result slots

Every record-write plan adds and closes the previously under-specified result
slot declaration as exactly:

```text
resultSlots = {}
```

No key is accepted. Record ID, source batch ID, punches, metrics, status,
timezone, revision, compatibility metadata, and all snapshots already have
explicit fields in the exact record-write union. No execution-derived record
value is needed to build an item row or the async compact summary.

### 4.5 First-execution deterministic values

For a normal first-execution plan, the executor derives these values only from
the verified plan and the closed effect result:

- `processedRows = count(items where kind='apply')`;
- `failedRows = skippedCount = count(items where kind='skip')`;
- sampled skipped rows preserve item ordinal order and have the exact output
  keys `{userId,workDate,warnings}`. Their values come only from the item's
  frozen `{resolvedUserId,resolvedWorkDate,warnings}` respectively;
- each sampled row is included only while its zero-based skipped rank is below
  `skippedSamplePolicy.limit`, and persisted `skippedRows` is additionally
  capped at 50;
- an apply item resolves `record_id` only through its exact
  `recordWriteRef -> recordWriteId -> recordId` relationship;
- batch engine, chunk config, strategies, mapping profile, group-sync snapshot,
  compatibility metadata, source, mapping, status, and IDs come only from
  their explicit verified-plan fields.

Opaque snapshots and compatibility metadata may be copied byte-for-byte only
to their named output fields. They never select a branch, SQL statement,
authorization rule, count, truncation limit, or terminal-response key.

The first-execution normal batch metadata is constructed exactly as follows:

- copy only the already named frozen batch metadata fields;
- always add `groupCreated=legacy_effect_result.groupCreated`;
- add `groupMembersAdded=legacy_effect_result.groupMembersAdded` exactly when
  the plan has at least one `ensure_member` effect, including a zero value when
  every insert conflicts;
- when `skippedCount>0`, add both `skippedCount` and the possibly empty
  `skippedRows` array; otherwise add neither.

The compact terminal summary is a separate sink. It always has required
`processedRows|failedRows|elapsedMs|chunkConfig`; it adds `skippedCount` exactly
when positive and `skippedRows` exactly when the bounded sample is nonempty.
Group-effect result keys remain batch metadata and are not new terminal-summary
keys.

### 4.6 Replay deterministic values

Both `idempotent_early` and `idempotent_in_transaction` use the exact
`idempotent_replay` batch variant. That variant has zero item, record-write, and
group-effect entries. It therefore never derives counts from items and never
executes or reconstructs group-effect result slots.

For either replay observation:

- `processedRows = batch.importedCount`;
- `failedRows = skippedCount = batch.skippedCount`;
- `processedRows + skippedCount = batch.totalRowCount`;
- engine, record-upsert strategy, item-insert strategy, chunk config, and the
  bounded skipped sample come only from the locked existing batch fields and
  metadata frozen into the replay variant;
- terminal `skippedCount` and `skippedRows` use the same independent inclusion
  rules in section 4.5;
- the existing batch metadata is read evidence and is not rewritten with a
  newly synthesized `groupCreated`, `groupMembersAdded`, or skipped sample.

The `locked_race` observation must use the one locked congruent batch selected
under canonical locks. It cannot reuse counts or metadata from an earlier
values-only candidate read. The `precheck_hit` observation uses the same batch
that passed its locked congruence recheck.

### 4.7 Observation values

`elapsedMs` is not added to either result-slot object. The canonical private
executor measures it for `first_execution|idempotent_in_transaction` and uses
literal zero for `idempotent_early`, as already required by section 4.6 of the
RATIFIED amendment. The selected observation variant remains locked by the
existing worker/repository state machine.

## 5. Required proof

The W4C-3a exact-head gate must independently prove:

1. exact-key parsing accepts only the two policy shapes and the two result-slot
   shapes above;
2. omission, extra keys, wrong literals, negative/fractional/501 sample limits,
   and nonempty record result slots fail before effect SQL;
3. `limit=0`, `limit=1`, `limit=50`, and `limit=500` preserve full skipped
   counts while producing the exact bounded source-order samples, including
   positive `summary.skippedCount` with omitted `summary.skippedRows` at
   `limit=0`;
4. changing the deployment environment after enqueue cannot change the sample;
5. replacing actual group/member affected-row counts with plan values, local
   effect counts, or current-table counts fails;
6. a conflict-updated group counts as `groupCreated=1`, while an ignored
   existing membership counts as zero; a group already present in the frozen
   group map creates no `ensure_group` effect and leaves `groupCreated=0`;
7. apply/skip counts, item rows, batch metadata, and terminal summary all come
   from one verified plan/effect result and commit in the worker transaction;
8. a mutation that parses an opaque snapshot or compatibility object to choose
   a branch fails;
9. same-process and module-reload execution produce identical deterministic
   fields from the same persisted plan; only the already permitted elapsed-time
   observation differs;
10. P06 retains its independent item-return behavior and creates no V1 terminal
    response.
11. `idempotent_early` and `idempotent_in_transaction` use locked replay-batch
    counts and metadata with zero effect DML; replacing either with the empty
    replay item count or a pre-lock candidate value fails.
12. batch metadata and compact terminal summary obey their distinct exact key
    sets and inclusion rules; copying one object wholesale into the other
    fails.

Every mutation has an independent positive control. Where another guard would
reject first, the neighboring guard is neutralized in a separate run so the
field-specific leg must fail.

## 6. Ratification and execution boundary

An owner RATIFY must name the merged SHA of this PROPOSED amendment and
`OD-W4C-60=(a|b)`. Only option (a) authorizes W4C-3a to consume these corrected
schemas.

Implementation that does not interpret the four corrected leaves may continue
under the existing RATIFIED authority. Batch/result execution, caller cutover,
and any claim that W4C-3a is complete must wait for this decision.

After RATIFY, W4C-3a still stops at its independently reviewed Draft PR and a
separate owner merge decision. No later slice, runtime activation, staging,
soak, deployment, or issue closure follows automatically.
