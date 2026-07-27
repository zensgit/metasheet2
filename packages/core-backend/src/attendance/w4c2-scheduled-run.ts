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
 * run-creation, resume, and finalization transactions". This slice (P1-2, the schema/
 * identity/enqueue half of section 4 step 3) ships the identity type, both
 * module-private constructors, and the run-scoped enqueue surface. The run-creation,
 * resume, finalization, and `abandoned`-transition transactions (section 1.1.2, 1.7, 1.8)
 * are a LATER slice — they land IN THIS SAME FILE, not a new module, so the "neither
 * constructor is exported outside the module" exclusivity claim this file makes stays true
 * across that follow-up.
 *
 * ZERO caller cutover: nothing in production imports this module yet. `deriveAttendanceScheduledRunIdV1`
 * (w4c2-live-scheduled-boundary.ts) is the held branch's SUPERSEDED derivation — section
 * 1.1's "must not survive implementation" rule — and is retired when the run-creation
 * transaction (the later slice) replaces its caller; this file does not touch that
 * function.
 *
 * Values-free discipline: every throw is a closed code string only, never the offending
 * input bytes.
 */
import type {
  AttendanceW4TransactionClientV1,
  Brand,
  CanonicalAttendanceScheduledRunInitiatorV1,
  CanonicalAttendanceWorkDateV1,
  VerifiedAttendanceOrgIdentityV1,
} from './w4c0-identity'
import { parseCanonicalAttendanceWorkDateV1, rehydrateVerifiedAttendanceOrgIdentityV1 } from './w4c0-identity'
import { ATTENDANCE_W4_SCHEDULED_RUN_OUTBOX_EVENT_KINDS_V1 } from './w4c0-operation-contract'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import type { AttendanceOutboxEventInputV1 } from './w4c0-operation-registry'

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

// Module-private reference so neither constructor above is flagged as dead code before the
// run-creation/resume/finalization transactions (a later slice, same module) call them.
// This reference does NOT create an external call path — it is itself unexported.
const __w4c2ScheduledRunConstructors = {
  rehydrateVerifiedAttendanceScheduledRunIdentityV1,
  mintAttendanceScheduledRunIdentityFromInsertedRowV1,
} as const
void __w4c2ScheduledRunConstructors

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
