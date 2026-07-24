# Attendance Issue #4556 W4 Segment Calculation and Immutable Snapshot Design Lock

> Status: **PROPOSED**
>
> Pinned baseline: `origin/main@e0defbe26d7f2e1747e74aa908ca710422812bf7`
>
> Date: 2026-07-24
>
> Scope: issue #4556, W4 only
>
> Authorization: this document authorizes **no runtime code, migration, flag
> change, deployment, rollout, or issue closure** before the owner RATIFYs the
> exact merged document SHA.

## 0. Purpose and authority

Issue #4556 requires a multi-period shift such as `08:00-12:00` and
`13:00-17:00` to calculate 480 worked minutes, not the 540-minute outer
envelope. W1-W3 delivered effective membership, shared work-date attribution,
segment schema, canonical shift authoring, and a preview editor. They did not
change authoritative attendance calculation.

W4 delivers the accounting layer:

1. deterministic per-segment matching and aggregation;
2. immutable calculation and segment snapshots;
3. one canonical writer for every current result-producing entrypoint;
4. append-only reversal for imports, approvals, and operator retirement;
5. org-scoped shadow, promotion, suspension, and explanation surfaces.

Once RATIFIED on its exact merged SHA, this document becomes the authoritative
W4 amendment to
`docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md`.
It governs W4 only. W5 flex, W6 read aggregation, W7 group-policy cutover, W8
closeout, production enablement, and customer UAT remain separately gated.

Every `OD-W4C-*` row in section 13 is OPEN. A merged PROPOSED document is not
implementation authorization.

## 1. Verified current-state spine

All evidence below was checked against the pinned baseline. Stable symbols are
listed so a rebase must re-find the code instead of carrying stale line numbers.

| Area | Current fact | Evidence |
| --- | --- | --- |
| Daily projection | `attendance_records` is one mutable daily result with first/last timestamps, minutes, status, and meta. | `packages/core-backend/src/db/migrations/zzzz20260114090000_create_attendance_tables.ts` |
| Daily statuses | Runtime storage accepts `normal`, `late`, `early_leave`, `late_early`, `partial`, `absent`, `adjusted`, `off`. | `zzzz20260114120000_add_attendance_scheduling_tables.ts` |
| W3 segments | One to three dense ordered segments are persisted through the canonical shift service. | `zzzz20260724120000_create_attendance_shift_segments.ts`; `attendance-shift-service.cjs` |
| W3 runtime hold | `SEGMENT_CALCULATION_IMPLEMENTED=false`; the org allowlist cannot activate calculation. | `attendance-shift-service.cjs:54,245-254` |
| W2 resolver | Six entrypoints return `resolved`, `ambiguous`, or `unresolved`; resolved `shiftId` is required and W2 `segmentIndex` is null. | `attendance-work-date-resolver.cjs:1-61`; `attendance-work-date-adapters.cjs` |
| Context selection | Runtime precedence remains rotation, direct assignment, default rule, then holiday/calendar handling. | `resolveWorkContext` at `index.cjs:14581`; `resolveWorkContextFromPrefetch` at `:17278` |
| Legacy metrics | `computeMetrics` uses elapsed first-in to last-out and daily status logic. | `index.cjs:11321-11372` |
| DST hazard | `buildZonedDate` catches conversion failure and falls back to a UTC-constructed instant. | `index.cjs:6574-6591` |
| Common writer | `upsertAttendanceRecord` and `computeAttendanceRecordUpsertValues` are common, but not exclusive. | `index.cjs:19361-19561` |
| Bulk writers | `values`, `unnest`, and staging `INSERT ... SELECT` independently write the projection. | `batchUpsertAttendanceRecordsValues`, `batchUpsertAttendanceRecordsUnnest`, `batchUpsertAttendanceRecordsStaging` |
| Scheduled side door | `generateAbsenceRecords` directly inserts `attendance_records`; both the cron and the admin route call it. | `index.cjs:21101-21120`; `runAutoAbsenceForOrgDate` |
| Import rollback | The rollback route directly deletes rows carrying `source_batch_id`. | `index.cjs:37971-37980` |
| Approval paths | Correction, leave, overtime, and outdoor punch can all create or update the daily row; outdoor also inserts its punch event, while correction/leave/overtime also append an adjustment event. | `applyAttendanceResultEdit`; terminal branches in `resolveRequest` |
| Outdoor first record | Request creation freezes event fields, but final approval can re-read current context and create the first row without W2 frozen attribution. | live/outdoor request and approval branches in `index.cjs` |
| Merge second pass | `applyAttendanceInOutMergePolicy` can mutate first/last after the first upsert. | `index.cjs:19279`; live/outdoor callers |
| Approval cancellation | Leave cancellation reverses its balance ledger but does not append a new attendance calculation. | cancellation branch near `index.cjs:31325-31420` |
| Central approval side doors | Legacy approve/reject and generic action routes can currently terminalize a platform-source attendance approval instance without running attendance effects; the plugin has no reconciliation subscription. | `packages/core-backend/src/routes/approvals.ts`; `ApprovalBridgeService.dispatchAction`; `resolveRequest` |
| Schedule-fact approvals | Terminal `shift_swap` and `schedule_dispatch` do not write a daily result, but do mutate shift assignments/group membership that future calculations consume. | `finalizeShiftSwapRequest`; `finalizeScheduleDispatchRequest` |
| Decision authorization | Attendance decision/cancel handlers load the request by bare ID; the global attendance permission bypass is not itself org-scoped, while scheduler-scope authorization is. | `resolveRequest`; `cancelRequest`; `assertAttendanceRequestApprovalAllowed` |
| Legacy import | `POST /api/attendance/import` has a private mapping/calculation/write loop. | route near `index.cjs:36337-36445` |
| Integration sync | `/api/attendance/integrations/:id/sync` repeats import calculation in another loop. | route near `index.cjs:37135-37620` |
| Integration semantic drift | Integration sync omits rule-engine/group-sync work performed by the modern commit path; even `dryRun` writes a run and updates `last_sync_at`. | integration sync loop and final run/watermark update |
| Rollback authorization drift | Import rollback has org scoping and `attendance:import|admin`, but lacks the commit path's finer delegated scope/group check. | rollback route versus `assertAttendanceImportCommitAllowed` |
| Explanation precedent | Wave 5 decision trace has separate admin/self hosts, active-org checks, token-subject self reads, and authorization before SQL. | `packages/core-backend/src/routes/attendance-admin.ts:1248-1471` |
| Identity lifecycle | A usable subject now requires activated/active user state plus active org membership; directory deprovision may revoke `user_orgs` under its separately gated policy. | `user-activation.ts`; `directory-sync.ts` admission/deprovision helpers |
| OpenAPI gap | `AttendanceRecord` has only the daily projection; no immutable segment calculation detail exists. | `packages/openapi/src/base.yml:431-470` |
| Cleanup bypass | Generated cleanup SQL and staging helpers include direct record/event DML. | `scripts/attendance/generate-cleanup-sql.cjs`; `scripts/ops/staging-attendance-*.mjs` |
| XLSX | The browser converts the first non-empty supported sheet to CSV and enters the existing CSV pipeline. | `AttendanceView.vue`; `importXlsxConvert.ts` |
| Ordinary reader side doors | Anomaly listing, makeup-anomaly fact derivation, open-record work-date resolution, and Wave 5 DecisionTrace read `attendance_records` outside the headline record/summary/export surfaces. | `handleAttendanceAnomaliesGet`; `deriveMakeupAnomalyFacts`; `loadOpenRecordsForWorkDateResolver`; `AttendanceDecisionTrace.ts` |
| Additional time fallbacks | Besides `buildZonedDate`, zoned-parts/work-date/minutes helpers silently fall back to UTC, while `parseDateInput` can interpret offset-less values in server-local time; default-rule timezone writes are not uniformly IANA-validated. | `getZonedParts`; `toWorkDate`; `getZonedMinutes`; `parseDateInput`; default-rule update route |

### 1.1 Current execution-path inventory is a completion artifact

The exact-head W4 implementation must regenerate this inventory and map every
initiator to its first source/effect/result DML. A shared helper is not a
substitute for naming each execution body. In particular, a route, queue
worker, startup recovery, cron callback, and administrator-triggered run are
separate debt entries even when they later call the same function.

| Debt ID | Current initiator and first effect | W4 owner and disposition |
| --- | --- | --- |
| P01 | Live `POST /api/attendance/punch`: event insert, then `upsertAttendanceRecord`. | W4C-2: persist event and canonical result under one transaction contract. |
| P02 | `applyAttendanceInOutMergePolicy`: second-pass record mutation after the first upsert, used by live/outdoor flows. | W4C-2: consume the prepared projection inside the same canonical transaction; no post-write recomputation. |
| P03 | Scheduled cron callback: `runAutoAbsenceForOrgDate` -> `generateAbsenceRecords` direct record insert. | W4C-2: remove direct insert and use frozen scheduled evidence. |
| P04 | Administrator `POST /api/attendance/auto-absence/run`: the same direct absence writer through a separate initiator. | W4C-2: prove the same canonical boundary and authorization/call order independently. |
| P05 | `POST /api/attendance/anomaly-result-edits`: upsert followed by `attachManualResultEditMarkerToRecord` UPDATE. | W4C-3c: freeze the override in prepared evidence and remove the post-write patch. |
| P06 | Modern synchronous `/import/commit`: `values`, `unnest`, or staging `INSERT ... SELECT` bulk upsert. | W4C-3a: transports only; all persist identical canonical prepared plans. |
| P07 | Async import queue worker `processAsyncImportCommitJob` -> `commitAttendanceImportPayload`. | W4C-3a: durable operation/item identity and the same atomic import/reversal contract. |
| P08 | Async import startup recovery that re-enqueues P07 after restart. | W4C-3a: restart replay is an explicit execution-path gate, not inferred from the HTTP route. |
| P09 | Legacy `POST /api/attendance/import`: private per-row mapping/calculation/upsert loop. | W4C-3a: normalize and use canonical prepare/apply. |
| P10 | `/api/attendance/integrations/:id/sync`: separate per-row calculation/upsert loop. | W4C-3a: normalize and use the same import kernel. |
| P11 | `/import/rollback/:id`: hard delete of records carrying `source_batch_id`. | W4C-3a: remove delete and append same-record reversals. |
| P12 | Approval request creation/edit: pending edit overwrites mutable `form_snapshot` without an `attendance_requests.version`; no complete immutable calculation snapshot exists today. | W4C-3b: append and bind immutable request snapshots before terminal processing. |
| P13 | Attendance plugin terminal handling: correction/leave/overtime and outdoor can all upsert the row; outdoor inserts the punch event, and correction/leave/overtime also insert adjustment events. | W4C-3b: freeze closed facts and route every source/effect/result write through one transaction; fresh-row creation is not a bypass. |
| P14 | Approved-request cancellation: balance/leave-ledger reversal only; it does **not** reverse an attendance result today. | W4C-3b: add an atomic calculation or explicit review/no-parent outcome; this is new capability, not a migration of an existing result reversal. |
| P15 | `scripts/attendance/generate-cleanup-sql.cjs`: privileged generated record/event deletes. | W4C-3c: canonical retirement for W4-backed rows; no privileged destructive shortcut. |
| P16 | Test-user cleanup and staging helpers: dynamic/direct synthetic deletes and inserts. | W4C-3c/W4C-5: classify tooling separately, retire W4-backed data canonically, and prove named-org residue cleanup. |
| P17 | Central legacy approve/reject, generic action/bridge, and any card action capable of reaching an attendance instance can terminalize shared approval state outside the plugin body. | W4C-3b: identify attendance instances before terminal DML and either dispatch the canonical attendance command in the same transaction or fail closed; no split-brain terminal state. |
| P18 | Terminal `shift_swap` and `schedule_dispatch` write schedule assignments/group membership outside the result transaction. | W4C-3b: classify them as schedule-fact writers and make their version/hash/lock participate in W4 context consistency before enabling authority. |
| P19 | Decision and cancellation request lookup plus global permission bypass do not define an explicit org-bound authorization contract. | W4C-3b: lock request org first, derive org from the locked row, then apply the closed platform-admin versus org-member authorization matrix before shared/result DML. |
| P20 | Anomaly, makeup-anomaly facts, open-record attribution, and DecisionTrace are direct ordinary readers absent from the named current-view list. | W4C-3c: move every one to the canonical active-current helper and give each an independent retired-row negative leg. |
| P21 | Time conversion has multiple silent UTC/server-local fallback helpers and a default-rule timezone write path without uniform IANA validation. | W4C-1/W4C-2: strict-parse every candidate for W4 authority and freeze the accepted zone/offset/instant; `legacy_projection_only` preserves current parsing, while `shadow` preserves the legacy result but records a non-promotable review for legacy-only time input. No helper-specific fallback may become W4 evidence. |
| P22 | Current request terminalization has three reachable execution bodies and no attendance reconciliation listener; later plugin approval may still apply effects after another body already made the instance terminal. | W4C-3b: one terminal attendance transition with expected version/status, canonical replay, and explicit rejection of a second execution body. |
| P23 | `/import/rollback/:id` accepts a broader authorization posture than import commit and can roll back another actor's org-local batch. | W4C-3a: bind rollback to the frozen batch owner/scope and re-run the commit-equivalent delegated authorization before claim/source DML. |
| P24 | Integration sync has a distinct semantic pipeline, and `dryRun` still writes the run plus `last_sync_at`. | W4C-3a: freeze current compatibility semantics explicitly, use one W4 calculator, and make dry-run append audit-only state without result/batch/watermark mutation. |
| P25 | Import token, preview/job, template-preference, upload-lifecycle, and temporary-staging writes are operational DML with different correctness contracts. | W4C-0: classify each explicitly; only business source/effect/result state enters the atomic result operation, while operational state gets its own allowlist and no authority over calculation truth. |
| P26 | Central approval assignment mutation is not one route. `POST /api/approvals/admin/reassign` selects pending `source_system='platform'` instances without an attendance discriminator, deactivates/creates `approval_assignments`, and increments `approval_instances.version`; its target check is global-active only. Existing generic `approve` node advancement, `return`, and `revoke` also create or deactivate assignments, while jump, transfer, add/reduce-sign, timeout, and future actions may reach the same state. Route selection by `published_definition_id` is not an attendance exclusion proof. These paths can therefore change who may decide an attendance request outside the locked request-org authority contract. | W4C-3b: derive the completion inventory from the actual generic action union and assignment-DML call graph; classify attendance instances before every assignment DML, lock their request org and instance version, apply the closed actor/target membership matrix, and serialize mutation against terminal decision. Every named generic action either proves attendance unreachable for both normal attendance rows and an adversarial attendance row carrying `published_definition_id`, or enters the same contract before instance/assignment DML. |

There is no general production recompute writer today. W4C-3c introduces
prior-policy/default recompute and explicitly labeled current-policy recompute;
it must not describe either as a migrated existing path. Manual result editing
is an override projection path, not that recompute capability.

XLSX is not another backend writer. Equivalent normalized CSV must produce the
same semantic input while XLSX/CSV origin remains separate provenance.

## 2. Scope and explicit non-goals

### 2.1 W4 delivers

- strict per-segment boundary construction and event matching;
- immutable calculation and per-segment rows;
- an atomic mutable compatibility projection and current pointer;
- canonical coverage of all writers in section 1.1;
- append-only reversal/retirement;
- shadow comparison and dual-host read-only explanation;
- named synthetic staging rollout only.

### 2.2 W4 reuses without redefining

- W2 `resolved|ambiguous|unresolved` semantics and OD-4556-6/7/8;
- current rotation/direct/default-rule context precedence;
- W3 segment limits, ordering, envelope compatibility, and flag-OFF guards;
- existing approval assignment semantics and leave/overtime financial
  contracts; approval authorization is tightened by W4C-R30 and is not
  inherited as a sufficient org-bound check;
- current `internalWinsOnIn` and `externalWinsOnOut` meanings.

### 2.3 OUT

- W5 flexible-time policy;
- W6/W7 calculation-group winner selection or policy precedence;
- production enablement, deploy, production migration execution, and UAT;
- a new universal attendance-group save endpoint;
- native device integrations;
- automatic historical restatement.
- new post-approval cancellation eligibility for request kinds that are not
  cancellable today.

W4 stores `calculationGroupId=null` and `contextSelector='legacy'`. A W4 query
against W1 group-membership tables is a scope violation.

## 3. Non-negotiable red lines

| ID | Rule | Required negative proof |
| --- | --- | --- |
| W4C-R1 | No first-in/last-out arithmetic for active multi-segment shifts. | Reintroducing outer-envelope arithmetic fails the split-shift real-DB case. |
| W4C-R2 | Duplicates and ambiguity never collapse to earliest/latest. | Choose-first, choose-last, and ignore-extra mutations fail. |
| W4C-R3 | DST conversion never falls back to UTC. | The current fallback mutation fails gap/fold tests. |
| W4C-R4 | Request snapshots, calculation, and segment history are append-only. | UPDATE, DELETE, TRUNCATE, cascade, and rollback-delete mutations fail. |
| W4C-R5 | Immutable rows, daily projection, and pointer change atomically. | Moving pointer/projection after commit fails injected-failure tests. |
| W4C-R6 | Every attendance source/effect/result writer uses one canonical boundary. | A generated call-path plus DML inventory catches every direct side door and positive control. |
| W4C-R7 | W4 does not consume calculation-group membership. | Static and behavioral mutations reading W1 membership fail. |
| W4C-R8 | Detail authorization and org/subject predicates precede result SQL. | Same-org other-user and cross-org spoof tests leak zero rows. |
| W4C-R9 | Shadow, reversal, and suspension never rewrite history. | Historical counts and hashes remain stable across transitions. |
| W4C-R10 | PROPOSED authorizes no runtime work. | Exact merged-SHA owner RATIFY predates the first runtime base commit. |
| W4C-R11 | Supersedes/restores lineage never crosses record or org. | Cross-record and cross-org composite-FK mutations fail at commit. |
| W4C-R12 | One result cannot mix mutable context revisions. | Concurrent assignment/segment edits block, retry, or fail fingerprint recheck. |
| W4C-R13 | Operation replay is congruent, not key-only. | Same key with changed subject/source/payload/provenance or changed/reordered batch item sequence fails 409. |
| W4C-R14 | A result write requires an immutable runtime-authenticated host witness. | Forged/cloned/post-mint-mutated witness and org/user/capability mutations fail before SQL. |
| W4C-R15 | Retired parents are invisible to every ordinary consumer. | Removing any canonical current-view predicate fails surface tests. |
| W4C-R16 | Fresh authoritative review never exposes a default daily row. | Removing review-placeholder retirement makes ordinary-read tests fail. |
| W4C-R17 | Suspension distinguishes completed replay from new work before source DML. | Moving suspension ahead of replay classification or admitting incomplete replay fails. |
| W4C-R18 | Authority never strands mutable pre-W4 request state. | Promotion with missing, unsupported, payload-stale, or reversal-incomplete request snapshots fails. |
| W4C-R19 | Operation claim and suspension preflight precede the first attendance source/effect DML. | Moving any route's first source write ahead of preflight fails. |
| W4C-R20 | Actual segment intervals never overlap or double-count one physical minute. | Removing the cross-segment actual-interval invariant fails the overlap fixture. |
| W4C-R21 | One attendance workflow uses one PostgreSQL transaction for source, shared effects, result, and operation seal. | A split transaction or nested commit fails injected-effect rollback and `txid_current()` equality tests. |
| W4C-R22 | Completed operation/batch history is durable retry evidence. | Completed-row UPDATE/DELETE/TRUNCATE/cascade mutations fail at the DB boundary. |
| W4C-R23 | The W4C-0 DML debt baseline is pinned before W4 runtime code. | Adding, renaming, or reclassifying a bypass in W4C-0 without removing a pinned debt ID fails CI. |
| W4C-R24 | Payable minutes are the intersection of actual and planned segment intervals, extended only by bounded frozen overtime. | Restoring raw actual-span arithmetic counts a planned break and fails. |
| W4C-R25 | Imported explicit metrics/policy results are never dropped or silently made authoritative. | Removing snapshot presence or congruence checks fails a metric-conflict fixture. |
| W4C-R26 | W4 atomic batches stay within one closed, tested bound. | 5001 items/targets fail before source DML; chunking or partial commit mutations fail. |
| W4C-R27 | A completed non-legacy W4 operation cannot lose its required lifecycle event between DB commit and process emit. | Removing the transactional outbox from a `shadow|eligible|authoritative` operation reproduces commit-before-emit loss; `legacy_projection_only` remains outside this invariant. |
| W4C-R28 | Frozen per-segment grace is derived only from the selected shift/rule profile until a new schema is ratified. | Segment-specific injection or current-policy reread fails fingerprint/context tests. |
| W4C-R29 | An attendance approval instance has one terminal execution body. | Legacy approve/reject, generic action/bridge, card action, and plugin decision mutations either converge before terminal DML or fail closed; a second body cannot apply or omit attendance effects. |
| W4C-R30 | Attendance approval and cancellation authorization is explicit at the locked request org. | Cross-org attendance-admin/delegated UUID probes fail before shared/result SQL; platform-admin override requires the closed global posture and an audit witness. |
| W4C-R31 | Schedule-fact writers cannot race or bypass frozen calculation context. | Moving shift-swap/schedule-dispatch/shift-assignment mutation outside the compatible lock/version protocol fails a concurrent calculation test. |
| W4C-R32 | Every ordinary daily-row reader uses the active-current contract. | Independent retired-row legs cover anomaly, makeup-anomaly facts, open-record attribution, DecisionTrace, and every pre-existing list/summary/report/export reader. |
| W4C-R33 | Every business time admitted as W4 evidence uses one strict timezone contract. | Invalid/missing zone, DST gap/fold, offset-less server-local parsing, and helper-level UTC fallback mutations cannot produce a completed W4 calculation: legacy remains byte-compatible, shadow records a non-promotable review while preserving the legacy result, and eligible/authoritative fail before source/result DML. |
| W4C-R34 | Pending request edits are versioned immutable transitions. | Reusing mutable `form_snapshot`, omitting the expected snapshot hash/version, or an A -> B -> A edit without three snapshots fails. |
| W4C-R35 | Import rollback cannot exceed the original batch's authorization scope. | Another importer, delegated scope, group, and cross-org probes fail before operation claim or reversal DML unless the closed owner/admin matrix authorizes them. |
| W4C-R36 | Integration dry-run cannot advance business state. | A dry-run may append its audit attempt but writes no attendance result/import batch/current pointer/`last_sync_at`; moving any forbidden write into that branch fails. |
| W4C-R37 | Operational import state never becomes calculation authority. | Token, preview/job, template-preference, upload cleanup, and temporary-stage mutations cannot satisfy operation identity, evidence, promotion, or rollback truth. |
| W4C-R38 | Attendance approval assignment authority is org-bound, action-complete, and version-serialized. | A generated matrix from the actual generic action union and assignment-DML call graph covers bulk reassign, non-terminal `approve` advancement, `return`, `revoke`, jump, transfer, add/reduce-sign, timeout, and future assignment mutations. Each action proves the attendance instance unreachable or locks its request org/version and satisfies the closed actor/target matrix before instance/assignment DML; tests include both a normal attendance instance and an adversarial one carrying `published_definition_id`, and a mutation-versus-decision race cannot authorize the wrong actor. |
| W4C-R39 | Closing a pre-W4 import rollback window is immutable, and rollback is serialized with closure, rollout transition, and writes to the same import batch. | Removing the append-only close witness, common rollout/operation-identity-advisory/operation-row/batch/target lock order, or final in-transaction eligibility recheck fails dual-connection races. For a legacy batch closed without preimage, close/transition first makes rollback return 409 with zero delete/reversal DML; rollback first makes transition wait and then re-evaluate. For source versus rollback on one batch, exactly one commits first and the waiter rechecks committed batch state before zero conflicting source/reversal DML. A batch with a valid frozen preimage retains its specified W4 reversal path. |
| W4C-R40 | Operation lifecycle follows rollout posture and supplied identity without an implicit retry hole. | A new legacy request with no supplied stable operation ID creates no operation/outbox row; legacy with a supplied ID claims/seals a compatibility operation but still creates no outbox; every new `shadow|eligible|authoritative` request requires, claims, and seals its operation plus required outbox. Independent mutations that create a legacy operation without an ID, omit the legacy-with-ID compatibility operation, or skip claim/seal outside legacy fail. |
| W4C-R41 | Rollout posture is frozen against every source transaction, including null-ID legacy work, through one fail-closed advisory-key helper, a rollout-only `00` bigint key class, and one rollout-first lock order. | A completed congruent replay may use an authorization-gated non-locking read and return with zero DML. Every request that continues acquires the org rollout shared transaction advisory lock through the single canonical helper before locking operation/source rows and holds it through commit; transition/closure use that helper's matching exclusive mode before their rows. Removing either lock, changing one caller's namespace/key or two-bit key class, swallowing acquisition failure, or restoring operation-row-first locking fails an independent dual-connection leg. |
| W4C-R42 | Concurrent first claim of one batch or operation identity serializes before any unique-row insert through an operation-only `10` bigint key class; target locks use disjoint class `11`, and `01` is forbidden. | When the first holder commits within the closed lock budget, two connections presenting the same all-new identity both complete with the one stored response and exactly one source/result effect. When it exceeds that budget, the waiter returns values-free `409 ATTENDANCE_OPERATION_IN_PROGRESS` with zero DML and a later retry returns the stored response. Neither case exposes raw `23505` or `55P03`. Removing the canonical identity advisory lock, changing one caller's key derivation, crossing a rollout/operation/target class, sorting by tuple instead of final signed key, or acquiring identity/target locks in a different final-key order fails independently. |

## 4. Canonical intent, prepared plan, and evidence

### 4.1 Untrusted intent versus trusted prepared plan

Routes submit an `AttendanceSourceOperationEnvelopeV1` to the canonical
operation boundary. The envelope contains either one command or an atomically
ordered batch of entrypoint-specific `AttendanceSourceCommandV1` items. Each
item has its own stable operation identity; a batch also has its durable batch
identity and requires all-or-nothing response replay. The command
discriminated union is closed over the entrypoints below and contains only
untrusted command values; it never contains a prepared plan, rollout posture,
authorization witness, persisted-event ID, approval-record ID, or trusted
snapshot. After suspension/authorization/idempotency preflight for every item,
a private entrypoint adapter persists or locks the source rows and mints the
normalized internal intent shown below. Routes and callers cannot submit JSON
and label it frozen:

```ts
interface AuthorizedAttendanceWriteContextV1 {
  readonly __attendanceWriteContextBrand: unique symbol
  readonly actorId: string
  readonly actorPosture:
    | 'self'
    | 'platform_admin'
    | 'attendance_admin'
    | 'delegated_import'
    | 'scheduler'
    | 'approval_system'
    | 'operator'
  readonly tokenSubjectUserId: string | null
  readonly orgId: string
  readonly subjectScope:
    | { readonly kind: 'self'; readonly userId: string }
    | { readonly kind: 'explicit_users'; readonly userIds: readonly string[] }
    | { readonly kind: 'org_scheduler' }
  readonly capability:
    | 'punch'
    | 'import'
    | 'scheduled'
    | 'approval_apply'
    | 'manual_edit'
    | 'recompute'
    | 'rollback'
    | 'retirement'
  readonly sourceRef: string
}

interface AttendanceCalculationIntentV1 {
  schemaVersion: 1
  orgId: string
  userId: string
  requestedWorkDate: string | null
  entrypoint:
    | 'live'
    | 'legacy_import'
    | 'integration_sync'
    | 'correction'
    | 'approved_leave'
    | 'approved_overtime'
    | 'outdoor_approval'
    | 'manual_override'
    | 'recompute'
    | 'scheduled'
    | 'approval_reversal'
    | 'import_rollback'
    | 'ops_retirement'
  attributionSource: 'resolve_now' | 'request_snapshot' | 'prior_calculation'
  attributionRef: string | null
  contextSource: 'resolved_attribution' | 'request_snapshot' | 'prior_calculation'
  contextRef: string | null
  evidenceInputs: AttendanceEvidenceInputV1[]
  approvedFactRefs: ApprovedAttendanceFactRefV1[]
  manualOverrideRef: string | null
  mergePolicy: 'append' | 'merge' | 'override' | 'reversal' | 'retire'
  provenanceRef: AttendanceInputProvenanceRefV1
  sourceBatchId: string | null
  operationId: string | null
  correlationId: string
}

type AttendanceEvidenceInputV1 =
  | { kind: 'persisted_event_ref'; eventId: string }
  | {
      kind: 'import_boundary'
      importItemId: string
      direction: 'check_in' | 'check_out'
      occurredAt: string
    }
  | {
      kind: 'import_metric_snapshot_ref'
      operationItemId: string
      snapshotVersion: 1
    }
  | { kind: 'scheduled_absence_ref'; scheduledRunId: string }
  | { kind: 'approved_request_ref'; requestId: string }

interface ApprovedAttendanceFactRefV1 {
  requestId: string
  expectedKind:
    | 'leave'
    | 'overtime'
    | 'correction'
    | 'outdoor_punch'
    | 'reversal'
}
```

An import metric snapshot is a closed immutable server snapshot, not a trusted
adapter object. It records:

- the exact presence/value of imported `status`, `workMinutes`,
  `lateMinutes`, `earlyLeaveMinutes`, `leaveMinutes`, and `overtimeMinutes`;
- the legacy holiday/rule-set/rule-engine output that would have produced the
  compatibility projection, including the closed engine/rule versions and
  source fingerprint; and
- which fields were absent, so absence cannot become an implicit zero.

The segment calculator remains the sole authoritative source of physical
minutes and status. A W4 import can become authoritative only when every
explicit imported metric and the frozen legacy policy result are congruent
with the canonical segment result. Any mismatch is
`review_required/import_metric_conflict`, preserves the imported compatibility
projection in shadow, and blocks promotion. It is forbidden to discard the
explicit values, silently recalculate them, or let them override segment
evidence. An import with metrics but insufficient boundary evidence is likewise
review-required.

The public source-command union is not an open callback or `unknown` payload.
W4C-0 defines strict schemas with unknown-key rejection and this exact variant
matrix:

| Command kind | Stable identity before source DML | Closed normalized payload |
| --- | --- | --- |
| `live_punch` | client UUID | event type, occurred-at, timezone, source, normalized location/meta, owned photo-file ref |
| `request_create` | client UUID | exact normalized request-write allowlist plus request type; no caller/source UUID |
| `request_pending_edit` | client UUID | request ID, expected snapshot version/hash, exact normalized patch allowlist |
| `request_decision` | web UUID or verified delivery-ledger UUID | request/approval ID, expected approval version/node, `approve|reject`, normalized comment/meta |
| `request_cancel` | client UUID | request/approval ID, expected request snapshot/version, normalized cancellation reason/meta |
| `import_batch` | canonical batch UUID plus UUIDv5 item IDs | transport kind, batch fingerprint, ordered exact normalized items |
| `integration_batch` | canonical sync-run UUID plus UUIDv5 item IDs | integration/run identity, source fingerprint, ordered exact normalized items |
| `scheduled` | UUIDv5 run/user/work-date ID | expected run version and scheduled-absence source |
| `manual_edit` | client UUID | record ID, expected current calculation/version, closed set/unset operations, reason/evidence |
| `recompute` | client UUID | record ID, expected current calculation/version, `frozen_prior|current_policy` |
| `import_rollback` | client UUID | batch ID, expected batch state/fingerprint |
| `ops_retirement` | operator command UUID | record ID, expected current calculation/version, reason/ticket |

Every value entering the `operationId` or `batchCommandId` position is one
canonical UUID string. The parser accepts exactly the RFC 4122
`8-4-4-4-12` hexadecimal form, rejects leading/trailing whitespace, braces,
URN prefixes, non-ASCII lookalikes, NUL, and every non-string value, validates
the UUID variant/version where the source contract fixes one, and emits
lowercase ASCII. The emitted 36 bytes are the only identity bytes stored,
fingerprinted, compared, or passed to the advisory-key builder. Callers cannot
pass a pre-normalized-looking `string` around this parser.

`orgId` uses a separate `CanonicalAttendanceOrgKeyV1` parser. It emits a
canonical lowercase UUID for every W4-enabled posture. It may emit the exact
ASCII sentinel `default` only for an existing `legacy_projection_only`
compatibility command, because historical attendance rows used that sentinel;
no whitespace/case alias is accepted, and `shadow|eligible|authoritative`
reject it before source DML. All three advisory builders/helpers consume only
this branded parser output, so strict W4 tenancy and byte-compatible legacy
operation locking do not conflict.

`CanonicalAttendanceUserIdV1` is the same strict lowercase UUID form.
`CanonicalAttendanceWorkDateV1` is a calendar-valid ASCII `YYYY-MM-DD` with no
whitespace or alternate Unicode digits. They are branded parser outputs; raw
route/body strings cannot be cast into target-lock identity.

Derived identities use UUIDv5 over the exact UTF-8 bytes below and then pass
through the same parser. W4C-0 exports the three literal namespace UUIDs as its
only identity-derivation source:

```text
ATTENDANCE_IMPORT_ITEM_NAMESPACE_V1 =
  6f67fdaa-e2aa-48b3-b76c-c4aab9723173
ATTENDANCE_INTEGRATION_ITEM_NAMESPACE_V1 =
  46501375-c273-459f-a5af-f926859f6411
ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1 =
  e4363171-f53f-47d7-a074-607ef3fad391

import item name =
  canonicalBatchUuid + NUL + canonicalUnsignedOrdinal + NUL +
  lowercaseSha256SemanticFingerprint
integration item name =
  canonicalSyncRunUuid + NUL + canonicalUnsignedOrdinal + NUL +
  lowercaseSha256SemanticFingerprint
scheduled name =
  canonicalRunUuid + NUL + canonicalUserUuid + NUL + canonicalYYYYMMDD
```

The unsigned ordinal is base-10 ASCII with no sign or leading zero except
`0`; the semantic fingerprint is exactly 64 lowercase hexadecimal bytes; the
date is exactly `YYYY-MM-DD` and calendar-valid. Existing import batch IDs and
directory sync-run IDs are UUIDs and become the corresponding canonical batch
command IDs. A verified DingTalk/card decision uses the canonical UUID
`dingtalk_approval_card_deliveries.id` (`outTrackId`) as its action operation
ID; provider prose, task ID, action label, operator ID, and callback payload
never become identity bytes. Its requested action remains in the command
fingerprint, so reusing one delivery ID for a different action conflicts.
ASCII uppercase hexadecimal UUID input canonicalizes to the same lowercase
UUID and key. Whitespace, Unicode lookalike/normalization, overlength, NUL,
malformed ordinal/date/fingerprint, and tuple-boundary mutations fail before
source DML.

Every variant also carries schema version, org, subject, correlation ID, and
its closed entrypoint/capability discriminants. External aliases such as
`occurred_at` or `request_type` are normalized once before fingerprinting; the
command contains only canonical names. The boundary strict-parses into
null-prototype objects, deep-copies and recursively freezes the normalized
envelope, and computes its command/item-sequence/item-set fingerprints before
any async adapter call. Private adapters never retain or read the caller-owned
object;
prototype replacement or mutation of the original after entry cannot alter the
claimed command. Request creation and pending edit add optional `operationId`
to their public schemas immediately in W4C-0 and require it whenever posture is
not `legacy_projection_only`. After a new request command is claimed, its
private adapter generates request/approval UUIDs and stores them in the
operation response. Replay returns those stored IDs before adapter execution;
randomly regenerated IDs are never part of the command fingerprint and never
substitute for the client command identity.

Business-time parsing has an explicit migration split. In
`legacy_projection_only`, the closed legacy branch preserves the current
parser and response/projection bytes and emits no W4 row. In effective
`shadow`, a value accepted only by the legacy parser, including an offset-less
timestamp that would use process-local time, still executes the prepared legacy
source/projection behavior; the W4 side freezes the raw value, the exact
legacy-resolved instant, and parser/environment provenance and appends only
`review_required/legacy_time_ingress_not_authoritative` with zero segments and
no current pointer. That review can never satisfy eligibility or promotion.
Effective `eligible` and `authoritative` reject the same input before any
source/effect/result DML. A successfully strict-parsed value follows the normal
shadow/authoritative path. This compatibility exception never permits a legacy
resolved instant, UTC fallback, or process timezone to become W4 calculation
evidence.

The authorization context is an in-process branded value, never request JSON.
The host factory normalizes and deep-copies every value, freezes the outer
object and nested arrays/objects, and registers it in a module-private
`WeakMap<object,canonicalDigest>`. Every use recomputes and constant-time
compares that digest before reading a field. The CJS plugin cannot satisfy the
runtime check by object-shape imitation, spread, JSON clone, prototype
replacement, or post-mint mutation of the original object.
Each adapter mints it only after its entrypoint-specific permission check and
the stricter closed W4 authorization contract for that entrypoint,
token-subject binding, `users.is_active=true`,
`COALESCE(users.activation_status,'activated')='activated'`, active
`user_orgs` membership/delegated scope, and source ownership check. In
particular, an existing global attendance permission is only an input to the
actor-posture decision; it never substitutes for the locked-request-org matrix
in W4C-R30. The
canonical writer rechecks the target org/subject, active user/activation state,
and necessary membership/source row inside its transaction. A directory
deprovision or activation change therefore invalidates a newly minted witness;
an operation row never caches the old access. Self writes reject any requested
user override; batch user IDs must belong to the closed explicit scope;
scheduler scope is available only to the registered internal scheduler
identity. A context whose capability does not match the entrypoint fails before
source/result DML.

The existing platform-admin override remains an explicit posture; it may waive
membership but never org/subject/source predicates or capability matching.

Intent values remain untrusted. Prepare loads persisted events, requests,
terminal approval records, manual edits, batches/items, and scheduled runs by
the authorized org/subject/source reference. Only normalized import boundaries
may carry raw business times, and they remain bound to an org-scoped import
item. Approved facts, manual snapshots, rollout posture, tier, and provenance
are minted by prepare, not supplied by an adapter.

In `legacy_projection_only`, `operationId` may remain null, preserving the
existing API. A null-ID legacy command creates no operation row. If a legacy
caller does supply a valid stable ID, the boundary claims and seals a
compatibility operation so response-loss retry remains idempotent across a
later rollout transition; that row still has no W4 result pointer or outbox.
In every W4 posture the ID and operation row are mandatory. `operationId` is
not caller prose. Stable identities are:

- client-generated UUID reused for a live punch, web approval decision,
  manual edit, recompute, rollback, or operator command;
- the verified delivery-ledger UUID for a DingTalk/card action;
- an existing canonical UUID batch/run command plus the namespace-derived
  UUIDv5 item identities above; and
- the namespace-derived scheduled-run/user/date UUIDv5 above.

An approval decision never uses `approval_records.id` as its operation ID:
that `BIGSERIAL` value does not exist until after the terminal insert. The
decision command identity is claimed before changing the approval instance;
the returned approval-record ID is then frozen as business evidence. A retry
reuses the original command identity. A deliberate replay/current-policy
recompute receives a new command ID. W4-enabled clients that cannot supply a
stable identity fail before source DML; no server-generated response-only ID
pretends to make response-loss retry safe. Merge policy is also checked against
a closed entrypoint/policy matrix rather than trusted because the adapter
supplied it.

Source/ref pairs are exact:

- `resolve_now` + `resolved_attribution`: both refs null;
- `request_snapshot`: both refs are the same org-scoped request ID;
- `prior_calculation`: both refs are the same-record/same-org calculation ID;
- mixed, unknown, cross-user, and cross-org pairs fail before result DML.

Prepare either runs W2 or loads and revalidates the frozen request/prior
snapshot through org-scoped queries.

```ts
interface FrozenWorkDateAttributionV2 {
  schemaVersion: 2
  resolverVersion: string
  orgId: string
  userId: string
  workDate: string
  shiftId: string
  reasonCode: string
  resolvedAt: string
  absoluteWindow: {
    startAt: string
    endAt: string
  }
  attributionWindow: {
    startAt: string
    endAt: string
  }
  attributionTailMinutes: number
  extendedByApprovedOvertime: boolean
  windowEvidenceFingerprint: string
  source:
    | 'live_resolution'
    | 'request_creation'
    | 'import_resolution'
    | 'scheduled_resolution'
}

type AttendanceAttributionSnapshotV1 =
  | { posture: 'resolved_v2'; value: FrozenWorkDateAttributionV2 }
  | {
      posture: 'unsupported'
      sourceSchemaVersion: 0 | 1 | null
      reason: 'legacy_v1' | 'missing' | 'ambiguous' | 'unresolved'
      sourceFingerprint: string | null
}
```

Both windows are absolute UTC instants produced by a W4 strict V2 builder from
the full W2 winner before the resolver narrows its public result. The current
W2 window is candidate evidence, not trusted output: V2 reconstructs every
local boundary without `buildZonedDate` and its UTC fallback, then requires the
candidate identity/window to agree or returns review-required. A gap/fold
decision is therefore made by section 5, never inherited from legacy fallback.
`windowEvidenceFingerprint` covers the closed tail policy plus the
IDs/versions and frozen anchors of approved overtime windows that extended
attribution. Segment planned boundaries must stay inside `absoluteWindow`;
direction-specific capture cells are clipped to `attributionWindow`.
Request/prior-calculation reads use these frozen windows even after assignment,
overtime, shift, or tail-policy changes.

Only `resolved_v2` can produce completed segments or a current projection. An
existing parent may append an unsupported review row with zero children. A
fresh unsupported action returns `W4_ATTRIBUTION_UNSUPPORTED` and does not
create an empty daily record.

```ts
interface FrozenAttendanceContextV1 {
  schemaVersion: 1
  selector: 'legacy'
  orgId: string
  userId: string
  workDate: string
  timezone: string
  shiftId: string
  isWorkday: boolean
  holidayKind: string | null
  calculationGroupId: null
  roundingMinutes: number
  severeLateThresholdMinutes: number
  absenceLateThresholdMinutes: number
  segments: Array<{
    index: 0 | 1 | 2
    startTime: string
    endTime: string
    startDayOffset: 0
    endDayOffset: 0 | 1
    lateGraceMinutes: number
    earlyLeaveGraceMinutes: number
  }>
}
```

W4 has no per-segment grace authoring source. The selected work-context
profile's shift/rule-level `lateGraceMinutes` and
`earlyLeaveGraceMinutes` are therefore validated once and copied identically
into every frozen segment. A segment row cannot override either value, and the
calculator never re-reads current policy. Introducing true per-segment grace
requires a later schema/authoring contract amendment.

The policy values are normalized and validated together with the frozen
context. `roundingMinutes` is a positive integer. A zero severe/absence
threshold disables that tier; otherwise the existing nesting rule is frozen:
`absenceLateThresholdMinutes >= severeLateThresholdMinutes >=
max(segment.lateGraceMinutes)`. W4 floors each completed segment's physical
duration to whole minutes, sums those raw segment minutes, then applies the
existing round-down `roundMinutes(total,roundingMinutes)` exactly once to the
daily worked total. Late/early minutes are whole-minute per-segment values
summed without another rounding pass. Severe/absence tier fields are derived
from the final daily late total and the frozen thresholds. Per-segment rounding
and current-rule rereads are forbidden.

Prepare owns the trusted output:

```ts
type PreparedAttendanceWritePlanV1 =
  | {
      posture: 'legacy_projection_only'
      operationId: string | null
      operationCommandFingerprint: string
      calculation: null
      projectionDirective: {
        kind: 'apply_legacy'
        projection: PreparedDailyProjectionV1
      }
    }
  | {
      posture: 'shadow' | 'eligible' | 'authoritative'
      operationId: string
      operationCommandFingerprint: string
      calculation: PreparedAttendanceCalculationV1
      projectionDirective: AttendanceProjectionDirectiveV1
    }

interface PreparedAttendanceCalculationV1 {
  schemaVersion: 1
  engineVersion: string
  nextCalculationVersion: number
  mode: 'shadow' | 'authoritative'
  attribution: AttendanceAttributionSnapshotV1
  context: FrozenAttendanceContextV1 | null
  contextDecision:
    | 'resolved_attribution'
    | 'request_frozen'
    | 'prior_calculation_frozen'
    | 'current_policy_requested'
    | 'unavailable'
  segmentSnapshot: FrozenAttendanceContextV1['segments'] | []
  evidence: AttendanceEvidenceV1[]
  approvedFacts: ApprovedAttendanceFactV1[]
  manualOverride: ManualAttendanceOverrideV1 | null
  mergePolicy: AttendanceCalculationIntentV1['mergePolicy']
  calculationTier: 'legacy_shadow' | 'segment_authoritative'
  inputProvenance: AttendanceInputProvenanceV1
  semanticInputFingerprint: string
  provenanceFingerprint: string
  sourceDefinitionFingerprint: string | null
  result: PreparedAttendanceResultV1
}

type AttendanceProjectionDirectiveV1 =
  | { kind: 'apply_legacy'; projection: PreparedDailyProjectionV1 }
  | { kind: 'apply_segment'; projection: PreparedDailyProjectionV1 }
  | { kind: 'preserve' }
  | {
      kind: 'restore'
      restoresCalculationId: string
      parentState: {
        projectionOwner: 'legacy_untracked' | 'w4'
        currentCalculationId: string | null
        visibilityState: 'active' | 'retired'
        visibilityReason:
          | 'active'
          | 'review_placeholder'
          | 'import_rollback'
          | 'operator_retirement'
        projection: PreparedDailyProjectionV1 | null
      }
    }
  | { kind: 'retire' }
```

`PreparedDailyProjectionV1` is the closed compatibility shape for
`firstInAt`, `lastOutAt`, non-negative worked/late/early minutes, daily status,
timezone, work date, and allowlisted meta. The canonical boundary has a closed
legacy branch: `legacy_projection_only` runs the extracted pure legacy policy,
emits no W4 calculation, and preserves flag-OFF response bytes. In
`shadow|eligible`, prepare always runs that same policy and emits
`apply_legacy`, even when the W4 calculation outcome is `review_required`.
This keeps compatibility projection independent from W4 outcome. In
`authoritative`, a completed calculation emits `apply_segment`; authoritative
review emits `preserve`. Reversal directives follow section 7. Apply executes
the directive verbatim and never calls either calculator.

`apply_legacy` and `apply_segment` set `visibility_state=active` and
`visibility_reason=active` atomically. `restore` reinstates the exact frozen
owner/pointer/visibility/reason/projection tuple; it does not force active.
`preserve` changes neither. `retire` sets the exact closed reason carried by its
trusted prepared plan. A parent retired by first-import rollback or created as
a review placeholder may be reactivated by the next valid non-rollback
business source; that operation first freezes the retired parent tuple as its
preimage, then prepares from the new durable source and complete immutable
evidence, never from hidden default/imported daily fields. A parent retired by
an operator command is terminal for ordinary writers: they return
`ATTENDANCE_RECORD_OPERATOR_RETIRED` with zero writes. W4 does not invent an
operator reactivation path; that requires a separately RATIFIED design.

Recompute uses prior frozen context by default. “Current policy” is a distinct
`resolve_now` intent and records `current_policy_requested`; it never mutates
the old snapshot.

Every correction, leave, overtime, and outdoor request that can affect a W4
projection freezes V2 and context at request creation. Final approval consumes
that exact snapshot. A pre-W4 request is not upgraded from current schedules.

### 4.2 Closed evidence and approved facts

```ts
type AttendanceEvidenceV1 =
  | {
      kind: 'punch'
      ref: string
      direction: 'check_in' | 'check_out'
      occurredAt: string
      source: 'attendance_event' | 'outdoor_approval' | 'import'
    }
  | {
      kind: 'approved_adjustment'
      ref: string
      direction: 'check_in' | 'check_out'
      occurredAt: string
      source: 'correction'
    }
  | {
      kind: 'scheduled_absence'
      ref: string
    }

type ApprovedAttendanceFactV1 =
  | {
      kind: 'leave'
      requestId: string
      requestSnapshotVersion: number
      requestSnapshotFingerprint: string
      approvalVersion: number
      approvalRecordId: string
      coverage:
        | {
            kind: 'bounded_interval'
            startAt: string
            endAt: string
            minutes: number
          }
        | {
            kind: 'minutes_only_unbounded'
            minutes: number
            source: 'explicit_minutes' | 'policy_default'
          }
      leaveType: string
    }
  | {
      kind: 'overtime'
      requestId: string
      requestSnapshotVersion: number
      requestSnapshotFingerprint: string
      approvalVersion: number
      approvalRecordId: string
      coverage:
        | {
            kind: 'bounded_interval'
            startAt: string
            endAt: string
            minutes: number
          }
        | {
            kind: 'minutes_only_unbounded'
            minutes: number
            source: 'explicit_minutes' | 'policy_default'
          }
    }
  | {
      kind: 'correction'
      requestId: string
      requestSnapshotVersion: number
      requestSnapshotFingerprint: string
      approvalVersion: number
      approvalRecordId: string
      direction: 'check_in' | 'check_out'
      occurredAt: string
      supersededEvidenceRef: string
    }
  | {
      kind: 'outdoor_punch'
      requestId: string
      requestSnapshotVersion: number
      requestSnapshotFingerprint: string
      approvalVersion: number
      approvalRecordId: string
      direction: 'check_in' | 'check_out'
      occurredAt: string
    }
  | {
      kind: 'reversal'
      requestId: string
      requestSnapshotVersion: number
      requestSnapshotFingerprint: string
      approvalVersion: number
      approvalRecordId: string
      reversesApprovalRecordId: string
    }
```

Unknown keys/kinds/directions fail closed. Evidence is sorted by
an explicit variant comparator before hashing: timed evidence by
`(occurredAt,direction,kind,ref)`, then untimed `scheduled_absence` by
`(kind,ref)`. Missing fields never become JavaScript `undefined` sort keys.
Facts use a closed kind rank followed by request ID, immutable request-snapshot
version/fingerprint, terminal approval version, business
interval/occurrence time when present, and approval-record ID.

`approvalVersion` is the terminal `approval_instances.version` written in the
same transaction; `approvalRecordId` is the returned `approval_records.id`
serialized as a decimal string. Request creation freezes V2/context and a
closed request payload into section 7.2. Every permitted pending edit appends a
new request snapshot/version in its update transaction. Final approval binds
the exact latest snapshot hash/version before producing a fact. W4 does not
assume a nonexistent mutable `attendance_requests.version` column or trust
mutable `form_snapshot`.

Manual override is a closed set/unset operation list. Its `set_metrics.status`
uses only the existing daily status union; an arbitrary string is invalid. The
snapshot includes edit ID, before-fingerprint, reason, and
`actorPosture='attendance_admin'`.

### 4.3 Semantic versus provenance fingerprints

- `semanticInputFingerprint` hashes the semantic projection of attribution,
  context, ordered evidence, ordered approved facts, manual override, merge
  policy, tier, and engine/schema versions.
- The semantic projection includes every business time that changes a result:
  punch/correction occurrence, leave/overtime interval, work date, timezone,
  local segment boundaries, and resolved UTC boundaries. It excludes only
  operational audit times such as `resolvedAt`, `createdAt`, conversion time,
  transport time, and correlation IDs.
- `provenanceFingerprint` hashes exact transport metadata separately.
- Equivalent native CSV and client-converted XLSX must share the semantic
  fingerprint and differ in provenance.
- Changing any approved fact or manual override changes the semantic
  fingerprint.

`AttendanceInputProvenanceV1` is a discriminated union whose transport set is
exactly
`live_event|rows|csv_text|csv_upload|xlsx_client_converted_csv|integration_sync|approved_request|scheduled_job|recompute|approval_reversal|import_rollback|operator_retirement|legacy_baseline_capture`.
Artifact SHA-256, normalized CSV SHA-256, converted sheet name, and source
reference are required or forbidden per variant; unknown or inapplicable
non-null keys fail closed.

### 4.4 Approved facts and merge semantics

W4 preserves physical-time truth:

- segment worked minutes come only from matched in/out evidence intersected
  with that planned segment, plus only its exact bounded approved-overtime
  extension;
- leave or overtime approval alone never fabricates worked minutes;
- bounded approved overtime may extend W2 attribution under OD-4556-7, but
  unmatched overtime contributes zero physical work;
- validated bounded leave is intersected with each planned segment and excuses
  only the planned interval it fully covers;
- partial bounded coverage and `minutes_only_unbounded` leave/overtime remain
  faithfully snapshotted but become review-required; they cannot excuse a
  segment or extend attribution;
- physical missing status remains visible with
  `approved_leave_overlay`; daily aggregation distinguishes excused from
  unexcused missing;
- all planned time fully covered by leave and no unexcused anomaly yields daily
  `adjusted`;
- correction/outdoor facts are boundary evidence, not minute overlays.

The exact current `applyAttendanceInOutMergePolicy` branch behavior is lifted
into a pure frozen policy before calculation. W4 changes no
`internalWinsOnIn`/`externalWinsOnOut` meaning; it removes only the second
mutable post-upsert pass.

## 5. Time conversion and segment matching

### 5.1 Strict IANA conversion

For every frozen local segment boundary:

1. enumerate UTC instants that round-trip to local date/time/timezone;
2. zero matches: review-required `dst_gap_local_time`;
3. one match: use it;
4. two matches on an unshared boundary: start chooses earlier, end chooses
   later;
5. two matches on the same local boundary shared by `E_i` and `S_(i+1)`:
   review-required `dst_fold_shared_boundary_ambiguous` because W3 stores no
   offset capable of assigning the repeated hour to either segment;
6. invalid timezone or more than two matches: review-required;
7. freeze instant, timezone, offset, and
   `unique|fold_earlier|fold_later`.

No caller catches a failure and retries in UTC.

### 5.2 Absolute anchors and capture cells

Construct strictly ordered `(S_i,E_i)` instants:

- `S_i < E_i`;
- `E_i <= S_(i+1)`;
- all planned boundaries remain in frozen W2 `absoluteWindow`;
- any invariant failure is `invalid_segment_order`.

W4 adds no hidden capture-minute setting. It constructs two independent
direction partitions: check-in anchors are segment starts and check-out anchors
are segment ends. Midpoints are computed only between adjacent anchors in the
same partition. Cells are left-closed/right-open, the final right endpoint is
included, and a midpoint tie belongs to the later segment. Both partitions are
clipped to frozen W2 `attributionWindow`.

### 5.3 Duplicate posture

- every timed evidence item must lie in the frozen attribution window and match
  exactly one directional cell; otherwise retain it in the immutable snapshot,
  return review-required `evidence_outside_attribution_window`, and never extend
  the work span;
- multiple matches: review-required `ambiguous_segment_match`;
- two in candidates in one cell: `duplicate_check_in`;
- two out candidates in one cell: `duplicate_check_out`;
- correction must name the superseded evidence ref;
- after matching, `actualIn < actualOut` is required for each completed segment;
  equality or reversal is review-required `invalid_evidence_order`;
- completed actual intervals must remain ordered and non-overlapping:
  `actualOut_i <= actualIn_(i+1)`. Any overlap is review-required
  `overlapping_actual_intervals`; no evidence is reassigned or counted twice;
- raw actual boundaries remain the source for late/early and evidence
  explanation, but payable physical time is
  `intersection([actualIn_i,actualOut_i),[S_i,E_i))`. Early arrival, late
  departure, or an interval extending toward the next segment cannot count a
  planned break. Only a validated bounded overtime fact frozen in the
  calculation may extend the right and/or left payable boundary, and its
  extension remains clipped to that exact approved interval;
- an actual interval that crosses a planned inter-segment break is retained for
  explanation but produces only the in-segment intersection. Tests cover
  early-in, late-out, cross-break, approved bounded extension, and an
  unapproved extension mutation;
- review rows never become the current W4 pointer; authoritative review
  preserves the current projection, while shadow review still applies its
  separately prepared legacy compatibility projection.

If only one direction has duplicates, its specific duplicate code wins. If
both directions or another ambiguity coexist, `ambiguous_segment_match` wins.
The calculator never picks earliest/latest to hide a duplicate.

## 6. Closed status and reason contracts

### 6.1 Segment statuses

Exact set:

```text
normal
late
early_leave
late_early
missing_check_in
missing_check_out
missing_both
```

Priority: missing both, missing in, missing out, late+early, late, early, normal.

Exact segment reason set:

```text
within_window
late_check_in
early_check_out
missing_check_in
missing_check_out
missing_both
approved_correction_applied
approved_leave_overlay
approved_overtime_overlay
dst_fold_start_earlier
dst_fold_end_later
```

Reason arrays are non-empty, sorted, unique, and closed at parser, service,
OpenAPI, and DB layers.

### 6.2 Calculation outcomes

`outcome` is exactly
`baseline|completed|review_required|reversed`.

Persisted outcome reasons:

```text
calculated
shadow_only
legacy_projection_baseline
ambiguous_segment_match
duplicate_check_in
duplicate_check_out
dst_gap_local_time
dst_fold_shared_boundary_ambiguous
invalid_timezone
invalid_segment_order
invalid_evidence_order
overlapping_actual_intervals
evidence_outside_attribution_window
missing_frozen_context
legacy_attribution_not_upgradeable
frozen_evidence_unavailable
context_resolution_ambiguous
context_mismatch
input_schema_invalid
legacy_time_ingress_not_authoritative
approved_fact_conflict
manual_override_invalid
import_metric_conflict
import_rollback_reversal
operator_retirement
```

`baseline` pairs only with `legacy_projection_baseline`; `completed` pairs only
with `calculated|shadow_only`; `reversed` pairs only with
`import_rollback_reversal|operator_retirement`; the middle error set pairs with
`review_required`.

`IMPORT_ROLLBACK_SUPERSEDED`, `SEGMENT_CALCULATION_SUSPENDED`, and
`W4_ATTRIBUTION_UNSUPPORTED`, `ATTENDANCE_OPERATION_CONFLICT`, and
`ATTENDANCE_WRITE_NOT_AUTHORIZED` are no-write request/transition errors, not
persisted reasons.

### 6.3 Daily aggregation

“Missing” below means not fully excused by validated leave:

1. every segment unexcused `missing_both` -> `absent`;
2. any unexcused missing -> `partial`;
3. any `late_early`, or late plus early across segments -> `late_early`;
4. any late -> `late`;
5. any early -> `early_leave`;
6. approved fact changed or fully excused the result with no anomaly ->
   `adjusted`;
7. otherwise -> `normal`.

Non-workday remains `off`. Daily first/last are min/max matched boundaries;
worked minutes follow the one daily rounding pass frozen in section 4.1, while
late and early minutes are segment sums; breaks and overlapping actual
intervals are never counted; missing boundaries synthesize no work.

## 7. Immutable persistence and reversal

### 7.1 `attendance_result_operation_batches` and
`attendance_result_operations`

Create the durable batch and item source/idempotency registries before
calculation tables. A batch row is keyed by
`(org_id,entrypoint,batch_command_id)` and stores both the exact ordered
`item_sequence_fingerprint` and the order-insensitive
`item_set_fingerprint`, item count, authenticated actor/source/subject scope,
accepted posture, state, and response. Each item row stores its canonical input
ordinal and has a composite FK to its batch row when batched; single commands
have no batch FK. Reusing a batch command ID with any different ordered
sequence of `(ordinal,operation_id,command_fingerprint)` fails 409 before
item/source DML, even when the unordered set is identical.

Item operation logical fields are org, entrypoint, operation ID, authorized
subject/source kind/source ref, authenticated actor ID, token subject, exact
pre-source command fingerprint, accepted rollout posture, state, resolved
record/calculation/request refs, sealed semantic and provenance fingerprints
when a result exists, response snapshot, created/updated timestamps, and
optimistic version. Import/integration item operations additionally persist an
immutable closed `normalized_business_input_snapshot` containing boundary
presence and the section 4.1 metric/policy snapshot; it excludes uploaded file
bytes, arbitrary row columns, secrets, and unrecognized keys. Calculation
evidence copies the exact snapshot rather than re-reading mutable import
preview/meta.

- primary/unique key: `(org_id,entrypoint,operation_id)`;
- lock this row before attribution or parent creation;
- replay first revalidates a freshly minted authorization witness; the operation
  row is never an authorization cache;
- same key plus byte-equal actor ID, actor posture, token subject, source,
  subject, capability, command payload, immutable source references, and
  pre-source provenance fields returns the recorded response/result;
- same key with any different actor ID, actor posture, token subject, source,
  subject, capability, command payload, immutable source reference, pre-source
  provenance field, or requested semantic action returns 409
  `ATTENDANCE_OPERATION_CONFLICT`;
- an operation stores the rollout posture first accepted; a retry after a
  rollout transition returns that result rather than re-executing under the new
  posture;
- after fresh authorization, an exact-key read of batch/item operation rows is
  allowed before the suspension decision solely to classify replay; a
  congruent completed replay returns its stored response even while currently
  suspended and performs no source/result write;
- a missing, incomplete, paused, mixed, or non-congruent operation is not a
  completed replay. Suspension is then checked before creating/advancing an
  operation row or touching any source row; synchronous work returns 503 and a
  durable queued item remains paused;
- states are closed to `claimed|paused|completed|canceled`; only
  `claimed->paused|completed|canceled` and `paused->completed|canceled` are
  legal, and cancel is allowed only before source DML;
- state changes occur in the same transaction as request/event/calculation
  effects; an already durable queued source may remain `paused`;
- operation and batch rows reject DELETE/TRUNCATE. After `completed`, command,
  actor/source/subject/capability, accepted posture, fingerprints, resolved
  refs, response, and state are immutable; no parent/source FK cascades them;
- response-loss replay and concurrent first writers are real-DB tested. A
  first writer does not rely on the unique constraint to serialize: after the
  org rollout lock it acquires the section 9 exclusive transaction advisory
  lock for every supplied batch/operation identity before re-reading or
  inserting that identity. The unique constraint remains a corruption
  backstop, not an expected `23505` control path.

For W4-enabled live punch and web approval decisions, OpenAPI and the web client
add a required UUID `operationId`. The client allocates it once per user gesture
and reuses it across outdoor-note, decision, and network retries; the server
binds the event, pending request, or decision to that operation. A verified
channel callback binds its immutable action identity. Legacy posture accepts
its old payload unchanged. Scheduled absence gains a durable
scheduled-run/user/date source row; legacy import gains batch/item identities
before it can enter shadow. Process-local dedupe and a post-insert serial ID are
not operation sources.

For an atomic import/integration batch, acquire the batch-command and item
operation identity advisory locks in section 9's canonical order, then
lock/claim the batch row followed by item operation rows sorted by
`(org_id,entrypoint,operation_id)`. The batch ID is not reused as every item's
calculation operation ID. Because the source
transaction is atomic, replay must observe one congruent completed batch plus
all congruent completed items, or no batch/items; a mixed existing/new,
missing-item, count/hash mismatch, or item attached to another batch fails
closed as `ATTENDANCE_OPERATION_BATCH_CONFLICT`. The recorded batch response is
returned only after every item is reauthorized and congruent. It is stored as
an order vector plus an object keyed by item operation ID, so positional output
cannot be replayed against a reordered request.

Import item operation IDs are deterministically derived from the fixed UUID
namespace, batch command ID, canonical row ordinal, and item semantic
fingerprint in section 4. Integration item UUIDv5 input is exactly the durable
sync-run ID, canonical input ordinal, and semantic fingerprint in section 4;
the immutable provider item key/version is an input to that semantic
fingerprint and is not appended again to the UUIDv5 name bytes.
Identical retry input therefore regenerates the exact ordered sequence;
reordering changes `item_sequence_fingerprint`, while adding, removing, or
changing a row also changes the set/count and conflicts before DML.

W4's whole-batch atomicity is deliberately bounded:

```text
W4_MAX_BATCH_ITEMS = 5000
W4_MAX_DISTINCT_TARGETS = 5000
W4_TRANSACTION_STATEMENT_TIMEOUT_MS = 180000
W4_TRANSACTION_LOCK_TIMEOUT_MS = 5000
W4_ADVISORY_HELPER_WAIT_MS = W4_TRANSACTION_LOCK_TIMEOUT_MS
W4_TRANSACTION_MAX_RETRIES = 2
```

These are one exported contract, not environment-tunable hidden behavior.
The limits are validated before batch/source DML. A W4-enabled request above
either item or target limit fails closed as `W4_BATCH_LIMIT_EXCEEDED`; an
authoritative org never falls back to partial commits or the legacy writer.
Legacy projection-only behavior remains byte-identical. Shadow/eligible may
preserve the legacy compatibility response only when the entire batch is kept
out of W4 and records an explicit values-free
`w4_batch_limit_shadow_bypass` rollout event; such a batch contributes no
promotion evidence. Benchmarks must prove the exact maxima and timeout/retry
posture before promotion. Changing a constant requires a contract amendment.

Operation and target acquisition each enforce one helper-wide monotonic
deadline, not one fresh timeout per key. At helper entry, the production
monotonic clock fixes
`deadline = now + W4_ADVISORY_HELPER_WAIT_MS`. Before each final-key
query the helper computes the positive integer remaining milliseconds, applies
that value through transaction-local `set_config('lock_timeout', ..., true)`,
acquires exactly that key, and checks the same deadline again. Expiry before a
query or after the final acquisition throws the helper's typed busy error and
rolls back all acquired transaction locks and DML. On successful completion it
restores `W4_TRANSACTION_LOCK_TIMEOUT_MS`. A module-private test clock is the
only clock seam and production construction cannot inject it.

SQLSTATE `55P03` from the operation helper's own acquisition query maps after
rollback to values-free HTTP
`409 ATTENDANCE_OPERATION_IN_PROGRESS`; it is not retried and raw SQL
state/message is never returned. A later retry performs normal authorization
and replay. A timeout from any other statement is not relabeled as operation
contention. The rollout helper has one key and maps a `55P03` raised by its own
acquisition to values-free `503 ATTENDANCE_CALCULATION_ROLLOUT_BUSY` after the
whole transaction rolls back. The target helper uses the same helper-wide
deadline protocol and maps its own acquisition timeout to values-free
`503 ATTENDANCE_CALCULATION_TARGET_BUSY`. No other `55P03` or `57014` is
relabeled or retried. None of these timeouts permits compatibility fallback or
partial DML.

After private adapters resolve targets, a batch groups all items with the same
`(org,user,workDate)` into one ordered evidence fold and produces exactly one
prepared calculation for that target. Its calculation operation ID is
deterministically derived from the batch command ID plus the resolved target;
it is neither the batch ID nor any one item ID. Every contributing item row
points to that target calculation. Before the first target write, the batch freezes one
`pre_batch_parent_state` containing parent absent/present, exact daily
projection, projection owner, current pointer, visibility state/reason, and
compatibility fingerprint in that calculation's
`parent_preimage_snapshot`. Batch rollback restores this target-level preimage,
never the immediately preceding calculation when that calculation was
produced by another item in the same batch.

### 7.1a Transactional event outbox

Create durable `attendance_result_event_outbox`. Each W4-covered source
operation in section 8.3 running in `shadow|eligible|authoritative` that
currently reaches `emitEvent` stores one closed event row in the same
transaction as its operation seal and source/effect/result writes. This
durability contract does not apply to `legacy_projection_only`: that posture
has no mandatory `operationId`; when one is supplied its compatibility
operation stores the legacy response but creates no outbox. Legacy preserves
the existing synchronous/best-effort emit behavior and response bytes.
`suspended` admits no new source operation; congruent replay of an already
completed non-legacy operation may notify an already-running dispatcher through
a non-persistent in-process signal, or rely on its ordinary poll. The replay
request transaction is authorization SELECT plus response return only: it
cannot insert/update operation, outbox, audit, source, shared-effect, or result
rows. Completed legacy compatibility replay likewise performs no emit or
business DML.
W4C-0 generates the exact reachable event-kind/payload inventory; unrelated
configuration/report events remain outside this lock. The unique identity is
`(org_id,entrypoint,operation_id,event_kind)`; payload schema/version,
business-key fingerprint, guarded `pending|delivered` state, attempts,
next-attempt time, and created/delivered timestamps are explicit. Identity and
payload are immutable; only closed retry/delivery transitions may update
delivery fields. Event kinds and payload keys are a closed allowlist that
preserves the existing public event contract without serializing arbitrary
request/calculation snapshots.

A retryable dispatcher claims rows with `FOR UPDATE SKIP LOCKED`, emits the
existing in-process event, and marks delivery. Process restart or a crash after
DB commit but before emit leaves the row pending; exact operation replay never
re-executes business DML but may wake the pending dispatcher. Concurrent
dispatchers, emit failure, and response-loss retries produce one durable outbox
row. Down migration refuses while any outbox row exists.

W4C-0 delivers the schema, immutable payload/identity constraints, state
machine, and transaction-bound enqueue interface without caller cutover.
W4C-2 delivers the dispatcher and live/scheduled event cutover; W4C-3b adds the
closed approval/cancellation kinds. A lifecycle event may remain best-effort
only if a separate contract amendment names that exact event and proves there
is no correctness/reliability consumer.

### 7.2 `attendance_request_calculation_snapshots`

Create an append-only request snapshot table keyed by
`(org_id,request_id,version)`. `payload_fingerprint` is indexed but not unique:
the valid edit history A -> B -> A must append version 3 rather than collide
with version 1. It stores request type, subject, bounded or minutes-only
payload, V2 attribution/context (or explicit unsupported posture), and
creation/edit actor/time.

The migration adds the referenced unique `(id,org_id)` key to
`attendance_requests`; every snapshot FK includes both columns.

- W4-enabled request creation appends version 1 in the request transaction;
- every allowed pending business-field edit locks the request/latest snapshot
  and appends exactly one new version;
- approval/rejection/cancellation locks and binds the latest exact version/hash;
- terminal `approval_records` insertion uses `RETURNING id`;
- a pre-W4 request with no snapshot is unsupported and cannot be upgraded from
  current schedule/config. In shadow/eligible only, its terminal action may
  preserve exact legacy behavior and append an unsupported W4 review; in
  authoritative it is blocked before terminal state;
- UPDATE/DELETE/TRUNCATE triggers protect snapshots;
- direct mutable `attendance_requests` or `approval_instances.form_snapshot`
  substitution cannot produce an attendance fact.

### 7.3 `attendance_record_calculations`

Required logical columns:

| Column | Contract |
| --- | --- |
| `id` | UUID PK, generated before insert |
| `org_id`, `attendance_record_id` | required; composite parent FK, RESTRICT |
| `version` | positive integer, unique per record |
| `calculation_kind` | `legacy_baseline|calculation|reversal` |
| `mode` | `shadow|authoritative` |
| `entrypoint` | exact section 4.1 set |
| `engine_version`, `snapshot_schema_version` | required |
| `supersedes_calculation_id` | nullable same-record/same-org composite self FK |
| `restores_calculation_id` | nullable same-record/same-org composite self FK |
| `source_batch_id` | nullable UUID, no cascade |
| `operation_id` | required host-derived key; null only for internal legacy baseline |
| `semantic_input_fingerprint` | `char(64)` |
| `provenance_fingerprint` | `char(64)` |
| `source_definition_fingerprint` | nullable only for unsupported review |
| `attribution_snapshot` | exact tagged union from section 4.1 |
| `context_snapshot` | exact V1, nullable only for unsupported review |
| `segment_snapshot` | exact ordered frozen array |
| `evidence_snapshot` | exact closed array |
| `approved_facts_snapshot` | exact closed array |
| `manual_override_snapshot` | nullable exact shape |
| `input_provenance` | exact shape |
| `merge_policy`, `calculation_tier` | exact closed values |
| `outcome`, `outcome_reason_code` | exact compatible pair |
| `projection_effect` | `none|set_active|set_retired` |
| `expected_segment_count` | integer 0..3 |
| projected daily fields | nullable status/times/non-negative minutes; all null for review, populated only for closed baseline/completed/reversal snapshots |
| `parent_preimage_snapshot` | nullable closed absent/present witness with projection, owner, pointer, visibility state/reason, and compatibility fingerprint |
| `shadow_diff_code`, `shadow_diff` | nullable exact values-free shape |
| actor/correlation/created fields | append-only audit |

There is no `updated_at`.

Constraints:

- unique `(attendance_record_id,version)`;
- unique `(id,attendance_record_id,org_id)`;
- partial unique `(org_id,entrypoint,operation_id)` where operation ID is not
  null; retries return the existing calculation and cannot allocate another
  version;
- baseline uniqueness uses
  `(org_id,attendance_record_id,projected_daily_fingerprint)` and cannot consume
  the external operation ID needed by the following normal calculation;
- supersedes/restores FKs include `(attendance_record_id,org_id)`;
- `attendance_records` gains the referenced unique `(id,org_id)` key;
- supersedes/restores are immediate and must point to a strictly lower version;
  deferred forward references, self-reference, and lineage cycles fail;
- baseline snapshots an existing legacy parent immediately before its first
  authoritative replacement, has no segment children, and is never produced by
  migration/backfill; its projection effect is `none`;
- every current-changing authoritative calculation supersedes the exact locked
  current calculation when a current pointer exists; an active legacy parent
  first receives a baseline in the same transaction;
- a fresh authoritative `review_required` result may create only a hidden
  review-placeholder parent, has no predecessor/pointer/projection effect, and
  has every projected daily field null rather than a DB default; a later first
  completed result on that parent needs no baseline because no active
  compatibility projection existed;
- normal calculation has no restore target;
- reversal requires supersedes. A present preimage pointer requires
  `restores_calculation_id` to equal it; an absent-pointer retired preimage
  requires restores null. The reversal's projection effect matches the frozen
  target state (`set_active|set_retired`) even when the restored parent pointer
  is an earlier calculation or null;
- completed normal calculation requires resolved V2, context, and expected
  count 1..3;
- baseline/review/reversal count is zero; shadow projection effect is `none`;
- a baseline is restore-only and never a final parent pointer; only
  authoritative completed/reversed rows may affect the parent.

### 7.4 `attendance_record_segments`

Required fields: UUID, org, record, calculation, index 0..2, expected start/end,
actual in/out, non-negative metrics, closed status/reasons, matched/unmatched
evidence refs, and created time.

- unique `(calculation_id,segment_index)`;
- composite FK `(calculation_id,record_id,org_id)` with RESTRICT;
- completed normal calculation has exactly `expected_segment_count` children;
- review and reversal have zero children;
- a `DEFERRABLE INITIALLY DEFERRED` constraint trigger checks exact child count
  at commit so direct incomplete inserts fail.

There is no `updated_at`.

### 7.5 Parent pointer

Add to `attendance_records`:

```text
current_calculation_id uuid NULL
projection_owner text NOT NULL DEFAULT 'legacy_untracked'
  CHECK IN ('legacy_untracked','w4')
visibility_state text NOT NULL DEFAULT 'active'
  CHECK IN ('active','retired')
visibility_reason text NOT NULL DEFAULT 'active'
  CHECK IN ('active','review_placeholder','import_rollback','operator_retirement')
```

The pointer uses a composite FK to the same record/org calculation. A DB
constraint trigger additionally proves:

- `legacy_untracked` iff the pointer is null;
- `w4` points to authoritative completed/reversed W4 evidence;
- `visibility_state` matches the selected row's
  `projection_effect=set_active|set_retired`;
- active visibility requires `visibility_reason=active`; retired visibility
  requires one of the three closed retired reasons, and a W4 pointer's reason
  must match its selected row;
- once a baseline or authoritative current-owning row exists, the parent can
  never return to `legacy_untracked`; review-only rows do not trigger this
  invariant;
- every mutable W4-owned daily field equals the selected snapshot.

W4 review rows never become the current W4 pointer. For a fresh authoritative
review, create the parent in the same transaction only as
`legacy_untracked`/pointer-null/retired/`review_placeholder`; ordinary readers
see no fabricated `normal` zero-minute row. An existing authoritative review
preserves the exact prior pointer/projection/visibility. In shadow, the
independent prepared legacy compatibility projection still applies and may
update the visible daily row even though the W4 review row is not current.

Shadow first-import rollback may keep
`projection_owner=legacy_untracked`, pointer null, and set
retired/`import_rollback`; this preserves history without pretending the row is
visible. Currentness is derived only from the
pointer/owner/visibility/reason tuple; immutable rows never carry a mutable
`is_current` claim.

### 7.6 Canonical current-record visibility

Create one canonical current-record view/query helper that includes
`visibility_state='active'`. Every ordinary consumer must use it: employee/admin
record lists, summary/payroll, report sync/digests, missed-punch/reminder
selection, anomaly listing, makeup-anomaly fact derivation, open-record
work-date attribution, Wave 5 DecisionTrace, comprehensive-hours, export, and
any integration/report reader. These are independent consumers even when they
share a downstream helper; each receives its own retired-row negative test.
Only explicitly named history/calculation-detail and operator audit paths may
read retired parents.

An exact-head generated SELECT inventory scans all runtime roots and operator
scripts, classifies every `attendance_records` read as current or historical,
and fails on an unclassified/direct ordinary read. First-import rollback tests
must prove every ordinary surface returns no retired row while historical
detail still returns the immutable reversal/preimage.

### 7.7 Immutability boundary

DB triggers reject UPDATE, DELETE, and TRUNCATE on request snapshots,
calculations, and segments.
Operation and batch registries reject DELETE/TRUNCATE and FK cascade. A guarded
transition trigger allows only the section 7.1 state machine; once completed,
all columns including response/fingerprints/refs/state are immutable. An
UPDATE that does not perform a legal state transition is rejected.
Application code and W4 runbooks have no trigger-disable path.

The repository currently uses the same DB owner path for migration and runtime.
This lock therefore does not falsely claim protection from a malicious/manual
table-owner session. A later ops hardening may split migration-owner and
runtime-writer roles. W4 migrations never disable triggers after rows exist.

### 7.8 Predecessor, preimage, and evidence evolution

Every authoritative normal calculation supersedes the exact locked current
pointer. A wrong/null predecessor is a DB failure. When an existing
`legacy_untracked` parent is about to receive its first authoritative result,
apply first appends a `legacy_baseline` carrying the exact daily projection,
visibility, allowlisted meta, and a provenance-quality marker, then makes the
normal calculation supersede that baseline. The baseline is restore evidence,
not a parent pointer target and not permission to infer punches from
first/last.

Prepared evidence starts from the prior immutable snapshot only when its closed
provenance is complete:

- a new durable event appends its exact ref;
- import `override` replaces only the explicitly supplied boundaries; import
  `merge` requires complete prior evidence;
- correction replaces the exact named evidence ref;
- approved-fact reversal removes the exact approval-record/version fact;
- unrelated facts/evidence survive;
- mutable parent first/last/meta are never reverse-engineered into evidence.

If a legacy baseline lacks complete provenance and an operation would need to
merge with it, W4 emits review/no current change until an explicit source replay
is supplied. Promotion fixtures must therefore prove source completeness for
every current synthetic record.

Every import target calculation freezes the write-before parent preimage as
either `absent` or the exact projection, owner, current pointer, visibility
state/reason, and compatibility fingerprint. A batch with multiple items for
one target freezes this once before its folded calculation; no later item may
replace it with a batch-internal predecessor. This snapshot is independent of
W4 outcome and is the only rollback source.

### 7.9 Import rollback

Authoritative or mixed-batch rollback is one transaction:

1. lock batch, then records in `(org,user,workDate)` order;
2. load immutable calculations and each target's exact
   `pre_batch_parent_state` by org/batch;
3. if current pointer is not the batch calculation or its idempotent reversal,
   abort whole batch with 409 `IMPORT_ROLLBACK_SUPERSEDED`, zero writes;
4. append one reversal per record;
5. prior parent existed: set the exact restore target when present, copy the
   frozen daily projection into the reversal when present, and restore the
   pre-batch owner, current pointer, visibility state/reason, and projection.
   A retired preimage stays retired; an active preimage becomes active;
6. import created the first parent: no restore target,
   `projection_effect=set_retired`, point parent to reversal, set
   `visibility_reason=import_rollback`, and hide ordinary reads. The reversal's
   non-null projected daily fields are the exact frozen imported after-image
   being retired, while `parent_preimage_snapshot={ posture:'absent' }` proves
   there was no restore value. The writer cannot synthesize zero/null defaults.
   Historical detail labels this row `retired/effective=false`;
7. batch becomes rolled back only after all rows succeed;
8. repeat returns existing reversal IDs.

Ancestry alone is insufficient: later punch/correction may have adopted import
evidence. Mutable parent `source_batch_id` is not rollback authority.

Pure-shadow rollback instead locks the same batch/records, verifies that no
later compatibility operation superseded the frozen preimage by requiring the
current compatibility fingerprint to equal the batch's prepared after-image
(otherwise whole-batch 409/zero writes), appends a
reversal with `projection_effect=none`, and applies the frozen parent preimage:
restore the exact prior projection/owner/pointer/visibility tuple, or set
`visibility_state=retired`, `visibility_reason=import_rollback` when the batch
created the first parent. It never forces a retired preimage active and never
leaves imported compatibility values visible after reporting success. Mixed
shadow/authoritative batches use the authoritative all-or-nothing rule.

Legacy posture keeps the existing rollback response only while the org remains
in `legacy` and every affected parent has zero immutable W4 calculation,
pointer, or operation rows. A pre-W4 batch without a frozen target preimage
cannot cross into W4 rollback semantics by inference: transition to
`shadow|eligible|authoritative` is blocked while such a batch remains
reversible, unless a separately audited operator action first appends one
immutable `attendance_import_rollback_closures` witness for the batch without
touching business rows. The witness is unique by `(org_id,batch_id)` and stores
the locked batch identity/fingerprint, actor identity and authorization
posture, reason code, closed timestamp, and audit correlation ID; it is never
updated or deleted.

Legacy rollback, rollback-window close, and every rollout transition use one
`SERIALIZABLE` protocol. They use section 9's complete order: acquire the org
rollout advisory lock; lock the rollout state row when present for a transaction
that changes it; acquire every relevant operation-identity advisory lock in
stable order; lock the corresponding operation rows; then lock batch/items and
affected target rows in their stable orders before reading the closure witness
and reversible/preimage state and finally rechecking those predicates before
commit. The first advisory component is the section 9 posture lock:
rollback takes it shared, while close and transition take it exclusive. The
advisory lock covers a missing-state legacy org where no rollout row exists.
The close action inserts the witness only when no rollback is
in progress and the locked legacy batch has zero frozen target preimages and
zero W4 operation, calculation, or pointer references. If any such durable
reversal evidence or reference exists, closure returns 409 and writes neither
witness nor audit row. Only an eligible closure emits its rollout audit in the
same transaction. A transition does not trust an earlier scan: while holding
the same locks it proves every pre-W4 batch is closed or has a frozen target
preimage. A rollback that sees a closure witness therefore necessarily has no
valid frozen preimage and returns 409 with zero delete/reversal DML. If
rollback wins the lock, close/transition waits and then re-evaluates the
committed batch state; if close/transition wins, rollback cannot use a stale
pre-lock read.

If a legacy batch nevertheless reaches rollback after W4 acceptance, the route returns 409
`IMPORT_ROLLBACK_PREIMAGE_UNAVAILABLE` with zero writes; it never falls back to
DELETE, reconstructs a preimage from the mutable parent, or detaches immutable
children. W4 posture uses an OpenAPI-locked result with exact counts `affected`,
`restored`, and `retired`; it does not call a logical retirement “deleted”.

A current reversal with restore target exposes reversal lineage and reads
segment detail only from that same-record restore target. A retired reversal
has no effective segments and returns explicit retired detail.

### 7.10 Approval reversal and operator retirement

- pending cancellation that never affected calculation writes no calculation;
- approved fact cancellation appends a new calculation from prior frozen
  attribution/evidence in the same transaction as an already allowed
  ledger/request reversal. W4 does not widen the public cancellation-eligibility
  matrix: at the pinned baseline this path is approved leave only. Approved
  overtime, correction, outdoor, shift-swap, and schedule-dispatch requests
  remain non-cancellable and fail before operation/source/shared/result DML
  unless a later RATIFIED contract explicitly adds their compensating effects;
- missing frozen evidence is review/no-parent fail-close, never current-policy
  reconstruction;
- operator cleanup uses `ops_retirement`,
  `outcome=reversed`, `operator_retirement`, and
  `projection_effect=set_retired`; the parent reason is
  `operator_retirement` and ordinary result writers remain blocked;
- direct cleanup is allowed only for non-W4 test fixtures after a guard proves
  zero immutable rows.

## 8. One canonical writer and concurrency contract

### 8.1 Service boundary

```ts
executeAttendanceResultOperation(
  authorization: AuthorizedAttendanceWriteContextV1,
  envelope: AttendanceSourceOperationEnvelopeV1,
): Promise<AttendanceCalculationOperationResultV1>

prepareAttendanceCalculationLocked(
  trx,
  authorization: AuthorizedAttendanceWriteContextV1,
  locked: LockedAttendanceCalculationSourcesV1,
  intent: AttendanceCalculationIntentV1,
): Promise<PreparedAttendanceCalculationV1>

applyPreparedAttendanceCalculationLocked(
  trx,
  authorization: AuthorizedAttendanceWriteContextV1,
  locked: LockedAttendanceCalculationSourcesV1,
  prepared: PreparedAttendanceWritePlanV1,
): Promise<AttendanceCalculationWriteResultV1>

writeAttendanceCalculationsBatch(
  trx,
  authorization: AuthorizedAttendanceWriteContextV1,
  intents: AttendanceCalculationIntentV1[],
): Promise<AttendanceCalculationWriteResultV1[]>
```

`executeAttendanceResultOperation` is the only public write boundary. It first
proves the branded authorization capability covers every envelope item and
rechecks membership/source ownership in SQL. It opens one `SERIALIZABLE`
transaction and performs an authorization-gated, non-locking read of supplied
operation keys in stable order so an all-completed congruent replay can return
with zero DML even under suspension. Any request that cannot return at that
point acquires the org rollout shared advisory lock before it locks or claims
an operation/source row, acquires the canonical exclusive identity advisory
locks for all supplied batch/operation identities, re-reads the operation keys
under those locks, and then resolves rollout posture. A new
`shadow|eligible|authoritative` request claims
all item operations in stable order before invoking closed private adapters
and seals them before commit. A new `legacy_projection_only` request invokes
the same closed adapters and atomic compatibility path. With no supplied stable
ID it creates no operation row; with a supplied stable ID it claims and seals
a compatibility operation in the same transaction so a later cross-posture
retry returns the stored legacy response. Neither legacy form creates an
outbox. Those adapters alone may create/lock the event, request, terminal
approval, batch/item, edit, scheduled-run, or operator source rows and mint
internal intents.

For attendance workflows, that transaction is also the transaction for every
shared approval/assignment/leave/comp-time/overtime ledger effect. Named generic
services expose transaction-bound functions that accept the canonical `trx`;
they neither open, own, commit, nor retry another transaction. An attendance
branch that currently enters a generic service first is inverted: it enters
`executeAttendanceResultOperation`, whose private adapter calls the generic
function with the same `trx`. Non-attendance product callers retain their
existing public generic transaction path. A callback that commits W4 and then
lets a caller-owned approval/ledger transaction commit or fail is forbidden.
Every attendance lifecycle notification required by the existing event
contract for a `shadow|eligible|authoritative` operation is enqueued in the
section 7.1a outbox before the operation is sealed; direct post-commit emit
without a durable row is forbidden in those postures. The closed
`legacy_projection_only` branch retains its existing synchronous/best-effort
emit and creates no outbox row; it creates a compatibility operation only when
the caller supplied a stable operation ID.

`writeAttendanceCalculationsBatch`, prepare, and apply are private to that
transaction. The batch function validates every minted intent against its
claimed envelope item, performs section 8.2, creates a non-serializable
`LockedAttendanceCalculationSourcesV1` witness, calls prepare, and immediately
calls apply. No route-provided intent, source callback, prepared plan, or lock
witness is accepted; no prepared value may cross a transaction.

Prepare owns attribution/context loading from the locked witness,
evidence/fact normalization, frozen merge policy, fingerprints, version
proposal, metrics, statuses, and reasons. Apply owns
version/fingerprint recheck, immutable inserts, pointer/daily projection,
lineage, and existing entrypoint audit state. Apply never
recalculates or merges. In shadow/eligible, the legacy compatibility projection
is also prepared from the same locked inputs and carried by
`projectionDirective=apply_legacy`; there is no call back into the old mutable
writer after prepare.

Bulk import is set-based persistence of the same prepared plan; it has no
alternate result algorithm.

### 8.2 Transaction and lock order

1. begin `SERIALIZABLE`; verify the frozen authorization and normalize the
   envelope, then non-locking-read any existing exact batch/item operation keys
   in stable order; return only an all-completed congruent replay. A missing,
   mixed, incomplete, or non-congruent state cannot continue from this read;
2. acquire the org rollout shared transaction advisory lock before any
   operation/source row lock and retain it through commit. Acquire the section
   9 exclusive identity advisory locks for every non-null batch command and
   item operation identity in one canonical order, then re-read/lock exact
   operation rows in stable order and resolve rollout posture. If suspended,
   stop before operation/source DML;
   for `shadow|eligible|authoritative`, insert/claim all-new batch/item rows and
   reject mixed or non-congruent state. For `legacy_projection_only`, reject
   any conflicting/incomplete existing operation state; claim a compatibility
   operation only for each command carrying a supplied stable ID, and create no
   operation for a null-ID command;
3. run the closed entrypoint adapter: lock/create its source rows, capture any
   `approval_records.id RETURNING` value as evidence, and mint internal intents;
4. run candidate resolution inside the transaction;
5. call the section 9 canonical target helper for every resolved
   `(org,user,workDate)`; it acquires class-`11` final signed keys in numeric
   order, then `SELECT ... FOR UPDATE` each parent in stable target order. If
   absent, recheck under that key and reserve a server UUID in the private
   witness but do not insert a row yet;
6. lock selected assignment/rule/shift parent, ordered segments, calendar, and
   approved facts in stable key order;
7. re-run attribution/context selection from the transaction snapshot and
   require candidate identity plus source-definition fingerprint equality;
8. mint the lock witness, freeze, calculate, and prepare both W4 result and
   required compatibility projection;
9. immediately re-read/re-hash locked sources; mismatch aborts/retries;
10. if the parent was absent, insert it now from the prepared outcome: active
    with the prepared legacy/authoritative projection, or retired
    `review_placeholder`; the unique `(org,user,workDate)` constraint remains
    the final backstop;
11. allocate next version;
12. insert calculation and required segment children;
13. execute the prepared projection directive and pointer change;
14. for `shadow|eligible|authoritative`, append the closed outbox event rows
    required by this source operation; the separate
    `legacy_projection_only` branch has already preserved its existing emit
    behavior and writes no outbox row;
15. for `shadow|eligible|authoritative`, seal operation
    result/fingerprints/response; for `legacy_projection_only`, seal the stored
    legacy response only when a compatibility operation was claimed. In both
    branches update the existing entrypoint-owned audit/batch/request state
    required by the frozen compatibility contract;
16. commit.

Any failure rolls back all steps. Unique record/version is the target
concurrency backstop; operation uniqueness is the corruption backstop after
identity advisory serialization. No table lock is allowed.
Batches sort `(org,user,workDate)` before advisory/row locks. Advisory-hash
collisions may reduce concurrency but cannot weaken correctness. Only SQLSTATE
`40001` and `40P01` receive a bounded whole-transaction retry.

Real-DB tests inject a failure after each approval, assignment, request,
event/import source, leave/comp-time/overtime ledger, calculation, segment,
parent projection, outbox, and operation-seal write. Every case leaves all
participating tables unchanged. A test-only witness records `txid_current()` plus backend PID
at each source/effect/result stage and requires one transaction/connection for
the whole attendance workflow; splitting or nesting the transaction fails.

Every contributing writer must use compatible locks or change a version/hash
seen by the recheck. A real-DB race between calculation and assignment/segment
edit must never commit a mixed snapshot.

Three independent operation-lifecycle mutations are mandatory. Making a new
null-ID legacy request insert or seal an operation must fail a
zero-operation-row leg. Making a stable-ID legacy request skip its compatibility
claim/seal must fail a response-loss test that commits under legacy, transitions
to shadow, retries the same ID, and requires the stored response with zero new
database DML. Making any new `shadow|eligible|authoritative` request skip
claim or seal must fail durable replay and atomicity legs. The presence of the
neighboring outbox or source-row guard is not accepted as the exclusive failure
reason for any mutation. The legacy-to-shadow replay leg snapshots row counts
and content hashes for operation, outbox, audit, source, shared-effect, and
calculation/result tables before retry and requires every snapshot to remain
byte-congruent afterward. Independently mutating replay to update its completed
operation or insert/update an outbox row must make only the corresponding
exclusive assertion fail.

A separate two-connection first-claim test starts with no batch/item operation
row, submits the same authenticated payload and identities concurrently, and
holds the first transaction after identity-lock acquisition. The second waits,
then re-reads and returns the first transaction's stored response when the
first holder commits within `W4_ADVISORY_HELPER_WAIT_MS`. Both callers
succeed with exactly one operation/batch/item set, one source/result effect,
and no surfaced `23505`. A second leg deliberately holds the first transaction
beyond that budget: the waiter receives values-free
`409 ATTENDANCE_OPERATION_IN_PROGRESS`, all source/result/operation row counts
and hashes remain those of the first transaction alone, no `55P03` escapes,
and a later retry returns the stored response. Removing the identity advisory
acquisition, changing one key namespace/tuple, locking only batch or only
items, moving the identity lock after INSERT, or relabeling an unrelated
`55P03` makes an exclusive leg fail; broad retry of unrelated `23505` is
forbidden.

A separate lock-order mutation restores operation-row locking before the
rollout shared advisory lock. A two-connection test with an incomplete stable-ID
operation and a concurrent rollout transition must then fail: the canonical
implementation completes in the common order of rollout, identity advisory,
then operation row without a deadlock or bounded-retry exhaustion, and the
transition's committed posture governs any source DML that follows.

### 8.3 Entrypoint parity

Live, scheduled, three modern import transports, legacy import, integration
sync, request creation/pending edit/intermediate or terminal decision through
the plugin, central legacy route, generic bridge, or verified card action,
correction, leave/overtime, outdoor approval, manual override, recompute,
approval reversal, import rollback, and operator retirement all use section
8.1. A source-only request operation may seal a response without inserting a
calculation, but it still uses operation preflight and immutable request
snapshots. Shift-swap and schedule-dispatch terminal operations are source-only
schedule-fact commands: they use the operation boundary and compatible
context-lock/version protocol but do not fabricate a daily calculation.
Rule preview remains non-authoritative and writes no snapshots.

### 8.4 Source, effect, and result mechanical bypass guard

A generated exact-head inventory starts from every section 4.1 command/route/
worker and records the first source DML, every same-transaction effect DML, and
the result DML. The closed dedicated-table set includes at least
`attendance_events`, `attendance_requests`, request snapshots,
`attendance_import_*`, scheduled-run sources, result edits, operation
batches/items, calculations/segments, and `attendance_records`. The generator
also discovers additional attendance-owned source/effect tables from the call
graph; an unclassified table or new write symbol fails CI.

The initial debt manifest is generated from pinned pre-W4 baseline
`e0defbe26d7f2e1747e74aa908ca710422812bf7`, reviewed and committed as a
docs/data-only first commit before any W4C-0 runtime change. Each entry has an
immutable debt ID, command kind, route/worker, table/verb, first-DML symbol,
shared-hook classification, and owning W4C slice; the artifact records its
canonical content hash. Later CI compares against that pinned artifact and
permits only deletion of a debt ID when its owner slice canonicalizes the path.
Path/symbol renames, table reclassification, or new debt fail; new W4 runtime
DML is valid only in the canonical/migration allowlists below and can never be
bootstrapped into the baseline as “existing”.

Shared tables such as `approval_instances`, `approval_records`,
`approval_assignments`, and leave/comp-time/overtime ledgers cannot be banned
globally because non-attendance products legitimately use them. Their inventory
therefore allowlists only named generic service functions and requires an
attendance workflow/business-key discriminator to enter the canonical W4
operation boundary before any terminal/shared effect DML. Within that boundary,
the named generic function receives the canonical `trx` and returns without
commit. Direct plugin-attendance shared-table DML moves into private command
adapters.
Removing the discriminator/hook or returning before it fails an attendance
approval/ledger positive control; non-attendance approval behavior remains a
separate positive control.

The discriminator is enforced at every current terminal body, not only in the
plugin: legacy `/api/approvals/:id/approve|reject`, generic
`/api/approvals/:id/actions` through `ApprovalBridgeService`, any
approval-card action capable of resolving an attendance instance, and the
attendance plugin decision routes. An attendance instance cannot be committed
terminal by a generic body and reconciled later. Before terminal shared-table
DML, the body must either enter the same canonical attendance transaction or
return the closed fail-closed response. The canonical transition locks
`approval_instances`, requires the expected pending status/version, and seals
operation replay with the exact terminal response. A later decision body
therefore returns a congruent completed replay or a conflict and never applies
attendance effects a second time.

The CI guard parses/scans every runtime root, generated SQL, migrations, and
operator scripts for INSERT/UPDATE/DELETE/TRUNCATE/MERGE, `COPY FROM|TO`,
raw-client copy streams, and staging-table CREATE/DROP/ALTER, including
templates, strings, VALUES, UNNEST, staging INSERT-SELECT, CTE DML, renamed
wrappers, and cleanup SQL. Paths come from workspace/package manifests, not a
handwritten plugin directory. Production DML is allowlisted only inside:

- the canonical operation boundary's private source/effect/result adapters;
- named shared generic functions with the mandatory attendance hook;
- W4 forward migrations/backfills; and
- fixtures that first prove zero operation/snapshot/calculation history.

Operational import state is separately classified rather than swept into
calculation authority: prepare/preview tokens, async job bookkeeping,
template preferences, upload-file lifecycle, and session-local temporary
staging have named owners and allowlists. They cannot mint evidence, satisfy
promotion, identify a business operation, or authorize rollback. A path that
does become a business source or shared effect must enter the canonical
operation boundary before its first such DML; renaming it “operational” cannot
evade the generated call-path test.

For every source command, a generated route-to-first-DML test records operation
claim and suspension-preflight witnesses and asserts both precede that first
DML. Moving request create/edit/decision/cancel, outdoor event, import,
integration, scheduled, manual, rollback, or operator source/effect DML ahead
of either witness fails. Each syntax/table class has a positive-control fixture,
including deliberate plugin, `packages/core-backend/src`, shared-approval, and
operator-script bypasses. Dedicated positive controls move each current
attendance import `COPY FROM STDIN` before operation/suspension preflight and
attempt a raw COPY into a W4 authoritative table; both must fail the guard.

## 9. Rollout state machine

Create org-keyed rollout state and append-only rollout events:

```text
legacy <-> shadow <-> eligible -> authoritative <-> suspended
```

State row fields: org, closed state, engine version, closed reason code, actor,
timestamp, optimistic lock version, prior state, and
`scope='synthetic_staging'`. Legal transitions are
`legacy->shadow`, `shadow->eligible|legacy`,
`eligible->authoritative|shadow`, `authoritative->suspended`, and
`suspended->authoritative`.

Pre-W4 import rollback-window closure is not inferred from time and is not a
mutable field on this state row. It is the append-only per-batch witness defined
in section 7.9. Rollback, closure, and every transition share that section's
complete org-rollout, rollout-state-if-written, operation-identity advisory,
operation-row, batch/item, then target lock order and final in-transaction
recheck.

W4C-0 exports exactly one key builder and one acquisition helper:

```ts
buildAttendanceCalculationRolloutAdvisoryKey(
  orgId: CanonicalAttendanceOrgKeyV1,
): bigint
acquireAttendanceCalculationRolloutLock(
  trx,
  orgId: CanonicalAttendanceOrgKeyV1,
  mode: 'shared' | 'exclusive',
): Promise<void>
```

The builder parses `orgId` through `CanonicalAttendanceOrgKeyV1`, then reads
the first eight bytes of
`SHA-256("metasheet2:attendance:segment-rollout:v1\0" + canonicalOrgId)` as
unsigned big-endian `u64`, clears the top two bits with
`u64 & 0x3fffffffffffffff`, and uses that signed bigint with prefix bits `00`
as the rollout key. The acquisition helper is the only place allowed to select
`pg_advisory_xact_lock_shared($1::bigint)` versus
`pg_advisory_xact_lock($1::bigint)`. Source, rollback, transition, and closure
all import it; there is no copied namespace, local hash, try-lock, swallowed
error, timeout-to-continue, or row-lock fallback. Collision may reduce
concurrency but cannot weaken correctness. This `00` class is disjoint from
operation class `10` and target class `11` below, so a source never attempts
an exclusive upgrade of the rollout key it already holds shared. Prefix `01`
is reserved and forbidden in W4.

W4C-0 also exports the only operation-identity key builder and acquisition
helper:

```ts
type AttendanceResultOperationIdentityV1 = Readonly<{
  kind: 'batch' | 'item'
  orgId: CanonicalAttendanceOrgKeyV1
  entrypoint: AttendanceSourceEntrypointV1
  id: CanonicalAttendanceOperationIdV1
}>

buildAttendanceResultOperationAdvisoryKey(
  identity: AttendanceResultOperationIdentityV1,
): bigint

acquireAttendanceResultOperationLocks(
  trx,
  identities: readonly AttendanceResultOperationIdentityV1[],
): Promise<void>
```

The builder parses `orgId` through `CanonicalAttendanceOrgKeyV1` and `id`
through the canonical UUID parser in section 4, validates `entrypoint` against
the closed command union, and rejects an ID whose entrypoint requires a
different UUID source/derivation contract.
It hashes the unambiguous NUL-separated tuple
`"metasheet2:attendance:result-operation:v1\0" + kind + "\0" + orgId +
"\0" + entrypoint + "\0" + id` with SHA-256. It reads the first eight bytes as
unsigned big-endian `u64`, keeps only the low 62 bits, sets prefix bits `10`
with `(u64 & 0x3fffffffffffffff) | 0x8000000000000000`, and interprets the
result as signed two's-complement bigint. The acquisition helper
canonicalizes identities, derives their final signed keys, de-duplicates by
final key, sorts those signed bigint keys numerically, and obtains an exclusive
`pg_advisory_xact_lock($1::bigint)` in that order. It never sorts merely by the
pre-hash tuple. A collision serializes unrelated identities but cannot reverse
lock order; two identities colliding to one final key require one acquisition.
Invalid identity, key derivation, or SQL failure aborts the whole transaction;
there is no copied namespace, local sort, try-lock, swallowed error,
timeout-to-continue, row-lock fallback, or generic `23505` retry.

W4C-0 also exports the only target-key builder and acquisition helper:

```ts
type AttendanceCalculationTargetIdentityV1 = Readonly<{
  orgId: CanonicalAttendanceOrgKeyV1
  userId: CanonicalAttendanceUserIdV1
  workDate: CanonicalAttendanceWorkDateV1
}>

buildAttendanceCalculationTargetAdvisoryKey(
  identity: AttendanceCalculationTargetIdentityV1,
): bigint

acquireAttendanceCalculationTargetLocks(
  trx,
  identities: readonly AttendanceCalculationTargetIdentityV1[],
): Promise<void>
```

The builder strict-parses the branded org/user/work-date tuple, hashes
`"metasheet2:attendance:calculation-target:v1\0" + orgId + "\0" + userId +
"\0" + workDate`, keeps only the low 62 digest bits, sets prefix bits `11`
with `(u64 & 0x3fffffffffffffff) | 0xc000000000000000`, and interprets the
result as signed two's-complement bigint. The helper de-duplicates and sorts
final signed keys numerically before exclusive transaction advisory
acquisition. Every source, rollback, recompute, and retirement path imports
this helper before its target parent row; no local target hash or legacy
advisory helper remains reachable in W4.

A module-private digest seam exists only in the real-DB test build. It forces
two distinct identities onto crossed raw digest outputs and proves both
transactions still acquire final signed keys in the same numeric order; it
forces two identities onto one final key and proves one acquisition; and it
forces equal raw eight-byte digests for rollout, operation, and target builders
and proves the two-bit classes keep all three PostgreSQL keys distinct.
Production construction cannot inject or replace the SHA-256 implementation.
Mutating any class prefix, admitting reserved class `01`, sorting before
derivation, omitting final-key de-duplication, or exposing the test seam to
production makes an exact gate fail.

That stable org rollout advisory key has shared/exclusive transaction modes.
Every new source/result transaction, including null-ID legacy work, acquires it
shared before locking operation/source rows or resolving posture and holds it
through commit. Rollback also takes it shared before operation-identity/
operation-row/batch/target locks. Transition and rollback-window closure take
it exclusive before locking
the rollout state row where present, operation-identity advisory keys,
operation rows, batch/items, or targets.
Completed
congruent replay may return from an authorization-gated non-locking read before
this lock because it performs zero source/result DML. Any non-returning read is
discarded and repeated under the shared lock; no row lock survives across that
acquisition. The advisory key, rather than existence of a rollout row, covers a
legacy org with no persisted state. This freezes accepted posture without
serializing ordinary same-org source writes against one another.

After that org rollout lock and any rollout-state row changed by the
transaction, every path that can first-claim or race a supplied batch/operation
identity calls `acquireAttendanceResultOperationLocks` before reading with a
row lock or inserting an operation/batch row. Existing and missing identities
therefore share one protocol. A non-locking replay/discovery read may collect
candidate identities but confers no authority; after identity-lock acquisition
the path must re-read the exact rows and reject any set/fingerprint drift.
Null-ID legacy work has no operation identity lock. Completed congruent replay
is the only path allowed to return before both advisory protocols, and it
performs zero DML.

For an import source and rollback of the same batch, the complete common order
after the shared rollout lock is: all current/original batch and item operation
identities through the canonical exclusive identity advisory helper in final
signed-bigint numeric order; their operation rows in stable
`(entrypoint,operation_id,item_key)` order; the import batch and item rows in
stable ID order; then affected `(org,user,workDate)` target advisory/parent rows
in the section 8.2 order. The source must recheck that the batch remains writable
immediately before its source DML. Rollback must recheck the locked batch
fingerprint, item set, closure, reversal/preimage, and W4 references immediately
before reversal DML. If source commits first, rollback waits and evaluates that
committed item set; if rollback commits first, source waits and fails before new
source/result DML. No path may take an operation row, batch, or target before
the relevant identity advisory locks, or upgrade the shared rollout lock.

One async `resolveSegmentCalculationPosture(trx,orgId)` is the sole truth for
calculator mode, shift capability output, single/sequence reference guards,
conversion/deletion guards, and rollout commands. It combines implementation
capability, an exact org-only outer allowlist, persisted state, scope, and legal
transition. W4 removes the synchronous environment-only
`isSegmentCalculationEnabled` decision from every production caller.
`*`, missing state, `legacy`, or `suspended` never advertises or permits
authoritative calculation. During W4, reference writers may accept
multi-segment shifts in `shadow|eligible|authoritative` only for the exact
named synthetic-staging org; any production scope remains separately gated.

Its return shape and values are closed:

| Effective state | write posture | author segments | reference segments | authoritative results | convert referenced shift | delete unreferenced shift |
| --- | --- | --- | --- | --- | --- | --- |
| missing / wildcard-only / `legacy` | `legacy_projection_only` | yes, preview | no | no | no | yes |
| `shadow` synthetic | `shadow` | yes | yes | no | yes | yes |
| `eligible` synthetic | `shadow` | yes | yes | no | yes | yes |
| `authoritative` synthetic | `authoritative` | yes | yes | yes | yes | yes |
| `suspended` | `blocked` | no | no | no | no | no |

Deletion still requires the canonical historical/reference-blocker scan;
“delete unreferenced” never bypasses it. Capability DTO, conversion, delete,
and the exact-head generated inventory of all single/sequence reference guards
consume this one returned object. Removing any consumer call or deriving a
second boolean fails.

Effective state requires:

1. implementation capability present;
2. exact org in the outer allowlist;
3. persisted org state;
4. legal transition;
5. transition to `eligible` or `authoritative` has zero pending
   calculation-affecting request whose latest immutable snapshot is anything
   other than `resolved_v2`, whose snapshot payload fingerprint differs from
   the locked current request allowlist, or whose terminal/reversal linkage is
   incomplete. Merely having an `unsupported` snapshot never clears the gate;
6. transition to `eligible` or `authoritative` has zero active/reversible
   legacy request fact referenced by the synthetic source set and zero
   `claimed|paused` operation/batch/job accepted in a different posture.
   Operators complete or cancel-before-source under legacy/shadow semantics;
   W4 never backfills from mutable current config and never rebases an accepted
   operation posture; and
7. every pre-W4 import batch in the synthetic source set either has the
   append-only rollback-closure witness from section 7.9 or has an immutable
   target-level preimage created by a separately audited
   migration/reconciliation protocol. Wall-clock age alone never proves the
   window closed. A reversible legacy batch with neither proof blocks
   transition rather than inheriting the destructive rollback route; and
8. transition to `eligible` or `authoritative` has zero unresolved
   `legacy_time_ingress_not_authoritative` review in the synthetic source set.
   Clients must first send strictly zoned replacement evidence or resolve the
   item through a separately RATIFIED correction path; the legacy-resolved
   instant itself is never promoted.

Wildcard org is forbidden for W4 staging.

| State | Behavior |
| --- | --- |
| legacy | Existing behavior; no W4 immutable write required. |
| shadow | Legacy projection current; append W4 shadow result/diff. |
| eligible | Same runtime as shadow; org rollout event stores exact promotion evidence. No per-record eligibility is implied. |
| authoritative | Completed W4 result updates pointer/projection. |
| suspended | History readable; every new result-producing write fails 503 with zero calculation/projection write. |

An already completed, newly reauthorized, fully congruent idempotent replay is
not a new result-producing write and returns its stored response under
`suspended`. It is recognized only by the operation-table preflight in section
8.2 and performs zero source/result DML. Missing, paused, incomplete, or
conflicting keys are not replay and remain blocked.

Promotion drains or cancels every incomplete org operation before changing
posture. `authoritative->suspended` may pause a durable queued operation only
when its accepted posture is already authoritative and its source identity is
complete. `suspended->authoritative` admits only that same-posture paused set
after the offline replay; any shadow/eligible/unknown accepted posture blocks
resume and must be canceled before source; if source already exists, resume
fails for explicit operator remediation under a separately reviewed protocol.
No transition mutates `accepted_posture`.

Suspension records prior state and exact reason/engine/evidence in its
append-only event. Suspension is not rollback. It preserves pointers/history
and has no automatic
legacy fallback, including single-segment fallback. Raw input survives only
when a pre-existing independently durable/idempotent input contract had already
committed before the worker observed suspension. Synchronous live, approval,
import, manual, recompute, and operator routes check suspension before writing
events, requests, batch state, approval terminal state, or other source rows
and return 503 with zero writes. An already-durable queued job remains
retryable/paused with the closed suspension code and writes no result. Resume
requires owner incident review, compatible engine version, and an offline
read-only shadow replay of the suspended source set with zero
critical/unresolved diffs. That replay writes no operation, calculation,
projection, pointer, or rollout transition row; its signed artifact is attached
to the resume event.
Because the parent projection remains W4-owned while suspended, resume returns
to the prior authoritative state; it does not switch the mutable parent back to
legacy. The first post-resume result is authoritative and supersedes the
preserved pointer atomically.

Named synthetic staging requires exact image SHA, zero pending migrations,
health, no customer data, no external notification, every entrypoint, minimum
observation threshold, zero critical diff, a zero legacy-request backlog report
covering pending and still-reversible approved facts, suspend/resume, reversal,
and residue/hash proof. It is not customer acceptance.

## 10. Shadow and explanation contracts

### 10.1 Shadow diff

Closed code set:

```text
equal
expected_break_exclusion
status_changed
work_minutes_mismatch
late_minutes_mismatch
early_leave_minutes_mismatch
missing_boundary_mismatch
work_date_mismatch
context_mismatch
input_mismatch
review_required
legacy_uncomparable
```

Exact values-free diff fields: schema version, code, changed field-name array,
absolute minute delta, segment count. No user, punch, request, shift, or group
ID appears in rollout summaries. Work-date/context/input/review differences are
critical and block eligibility.

### 10.2 Dual-host detail

```text
GET /api/attendance-admin/records/{recordId}/calculation-detail
GET /api/attendance/records/{recordId}/calculation-detail
```

Optional calculation ID selects history; absence uses current pointer.

- admin: attendance admin plus active delegated org membership; record and org
  predicates stay in SQL;
- self: attendance read; rejects user ID input; subject comes only from token;
  active org membership resolves before detail SQL; every query includes
  record/org/subject;
- platform-admin override, if retained, remains explicit and does not remove
  org predicates;
- missing, cross-user, and cross-org share not-found shape.

Top-level response keys are exactly `recordId`, `calculation`, `segments`,
`current`. No raw user/request IDs or arbitrary snapshot JSON is returned.

Legacy record with no pointer returns 200, `calculation=null`, empty segments,
and a `current` object containing `projectionOwner=legacy_untracked`, its exact
visibility, and `posture=undeterminable`; it does not fabricate segments. Reversal
restore/retired behavior follows section 7.

Unknown persisted enum/schema fails `CALCULATION_SCHEMA_UNSUPPORTED`.

### 10.3 Decision trace

In authoritative orgs, today-status/late-early/missing-punch trace reads current
immutable W4 evidence. It cannot reconstruct from mutable meta, current
schedule/rule/group, V1 attribution, current request state, or first/last alone.
Unsupported evidence returns values-free
`undeterminable/frozen_evidence_unavailable`. Shadow trace is labeled shadow and
never presented as the decision that produced the legacy current row.

## 11. Migration, retention, and performance

Forward migration creates operation-batch/item/request-snapshot/calculation/
segment/outbox/rollout tables, the append-only import rollback-closure table,
current-record view, triggers, deferred constraints,
pointer/owner/visibility/reason fields, indexes, and FKs. It does not fabricate
historical segments, rollback closures, or baselines. Existing rows remain
legacy-untracked. Fresh/upgrade/replay must pass.

Down first proves zero operation batches/items, request snapshots,
calculations, segments, outbox rows, rollout events, rollback-closure
witnesses, and pointers. Any row aborts before DDL. It does not clear history
to make down pass.

W4 adds no purge. History lives at least as long as parent/payroll/audit
retention; parent deletion is blocked by RESTRICT. Future retention must honor
legal hold, current pointer, reversal chain, and org isolation.

Representative synthetic `EXPLAIN` evidence is required for current/historical
detail, source-batch reversal, and shadow backlog. Retry only
serialization/deadlock at the transaction boundary with bounded attempts.

## 12. Implementation slices and completion gates

Each slice is a separate fresh-main PR, predecessor merged first, independent
adversarial review 0 P1/P2, exact-head tests/mutations, and no runtime org
enablement unless section 12.8 explicitly receives owner authorization.
Every cut-over slice proves its newly covered entrypoints in
`legacy_projection_only` retain flag-OFF response/projection bytes, use the
canonical boundary, and insert no W4 calculation or outbox row. A null-ID
legacy command inserts no operation row; a stable-ID legacy command inserts
only its compatibility operation and no W4 result pointer.

### 12.1 W4C-0: contracts and durable storage

Deliver durable batch/item operation registries, immutable request snapshots,
calculation/baseline/segment/outbox tables, immutable import rollback-closure
witnesses, types, validators, triggers, pointer/owner/visibility/reason
constraints, rollout state, and canonical authorization/write/enqueue
interfaces with no caller cutover.

Gates:

- fresh/upgrade/replay-safe DB;
- down empty success and populated pre-DDL failure;
- immutable-table UPDATE/DELETE/TRUNCATE refusal; operation/batch
  DELETE/TRUNCATE/cascade refusal, illegal state-transition refusal, and
  completed-response/fingerprint immutability;
- no source disables triggers after data exists;
- cross-org pointer and cross-record/org lineage refusal;
- same-org shadow/review pointer and pointer/state mismatch refusal;
- direct active daily-field drift and authoritative pointer clearing refusal;
- operation same-key/same-payload replay and every different-payload/source/
  subject conflict;
- atomic batch replay is all-existing or all-new; a reused batch command ID
  with a changed ordered item-sequence hash, item-set hash/count, mixed item
  state, missing item, reordered input, or one batch ID reused as multiple
  calculation operation IDs fails;
- two concurrent first claims of the same single operation and of the same
  all-new batch return the one stored response with exactly one source/result
  effect when the first holder commits within the lock budget; a holder beyond
  that budget makes the waiter return values-free
  `409 ATTENDANCE_OPERATION_IN_PROGRESS` with zero extra DML, and its later
  retry returns the stored response. Neither path surfaces `23505|55P03`;
  removing the canonical operation-identity advisory lock, locking only the
  batch or only its items, changing one identity tuple, moving acquisition
  after INSERT, or broadly relabeling another `55P03` fails an exclusive
  two-connection leg;
- a multi-key deadline leg blocks the helper's first final key for less than
  five seconds and its second key long enough that cumulative wait exceeds
  five seconds. It must return the exact operation/target busy code within the
  one helper budget, roll back with zero DML, and succeed or replay after the
  blockers release. Resetting the deadline per key, omitting the
  post-acquisition check, using wall-clock time, failing to restore the normal
  lock timeout after success, or exposing the test clock to production fails
  independently;
- item/target limit, lock/statement timeout, and retry constants are one
  exported contract; above-limit W4 commands fail before source DML, and
  authoritative mode cannot fall back to chunked/partial legacy commits;
- outbox identity/payload is immutable; invalid event kind/key set, duplicate
  operation event, illegal delivery transition, and down-with-row all fail;
- rollback-closure identity/evidence is immutable; duplicate close is
  idempotent only when byte-congruent, while conflicting actor/reason/batch
  fingerprint returns 409 and UPDATE/DELETE/TRUNCATE/cascade all fail;
- closure of a batch with any frozen target preimage or W4
  operation/calculation/pointer reference returns 409 and inserts neither
  closure witness nor audit event; removing each eligibility predicate fails
  its own leg;
- org rollout advisory shared/exclusive behavior is proven with two
  connections: a null-ID legacy source holding the shared lock makes
  transition wait and re-evaluate after its commit, while transition holding
  exclusive makes the source resolve the new posture after release. Removing
  either acquisition permits an old-posture commit and fails;
- all four lock users import
  `acquireAttendanceCalculationRolloutLock`; mutating any one caller's
  namespace/key derivation or swallowing the helper's SQL error fails its own
  cross-connection leg before source/rollback/transition/closure DML;
- every first-claiming command imports
  `acquireAttendanceResultOperationLocks`; mutation of identity normalization,
  namespace, rollout/operation/target two-bit class partition, final-key
  de-duplication, signed-bigint numeric sort, SQL error propagation, or any
  batch/item caller fails before unique-row/source/result DML. Every target
  writer imports `acquireAttendanceCalculationTargetLocks`; restoring a local
  target hash or taking a target before operation/batch locks fails. A
  test-only digest seam forces crossed final-key order, same-key collisions,
  and equal rollout/operation/target raw digests; production construction
  cannot inject it and class `01` is never acquired. Helper-origin rollout and
  target lock timeouts map to their exact values-free 503 codes with zero DML;
  relabeling another query's `55P03` fails;
- direct, verified-channel, import, integration, and scheduled identity tests
  pin the section 4 UUID parser, three namespace constants, UUIDv5 name bytes,
  and exact lowercase output. Uppercase ASCII UUID input must produce the same
  identity/key. Whitespace, braces, URN, Unicode lookalikes, NUL, overlength,
  malformed ordinal/date/fingerprint, and tuple-boundary mutations fail before
  operation/source DML. An exact `default` org key succeeds only for a legacy
  compatibility command and fails for every W4-enabled posture; changing
  either leg fails independently;
- an incomplete stable-ID operation versus rollout transition proves the common
  rollout-then-operation-identity-advisory-then-operation-row lock order
  completes without deadlock or bounded-retry exhaustion; moving either
  operation lock ahead of the shared rollout lock fails this leg;
- source versus rollback on the same import batch is run in both barrier
  orders. Source-first makes rollback recheck the committed item set before any
  reversal, while rollback-first makes source fail before new source/result
  DML. Reversing identity-advisory/operation-row/batch/target lock order or
  deleting either final recheck fails independently;
- replay under a different actor/token subject or after authorization revocation
  cannot read the stored response;
- approval decision operation identity is claimed before terminal state/record
  DML; using returned `approval_records.id` as the retry key fails;
- request snapshot edit and A -> B -> A reversion append versions; mutable
  substitution fails;
- plain-object/spread/JSON-cloned authorization witnesses and mutation of the
  original post-mint org/capability/scope/nested user array fail runtime
  verification;
- pending-activation, inactive-user, inactive-membership, and
  deprovision-between-mint-and-use legs fail before source/result DML;
- mutating the original command or batch items after boundary entry, replacing
  their prototype, or changing a nested value after fingerprinting cannot alter
  adapter input or operation congruence;
- strict source-command validators cover every table in section 4.1; request
  create/edit operation-ID fields are accepted but no route is cut over;
- the collector generates an exact-head source/effect/result debt inventory
  naming every current command route, worker/recovery body, cron/admin
  initiator, first DML, shared-table hook, privileged/tooling path, and planned
  canonical adapter. The initial set contains P01-P26 from section 1.1; its
  immutable debt IDs/content hash are generated from pinned baseline
  `e0defbe26...` before runtime changes. W4C-0 proves
  collection/positive controls and fails new, renamed, or unclassified DML;
  existing debt entries are removed only by their owning later slices;
- legacy baseline is restore-only and never inferred from first/last;
- retry idempotency and strictly-older lineage refusal;
- deferred parent-and-child triggers reject incomplete or extra direct children
  at commit;
- failure after calculation insert leaves no child/pointer/projection;
- suite is DB-excluded from no-DB run and explicitly named in CI.

### 12.2 W4C-1: pure calculator

Deliver strict timezone conversion, cells, duplicate posture, status/reasons,
daily aggregate, semantic/provenance/source fingerprints, and pure merge policy.

Gates cover 1/2/3 segments, overnight, breaks, every status, midpoint ties,
out-of-window/unmatched/duplicate/ambiguous/reversed evidence, cross-segment
actual-interval overlap, DST including the shared-fold-boundary review,
full/partial leave, overtime with/without punch, current merge-policy branches,
CSV/XLSX fingerprint split, and mutations
for envelope arithmetic, payable-interval intersection removal, cross-break
counting, unapproved early/late extension, duplicate collapse, midpoint side,
UTC fallback, fold choice, out-of-window ignore, non-positive or
cross-segment-overlapping actual span, per-segment/double rounding, omitted
late-tier thresholds, unknown enum, approved-fact omission, business-time
omission, and current-context reread.
Changing only `occurredAt` on an otherwise identical evidence ref must change
the semantic hash.
Invalid or missing IANA zones, every legacy helper-level UTC fallback, and
offset-less values that would otherwise use server-local time cannot enter a
completed W4 calculation. Pure-calculator tests reject them. The W4C-2
entrypoint matrix separately proves legacy byte compatibility, shadow legacy
success plus `legacy_time_ingress_not_authoritative` review, and
eligible/authoritative rejection before source/result DML. Default-rule and
shift timezone writes use the same strict IANA validator; a persisted invalid
zone is never accepted as a future calculation input.

### 12.3 W4C-2: live and scheduled shadow

Deliver live canonical writer, remove scheduled direct insert, freeze W2/context,
and atomically keep legacy projection plus shadow result.

Gates:

- fresh W2 ambiguity creates no parent/result; existing parent may append only
  unsupported review with zero children/no pointer;
- fresh authoritative calculator review creates only a retired
  `review_placeholder`: ordinary reads return no row, history returns the
  review, and no default `normal`/zero-minute projection is visible;
- V1/missing/ambiguous/unresolved cannot cast to V2;
- V2 freezes absolute/attribution windows; changing tail/overtime/assignment
  after request creation or prior calculation does not move them;
- same-org other-user and cross-org isolation;
- forged authorization witness, self user override, wrong scheduler capability,
  and inactive membership fail before source/result SQL;
- live `operationId` response-loss/network/outdoor-note retry returns one event
  or request and one result; same key/different evidence returns 409;
- web decision UUID and verified channel action identity replay one terminal
  approval/fact/result; a response-only approval-record ID mutation fails;
- durable scheduled-run replay survives process restart and `skipDedup` cannot
  bypass it;
- live/scheduled outbox rows are inserted before operation seal; crash after
  commit/before emit, dispatcher restart, concurrent dispatcher, and emit
  failure eventually deliver without repeating source/result DML;
- the same live/scheduled entrypoints in `legacy_projection_only` retain their
  existing synchronous/best-effort emit behavior and create no operation,
  calculation, or outbox row; removing either side of this posture split fails
  independently;
- P01 live, P02 merge second-pass, P03 cron absence, and P04 administrator-run
  absence inventory entries are removed independently; claim and suspension
  witnesses precede each first source DML under call-order mutation;
- mutating either absence initiator to bypass the canonical writer, or restoring
  the P02 post-upsert mutation, fails its own positive-control leg;
- scheduled direct-insert mutation fails DML guard;
- calculation-group read mutation fails;
- wildcard/missing/legacy/suspended posture cannot enable capability,
  calculator, or reference writers; removing any one shared resolver call
  fails;
- shadow/eligible promotion is blocked by every claimed/paused operation or
  queued job; accepted posture is immutable and cannot be silently rebased;
- a newly authorized congruent completed replay returns its stored response
  under suspension with zero DML; missing/conflicting/incomplete operation
  state returns suspension/conflict and writes nothing;
- concurrent assignment/segment edit cannot mix fingerprint;
- shadow uses the prepared legacy projection; re-entering the old writer after
  prepare fails a mutation;
- a W4 review outcome still applies the exact prepared legacy projection in
  shadow; duplicate/DST review cannot make flag-OFF projection stale;
- an offset-less or otherwise legacy-only business time has a three-posture
  matrix: `legacy_projection_only` preserves exact current response/projection
  with no W4 row; effective `shadow` preserves that response/projection and
  appends exactly one zero-segment/no-pointer
  `legacy_time_ingress_not_authoritative` review carrying raw plus
  legacy-parser provenance; effective `eligible|authoritative` rejects before
  event/request/result/effect DML. Treating the legacy-resolved instant as W4
  evidence, omitting the shadow review, or rejecting the shadow legacy write
  fails independently;
- flag/state OFF externally preserves legacy projection/response bytes; shadow
  DB evidence exists only in shadow/eligible.

### 12.4 W4C-3a: import, integration, and rollback

Deliver all three modern import transports, legacy import, integration sync,
semantic/provenance parity, and append-only rollback.

Gates:

- values/unnest/staging produce identical prepared results, projections, and
  reversal chains;
- duplicate batch items resolving to one `(org,user,workDate)` fold in input
  order into one prepared target calculation; rollback restores the one frozen
  pre-batch parent tuple, not a batch-internal predecessor;
- native CSV/equivalent XLSX semantic same, provenance distinct;
- integration/legacy import same canonical W4 semantic row result; their
  current compatibility projections are snapshotted separately, so the
  integration path's missing rule-engine/group-sync work cannot be silently
  presented as modern-import parity;
- exact-presence imported metrics and frozen legacy policy/rule-engine output
  are snapshotted. Congruent values may proceed; mismatch or insufficient
  boundary evidence yields `import_metric_conflict` review and blocks
  promotion. Dropping, zero-filling, or letting an imported metric override the
  canonical segment result fails;
- exactly 5000 items/targets is accepted under the transaction benchmark;
  5001 fails before batch/item/staging COPY DML. Authoritative mode never
  chunks or partially commits an over-limit batch, and shadow's explicit
  limit-bypass evidence never counts toward promotion;
- first-import rollback retires; update import restores;
- first-import reversal stores the exact imported after-image as its non-null
  historical projection, carries an explicit absent preimage, is
  `retired/effective=false`, and cannot synthesize zero/null defaults;
- rollback of a reactivated import tombstone or review placeholder restores its
  exact retired owner/pointer/visibility/reason tuple and never forces active;
- shadow first/update rollback applies frozen absent/existing compatibility
  preimage and leaves no imported ordinary projection visible;
- a reversible pre-W4 batch without immutable target preimages blocks W4
  transition and, if presented to a W4 rollback route, returns
  `IMPORT_ROLLBACK_PREIMAGE_UNAVAILABLE` with zero parent/calculation/history
  writes; the legacy DELETE path cannot be selected;
- a later valid non-rollback source reactivates an import-rollback tombstone
  from durable evidence only; hidden imported/default fields are never inferred;
- later punch/correction blocks entire batch 409;
- shadow reversal leaves pointer;
- repeat idempotent;
- Nth-row failure rolls back whole batch;
- source/import item/result/operation seal share one transaction ID; injected
  failure at any stage leaves zero batch effect;
- P23 rollback rechecks the frozen batch owner/delegated scope with the
  commit-equivalent authorization matrix before operation claim; same-org
  other-importer, wrong-group, inactive membership, and cross-org attempts
  produce the closed not-found/forbidden shape with zero reversal DML;
- legacy rollback, append-only rollback-window closure, and rollout transition
  acquire section 9's complete org-rollout, rollout-state-if-written,
  operation-identity advisory, operation-row, batch/item, then target lock
  order in one `SERIALIZABLE` transaction and recheck at commit. For a legacy
  batch closed without preimage, dual-connection tests
  prove both race orders:
  closure/transition first makes rollback return 409 with zero
  delete/reversal DML; rollback first makes closure/transition wait and then
  re-evaluate. A separate frozen-preimage leg proves that transition does not
  disable its W4 reversal path: closure is first rejected with no witness/audit,
  transition then succeeds, and W4 reversal restores the frozen preimage.
  Removing the closure eligibility check, witness, common lock, or final
  recheck fails independently;
- same-batch source/rollback concurrency runs in both commit orders under the
  shared rollout lock and common operation-identity-advisory/operation-row/
  batch/target order. Exactly one side establishes the next valid state; the
  waiter rechecks and performs zero conflicting source/reversal DML. Removing
  either recheck or reversing one path's lock order fails independently;
- P24 integration dry-run may append only its audit attempt. It cannot create
  an import batch/result, change a current pointer, or update `last_sync_at`;
  real sync freezes its compatibility pipeline and uses the canonical W4
  calculator;
- P25 operational import tables/files are explicitly classified and cannot
  supply business evidence, operation identity, promotion success, or rollback
  authority;
- legacy import has durable batch/item identities before shadow;
- P06 synchronous modern transport, P07 async worker, P08 restart recovery, P09
  legacy import, P10 integration sync, P11 rollback, and P23-P25 authorization/
  integration/operational classifications are removed independently;
  batch/item claims and suspension witnesses precede import job/batch/item and
  integration business source/effect DML;
- sync/worker/recovery parity is proven against the same prepared batch and the
  async operation replay is proven across process restart; deleting any one
  execution-body adapter or routing recovery around it fails its own leg;
- records, payroll/summary, report sync/digest, reminder, anomalies, makeup
  facts, open-record attribution, DecisionTrace, comprehensive-hours,
  integration, and export all hide retired rows while history detail shows
  them;
- delete/cascade and omitted-transport mutations fail.

### 12.5 W4C-3b: approval, correction, outdoor, cancellation

Deliver canonical correction, leave/overtime, outdoor first-record path, frozen
request context, and approval reversal.

Gates:

- first record cannot become authoritative without request-time V2/context;
- pre-W4 request cannot upgrade from current config; shadow may complete its
  exact legacy terminal action plus unsupported W4 review, while authoritative
  promotion and terminal action are blocked until the legacy backlog is zero;
- promotion requires every pending calculation-affecting request's latest
  snapshot to be `resolved_v2`, payload-congruent with the locked request, and
  terminal/reversal-link complete; an immutable `unsupported` snapshot does not
  satisfy the gate;
- request creation and each pending edit append immutable request snapshots;
  terminal approval binds exact snapshot version/hash and returned approval
  record ID;
- request create/edit/decision/cancel/outdoor route inventory entries are
  removed; operation claim/suspension precede first request, event, approval,
  assignment, and attendance-ledger DML;
- P26 central assignment-mutation inventory is generated from the actual
  generic action union plus every assignment-DML call site. It names bulk
  reassign, non-terminal `approve` advancement, `return`, `revoke`, jump,
  transfer, add/reduce-sign, timeout, and future additions. Each action tests
  both a normal attendance instance and an adversarial attendance instance
  carrying `published_definition_id`; route selection by that field cannot
  prove attendance unreachable;
- central bulk reassignment identifies an attendance instance from the exact
  workflow key plus locked request join before assignment DML. For an
  attendance instance, the actor is either the verified platform-admin
  override or an active member of the locked request org holding both
  `approvals:admin` and the closed attendance-admin posture; the target is
  active, activated, and an active member of that same org. Caller org,
  requester/subject JSON alone, and global target activity cannot authorize
  the mutation. Unauthorized explicit IDs use the same not-found shape, while
  discovery excludes unauthorized attendance rows;
- attendance reassignment locks the approval instance, request, current-node
  source assignments, and target membership; it validates pending/current-node
  state, preserves the source assignment epoch, increments
  `approval_instances.version`, and appends the existing reassign audit in one
  transaction. A decision with the old version and a reassign racing a locked
  decision cannot both succeed. Independent legs cover same-org success,
  inactive/deprovisioned/non-member target, org-local actor missing either
  permission, platform-admin override, same-ID not-found, and two-org spoof;
- generic non-terminal `approve` advancement, `return`, `revoke`, admin jump,
  transfer, add/reduce-sign, timeout transfer/jump, and future generic
  assignment mutation each have a named reachability test. Unsupported
  attendance instances fail before assignment/instance DML; a supported action
  routes through the P26 org/version contract. Removing an action-union member,
  assignment-DML call site, normal attendance fixture, or
  `published_definition_id` adversarial fixture fails the generated debt guard;
- P17/P22 central legacy approve/reject, generic bridge, verified card action,
  and plugin decision converge before terminal DML or fail closed; a
  central-first/plugin-second and plugin-first/central-second matrix proves one
  terminal approval, one fact/result/effect set, and congruent replay or
  conflict;
- P19 authorization locks the request and derives its org before checking the
  closed actor matrix: attendance-admin/delegated actors require active
  membership in that org; a platform-admin cross-org override requires the
  verified global posture and an audit witness; caller-supplied org never
  widens either case;
- P18 shift-swap and schedule-dispatch terminal writers use the same operation
  preflight and compatible schedule-fact lock/version protocol; racing either
  against a calculation cannot commit mixed context;
- request, terminal approval, assignment, ledger fact/reversal, calculation,
  projection, and operation seal share one transaction/connection; every
  injected-failure leg rolls all of them back;
- bounded and minutes-only facts are both representable; minutes-only remains
  review and cannot excuse/extend;
- cancellation's current balance-only reversal is treated as an uncovered
  source path until the new calculation or explicit review/no-parent outcome is
  atomic with that financial reversal; no test may imply an existing attendance
  result reversal;
- cancellation eligibility remains byte-identical: approved leave gets the W4
  reversal path, while approved overtime/correction/outdoor/shift-swap/
  schedule-dispatch remain rejected before operation/source/shared/result DML;
  making any of them cancellable fails a scope-boundary test;
- approval/resolution/cancellation lifecycle events in
  `shadow|eligible|authoritative` use closed outbox kinds; commit-before-emit
  crash and replay cannot lose or duplicate the durable event row, while the
  same entrypoints in `legacy_projection_only` preserve existing emit behavior
  and create no operation/calculation/outbox row;
- full/partial leave and overtime follow section 4.4;
- cross-org/user or mutated frozen request fails;
- cross-org UUID probes independently cover approve, reject, cancel, central
  legacy, generic bridge, and card action before shared/result SQL;
- terminal approval version/record ID and request-snapshot fingerprint are
  frozen from the same transaction; substituting mutable request state fails;
- omitting any adapter from inventory fails.

### 12.6 W4C-3c: manual, recompute, operator, final inventory

Deliver immutable manual override, introduce prior-policy/default recompute and
explicit-current-policy recompute as new capabilities, remove the meta patch,
canonicalize privileged operator retirement, and regenerate the final DML
inventory.

Gates:

- manual override survives unrelated updates until explicit supersession;
- set/unset/closed status validators;
- prior/current-policy recompute is distinct and explainable;
- retirement writes `operator_retirement` and never deletes;
- P15 generated operator cleanup and every W4-backed P16 test/staging cleanup
  path use retirement; tooling-only fixture setup/teardown stays separately
  named and cannot be mistaken for a production bypass;
- ordinary punch/import/approval/recompute cannot reactivate an
  operator-retired parent and fails with zero writes;
- predecessor-null/wrong-branch, legacy-preimage restore, import-then-live
  evidence loss, and inference-from-first/last mutations fail;
- direct-service forged authorization and every entrypoint/capability mismatch
  fail;
- every dedicated/shared source, effect, and result DML syntax positive control
  and every remaining side door mutation fails;
- P20 anomaly listing, makeup-anomaly fact derivation, open-record work-date
  attribution, and DecisionTrace each use the canonical active-current helper;
  removing the predicate from any one surface exposes a retired fixture and
  fails only that surface's positive control;
- manual/recompute/operator inventory entries are removed and the final
  generated debt set is empty; CI changes from no-new-debt to zero-bypass hard
  enforcement.

### 12.7 W4C-4: shadow ledger and detail

Deliver diff/backlog, dual-host detail, OpenAPI/client generation, neutral
labels, and decision-trace integration.

Gates:

- full dual-host permission matrix;
- same-org other-user 404 equals missing;
- cross-org admin spoof rejected before result SQL;
- removing subject/org predicate demonstrates test failure;
- unknown schema/enum fail closed;
- every ordinary-read SELECT is classified by the generated current/history
  inventory; adding a direct retired-row read fails;
- unsupported trace is undeterminable;
- current-schedule/V1 reconstruction and raw-ID mutations fail;
- OpenAPI lint/build/generated diff clean.

### 12.8 W4C-5: named synthetic staging

Deliver transition commands/runbook, named synthetic org, status/shadow/
eligibility/authority/suspend/resume/reversal/residue helpers, and verification
MD.

Gates:

- separate owner authorization for staging org;
- exact image SHA, pending migrations zero, health;
- no wildcard/customer data/external notifications;
- every entrypoint represented;
- P16 staging execution bodies and cleanup are inventoried explicitly; dynamic
  SQL or direct DML against W4-backed rows fails the tooling debt guard;
- zero pending or still-reversible calculation-affecting request whose latest
  snapshot is missing, unsupported, payload-stale, or reversal-incomplete
  before authority;
- zero unresolved `legacy_time_ingress_not_authoritative` review before
  eligibility or authority, with a negative transition test;
- minimum seven calendar days, zero critical diffs, zero unresolved reviews;
- reversal and suspend/resume drills;
- authoritative suspend preserves owner/pointer, offline replay is clean,
  resume returns authoritative, and the first changed punch supersedes the
  preserved pointer successfully;
- suspend/resume admits only paused operations already accepted as
  authoritative; a shadow/eligible/unknown accepted posture blocks transition,
  and source-bearing mismatches require explicit incident remediation;
- valid pointers and unchanged historical hashes;
- suspension preflight causes zero synchronous source/result writes and an
  already-durable job remains retryable without a projection;
- PASS marker and residue zero;
- no production deploy/flag action.

### 12.9 CI collection is part of each slice

Every new test proves local collection, DB exclude/run-list wiring, workflow
positive control, and exact mutation/failing leg. Frontend additions update both
path filters and explicit web-guard run list. Skip-green is a failed gate.

## 13. Owner decision menu

All decisions remain **OPEN** until exact merged-SHA RATIFY.

| ID | Options | Recommendation |
| --- | --- | --- |
| OD-W4C-1 status/reasons | (a) accept section 6; (b) amend exact values | (a) |
| OD-W4C-2 capture cells | (a) midpoint partition; (b) new explicit windows | (a), no hidden setting |
| OD-W4C-3 duplicates | (a) review on second candidate; (b) collapse | (a) |
| OD-W4C-4 DST | (a) gap review, unshared fold start earlier/end later, shared fold boundary review; (b) explicit alternative | (a) |
| OD-W4C-5 persistence | (a) append-only schema/pointer/reversal; (b) event-only reconstruction | (a) |
| OD-W4C-6 rollback conflict | (a) whole-batch 409; (b) partial reversal | (a) |
| OD-W4C-7 promotion | (a) seven days, every entrypoint, zero critical/unresolved; (b) explicit alternative | (a), synthetic staging only |
| OD-W4C-8 rollout gate | (a) named outer allowlist plus state and synthetic-only W4 reference enablement; (b) explicit alternative | (a) |
| OD-W4C-9 suspension | (a) preserve W4 current, block writes, offline replay, resume authoritative; (b) separately specify fallback contract | (a) |
| OD-W4C-10 explanation | (a) admin+self; (b) admin only | (a) |
| OD-W4C-11 retention | (a) no W4 purge; (b) new purge design | (a) |
| OD-W4C-12 order | (a) 0->1->2->3a->3b->3c->4->5; (b) explicit alternative | (a) |
| OD-W4C-13 attribution | (a) V2 only, no inference upgrade; (b) separately prove upgrader | (a) |
| OD-W4C-14 approved reversal | (a) append from frozen evidence; (b) mutate prior | (a) |
| OD-W4C-15 cleanup | (a) canonical reversal/retirement; (b) destructive bypass | (a) |
| OD-W4C-16 approved projection | (a) section 4.4 physical minutes + bounded leave excuse; (b) explicit alternative | (a) |
| OD-W4C-17 live idempotency | (a) W4-enabled client operation UUID plus durable all-source registry; (b) explicit alternative | (a) |
| OD-W4C-18 invalid evidence | (a) out-of-window or non-positive segment span is review-required with no current change; (b) explicit alternative | (a) |
| OD-W4C-19 retired lifecycle | (a) import-rollback/review tombstones reactivate only from new durable evidence; operator retirement is terminal absent a new design; (b) explicit alternative | (a) |
| OD-W4C-20 actual overlap | (a) cross-segment actual intervals must not overlap; overlap is review-required; (b) separately define a non-double-counting allocation rule | (a), no clipping or hidden reassignment |
| OD-W4C-21 same-target batch rows | (a) fold ordered rows for one org/user/workDate into one calculation and one pre-batch restore witness; (b) reject duplicate resolved targets before source DML | (a), preserves import capability and rollback truth |
| OD-W4C-22 rounding/tiering | (a) floor each physical interval to minutes, sum, round down once at daily level, then tier daily late total from frozen thresholds; (b) explicit alternative | (a), preserves the legacy daily-rounding boundary |
| OD-W4C-23 import metrics | (a) snapshot exact presence plus frozen legacy policy result; require congruence with segment truth or review/block promotion; (b) define an authoritative override model | (a), never discard or silently override |
| OD-W4C-24 atomic batch bound | (a) 5000 items/targets, 180s statement, 5s lock, two retries; above limit fails authoritative and cannot count as shadow promotion evidence; (b) separately benchmark another closed bound | (a), matches the current chunk ceiling without claiming 500k-row atomicity |
| OD-W4C-25 lifecycle delivery | (a) transactional closed outbox for existing attendance lifecycle events; (b) enumerate each best-effort event and prove no correctness consumer | (a) |
| OD-W4C-26 grace source | (a) copy the selected shift/rule profile's two grace values identically into every frozen segment; (b) reopen W3 for true per-segment authoring | (a), no invented per-segment source |
| OD-W4C-27 first-import reversal | (a) retired reversal carries the exact imported after-image plus explicit absent preimage; (b) separately define another non-null historical projection | (a), no zero/null fabrication |
| OD-W4C-28 approval terminal body | (a) every attendance instance terminal route enters one canonical transaction or fails closed before terminal DML; (b) commit centrally then reconcile asynchronously | (a), no split-brain window |
| OD-W4C-29 approval org authority | (a) attendance-admin/delegated actors require active membership in the locked request org; verified global platform-admin override is explicit and audited; (b) retain UUID plus global attendance permission behavior | (a) |
| OD-W4C-30 schedule-fact approvals | (a) shift-swap/schedule-dispatch use the operation boundary and compatible context lock/version without fabricating a result; (b) leave them outside W4 | (a), they change future calculation input |
| OD-W4C-31 current reader inventory | (a) anomaly, makeup facts, open-record attribution, and DecisionTrace join the canonical active-current contract with independent tests; (b) tolerate retired-row reads | (a) |
| OD-W4C-32 timezone ingress | (a) strict IANA validation and explicit offset/instant for W4 evidence and settings writes, with the section 4.1 legacy/shadow compatibility quarantine; (b) retain helper-specific fallbacks as W4 evidence | (a), observe legacy-only clients in shadow without admitting ambiguous time to authority |
| OD-W4C-33 pending edit concurrency | (a) append immutable request snapshot versions with expected hash/version; (b) continue mutable `form_snapshot` overwrite | (a) |
| OD-W4C-34 rollback authorization | (a) batch owner/delegated scope is frozen and rollback uses commit-equivalent authorization plus org binding; (b) any org-local importer may roll back any batch | (a) |
| OD-W4C-35 integration dry-run | (a) audit attempt only, with no batch/result/pointer/`last_sync_at` write; (b) retain current watermark side effect | (a) |
| OD-W4C-36 import operational state | (a) classify token/job/prefs/upload/temp state separately and deny calculation authority; (b) treat every operational row as business evidence | (a) |
| OD-W4C-37 attendance assignment mutation | (a) central reassign and any reachable generic assignment mutation use the locked request-org actor/target matrix plus approval-version serialization; unsupported generic actions prove zero attendance DML; (b) retain global `approvals:admin` plus globally active target behavior | (a), changing who may approve is an org-bound security decision |
| OD-W4C-38 operation lifecycle by posture | (a) completed congruent replay is read first; null-ID legacy writes no operation/outbox, stable-ID legacy claims/seals a compatibility operation with no outbox, and shadow/eligible/authoritative require claim/seal plus required outbox; (b) require operation IDs from every legacy caller | (a), preserves the existing optional-ID API while closing cross-posture response-loss replay |
| OD-W4C-39 legacy rollback-window closure | (a) append an immutable per-batch closure witness only for a batch with zero frozen preimage/W4 references, and serialize rollback/closure/transition with section 9's complete org-rollout, rollout-state-if-written, operation-identity-advisory, operation-row, batch/item, then target lock protocol; (b) infer closure from time or an unlocked scan | (a), no stale-read destructive rollback or suppression of valid W4 reversal |
| OD-W4C-40 rollout/source serialization | (a) completed congruent replay may non-locking-read and return with zero DML; every continuing source and rollback uses one fail-closed helper for class-`00` shared org rollout before class-`10` operation identities, rows/batches, and class-`11` targets, while transition and closure use rollout exclusive first; class `01` is reserved; (b) rely on operation-row scans and transaction isolation alone | (a), disjoint two-bit classes forbid cross-purpose lock upgrade, the shared rollout mode preserves ordinary write concurrency, covers null-ID legacy work, serializes same-batch source/rollback through their lower-order locks, and gives one complete order |
| OD-W4C-41 concurrent first claim | (a) one canonical exclusive transaction-advisory helper strict-parses canonical UUID identities, derives class-`10` keys, de-duplicates and numerically sorts final signed keys, then serializes every supplied batch/item identity after class-`00` rollout and before row read/insert; the canonical target helper later does the same for class `11`; contention within 5 seconds replays the stored response, longer contention returns values-free `409 ATTENDANCE_OPERATION_IN_PROGRESS` and a later retry replays; (b) catch and retry unique-constraint `23505`; (c) rely on the unique constraint and surface one caller's failure | (a), the closed timeout is honest, raw `23505|55P03` never escapes, unrelated constraint failures stay fail-closed, cross-class upgrades are impossible, and unrelated operations remain concurrent except for harmless within-class hash collision |

## 14. RATIFY and execution sequence

1. Rebase docs PR to current main.
2. Re-verify anchors and regenerate writer inventory.
3. Owner decides OD-W4C-1..41.
4. Amend until no decision is ambiguous.
5. Merge document as PROPOSED.
6. Owner RATIFYs exact merged SHA.
7. Only then start W4C-0 from fresh main.
8. Each runtime slice follows section 12 and enables no org.
9. W4C-5 staging requires separate owner authorization.
10. Production enablement and issue closure require separate final decisions
    after verification MD is on main.

## 15. Completion definition

W4 is complete only when:

- W4C-0, 1, 2, 3a, 3b, 3c, 4, and 5 are on main in order;
- every source, shared-effect, result, and current-read DML side door is
  canonicalized;
- every attendance approval terminal body converges before shared terminal DML,
  and schedule-fact approval writers participate in context consistency;
- anomaly, makeup-anomaly facts, open-record attribution, DecisionTrace, and
  all previously named ordinary readers hide retired parents;
- immutable constraints are proven on real PostgreSQL;
- all three import transports use reversal rollback;
- explicit import metrics/policy output are snapshotted and either congruent or
  promotion-blocking; bounded batch limits are proven;
- W4-covered post-commit events have transactional outbox/restart evidence;
- status/reason/DST/matching contracts agree across DB/service/OpenAPI/tests;
- named-org rollout and suspension drills pass;
- detail authorization passes cross-user/cross-org matrices;
- verification MD records exact SHAs, runs, real-DB evidence, mutations,
  rollout state, and honest residuals;
- owner separately decides production enablement and #4556 closure.

Until then W3 authoring compatibility is the safe public behavior and
multi-segment authoritative calculation remains off.
