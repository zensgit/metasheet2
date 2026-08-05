/**
 * W4C-2 P1-2 (#4556) — durable scheduled-run identity, run-scoped outbox enqueue, and the
 * private minting factories (amendment section 1.4.1).
 *
 * Authority: docs/development/attendance-issue-4556-w4c2-scheduled-run-identity-amendment-20260726.md
 * (RATIFIED per PR #4617; owner Bundle A = 44a/45a/46a/47a/48a/49a/50a/51a/52a/53(i)),
 * section 1.4.1.
 *
 * THIS is the module section 1.4.1 requires: "There are exactly two constructors, and both
 * are defined in, and neither is exported outside, the module that ALSO defines the
 * run-creation, resume, and finalization transactions". This slice (P1-2 second half — the
 * transactional half of section 4 step 3, following the schema/identity/enqueue half already
 * on this branch) adds: the pure target-set-resolution/fingerprint functions (section 1.2's
 * `ordinal`, section 1.3, `O-2`/`OD-W4C-51=(a)` — `ORDER BY user_id` canonical order), the
 * run-creation/resume transaction (section 1.7), the finalization transaction (section 1.8),
 * the `O-3=(a)` per-target outcome writer (section 1.1.1), the `abandoned` transition
 * (section 1.1.2), and the recovery-sweep step function (section 1.7's "no stuck absorbing
 * state"). All of it lands IN THIS SAME FILE, so the "neither constructor is exported outside
 * the module" exclusivity claim this file makes stays true.
 *
 * Caller cutover (owner ruling 2026-07-28, "(b-narrow)"): `w4c2-live-scheduled-boundary.ts`'s
 * `executeScheduledRun` now drives `createOrResumeAttendanceScheduledRunV1` /
 * `recordAttendanceScheduledRunTargetOutcomeV1` / `finalizeAttendanceScheduledRunV1` for the
 * `shadow`/`eligible`/`authoritative` posture branch, from both production initiators (the
 * cron tick and the `POST /api/attendance/auto-absence/run` admin route, both funneling
 * through `plugins/plugin-attendance/index.cjs`'s `runAutoAbsenceForOrgDate`). Membership
 * resolution (section 1.7 step 4, "resolve membership and per-user work-date attribution
 * exactly as today") stays the injected async callback
 * (`AttendanceScheduledRunMembershipResolverV1`) this file always specified — the boundary's
 * closure wraps the SAME pre-resolved `(generate, review)` lists `runAutoAbsenceForOrgDate`
 * already computes via `attendance-work-date-resolver.cjs`, unchanged, so this file still does
 * not reimplement that resolver. The held branch's SUPERSEDED derivation,
 * `deriveAttendanceScheduledRunIdV1` (formerly `w4c2-live-scheduled-boundary.ts`), is retired
 * by this cutover (section 1.1's "must not survive implementation" rule) — `runId` is now
 * always the server-minted `attendance_scheduled_runs.run_id` this module's own
 * `INSERT ... RETURNING`/resume read produces. The recovery sweep is wired through the
 * plugin-owned scheduler context builder: it resumes the exact scanned `run_id`, never the
 * ordinary create-or-resume entry point, so a scan/finalize race cannot create generation
 * `n+1`.
 *
 * Values-free discipline: every throw is a closed code string only, never the offending
 * input bytes.
 */
import crypto from 'node:crypto'
import type {
  AttendanceW4TransactionClientV1,
  Brand,
  CanonicalAttendanceRolloutOrgKeyV1,
  CanonicalAttendanceScheduledRunInitiatorV1,
  CanonicalAttendanceScheduledRunKeyV1,
  CanonicalAttendanceWorkDateV1,
  VerifiedAttendanceOperationIdentityV1,
  VerifiedAttendanceOrgIdentityV1,
} from './w4c0-identity'
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceScheduledRunLock,
  createVerifiedAttendanceOrgIdentityV1,
  deriveAttendanceOperationCandidateIdentityV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  parseCanonicalAttendanceScheduledRunKeyV1,
  parseCanonicalAttendanceWorkDateV1,
  rehydrateVerifiedAttendanceOrgIdentityV1,
  requireVerifiedAttendanceOperationIdentityV1,
  resolveSegmentCalculationPosture,
} from './w4c0-identity'
import {
  verifyAuthorizedAttendanceWriteContextV1,
  type AuthorizedAttendanceWriteContextV1,
} from './w4c0-authorization'
import { ATTENDANCE_W4_SCHEDULED_RUN_OUTBOX_EVENT_KINDS_V1, AttendanceW4OperationError } from './w4c0-operation-contract'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import type { AttendanceOutboxEventInputV1 } from './w4c0-operation-registry'
import { W4C2_SCHEDULED_REVIEW_REASON_CODES_V1 } from '../db/migrations/zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union'

// ---------------------------------------------------------------------------
// Values-free error type (this module's own, mirroring w4c0-identity.ts's discipline).
// ---------------------------------------------------------------------------

export class AttendanceW4ScheduledRunIdentityError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4ScheduledRunIdentityError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4ScheduledRunIdentityError(code)
}

// ---------------------------------------------------------------------------
// Strict object intake — a local copy of w4c0-identity.ts's own private helper (each W4
// module owns its tiny scalar/shape parsers; see that file's own `requireHex64` precedent
// in w4c0-operation-registry.ts).
// ---------------------------------------------------------------------------

function requireExactKeys(input: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(code)
  const obj = input as Record<string, unknown>
  if (Object.getOwnPropertySymbols(obj).length > 0) fail(code)
  const own = Object.getOwnPropertyNames(obj)
  if (own.length !== keys.length) fail(code)
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(code)
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key)
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) fail(code)
    out[key] = descriptor.value
  }
  return out
}

function frozenNullProto<T extends Record<string, unknown>>(fields: T): T {
  const out = Object.create(null) as T
  for (const key of Object.keys(fields)) {
    ;(out as Record<string, unknown>)[key] = fields[key]
  }
  return Object.freeze(out)
}

const UUID_SYNTAX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const LOWER_HEX_64 = /^[0-9a-f]{64}$/
const SCHEDULED_RUN_INITIATORS = ['cron', 'admin_run'] as const

function parseUuidSyntax(input: unknown, code: string): string {
  if (typeof input !== 'string') fail(code)
  if (input.length !== 36) fail(code)
  if (!UUID_SYNTAX.test(input)) fail(code)
  return input.toLowerCase()
}

function requireRfc4122VariantVersion(canonicalUuid: string, code: string): void {
  const version = canonicalUuid.charCodeAt(14) - 0x30
  if (version < 1 || version > 5) fail(code)
  const variant = canonicalUuid[19]
  if (variant !== '8' && variant !== '9' && variant !== 'a' && variant !== 'b') fail(code)
}

function parseHex64(input: unknown, code: string): string {
  if (typeof input !== 'string') fail(code)
  if (input.length !== 64) fail(code)
  if (!LOWER_HEX_64.test(input)) fail(code)
  return input
}

function parseGeneration(input: unknown): number {
  const code = 'W4C2_SCHEDULED_RUN_GENERATION_INVALID'
  const n = typeof input === 'string' ? Number(input) : input
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) fail(code)
  return n
}

function requireHex64(value: unknown, code: string): string {
  return parseHex64(value, code)
}

// ---------------------------------------------------------------------------
// Verified scheduled-run identity (section 1.4.1).
// ---------------------------------------------------------------------------

declare const ScheduledRunOpaque: unique symbol
type Opaque<T, B extends string> = T & { readonly [ScheduledRunOpaque]: B }

export type CanonicalAttendanceScheduledRunIdV1 = Brand<string, 'CanonicalAttendanceScheduledRunIdV1'>

export type VerifiedAttendanceScheduledRunIdentityV1 = Opaque<
  Readonly<{
    runId: CanonicalAttendanceScheduledRunIdV1
    org: VerifiedAttendanceOrgIdentityV1
    entrypoint: 'scheduled'
    initiator: CanonicalAttendanceScheduledRunInitiatorV1
    workDate: CanonicalAttendanceWorkDateV1
    generation: number
    targetSetFingerprint: string
  }>,
  'VerifiedAttendanceScheduledRunIdentityV1'
>

const runWitnesses = new WeakSet<object>()

/** Exact camelCase mirror of the `attendance_scheduled_runs` row this constructor trusts. */
export interface AttendanceScheduledRunDurableRowV1 {
  runId: string
  orgId: string
  entrypoint: string
  initiator: string
  acceptedWritePosture: string
  workDate: string
  generation: number | string
  targetSetFingerprint: string
}

const RUN_ROW_KEYS = [
  'runId',
  'orgId',
  'entrypoint',
  'initiator',
  'acceptedWritePosture',
  'workDate',
  'generation',
  'targetSetFingerprint',
] as const

/**
 * The shared validation core BOTH module-private constructors below call, so they are
 * equalized in trust level rather than one being special-cased (section 1.4.1: "Both
 * constructors validate the same shape ... and apply the same defensive rejection of a row
 * that fails any of the table's own CHECK/FK invariants"). Rejects JSON clones, spreads,
 * and prototype lookalikes exactly as the W4C-0 witness layer does — this row's shape is
 * validated field-by-field; the returned witness is what actually proves admission.
 */
function mintScheduledRunWitnessFromRow(row: unknown): VerifiedAttendanceScheduledRunIdentityV1 {
  const code = 'W4C2_SCHEDULED_RUN_DURABLE_ROW_INVALID'
  const fields = requireExactKeys(row, RUN_ROW_KEYS, code) as unknown as AttendanceScheduledRunDurableRowV1

  const runId = parseUuidSyntax(fields.runId, 'W4C2_SCHEDULED_RUN_ID_INVALID')
  requireRfc4122VariantVersion(runId, 'W4C2_SCHEDULED_RUN_ID_INVALID')

  if (fields.entrypoint !== 'scheduled') fail('W4C2_SCHEDULED_RUN_ENTRYPOINT_INVALID')

  if (
    typeof fields.initiator !== 'string' ||
    !(SCHEDULED_RUN_INITIATORS as readonly string[]).includes(fields.initiator)
  ) {
    fail('W4C2_SCHEDULED_RUN_INITIATOR_INVALID')
  }

  const workDate = parseCanonicalAttendanceWorkDateV1(fields.workDate)
  const generation = parseGeneration(fields.generation)
  const targetSetFingerprint = parseHex64(fields.targetSetFingerprint, 'W4C2_SCHEDULED_RUN_FINGERPRINT_INVALID')

  // Reuses the published W4-covered org witness rehydration (w4c0-identity.ts) — no
  // parallel default/posture-door implementation.
  const org = rehydrateVerifiedAttendanceOrgIdentityV1({
    orgId: fields.orgId,
    acceptedWritePosture: fields.acceptedWritePosture,
  })

  const witness = frozenNullProto({
    runId: runId as CanonicalAttendanceScheduledRunIdV1,
    org,
    entrypoint: 'scheduled' as const,
    initiator: fields.initiator as CanonicalAttendanceScheduledRunInitiatorV1,
    workDate,
    generation,
    targetSetFingerprint,
  }) as VerifiedAttendanceScheduledRunIdentityV1
  runWitnesses.add(witness)
  return witness
}

/**
 * module-private — used by the resume protocol (section 1.7) and by the finalization
 * transaction's step 3 `SELECT ... FOR UPDATE` re-read (section 1.8), always over a row
 * read under the class-`01` lock, whether or not that read is in the same transaction that
 * originally inserted the row. Not exported outside this module (section 1.4.1) — the
 * later slice's run-creation/resume/finalization transactions, defined in THIS file, are
 * its only callers.
 */
function rehydrateVerifiedAttendanceScheduledRunIdentityV1(
  durableRow: AttendanceScheduledRunDurableRowV1,
): VerifiedAttendanceScheduledRunIdentityV1 {
  return mintScheduledRunWitnessFromRow(durableRow)
}

/**
 * module-private — used ONLY by section 1.7 step 5-6's run-creation transaction, over the
 * exact row its own `INSERT ... RETURNING` produced, still holding the class-`01` lock
 * acquired at step 2. This is the constructor the zero-`generate`-target case (section 1.9)
 * uses, since that case's run-creation transaction is itself the finalization transaction
 * and therefore must enqueue before its own transaction's `COMMIT` — there is no
 * separately-committed row to re-read. Not exported outside this module.
 *
 * Equivalence argument (section 1.4.1, round-6 correction): a row produced by this
 * transaction's own `INSERT ... RETURNING`, while class-`01` is held for the run key and no
 * other transaction can concurrently start or complete a run for the same
 * `(org_id, initiator, work_date)`, carries exactly the same guaranteed-valid shape a later
 * re-read under `FOR UPDATE` would see — the only difference is which side of this
 * transaction's own `COMMIT` the read happens on. What actually holds, for both
 * constructors, is: read under the class-`01` lock, within the transaction that owns it,
 * after the row's own `INSERT`/`SELECT` has satisfied every table `CHECK`/`FK` — not
 * "after commit".
 */
function mintAttendanceScheduledRunIdentityFromInsertedRowV1(
  insertedRow: AttendanceScheduledRunDurableRowV1,
): VerifiedAttendanceScheduledRunIdentityV1 {
  return mintScheduledRunWitnessFromRow(insertedRow)
}

// Both constructors above are now called by the run-creation/resume/finalization
// transactions below, in THIS SAME MODULE — the "neither is exported outside the module"
// exclusivity claim (section 1.4.1) stays true: the run-creation transaction
// (`createOrResumeAttendanceScheduledRunV1`) is the only caller of
// `mintAttendanceScheduledRunIdentityFromInsertedRowV1`; the resume protocol and the
// standalone finalization transaction (`finalizeAttendanceScheduledRunV1`) are the only
// callers of `rehydrateVerifiedAttendanceScheduledRunIdentityV1`.

/**
 * Read-only witness check for the run-scoped enqueue surface below — mints nothing;
 * membership in the module-private WeakSet remains the only proof, so a JSON clone/spread/
 * prototype lookalike is rejected here exactly as it is by the constructors above.
 */
export function requireVerifiedAttendanceScheduledRunIdentityV1(
  identity: unknown,
): VerifiedAttendanceScheduledRunIdentityV1 {
  if (typeof identity !== 'object' || identity === null || !runWitnesses.has(identity)) {
    fail('W4C2_SCHEDULED_RUN_WITNESS_REQUIRED')
  }
  return identity as VerifiedAttendanceScheduledRunIdentityV1
}

// ---------------------------------------------------------------------------
// Run-scoped outbox enqueue (section 1.4.1) — the exported entry point gate 22(b) injects
// a fabricated identity through, since it is the only exported entry point in this module's
// surface that accepts a `VerifiedAttendanceScheduledRunIdentityV1` parameter directly.
// ---------------------------------------------------------------------------

/**
 * Rejects everything except the two run-level kinds and fail-closes on
 * `legacy_projection_only` exactly as `enqueueAttendanceResultEventOutboxV1`
 * (w4c0-operation-registry.ts) does today (`W4C0_OUTBOX_LEGACY_FORBIDDEN`) — reused
 * literally, not a parallel legacy-posture check.
 */
export async function enqueueAttendanceScheduledRunEventOutboxV1(
  trx: AttendanceW4TransactionClientV1,
  identity: unknown,
  events: readonly AttendanceOutboxEventInputV1[],
): Promise<void> {
  const verified = requireVerifiedAttendanceScheduledRunIdentityV1(identity)
  if (verified.org.acceptedWritePosture === 'legacy_projection_only') {
    fail('W4C0_OUTBOX_LEGACY_FORBIDDEN')
  }
  if (!Array.isArray(events) || events.length === 0) fail('W4C2_SCHEDULED_RUN_OUTBOX_EVENTS_INVALID')
  for (const event of events) {
    if (!(ATTENDANCE_W4_SCHEDULED_RUN_OUTBOX_EVENT_KINDS_V1 as readonly string[]).includes(event.eventKind)) {
      fail('W4C2_SCHEDULED_RUN_OUTBOX_EVENT_KIND_INVALID')
    }
    if (!Number.isInteger(event.payloadSchemaVersion) || event.payloadSchemaVersion < 1) {
      fail('W4C2_SCHEDULED_RUN_OUTBOX_EVENTS_INVALID')
    }
    requireHex64(event.businessKeyFingerprint, 'W4C2_SCHEDULED_RUN_OUTBOX_EVENTS_INVALID')
    await trx.query(
      `INSERT INTO attendance_result_event_outbox (
          org_id, entrypoint, identity_kind, scheduled_run_id, event_kind, payload,
          payload_schema_version, business_key_fingerprint, delivery_state
        ) VALUES ($1,'scheduled','scheduled_run',$2::uuid,$3,$4::jsonb,$5,$6,'pending')`,
      [
        verified.org.orgId,
        verified.runId,
        event.eventKind,
        canonicalAttendanceJsonV1(event.payload),
        event.payloadSchemaVersion,
        event.businessKeyFingerprint,
      ],
    )
  }
}

// ---------------------------------------------------------------------------
// Section 1.2/1.3: pure target-set resolution + fingerprint. `O-2`/`OD-W4C-51=(a)`
// (RATIFIED, Bundle A): `ORDER BY user_id` pins ordinal as a deterministic function of
// membership, so a resume recomputation is byte-identical by construction.
// ---------------------------------------------------------------------------

const NUL_BYTE = Buffer.from([0])

export type AttendanceScheduledRunTargetKindV1 = 'generate' | 'review'

/** Caller-supplied resolved membership entry — pre-ordering, pre-ordinal. */
export interface AttendanceScheduledRunMemberInputV1 {
  readonly userId: string
  readonly targetKind: AttendanceScheduledRunTargetKindV1
  readonly reviewReasonCode: string | null
}

/** One frozen target-plan entry, post `O-2=(a)` canonical ordering. */
export interface AttendanceScheduledRunTargetPlanEntryV1 {
  readonly ordinal: number
  readonly userId: string
  readonly targetKind: AttendanceScheduledRunTargetKindV1
  readonly reviewReasonCode: string | null
}

/**
 * Section 1.2/1.3, `O-2=(a)`: strict-parses each member, then sorts `ORDER BY user_id`
 * ascending and assigns 0-based `ordinal` — a pure function of the resolved membership set,
 * called identically by both the run-creation transaction (section 1.7 step 4-5) and the
 * resume protocol's recomputation (section 1.7 step 3), so byte-equality between the two is
 * not a coincidence of shared code paths happening to agree — it is the same function.
 */
export function resolveAttendanceScheduledRunTargetSetV1(
  members: readonly AttendanceScheduledRunMemberInputV1[],
): readonly AttendanceScheduledRunTargetPlanEntryV1[] {
  const code = 'W4C2_SCHEDULED_RUN_MEMBER_INVALID'
  if (!Array.isArray(members)) fail(code)
  const seenUserIds = new Set<string>()
  const validated = members.map((member) => {
    if (typeof member !== 'object' || member === null) fail(code)
    const fields = requireExactKeys(member, ['userId', 'targetKind', 'reviewReasonCode'], code) as unknown as AttendanceScheduledRunMemberInputV1
    const userId = parseUuidSyntax(fields.userId, 'W4C2_SCHEDULED_RUN_MEMBER_USER_ID_INVALID')
    if (fields.targetKind !== 'generate' && fields.targetKind !== 'review') {
      fail('W4C2_SCHEDULED_RUN_MEMBER_TARGET_KIND_INVALID')
    }
    let reviewReasonCode: string | null = null
    if (fields.targetKind === 'review') {
      if (
        typeof fields.reviewReasonCode !== 'string' ||
        !(W4C2_SCHEDULED_REVIEW_REASON_CODES_V1 as readonly string[]).includes(fields.reviewReasonCode)
      ) {
        fail('W4C2_SCHEDULED_RUN_MEMBER_REVIEW_REASON_INVALID')
      }
      reviewReasonCode = fields.reviewReasonCode
    } else if (fields.reviewReasonCode !== null) {
      fail('W4C2_SCHEDULED_RUN_MEMBER_REVIEW_REASON_INVALID')
    }
    if (seenUserIds.has(userId)) fail('W4C2_SCHEDULED_RUN_MEMBER_DUPLICATE_USER')
    seenUserIds.add(userId)
    return { userId, targetKind: fields.targetKind, reviewReasonCode }
  })
  // `O-2=(a)`: ORDER BY user_id ascending — the canonical, deterministic pin.
  const sorted = [...validated].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
  return sorted.map((entry, ordinal) => Object.freeze({ ...entry, ordinal }))
}

/**
 * Section 1.3: the canonical NUL-separated target-set fingerprint. Order-sensitive by
 * construction (ordinal is part of the hashed bytes) — a benign reordering across a resume is
 * impossible once `O-2=(a)` pins `ordinal` to a deterministic function of membership, so
 * ordinal drift alone is real evidence of corruption (gate 10's "or one ordinal" leg, kept
 * under `(a)`).
 */
export function computeAttendanceScheduledRunTargetSetFingerprintV1(
  key: { readonly orgId: string; readonly initiator: string; readonly workDate: string },
  targets: readonly AttendanceScheduledRunTargetPlanEntryV1[],
): string {
  const parts: Buffer[] = [Buffer.from('metasheet2:attendance:scheduled-run-target-set:v1', 'utf8')]
  parts.push(NUL_BYTE, Buffer.from(key.orgId, 'utf8'))
  parts.push(NUL_BYTE, Buffer.from(key.initiator, 'utf8'))
  parts.push(NUL_BYTE, Buffer.from(key.workDate, 'utf8'))
  for (const target of targets) {
    parts.push(NUL_BYTE, Buffer.from(String(target.ordinal), 'utf8'))
    parts.push(NUL_BYTE, Buffer.from(target.userId, 'utf8'))
    parts.push(NUL_BYTE, Buffer.from(target.targetKind, 'utf8'))
    parts.push(NUL_BYTE, Buffer.from(target.reviewReasonCode ?? '', 'utf8'))
  }
  return crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex')
}

/** Section 1.5: the run-level outbox event business-key fingerprint. */
export function computeAttendanceScheduledRunEventBusinessKeyFingerprintV1(
  eventKind: string,
  orgId: string,
  workDate: string,
  runId: string,
): string {
  const preimage = Buffer.concat([
    Buffer.from('metasheet2:attendance:scheduled-run-event:v1', 'utf8'),
    NUL_BYTE,
    Buffer.from(eventKind, 'utf8'),
    NUL_BYTE,
    Buffer.from(orgId, 'utf8'),
    NUL_BYTE,
    Buffer.from(workDate, 'utf8'),
    NUL_BYTE,
    Buffer.from(runId, 'utf8'),
  ])
  return crypto.createHash('sha256').update(preimage).digest('hex')
}

// ---------------------------------------------------------------------------
// Section 1.7: run-creation transaction, resume protocol.
// ---------------------------------------------------------------------------

export interface AttendanceScheduledRunKeyInputV1 {
  readonly orgId: string
  readonly initiator: CanonicalAttendanceScheduledRunInitiatorV1
  readonly workDate: string
}

/**
 * Injected membership resolver — section 1.7 step 4's "resolve membership and per-user
 * work-date attribution exactly as today" is NOT reimplemented here (see the module
 * docstring's caller-cutover note); the caller supplies the real resolver. Called under the
 * class-`01` lock, inside the run-creation/resume transaction.
 */
export type AttendanceScheduledRunMembershipResolverV1 = (
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  workDate: string,
) => Promise<readonly AttendanceScheduledRunMemberInputV1[]>

interface AttendanceScheduledRunRowShapeV1 {
  run_id: string
  org_id: string
  entrypoint: string
  initiator: string
  work_date: string
  generation: number | string
  accepted_write_posture: string
  target_set_fingerprint: string
  expected_user_count: number | string
  review_count: number | string
  state: string
}

export type AttendanceScheduledRunStartOutcomeV1 =
  | { readonly kind: 'org_suspended_deferred' }
  | { readonly kind: 'org_legacy_zero_rows' }
  | {
      readonly kind: 'created_running'
      readonly runId: string
      readonly generation: number
      readonly expectedUserCount: number
      readonly reviewCount: number
    }
  | {
      readonly kind: 'created_and_finalized'
      readonly runId: string
      readonly generation: number
      readonly reviewCount: number
      readonly generatedCount: number
    }
  | {
      readonly kind: 'resumed'
      readonly runId: string
      readonly generation: number
      readonly outstandingGenerateTargets: readonly {
        readonly targetId: string
        readonly userId: string
        readonly operationId: string
      }[]
      readonly readyToFinalize: boolean
    }

export interface AttendanceScheduledRunExactResumeKeyV1 extends AttendanceScheduledRunKeyInputV1 {
  readonly runId: string
}

export type AttendanceScheduledRunExactResumeOutcomeV1 =
  | AttendanceScheduledRunStartOutcomeV1
  | { readonly kind: 'not_running'; readonly runId: string; readonly state: 'completed' | 'abandoned' }

async function readRunningScheduledRunForUpdateV1(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  initiator: string,
  workDate: string,
): Promise<AttendanceScheduledRunRowShapeV1 | null> {
  const result = await trx.query(
    `SELECT run_id::text AS run_id, org_id, entrypoint, initiator, work_date::text AS work_date,
            generation, accepted_write_posture, target_set_fingerprint, expected_user_count,
            review_count, state
       FROM attendance_scheduled_runs
      WHERE org_id = $1 AND initiator = $2 AND work_date = $3::date AND state = 'running'
      FOR UPDATE`,
    [orgId, initiator, workDate],
  )
  if (result.rows.length === 0) return null
  if (result.rows.length > 1) fail('W4C2_SCHEDULED_RUN_STATE_AMBIGUOUS')
  return result.rows[0] as unknown as AttendanceScheduledRunRowShapeV1
}

async function readScheduledRunByExactIdV1(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  runId: string,
  forUpdate: boolean,
): Promise<AttendanceScheduledRunRowShapeV1 | null> {
  const result = await trx.query(
    `SELECT run_id::text AS run_id, org_id, entrypoint, initiator, work_date::text AS work_date,
            generation, accepted_write_posture, target_set_fingerprint, expected_user_count,
            review_count, state
       FROM attendance_scheduled_runs
      WHERE org_id = $1 AND run_id = $2::uuid
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [orgId, runId],
  )
  if (result.rows.length === 0) return null
  if (result.rows.length > 1) fail('W4C2_SCHEDULED_RUN_STATE_AMBIGUOUS')
  return result.rows[0] as unknown as AttendanceScheduledRunRowShapeV1
}

/**
 * Section 1.7: the run-creation transaction (steps 1-6) and, when it detects an existing
 * `running` row at step 3, the resume protocol. Intended to run as the `body` of
 * `runAttendanceResultOperationTransactionV1` (w4c0-operation-registry.ts) — the canonical
 * `SERIALIZABLE` wrapper — so this function itself issues no `BEGIN`/`COMMIT`.
 */
export async function createOrResumeAttendanceScheduledRunV1(
  trx: AttendanceW4TransactionClientV1,
  key: AttendanceScheduledRunKeyInputV1,
  resolveMembership: AttendanceScheduledRunMembershipResolverV1,
): Promise<AttendanceScheduledRunStartOutcomeV1> {
  const canonicalKey: CanonicalAttendanceScheduledRunKeyV1 = parseCanonicalAttendanceScheduledRunKeyV1(key)

  // Step 1: class-00 shared; resolve posture.
  await acquireAttendanceCalculationRolloutLock(trx, canonicalKey.orgId, 'shared')
  const posture = await resolveSegmentCalculationPosture(trx, canonicalKey.orgId)
  if (posture.writePosture === 'blocked') {
    return { kind: 'org_suspended_deferred' }
  }
  if (posture.writePosture === 'legacy_projection_only') {
    return { kind: 'org_legacy_zero_rows' }
  }
  const org = createVerifiedAttendanceOrgIdentityV1({ orgKey: canonicalKey.orgId, posture })

  // Step 2: class-01 run key lock.
  await acquireAttendanceScheduledRunLock(trx, canonicalKey)

  // Step 3: resume detection.
  const existing = await readRunningScheduledRunForUpdateV1(
    trx,
    canonicalKey.orgId,
    canonicalKey.initiator,
    canonicalKey.workDate,
  )
  if (existing) {
    return resumeAttendanceScheduledRunV1(trx, org, existing, resolveMembership)
  }

  // Step 4: resolve membership, build the frozen plan.
  const members = await resolveMembership(trx, canonicalKey.orgId, canonicalKey.workDate)
  const plan = resolveAttendanceScheduledRunTargetSetV1(members)
  const fingerprint = computeAttendanceScheduledRunTargetSetFingerprintV1(canonicalKey, plan)
  const expectedUserCount = plan.filter((t) => t.targetKind === 'generate').length
  const reviewCount = plan.filter((t) => t.targetKind === 'review').length

  // Step 5: allocate generation, insert run + target rows.
  const genResult = await trx.query(
    `SELECT COALESCE(MAX(generation), 0) AS max_gen FROM attendance_scheduled_runs
      WHERE org_id = $1 AND initiator = $2 AND work_date = $3::date`,
    [canonicalKey.orgId, canonicalKey.initiator, canonicalKey.workDate],
  )
  const generation = Number((genResult.rows[0] as { max_gen: number | string }).max_gen) + 1

  const insertedResult = await trx.query(
    `INSERT INTO attendance_scheduled_runs (
        org_id, entrypoint, initiator, work_date, generation, accepted_write_posture,
        target_set_fingerprint, expected_user_count, review_count, state
      ) VALUES ($1,'scheduled',$2,$3::date,$4,$5,$6,$7,$8,'running')
      RETURNING run_id::text AS run_id, org_id, entrypoint, initiator,
                work_date::text AS work_date, generation, accepted_write_posture`,
    [
      canonicalKey.orgId,
      canonicalKey.initiator,
      canonicalKey.workDate,
      generation,
      org.acceptedWritePosture,
      fingerprint,
      expectedUserCount,
      reviewCount,
    ],
  )
  const runRow = insertedResult.rows[0] as {
    run_id: string
    org_id: string
    entrypoint: string
    initiator: string
    work_date: string
    generation: number
    accepted_write_posture: string
  }
  const runId = runRow.run_id

  for (const target of plan) {
    let operationId: string | null = null
    if (target.targetKind === 'generate') {
      const candidate = deriveAttendanceOperationCandidateIdentityV1({
        sourceKind: 'scheduled',
        scheduledRunId: runId,
        userId: target.userId,
        workDate: canonicalKey.workDate,
      })
      operationId = candidate.operationId
    }
    await trx.query(
      `INSERT INTO attendance_scheduled_run_targets (
          org_id, run_id, work_date, ordinal, user_id, target_kind, review_reason_code, operation_id
        ) VALUES ($1,$2::uuid,$3::date,$4,$5::uuid,$6,$7,$8::uuid)`,
      [
        canonicalKey.orgId,
        runId,
        canonicalKey.workDate,
        target.ordinal,
        target.userId,
        target.targetKind,
        target.reviewReasonCode,
        operationId,
      ],
    )
  }

  // Section 1.9: a run with zero `generate` targets has its own creation transaction BE the
  // finalization transaction — inline, same transaction, over the just-inserted row, via the
  // mint-from-inserted-row constructor (never rehydration: there is no separately-committed
  // row yet to re-read).
  if (expectedUserCount === 0) {
    const identity = mintAttendanceScheduledRunIdentityFromInsertedRowV1({
      runId: runRow.run_id,
      orgId: runRow.org_id,
      entrypoint: runRow.entrypoint,
      initiator: runRow.initiator,
      acceptedWritePosture: runRow.accepted_write_posture,
      workDate: runRow.work_date,
      generation: runRow.generation,
      targetSetFingerprint: fingerprint,
    })
    const folded = await finalizeAttendanceScheduledRunCoreV1(
      trx,
      identity,
      runId,
      canonicalKey.orgId,
      canonicalKey.workDate,
      plan,
      reviewCount,
    )
    return {
      kind: 'created_and_finalized',
      runId,
      generation,
      reviewCount: folded.reviewCount,
      generatedCount: folded.generatedCount,
    }
  }

  return { kind: 'created_running', runId, generation, expectedUserCount, reviewCount }
}

/**
 * Recovery-only exact-run resume. Unlike `createOrResumeAttendanceScheduledRunV1`, this
 * function can never allocate a generation. The pre-lock read only discovers and verifies
 * the durable class-01 key; authority is established by the class-00/class-01 locks and the
 * second `FOR UPDATE` read.
 */
export async function resumeAttendanceScheduledRunByExactIdV1(
  trx: AttendanceW4TransactionClientV1,
  key: AttendanceScheduledRunExactResumeKeyV1,
  resolveMembership: AttendanceScheduledRunMembershipResolverV1,
): Promise<AttendanceScheduledRunExactResumeOutcomeV1> {
  const canonicalKey = parseCanonicalAttendanceScheduledRunKeyV1({
    orgId: key.orgId,
    initiator: key.initiator,
    workDate: key.workDate,
  })
  const runId = parseUuidSyntax(key.runId, 'W4C2_SCHEDULED_RUN_ID_INVALID')
  requireRfc4122VariantVersion(runId, 'W4C2_SCHEDULED_RUN_ID_INVALID')

  await acquireAttendanceCalculationRolloutLock(trx, canonicalKey.orgId, 'shared')
  const posture = await resolveSegmentCalculationPosture(trx, canonicalKey.orgId)
  if (posture.writePosture === 'blocked') {
    return { kind: 'org_suspended_deferred' }
  }

  const preRead = await readScheduledRunByExactIdV1(trx, canonicalKey.orgId, runId, false)
  if (!preRead) fail('W4C2_SCHEDULED_RUN_NOT_FOUND')
  if (preRead.initiator !== canonicalKey.initiator || preRead.work_date !== canonicalKey.workDate) {
    fail('W4C2_SCHEDULED_RUN_RECOVERY_KEY_MISMATCH')
  }

  await acquireAttendanceScheduledRunLock(trx, canonicalKey)
  const existing = await readScheduledRunByExactIdV1(trx, canonicalKey.orgId, runId, true)
  if (!existing) fail('W4C2_SCHEDULED_RUN_NOT_FOUND')
  if (existing.initiator !== canonicalKey.initiator || existing.work_date !== canonicalKey.workDate) {
    fail('W4C2_SCHEDULED_RUN_RECOVERY_KEY_MISMATCH')
  }
  if (existing.state !== 'running') {
    if (existing.state !== 'completed' && existing.state !== 'abandoned') {
      fail('W4C2_SCHEDULED_RUN_STATE_INVALID')
    }
    return { kind: 'not_running', runId, state: existing.state }
  }

  const org = createVerifiedAttendanceOrgIdentityV1({ orgKey: canonicalKey.orgId, posture })
  return resumeAttendanceScheduledRunV1(trx, org, existing, resolveMembership)
}

/**
 * Section 1.7's resume protocol (steps 1-4; step 5's "attempt finalization" is the caller's
 * job — this function only reports readiness). Always called under the class-`00`/class-`01`
 * locks the run-creation transaction already holds, over the `FOR UPDATE` row it already read.
 */
async function resumeAttendanceScheduledRunV1(
  trx: AttendanceW4TransactionClientV1,
  org: VerifiedAttendanceOrgIdentityV1,
  existing: AttendanceScheduledRunRowShapeV1,
  resolveMembership: AttendanceScheduledRunMembershipResolverV1,
): Promise<AttendanceScheduledRunStartOutcomeV1> {
  // Step 2: frozen posture must equal the currently resolved posture.
  if (org.acceptedWritePosture !== existing.accepted_write_posture) {
    fail('W4C2_SCHEDULED_RUN_RESUME_POSTURE_MISMATCH')
  }

  // Step 3: recompute the target set; require byte equality with the frozen fingerprint.
  const members = await resolveMembership(trx, existing.org_id, existing.work_date)
  const plan = resolveAttendanceScheduledRunTargetSetV1(members)
  const recomputedFingerprint = computeAttendanceScheduledRunTargetSetFingerprintV1(
    { orgId: existing.org_id, initiator: existing.initiator, workDate: existing.work_date },
    plan,
  )
  if (recomputedFingerprint !== existing.target_set_fingerprint) {
    fail('W4C2_SCHEDULED_RUN_RESUME_TARGET_SET_DRIFT')
  }

  // Step 4: outstanding = generate targets with no row yet in the outcome table (O-3=(a)'s
  // terminal-evidence definition) — never an in-memory cursor.
  const outstandingResult = await trx.query(
    `SELECT t.id::text AS target_id, t.user_id, t.operation_id::text AS operation_id
       FROM attendance_scheduled_run_targets t
       LEFT JOIN attendance_scheduled_run_target_outcomes o
         ON o.org_id = t.org_id AND o.target_id = t.id
      WHERE t.org_id = $1 AND t.run_id = $2::uuid AND t.target_kind = 'generate' AND o.id IS NULL
      ORDER BY t.ordinal ASC`,
    [existing.org_id, existing.run_id],
  )
  const outstandingGenerateTargets = outstandingResult.rows.map((row) => {
    const r = row as { target_id: string; user_id: string; operation_id: string }
    return { targetId: r.target_id, userId: r.user_id, operationId: r.operation_id }
  })

  return {
    kind: 'resumed',
    runId: existing.run_id,
    generation: Number(existing.generation),
    outstandingGenerateTargets,
    readyToFinalize: outstandingGenerateTargets.length === 0,
  }
}

// ---------------------------------------------------------------------------
// Section 1.1.1 (O-3=(a)): the per-target terminal-outcome writer.
// ---------------------------------------------------------------------------

export type AttendanceScheduledRunTargetOutcomeInputV1 =
  | { readonly terminalOutcome: 'completed' }
  | { readonly terminalOutcome: 'failed'; readonly failureReasonCode: 'ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED' }

/**
 * `recordAttendanceScheduledRunTargetOutcomeV1(trx, operationWitness, outcome)` — section
 * 1.1.1's exact name. The only writer of `attendance_scheduled_run_target_outcomes`, gated on
 * a VERIFIED per-user operation witness for the exact target it writes: a caller cannot forge
 * an outcome through this helper for a target whose operation it does not already hold a
 * verified witness for. This is a TypeScript-encapsulation guarantee (module export
 * boundary), not a DB-level one — the disclosure section 1.1.1 states explicitly.
 *
 * P1-2 remediation (gate 12, second clause / section 1.7's fail-closed rule): a straggler
 * seal — a per-user operation transaction that reaches this writer after the run has already
 * left `running` (abandoned, or completed once every other target already finalized it) — is
 * rejected BEFORE this function's own `INSERT`, never silently recorded against a run the
 * state machine has already closed. This closes the writer's own DML, not the earlier,
 * per-user source DML gate 12 also names — that half lives on the still-uncut legacy
 * scheduled caller (`w4c2-live-scheduled-boundary.ts`), a separate, disclosed gap.
 */
export async function recordAttendanceScheduledRunTargetOutcomeV1(
  trx: AttendanceW4TransactionClientV1,
  operationWitness: unknown,
  outcome: AttendanceScheduledRunTargetOutcomeInputV1,
): Promise<void> {
  const verified: VerifiedAttendanceOperationIdentityV1 = requireVerifiedAttendanceOperationIdentityV1(operationWitness)
  if (verified.entrypoint !== 'scheduled' || verified.kind !== 'item') {
    fail('W4C2_SCHEDULED_RUN_OUTCOME_WITNESS_INVALID')
  }

  const invalidCode = 'W4C2_SCHEDULED_RUN_OUTCOME_INVALID'
  if (typeof outcome !== 'object' || outcome === null) fail(invalidCode)
  let terminalOutcome: 'completed' | 'failed'
  let failureReasonCode: string | null
  if ((outcome as { terminalOutcome?: unknown }).terminalOutcome === 'completed') {
    if (Object.keys(outcome as object).length !== 1) fail(invalidCode)
    terminalOutcome = 'completed'
    failureReasonCode = null
  } else if ((outcome as { terminalOutcome?: unknown }).terminalOutcome === 'failed') {
    const keys = Object.keys(outcome as object)
    if (keys.length !== 2 || !keys.includes('failureReasonCode')) fail(invalidCode)
    const reason = (outcome as { failureReasonCode?: unknown }).failureReasonCode
    if (reason !== 'ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED') fail('W4C2_SCHEDULED_RUN_OUTCOME_REASON_INVALID')
    terminalOutcome = 'failed'
    failureReasonCode = reason
  } else {
    fail(invalidCode)
  }

  const targetResult = await trx.query(
    `SELECT t.id::text AS id, t.run_id::text AS run_id, r.state AS run_state
       FROM attendance_scheduled_run_targets t
       JOIN attendance_scheduled_runs r ON r.run_id = t.run_id AND r.org_id = t.org_id
      WHERE t.org_id = $1 AND t.operation_id = $2::uuid AND t.target_kind = 'generate'`,
    [verified.org.orgId, verified.id],
  )
  if (targetResult.rows.length !== 1) fail('W4C2_SCHEDULED_RUN_OUTCOME_TARGET_NOT_FOUND')
  const targetRow = targetResult.rows[0] as { id: string; run_id: string; run_state: string }
  // Gate 12 / section 1.7: a target row can only ever reference a run that exists (fk_asrt_run)
  // — the DB enforces "non-existent run" for us — but the run's CURRENT state is not part of
  // that FK, so "non-`running` run" must be checked here, before the INSERT below.
  if (targetRow.run_state !== 'running') fail('W4C2_SCHEDULED_RUN_OUTCOME_RUN_NOT_RUNNING')

  await trx.query(
    `INSERT INTO attendance_scheduled_run_target_outcomes (
        org_id, run_id, target_id, terminal_outcome, failure_reason_code
      ) VALUES ($1,$2::uuid,$3::uuid,$4,$5)`,
    [verified.org.orgId, targetRow.run_id, targetRow.id, terminalOutcome, failureReasonCode],
  )
}

/**
 * Section 1.7's fail-closed rule, first half (the caller-cutover slice that wires the
 * durable machine into the live scheduled entrypoint, `w4c2-live-scheduled-boundary.ts`):
 * "a scheduled per-user operation whose `source_root_id` has no committed
 * `attendance_scheduled_runs` row, or whose run is not `running`, is rejected **before**
 * source DML." `recordAttendanceScheduledRunTargetOutcomeV1` above already closes the
 * SAME check for its own `INSERT` (the writer's own DML) — this is the earlier half, called
 * by the per-user operation transaction immediately after the operation identity is minted
 * and BEFORE the boundary's own legacy-DML adapter call, so a straggler (a per-user
 * transaction that reaches this point after the run has already left `running` — abandoned,
 * or completed once every other target already finalized it) can never write the absence
 * row at all, not merely fail to record its outcome afterward. Values-free: the caller's
 * `runId`/`orgId` are never echoed in the rejection.
 */
export async function requireAttendanceScheduledRunRunningBeforeSourceDmlV1(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  runId: string,
): Promise<void> {
  const result = await trx.query(
    `SELECT state FROM attendance_scheduled_runs WHERE org_id = $1 AND run_id = $2::uuid`,
    [orgId, runId],
  )
  if (result.rows.length !== 1) fail('W4C2_SCHEDULED_RUN_NOT_RUNNING_BEFORE_SOURCE_DML')
  const state = (result.rows[0] as { state: string }).state
  if (state !== 'running') fail('W4C2_SCHEDULED_RUN_NOT_RUNNING_BEFORE_SOURCE_DML')
}

// ---------------------------------------------------------------------------
// Section 1.8: finalization transaction (shared core + standalone entry point) plus the
// section 1.7 "no stuck absorbing state" recovery-sweep step function.
// ---------------------------------------------------------------------------

interface AttendanceScheduledRunPlanEntryLikeV1 {
  readonly ordinal: number
  readonly userId: string
  readonly targetKind: string
  readonly reviewReasonCode: string | null
}

/**
 * Steps 5-9 of section 1.8, shared verbatim by the zero-`generate`-target inline path
 * (section 1.9) and the standalone finalization transaction below — "not a third transaction
 * shape."
 */
async function finalizeAttendanceScheduledRunCoreV1(
  trx: AttendanceW4TransactionClientV1,
  identity: VerifiedAttendanceScheduledRunIdentityV1,
  runId: string,
  orgId: string,
  workDate: string,
  plan: readonly AttendanceScheduledRunPlanEntryLikeV1[],
  reviewCount: number,
): Promise<{ completedUserCount: number; generatedCount: number; reviewCount: number }> {
  const generateTargets = plan.filter((t) => t.targetKind === 'generate')
  let completedUserCount = 0
  let generatedCount = 0
  if (generateTargets.length > 0) {
    const foldResult = await trx.query(
      `SELECT count(*) FILTER (WHERE o.terminal_outcome = 'completed') AS completed_count,
              count(*) FILTER (WHERE o.terminal_outcome = 'completed'
                                     AND (r.response_snapshot ->> 'inserted') = 'true') AS generated_count
         FROM attendance_scheduled_run_targets t
         JOIN attendance_scheduled_run_target_outcomes o
           ON o.org_id = t.org_id AND o.target_id = t.id
         LEFT JOIN attendance_result_operations r
           ON r.org_id = t.org_id AND r.entrypoint = 'scheduled' AND r.operation_id = t.operation_id
        WHERE t.org_id = $1 AND t.run_id = $2::uuid AND t.target_kind = 'generate'`,
      [orgId, runId],
    )
    const row = foldResult.rows[0] as { completed_count: string | number; generated_count: string | number }
    completedUserCount = Number(row.completed_count)
    generatedCount = Number(row.generated_count)
  }

  const reasons = plan
    .filter((t) => t.targetKind === 'review')
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((t) => ({ userId: t.userId, reasonCode: t.reviewReasonCode }))

  const ABSENCE_KIND = 'attendance.absence.generated'
  const REVIEW_KIND = 'attendance.work_date.review_required'
  const events: AttendanceOutboxEventInputV1[] = [
    {
      eventKind: ABSENCE_KIND,
      payload: { orgId, workDate, total: generatedCount },
      payloadSchemaVersion: 1,
      businessKeyFingerprint: computeAttendanceScheduledRunEventBusinessKeyFingerprintV1(
        ABSENCE_KIND,
        orgId,
        workDate,
        runId,
      ),
    },
  ]
  if (reviewCount > 0) {
    events.push({
      eventKind: REVIEW_KIND,
      payload: { orgId, workDate, total: reviewCount, reasons },
      payloadSchemaVersion: 1,
      businessKeyFingerprint: computeAttendanceScheduledRunEventBusinessKeyFingerprintV1(
        REVIEW_KIND,
        orgId,
        workDate,
        runId,
      ),
    })
  }

  // Steps 7-8: outbox insert(s) and the state flip are the SAME transaction (gate 8) — this
  // function issues no BEGIN/COMMIT itself; the caller's SERIALIZABLE wrapper owns the boundary.
  await enqueueAttendanceScheduledRunEventOutboxV1(trx, identity, events)

  await trx.query(
    `UPDATE attendance_scheduled_runs
        SET state = 'completed', completed_user_count = $3, generated_count = $4, finalized_at = now()
      WHERE org_id = $1 AND run_id = $2::uuid AND state = 'running'`,
    [orgId, runId, completedUserCount, generatedCount],
  )

  return { completedUserCount, generatedCount, reviewCount }
}

export interface AttendanceScheduledRunTargetIdentifierV1 {
  readonly orgId: string
  readonly initiator: CanonicalAttendanceScheduledRunInitiatorV1
  readonly workDate: string
  readonly runId: string
}

export type AttendanceScheduledRunFinalizationOutcomeV1 =
  | { readonly kind: 'deferred'; readonly code: 'ATTENDANCE_SCHEDULED_RUN_FINALIZATION_DEFERRED' }
  | { readonly kind: 'not_running'; readonly state: 'completed' | 'abandoned' }
  | { readonly kind: 'not_ready' }
  | {
      readonly kind: 'finalized'
      readonly runId: string
      readonly completedUserCount: number
      readonly generatedCount: number
      readonly reviewCount: number
    }

/**
 * Section 1.8, the standalone finalization transaction (steps 1-9). Intended to run as the
 * `body` of `runAttendanceResultOperationTransactionV1`. Never acquires class-`11`, never
 * issues source DML (gate 15).
 */
export async function finalizeAttendanceScheduledRunV1(
  trx: AttendanceW4TransactionClientV1,
  target: AttendanceScheduledRunTargetIdentifierV1,
): Promise<AttendanceScheduledRunFinalizationOutcomeV1> {
  const canonicalKey = parseCanonicalAttendanceScheduledRunKeyV1({
    orgId: target.orgId,
    initiator: target.initiator,
    workDate: target.workDate,
  })
  const runId = parseUuidSyntax(target.runId, 'W4C2_SCHEDULED_RUN_ID_INVALID')

  // Step 1: class-00 shared; resolve posture; the `blocked` branch (W4C-R43) is retryable,
  // zero-DML, and distinct from a terminal remediation outcome.
  await acquireAttendanceCalculationRolloutLock(trx, canonicalKey.orgId, 'shared')
  const posture = await resolveSegmentCalculationPosture(trx, canonicalKey.orgId)
  if (posture.writePosture === 'blocked') {
    return { kind: 'deferred', code: 'ATTENDANCE_SCHEDULED_RUN_FINALIZATION_DEFERRED' }
  }

  // Step 2: class-01 run key lock.
  await acquireAttendanceScheduledRunLock(trx, canonicalKey)

  // Step 3: SELECT ... FOR UPDATE.
  const rowResult = await trx.query(
    `SELECT run_id::text AS run_id, org_id, entrypoint, initiator, work_date::text AS work_date,
            generation, accepted_write_posture, target_set_fingerprint, review_count, state
       FROM attendance_scheduled_runs
      WHERE org_id = $1 AND run_id = $2::uuid
      FOR UPDATE`,
    [canonicalKey.orgId, runId],
  )
  if (rowResult.rows.length === 0) fail('W4C2_SCHEDULED_RUN_NOT_FOUND')
  const row = rowResult.rows[0] as {
    run_id: string
    org_id: string
    entrypoint: string
    initiator: string
    work_date: string
    generation: number
    accepted_write_posture: string
    target_set_fingerprint: string
    review_count: number | string
    state: string
  }

  // "Not running" (already completed OR already abandoned, round-7 F3 fix): return the
  // recorded outcome with zero DML — normal, expected, never thrown.
  if (row.state !== 'running') {
    if (row.state !== 'completed' && row.state !== 'abandoned') fail('W4C2_SCHEDULED_RUN_STATE_INVALID')
    return { kind: 'not_running', state: row.state as 'completed' | 'abandoned' }
  }

  // Posture-mismatch fail-closed backstop (section 1.8 step 1's third branch; `O-4=(a)`
  // extends the promotion-block predicate so this is practically unreachable in ordinary
  // operation, but remains the backstop this branch states).
  if (posture.writePosture !== row.accepted_write_posture) {
    fail('W4C2_SCHEDULED_RUN_FINALIZATION_POSTURE_MISMATCH')
  }

  // Step 4: terminal-evidence check (O-3=(a): a row in the outcome table).
  const targetsResult = await trx.query(
    `SELECT t.ordinal, t.user_id, t.target_kind, t.review_reason_code, o.terminal_outcome
       FROM attendance_scheduled_run_targets t
       LEFT JOIN attendance_scheduled_run_target_outcomes o
         ON o.org_id = t.org_id AND o.target_id = t.id
      WHERE t.org_id = $1 AND t.run_id = $2::uuid
      ORDER BY t.ordinal ASC`,
    [canonicalKey.orgId, runId],
  )
  const targetRows = targetsResult.rows as Array<{
    ordinal: number
    user_id: string
    target_kind: string
    review_reason_code: string | null
    terminal_outcome: string | null
  }>
  const notReady = targetRows.some((t) => t.target_kind === 'generate' && t.terminal_outcome === null)
  if (notReady) {
    return { kind: 'not_ready' }
  }

  const identity = rehydrateVerifiedAttendanceScheduledRunIdentityV1({
    runId: row.run_id,
    orgId: row.org_id,
    entrypoint: row.entrypoint,
    initiator: row.initiator,
    acceptedWritePosture: row.accepted_write_posture,
    workDate: row.work_date,
    generation: row.generation,
    targetSetFingerprint: row.target_set_fingerprint,
  })

  const plan: AttendanceScheduledRunPlanEntryLikeV1[] = targetRows.map((t) => ({
    ordinal: Number(t.ordinal),
    userId: t.user_id,
    targetKind: t.target_kind,
    reviewReasonCode: t.review_reason_code,
  }))

  const folded = await finalizeAttendanceScheduledRunCoreV1(
    trx,
    identity,
    runId,
    canonicalKey.orgId,
    canonicalKey.workDate,
    plan,
    Number(row.review_count),
  )

  return {
    kind: 'finalized',
    runId,
    completedUserCount: folded.completedUserCount,
    generatedCount: folded.generatedCount,
    reviewCount: folded.reviewCount,
  }
}

// ---------------------------------------------------------------------------
// Section 1.7, "no stuck absorbing state" — the recovery-sweep scan + one-candidate step.
// ---------------------------------------------------------------------------

export interface AttendanceScheduledRunSweepCandidateV1 {
  readonly orgId: string
  readonly initiator: CanonicalAttendanceScheduledRunInitiatorV1
  readonly workDate: string
  readonly runId: string
}

/**
 * Section 1.7's scan predicate — `state = 'running'`, deliberately NOT scoped to today's
 * `work_date` (a run stranded on a prior calendar day must still be visible), bounded by
 * `limit`.
 *
 * #4770 fairness fix: the prior fixed-prefix form (`ORDER BY created_at ASC LIMIT $1`, no
 * write-back) let the oldest N candidates occupy the scan window on EVERY tick forever if they
 * never reach a terminal state — candidate N+1 could starve indefinitely. This is a durable
 * ROTATION, not an `OFFSET` (owner constraint: `OFFSET` is unstable once rows leave `running`
 * concurrently — an offset computed against one tick's row count is meaningless against the
 * next tick's shrunken/grown set). The scan and the write-back happen in the SAME statement
 * (`UPDATE ... WHERE run_id IN (SELECT ...)`), so the rotation is durable across ticks/process
 * restarts, not an in-memory cursor: every candidate this tick selects has its
 * `last_attempt_at` stamped to `now()` in the same statement, which demotes it below any
 * candidate this tick did NOT reach (`NULLS FIRST` keeps never-attempted rows — including
 * brand-new ones — ahead of anything already attempted). Steady state (backlog <= limit)
 * selects the SAME candidate SET the old fixed-prefix query did: every row starts
 * `last_attempt_at IS NULL`, so the `created_at ASC` tiebreak alone decides which rows the
 * inner `ORDER BY ... LIMIT` picks. It does NOT guarantee the same RETURNED order —
 * PostgreSQL does not promise `UPDATE ... RETURNING` preserves a subquery's `ORDER BY`, so
 * downstream processing order is not oldest-first even in steady state (each candidate is its
 * own independent transaction below and nothing here depends on order).
 *
 * #4774 fix (gate P1-1/P2-2): the inner `SELECT` carries `FOR UPDATE SKIP LOCKED`. Without it,
 * this query was a row-lock WAITER — any concurrent holder of a row lock on one selected
 * `running` row (the sweep's OWN per-candidate `finalizeAttendanceScheduledRunV1`/
 * `abandonAttendanceScheduledRunV1` step-3 `SELECT ... FOR UPDATE`, or a second concurrent scan
 * worker) blocked this `UPDATE` until `lock_timeout` (5000ms) aborted it with `55P03` — a
 * SQLSTATE `isRetryableSqlState()` does not cover — which propagated out of
 * `sweepAttendanceScheduledRunsOnceV1` (whose scan transaction sits OUTSIDE the per-candidate
 * try/catch) and killed the ENTIRE tick, 0 candidates processed. `FOR UPDATE SKIP LOCKED` is
 * the standard durable-queue claim idiom: a currently-locked row is simply excluded from THIS
 * tick's candidate set (never stamped, never counted as `errored`) and remains at the front of
 * the rotation (`last_attempt_at IS NULL`) to be retried next tick — fully compatible with the
 * fairness rotation above, and restores section 1.7's containment invariant for the scan phase
 * ("one stuck candidate cannot block the others in the same scan"). It also makes two
 * concurrent scan workers claim disjoint candidate sets instead of duplicating work (a locked
 * row is skipped by the other worker's scan rather than raced/retried onto the same rows) — see
 * `attendance-w4c2-sweep-fairness.db.test.ts`'s "tick-level containment under a concurrent row
 * lock" and "multi-worker exclusivity" regression guards.
 */
export async function scanAttendanceScheduledRunSweepCandidatesV1(
  trx: AttendanceW4TransactionClientV1,
  limit: number,
): Promise<readonly AttendanceScheduledRunSweepCandidateV1[]> {
  if (!Number.isInteger(limit) || limit < 1) fail('W4C2_SCHEDULED_RUN_SWEEP_LIMIT_INVALID')
  const result = await trx.query(
    `UPDATE attendance_scheduled_runs
        SET last_attempt_at = now()
      WHERE run_id IN (
        SELECT run_id
          FROM attendance_scheduled_runs
         WHERE state = 'running'
         ORDER BY last_attempt_at ASC NULLS FIRST, created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING org_id, initiator, work_date::text AS work_date, run_id::text AS run_id`,
    [limit],
  )
  return result.rows.map((row) => {
    const r = row as { org_id: string; initiator: string; work_date: string; run_id: string }
    return {
      orgId: r.org_id,
      initiator: r.initiator as CanonicalAttendanceScheduledRunInitiatorV1,
      workDate: r.work_date,
      runId: r.run_id,
    }
  })
}

export type AttendanceScheduledRunSweepStepOutcomeV1 =
  | { readonly kind: 'finalized'; readonly runId: string }
  | { readonly kind: 'not_ready'; readonly runId: string }
  | { readonly kind: 'skipped'; readonly runId: string; readonly reason: string }

/**
 * One candidate's worth of the sweep. Section 1.7 describes two branches ("not yet terminal"
 * -> resume; "all terminal" -> finalize) that are "already fully specified elsewhere in this
 * section" — this function reuses `finalizeAttendanceScheduledRunV1` verbatim rather than
 * inventing a third transaction shape: `not_ready` IS the "resume" branch's terminal-evidence
 * signal. The worker then invokes the plugin-owned context builder and its recovery-only
 * exact-run boundary for the actual per-user replay. Intended to run as ONE candidate per its OWN
 * `runAttendanceResultOperationTransactionV1` call, never batched, so one stuck candidate
 * cannot block the others in the same scan.
 */
export async function sweepAttendanceScheduledRunCandidateV1(
  trx: AttendanceW4TransactionClientV1,
  candidate: AttendanceScheduledRunSweepCandidateV1,
): Promise<AttendanceScheduledRunSweepStepOutcomeV1> {
  const outcome = await finalizeAttendanceScheduledRunV1(trx, candidate)
  if (outcome.kind === 'finalized') return { kind: 'finalized', runId: candidate.runId }
  if (outcome.kind === 'not_ready') return { kind: 'not_ready', runId: candidate.runId }
  if (outcome.kind === 'deferred') return { kind: 'skipped', runId: candidate.runId, reason: 'org_blocked' }
  return { kind: 'skipped', runId: candidate.runId, reason: outcome.kind }
}

// ---------------------------------------------------------------------------
// Section 1.1.2: the `abandoned` transition.
// ---------------------------------------------------------------------------

const ABANDON_ACTOR_POSTURES = ['platform_admin', 'attendance_admin'] as const
const ABANDON_REASON_CODES = ['ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED'] as const
export type AttendanceScheduledRunAbandonReasonCodeV1 = (typeof ABANDON_REASON_CODES)[number]

export interface AttendanceScheduledRunAbandonKeyV1 {
  readonly orgId: string
  readonly runId: string
}

export type AttendanceScheduledRunAbandonOutcomeV1 =
  | { readonly kind: 'deferred'; readonly code: 'ATTENDANCE_SCHEDULED_RUN_ABANDON_DEFERRED' }
  | { readonly kind: 'not_running'; readonly state: 'completed' | 'abandoned' }
  | { readonly kind: 'abandoned'; readonly runId: string; readonly completedUserCount: number }

/**
 * Section 1.1.2: `abandonAttendanceScheduledRunV1(trx, callerIdentity, key, reasonCode)` — the
 * sole intended writer of the `running -> abandoned` transition. Authorization is evaluated
 * BEFORE any lock (fail-closed, zero DML, zero lock contention on rejection). `callerIdentity`
 * is the branded `AuthorizedAttendanceWriteContextV1` witness (w4c0-authorization.ts) —
 * reusing that module's existing digest-verified mint/verify mechanics rather than a parallel
 * implementation.
 */
export async function abandonAttendanceScheduledRunV1(
  trx: AttendanceW4TransactionClientV1,
  callerIdentity: unknown,
  key: AttendanceScheduledRunAbandonKeyV1,
  reasonCode: AttendanceScheduledRunAbandonReasonCodeV1,
): Promise<AttendanceScheduledRunAbandonOutcomeV1> {
  const verifiedCaller: AuthorizedAttendanceWriteContextV1 = verifyAuthorizedAttendanceWriteContextV1(callerIdentity)

  if (verifiedCaller.capability !== 'retirement') {
    throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  }
  if (!(ABANDON_ACTOR_POSTURES as readonly string[]).includes(verifiedCaller.actorPosture)) {
    throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  }
  if (!(ABANDON_REASON_CODES as readonly string[]).includes(reasonCode)) {
    fail('W4C2_SCHEDULED_RUN_ABANDON_REASON_INVALID')
  }

  // Org anchor: the run's org is compared against the CALLER IDENTITY's verified org, never a
  // caller-supplied `key.orgId` alone — a mismatch is rejected in the same not-found shape as
  // a nonexistent run (gate 13 cross-org isolation), before any lock.
  if (key.orgId !== verifiedCaller.orgId) {
    throw new AttendanceW4OperationError('ATTENDANCE_SCHEDULED_RUN_NOT_FOUND')
  }
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(verifiedCaller.orgId) as CanonicalAttendanceRolloutOrgKeyV1
  const runId = parseUuidSyntax(key.runId, 'W4C2_SCHEDULED_RUN_ID_INVALID')

  // Lock order identical to finalization: class-00 shared, resolve posture.
  await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
  const posture = await resolveSegmentCalculationPosture(trx, orgKey)
  if (posture.writePosture === 'blocked') {
    return { kind: 'deferred', code: 'ATTENDANCE_SCHEDULED_RUN_ABANDON_DEFERRED' }
  }

  // A non-locking read to discover (initiator, workDate) for the class-01 key — confers no
  // authority (same doctrine as the existing pre-lock candidate read), org-scoped.
  const preRead = await trx.query(
    `SELECT initiator, work_date::text AS work_date FROM attendance_scheduled_runs
      WHERE org_id = $1 AND run_id = $2::uuid`,
    [orgKey, runId],
  )
  if (preRead.rows.length === 0) throw new AttendanceW4OperationError('ATTENDANCE_SCHEDULED_RUN_NOT_FOUND')
  const preReadRow = preRead.rows[0] as { initiator: string; work_date: string }

  const canonicalKey = parseCanonicalAttendanceScheduledRunKeyV1({
    orgId: orgKey,
    initiator: preReadRow.initiator,
    workDate: preReadRow.work_date,
  })
  await acquireAttendanceScheduledRunLock(trx, canonicalKey)

  const rowResult = await trx.query(
    `SELECT run_id::text AS run_id, state FROM attendance_scheduled_runs
      WHERE org_id = $1 AND run_id = $2::uuid
      FOR UPDATE`,
    [orgKey, runId],
  )
  if (rowResult.rows.length === 0) throw new AttendanceW4OperationError('ATTENDANCE_SCHEDULED_RUN_NOT_FOUND')
  const row = rowResult.rows[0] as { run_id: string; state: string }

  // Idempotency / concurrency: a second call (any state other than `running`) returns the
  // recorded outcome with zero DML — the same branch shape as finalization's losing racer.
  if (row.state !== 'running') {
    if (row.state !== 'completed' && row.state !== 'abandoned') fail('W4C2_SCHEDULED_RUN_STATE_INVALID')
    return { kind: 'not_running', state: row.state as 'completed' | 'abandoned' }
  }

  // Fold completed_user_count from currently-recorded evidence, exactly as finalization step 5
  // does — never an in-memory count.
  const foldResult = await trx.query(
    `SELECT count(*) FILTER (WHERE o.terminal_outcome = 'completed') AS completed_count
       FROM attendance_scheduled_run_targets t
       JOIN attendance_scheduled_run_target_outcomes o
         ON o.org_id = t.org_id AND o.target_id = t.id
      WHERE t.org_id = $1 AND t.run_id = $2::uuid AND t.target_kind = 'generate'`,
    [orgKey, runId],
  )
  const completedUserCount = Number((foldResult.rows[0] as { completed_count: string | number }).completed_count)

  await trx.query(
    `UPDATE attendance_scheduled_runs
        SET state = 'abandoned', completed_user_count = $3, abandon_reason_code = $4,
            abandoned_by_actor_posture = $5, finalized_at = now()
      WHERE org_id = $1 AND run_id = $2::uuid AND state = 'running'`,
    [orgKey, runId, completedUserCount, reasonCode, verifiedCaller.actorPosture],
  )

  return { kind: 'abandoned', runId, completedUserCount }
}
