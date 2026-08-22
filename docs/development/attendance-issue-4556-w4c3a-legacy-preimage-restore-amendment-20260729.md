# Attendance Issue #4556 W4C-3a Legacy Preimage Restore Amendment

> Status: **RATIFIED** (implementation of option (a) only)
>
> Date: 2026-07-29
>
> Decision: `OD-W4C-55` — resolved `(a)`
>
> Ratified: 2026-07-29, merged SHA
> `1055e543a3680be9f37462de23483bf61ad4610c` — the commit that landed this
> document on `main` (PR 4672) — with `OD-W4C-55=(a)`. Durable owner record
> (transcribed by the implementation agent, which is not the decision-maker):
> PR 4672 comment `5113759839`,
> <https://github.com/zensgit/metasheet2/pull/4672#issuecomment-5113759839>.
>
> Scope of what the ratification authorizes: implementing **only option (a)**
> of this amendment at the exact merge SHA above. The implementation remains
> subject to a fresh exact-head independent gate with zero P1/P2 findings and a
> separate owner merge decision.
>
> Ratification authorizes the slice it names and nothing downstream: this
> document still does not authorize merge of the W4C-3a implementation PR,
> W4C-3b or later slices, flag changes, deployment, staging or soak, customer
> or production data, or closure of issue 4556.
>
> **Status reconciliation note (2026-08-09):** this header previously read
> `PROPOSED`. That was in-repo status drift, not a pending decision — the owner
> record cited above predates this correction and is unchanged by it. This edit
> transcribes that existing record and confers no new authority; the linked
> owner comment is the authority, not this document and not the pull request
> carrying this edit. If any line here misstates that record, it must not merge.

## 0. Why this amendment exists

The RATIFIED W4 design requires two properties that the current durable schema
cannot simultaneously satisfy for an authoritative update import over an
existing legacy-owned daily record:

1. Section 7.9 step 5 requires rollback to restore the exact frozen pre-batch
   projection owner, current pointer, visibility tuple, and daily projection.
   A valid preimage can be
   `projection_owner='legacy_untracked'` with
   `current_calculation_id=NULL`.
2. Section 7.5 and the already-applied
   `attendance_w4_records_pointer_guard()` reject any return to
   `legacy_untracked` after a legacy baseline or authoritative current-owning
   calculation exists.
3. Section 7.8 says every existing `legacy_untracked` parent receiving an
   authoritative result first appends a baseline, while baseline uniqueness
   permits only one row per identical frozen legacy projection. After an exact
   rollback to legacy ownership, blindly applying that rule either selects no
   predecessor or attempts a duplicate baseline.

An authoritative import replacing an existing legacy parent creates exactly
that conflict:

1. before the import, the parent is legacy-owned with a null pointer;
2. the writer freezes that exact tuple and appends a legacy baseline plus an
   authoritative import calculation;
3. rollback appends a reversal;
4. restoring the frozen tuple triggers
   `W4C0_POINTER: parent cannot return to legacy_untracked`.

Keeping the W4 pointer instead would make the SQL succeed, but it would violate
the exact restore rule and make the parent claim W4 ownership it did not have
before the batch. No implementation may silently choose between these two
RATIFIED statements.

## 1. Evidence

This amendment was derived against `origin/main`
`5ae2cea0b2a84f0d36319f79c38ae2e796b5d20a`.

### 1.1 Governing text

- Design lock section 7.5: once a baseline or authoritative current-owning row
  exists, the parent can never return to `legacy_untracked`.
- Design lock section 7.8: every import target freezes the exact write-before
  owner, pointer, visibility, projection, and compatibility fingerprint.
- Design lock section 7.9 step 5: update rollback restores that exact frozen
  owner/pointer/visibility/projection tuple.
- Design lock section 12.4: update import rollback restores, while first-import
  rollback retires.

### 1.2 Applied database behavior

Migration
`zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts`
implements the no-return rule in `attendance_w4_records_pointer_guard()`:

- when `NEW.projection_owner='legacy_untracked'`, it searches for any baseline
  or authoritative current-owning calculation for the parent;
- if one exists, it raises
  `W4C0_POINTER: parent cannot return to legacy_untracked`;
- an authoritative import and its reversal necessarily leave such rows in the
  append-only calculation history.

This is not a missing application branch. The database rejects the exact
section 7.9 restore even when every application predicate is correct.

The existing calculation lineage trigger does not resolve the follow-on
problem. It proves only that a supplied predecessor belongs to the same
record/org and has a lower version. It neither makes a historical reversal
current nor proves which immutable row a later authoritative source must
supersede when the parent pointer is null.

## 2. Non-negotiable invariants

Either option must retain all of the following:

1. rollback never deletes an attendance parent, calculation, segment, source
   item, operation, or history row;
2. the only restore source is the immutable target-level
   `parent_preimage_snapshot`, never mutable parent fields;
3. the batch, operation identities, target rows, and preimage are locked and
   rechecked in the section 9 order before reversal DML;
4. a later punch/correction or wrong current pointer aborts the whole batch
   with `IMPORT_ROLLBACK_SUPERSEDED` and zero writes;
5. a reversible pre-W4 batch without an immutable preimage returns
   `IMPORT_ROLLBACK_PREIMAGE_UNAVAILABLE` and zero writes;
6. first-import rollback still points the parent at an authoritative retired
   reversal with the exact imported after-image;
7. operator retirement is not reversible through this exception;
8. no ordinary update can clear a W4 pointer or change owner/visibility without
   a just-appended, same-record, same-org import rollback reversal and a
   database-verifiable current-transaction restore witness;
9. a later non-rollback source may reactivate an import rollback tombstone only
   from durable evidence.
10. no application assertion, mutable parent field, session GUC, nullable
    reference, or unconstrained JSON search is sufficient to authorize the
    pointer-clear exception;
11. after an exact legacy restore, the next authoritative source has one
    database-enforced predecessor and cannot append a duplicate baseline.

## 3. Decision `OD-W4C-55`

### Option (a): exact frozen tuple plus a durable lineage bridge (recommended)

Preserve section 7.9 literally and amend sections 7.3, 7.5, and 7.8 together.
Add two append-only relations.

`attendance_import_rollback_commands` binds one canonical direct rollback
operation to exactly one canonical source batch:

| Column | Contract |
| --- | --- |
| `org_id`, `rollback_operation_id` | composite primary key |
| `rollback_entrypoint` | required and fixed to `import_rollback`; with the preceding fields, composite FK to `attendance_result_operations` |
| `source_batch_entrypoint`, `source_batch_id` | required; entrypoint closed to `import_batch|integration_batch`; composite FK to `attendance_result_operation_batches` |
| `writer_xid` | required `xid8`, defaulted by the database from `pg_current_xact_id()` |
| actor/correlation/created fields | append-only audit, copied from the canonical rollback operation |

The primary key makes a rollback operation bind exactly one source batch.
Per-record restoration then uses
`attendance_import_rollback_restore_witnesses`:

| Column | Contract |
| --- | --- |
| `org_id`, `attendance_record_id` | required; composite parent identity |
| `reversal_calculation_id` | required PK component; same-record/org FK to the just-appended reversal |
| `reversed_calculation_id` | required same-record/org FK to the imported calculation being reversed |
| `rollback_operation_id`, `source_batch_entrypoint`, `source_batch_id` | required composite FK to the one rollback-command header; no per-record batch substitution |
| `frozen_preimage_fingerprint` | required 64-lowercase-hex hash of the exact closed present preimage |
| `writer_xid` | required `xid8`, defaulted by the database from `pg_current_xact_id()` |
| actor/correlation/created fields | append-only audit, copied from the canonical rollback operation |

Both relations reject UPDATE, DELETE, and TRUNCATE. Their FKs and constraint
triggers prove all of the following:

1. `OLD.projection_owner='w4'` and `OLD.current_calculation_id` is the
   authoritative import calculation being reversed;
2. the rollback-command header, witness, exactly one higher-version
   authoritative reversal, and parent restore are written by the same
   transaction: both stored XIDs equal `pg_current_xact_id()` at the parent
   update;
3. that reversal has
   `entrypoint='import_rollback'`,
   `outcome='reversed'`,
   `outcome_reason_code='import_rollback_reversal'`, and supersedes the old
   current calculation;
4. the reversal and reversed calculation equal the witness FKs; the reversed
   calculation has non-null `source_batch_id`, and its calculation entrypoint
   maps exactly to the header's batch entrypoint:
   `legacy_import -> import_batch` or
   `integration_sync -> integration_batch`. Equality between the two distinct
   enum domains is never asserted;
5. the reversed calculation's source batch ID equals the header's source batch
   ID. The source batch exists in `attendance_result_operation_batches`, the
   rollback operation exists in `attendance_result_operations`, and a deferred
   commit-time constraint requires both canonical rows to be `completed`;
6. the reversed import calculation carries
   `parent_preimage_snapshot.posture='present'`,
   `projectionOwner='legacy_untracked'`, and
   `currentCalculationId=NULL`;
7. the preimage is an exact closed shape. Its stored compatibility fingerprint
   and the witness fingerprint both equal the domain-separated SHA-256 of the
   frozen projection, owner, pointer, visibility state, and visibility reason;
8. `NEW` equals the frozen preimage byte-for-byte for every daily projection,
   owner, pointer, visibility state, and visibility reason field;
9. the reversal's projected fields equal the same frozen projection, its
   `projected_daily_fingerprint` equals the validated preimage projection
   fingerprint, its `projection_effect` matches the frozen visibility, and its
   `restores_calculation_id` is null because the frozen pointer was null;
10. null references, a fabricated source-batch ID, reuse of one rollback
    operation for another batch, a previously committed header/witness, or a
    witness from another record/org/transaction cannot satisfy the exception.

The pointer guard permits `w4 -> legacy_untracked` only by joining this exact
witness and rollback-command header and requiring both `writer_xid` values to
equal the current transaction. A deferred constraint rechecks the final parent
tuple, reversal, one-to-one batch binding, rollback operation, and transaction
witness at commit. The guard rejects every other transition. This is not a
generic pointer-clear API.

Amend section 7.8 to split the null-pointer legacy state:

1. **Virgin legacy parent:** no restore witness and no authoritative history.
   The existing rule remains: append one baseline from the exact locked legacy
   projection and make the first authoritative normal calculation supersede
   that baseline.
2. **Witnessed legacy restore:** the latest immutable restore witness is the
   lineage bridge. The next authoritative normal calculation must supersede
   exactly that witness's reversal calculation and must not append a baseline.

A database constraint trigger applies this split under the locked parent:

- for a witnessed legacy restore, it requires the selected witness to have the
  highest import-rollback reversal version for the record and requires the new
  current-changing normal calculation's predecessor to equal that reversal;
- later immutable `review_required` observations with
  `projection_effect='none'` may exist after the bridge. They preserve the
  legacy parent tuple, do not become a pointer, do not consume or replace the
  bridge, and are not valid predecessors for the next current-changing result;
- any later baseline, completed calculation, reversal, or other
  current-changing/unclassified row while the parent remains in witnessed
  legacy state fails closed;
- for a virgin legacy parent, it retains the existing same-transaction baseline
  requirement;
- if W4 history exists without one of those two provable shapes, it fails
  closed.

The writer never derives currentness from historical rows. The parent remains
truthfully legacy-owned with a null current pointer; the witness supplies only
the next immutable lineage predecessor. Mutable `first_in_at`/`last_out_at`,
mutable `source_batch_id`, and a duplicate baseline are forbidden sources.

This option preserves the truth of the frozen preimage and makes the
owner/pointer tuple mean the same thing before and after rollback.

### Option (b): no-return invariant wins; change rollback ownership semantics

Keep the current database guard unchanged. Update sections 7.8, 7.9, and 12.4
so an authoritative update-import rollback:

- copies the exact frozen legacy daily projection into the reversal;
- keeps `projection_owner='w4'`;
- points `current_calculation_id` to the new reversal;
- records the prior legacy owner/null pointer only as historical preimage
  metadata, not as the restored current tuple.

This option is simpler for current DDL, but it changes the already-RATIFIED
meaning of "restore the pre-batch owner/current pointer" and makes a legacy
parent become permanently W4-owned after a batch that was later rolled back.

## 4. Required implementation and tests for option (a)

If option (a) is selected, W4C-3a cannot complete unless all of these
independent legs pass:

1. **Positive update restore:** legacy-owned active parent -> authoritative
   import -> rollback restores the exact legacy owner/null pointer, projection,
   and visibility. The frozen compatibility fingerprint is preserved in the
   immutable preimage/witness and recomputes from the restored tuple; it is not
   claimed to be a mutable parent column.
2. **Retired tuple restore:** a legacy-owned retired review/import tombstone
   remains retired with its exact reason and projection.
3. **First-import separation:** absent preimage still produces a W4-owned
   retired reversal; it cannot use the legacy exception.
4. **Missing witness/reversal:** direct pointer clear without both the
   current-transaction witness and just-appended reversal fails.
5. **Wrong reversal kind:** approval/operator/manual reversal cannot use the
   exception.
6. **Wrong lineage:** reversal that does not supersede `OLD.current` fails.
7. **Projection drift:** changing any frozen status/time/minute,
   owner/pointer/visibility/reason field fails.
8. **Cross-org/record:** a reversal or preimage from another org/record fails.
9. **Stale/fabricated witness:** a previously committed witness, nullable
   linkage, fabricated batch UUID, wrong source-batch entrypoint, incomplete
   source batch, or incomplete rollback operation fails independently.
10. **Cross-batch command reuse:** one completed direct rollback operation
    cannot authorize witnesses for two source batches; removing the
    rollback-command header or its uniqueness makes this leg fail.
11. **Mutation:** removing the current-XID, calculation-to-batch entrypoint
    mapping, reason, source-batch, operation, closed-preimage,
    projection-effect, or fingerprint-equality predicate makes exactly its
    negative leg fail.
12. **Next source:** after exact legacy restore, a valid punch/import
    supersedes exactly the latest witnessed reversal, does not treat it as a
    current pointer, does not infer legacy evidence, and does not append a
    duplicate baseline.
13. **Review pass-through:** one or more intervening authoritative/shadow
    `review_required` rows preserve the legacy tuple and bridge; the next
    completed result still supersedes the witnessed reversal. Treating a
    review row as the predecessor or as consuming the bridge fails.
14. **Next-source negatives:** a stale witness, non-latest reversal, null/wrong
    predecessor, later unaccounted calculation, or attempted second baseline
    fails at the database boundary.
15. **Atomicity:** injected failure between command-header insert, reversal
    insert, witness insert, parent restore, operation completion, and batch
    completion leaves none of those effects committed.
16. **Two-connection race:** a later valid source and rollback in both commit
    orders produce exactly one valid next state; the waiter rechecks and writes
    no conflicting result.
17. **Virgin separation:** an ordinary never-W4 legacy parent still receives
    exactly one baseline; a restore witness cannot be fabricated to skip it.

## 5. Recommendation

Select `OD-W4C-55=(a)`.

The design lock repeatedly treats the frozen preimage as the sole rollback
truth. A narrow, transaction-bound database exception plus an immutable lineage
bridge preserves that decision without opening a generic pointer-clear path or
inventing currentness from history. Option (b) is viable only if the owner
intentionally changes the product meaning of rollback ownership.

## 6. Execution boundary

Before RATIFY:

- pure W4C-3a planning, fingerprinting, and no-DML tests may continue;
- no import rollback DML, pointer-trigger change, route cutover, or debt claim
  removal may land.

After owner RATIFY of the exact merged amendment SHA:

- W4C-3a may implement only the selected option and the gates above;
- the W4C-3a implementation still requires an independent exact-head
  adversarial gate with zero P1/P2 and a separate owner merge decision;
- W4C-3b+, flags, deployment, soak, and issue closure remain outside scope.
