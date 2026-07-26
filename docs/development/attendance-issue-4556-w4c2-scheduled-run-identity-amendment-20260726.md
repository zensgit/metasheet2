# Attendance Issue #4556 W4C-2 Scheduled-Run Identity Amendment (section 7.1a)

> Status: **PROPOSED** — requires owner RATIFY of the exact merged SHA before
> any runtime code is written.
>
> Date: 2026-07-26
>
> Governing lock:
> `attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`
> at merged commit `d6ac495b947c0b42ed7bee66d9531fbe25a486ca`
> (file blob `528c6521d152f84bc067247b5f1c134cfb1183d3`, identical on
> `origin/main` `97cf6203397b958c78c646f09176b93b00d279aa` and on the held
> W4C-2 head `b5db447ae18700f023d8915353f2aee109121eb4`).
> `OD-W4C-1..42` were RATIFIED at `a3e5765727ca608e8c49c7a44a025e6e4aae5d40`.
>
> Companion amendment:
> `attendance-issue-4556-w4c0-identity-proof-amendment-20260725.md`,
> RATIFIED at `3fa1ae3421744fcec9a18c4f87153281c59ec6b2`, `OD-W4C-43=(a)`.
>
> Scope: the section 7.1a outbox **identity model**, the `scheduled`
> entrypoint's **durable run identity**, the reserved class-`01` advisory
> class, and the section 12.3 scheduled gates. Nothing else in the lock is
> touched.
>
> Owner authorization basis: PR #4595 `c-5082275704` (restricted resumption:
> "W4C-2 修复 + 新 exact-head 独立门审" only) and PR #4612 `c-5082785641`
> (owner ruling **G-2 = (b2)**, which overturned `c-5082614287` = the
> `(c)-plus` classification exemption).
>
> Runtime posture: PR #4612 stays **Draft** under
> **OWNER-AUTHORIZATION-HOLD**. This amendment contains **no runtime code**
> and authorizes **no** implementation, ready-for-review transition, arming,
> merge, flag enablement, org enablement, deployment, staging soak, or
> issue closure. The `(c)-plus` landing was already reverted on that branch
> by `ad55410277443603d073040a67fe36de2a965c62`.

## 0. Why this amendment exists

### 0.1 The finding and the rejected shortcut

The W4C-2 exact-head gate review raised **P1-2**: the `scheduled` entrypoint
reaches `emitEvent` with two run-level events that are neither in the
section 7.1a closed event-kind set nor durably enqueued, while section 7.1a
(lock line 1317ff) makes W4C-2 responsible for the live/scheduled event
cutover and section 12.3 (lock line 2672ff) separately requires
"live/**scheduled** outbox rows are inserted before operation seal".

This lane then proposed `(c)-plus` — classify the two run-level events as
non-operation lifecycle signals and exempt them. The owner **rejected** it
for three reasons, all of which this lane accepts without argument:

1. **The RATIFIED lock is not ambiguous.** Both anchors above were already
   quoted by the gate finding itself. `(c)-plus` was therefore a **contract
   downgrade**, not a classification erratum.
2. **A W4C-0 closed-set omission does not prove the lock wrong.**
   `packages/core-backend/src/attendance/w4c0-operation-contract.ts:92`
   omits `attendance.absence.generated`; that is evidence of an **inventory
   defect in W4C-0**, not evidence that the event was meant to be excluded.
3. **`(c)-plus` missed the second run-level event.** The scheduled path emits
   **two** events — `plugins/plugin-attendance/index.cjs:21243`
   (`attendance.absence.generated`) and
   `plugins/plugin-attendance/index.cjs:21249`
   (`attendance.work_date.review_required`). The second carries
   pending-human-review information and must not be demoted to best-effort
   without proof about its consumers and durable state. This lane never
   examined it — a substantive omission.

Option `(a)` (turn one run into N per-user events) was also rejected: it
changes `total` semantics, consumer trigger counts, and alerting meaning, so
it is a public wire-semantics break.

### 0.2 Verified current state at `97cf6203397b958c78c646f09176b93b00d279aa`

- `plugins/plugin-attendance/index.cjs:21242-21256`: after
  `generateAbsenceRecords(...)`, `emit('attendance.absence.generated', {orgId,
  workDate, total: rows.length})` is unconditional, and
  `emit('attendance.work_date.review_required', {orgId, workDate, total,
  reasons})` fires only when `reviewRequired.length > 0`. Both are
  synchronous best-effort; a crash between commit and emit loses them.
- `packages/core-backend/src/attendance/w4c0-operation-contract.ts:92-99`:
  the closed kind set is exactly `attendance.punched`,
  `attendance.requested`, `attendance.request.updated`,
  `attendance.request.cancelled`, `attendance.resolved`,
  `attendance.outdoorPunch.requested` — neither run-level kind is present.
- `packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:210-216`
  holds a **second, byte-identical copy** of that list (the TS file's comment
  at line 85-90 already warns that both copies must be reconciled).
- Same migration, lines 578-600: `attendance_result_event_outbox` has
  `operation_id uuid NOT NULL` with **no** foreign key to
  `attendance_result_operations`, and one unique key
  `uq_areo_identity (org_id, entrypoint, operation_id, event_kind)`. Nothing
  mechanically stops a caller from writing a **run** UUID into
  `operation_id`.
- The held W4C-2 branch's scheduled path
  (`packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts`,
  head `b5db447ae18700f023d8915353f2aee109121eb4`) already runs **one durable
  per-user operation per target user** with `identity_source_kind='scheduled'`
  derived from `(runId, userId, workDate)`. That part is correct and this
  amendment does not change it. What is missing is any durable **run**
  object: `runId` is a pure in-process derivation
  (`deriveAttendanceScheduledRunIdV1`) with no row, no counters, no terminal
  state, and no enqueue site.
- In-repo subscribers to either event: none found in runtime code at this
  SHA; only
  `packages/core-backend/tests/integration/attendance-work-date-resolver-w2.db.test.ts:271,332`
  assert emission. The events are published on the public plugin event bus,
  so external subscribers **cannot be enumerated from this repository** —
  which is precisely why they may not be demoted.

### 0.3 A second, independent defect this amendment closes

Even ignoring durability, the held branch's scheduled path folds its public
`total` from an **in-memory** array that deliberately excludes replayed users
(`if (outcome.inserted && outcome.mode !== 'replay') insertedRows.push(...)`).
A run interrupted after some users committed and then resumed would therefore
emit a **smaller** `total` than the same run would have emitted uninterrupted.
Under `(b2)` the counts come from durable, immutable per-user evidence, so a
resumed run emits the same bytes an uninterrupted run would have emitted.

### 0.4 What `(b2)` is

`(b2)` **completes** the durability contract: it adds the run-level identity
that section 7.1a's `(org_id, entrypoint, operation_id, event_kind)` shape
could not express, so that a run-level event can be delivered exactly once,
durably, with unchanged payload bytes and unchanged "one run, one event"
external semantics. It weakens nothing.

## 1. Locked correction

This amendment supersedes only these parts of the governing lock:

- section 7.1a's single-shape outbox identity
  `(org_id, entrypoint, operation_id, event_kind)`, its closed event-kind
  set, and its "each W4-covered **source operation** ... stores one closed
  event row in the same transaction as its operation seal" as the *only*
  enqueue shape;
- section 7.1's sentence "Scheduled absence gains a durable
  scheduled-run/user/date source row", which is refined into a durable run
  row plus immutable target rows plus the unchanged per-user operations;
- section 8.2's lock order and step 14, by inserting the reserved class-`01`
  run lock and by adding one new, strictly non-source **finalization
  transaction** shape;
- `OD-W4C-40`'s "class `01` is reserved", which this amendment assigns;
- the section 12.3 scheduled gates affected by the above.

Everything else — advisory hash bytes, the class-`00`/`10`/`11` formulas and
tuples, the W4C-0 verified-identity factory and its source matrix, the three
UUIDv5 namespaces, per-user scheduled operation derivation, posture
normalization, batch limits, and every unrelated gate — remains **unchanged**.

### 1.1 Durable scheduled-run row

Create `attendance_scheduled_runs`. Draft shape (column names and constraint
names are part of this lock; types are PostgreSQL):

```sql
CREATE TABLE attendance_scheduled_runs (
  run_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 text NOT NULL,
  entrypoint             text NOT NULL,      -- fixed 'scheduled'
  initiator              text NOT NULL,      -- closed: 'cron' | 'admin_run'
  work_date              date NOT NULL,
  generation             integer NOT NULL,   -- 1-based per (org,initiator,work_date)
  accepted_write_posture text NOT NULL,      -- closed: 'shadow' | 'authoritative'
  target_set_fingerprint text NOT NULL,      -- lowercase sha-256 (section 1.3)
  expected_user_count    integer NOT NULL,   -- frozen at creation
  review_count           integer NOT NULL,   -- frozen at creation
  state                  text NOT NULL DEFAULT 'running',
  completed_user_count   integer,            -- written only at finalization
  generated_count        integer,            -- written only at finalization
  abandon_reason_code    text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  finalized_at           timestamptz,
  CONSTRAINT uq_asr_run_org       UNIQUE (run_id, org_id),
  CONSTRAINT uq_asr_run_org_date  UNIQUE (run_id, org_id, work_date),
  CONSTRAINT uq_asr_generation    UNIQUE (org_id, initiator, work_date, generation),
  CONSTRAINT chk_asr_entrypoint   CHECK (entrypoint = 'scheduled'),
  CONSTRAINT chk_asr_initiator    CHECK (initiator IN ('cron','admin_run')),
  CONSTRAINT chk_asr_posture      CHECK (accepted_write_posture IN ('shadow','authoritative')),
  CONSTRAINT chk_asr_state        CHECK (state IN ('running','completed','abandoned')),
  CONSTRAINT chk_asr_fingerprint  CHECK (target_set_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_asr_counts       CHECK (generation >= 1
                                     AND expected_user_count >= 0
                                     AND review_count >= 0),
  CONSTRAINT chk_asr_terminal_shape CHECK (
       (state = 'running'   AND completed_user_count IS NULL
                            AND generated_count IS NULL
                            AND finalized_at IS NULL
                            AND abandon_reason_code IS NULL)
    OR (state = 'completed' AND completed_user_count = expected_user_count
                            AND generated_count IS NOT NULL
                            AND generated_count <= expected_user_count
                            AND finalized_at IS NOT NULL
                            AND abandon_reason_code IS NULL)
    OR (state = 'abandoned' AND completed_user_count IS NOT NULL
                            AND generated_count IS NULL
                            AND finalized_at IS NOT NULL
                            AND abandon_reason_code IS NOT NULL)
  ),
  CONSTRAINT chk_asr_abandon_reason CHECK (
    abandon_reason_code IS NULL
    OR abandon_reason_code IN ('ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED')
  )
);

CREATE UNIQUE INDEX uq_asr_one_running
  ON attendance_scheduled_runs (org_id, initiator, work_date)
  WHERE state = 'running';
```

Rules:

- `run_id` is a **server-minted** UUID. It is durable identity, not a
  derivation; the held branch's `deriveAttendanceScheduledRunIdV1` derivation
  is superseded and must not survive implementation. A restarted process
  **reads** the running run instead of re-deriving an ID.
- At most one `running` run per `(org_id, initiator, work_date)` — enforced by
  the partial unique index as a corruption backstop, with the class-`01`
  advisory lock (section 1.6) as the expected serialization path. Raw `23505`
  is never a control path.
- `generation` is allocated under that advisory lock as
  `1 + max(generation)` for the key. A fresh invocation after a terminal run
  starts generation `n+1`; this preserves today's behavior that a repeated
  `skipDedup` invocation produces another run and another event.
- `accepted_write_posture` is **frozen at creation** and immutable, exactly
  like the P07 job's field. Resuming a run under a different resolved posture
  is fail-closed remediation, never a silent rebase.
  `legacy_projection_only` and `suspended` create **no** run row (sections
  1.9).
- States are closed to `running|completed|abandoned`; only
  `running->completed` and `running->abandoned` are legal. `running` is the
  only non-terminal state and is always recoverable (section 1.7), so there is
  no stuck absorbing state.
- `abandoned` is an explicit operator remediation terminal state. It writes
  **no** outbox row and no source DML. It exists so a run whose targets can
  never complete cannot pin the partial unique index forever.
- Rows reject `DELETE`/`TRUNCATE`. An `UPDATE` guard trigger permits changes
  only to `state`, `completed_user_count`, `generated_count`,
  `abandon_reason_code`, `finalized_at`, and only along a legal transition
  out of `running`; every other column is frozen after insert.
- `expected_user_count` equals the number of `target_kind='generate'` target
  rows; `review_count` equals the number of `target_kind='review'` target
  rows. Both are frozen at creation because both are fully known then. They
  are also constrained to match the actual target rows by a deferred
  commit-time constraint trigger, so an implementation cannot commit a run
  whose frozen counts disagree with its target rows.

### 1.2 Immutable run target rows

```sql
CREATE TABLE attendance_scheduled_run_targets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             text NOT NULL,
  run_id             uuid NOT NULL,
  work_date          date NOT NULL,
  ordinal            integer NOT NULL,     -- canonical emission order, 0-based
  user_id            uuid NOT NULL,
  target_kind        text NOT NULL,        -- closed: 'generate' | 'review'
  review_reason_code text,                 -- non-null iff target_kind='review'
  operation_id       uuid,                 -- non-null iff target_kind='generate'
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_asrt_ordinal UNIQUE (org_id, run_id, ordinal),
  CONSTRAINT uq_asrt_user    UNIQUE (org_id, run_id, user_id),
  CONSTRAINT fk_asrt_run FOREIGN KEY (run_id, org_id, work_date)
    REFERENCES attendance_scheduled_runs (run_id, org_id, work_date),
  CONSTRAINT chk_asrt_ordinal     CHECK (ordinal >= 0),
  CONSTRAINT chk_asrt_kind        CHECK (target_kind IN ('generate','review')),
  CONSTRAINT chk_asrt_review_pair CHECK ((target_kind = 'review')   = (review_reason_code IS NOT NULL)),
  CONSTRAINT chk_asrt_op_pair     CHECK ((target_kind = 'generate') = (operation_id IS NOT NULL)),
  CONSTRAINT chk_asrt_reason_closed CHECK (
    review_reason_code IS NULL OR review_reason_code IN (/* closed list, section 1.2.1 */)
  ),
  CONSTRAINT chk_asrt_derived_operation CHECK (
    target_kind <> 'generate'
    OR operation_id = attendance_w4_uuidv5(
         'e4363171-f53f-47d7-a074-607ef3fad391'::uuid,
         attendance_w4_scheduled_name_bytes(run_id, user_id, work_date))
  )
);
```

- Target rows are fully immutable: `UPDATE`, `DELETE`, and `TRUNCATE` are all
  refused by triggers. They are the run's frozen plan.
- `chk_asrt_derived_operation` reuses the **already RATIFIED** W4C-0 SQL
  UUIDv5 function and scheduled name-bytes helper
  (migration `zzzz20260725120000_...:241`, `:283`, `:545`) and the same namespace
  `ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1`. No new derivation is
  invented, and the per-user operation row's own
  `chk_aro_derived_identity` continues to bind the same tuple, so plan and
  execution cannot disagree.
- The FK deliberately carries `work_date` so the derived-identity CHECK can be
  purely declarative without trusting a denormalized copy.
- `ordinal` freezes the canonical order in which users were resolved, so the
  `reasons` array of `attendance.work_date.review_required` is reconstructed
  byte-stably at finalization regardless of restarts or row-visit order.

#### 1.2.1 Closed review reason codes

`review_reason_code` is closed to exactly the union of

- the frozen `REASON` map exported by
  `plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs:28` (the
  values the scheduled loop copies through today), and
- the three literals the scheduled loop supplies itself:
  `WORK_DATE_ATTRIBUTION_MISMATCH`, `WORK_DATE_ATTRIBUTION_AMBIGUOUS`,
  `WORK_DATE_ATTRIBUTION_UNRESOLVED`.

This creates a **third dual-copy** (resolver module + migration CHECK). The
implementation must add the same kind of parity gate required in section 1.5
and a negative gate proving an unlisted reason code is rejected at the DB
boundary rather than silently stored or coerced.

### 1.3 Target-set fingerprint

`target_set_fingerprint` is the lowercase hex SHA-256 of the canonical
NUL-separated byte string

```text
"metasheet2:attendance:scheduled-run-target-set:v1\0"
  + orgId + "\0" + initiator + "\0" + workDate
  + for each target in ascending ordinal:
      "\0" + ordinal(decimal, no padding)
      + "\0" + userId
      + "\0" + targetKind
      + "\0" + (reviewReasonCode ?? "")
```

Properties this lock requires:

- **Deterministic and order-sensitive.** It pins both membership and the
  emission order that the `reasons` array will reproduce.
- **Computed once**, from the exact frozen target rows, inside the run-creation
  transaction; never recomputed from mutable membership afterwards except for
  the resume equality check.
- **Resume guard, not a run key.** Its only enforcement role is section 1.7's
  resume check: a resumed `running` run whose recomputed target set differs in
  any byte is fail-closed remediation. It is *not* an input to `run_id`,
  because a roster change between two separate invocations is normal and must
  produce a new generation rather than a conflict.
- Ordinal is included explicitly so that two runs with the same membership but
  different resolution order are distinguishable.

### 1.4 Outbox identity becomes an explicit discriminated union

`attendance_result_event_outbox` gains an explicit discriminant and a second,
mutually exclusive identity column:

```sql
ALTER TABLE attendance_result_event_outbox
  ADD COLUMN identity_kind    text,      -- closed: 'operation' | 'scheduled_run'
  ADD COLUMN scheduled_run_id uuid,
  ALTER COLUMN operation_id DROP NOT NULL;

-- after backfill (section 1.10):
ALTER TABLE attendance_result_event_outbox
  ALTER COLUMN identity_kind SET NOT NULL,
  ADD CONSTRAINT chk_areo_identity_kind
    CHECK (identity_kind IN ('operation','scheduled_run')),
  ADD CONSTRAINT chk_areo_identity_operation
    CHECK ((identity_kind = 'operation')      = (operation_id IS NOT NULL)),
  ADD CONSTRAINT chk_areo_identity_run
    CHECK ((identity_kind = 'scheduled_run')  = (scheduled_run_id IS NOT NULL)),
  ADD CONSTRAINT chk_areo_identity_exclusive
    CHECK ((operation_id IS NULL) <> (scheduled_run_id IS NULL)),
  ADD CONSTRAINT fk_areo_operation
    FOREIGN KEY (org_id, entrypoint, operation_id)
      REFERENCES attendance_result_operations (org_id, entrypoint, operation_id),
  ADD CONSTRAINT fk_areo_scheduled_run
    FOREIGN KEY (scheduled_run_id, org_id)
      REFERENCES attendance_scheduled_runs (run_id, org_id),
  ADD CONSTRAINT chk_areo_kind_identity_map CHECK (
    CASE event_kind
      WHEN 'attendance.absence.generated'          THEN identity_kind = 'scheduled_run'
      WHEN 'attendance.work_date.review_required'  THEN identity_kind = 'scheduled_run'
      ELSE identity_kind = 'operation'
    END
  );

-- uq_areo_identity is a table CONSTRAINT, dropped only after the
-- replacement partial unique index below exists:
--   ALTER TABLE attendance_result_event_outbox
--     DROP CONSTRAINT uq_areo_identity;
CREATE UNIQUE INDEX uq_areo_operation_identity
  ON attendance_result_event_outbox (org_id, entrypoint, operation_id, event_kind)
  WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX uq_areo_run_identity
  ON attendance_result_event_outbox (org_id, entrypoint, scheduled_run_id, event_kind)
  WHERE scheduled_run_id IS NOT NULL;
```

**A run ID may never masquerade as a per-user operation ID.** Four independent
mechanical blocks, each separately mutation-provable:

1. **Referential.** `fk_areo_operation` did not exist before. A run UUID
   written into `operation_id` has no matching
   `attendance_result_operations` row and is rejected by the database.
   Symmetrically `fk_areo_scheduled_run` rejects a per-user operation UUID
   written into `scheduled_run_id`.
2. **Namespace.** A scheduled per-user operation ID is UUIDv5 over
   `ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1` and is verified by the
   existing `chk_aro_derived_identity`; a run ID is a random v4 with no
   derivation. Neither can satisfy the other's constraint.
3. **Kind map.** `chk_areo_kind_identity_map` forbids the two run-level kinds
   from ever carrying an `operation_id`, and forbids the six per-user kinds
   from ever carrying a `scheduled_run_id`.
4. **Type-level.** The TypeScript enqueue surface splits into two functions
   with **disjoint opaque witnesses** (section 1.4.1). A run witness is not
   accepted by the operation enqueue and vice versa; a bare UUID string is
   accepted by neither.

`chk_areo_delivered_pair`, the `pending|delivered` state machine, the
`attempts`/`next_attempt_at` fields, the immutability trigger, and the
`DELETE`/`TRUNCATE` refusals are unchanged and apply identically to run-level
rows.

#### 1.4.1 TypeScript surface

```ts
type VerifiedAttendanceScheduledRunIdentityV1 = Opaque<Readonly<{
  runId: CanonicalAttendanceScheduledRunIdV1
  org: VerifiedAttendanceOrgIdentityV1
  entrypoint: 'scheduled'
  initiator: 'cron' | 'admin_run'
  workDate: CanonicalAttendanceWorkDateV1
  generation: number
  targetSetFingerprint: string
}>>

rehydrateVerifiedAttendanceScheduledRunIdentityV1(durableRow):
  VerifiedAttendanceScheduledRunIdentityV1

buildAttendanceScheduledRunAdvisoryKey(
  key: CanonicalAttendanceScheduledRunKeyV1,   // (org, initiator, workDate)
): bigint

acquireAttendanceScheduledRunLock(
  trx,
  key: CanonicalAttendanceScheduledRunKeyV1,
): Promise<void>

enqueueAttendanceScheduledRunEventOutboxV1(
  trx,
  identity: VerifiedAttendanceScheduledRunIdentityV1,
  events: readonly AttendanceOutboxEventInputV1[],
): Promise<void>
```

- The run identity is minted **only** by rehydration from the committed,
  locked run row — there is no "create" factory that trusts caller input, so
  an outbox row cannot precede its run row.
- `enqueueAttendanceResultEventOutboxV1` keeps its current signature and its
  `requireVerifiedAttendanceOperationIdentityV1` strictness
  (`w4c0-operation-registry.ts:820-856`); it additionally sets
  `identity_kind='operation'` and rejects the two run-level kinds.
- `enqueueAttendanceScheduledRunEventOutboxV1` rejects everything except the
  two run-level kinds and fail-closes on `legacy_projection_only` exactly as
  the operation enqueue does today (`W4C0_OUTBOX_LEGACY_FORBIDDEN`).
- JSON clones, spreads, prototype lookalikes, and plain objects are rejected
  by both, per the W4C-0 amendment's witness doctrine.

### 1.5 Closed event-kind set extension and the two copies

`ATTENDANCE_W4_OUTBOX_EVENT_KINDS_V1` gains exactly two members:

```text
attendance.absence.generated
attendance.work_date.review_required
```

The list exists **twice** —
`packages/core-backend/src/attendance/w4c0-operation-contract.ts:92` and
`.../migrations/zzzz20260725120000_...:210` (`OUTBOX_EVENT_KINDS`, consumed by
`chk_areo_event_kind`) — and the TS file's own comment at lines 85-90 already
warns that both must be reconciled. This amendment requires:

- both copies changed in the same commit;
- a **parity gate** that fails when the two lists differ in membership or
  order, executed in a CI-gated suite (a source-text regex over one file is
  not acceptable evidence);
- a negative gate proving an unlisted kind is rejected at the DB boundary;
- W4C-0's generated reachable-event inventory reconciled against both copies,
  since section 0.1 reason 2 classifies the current omission as an inventory
  defect that must not recur silently.

Payloads stay byte-identical to today:

- `attendance.absence.generated` — closed key set exactly
  `{orgId, workDate, total}`, `total` = the run's `generated_count`;
- `attendance.work_date.review_required` — closed key set exactly
  `{orgId, workDate, total, reasons}`, `total` = the run's `review_count`,
  `reasons` = the ordered array of `{userId, reasonCode}` rebuilt from the
  `target_kind='review'` target rows in ascending `ordinal`.

`business_key_fingerprint` for both is the lowercase SHA-256 over
`"metasheet2:attendance:scheduled-run-event:v1\0" + eventKind + "\0" + orgId
+ "\0" + workDate + "\0" + runId`. `payload_schema_version` is `1`.

The `reasons` array is a per-user vector and is the single exception to
"no per-user data in a run-level payload"; it is admitted because it is the
**existing public payload** and removing it would be the wire break `(b2)`
exists to avoid. It is a closed shape (`userId`, `reasonCode` only, with
`reasonCode` from section 1.2.1's closed list) and is never a free-form
snapshot.

### 1.6 Advisory class `01` and lock order

`OD-W4C-40` reserved class `01`. This amendment assigns it to the scheduled
run key:

```text
buildAttendanceScheduledRunAdvisoryKey =
  BigInt.asIntN(64,
    (u64(SHA-256("metasheet2:attendance:scheduled-run:v1\0"
                 + orgId + "\0" + initiator + "\0" + workDate)) & LOW_62_MASK)
    | 0x4000000000000000n)
```

- Same construction discipline as the three existing builders in
  `w4c0-identity.ts:866-960`: first eight digest bytes, big-endian, low 62
  bits, two-bit class prefix, signed two's complement.
- The key is over the **run key tuple**, not `run_id`, because it must also
  serialize two concurrent *starts* that do not yet have an ID.
- Canonical order becomes `00` rollout → `01` scheduled run → `10` operation
  identities → operation/batch/item rows → `11` targets. Class `01` sits where
  it does because a run is strictly coarser than the per-user operations it
  contains.
- **Cross-class upgrade stays forbidden.** A scheduled-run key is never
  derived from an operation identity and never passed to
  `acquireAttendanceResultOperationLocks`; an operation identity is never
  passed to `acquireAttendanceScheduledRunLock`. The classes remain disjoint
  by construction and each helper re-validates its own witness type.
- The run helper uses the same helper-wide monotonic deadline protocol as the
  operation/target helpers and maps its own typed budget/acquisition timeout
  (including its own `55P03`) to values-free
  `503 ATTENDANCE_SCHEDULED_RUN_BUSY`. No other `55P03`/`57014` is relabeled;
  no retry, no compatibility fallback, no partial DML.
- Only the scheduled entrypoint acquires class `01`. Live, import,
  integration, request, and approval paths acquire it never.

### 1.7 Start, per-user execution, restart resume

**Run-creation transaction** (one transaction, no per-user source DML):

1. begin `SERIALIZABLE`; acquire class-`00` org rollout **shared** and resolve
   posture. `suspended` returns the closed operational outcome with zero DML;
   `legacy_projection_only` leaves the transaction and takes section 1.9's
   legacy path with zero W4 rows;
2. acquire the class-`01` run key lock;
3. re-read `attendance_scheduled_runs` for the key. If a `running` row exists,
   this is a **resume**, not a start: go to the resume protocol below;
4. resolve membership and per-user work-date attribution exactly as today,
   producing the ordered target vector;
5. allocate `generation`, compute `target_set_fingerprint`, insert the run row
   (`state='running'`, frozen posture and counts) and all target rows;
6. commit. No absence row, calculation, operation row, or outbox row is
   written by this transaction.

**Per-user execution** is unchanged from the held branch: for each
`target_kind='generate'` target, one canonical operation transaction with the
W4C-0 `scheduled` identity derived from `(run_id, user_id, work_date)`,
acquiring class-`00` shared, then class-`10`, then class-`11`. A per-user
transaction **must not** update the run row, so per-user work never contends
on it.

Fail-closed rule: a scheduled per-user operation whose `source_root_id` has no
committed `attendance_scheduled_runs` row, or whose run is not `running`, is
rejected **before** source DML.

**Resume protocol** (restart, crash recovery, or duplicate invocation):

1. under class-`00` shared and class-`01`, read the `running` run row
   `FOR UPDATE` and its target rows;
2. require the frozen `accepted_write_posture` to equal the currently resolved
   posture; a mismatch is fail-closed remediation (no silent rebase);
3. recompute the target set from current membership and require byte equality
   with `target_set_fingerprint`. Any difference is fail-closed remediation;
   the run is never silently re-planned;
4. the set of users still to do is exactly the `target_kind='generate'`
   targets whose operation row is **absent or not `completed`**, determined by
   exact key `(org_id,'scheduled',operation_id)` — never by an in-memory
   cursor, a process-local set, or a count. A completed operation is replayed
   with zero DML by the existing preflight;
5. after the last outstanding user completes, attempt finalization
   (section 1.8).

Because step 3 compares against the frozen fingerprint rather than mutating
the plan, `skipDedup` and the process-local `lastAutoAbsenceKey` can neither
duplicate nor bypass durable state: a second invocation while a run is
`running` resumes it; a second invocation after it is terminal creates
generation `n+1`.

**No stuck absorbing state.** A `running` run whose targets are all terminal
but which was never finalized is finalized by the same registered private
recovery sweep that resumes runs; no lease token, request body, or process
identity confers that authority. A run that cannot progress is closed by the
explicit `abandoned` transition.

### 1.8 Finalization transaction

Exactly one transaction, containing **no** source DML, **no** calculation
write, and **no** class-`11` target lock:

1. begin `SERIALIZABLE`; acquire class-`00` org rollout **shared**; resolve
   posture and require equality with the run's frozen
   `accepted_write_posture`;
2. acquire the class-`01` run key lock;
3. `SELECT ... FOR UPDATE` the run row. If it is already `completed`, return
   its recorded outcome with **zero DML** (this is the losing racer's path,
   and it is a normal, expected outcome, not an error);
4. re-read all target rows and, by exact key, every corresponding operation
   row. Require every `target_kind='generate'` target to have a `completed`
   operation row. If any is missing or not completed, finalization is not
   admitted and the transaction ends with zero DML;
5. fold the counts from that immutable evidence:
   `completed_user_count` = number of completed generate-targets (which the
   step-4 predicate makes equal to `expected_user_count`);
   `generated_count` = number of those whose sealed `response_snapshot`
   records `inserted = true`;
6. rebuild both payloads (section 1.5), including the `reasons` array in
   ascending target `ordinal`;
7. insert the run-level outbox rows: always
   `attendance.absence.generated`; and `attendance.work_date.review_required`
   **only when `review_count > 0`** — the non-empty condition owner point 7
   requires, matching today's `if (reviewRequired.length > 0)`;
8. update the run row to `state='completed'` with the folded counts and
   `finalized_at`;
9. commit.

Steps 7 and 8 are in the **same** transaction, so a run is never marked
completed without its events and never emits events without being completed.

Concurrency: the class-`01` lock plus `FOR UPDATE` plus the
`state='running'` predicate serializes competing finalizers; the two partial
unique indexes on the outbox are the corruption backstop, not the control
path, and raw `23505` never escapes. A finalizer that loses the race takes
step 3's zero-DML path.

Delivery: the existing W4C-2 dispatcher claims run-level rows with
`FOR UPDATE SKIP LOCKED` and emits `emit(event_kind, payload)` with the exact
stored bytes, so external consumers observe the same event names, the same
payload keys, and one event per run.

### 1.9 Posture matrix

| Effective posture | Run row | Target rows | Per-user operations | Outbox | Emit |
| --- | --- | --- | --- | --- | --- |
| `legacy_projection_only` | none | none | none (null-ID legacy) | **none** | unchanged synchronous best-effort, unchanged bytes |
| `suspended` | none created; an existing `running` run is not advanced | unchanged | none | none | none |
| `shadow` / `eligible`(→`shadow`) | created | created | per user | run-level rows at finalization | only via dispatcher |
| `authoritative` | created | created | per user | run-level rows at finalization | only via dispatcher |

- The legacy leg and the durable leg must fail **independently** under
  mutation; neither may be the exclusive failure reason for the other.
- A posture flip between run creation and a later per-user or finalization
  transaction is remediation, never a rebase.
- An `eligible` state normalizes to accepted write posture `shadow` before it
  reaches the run row, exactly as in W4C-0 amendment section 1.2.
- A run with `expected_user_count = 0` (no generate targets, e.g. every user
  went to review, or the org has no working-day users) is still created and
  finalized — in a single transaction when there is nothing to wait for — so
  today's `total: 0` emission is preserved. The pre-existing `skipped` early
  returns (`holiday-rest-no-policy`, `dedup`) still create nothing and emit
  nothing.

### 1.10 Migration and rollback

One new `zzzz`-prefixed migration (both new tables and the outbox alteration
must sort after the W4C-0 `zzzz20260725120000_...` migration they depend on).

`up()`:

1. create `attendance_scheduled_runs` and
   `attendance_scheduled_run_targets` with every constraint above, plus the
   `DELETE`/`TRUNCATE` refusal triggers, the run `UPDATE` column guard, and
   the deferred commit-time constraint tying frozen counts to target rows;
2. add `identity_kind` and `scheduled_run_id` to the outbox, drop
   `NOT NULL` on `operation_id`;
3. **backfill** `identity_kind = 'operation'` for every existing row. Every
   pre-existing row has a non-null `operation_id` by the old `NOT NULL`
   constraint, so the backfill is total;
4. add the CHECK constraints, both FKs, and the two partial unique indexes;
   drop `uq_areo_identity` only after the operation partial unique index
   exists;
5. extend `OUTBOX_EVENT_KINDS` (migration copy) in lockstep with the TS copy.

**Fail-closed semantics.** `fk_areo_operation` is added **validated**, never
`NOT VALID`: if any pre-existing outbox row references an operation row that
does not exist, the migration **aborts** and the deployment fails. The
migration never deletes, nulls, or quarantines a row to make itself pass. The
same rule applies to the extended kind CHECK.

**Compatibility with existing W4C-0 outbox rows.** W4C-0 landed the schema and
the transaction-bound enqueue interface with **no caller cutover**, so no
production code path enqueues today; in practice the table is empty. The
migration must not rely on that: it treats any existing row as real history,
classifies it as `identity_kind='operation'`, and preserves its identity,
payload, delivery state, attempts, and timestamps byte-for-byte.

**Upgrade path for runs that predate the migration.** None can exist under
W4C-2's hold, but the contract is explicit: a scheduled run with no run row
has no run-level identity, produces no run-level outbox row, and cannot be
resumed; its history is whatever the legacy best-effort emit produced. A
scheduled per-user operation naming a `source_root_id` with no run row is
rejected before source DML (section 1.7) rather than adopted.

`down()`:

- refuses **before the first DDL statement** while any row exists in
  `attendance_scheduled_runs`, `attendance_scheduled_run_targets`, or
  `attendance_result_event_outbox`, with a `W4C2_DOWN_BLOCKED:` message
  naming the table and count — the same shape as W4C-0's `down()` guard
  (`zzzz20260725120000_...:1722-1755`). It never clears history to pass;
- only on a proven-empty database does it drop the two new tables, drop the
  two partial unique indexes and the new constraints/columns, restore
  `operation_id NOT NULL` and the original single `uq_areo_identity`, and
  restore the original six-member `chk_areo_event_kind`, leaving the W4C-0
  shape byte-equivalent;
- a fresh/upgrade/replay-safe/down-empty/down-populated gate matrix applies,
  as in section 12.1.

## 2. Required gates

W4C-2's P1-2 cannot pass until each of these is independently
**mutation-proven** on real PostgreSQL. Neutering any one guard must make its
own leg — and only its own leg — fail; a neighbouring guard's failure is not
accepted as the exclusive reason.

1. **Run ID cannot masquerade as an operation ID.** Inserting an outbox row
   whose `operation_id` is a `run_id` fails; whose `scheduled_run_id` is a
   per-user operation ID fails; a run-level kind with `identity_kind
   ='operation'` fails; a per-user kind with `identity_kind='scheduled_run'`
   fails; both non-null and both null fail. Dropping `fk_areo_operation`,
   `chk_areo_kind_identity_map`, or `chk_areo_identity_exclusive` each fails a
   different leg. At the TS boundary, passing a run witness to
   `enqueueAttendanceResultEventOutboxV1` (and an operation witness to the run
   enqueue, and a bare UUID string to either) is rejected before any SQL.
2. **`attendance.absence.generated` durable leg.** A crash after the
   finalization commit but before emit leaves the row `pending`; dispatcher
   restart delivers it exactly once; the run row is `completed` and no source
   or per-user DML repeats. Deleting the enqueue call makes only this leg
   fail.
3. **`attendance.work_date.review_required` durable leg.** Same, plus: with
   `review_count = 0` **no** row is inserted, and with `review_count > 0`
   exactly one row is inserted whose `reasons` array equals the pre-restart
   array byte-for-byte in ordinal order. Making the enqueue unconditional and
   making it never fire each fail their own leg.
4. **Payload/wire freeze.** For a fixture run, the delivered event names and
   payload bytes are identical to the pre-amendment synchronous emit for the
   same inputs, and exactly one event of each applicable kind is delivered per
   run. Adding a key, dropping `reasons`, renaming `total`, or emitting per
   user fails.
5. **Legacy posture zero-outbox leg.** Under `legacy_projection_only` the run
   produces no run row, no target row, no operation row, no outbox row, and
   the unchanged synchronous best-effort emit with unchanged response bytes.
   Removing either side of the posture split fails independently.
6. **Restart completes only unfinished users.** A run interrupted after k of n
   users is resumed; the n−k remaining users execute, the k completed users
   replay with zero DML (row-count and content-hash snapshots before/after are
   byte-congruent), and the finalized `generated_count`/`total` equals the
   uninterrupted run's. Deriving the remaining set from an in-memory cursor,
   or folding `total` from in-process results instead of durable evidence,
   fails this leg (this is section 0.3's defect).
7. **Concurrent finalization is serialized.** Two connections attempt
   finalization of the same run simultaneously; exactly one inserts the outbox
   rows and flips the state, the other returns the recorded outcome with zero
   DML, no `23505` or `55P03` escapes, and exactly one row per kind exists.
   Removing the class-`01` acquisition, the `FOR UPDATE`, or the
   `state='running'` predicate each fails a two-connection leg; a leg that
   holds the first transaction beyond the helper budget returns values-free
   `503 ATTENDANCE_SCHEDULED_RUN_BUSY` with zero extra DML and replays later.
8. **Finalization atomicity.** An injected failure after the outbox insert and
   before the state flip (and the reverse order) leaves **both** unwritten;
   a test-only witness proves one `txid_current()`/backend PID for the whole
   finalization. Splitting them into two transactions fails.
9. **Closed-set parity.** The TS and migration copies of the event-kind list
   are proven equal in membership and order by an executed gate (not a source
   regex); changing either copy alone fails. An unlisted kind is rejected at
   the DB boundary. The same parity and negative-value gates cover the closed
   review-reason list of section 1.2.1.
10. **Target-set resume guard.** A resume whose recomputed target set differs
    by one user, one reason code, or one ordinal is fail-closed remediation
    with zero DML; a byte-identical recomputation resumes. Removing the
    fingerprint comparison fails only this leg.
11. **Run row invariants.** Two `running` runs for one
    `(org, initiator, work_date)` are impossible; `generation` is strictly
    increasing; `accepted_write_posture`, `target_set_fingerprint`,
    `expected_user_count`, and `review_count` are immutable after insert;
    illegal state transitions (`completed->running`, `completed->abandoned`,
    `running->running` with changed frozen columns) are refused; target rows
    refuse `UPDATE`/`DELETE`/`TRUNCATE`; a run whose frozen counts disagree
    with its target rows cannot commit.
12. **Derived-identity binding.** A target row whose `operation_id` is not the
    canonical UUIDv5 of `(run_id, user_id, work_date)` under
    `ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1` is refused by the DB, and a
    per-user operation naming a non-existent or non-`running` run is rejected
    before source DML.
13. **Cross-org isolation.** A run row, target row, or outbox row referencing
    another org's run/operation is refused; a second org's concurrent run for
    the same `work_date` is unaffected.
14. **Migration gates.** Fresh, upgrade (with a pre-existing outbox row),
    replay, `down()`-empty success, and `down()`-populated refusal all pass;
    an outbox row referencing a missing operation row makes `up()` abort
    rather than mutate data; `down()` restores the exact W4C-0 outbox shape.
15. **Lock-order gate.** Acquiring class-`01` before class-`00`, or acquiring
    class-`11` inside the finalization transaction, or performing any source
    DML in the finalization transaction, each fails its own leg.

Section 12.3's existing scheduled gates remain in force and are amended only
to read: run-level outbox rows are inserted in the finalization transaction
that marks the run `completed`, while per-user outbox rows remain inserted
before their operation seal.

## 3. Decisions

| Decision | Options | Recommendation |
| --- | --- | --- |
| `OD-W4C-44` scheduled run identity | (a) durable `attendance_scheduled_runs` row with server-minted `run_id`, frozen posture/counts/target-set fingerprint, immutable target rows, closed `running|completed|abandoned` states, and run-level outbox written in the same finalization transaction as `completed`; (b) keep the derived in-process run ID and add only outbox columns; (c) no run object — reduce the two run-level events to per-user events | **(a)** |
| `OD-W4C-45` repeat invocation and roster drift | (a) `generation` allocated under class-`01`; a fresh invocation after a terminal run starts generation `n+1` (today's re-emit behavior preserved), while the frozen `target_set_fingerprint` guards **resume** only and any drift on resume is fail-closed remediation; (b) one run per `(org, initiator, work_date)` forever — a repeat invocation is a zero-DML replay that emits nothing; (c) include the fingerprint in the run identity so a roster change mints a different run | **(a)** |
| `OD-W4C-46` advisory class for the run lock | (a) assign the reserved class `01` over `(org, initiator, work_date)`, ordered `00 → 01 → 10 → 11`, with its own values-free `503 ATTENDANCE_SCHEDULED_RUN_BUSY`; (b) reuse class `10` with a third `kind` discriminant `scheduled_run`; (c) rely on the partial unique index and row locks alone | **(a)** |
| `OD-W4C-47` run-level payload and delivery order | (a) freeze both payloads byte-identically, keep the closed `reasons` vector rebuilt in target `ordinal` order, and leave inter-event delivery order unconstrained (as today's two independent `emit` calls already are); (b) additionally add a stored `delivery_ordinal` and require `attendance.absence.generated` to be delivered before `attendance.work_date.review_required` for the same run; (c) reduce `reasons` to a count | **(a)** |
| `OD-W4C-48` non-terminal run escape hatch | (a) add the terminal `abandoned` state with a closed values-free reason code, written by an operator remediation path, emitting no event and writing no source DML; (b) `running|completed` only, and accept that an unsatisfiable run holds the partial unique index indefinitely | **(a)** |

`OD-W4C-44(b)` fails because a derived ID cannot carry counts, terminal state,
or a resume guard, and would leave section 0.3's `total` drift unfixed.
`OD-W4C-44(c)` is the already-rejected option `(a)` of the G-2 ruling.
`OD-W4C-45(b)` silently changes today's admin re-run behavior;
`OD-W4C-45(c)` makes an ordinary mid-run roster change fabricate a second run
for one day. `OD-W4C-46(b)` would extend an already RATIFIED key tuple and
weaken the "cross-class upgrade is impossible" property;
`OD-W4C-46(c)` makes `23505` a control path. `OD-W4C-47(b)` is defensible but
adds a column and a delivery constraint that today's behavior does not
actually guarantee; `OD-W4C-47(c)` is a wire break. `OD-W4C-48(b)` creates a
stuck non-terminal state.

## 4. Execution sequence

1. Merge this document as **PROPOSED** with no runtime code. PR #4612 stays
   Draft under OWNER-AUTHORIZATION-HOLD and is not touched by this merge.
2. Owner RATIFYs the **exact merged SHA** of this file and decides
   `OD-W4C-44..48`. Nothing below starts before that.
3. Only then implement P1-2 on the W4C-2 branch: the migration, the two new
   tables, the outbox discriminated union, the class-`01` builder/helper, the
   run-scoped enqueue surface, the run/resume/finalization transactions, the
   two closed-set copies, and all of section 2's gates.
4. New **exact-head** independent adversarial review of the resulting head.
5. Even at zero P1/P2, the lane **stops**: merging PR #4612 remains an owner
   decision, and this amendment authorizes no arming, flag enablement, org
   enablement, deployment, or closure of #4556.
6. Issue #4616, which was opened as the `(c)-plus` residual-risk carrier, is
   rewritten against the `(b2)` boundary or closed with a public note once
   this amendment lands; it is not silently left stating a superseded
   premise.

## 5. Declared residuals

These are stated rather than hidden; each is either an owner decision above or
an accepted bound:

- **External consumers are unenumerable.** No in-repo runtime subscriber to
  either run-level event exists at `97cf6203397b958c78c646f09176b93b00d279aa`;
  only two DB tests assert emission. This amendment therefore preserves the
  wire contract instead of arguing from a consumer inventory.
- **Third dual-copy created.** The closed review-reason list now lives in the
  resolver module and in a migration CHECK. Section 1.2.1 requires a parity
  gate, but the underlying duplication is real and is a maintenance cost.
- **`run_id` FK direction.** `attendance_scheduled_run_targets` binds the
  operation ID by derivation CHECK rather than by FK, because target rows are
  written before the operation rows exist. The operation row's own
  `chk_aro_derived_identity` is the other half of that binding.
- **Finalization is a new transaction shape** in section 8.2's world: it holds
  class-`00` and class-`01` only, and is forbidden from source DML and from
  class-`11`. Section 2 gate 15 is the only thing that keeps that honest.
- **`abandoned` has no consumer today.** It exists solely to prevent a stuck
  non-terminal run; if the owner picks `OD-W4C-48(b)`, gate 11 and section 1.1
  must be edited accordingly before implementation.
