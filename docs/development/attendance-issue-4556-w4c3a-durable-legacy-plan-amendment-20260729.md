# Attendance Issue #4556 W4C-3a Durable Legacy Execution Plan Amendment

> Status: **PROPOSED**
>
> Date: 2026-07-29
>
> Decision required: `OD-W4C-56`
>
> Governing base: W4 design lock and the RATIFIED W4C-3a legacy-preimage
> amendment at exact merged SHA
> `1055e543a3680be9f37462de23483bf61ad4610c`. The owner decision is durably
> transcribed in PR #4672 comment `#5113759839`.
>
> This document does not authorize W4C-3a implementation, merge, W4C-3b or
> later slices, flag changes, deployment, staging soak, production use, or
> closure of issue #4556. A future implementation remains separately gated and
> requires an exact-head independent review with zero P1/P2 findings.

## 0. Why another amendment is required

The W4 design requires all of the following:

1. P07 enqueue persists a strict, immutable V1 job identity and normalized
   import command without creating an operation row.
2. P08 can execute the same prepared batch after process restart.
3. `legacy_projection_only` preserves the existing import response and
   compatibility effects.
4. operational import state cannot become W4 calculation, authorization,
   promotion, or rollback authority.

The implementation audit performed after `OD-W4C-55=(a)` found that the
strict W4 import envelope and the existing legacy import effect do not contain
the same information. The envelope is sufficient for canonical W4 semantic
calculation. It is not sufficient to reconstruct every existing import batch,
item, record, group, response, and upload-cleanup effect after the process-local
prepared closure has disappeared.

This is a contract-shape conflict, not an unimplemented helper:

- adding missing fields to the strict normalized business input would mix
  operational legacy compatibility state into W4 evidence;
- deriving missing values from current rule, settings, profile, group, or file
  state at worker time would violate restart freeze and could change the result
  after enqueue;
- writing only the final daily projection would not be byte-compatible with
  the existing import execution;
- keeping a process-local closure would fail P08 restart recovery.

W4C-3a runtime therefore remains paused. The implementation worktree is frozen
inventory and is not evidence that this amendment has been accepted.

Terminology in this amendment keeps the governing slice ownership: `P07 worker`
means `processAsyncImportCommitJob`, and `P08` means startup recovery that
re-enqueues that worker. `P07 flow`, and bare `P07` only in an enqueue/route
sentence, are shorthand for the existing authenticated async enqueue route plus
its P07 worker; neither usage reassigns P08 or authorizes a new async route.

## 1. Evidence at the governing base

### 1.1 Existing legacy execution has a wider effect surface

The current `commitAttendanceImportPayload` implementation in
`plugins/plugin-attendance/index.cjs` performs more than a daily-record upsert:

| Effect | Existing behavior at SHA `1055e543a...` |
| --- | --- |
| Batch row | writes source, rule-set, mapping, original row count, status, idempotency, and computed metadata |
| Item rows | writes one operational item for success and skipped/invalid rows, including snapshots and record linkage |
| Daily record | applies merge/override behavior against the execution-time record and writes the existing compatibility metadata |
| Group effects | may create attendance groups and assign members |
| Batch completion metadata | records group counts, skipped counts/samples, engine and persistence strategies |
| Response | synchronous HTTP returns a route data payload; async completion stores a compact job-summary payload that the existing job mapper projects |
| Upload lifecycle | performs post-commit cleanup for an uploaded import artifact |

Exact anchors at the governing SHA:

- the legacy worker begins at `plugins/plugin-attendance/index.cjs:25917`;
- mutable rule/profile/group inputs are selected at
  `plugins/plugin-attendance/index.cjs:25945-26030`;
- batch metadata and batch-row DML are at
  `plugins/plugin-attendance/index.cjs:26076-26130`;
- item IDs and snapshots are created at
  `plugins/plugin-attendance/index.cjs:26132-26155`;
- invalid and duplicate source ordinals are retained at
  `plugins/plugin-attendance/index.cjs:26341-26399`;
- record mode and compatibility metadata feed the record write at
  `plugins/plugin-attendance/index.cjs:26680-26712`;
- group/member and skipped-result metadata are finalized at
  `plugins/plugin-attendance/index.cjs:26720-26740`;
- upload cleanup is at `plugins/plugin-attendance/index.cjs:26744-26745`;
- async worker result construction is at
  `plugins/plugin-attendance/index.cjs:25920-25943,26748-26793`, and its compact
  durable job summary plus public job projection are at `:25274-25388`;
- the legacy CSV source-row limit is resolved at
  `plugins/plugin-attendance/index.cjs:6867-6869`; CSV row-source parsing invokes
  its limit guard at `plugins/plugin-attendance/index.cjs:24996-25052`, while
  direct `payload.rows` returns before that guard at
  `plugins/plugin-attendance/index.cjs:24990`;
- current V1 reservation writes legacy `created_by` and W4 `actor_id` from
  distinct inputs at
  `packages/core-backend/src/attendance/w4c0-operation-registry.ts:998` and
  `:1006`;
- the synchronous full-import route checks its visible legacy idempotency batch
  before row-source parsing at `plugins/plugin-attendance/index.cjs:35765-35794`,
  while scoped import parses/authorizes rows at `:35847-35878` before its
  requester-bound lookup at `:35879-35907`;
- synchronous first-execution and locked-race responses are at
  `plugins/plugin-attendance/index.cjs:36713-36762`; their data key sets are
  observably different from the async worker result, so one unqualified terminal
  response shape would be false;
- the async route first deduplicates only an existing job at
  `plugins/plugin-attendance/index.cjs:37011-37026`; when no such job exists, the
  worker's `:25920-25943` legacy-batch check can still produce the early
  idempotent result before rule/profile/upload reads;
- current job reservation rejects an empty normalized item vector at
  `packages/core-backend/src/attendance/w4c0-operation-registry.ts:900`; the DB
  proof validator rejects zero at
  `packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:355`,
  and the job item-count/proof CHECKs are at `:1613-1631`;
- the current legacy record path locks only already-existing rows at
  `plugins/plugin-attendance/index.cjs:26218`; its conflict-update upsert is at
  `:20217`.

The governing design also says:

- current compatibility projections are snapshotted separately;
- P07/P08 restart parity is against the same prepared batch;
- source/import-item/result/operation seal share the required transaction;
- `legacy_projection_only` preserves external response/projection bytes;
- operational import tables and files remain non-authoritative.

Those requirements are anchored in
`docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`
at `:2726-2728` (separate compatibility snapshots), `:2756-2757`
(single-transaction seal), `:2784-2791` (operational non-authority), and
`:2798-2799` (same-batch restart parity). The explicit
response/projection-byte requirements are at `:2431-2436` and `:2692-2710`.

### 1.2 The strict W4 semantic input is intentionally narrower

The design's closed import command contains the batch identity, transport,
fingerprint, ordered target items, exact imported metric presence, the
compatibility daily projection, frozen policy/engine result, and artifact
provenance.

It intentionally does not contain:

- invalid rows that have no canonical `(org,user,workDate)` target;
- required-field validation and skipped-row snapshots;
- import mode, item-return/truncation policy, mapping or profile selection;
- batch source, rule-set, idempotency, and compatibility metadata;
- group creation/member-assignment intent;
- the complete legacy record metadata shape;
- uploaded artifact cleanup identity;
- the complete legacy response-construction inputs.

Duplicate import items may fold into one W4 target while the legacy operational
surface still retains every source ordinal. A target-only reconstruction cannot
recover that distinction.

### 1.3 The rejected minimal fallback

A fallback that reads only the strict target envelope and writes:

1. one simplified `attendance_import_batches` row; and
2. one `attendance_records` upsert per target

is not a byte-compatible legacy worker. It omits item rows, skipped snapshots,
group effects, batch metadata, merge semantics, response fields, and upload
cleanup. Tests that assert only final minutes or the absence of current-rule
reads are necessary but not sufficient.

## 2. Decision `OD-W4C-56`

### Option (a): versioned, digest-bound legacy execution-plan manifest and chunks

**Recommended.**

Keep the strict W4 normalized business input unchanged. At P07 enqueue, build a
separate closed `LegacyImportExecutionPlanV1` from the same validated request
and persist its manifest plus bounded ordered chunks durably with the job. The
plan is operational compatibility state, never W4 evidence.

The worker:

1. loads the job, manifest, and chunks inside the canonical transaction;
2. verifies schema version, exact keys, digest, job/batch/org/actor identity,
   command fingerprint, item vector, and accepted write posture;
3. executes only the closed plan;
4. never rereads mutable rule, settings, mapping profile, group-rule mapping, or
   uploaded file contents to derive a business result;
5. commits the legacy source effect and terminal job status in the same
   transaction;
6. schedules any post-commit artifact cleanup through a durable, idempotent
   operational cleanup command.

### Option (b): narrow "byte-compatible" to daily projection only

Redefine P07/P08 legacy compatibility to preserve only the daily projection and
a reduced response. Explicitly allow loss of import items, skipped snapshots,
batch metadata, group effects, upload cleanup, and existing response fields.

This is **not recommended**. It turns a proven compatibility gap into a product
behavior change, weakens the existing flag-OFF contract, and would require
separate user-facing migration and acceptance work.

### Proposed owner ruling

`OD-W4C-56=(a)`.

Option (a) explicitly asks the owner to accept these narrow behavioral and
storage changes; none is implied merely by calling the result compatible:

1. V1 plans, chunks, frozen job identity, and terminal responses become
   DB-immutable and non-deletable; job/cleanup closed lifecycles remain mutable
   only through their guarded transitions;
2. a synchronous request whose visible legacy idempotency batch already exists
   preserves the current direct route return with no V1 job; async enqueue uses
   the operational replay branch. Full-import remains org/key-wide before
   source/current-rule access, while P06 scoped import preserves row-scope
   authorization before replay. P07 remains full-import-only under its existing
   `attendance:import|attendance:admin` route guard; this amendment does not add
   scheduler-scoped async import;
3. an all-invalid/skipped source uses a DB-enforced zero-W4-item operational
   branch rather than a fabricated target;
4. an above-5000 legacy/shadow source uses a separate operational-only branch
   with no W4 item operation/proof rows rather than weakening W4's hard limit;
5. only legacy CSV sources retain the existing CSV row limit; direct rows and
   other non-CSV transports do not gain a new source-row rejection;
6. the P07/P08 worker stores the exact existing compact async job summary and
   which of the three existing execution observations it actually reached;
   synchronous P06 never creates or adopts a V1 job/plan/terminal-response row,
   never calls the private queue processor, and retains its existing HTTP
   serializer through its separately locked synchronous execution path;
7. class-`11` target locks are backed by a flag-independent DB trigger that
   updates one `(org,user,workDate)` revision on every attendance-record DML, so
   old/non-W4 SQL writers cannot create an absent-row race; V1 enqueue is still
   disabled until old import workers drain;
8. group effects use a flag-independent DB trigger that updates an org revision
   on every group/member DML, so SQL writers cannot change group state between
   precondition check and effect commit;
9. cooperating concurrent group imports are serialized, so the losing waiter
   observes the revision change and fails/replans instead of recreating the old
   unlocked race;
10. P07/P08 upload deletion failure is durably retryable without changing the
    already committed business response; P06 retains its governing best-effort
    synchronous cleanup and does not create a V1 job for cleanup;
11. a record/group preimage changed after enqueue yields typed
    terminal-failed remediation instead of recalculating the accepted plan from
    new DB state; a caller may submit a new authorized command, but the accepted
    job is never reopened;
12. every post-cutover sync/async import writer sharing a legacy idempotency key
    joins one canonical class-`10` idempotency lock and retryable-job/batch
    recheck, closing the current unique-index/raw-race path across different W4
    command IDs.
13. for P07/P08 uploaded sources, the business effect, completed job, immutable
    terminal summary, and pending cleanup command commit atomically. A concurrent
    poll may therefore observe the completed job before the first post-commit
    cleanup attempt; cleanup failure never rewrites that business result and is
    retried from the durable command.
14. `operational_only_batch_limit` does not acquire an unbounded per-target
    advisory-lock vector. It acquires one org-scoped operational-bulk class-`11`
    sentinel, then locks and rechecks every real record/revision/group row in
    canonical order before any DML. Strict W4 jobs retain the governing
    per-target class-`11` set; replay/no-target branches take no target lock.
15. a congruent committed legacy batch remains a zero-effect operational
    idempotency replay in every write posture, including `authoritative`; it
    does not invent retroactive W4 operation/source/result evidence and cannot
    contribute promotion evidence.
16. for non-suspended V1 execution, unsupported version, integrity/identity
    mismatch, authorization loss, or a changed frozen precondition transitions
    only the accepted V1 job to one closed terminal `failed` reason with zero
    business/terminal/cleanup DML. A suspended queued V1 job remains queued even
    when its actor has meanwhile lost authorization; after resume, that same
    authorization loss fails before plan/source DML. Same-job reopen is
    forbidden; recovery requires a new authorized command.
17. while the amendment schema is installed, DB guards reject `TRUNCATE` on
    attendance records, groups, members, and both revision tables. Controlled
    teardown must first satisfy the zero-V1 guarded-down contract; row-level
    revision safety cannot coexist with an unobserved table truncate.
18. migration `up` refuses if any pre-amendment V1 import job already exists;
    it does not infer a plan from legacy payload/current state. Such an
    environment requires a separately ratified history migration or a clean
    non-production rebuild before this slice can be installed.

## 3. Plan storage contract

Add one manifest table named `attendance_import_legacy_execution_plans` and one
child table named `attendance_import_legacy_execution_plan_chunks`. A single
unbounded JSONB row is prohibited because legacy source cardinality, including
the existing CSV-only limit and uncapped direct-row families, is separate from
W4's 5000-item atomicity bound.

```text
LEGACY_IMPORT_PLAN_MAX_SOURCE_ROWS_PER_CHUNK = 500
```

This is one exported storage constant, not environment-tunable behavior.
Changing it requires a storage-contract amendment and does not authorize
rechunking an already persisted plan.

| Column | Contract |
| --- | --- |
| `job_id uuid PRIMARY KEY` | foreign key to `attendance_import_jobs(id)`; one plan per V1 job |
| `org_id text NOT NULL` | must equal the job org |
| `batch_id uuid NOT NULL` | must equal the job batch ID and W4 batch command ID |
| `plan_version integer NOT NULL` | exactly `1` for this slice |
| `plan_digest text NOT NULL` | lowercase SHA-256 of the logical canonical plan stream, independent of physical chunk boundaries |
| `chunk_vector_digest text NOT NULL` | lowercase SHA-256 of the ordered chunk descriptor vector |
| `source_kind text NOT NULL` | equals job `w4_source_kind` |
| `source_ref text NOT NULL` | equals job `w4_source_ref` |
| `created_by text NOT NULL` | equals job `created_by`; this is the legacy batch/requester audit identity |
| `actor_id text NOT NULL` | equals job `w4_actor_id`; it is not required to equal `created_by` |
| `actor_posture text NOT NULL` | equals job `w4_actor_posture` |
| `token_subject_user_id text` | null-safe equality with job `w4_token_subject_user_id` |
| `accepted_write_posture text NOT NULL` | equals job `w4_accepted_write_posture` |
| `identity_proof_vector_digest text NOT NULL` | DB-canonical digest of job `w4_identity_proof_vector` |
| `command_fingerprint text NOT NULL` | equals the job W4 command fingerprint |
| `legacy_input_fingerprint text NOT NULL` | equals the job's branch-discriminated, new-effect-ID-independent retry fingerprint |
| `operational_branch text NOT NULL` | exactly `strict_targeted`, `operational_only_idempotent_replay`, `operational_only_no_target`, or `operational_only_batch_limit`; equals the job branch |
| `legacy_row_source_kind text` | closed selected source family; null exactly for `operational_only_idempotent_replay/precheck_hit`, which returns before source selection |
| `legacy_source_row_limit bigint` | frozen safe-integer CSV limit; required only for a selected CSV source and null otherwise |
| `source_row_count integer NOT NULL` | exact source ordinal count represented by the chunks; zero only for `operational_only_idempotent_replay`; retains the pre-existing async job `total integer` representability envelope |
| `source_ordinal_digest text NOT NULL` | lowercase SHA-256 over every ordered source ordinal and its closed plan disposition |
| `w4_item_count integer NOT NULL` | exact canonical W4 item count; may be lower than source row count |
| `w4_distinct_target_count integer NOT NULL` | exact distinct canonical `(org,user,workDate)` count |
| `w4_item_sequence_fingerprint text NOT NULL` | equals the job frozen W4 sequence fingerprint |
| `w4_item_set_fingerprint text NOT NULL` | equals the job frozen W4 set fingerprint |
| `group_revision bigint` | org group revision frozen under lock; required exactly when group effects exist |
| `group_state_fingerprint text` | exact frozen group/member precondition; required exactly when group effects exist |
| `chunk_count integer NOT NULL` | exact positive number of required child chunks, or zero only for `operational_only_idempotent_replay` |
| `manifest jsonb NOT NULL` | strict root metadata; no effect arrays and no chunk-descriptor array |
| `created_at timestamptz NOT NULL` | immutable creation audit |

Each chunk row contains:

| Column | Contract |
| --- | --- |
| `job_id uuid NOT NULL` | foreign key to the manifest job ID |
| `chunk_index integer NOT NULL` | dense zero-based index; primary key with `job_id` |
| `first_source_ordinal integer NOT NULL` | first source ordinal represented by the chunk |
| `source_row_count integer NOT NULL` | positive bounded number represented by the chunk |
| `chunk_digest text NOT NULL` | lowercase SHA-256 of canonical chunk JSON |
| `chunk jsonb NOT NULL` | exact-key parsed item, record-write, and group-effect entries |

The migration also adds immutable nullable job columns
`w4_legacy_plan_digest`, `w4_distinct_target_count`,
`w4_operational_branch`, and `w4_legacy_input_fingerprint`. Their W4 shape
constraint is extended so null-version jobs require all four null and every new
V1 import job requires congruent manifest values. Migration `up` refuses rather
than infer any value if a pre-existing V1 job is present.

Database constraints and one named deferred constraint-trigger function,
`attendance_validate_import_legacy_plan_v1(job_id)`, enforce:

- lowercase 64-hex digests/fingerprints;
- for `strict_targeted`, W4 item count `1..5000`, distinct-target count
  `1..5000`, and the current nonempty identity-proof-vector validation;
- for `operational_only_idempotent_replay`, W4/source/distinct-target counts
  exactly zero, canonical empty source/item fingerprints and proof vector, zero
  chunks, a positive locked legacy-batch replay row count inside the closed
  batch precondition, job `total` equal to that replay row count, and no
  batch/item/record/group or W4 source/result DML. Its closed replay selector is
  exactly `precheck_hit|locked_race`. P07 remains full-import-only.
  `precheck_hit` requires `artifactCleanup.kind='none'` and no selected row
  source; `locked_race` permits only the uploaded-source
  cleanup intent already derived from the source opened before the locked race
  was observed;
- for `operational_only_no_target`, W4 item count and distinct-target count
  exactly zero, the one exported canonical empty sequence/set fingerprints, an
  exact empty identity-proof vector, and an all-`skip` plan;
- for `operational_only_batch_limit`, a positive exact W4 semantic item/target
  count with at least one count above its 5000 bound, an exact empty
  identity-proof vector, streaming sequence/set fingerprints over the chunked
  semantic items, accepted posture `legacy_projection_only|shadow`, and zero W4
  operation/source/result DML;
- nonnegative safe-integer distinct-target count not greater than W4 item
  count; the 5000 bound is branch-specific above;
- all row/item/ordinal/count values remain nonnegative PostgreSQL `integer`
  values because the pre-existing `attendance_import_jobs.total/progress`
  columns already impose that async storage envelope. The implementation turns
  an out-of-range transport count into a typed pre-DML rejection rather than a
  raw numeric error; this is not a new CSV-derived limit on non-CSV sources;
- positive source row count outside the replay branch; replay requires zero.
  `precheck_hit` requires null selected source kind and null limit.
  `locked_race` freezes the source kind already selected before the final
  recheck:
  `uploaded_csv|inline_csv` requires the positive frozen legacy CSV limit,
  while `direct_rows|entries|dingtalk_tabular` requires a null limit.
  Non-replay CSV requires
  `source_row_count <= legacy_source_row_limit`; non-CSV gains no new source-row
  cap;
- `w4_item_count <= source_row_count`;
- outside replay, job `total` equals manifest `source_row_count`; replay uses
  the locked positive row count above and does not pretend it parsed source
  ordinals;
- positive bounded chunk count outside replay, dense chunk indexes, contiguous
  source ordinal ranges, and an exact sum equal to manifest
  `source_row_count`; replay requires zero chunks and zero child rows;
- immutable identity, version, digest, fingerprints, and plan;
- no manifest/chunk without one V1 job;
- at initial V1 job commit, no job exists without exactly one congruent manifest
  and its complete chunk set. A previously committed `queued|running` job may
  later enter only the closed quarantine states
  `failed/ATTENDANCE_IMPORT_LEGACY_PLAN_MISSING` or
  `failed/ATTENDANCE_IMPORT_LEGACY_PLAN_CHUNK_MISSING` when the private worker
  proves the corresponding history loss; that exception permits the missing
  relation solely so the immutable failure can be recorded. It allows no
  business/terminal/cleanup DML, no same-job retry, and no failed-shape INSERT;
- at transaction commit, a completed V1 job has exactly one congruent terminal
  response and every other status, including `failed`, has none;
- no manifest/chunk for null-version pre-cutover jobs.

`identity_proof_vector_digest` uses one DB-owned expression:

```sql
encode(
  digest(convert_to(w4_identity_proof_vector::jsonb::text, 'UTF8'), 'sha256'),
  'hex'
)
```

The application does not define a second serialization for that binding.

The V1 job ID is server-minted before either closed payload is built and is
inserted explicitly into the job row. The named function validates the joined
job/manifest org, `batch_id` and `w4_batch_command_id`, plan version, job-held
plan digest, source kind/ref, `created_by`, W4 actor ID/posture, token subject,
accepted posture, operational branch, command fingerprint, legacy-input
fingerprint, identity-proof-vector digest, W4 item
count/fingerprints, distinct-target count, chunk count/index/ranges, group
precondition shape, replay selector/precondition digest, and source-row sum
at commit. Null equality uses
`IS NOT DISTINCT FROM`. It is not an application-only check and does not depend
on insert order.

The migration extends the existing
`attendance_w4_import_jobs_w4_guard()`/`trg_aij_w4_guard` boundary and adds the
matching V1 INSERT check so the UPDATE-only quarantine exception is provable
from `OLD`/`NEW`: direct failed-shape INSERT, any other transition into one of
the seven reasons, reason replacement, and every `failed -> queued|running`
transition are rejected before the deferred validator runs.

The manifest DB check requires the exact root key set from section 4.1. Chunk
rows supply the descriptor columns and require the exact JSON top-level key set
`items|recordWrites|groupEffects`. The TypeScript parser validates every nested
discriminated union both before insert and after load. The private worker then
recomputes each chunk digest, ordered chunk vector digest, source ordinal digest,
identity proof digest, and logical plan digest before effect DML. A nested-key
or digest mutation may persist only through direct DB corruption; it still
cannot execute.

The strict W4 identity/proof remains in the governing frozen job columns and
the verified plan items; an operational-only branch retains only its closed
job-column identity/count/fingerprint summary. Neither duplicates the legacy
plan body in `payload`. `w4_legacy_plan_digest` is the single job-held plan
binding; no second mutable plan body or alternative digest is allowed.

Every V1 job also carries one frozen, exact-key public-job envelope in its
existing `payload` column:

```text
{
  __jobType: 'commit',
  idempotencyKey,
  __importEngine,
  recordUpsertStrategy,
  itemsInsertStrategy,
  __w4ContractVersion: 1
}
```

It contains no row/file bytes, mapping, target, plan body, response summary,
credential, or result slot and is immutable from INSERT onward. Queued/running
V1 projections use this envelope plus immutable job columns and progress.
Completed V1 projection requires the joined terminal response and never falls
back to this envelope as a result summary. Null-version payload/update behavior
remains unchanged.
For normal branches, engine/strategy fields equal the accepted frozen plan; for
replay they are derived only from the locked existing batch metadata through
the governing helpers.

Both tables use `ON DELETE RESTRICT`, have no public or plugin-facing CRUD route,
and are readable only through the private canonical worker. DB `BEFORE UPDATE
OR DELETE` triggers call the one named function
`attendance_reject_w4_import_history_mutation()`. V1 jobs reject delete and
changes to frozen W4/plan identity or the frozen public-job `payload`, while
retaining only their existing closed status/progress/error/timestamp
transitions; once terminal, status, counts, error, and terminal timestamps are
immutable. Manifests, chunks, and terminal
responses reject every update/delete. Cleanup rows reject delete and
identity/file/org/job updates but allow only the section 4.7
status/lease/attempt CAS transitions.
These rules hold regardless of statement order or transaction. Current tests
that delete V1 jobs are changed to use a fresh database/transaction rollback;
they may not weaken these guards for cleanup.
Plan data follows the job/import-history retention boundary and cannot be
logged as a whole. Any future archival/deletion protocol requires a separately
ratified retention amendment.

The manifest/chunks are not:

- an operation claim;
- authorization or delegated-scope evidence;
- W4 source, attribution, calculation, promotion, or rollback evidence;
- a substitute for operation, batch, item, or target locks.

Actor/token/org membership, capability, source-reference, and rollout posture
are rechecked from canonical core sources before the manifest/chunks are read.
P07/P08 require current full-import authorization. After digest/exact-key
parsing, plan record targets and group-member identities are only untrusted
lock/query inputs; they cannot grant or widen that permission. Plan verification
and authorization complete before record/group preconditions or any
source/effect/result DML.

If `OD-W4C-56=(a)` is RATIFIED, it amends P25 and the R42/R43 replay
classification only this far: the closed
manifest/chunks may instruct the legacy compatibility DML enumerated in this
document after canonical authorization, posture, identity, and lock checks.
The congruent committed-legacy-batch branch may return its zero-effect
operational result without fabricating a completed W4 operation, including
under `authoritative`; it is not classified as a W4 completed replay and cannot
produce promotion evidence.
They remain forbidden as W4 calculation/source evidence, promotion evidence,
rollback authority, authorization, an operation claim, or proof of completion
without the canonical transaction's resulting rows and terminal job state.

### 3.1 Scale and W4 atomicity remain separate

This amendment does not reinterpret the governing lock's exact limits:

- `W4_MAX_BATCH_ITEMS=5000` and `W4_MAX_DISTINCT_TARGETS=5000` apply to a W4
  atomic operation;
- the existing legacy CSV source-row limit remains CSV-only and is frozen in
  the plan manifest; current direct `payload.rows`, `entries`, and DingTalk
  tabular transports do not acquire that CSV rejection;
- `legacy_projection_only` above either W4 limit executes only the compatibility
  plan and remains externally byte-compatible, with zero W4 operation/source/
  result DML;
- `shadow` above either W4 limit may execute only the whole legacy plan,
  records the existing values-free `w4_batch_limit_shadow_bypass` event, and
  contributes no promotion evidence;
- authoritative above either W4 limit fails
  `W4_BATCH_LIMIT_EXCEEDED` before job/plan, legacy, or W4 source/effect DML.

Exactly 5000 W4 items and 5000 distinct targets are accepted. A 5001st W4 item
or target takes the posture-specific path above. A 5001st source row is not by
itself a W4-limit failure; it is a legacy-limit failure only for a CSV source
whose frozen CSV limit is lower than that count.

For full-import access, before any uploaded-file or mutable business-state read,
a request carrying a visible legacy idempotency key checks the existing legacy
batch under the governing visibility rule. Scoped import retains its current
ordering: parse/authorize the submitted target rows first, then check only the
requester's visible batch. A synchronous request whose congruent committed batch
already exists returns immediately through the governing sync serializer,
without creating a V1 job/manifest and without opening the source. Full-import
visibility remains org/key-wide for every currently authorized full importer;
scoped visibility remains requester-bound. This direct return is not a plan and
cannot become W4 evidence.

The existing commit-token contract remains outside the durable plan, including
its current per-path ordering. P06 full-import replay precedes both the required
token-presence check and consumption. P06 scoped import preserves its current
order: required token-presence check, source parse and row authorization,
requester-bound replay, then token consumption only if replay did not return.
P07 existing-operational-job replay precedes both its required token check and
consumption. In every all-new path, one-time consumption still completes before
source/effect or job/plan DML. A commit token, credential, or consumption result
is never persisted or fingerprinted into the plan. This amendment neither
restores a consumed token after a later failure nor permits token validation to
be skipped because a plan can be built.

For async enqueue, including when it discovers the congruent batch only at the
final locked recheck after source planning, the named
`operational_only_idempotent_replay` branch preserves the accepted async
summary:

- the manifest has source/W4 item/distinct-target counts zero, canonical empty
  source/item fingerprints and proof vector, zero chunks, and no source ordinal
  or effect intent;
- its closed batch precondition freezes the locked existing batch ID, positive
  imported/skipped row-count total, imported/skipped counts, engine,
  record-upsert strategy, metadata, idempotency key, requester visibility, and a
  digest over that exact read set;
- a private operational command fingerprint binds
  `{schemaVersion:1,kind:'operational_only_idempotent_replay',orgId,
  batchCommandId,sourceRef,legacyInputFingerprint,replayBatchId,
  replayPreconditionDigest,replaySelector}`;
- only the batch/job identity and the canonical legacy-idempotency key take
  class-`10`; no item/target lock or W4 operation/source/result row exists;
- `replaySelector='precheck_hit'` means the authorized enqueue visibility
  checkpoint already saw the batch. Sync HTTP already returned directly and
  cannot create this job. The P07 full-import checkpoint precedes source
  opening. The worker rechecks that exact batch under both locks, stores the
  compact async
  `idempotent_early` summary, creates no upload-cleanup command, and
  terminalizes the operational job;
- `replaySelector='locked_race'` means the authorized candidate read saw none,
  the request source was opened and classified, and only the final locked
  recheck saw the congruent batch. The async worker stores
  `idempotent_in_transaction`; an uploaded source carries only its frozen
  cleanup identity and creates the selector-authorized cleanup command. It
  still creates no batch/item/record/group or W4 source/result row;
- a missing, changed, hidden, or non-congruent batch fails closed; it never
  falls through to source parsing from the frozen replay job.

Legacy batch/item rows are not authorization evidence. P07/P08 recheck the
current full-import authorization from canonical core queries before returning
or executing a replay. Scheduler-scoped async import is outside this amendment
and cannot be inferred from P06's scoped synchronous path.

This branch is selected either for a legacy batch already visible at the async
route-authorized enqueue checkpoint (`precheck_hit`) or for a congruent batch
that wins only at the final locked recheck after source planning
(`locked_race`). The selector is frozen in the plan and is not reselected by
the worker. Every post-cutover sync/async import writer that can create the same
legacy idempotency key must
take the same canonical idempotency lock before batch DML, so a different W4
command identity cannot evade serialization.

This shared lock does not merge P06 and P07 ownership. A synchronous request
that reaches the locked recheck and finds a queued/running V1 job returns the
governing typed in-progress posture; a failed/remediation-only V1 reservation
returns its closed typed conflict. Both write zero rows and neither returns the
async job, adopts its identity, or invokes its worker. Conversely, async enqueue
that finds an in-progress or conflicting synchronous operation returns the
applicable closed posture and creates no job. Once either side has committed the
legacy batch, sync uses its direct governing serializer and async may create
only the replay job above. Independent two-connection tests cover both race
orders and kill removal of either side's common class-`10` lock/recheck.

For `legacy_projection_only|shadow`, above-limit input is the named
`operational_only_batch_limit` branch:

- the manifest stores exact positive W4 semantic item/target counts and
  streaming sequence/set fingerprints, with at least one count above 5000;
- streaming uses the existing deterministic item-identity derivation and
  sequence/set algorithms over each chunk in ordinal order; derived IDs are
  fingerprint values only and do not confer an operation claim;
- the job identity-proof vector is exactly `[]`; semantic entries remain only in
  bounded plan chunks and are operational compatibility state, not admitted W4
  source evidence;
- a private operational identity command fingerprint binds
  `{schemaVersion:1,kind:'operational_only_batch_limit',orgId,batchCommandId,
  sourceRef,legacyInputFingerprint,w4ItemCount,w4DistinctTargetCount,
  w4ItemSequenceFingerprint,w4ItemSetFingerprint}`;
- only the batch identity takes class-`10`; no W4 item operation identity is
  claimed or inserted;
- enqueue and worker each take one org-scoped operational-bulk class-`11`
  sentinel from one exported collision-tested derivation disjoint from every
  ordinary target key, rather than one advisory key per target. Competing bulk
  operational imports serialize on that sentinel; all actual
  record/revision/group rows are still locked and rechecked in canonical order
  before the first effect;
- authoritative posture rejects the branch before job/plan/revision/source DML;
- removing the whole-plan legacy execution or allowing the branch to contribute
  promotion evidence is a failure.

An all-invalid/skipped import has nonzero source rows but zero W4 items and zero
W4 targets. It is a named `operational_only_no_target` job branch:

- no synthetic item or target identity may be fabricated;
- empty W4 sequence/set fingerprints use the one exported canonical empty-vector
  fingerprints;
- the existing normalized W4 batch parser, operation-registry batch parser,
  operation-batch item-count CHECK, and nonempty operation proof-vector
  validator remain unchanged and are never called for this branch;
- one new private discriminated
  `buildAttendanceOperationalOnlyImportIdentityV1` creates only the verified
  batch identity and command fingerprint needed for class-`10` job reservation
  in all operational-only branches; for no-target its command fingerprint is
  SHA-256 of canonical JSON
  `{schemaVersion:1,kind:'operational_only_no_target',orgId,batchCommandId,
  sourceRef,legacyInputFingerprint}` and is never W4 calculation evidence;
- the job reservation helper, job-specific
  `attendance_w4_job_proof_vector_valid`, job item-count CHECK, V1 job-shape
  CHECK, and deferred job/manifest validator are replaced together. Count zero
  is accepted only with vector `[]` and `w4DistinctTargetCount=0`, then:
  `operational_only_idempotent_replay` requires zero source ordinals/chunks plus
  its locked replay precondition, while `operational_only_no_target` requires
  every positive-count source ordinal to be `skip`. A positive count with an
  empty vector is accepted only for `operational_only_batch_limit` and section
  3.1's exact above-limit/posture/chunk predicates. `strict_targeted` keeps the
  current nonempty vector equality;
- the replacement proof validator has the one explicit signature
  `(source_kind text, root uuid, vector jsonb, item_count integer,
  operational_branch text, distinct_target_count integer)`. The migration drops
  and recreates the dependent job CHECK, then removes the superseded four-
  argument function; it does not leave an overloaded legacy validator or an
  application-only branch predicate;
- it takes the batch/job identity lock but creates no W4 operation/source/result
  row and contributes no promotion evidence;
- it executes the exact legacy batch/item/skipped response in every write
  posture because there is no valid business target to make authoritative.

Removing any one of those predicates must return the existing invalid-empty-
reservation failure rather than enter this branch.

## 4. `LegacyImportExecutionPlanV1`

The plan is canonical JSON with exact-key rejection, null-prototype parsing,
bounded arrays/strings, and recursive freeze after parsing.

Exact-key rejection applies to every control object and discriminated union.
The governing legacy shape also contains source-defined JSON leaves such as
mapping snapshots, preview snapshots, and allowlisted compatibility metadata.
Those are permitted only in explicitly named leaf slots. Each leaf is canonical
JSON with one exported maximum encoded-byte size, depth, object-key count,
array length, and string length; it rejects prototype keys, non-finite numbers,
and unsupported values. The worker may copy a verified leaf verbatim only to
the one legacy JSONB/response slot named by its parent union. It may not inspect
one to choose authorization, lock, SQL identifier, branch, W4 evidence, or
result ownership. Leaf bytes remain covered by the chunk/plan digest and the
governing-SHA golden. Treating an opaque leaf as an extension/control object, or
silently dropping/truncating it, fails independently.

### 4.1 Root

```text
LegacyImportExecutionPlanV1 {
  schemaVersion: 1
  orgId
  jobId
  batchId
  sourceKind
  sourceRef
  createdBy
  actorId
  actorPosture
  tokenSubjectUserId
  acceptedWritePosture
  identityProofVectorDigest
  commandFingerprint
  legacyInputFingerprint
  operationalBranch
  legacyRowSourceKind
  sourceRowCount
  sourceOrdinalDigest
  w4ItemCount
  w4DistinctTargetCount
  w4ItemSequenceFingerprint
  w4ItemSetFingerprint
  legacySourceRowLimit
  groupRevision
  groupStateFingerprint
  chunkVectorDigest
  batch
  artifactCleanup
}
```

The root carries no free-form extension object. Each child is a closed
discriminated union. Effect arrays and chunk descriptors live only in bounded
child rows, not in the manifest JSON. The relational `chunk_count` plus
`chunkVectorDigest` bind the exact dense child set. `planDigest` binds the
logical canonical plan stream and is independent of physical chunk boundaries.
`chunkVectorDigest` separately binds the exact persisted chunk indexes, ranges,
and digests.

`legacyRowSourceKind` is null exactly for
`operational_only_idempotent_replay/precheck_hit`; that observation
may carry only an idempotency key and cannot pretend that an unopened source
family was selected. Otherwise it is the exact closed union
`uploaded_csv|inline_csv|direct_rows|entries|dingtalk_tabular`. The first two
require `legacySourceRowLimit`; the remaining three require null. It is
independent of W4 `sourceKind='import_batch'`. Root `sourceRef` remains the
non-null W4 source identity required by the governing V1 job contract; it is not
a claim that a legacy row source was opened.

The durable plan exists only for the authenticated P07 async route. Its selected
source precedence is:
`uploaded_csv > direct_rows > inline_csv > entries > dingtalk_tabular`.
`dingtalk_tabular` is the fallback only when none of the preceding families is
present. The selected family is frozen in `legacyRowSourceKind`; only the
selected source bytes/rows and the presence facts needed to select it enter
`legacyInputFingerprint`. Ignored lower-priority payload fields are neither
opened nor fingerprinted. Tests cover at least `rows+upload`,
`upload+csvText`, and `entries+data`. Replacing that order with last-writer-wins
or the synchronous route's distinct
`direct_rows > uploaded_csv > inline_csv > entries > dingtalk_tabular` order is
a compatibility failure. P06 retains that governing synchronous order in its
own path; it does not persist this plan.

`legacyInputFingerprint` is a branch-discriminated retry key independent of
new server-minted effect IDs.
For `strict_targeted|operational_only_no_target|
operational_only_batch_limit`, it is SHA-256 of canonical JSON for the validated
request inputs that can change an all-new legacy execution: schema version,
org/batch/source identity, the distinct legacy requester/`createdBy` identity,
row-source kind, CSV parsing options, fallback `userId`, `userMap`,
`userMapKeyField`, `userMapSourceFields`, import mode, batch source and
`batchMeta`, the normalized legacy `idempotencyKey`, rule-set/mapping/profile
selectors and explicit overrides as
submitted, explicit engine and status-map configuration, timezone,
merge/override and metadata options, item-return/truncation/skipped-sample
policy, group-sync request, and artifact-cleanup identity. For in-request
`direct_rows|entries|dingtalk_tabular|inline_csv`, it additionally binds every
ordered normalized submitted row value or the exact inline CSV byte sequence
without performing business-row resolution. For
`uploaded_csv`, it binds the opaque org-scoped upload file ID and submitted CSV
options but does not reread file contents on an existing-job or early-
idempotency retry; the accepted plan's source-ordinal and plan digests bind the
one file read performed for an all-new plan. It excludes selected current
rule/profile/group values, server-minted job/item/record IDs, current
record/group preimages, authorization headers/credentials, commit tokens,
secrets, elapsed time, and result slots. Neither the fingerprint input nor the
plan may persist a credential or commit token. The parser computes it before
effect IDs are minted. Changing any covered request input conflicts; current DB
or uploaded-file state changing after the first accepted job does not make a
congruent retry rebuild or replace that job.

For `operational_only_idempotent_replay`, the same column uses the separate
closed canonical input
`{schemaVersion:1,kind:'idempotent_replay',orgId,idempotencyKey,
replayBatchId,replayPreconditionDigest}`. It intentionally excludes submitted
row/file bytes and `createdBy`, because governing P07 full-import
replay is org/key-wide and returns the locked committed batch without reopening
or reinterpreting the source. The branch discriminator prevents either
fingerprint domain from satisfying the other.

The logical plan stream is the canonical JSON encoding of exactly:

```text
{
  schemaVersion, orgId, jobId, batchId, sourceKind, sourceRef,
  createdBy, actorId, actorPosture, tokenSubjectUserId, acceptedWritePosture,
  identityProofVectorDigest, commandFingerprint, legacyInputFingerprint,
  operationalBranch, legacyRowSourceKind,
  sourceRowCount, sourceOrdinalDigest,
  w4ItemCount, w4DistinctTargetCount,
  w4ItemSequenceFingerprint, w4ItemSetFingerprint,
  legacySourceRowLimit, groupRevision, groupStateFingerprint, batch,
  items: all items in ordinal order,
  recordWrites: all writes in canonical target order,
  groupEffects: all effects in canonical normalized-key order,
  artifactCleanup
}
```

Canonical JSON uses UTF-8, sorted object keys, array order as stated, exact
integer decimal text, and no insignificant whitespace. `chunkVectorDigest` is
SHA-256 of canonical JSON for the ordered descriptor array
`[{chunkIndex,firstSourceOrdinal,sourceRowCount,chunkDigest}]`.

### 4.2 Batch plan

The batch plan freezes every legacy batch-row input:

- source, rule-set ID, mapping snapshot, source row count, status;
- idempotency key and the exact existing visibility rule for idempotent replay;
- engine, chunk, record-upsert, and item-insert strategy;
- mapping-profile ID and the closed compatibility metadata;
- group-sync options and warning inputs;
- item-return, item-limit, and skipped-sample policy.

Values calculated from execution results, such as actual inserted group-member
count, are represented as named result slots. They are not guessed at enqueue.

`batch` is a closed discriminated union. The normal variant contains the inputs
and result slots above. The `idempotent_replay` variant contains only the locked
existing-batch read set named in section 3.1,
`replayPreconditionDigest`, and
`replaySelector:'precheck_hit'|'locked_race'`; it cannot contain mapping, item,
record, group, authorization-mode, target-vector, or mutable result slots.
`precheck_hit` requires null `legacyRowSourceKind` and
`artifactCleanup.kind='none'`. `locked_race` permits only the root cleanup
identity derived from the already-opened uploaded source, or `none` for a
non-upload source. The exact root/DB branch checks reject either variant or
cleanup/source shape under the wrong operational branch/selector.

### 4.3 Item plan

Outside `operational_only_idempotent_replay`, across the dense ordered chunks
there is exactly one item entry for every source ordinal, including rows that do
not produce a W4 target. The replay branch has zero chunks and no item entry.

```text
item =
  | {
      kind: 'apply',
      ordinal,
      semanticOrdinal,
      itemId,
      targetRef,
      previewSnapshot,
      recordWriteRef
    }
  | {
      kind: 'skip',
      ordinal,
      semanticOrdinal: null,
      itemId,
      resolvedUserId,
      resolvedWorkDate,
      reasonCode,
      warnings,
      previewSnapshot
    }
```

Requirements:

- ordinal is dense `0..sourceRowCount-1`;
- `semanticOrdinal` is the dense `0..w4ItemCount-1` rank of `apply` entries in
  source order; it is null for `skip`. W4 proof-vector ordinals, item-operation
  ID derivation, and sequence/set fingerprints use `semanticOrdinal`, never the
  source ordinal;
- item ID is server-minted before plan persistence;
- `resolvedUserId` and `resolvedWorkDate` preserve the post-mapping/fallback
  values written to `attendance_import_items` and the skipped response; either
  may be null independently and neither is reconstructed from raw snapshot data;
- skipped reason codes are closed and values-free;
- a duplicate W4 target retains all operational ordinals;
- item order is the response order and cannot be rebuilt from target order;
- `sourceOrdinalDigest` binds every source ordinal, including invalid/skipped
  rows that have no W4 identity;
- W4 item count and fingerprints bind only canonical W4 semantic items and must
  equal the job values;
- the W4 semantic item remains separately strict-parsed and digest-bound.

Chunk boundaries are operational only. Changing chunk size cannot change item
order, target folding, group intents, response order, W4 item fingerprints, or
the logical plan digest. It does change `chunkVectorDigest`; a congruent retry
must reuse the persisted manifest rather than rechunking.

`sourceOrdinalDigest` is SHA-256 of canonical JSON for the ordered array of
`{ordinal,semanticOrdinal,kind,itemId,resolvedUserId,resolvedWorkDate,targetRef,
recordWriteRef,reasonCode}` with absent union fields encoded as null.
Snapshots/warnings are bound by `planDigest`; they are not duplicated into this
identity digest. A first-row skip followed by an apply therefore binds source
ordinals `0,1` but W4 semantic ordinal `0`; source reordering or using source
ordinal `1` in the W4 proof must fail.

A `recordWrite` is stored in the chunk containing its first contributing source
ordinal. A `groupEffect` is stored in the chunk containing its first referencing
source ordinal. Cross-chunk references use server-minted IDs, and duplicate
definitions are rejected.

### 4.4 Record-write plan

Each unique `(org,user,workDate)` record write freezes:

- source ordinals folded into the target, in input order;
- exact merge/override mode;
- exact first/last punches and compatibility metrics;
- target revision, existing-record precondition fingerprint, and expected
  source ownership;
- server-minted record ID for a new parent, or the exact existing record ID;
- allowlisted compatibility metadata, policy/profile/multi-punch/attribution
  snapshots, and source batch ID;
- result fields needed by item snapshots and response construction.

`existing-record precondition fingerprint` is not a placeholder. It is lowercase
SHA-256 of canonical JSON with this exact, ordered read set from the enqueue
SERIALIZABLE snapshot while class-`11` and the target revision `FOR SHARE` are
held:

```text
{
  exists,
  id,
  orgId,
  userId,
  workDate,
  firstInAt,
  lastOutAt,
  workMinutes,
  lateMinutes,
  earlyLeaveMinutes,
  status,
  isWorkday,
  meta,
  sourceBatchId
}
```

Dates are canonical `YYYY-MM-DD`, instants are canonical UTC ISO strings, JSON
objects use recursively sorted keys, and SQL null remains JSON null. Missing row
uses `exists:false` with every other key null. Adding or removing a field
requires an amendment.

The migration adds `attendance_record_target_revisions` with primary key
`(org_id,user_id,work_date)`, `revision bigint NOT NULL`, and created/updated
timestamps. It backfills revision `1` for existing attendance records. A single
named DB function `attendance_bump_record_target_revision()` runs from
`BEFORE INSERT OR UPDATE OR DELETE` triggers on `attendance_records`: it
creates/locks the exact target revision row and increments it before the record
mutation. Moving a record between target keys is forbidden. Revision rows reject
application update/delete; the trigger is their only mutator. `BEFORE TRUNCATE`
guards reject truncation of both `attendance_records` and the revision table
while this schema is installed, because PostgreSQL row triggers do not observe
`TRUNCATE`.

For `strict_targeted`, V1 enqueue obtains canonical class-`11` target advisory
keys. For `operational_only_batch_limit`, it obtains only the one org-scoped
operational-bulk class-`11` sentinel; replay/no-target obtains no target lock.
Every branch with record writes then initializes absent revision rows at `0`,
locks all revision rows `FOR SHARE` in target order, and uses non-locking MVCC
reads for existing/missing record preimages. The revision share lock prevents a
trigger-backed writer from committing a revision change through that snapshot;
enqueue itself does not invert an old writer's existing
record-row-then-trigger order. It freezes each revision and precondition
fingerprint through plan/job commit.

The worker reacquires the branch-authorized strict target set or operational
bulk sentinel first, then uses the frozen `exists` bit to preserve the database
writer order per canonical target. It locks/rechecks every required pair before
the first effect DML:

- for `exists:true`, lock the exact attendance-record row first, then lock the
  target revision `FOR UPDATE`, require the frozen revision, and recompute the
  full precondition;
- for `exists:false`, lock the target revision `FOR UPDATE` first, then recheck
  that the record is still absent before insert.

Its own record DML increments the revision in that transaction. A disappeared
`exists:true` row or appeared `exists:false` row fails the precondition; it does
not switch lock orders or reinterpret the plan.

This side table is the row-independent version required by the governing lock:
even a retained writer that does not yet use class-`11` must pass the DB trigger,
so its commit changes the rechecked revision. Existing-row writers take the
business row before their row trigger; missing-row inserts reach the revision
trigger before a conflicting row exists, which is why the worker's two lock
orders above are branch-specific. A two-connection race covers both commit
orders for present and absent parents; the worker never overwrites an insert
made from a stale `exists:false` snapshot. A retained multi-row writer with a
different row order can still produce SQLSTATE `40P01`; the canonical worker's
governing bounded whole-transaction retry handles that code, and tests prove
retry or fail-closed zero-effect behavior rather than promising deadlock-free
legacy SQL. Post-cutover canonical contributors still must use the one exported
class-`11` helper. The helper selects exact target keys only for strict jobs and
the one org bulk sentinel only for the ratified above-limit operational branch.
V1 enqueue remains disabled until old plugin import workers have drained.
Restoring an unlocked post-cutover caller, taking per-target advisory locks for
an unbounded operational batch, disabling/bypassing the trigger, accepting a
changed revision, or surfacing a partial effect after `40P01` is a required
independent failure.

The worker locks and rechecks the record precondition before write. A mismatch
does not silently recalculate against current state; it fails closed with a
closed `ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED` job transition. It
leaves batch, item, group, record, W4, terminal-response, and cleanup DML
unchanged; the failed job is immutable and a retry requires a new authorized
command.

### 4.5 Group-effect plan

Group effects are closed intents:

```text
groupEffect =
  | { kind: 'ensure_group', groupId, normalizedName, code, timezone, ruleSetId }
  | { kind: 'ensure_member', memberId, groupRef, userId }
```

For a missing planned group, `groupId` is server-minted only after the
all-new-job recheck and the insert explicitly supplies that ID. On conflict,
the existing row ID wins exactly as today and the pre-minted ID remains an
unused plan value. `memberId` follows the same rule for
`ON CONFLICT DO NOTHING`. This makes same-process/restart/golden identity
comparable without deriving a new group/member ID after restart.

The migration adds `attendance_group_effect_revisions` with
`org_id text PRIMARY KEY`, `revision bigint NOT NULL`, and created/updated audit
timestamps. DB `BEFORE INSERT OR UPDATE OR DELETE` row triggers on
`attendance_groups` and `attendance_group_members` create/lock that org's
revision row and increment it before the group/member mutation through the one
named function `attendance_bump_group_effect_revision()`. Moving a row between
orgs is forbidden. This trigger is the serialization boundary for admin,
import, and direct service SQL; it does not depend on each caller remembering an
advisory helper. Group revision rows reject application update/delete; only the
trigger and the idempotent zero-row initializer may mutate them. `BEFORE
TRUNCATE` guards reject truncation of `attendance_groups`,
`attendance_group_members`, and the group revision table while this schema is
installed.

After class-`10` identity locks, enqueue creates/locks the revision row
`FOR SHARE`, then uses non-locking MVCC reads for the group/member state used to
build the plan. It freezes both the revision and `groupStateFingerprint`,
SHA-256 of canonical JSON over the exact sorted
`(group id,org,name,code,timezone,ruleSetId)` rows and intended
`(org,group,user)` membership existence bits.

The worker first acquires the branch-authorized strict record-target keys or the
single operational-bulk sentinel. For group effects, it then locks every
frozen-existing group and member business row in canonical UTF-8 identity order
before locking the org revision row `FOR UPDATE`. After the revision matches,
it rereads the exact existing rows plus all frozen-missing group/member keys and
requires the fingerprint before DML. This matches a
single-row legacy `UPDATE|DELETE`'s business-row-then-trigger order while the
revision lock serializes missing-row inserts. Its own DB triggers increment the
revision in that transaction. A retained multi-row writer with a different
order may yield `40P01`; the same bounded whole-transaction retry/zero-effect
rule as section 4.4 applies. If no group effect exists, both manifest fields are
null and no revision or group/member row is locked.

The worker:

- uses org-scoped unique keys;
- uses the existing group/member row order and revision sequence above before
  any group/member DML;
- preserves the existing `ensureAttendanceGroups` statement exactly:
  `ON CONFLICT (org_id,name) DO UPDATE` fills only null timezone/rule-set fields,
  updates `updated_at`, and each returned row increments legacy
  `groupCreated`, including a conflict-update row;
- preserves member insertion's existing `ON CONFLICT DO NOTHING` semantics and
  derives `groupMembersAdded` from rows actually inserted;
- never reloads current mapping, group name, auto-create, auto-assign, timezone,
  or rule-set selection to change the plan.

Changing `groupCreated` to "new physical rows only", omitting the conflict
update, or locking group rows in input order is a compatibility failure.

Option (a) explicitly hardens one race: cooperating canonical workers serialize
group effects through the DB revision row, so the first worker reports the
legacy returned row and a waiter fails the frozen precondition and must be
replanned rather than running stale intent. Within one accepted transaction, a
pre-existing group still follows the exact conflict-update/`groupCreated` rule.
This concurrency ordering change is accepted only if `OD-W4C-56=(a)` is
RATIFIED; it is not described as byte-identical to the old unlocked dual-worker
race.

### 4.6 Terminal response

The durable terminal contract is async-only. P07/P08 stores one exact compact
job summary plus the execution observation
`first_execution|idempotent_early|idempotent_in_transaction`. P06 synchronous
HTTP never creates, adopts, or reads this terminal-response row and never calls
the private queue processor.

The payload is the exact compact summary produced by the governing
`buildAsyncCommitJobSummaryPayload`:

```text
async_job_summary =
  __jobType|idempotencyKey|__importEngine|recordUpsertStrategy|
  itemsInsertStrategy|summary

summary required keys =
  processedRows|failedRows|elapsedMs|chunkConfig
```

`__jobType` is exactly `commit`. `summary.skippedCount` exists exactly when the
normalized count is positive; `summary.skippedRows` exists exactly when the
normalized bounded sample is nonempty. The existing `mapImportJobRow` continues
to produce its exact public job key set from immutable job columns and this
summary. For V1, the private job projection SQL joins the terminal-response row
and supplies that response to the mapper; it does not copy the summary into a
second mutable job-payload field or fall back to the frozen public-job envelope
as completed result data. Null-version jobs retain their governing
mapper/payload path. This amendment
does not expose the internal async helper return as a new API response. All
three observations use this one closed schema with observation-specific values.

Every list/get/retry projection of a V1 job applies the same visibility rule
before returning mapper data: the caller must currently hold full-import access
and the job must belong to that org. A UUID lookup is not visibility. A same-org
caller without full-import access and every cross-org caller receive the
governing closed not-found/forbidden shape and no terminal summary. Adding a
scheduler-scoped async projection requires a separate amendment.

The migration adds private immutable table
`attendance_import_legacy_terminal_responses`:

| Column | Contract |
| --- | --- |
| `job_id uuid PRIMARY KEY` | V1 job; `ON DELETE RESTRICT` |
| `org_id text NOT NULL` | equals job/plan org |
| `response_variant text NOT NULL` | exactly `first_execution|idempotent_early|idempotent_in_transaction` |
| `response_digest text NOT NULL` | SHA-256 of the canonical compact async summary |
| `response jsonb NOT NULL` | exact-key parsed compact async summary |
| `created_at timestamptz NOT NULL` | immutable terminal audit |

The terminal payload is result state, not enqueue-plan input. The worker
constructs the actually selected observation's compact summary, inserts that
payload, and terminalizes the job in the same business transaction. The
deferred validator requires exactly one congruent row when and only when the V1
job enters `completed`; queued, running, failed, canceled, or remediation-only
jobs have none. DB update/delete guards make variant, digest, and payload
immutable.

Selection is executable and does not conflict with P07's one existing-job
response:

| Observation | Selected behavior |
| --- | --- |
| before the canonical transaction, a values-only candidate read sees no matching committed legacy batch; after the import-idempotency and W4 locks, the locked recheck still sees none | execute effects and store `first_execution` |
| async candidate sees matching committed legacy batch `B`; under canonical locks the exact same `B` is re-read and congruent | freeze `replaySelector='precheck_hit'`; zero effect/cleanup DML; store `idempotent_early` |
| the candidate read sees none, but after source planning and canonical/import-idempotency locks a congruent committed batch now exists | freeze `replaySelector='locked_race'`; zero batch/item/record/group and W4 source/result DML; store/return `idempotent_in_transaction` and, only for an already-opened uploaded source, append its cleanup command |
| candidate existed but disappears or differs at locked recheck, or the locked row is incongruent | fail closed; no terminal response and no source/effect DML |
| async P07 reservation finds a visible existing queued/running V1 job | return the one existing mapped operational job response; do not invoke the legacy selector |
| executor retry finds a completed congruent V1 job | return its immutable stored compact summary with zero DML; never reselect |

The pre-transaction candidate is not authority; only the locked recheck selects
a branch. No branch rebuilds a response from current settings or records.
`OD-W4C-56=(a)` therefore preserves one immutable observation per V1 job.

Plan/job `batchId` remains the W4/job command identity and the ID to insert on
`first_execution`. The compact async terminal summary contains no batch ID, and
the public job mapper continues to expose the immutable job-row `batch_id`.
`replayBatchId` remains an internal locked-batch precondition only; it does not
rewrite job/plan identity or pretend the replay job inserted that batch.
Command and replay IDs plus the selected variant are covered by
observation-selector tests.

Cross-run parity compares every deterministic compact-summary field
byte-for-byte. The existing `elapsedMs` field retains its observation
semantics: literal zero for early replay, otherwise measured duration. Measured
durations, derived mapper `updatedAt`, and throughput are compared by key, type,
and their governing deterministic relation rather than literal wall-clock
value. This does not permit dropping, renaming, or defaulting any compatibility
field.

The independently tested P06 path preserves the governing synchronous key sets
and wrappers for first execution, direct early replay, and locked-race replay.
Those HTTP bytes are part of the governing-SHA compatibility golden, but they
are not persisted as a V1 terminal response and are not worker/restart state.
Sharing pure parsing/effect-adapter code with P07 is permitted; routing P06
through the private queue processor or returning an async job from P06 fails.

### 4.7 Artifact cleanup

```text
artifactCleanup =
  | { kind: 'none' }
  | { kind: 'uploaded_import_file', fileId, expectedOwnerOrgId }
```

The migration adds private table `attendance_import_upload_cleanup_commands`:

| Column | Contract |
| --- | --- |
| `job_id uuid PRIMARY KEY` | one command per job, foreign key `ON DELETE RESTRICT` |
| `org_id text NOT NULL` | equals locked job/manifest org |
| `file_id uuid NOT NULL` | equals the frozen cleanup file ID |
| `status text NOT NULL` | `pending|processing|completed|failed_retryable` |
| `attempt_count integer NOT NULL` | nonnegative, incremented per claimed attempt |
| `claim_token uuid` | non-null only while processing |
| `lease_expires_at timestamptz` | non-null only while processing |
| `last_error_code text` | closed values-free operational code only |
| `created_at/updated_at timestamptz NOT NULL` | operational audit |

The claim transition is one compare-and-set under `FOR UPDATE SKIP LOCKED` from
`pending|failed_retryable` (or expired `processing`) to a fresh processing
token/lease. Completion or retryable failure requires that exact token.
Concurrent normal/recovery drainers cannot own the command together. The table
has no public route and cannot supply business evidence.

The P07/P08 business transaction appends a durable cleanup command only after
the legacy source effect is ready to commit. The effect, completed job,
terminal summary, and pending command commit atomically. After commit, the
worker immediately attempts to drain that command. As in the current
`Promise.allSettled` behavior, unlink failure does not change or suppress the
business response; it records `failed_retryable` and returns that response. If
the process exits after business commit, a private recovery worker resumes the
idempotent deletion from `pending|failed_retryable|expired processing`; it never
rolls back the already-committed business result.

Because a public poll can race the post-commit drain, option (a) does not claim
that every observer sees one cleanup attempt before the completed job. It
accepts that narrow async timing change explicitly in favor of atomic,
restart-safe business completion. The stored response and public job payload are
independent of cleanup state and remain byte-stable.

Command creation is selected, not inferred from artifact presence alone. An
uploaded-file plan creates one command for `first_execution` and
`idempotent_in_transaction`, because both current branches reach the post-
transaction upload cleanup. For replay, only
`replaySelector='locked_race'` may select `idempotent_in_transaction` and carry
that uploaded-source cleanup identity. `replaySelector='precheck_hit'` selects
`idempotent_early`, requires `artifactCleanup.kind='none'`, and creates no
command because the current branch returns before resolving the row source or
attempting deletion. Non-upload plans create none. The deferred validator
checks cleanup presence, org/file identity, replay selector, terminal-response
variant, and plan cleanup union as one closed relationship.

This is one explicit compatibility exception under option (a): a cleanup failure
after the business transaction cannot rewrite the already-atomic terminal job
to a business import failure. The stored business response remains successful
and cleanup remains operationally retryable. Normal-path worker execution still
attempts cleanup immediately after commit. Option (b) does not
define this hardening.

The file and cleanup row remain operational-only under P25. Missing files count
as idempotent cleanup completion. File contents are never reread as business
input during P08 recovery.

P06 remains outside this job-keyed cleanup table. Its synchronous path retains
the governing post-commit best-effort upload deletion and response ordering;
the shared source/effect adapter does not manufacture a V1 job merely to obtain
durable cleanup. A future durable synchronous-upload cleanup contract would
require its own identity and amendment.

## 5. Enqueue and worker transaction contracts

### 5.1 Enqueue

P06 synchronous commit and P07 asynchronous enqueue share the canonical
authorization, posture, class-`10` lock, source parser, pure child-union
builders, and legacy effect-adapter modules. They do not share the durable
job-root builder or job ownership. P06 executes
its prepared effect in its own governing `SERIALIZABLE` source/effect
transaction, serializes the governing HTTP response, and creates no V1
job/manifest/terminal-response row. It never calls the private queue processor.
Under the common class-`10` locks it must:

1. preserve full-import batch replay before source opening and scoped replay
   only after row-derived authorization;
2. recheck the legacy batch plus any P07 job/operation reservation before
   effect DML;
3. return the governing direct sync idempotent serializer when the committed
   batch is present;
4. return the governing typed in-progress/conflict with zero DML when a
   queued/running/failed/remediation-only P07 job or synchronous operation owns
   the identity; and
5. preserve the governing per-path token ordering from section 3.1: full-import
   required check after its early replay; scoped required check before source
   parsing and requester-bound replay; and token consumption on both paths only
   after an allowed replay did not return and before any all-new source/effect
   DML; and
6. execute the all-new prepared effect and response atomically only when both
   rechecks are all-new.

The synchronous path may reuse the same pure child-union builders and effect
adapters in memory, but not the job-root type; it cannot persist, adopt, or
return an async job identity. Cross-path tests cover P06-first/P07-first and
committed/in-progress outcomes; routing P06 through P07/P08 or allowing both
sides to write fails independently.

P07 has a zero-DML existing-job replay preflight before one effect-bearing
`SERIALIZABLE` enqueue transaction. The two boundaries never pass row locks or a
mutable snapshot between them:

1. validate current full-import authorization and the governing async route
   schema, then
   derive only source-free batch-command, normalized idempotency, actor, and
   visibility candidate identities;
2. perform a values-only candidate read by the normalized route idempotency key
   without opening/hash-parsing a row source or resolving mutable current
   business state. A batch-command-only executor candidate is deferred until the
   effect-bearing transaction can compute its applicable fingerprint;
3. if a candidate exists, enter a short transaction, acquire class-`00` and its
   complete globally sorted class-`10` set, and re-read it under the normalized
   route-idempotency contract. Full-import access is org/key-wide and does not
   compare `createdBy`. The source is never reopened and no operational row
   grants authorization.
   Contract version is discriminated before inference. Null-version follows the
   governing pre-cutover retry rule; partial/unknown is remediation-only. When
   the row would also match a private executor identity, normalized route
   idempotency still governs, so a second full-import admin may receive the
   org-wide job without becoming its private executor. A visibility,
   authorization, or shape failure returns the governing typed result. This
   transaction performs zero DML;
4. only when no existing job returned, perform the governing required-token
   check and one-time consumption before the plan/job transaction. This retains
   the current failure boundary: the token is not restored if later enqueue
   fails, and a race found only after consumption may return the winner.

The effect-bearing P07 enqueue then uses one `SERIALIZABLE` transaction:

1. revalidate full-import authorization from fixed core queries;
2. acquire class-`00`, resolve write posture, and reject blocked/suspended
   authoring as defined by the governing lock;
3. for full-import access with a visible legacy idempotency key, perform the
   org/key-wide values-only batch candidate read before source access. A second
   currently authorized full importer is not rejected because `createdBy`
   differs;
4. if that full-import candidate exists, acquire the replay branch's complete
   batch/job/idempotency class-`10` set, re-read it, compute the replay-domain
   `legacyInputFingerprint`, and insert only the
   `precheck_hit` replay job/manifest with zero chunks, null selected row source,
   and `artifactCleanup.kind='none'`;
5. when no path returned, select/read the row source using section 4.1's async
   precedence and compute the normal-branch `legacyInputFingerprint`. Only
   selected `uploaded_csv|inline_csv` freezes and enforces the existing CSV
   limit; direct rows, entries, and DingTalk tabular input retain no CSV-derived
   cap;
6. resolve current rule/profile/directory inputs in this snapshot, classify
   every source ordinal as apply/skip, assign dense semantic ordinals to apply
   entries, and compute exact semantic item/target counts plus streaming
   fingerprints;
7. apply section 3.1's posture-specific limits and choose exactly one branch.
   Build the unchanged strict W4 semantic envelope only for `strict_targeted`;
   otherwise build only the private operational identity;
8. acquire one complete, globally sorted class-`10` set containing the
   branch-authorized batch/item identities and, when present, the canonical
   legacy-idempotency key. Recheck operation/job reservations and the legacy
   batch. If a racing legacy batch now exists, discard the unpersisted effect
   plan and insert only `locked_race`, retaining no source/effect intent except
   an uploaded-source cleanup identity already derived from the opened source. A
   racing job first applies any authorized normalized route-idempotency replay.
   If none
   applies, private batch-command executor retry requires the same authorized
   actor/posture, token subject, legacy requester/`createdBy`, source reference,
   command identity, and branch-discriminated `legacyInputFingerprint`; a
   mismatch is typed 409. An in-progress synchronous owner yields the governing
   typed contention posture with zero job DML;
9. only for an all-new non-replay reservation, acquire every strict target
    class-`11` key in final signed-key order, or the one org operational-bulk
    sentinel for `operational_only_batch_limit`. Initialize/lock target-revision
    rows `FOR SHARE` in canonical order and freeze each record precondition;
10. if group effects exist, lock the org group-revision row `FOR SHARE` before
    reading/freeze-hashing group/member state;
11. server-mint the new job, legacy item, prospective record, and planned
    group/member effect IDs, then stream the manifest/chunks;
12. insert the V1 job, manifest, and all required chunks together;
13. let the deferred congruence trigger validate the complete set and commit.

No operation, import batch/item, attendance record, group/member, calculation,
result, terminal-response, or cleanup row is created at enqueue. Initializing a
missing target/group revision row is permitted concurrency metadata only; it is
not source, result, authorization, or promotion evidence and rolls back if
enqueue fails.

A congruent HTTP retry does not rebuild a plan whose server effect IDs or frozen
DB preimages would differ. Job replay uses the preflight; legacy-batch replay
uses transaction steps 3/4; a first-writer race discovered after derivation
uses transaction step 8's complete comparison. Neither treats a newly resolved
write posture as a retry-congruence field. Any covered mismatch is typed and
fail-closed.
Manifest/chunk/plan-digest validation belongs to worker execution of that
accepted job, not retry candidate reconstruction.

### 5.2 Worker and restart recovery

P07 worker and P08 restart recovery enter the same private processor. Before
manifest/chunk access, it preserves the governing contract-version, suspension,
authorization, job-state, and posture precedence:

1. read only candidate job identity before lock;
2. start the canonical `SERIALIZABLE` transaction;
3. acquire class-`00`, resolve posture, and discriminate contract version;
4. a null-version pre-cutover job requires
   `legacy_projection_only`, locks only the job after class-`00`, and executes
   only the governing byte-compatible legacy worker with source effect and
   terminal job status in one transaction. It never reads or receives a V1
   plan; any other posture or partial shape is remediation-only;
5. for a suspended V1 job, acquire no class-`10`, class-`11`,
   operation, batch/item, target-revision, group-revision, manifest, or chunk
   lock. Lock/re-read only the job. A queued job remains queued, records the
   governing values-free suspended reason, and returns the retry posture even if
   its actor has meanwhile lost authorization. An already completed job is not
   exposed or rewritten by this private suspended-worker branch; authenticated
   route replay applies section 4.6 visibility before returning its immutable
   terminal response. Both paths perform zero source/result/effect DML, and any
   other state follows the governing remediation rule;
6. for a non-suspended V1 candidate, perform the actor-level canonical
   authorization check before manifest/chunk access. If it rejects, derive
   class-`10` only from strict frozen job columns, acquire it, lock/re-read the
   job, and repeat the check. A still-`queued|running` job transitions only to
   `failed/ATTENDANCE_IMPORT_LEGACY_PLAN_AUTHORIZATION_REJECTED`; a completed
   job is not exposed or rewritten. This closed failure reads no manifest/chunk
   and takes no class-`11` or business-row lock;
7. for an authorized non-suspended V1 job, derive the branch-authorized
   class-`10` set from the strict-parsed frozen job proof/branch, acquire those
   locks, recheck operation and job state, and apply the governing
   completed/all-new/mixed and frozen-posture state machine. A completed
   congruent job returns its immutable stored response with zero source/effect
   DML;
8. only a non-suspended `(queued, all-new)` job whose current write posture equals
   its frozen accepted posture proceeds. Lock the job, manifest, and chunks;
9. verify plan version/digest and every frozen identity/fingerprint, then parse
   the plan with exact-key rejection. A V1 worker never reads or parses the
   legacy job `payload` as business input;
10. only after full-import authorization and exact plan verification, treat plan
   target identities as untrusted lock/query inputs and derive the complete
   branch-authorized class-`11` shape: every strict target key or the single org
   operational-bulk sentinel. No plan/batch value grants authorization. Acquire
   the locks in canonical order, then lock/recheck every section 4.4
   existing-row-first or absent-revision-first pair before any effect. If group
   effects exist, apply section 4.5's row/revision order only after every target
   pair;
11. recheck record and revision-bound group preconditions;
12. execute the governing strict W4 operation/source/calculation/result path
    exactly when the `strict_targeted` branch and frozen write posture require
    it, together with exactly the closed legacy batch/item/group/record effects
    that the accepted plan froze for that posture. The amendment does not make a
    legacy record write authoritative or require every legacy effect union in
    every posture: legacy and shadow preserve their governing compatibility
    projection, while authoritative result ownership remains the governing W4
    contract. `legacy_projection_only` and all operational-only branches retain
    their governing zero-W4-operation/source/result posture;
13. insert the immutable selected terminal response and any selector-authorized
    cleanup command, seal any required strict W4 batch/items, and terminalize the
    job in the same transaction;
14. commit;
15. if a cleanup command exists, attempt it before the private processor
    returns, without changing the already-visible stored response if cleanup
    becomes retryable.

For an uploaded artifact, `first_execution` and
`idempotent_in_transaction` create the cleanup command; the latter is valid for
a replay job only with `replaySelector='locked_race'`.
`idempotent_early`/`precheck_hit` creates none because full-import replay returned
before opening a source. A non-upload source creates none. The deferred
validator enforces that selector and source-shape relationship.

An empty process, changed current rule/settings/profile/group mapping, or
deleted upload file cannot change the business result. Unknown plan version,
missing manifest/chunk, digest mismatch, identity mismatch, authorization
failure, or precondition mismatch is fail-closed. Except for the governing
suspension branch that remains queued, the seven section 6 plan failures enter
one immutable terminal `failed` reason and leave every business,
terminal-response, and cleanup effect absent. Recovery uses a new authorized
command rather than reopening that job.

## 6. Upgrade, down, and failure posture

- Existing null-version jobs continue through the already-governed
  null-version byte-compatible worker and never receive a plan backfill.
- No V1 job may be inserted without a complete manifest/chunk set after this
  migration. The section 3 quarantine exception is UPDATE-only for a previously
  committed job; it cannot make an incomplete initial INSERT legal.
- A V1 job created by an abandoned experimental build without a complete plan is
  remediation-only and cannot execute or be inferred.
- Migration `down` refuses while any manifest row, chunk row, cleanup-command
  row, terminal-response row, or V1 job exists, whether the job is
  queued, running, failed, or terminal. It preserves the governing migration's
  stronger any-V1-history refusal.
- Only after that zero-V1 guard passes may `down` remove the record/group
  revision triggers and their support tables; support rows alone are
  concurrency metadata and are not erased to make a V1-history guard pass.
- Plan rows are retained with job history; application code does not delete or
  rewrite them.
- A plan digest/version failure is not mapped to a business import failure and
  does not mutate accepted posture.

Closed operational reason codes added by this amendment:

| Reason code | Status | Same-job retry | Permitted recovery |
| --- | --- | --- | --- |
| `ATTENDANCE_IMPORT_LEGACY_PLAN_MISSING` | `failed` | no | operator quarantines/remediates the failed job without rewriting plan history, then a new authorized command |
| `ATTENDANCE_IMPORT_LEGACY_PLAN_CHUNK_MISSING` | `failed` | no | operator quarantines/remediates the failed job without rewriting plan history, then a new authorized command |
| `ATTENDANCE_IMPORT_LEGACY_PLAN_VERSION_UNSUPPORTED` | `failed` | no | compatible deployment or explicit migration, then a new authorized command |
| `ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH` | `failed` | no | integrity incident remediation, then a new authorized command |
| `ATTENDANCE_IMPORT_LEGACY_PLAN_IDENTITY_MISMATCH` | `failed` | no | identity/history remediation, then a new authorized command |
| `ATTENDANCE_IMPORT_LEGACY_PLAN_AUTHORIZATION_REJECTED` | `failed` | no | authorization must be restored and the caller must submit a new command |
| `ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED` | `failed` | no | caller may replan through a new command against current state |

The migration replaces `chk_aij_w4_exec_reason` so these seven codes are valid
only with `status='failed'`; the two governing pre-existing reason/status pairs
remain unchanged. A guarded transition permits only `queued|running -> failed`
for these codes, inside the fail-closed worker transaction before any business
effect. The reason is immutable once written. `failed -> queued|running` is
forbidden, no new job may be inserted directly in one of these failure states,
and no row above may coexist with a terminal response. Only the two named
missing-history codes relax manifest/chunk completeness, and only for that
UPDATE transition; every other congruence predicate remains enforced. Transient
serialization/deadlock retries occur inside the bounded whole-transaction retry
wrapper and do not persist one of these terminal reasons unless the final
contract check itself selects it. Upgrade and guarded-down tests prove every
code/status/response pairing and kill removal of the transition guard.
A "new authorized command" uses a new batch command/idempotency reservation; it
does not recycle, delete, or reopen the immutable failed job.
For these seven states, the public `error` field is null and
`w4_execution_reason_code` is the only exposed values-free reason. Plan values,
target IDs, SQL text, file paths, digests, and authorization details are never
copied into the mapper or logs.

## 7. Required discriminating evidence

### 7.1 Governing-SHA golden and two-database restart parity

Before changing the legacy worker, run the exact governing SHA
`1055e543a3680be9f37462de23483bf61ad4610c` against a fresh synthetic database
with a fixed clock and deterministic application UUID source. Commit the
sanitized canonical batch/item/record/group/response/cleanup fixture plus its
SHA-256 as the `legacy-import-v1` golden. The fixture contains no customer data
or secrets. The governing implementation leaves new record/group/member UUIDs
to PostgreSQL `gen_random_uuid()`, so the harness records those fresh IDs through
the closed natural-key bijection below rather than falsely claiming that an
application UUID stub controls database defaults.

The future implementation must reproduce that golden with the same clock/UUID
stream before restart parity is considered. A mutation that changes one golden
field or regenerates the fixture from the implementation under test must fail.
This closes the gap between "new same-process equals new restart" and "new
behavior still equals the pre-cutover legacy behavior."

The governing-SHA golden database is checked out and migrated at
`1055e543a3680be9f37462de23483bf61ad4610c`; it does not and cannot contain the
candidate manifest schema. Separately, use two fresh candidate databases
migrated through the implementation PR's exact head and seed them with the same
deterministic business state used by the golden:

- Candidate database A executes the prepared same-process plan through the new
  canonical adapter.
- Candidate database B commits enqueue, unloads/reloads the plugin module so
  process-local state is empty, changes current rule/settings/profile/group
  mapping, and executes only the persisted manifest/chunks.

The fixture includes:

- a new record;
- an existing record using non-default merge semantics;
- invalid and skipped rows;
- a skipped row whose mapped/fallback `resolvedUserId` differs from the raw row,
  plus a row with null resolved identity or date;
- duplicate ordinals folding to one W4 target;
- group auto-create and member assignment;
- profile/policy/multi-punch compatibility metadata;
- item truncation and skipped-sample response behavior;
- sync first execution/direct early replay/locked-race response data and wrappers,
  plus async first execution/early replay/locked-race compact summaries and
  public job projections;
- uploaded artifact cleanup intent.

The byte golden uses stable record/group preconditions and successful cleanup.
The explicitly ratified hardenings are separate discriminating fixtures, not
falsely normalized into legacy equality: concurrent same-name group creation,
record/group change after enqueue, and cleanup unlink failure must produce the
new fail/replan or retryable-cleanup posture specified in sections 4.4, 4.5, and
4.7. They do not weaken the normal-path byte golden.

After normalizing only database-generated timestamps explicitly excluded by the
existing response contract, and applying the `elapsedMs` comparison rule in
section 4.6, compare:

- import batch row and metadata;
- every import item and skipped snapshot;
- attendance record projection, source batch, and allowlisted metadata;
- attendance groups and members;
- the independently executed sync route response, and the async job's selected
  observation plus stored terminal compact summary;
- cleanup command and eventual cleanup state;
- zero unexpected W4 rows in `legacy_projection_only`.

Candidate databases A and B use the literal same pre-minted
job/batch/item/record/group/member IDs from one persisted plan; no ID
normalization is allowed between those two databases. Comparison with the
governing-SHA golden permits normalization only for a UUID freshly generated by
the governing implementation, through this exact bijection:

```text
job       -> (orgId, batchCommandId)
item      -> (batchId, sourceOrdinal)
record    -> (orgId, userId, workDate)
group     -> (orgId, normalizedName)
member    -> (orgId, normalizedGroupName, userId)
```

Pre-existing fixture IDs and the submitted batch command ID are never
normalized. Every mapped ID occurrence, including foreign keys, snapshots, and
response values, must map consistently and injectively; an unmapped, duplicate,
or relationship-breaking UUID fails the comparison. This is a bounded
cross-version accommodation for the governing DB defaults, not arbitrary ID
scrubbing, and it does not weaken literal same-plan restart identity.

### 7.2 Mutations that must fail independently

1. remove manifest insert while retaining job insert;
2. change one plan value without updating digest;
3. update digest but change job/batch/org/actor identity;
4. drop one skipped ordinal;
5. collapse duplicate ordinals to one item;
6. force `override` for a merge plan;
7. omit one compatibility metadata field;
8. remove one group ensure or member ensure;
9. reconstruct from current rule/settings/profile;
10. reconstruct from upload contents;
11. terminalize job outside the source-effect transaction;
12. run the old process-local closure after module reload;
13. replace manifest/chunk replay with target-only daily upserts;
14. accept a plan version other than `1`;
15. allow a CSV source's frozen legacy row limit plus one to write any job,
    manifest, or chunk row, or incorrectly apply that CSV limit to direct rows;
16. equate source row count/digest with the W4 item count/fingerprints when an
    invalid or duplicate source ordinal has no distinct W4 item;
17. commit an initial/queued V1 job after removing its manifest insert or
    changing one joined congruence value, or misuse the missing-history
    quarantine to make that incomplete INSERT legal;
18. commit an uploaded-source terminal response without the congruent pending
    cleanup command, hide completed response while cleanup is pending, or let a
    cleanup attempt/failure rewrite the stored business response;
19. treat source row 5001 as a W4 batch-limit failure when W4 item/target counts
    remain at or below 5000;
20. accept W4 item or distinct-target 5001 in authoritative posture;
21. omit, reorder, overlap, or duplicate one plan chunk while retaining its
    manifest entry;
22. change chunk boundaries and thereby change logical plan digest or a
    compatibility effect for otherwise congruent input;
23. replace a skipped item's resolved identity/date with its raw snapshot values;
24. route P06 through the private queue processor, return an async job from the
    sync API, collapse the three async execution observations, or select the
    wrong async observation;
25. count only physical group inserts or remove the conflict update;
26. remove one record-precondition field, change its canonical encoding, or
    acquire target/group locks in request order;
27. remove the job-held plan/legacy-input fingerprint or accept a manifest
    actor/source/token/posture mismatch;
28. let `down` proceed while any terminal V1 job remains;
29. map cleanup unlink failure to business failure or suppress the stored
    response;
30. admit an empty W4 vector without the all-skip proof, fabricate a synthetic
    W4 item, or count `sourceRowCount` as `w4DistinctTargetCount`.
31. keep the current job-specific `n < 1` proof-vector branch or positive-only
    job CHECK so either valid zero-W4 operational branch cannot commit, or
    wrongly relax the unchanged W4 operation-batch parser/table instead;
32. delete chunks, then manifest/terminal-response/cleanup rows, then a V1 job in one
    transaction, delete a terminal V1 job directly, or rewrite its terminal
    payload/counts;
33. replace the selected response variant after terminalization, reselect a
    completed job, or swap the early and in-transaction observations;
34. equate legacy `created_by` with delegated W4 `actor_id`, bind either to the
    other's job column, accept a private executor retry whose legacy requester
    differs, or reject an authorized full-import committed-batch
    replay solely because `createdBy` differs;
35. remove/bypass the record-target revision trigger, omit its frozen revision,
    or race an old unlocked record upsert against an `exists:false` plan in both
    commit orders;
36. remove a group/member revision trigger, build the plan without the revision
    share lock, or execute after changing one revision/fingerprint input;
37. let V1 enqueue start while an old unlocked import worker remains live;
38. claim both the governing-SHA golden and candidate parity databases contain
    the candidate manifest migration;
39. create a completed V1 job without exactly one congruent immutable terminal
    response or create a terminal response for any non-completed job.
40. decide retry congruence by rebuilding server-minted effect IDs/current
    preimages instead of the frozen branch-discriminated legacy-input
    fingerprint, or
    omit one covered request option from that fingerprint.
41. feed an above-limit operational batch through the strict W4 parser, persist
    a nonempty W4 proof/operation row for it, reject it in legacy/shadow, or
    admit it in authoritative posture.
42. mint a group/member effect ID at worker/restart time instead of persisting
    the server-minted ID in the accepted plan.
43. overwrite job/plan batch command identity with an idempotency winner's batch
    ID, expose `replayBatchId` as the async public job `batchId`, or make the
    synchronous idempotent serializer return its command ID instead of the
    locked existing batch ID.
44. create an upload cleanup command for `idempotent_early|precheck_hit`, omit it
    for an uploaded `first_execution|idempotent_in_transaction|locked_race`, or
    create one for a non-upload source.
45. execute only the legacy plan for a `strict_targeted` shadow/authoritative
    job, move the governing W4 source/result seal outside the legacy-effect/job
    transaction, or let an operational-only branch create W4
    operation/source/result rows.
46. force full-import early replay to open a deleted upload, let P06 scoped
    import replay before submitted-row canonical target authorization, create a
    V1 job for the synchronous direct early return, or allow either route to
    fall through from a changed locked legacy-batch precondition.
47. require a replay manifest to contain a source chunk/item, admit
    batch/item/record/group or W4 source/result DML in either replay selector,
    admit cleanup under `precheck_hit`, omit uploaded-source cleanup under
    `locked_race`, collapse the two selector response shapes, or allow a
    different W4 command identity to create the same legacy idempotency key
    without taking the shared idempotency lock.
48. persist or fingerprint an authorization credential, semantically parse a
    source before a full-import early replay, or omit one closed request input
    that changes all-new legacy behavior.
49. infer a V1 proof/plan from a null-version pre-cutover job, reject its
    governing congruent legacy retry solely because V1 fields are absent, or
    let a partial/unknown contract shape enter either worker.
50. treat a plan target or legacy batch as full-import authorization evidence,
    skip the canonical actor/full-import recheck, acquire any
    target/revision/business-row lock before plan verification, or perform any
    record/group/source/result DML before those gates.
51. lock an existing record/group/member revision before its business row,
    treat a missing-row plan as existing-row order, or let a `40P01` retry expose
    partial batch/item/record/group/terminal state.
52. use source ordinal as W4 semantic ordinal after a skipped row, leave a gap
    in the semantic rank, or reorder apply entries without changing either
    proof/fingerprint.
53. apply the sync source precedence on async input (or vice versa), open an
    ignored lower-priority source, or invent a non-null source kind for a
    no-source async `precheck_hit`.
54. persist a new plan failure reason with a non-`failed` status, INSERT a job
    directly in one of those failed states, retry the same failed job, attach a
    terminal response to it, permit `failed -> queued`, or let a non-missing
    reason bypass manifest/chunk completeness.
55. return the async helper result from the sync API, persist sync data as an
    async terminal summary, let P06 adopt a queued P07 job, omit either route
    from the golden, make the V1 mapper read/fall back to enqueue job payload,
    allow a same-org non-full caller to read a P07 job, or return a false
    negative to a currently authorized full-import admin.
56. reopen an uploaded source for a congruent P07 job retry, trust a changed or
    hidden locked legacy-batch replay precondition, infer scheduler-scoped async
    access from P06, or return/execute replay after current full-import
    authorization is lost.
57. derive any V1 batch/item/record/group/summary field from the legacy job
    `payload`, current request body, or process-local closure instead of the
    verified plan and result slots.
58. use an opaque JSON leaf to select authorization/branch/SQL structure, accept
    a prototype/limit violation, omit the leaf from plan digest/golden, or
    silently drop/truncate a verified legacy leaf on replay.
59. acquire one advisory key per target for an above-limit operational job,
    omit/change the org bulk sentinel, let two bulk jobs bypass it, begin DML
    before every real row/revision precondition is locked, or use the bulk
    sentinel to relax strict W4 target locks.
60. skip required commit-token validation/consumption on an all-new P06/P07
    command, consume a token before an allowed idempotent return, persist or
    fingerprint the token/result, or restore a consumed token after later
    plan/effect failure.
61. let a strict-targeted worker and an operational-bulk worker that share one
    real target both commit from the same frozen preimage, or rely on the bulk
    sentinel instead of the shared record/group revision protocol to serialize
    that cross-branch race.
62. let the private executor-identity mismatch mask an otherwise authorized
    full-import normalized idempotency replay of the same job, or weaken the
    executor comparison when no route-level replay applies.
63. truncate attendance records, groups, members, or either revision table while
    the amendment schema is installed, or remove one truncate guard without a
    failing migration/runtime leg.
64. let a suspended queued V1 job with a now-unauthorized actor enter terminal
    authorization rejection, or let the same job after non-suspended resume read
    plan/source state before the still-missing authorization fails.

Each mutation has a named positive control and fails only the intended leg where
practical. Multi-gate masking is tested by neutering neighboring guards.

### 7.3 CI and exact-head gate

The future implementation PR must include:

- fresh-schema, upgrade, and guarded-down migration tests for both manifest and
  chunks, terminal responses, cleanup commands, delete guards, zero-target shape,
  record/group revisions, their row triggers, and all five truncate guards;
- real PostgreSQL same-process/restart parity tests;
- two-user/two-org authorization and spoofing negatives, including two full
  admins sharing one committed batch/job as a positive, plus same-org non-full
  and cross-org negatives across enqueue, list, get, retry, completed terminal
  projection, and worker recovery;
- concurrent congruent enqueue and conflicting enqueue tests;
- full-import early-idempotency replay after upload cleanup, P06 scoped
  authorization-before-direct-replay, P07 no-source reopen on existing-job
  retry, and cross-command same-idempotency serialization;
- P06/P07 commit-token ordering controls: an allowed idempotent return does not
  consume, an all-new command cannot reach source/job/effect DML without the
  governing required-token consumption, and no durable plan field contains the
  token or result;
- a full-import second-admin positive in which one row matches both normalized
  idempotency and private executor identities, proving route replay wins without
  weakening private executor checks;
- independently executed sync first/early/locked-race and persisted async
  first/early/locked-race golden payloads, with exact wrapper/data/summary key
  sets and a mutation that incorrectly routes P06 through P07/P08;
- both route-specific multi-source precedence rules and no-source async replay
  tests;
- source-ordinal/semantic-ordinal discrimination with a leading skipped row;
- concurrent worker/recovery tests, absent-record commit-order races, and
  group-revision races, including retained-writer opposite-order `40P01`
  retry/zero-effect controls, plus strict-targeted versus operational-bulk
  same-target races in both commit orders;
- CSV-limit plus-one and direct-row same-cardinality discrimination;
- existing async `integer` count-envelope overflow rejection before any
  job/plan/source DML, without applying the CSV limit to non-CSV transports;
- all new reason-code/status/transition/terminal-response combinations on fresh,
  upgrade, and guarded-down schemas;
- suspended-plus-authorization-loss and resumed-plus-authorization-loss
  discrimination: the first remains queued with only the suspended reason and
  job lock, while the second fails before manifest/source DML;
- all-invalid/skipped zero-W4 branch positive/negative controls at both
  TypeScript and DB constraints;
- exact-5000 and item/target-5001 three-posture controls proving the
  above-limit operational branch has no W4 proof/operation/source/result rows,
  takes exactly one org bulk sentinel rather than an unbounded target advisory
  vector, and still locks/rechecks every real target before DML;
- all three async response-selector observations plus completed-job stored-response
  replay;
- the complete mutation ledger above;
- required CI run-list wiring with a guard that proves the real tests execute;
- an exact-head independent review with zero P1/P2 findings.

Green unit tests, one final daily row, or "no current rule reread" alone do not
satisfy this amendment.

## 8. Relationship to the frozen implementation inventory

The unmerged W4C-3a worktree may be reused only after this amendment is
RATIFIED. Reuse is selective:

- core authorization, identity, lock-order, rollback, and 5000-boundary work
  must be re-reviewed against the new exact head;
- the target-only durable fallback is rejected and must not be carried forward;
- process-local plan handoff may remain only as a same-process optimization if
  the manifest/chunk path is the authoritative behavior and parity tests prove both
  paths identical;
- no test or comment may call a target-only upsert byte-compatible.

## 9. Ratification and implementation sequence

1. merge this document as `PROPOSED`;
2. independently verify the merged document against the exact main tree;
3. owner RATIFY the exact merged SHA and choose `OD-W4C-56=(a|b)`;
4. only if `(a)` is RATIFIED, restore a fresh W4C-3a implementation branch from
   then-current main and selectively port valid frozen inventory;
5. implement schema/parser/enqueue first, then worker replay, then caller
   cutover and parity tests;
6. open a Draft implementation PR;
7. run exact-head independent review and repair until zero P1/P2;
8. stop at the owner merge decision.

None of these steps authorizes W4C-3b, W4C-5 soak, flag changes, deployment,
production/customer data, or issue closure.
