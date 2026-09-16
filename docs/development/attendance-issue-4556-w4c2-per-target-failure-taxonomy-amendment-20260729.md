# Attendance Issue #4556 W4C-2 Per-Target Failure Taxonomy Amendment

> Status: **RATIFIED** (option (a) implementation and its independent gate only)
>
> Date: 2026-07-29
>
> Decision: `OD-W4C-54` — resolved `(a)`
>
> Ratified: 2026-07-29, merged SHA
> `548d9f35974cfd50a5cc4c54a76d4a3df01a198e` — the commit that landed this
> document on `main` (PR 4669) — with `OD-W4C-54=(a)`. Durable owner record
> (relayed transcription): PR 4669 comment `5110505124`,
> <https://github.com/zensgit/metasheet2/pull/4669#issuecomment-5110505124>.
>
> Scope of what the ratification authorizes: resume W4C-2 **only** to implement
> and independently gate option (a) — keep the production permanent-rejection
> allowlist empty, keep production failed-outcome callsites at zero, exercise
> the failed-outcome writer through the named real-DB contract fixture, and
> record the run/event/promotion pinning residual honestly.
>
> Ratification authorizes the slice it names and nothing downstream: this
> document still does not authorize merging parent PR 4612 or PR 4668, starting
> W4C-3a or any later W4C slice, enabling flags, deploying, using customer data,
> running the W4C-5 staging soak, or closing issue 4556. Each of those remains
> separately gated.
>
> **Status reconciliation note (2026-08-09):** this header previously read
> `PROPOSED`. That was in-repo status drift, not a pending decision — the owner
> record cited above predates this correction and is unchanged by it. This edit
> transcribes that existing record and confers no new authority; the linked
> owner comment is the authority, not this document and not the pull request
> carrying this edit. If any line here misstates that record, it must not merge.

## 0. Why this amendment exists

The RATIFIED W4C-2 scheduled-run amendment chose
`OD-W4C-50=(a)`: durable per-target outcomes may be `completed` or `failed`,
and a failed outcome must pair with a canceled per-user operation and the
closed reason code
`ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED`.

The durable owner record is PR #4617 comment `c-5090978124` (2026-07-27):
it RATIFYs amendment merge
`d1bed9d640f8ee634975c70a6c981d2f49a97832` together with provenance erratum
`d449aa7e6d02f94df2738a77cafffa778b12fde0`, and selects Bundle A including
`OD-W4C-50=(a)`. The source amendment's own header carried a point-in-time
`PROPOSED` header because the owner decision happened after that document
merged; that stale header was never itself the ratification evidence.
(Status reconciliation, 2026-08-09: that stale header has since been corrected
to `RATIFIED` against this same durable record. The reasoning in this paragraph
is unchanged — the comment, not either header, is the evidence.)

PR #4612 implements that representation, writer, integrity checks,
finalization behavior, and run-level event counts. Its production scheduled
loop currently records only `completed` outcomes. This is not merely a missing
branch. The governing text names "a deterministic, fail-closed rejection, not
a transient error" but does not identify which production decisions belong to
that class.

An implementation that catches an arbitrary exception and records `failed`
would silently turn authorization failures, suspension, contention, database
errors, and adapter defects into permanent business outcomes. An
implementation that moves authorization after claim merely to manufacture a
canceled operation would weaken the authorization boundary. Both would satisfy
the shape of `OD-W4C-50=(a)` while violating its safety intent.

This amendment closes that ambiguity before any production failed-outcome
producer is added.

## 1. Evidence boundary

The following statements were re-derived against:

- `origin/main` `dd693d8ca65bee182e1fdd14212cead45fe7c947`;
- PR #4612 head `0bed4dd21484674b1fdc4e510dd8d4f8dbf1e7f0`;
- recovery child PR #4668 head
  `c3198eec2ab4beb9eb79d0c305609b380837ddce`.

They are point-in-time evidence, not merge authorization.

### 1.1 What is already implemented

- `w4c2-scheduled-run.ts` defines the closed outcome union, validates the sole
  failed reason code, rejects non-running runs, and appends one outcome row.
- `w4c0-operation-registry.ts` exposes a source-free
  `cancelAttendanceResultOperationV1` transition from `claimed` to `canceled`.
- Finalization checks outcome completeness and operation/outcome agreement.
- Real-database tests exercise the schema, writer, finalizer, and malformed
  pairs. The current failed fixture performs its cancel with raw SQL rather
  than the registry helper; section 4 requires the helper-bound contract leg
  before PR #4612 may be presented for merge.

### 1.2 What is not implemented

The production loop in `w4c2-live-scheduled-boundary.ts`:

1. performs operation preflight;
2. rejects suspension or authorization/liveness failures before source DML;
3. checks that the run remains `running`;
4. calls `applyScheduledAbsenceLegacy`;
5. seals the operation `completed`;
6. records `terminalOutcome='completed'`.

There is no production branch that decides a target is a permanent rejection,
cancels its claimed operation before source DML, records `failed` in the same
transaction, and continues with sibling targets.

### 1.3 Current classification inventory

No current production condition is proven to be a safe permanent per-target
rejection:

| Condition | Required behavior | Why it is not `failed` |
| --- | --- | --- |
| actor or target authorization/liveness rejection | reject before claim/source DML | Moving it after claim would weaken authorization and change existing behavior. |
| org suspended or rollout posture not executable | defer or fail closed with zero source DML | It is a rollout state, not a permanent target fact. |
| serialization failure, deadlock, lock contention, busy run | roll back and retry | These are transient by definition. |
| run no longer `running` | reject/no-op according to the existing run state | It is a run-level race, not a new per-target business outcome. |
| target-set or posture drift | fail-closed remediation | Existing W4C-2 recovery/abandonment rules govern it. |
| source adapter, database, or programming exception | roll back and surface error | Treating defects as business failure would hide data loss. |
| authoritative mode not delivered | fail closed | It is an unavailable execution capability, not a target rejection. |
| zero inserted rows | normal `completed` result with `inserted=false` | Existing wire behavior already treats this as a successful no-insert result. |
| unresolved attribution or review-required calculation | record its existing review posture | It is not a rejected scheduled target. |

The current permanent-rejection allowlist is therefore empty.

That empty allowlist has an operational cost that must not be hidden: when one
target repeatedly hits a deterministic preflight rejection, the per-target
transaction throws, the outer target loop does not continue to siblings, and
the run remains `running` with an outstanding target. A later resume retries
the same target. Unless the condition changes or an operator explicitly
abandons the run, finalization and both run-level events remain blocked; under
the promotion rules this can also block shadow-to-authoritative promotion.
This is the same run-pinning consequence that motivated choosing
`OD-W4C-50=(a)` over `(b)`. Option `(a)` below accepts it as a declared
temporary residual; it does not claim that the motivating production failure
case is solved.

## 2. Non-negotiable invariants

These invariants apply under either decision:

1. Authorization and liveness checks remain before any operation claim or
   source DML. This amendment never moves or weakens them.
2. A permanent target rejection, if one is later admitted, is decided only
   after a verified scheduled item identity exists and before any source DML.
3. The operation cancel and failed outcome insert occur in the same
   transaction. The transaction then commits before the outer loop proceeds to
   the next target.
4. A transient, infrastructure, adapter, database, or programming error rolls
   back the entire per-target transaction. It never writes a failed outcome.
5. No savepoint may preserve a claim or failed outcome after source DML has
   started. Post-source errors roll back.
6. The outer scheduled loop continues with sibling targets only after a
   recognized permanent rejection was durably committed.
7. The failed reason-code set remains closed. Adding a reason or predicate is a
   contract amendment, not a local catch clause.
8. Generic `catch`, HTTP status ranges, error-message matching, or
   `instanceof Error` are forbidden as permanent-rejection classifiers.
9. Run-level events remain derived from durable terminal outcomes and are
   emitted only by finalization.

## 3. Decision `OD-W4C-54`

### Option (a): ratify an empty production allowlist now (recommended)

Interpret `OD-W4C-50=(a)` as ratifying the durable representation and
finalization semantics without requiring the implementation to invent a
production permanent-rejection predicate.

Under this option:

- the production allowlist is explicitly empty;
- no production call site may write `terminalOutcome='failed'`;
- the failed writer remains a module capability exercised by real-database
  contract tests with a verified operation witness;
- gate 20 proves the database and finalization mechanics, but must label its
  failed target as a contract fixture rather than a production-path replay;
- PR #4612 cannot claim a live failed-outcome producer;
- a future concrete business predicate requires a new amendment naming the
  predicate, authority source, pre-source proof, retry classification, and
  discriminating production-path tests.
- one repeatedly rejected target can still pin the run, suppress run-level
  events, and block promotion until the condition changes or an operator
  abandons the run. This is a declared residual, not a completed production
  failure path.

This option is the shortest safe route to internal QA because it removes an
unimplementable completion claim without weakening runtime behavior. It closes
the representation/finalization slice, not the production permanent-rejection
capability.

### Option (b): define the first production permanent-rejection predicate now

Do not merge PR #4612 as complete until a follow-up revision identifies and
implements at least one concrete, irreversible predicate owned by the
scheduled boundary.

No such predicate is named today. In particular, "the frozen target ceased to
be an active member of the org after the run was created" is **not** an
admissible default candidate:

- `admin_run` currently includes target liveness in preflight authorization,
  so moving it after claim would cross the authorization boundary forbidden by
  sections 1.3 and 2;
- the cron `org_scheduler` authority intentionally waives per-subject
  predicates, so adding this check would reject targets that succeed today;
- membership can be restored, so retry can make the condition succeed and the
  fact is not proven permanent;
- reclassifying liveness as "eligibility" does not make the authorization
  change safe.

Choosing `(b)` authorizes a design round only. It does not authorize moving
authorization, introducing a savepoint, or implementing the candidate by
guesswork. If no predicate can satisfy every section 5 gate without changing
authorization or currently successful behavior, the design round must return
`NO-ADMISSIBLE-PREDICATE`; it must not manufacture one.

### Recommendation

Choose **(a)**. It preserves every shipped authorization and transaction
boundary, makes the current implementation claim honest, and lets QA exercise
the durable scheduled-run, recovery, replay, concurrency, and finalization
paths now. Its cost is explicit: the run-pinning case remains a residual and
must stay visible in the verification MD and issue closeout ledger. Option
`(b)` should be selected only if a current product requirement names a
concrete permanent per-target rejection that must ship in this slice.

## 4. Completion gates for option (a)

Before PR #4612 may be presented for merge:

1. Production search proves zero
   `recordAttendanceScheduledRunTargetOutcomeV1(..., { terminalOutcome:
   'failed', ... })` call sites.
2. A real-database contract test creates a verified scheduled operation,
   calls `cancelAttendanceResultOperationV1` before source DML, records the
   closed failed outcome in the same transaction, and finalizes a mixed
   completed/failed run with correct counts.
3. The same test proves an uncanceled/failed and canceled/completed mismatch
   fails at commit.
4. Mutating the failed reason code outside the closed set fails.
5. A source-DML sentinel proves the failed contract fixture performs no source
   DML.
6. Existing production scheduled-path tests prove completed, replay,
   suspension, contention, recovery, and legacy-byte-compatibility behavior is
   unchanged.
7. PR body and verification MD state that the production permanent-rejection
   allowlist is empty and that the failed path is contract-tested, not live.
8. An independent exact-head review returns zero P1/P2.

## 5. Additional gates before any future non-empty allowlist

A later amendment must name, for every admitted predicate:

1. the authoritative fact and org anchor;
2. the exact point after verified claim and before source DML where it is
   decided;
3. why retry cannot make the predicate succeed;
4. why it is not an authorization, suspension, contention, or infrastructure
   failure;
5. the closed reason-code mapping;
6. same-transaction cancel/outcome proof;
7. a positive production-path test;
8. a neighboring transient/error negative test that rolls back;
9. a sibling-continuation test;
10. a mutation that broadens the classifier and must fail.
11. a before/after matrix showing whether the predicate newly rejects a target
    that succeeds today, separately for `cron` and `admin_run`;
12. proof that restoration or retry cannot make the same run's target
    admissible; if it can, the predicate is not permanent and cannot enter the
    allowlist.

## 6. Required owner record

RATIFY must bind the exact merged SHA of this document and state one of:

- `OD-W4C-54=(a)`: empty production permanent-rejection allowlist; or
- `OD-W4C-54=(b)`: design the first concrete predicate before W4C-2 completion.

No agent-authored statement may substitute for that owner record.
