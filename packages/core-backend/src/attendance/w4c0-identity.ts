/**
 * W4C-0 (#4556) Stage B — TS identity / advisory-lock / posture layer.
 *
 * Authority:
 *  - docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md
 *    (RATIFIED; sections 4.1 canonical parsers/namespaces, 8.2 lock order, 9 key builders,
 *    acquisition helpers, rollout posture resolver, 12.1 gates), and
 *  - docs/development/attendance-issue-4556-w4c0-identity-proof-amendment-20260725.md
 *    (RATIFIED, OD-W4C-43=(a); closed verified-identity factories, durable source proof,
 *    closed source matrix, TS/SQL UUIDv5 golden parity).
 *
 * This module is the single home of the closed identity layer. Everything that proves
 * "these bytes were admitted by the locked contract" lives behind module-private WeakSets:
 * a verified identity is an in-process opaque witness. Serialization (JSON clone, spread,
 * structuredClone, queue/DB round trip) intentionally destroys the witness — a reader must
 * call `rehydrateVerifiedAttendanceOperationIdentityV1` against the complete durable proof
 * before any advisory builder accepts the identity again.
 *
 * W4C-0 ships NO caller cutover: nothing in production imports this module yet. The
 * existing W3 shift-service constant (`SEGMENT_CALCULATION_IMPLEMENTED = false` in
 * plugins/plugin-attendance/lib/attendance-shift-service.cjs) is untouched; consumers are
 * cut over to `resolveSegmentCalculationPosture` in later W4C slices.
 *
 * Error discipline: every throw is values-free — a closed `code` string only, never the
 * offending input bytes.
 */
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Branded scalar types (lock section 4.1; amendment section 1).
// ---------------------------------------------------------------------------

declare const CanonicalBrand: unique symbol
export type Brand<T, B extends string> = T & { readonly [CanonicalBrand]: B }

export type CanonicalAttendanceOrgKeyV1 = Brand<string, 'CanonicalAttendanceOrgKeyV1'>
export type CanonicalAttendanceRolloutOrgKeyV1 = Brand<string, 'CanonicalAttendanceRolloutOrgKeyV1'>
export type CanonicalAttendanceOperationIdV1 = Brand<string, 'CanonicalAttendanceOperationIdV1'>
export type CanonicalAttendanceUserIdV1 = Brand<string, 'CanonicalAttendanceUserIdV1'>
export type CanonicalAttendanceWorkDateV1 = Brand<string, 'CanonicalAttendanceWorkDateV1'>

declare const W4C0Opaque: unique symbol
type Opaque<T, B extends string> = T & { readonly [W4C0Opaque]: B }

// ---------------------------------------------------------------------------
// Closed enums (lock sections 4.1/9; amendment section 1).
// ---------------------------------------------------------------------------

export const ATTENDANCE_SOURCE_ENTRYPOINTS_V1 = Object.freeze([
  'live_punch',
  'request_create',
  'request_pending_edit',
  'request_decision',
  'request_cancel',
  'import_batch',
  'integration_batch',
  'scheduled',
  'manual_edit',
  'recompute',
  'import_rollback',
  'ops_retirement',
] as const)
export type AttendanceSourceEntrypointV1 = (typeof ATTENDANCE_SOURCE_ENTRYPOINTS_V1)[number]

export const ATTENDANCE_ACCEPTED_WRITE_POSTURES_V1 = Object.freeze([
  'legacy_projection_only',
  'shadow',
  'authoritative',
] as const)
export type AttendanceAcceptedWritePostureV1 = (typeof ATTENDANCE_ACCEPTED_WRITE_POSTURES_V1)[number]

export const ATTENDANCE_ROLLOUT_STATES_V1 = Object.freeze([
  'legacy',
  'shadow',
  'eligible',
  'authoritative',
  'suspended',
] as const)
export type AttendanceRolloutStateV1 = (typeof ATTENDANCE_ROLLOUT_STATES_V1)[number]

// Amendment section 1.3 / lock section 4.1: the three literal namespace UUIDs — the only
// accepted UUIDv5 namespaces (byte-identical constants also live in the Stage A migration's
// SQL boundary; the golden-parity gate pins both sides).
export const ATTENDANCE_IMPORT_ITEM_NAMESPACE_V1 = '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'
export const ATTENDANCE_INTEGRATION_ITEM_NAMESPACE_V1 = '46501375-c273-459f-a5af-f926859f6411'
export const ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1 = 'e4363171-f53f-47d7-a074-607ef3fad391'

/** attendance_result_operations.input_ordinal is int4; the TS boundary mirrors that bound. */
export const ATTENDANCE_W4_MAX_ITEM_ORDINAL = 2147483647

// ---------------------------------------------------------------------------
// Values-free error type.
// ---------------------------------------------------------------------------

export class AttendanceW4IdentityError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4IdentityError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4IdentityError(code)
}

// ---------------------------------------------------------------------------
// Canonical scalar parsers (lock section 4.1).
// ---------------------------------------------------------------------------

const UUID_SYNTAX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const LOWER_HEX_64 = /^[0-9a-f]{64}$/
const CANONICAL_ORDINAL = /^(0|[1-9][0-9]*)$/
const WORK_DATE_SYNTAX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

/**
 * Exact RFC 4122 8-4-4-4-12 hexadecimal form; rejects whitespace, braces, URN prefixes,
 * non-ASCII lookalikes, NUL, and non-string values; emits lowercase ASCII. The explicit
 * length check closes the JS `$`-matches-before-final-newline trap.
 */
function parseUuidSyntax(input: unknown, code: string): string {
  if (typeof input !== 'string') fail(code)
  if (input.length !== 36) fail(code)
  if (!UUID_SYNTAX.test(input)) fail(code)
  return input.toLowerCase()
}

/** RFC 4122 variant/version check for a direct-source client/operator/web UUID. */
function requireRfc4122VariantVersion(canonicalUuid: string, code: string): void {
  const version = canonicalUuid.charCodeAt(14) - 0x30 // position 14 = version nibble
  if (version < 1 || version > 5) fail(code)
  const variant = canonicalUuid[19]
  if (variant !== '8' && variant !== '9' && variant !== 'a' && variant !== 'b') fail(code)
}

function parseOrgKeyLexical(input: unknown, code: string): string {
  if (typeof input !== 'string') fail(code)
  if (input === 'default') return 'default' // exact ASCII sentinel; no whitespace/case alias
  return parseUuidSyntax(input, code)
}

/** Section 4.1 `CanonicalAttendanceOrgKeyV1` parser (canonical UUID or exact `default`). */
export function parseCanonicalAttendanceOrgKeyV1(input: unknown): CanonicalAttendanceOrgKeyV1 {
  return parseOrgKeyLexical(input, 'W4C0_ORG_KEY_INVALID') as CanonicalAttendanceOrgKeyV1
}

/**
 * Amendment section 1.2: the lexical PRE-LOCK rollout-org parser. Its output is sufficient
 * to derive and acquire the class-`00` rollout lock without claiming a posture.
 */
export function parseCanonicalAttendanceRolloutOrgKeyV1(input: unknown): CanonicalAttendanceRolloutOrgKeyV1 {
  return parseOrgKeyLexical(input, 'W4C0_ROLLOUT_ORG_KEY_INVALID') as CanonicalAttendanceRolloutOrgKeyV1
}

export function parseCanonicalAttendanceUserIdV1(input: unknown): CanonicalAttendanceUserIdV1 {
  return parseUuidSyntax(input, 'W4C0_USER_ID_INVALID') as CanonicalAttendanceUserIdV1
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** Calendar-valid ASCII `YYYY-MM-DD`; no whitespace or alternate Unicode digits. */
export function parseCanonicalAttendanceWorkDateV1(input: unknown): CanonicalAttendanceWorkDateV1 {
  const code = 'W4C0_WORK_DATE_INVALID'
  if (typeof input !== 'string') fail(code)
  if (input.length !== 10) fail(code)
  if (!WORK_DATE_SYNTAX.test(input)) fail(code)
  const year = Number(input.slice(0, 4))
  const month = Number(input.slice(5, 7))
  const day = Number(input.slice(8, 10))
  if (month < 1 || month > 12) fail(code)
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const maxDay = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]
  if (day < 1 || day > maxDay) fail(code)
  return input as CanonicalAttendanceWorkDateV1
}

/** Base-10 ASCII unsigned ordinal, no sign, no leading zero except `0`; int4-bounded. */
function parseCanonicalOrdinal(input: unknown): string {
  const code = 'W4C0_ORDINAL_INVALID'
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 0 || input > ATTENDANCE_W4_MAX_ITEM_ORDINAL) fail(code)
    return String(input)
  }
  if (typeof input !== 'string') fail(code)
  if (input.length === 0 || input.length > 10) fail(code)
  if (!CANONICAL_ORDINAL.test(input)) fail(code)
  if (Number(input) > ATTENDANCE_W4_MAX_ITEM_ORDINAL) fail(code)
  return input
}

/** Exactly 64 lowercase hexadecimal bytes. */
function parseSemanticFingerprint(input: unknown): string {
  const code = 'W4C0_SEMANTIC_FINGERPRINT_INVALID'
  if (typeof input !== 'string') fail(code)
  if (input.length !== 64) fail(code)
  if (!LOWER_HEX_64.test(input)) fail(code)
  return input
}

// ---------------------------------------------------------------------------
// Strict object intake (exact own enumerable string keys; no prototype reads,
// no symbol smuggling).
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
  const out: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key)
    if (!descriptor || !('value' in descriptor)) fail(code) // reject getters
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

// ---------------------------------------------------------------------------
// Closed source matrix (amendment section 1.1).
// ---------------------------------------------------------------------------

export type AttendanceOperationIdentityKindV1 = 'batch' | 'item'

interface SourceMatrixRow {
  readonly kind: AttendanceOperationIdentityKindV1
  readonly entrypoint: AttendanceSourceEntrypointV1
  readonly idRule: 'direct_uuid' | 'ledger_uuid' | 'root_uuid' | 'derived_item' | 'derived_scheduled'
}

export const ATTENDANCE_OPERATION_SOURCE_MATRIX_V1: Readonly<Record<string, SourceMatrixRow>> = Object.freeze({
  direct_live_punch: Object.freeze({ kind: 'item', entrypoint: 'live_punch', idRule: 'direct_uuid' } as const),
  direct_request_create: Object.freeze({ kind: 'item', entrypoint: 'request_create', idRule: 'direct_uuid' } as const),
  direct_request_pending_edit: Object.freeze({ kind: 'item', entrypoint: 'request_pending_edit', idRule: 'direct_uuid' } as const),
  direct_request_decision: Object.freeze({ kind: 'item', entrypoint: 'request_decision', idRule: 'direct_uuid' } as const),
  direct_request_cancel: Object.freeze({ kind: 'item', entrypoint: 'request_cancel', idRule: 'direct_uuid' } as const),
  direct_manual_edit: Object.freeze({ kind: 'item', entrypoint: 'manual_edit', idRule: 'direct_uuid' } as const),
  direct_recompute: Object.freeze({ kind: 'item', entrypoint: 'recompute', idRule: 'direct_uuid' } as const),
  direct_import_rollback: Object.freeze({ kind: 'item', entrypoint: 'import_rollback', idRule: 'direct_uuid' } as const),
  direct_ops_retirement: Object.freeze({ kind: 'item', entrypoint: 'ops_retirement', idRule: 'direct_uuid' } as const),
  verified_delivery: Object.freeze({ kind: 'item', entrypoint: 'request_decision', idRule: 'ledger_uuid' } as const),
  import_batch: Object.freeze({ kind: 'batch', entrypoint: 'import_batch', idRule: 'root_uuid' } as const),
  import_item: Object.freeze({ kind: 'item', entrypoint: 'import_batch', idRule: 'derived_item' } as const),
  integration_batch: Object.freeze({ kind: 'batch', entrypoint: 'integration_batch', idRule: 'root_uuid' } as const),
  integration_item: Object.freeze({ kind: 'item', entrypoint: 'integration_batch', idRule: 'derived_item' } as const),
  scheduled: Object.freeze({ kind: 'item', entrypoint: 'scheduled', idRule: 'derived_scheduled' } as const),
})

export type AttendanceOperationIdentitySourceKindV1 = keyof typeof ATTENDANCE_OPERATION_SOURCE_MATRIX_V1 & string

// ---------------------------------------------------------------------------
// UUIDv5 (TS side of the mandatory TS/SQL golden-parity gate; amendment 1.3).
// ---------------------------------------------------------------------------

const NUL = Buffer.from([0])

function uuidToBytes(canonicalUuid: string): Buffer {
  return Buffer.from(canonicalUuid.replace(/-/g, ''), 'hex')
}

function uuidv5(namespaceUuid: string, nameBytes: Buffer): string {
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([uuidToBytes(namespaceUuid), nameBytes]))
    .digest()
    .subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50 // version 5
  digest[8] = (digest[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = digest.toString('hex')
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
  )
}

function deriveItemOperationId(namespaceUuid: string, rootUuid: string, ordinal: string, semanticFingerprint: string): string {
  const name = Buffer.concat([
    Buffer.from(rootUuid, 'utf8'),
    NUL,
    Buffer.from(ordinal, 'utf8'),
    NUL,
    Buffer.from(semanticFingerprint, 'utf8'),
  ])
  return uuidv5(namespaceUuid, name)
}

function deriveScheduledOperationId(runUuid: string, userUuid: string, workDate: string): string {
  const name = Buffer.concat([
    Buffer.from(runUuid, 'utf8'),
    NUL,
    Buffer.from(userUuid, 'utf8'),
    NUL,
    Buffer.from(workDate, 'utf8'),
  ])
  return uuidv5(ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1, name)
}

// ---------------------------------------------------------------------------
// Opaque witness registries (module-private; membership IS the proof).
// ---------------------------------------------------------------------------

const orgWitnesses = new WeakSet<object>()
const operationWitnesses = new WeakSet<object>()
const targetWitnesses = new WeakSet<object>()
const postureWitnesses = new WeakSet<object>()

// ---------------------------------------------------------------------------
// Rollout posture resolver (lock section 9) — the single seam.
// ---------------------------------------------------------------------------

/** Minimal transaction-bound client (structurally satisfied by pg PoolClient / db/pg transaction handler). */
export interface AttendanceW4TransactionClientV1 {
  query(sqlText: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

export type AttendanceSegmentWritePostureV1 = AttendanceAcceptedWritePostureV1 | 'blocked'

export type ResolvedSegmentCalculationPostureV1 = Opaque<
  Readonly<{
    orgKey: CanonicalAttendanceRolloutOrgKeyV1
    effectiveState: AttendanceRolloutStateV1
    writePosture: AttendanceSegmentWritePostureV1
    authorSegments: 'preview' | 'full' | 'none'
    referenceSegments: boolean
    authoritativeResults: boolean
    convertReferencedShift: boolean
    deleteUnreferencedShift: boolean
  }>,
  'ResolvedSegmentCalculationPostureV1'
>

/**
 * Implementation capability (section 9 effective-state requirement 1) for THIS slice:
 * W4C-0 ships durable storage + the identity/lock layer, so the resolver seam itself is
 * implemented. The authoritative segment CALCULATOR is W4C-1: an `authoritative` answer
 * additionally requires a persisted `authoritative` rollout row, which cannot exist yet —
 * the Stage A rollout guard admits only `legacy`/`shadow` initial states and no transition
 * writer ships in W4C-0. Advertising `shadow` additionally requires BOTH an exact-org env
 * allowlist entry AND a persisted state row; neither exists by default, so default runtime
 * behavior remains byte-identical (`legacy_projection_only` for every org). The separate W3
 * reference-writer constant in attendance-shift-service.cjs stays `false` and is untouched.
 */
const SEGMENT_CALCULATION_IMPLEMENTATION_CAPABILITY = true

const SEGMENT_CALCULATION_ALLOWLIST_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'

/** Exact org-only outer allowlist; `*` (wildcard) NEVER counts for W4 (section 9). */
function isOrgExactlyAllowlisted(orgKey: string): boolean {
  const raw = typeof process.env[SEGMENT_CALCULATION_ALLOWLIST_ENV] === 'string'
    ? (process.env[SEGMENT_CALCULATION_ALLOWLIST_ENV] as string)
    : ''
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean)
  return entries.includes(orgKey)
}

interface PostureRowShape {
  readonly writePosture: AttendanceSegmentWritePostureV1
  readonly authorSegments: 'preview' | 'full' | 'none'
  readonly referenceSegments: boolean
  readonly authoritativeResults: boolean
  readonly convertReferencedShift: boolean
  readonly deleteUnreferencedShift: boolean
}

// Section 9 closed return-shape table (writePosture is the SOLE eligible->shadow conversion).
const POSTURE_TABLE: Readonly<Record<AttendanceRolloutStateV1, PostureRowShape>> = Object.freeze({
  legacy: Object.freeze({
    writePosture: 'legacy_projection_only',
    authorSegments: 'preview',
    referenceSegments: false,
    authoritativeResults: false,
    convertReferencedShift: false,
    deleteUnreferencedShift: true,
  } as const),
  shadow: Object.freeze({
    writePosture: 'shadow',
    authorSegments: 'full',
    referenceSegments: true,
    authoritativeResults: false,
    convertReferencedShift: true,
    deleteUnreferencedShift: true,
  } as const),
  eligible: Object.freeze({
    writePosture: 'shadow', // normalized: enqueue under `eligible` stores `shadow`
    authorSegments: 'full',
    referenceSegments: true,
    authoritativeResults: false,
    convertReferencedShift: true,
    deleteUnreferencedShift: true,
  } as const),
  authoritative: Object.freeze({
    writePosture: 'authoritative',
    authorSegments: 'full',
    referenceSegments: true,
    authoritativeResults: true,
    convertReferencedShift: true,
    deleteUnreferencedShift: true,
  } as const),
  suspended: Object.freeze({
    writePosture: 'blocked',
    authorSegments: 'none',
    referenceSegments: false,
    authoritativeResults: false,
    convertReferencedShift: false,
    deleteUnreferencedShift: false,
  } as const),
})

/**
 * One async `resolveSegmentCalculationPosture(trx, orgId)` is the sole truth for calculator
 * mode, shift capability output, reference guards, conversion/deletion guards, and rollout
 * commands (lock section 9). W4C-0 builds the seam only — no production caller is cut over.
 *
 * Callers must hold the class-`00` org rollout advisory lock (shared or exclusive per
 * section 8.2) before calling; the Stage C boundary enforces that ordering.
 *
 * Fail-closed notes:
 *  - a persisted `suspended` state is ALWAYS honored as suspended/blocked, regardless of
 *    capability or allowlist (suspension can never be evaded through the environment);
 *  - any other persisted state additionally requires implementation capability AND an
 *    exact-org allowlist entry; otherwise the org resolves to the missing/wildcard-only/
 *    `legacy` row (an environment value alone never advertises authoritative results, and
 *    removing the env entry alone never rewrites history — it only stops advertising).
 */
export async function resolveSegmentCalculationPosture(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<ResolvedSegmentCalculationPostureV1> {
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(orgId)
  const result = await trx.query(
    'SELECT state, scope FROM attendance_calculation_rollout_state WHERE org_id = $1',
    [orgKey],
  )
  let persisted: AttendanceRolloutStateV1 | null = null
  if (result.rows.length > 1) fail('W4C0_ROLLOUT_STATE_AMBIGUOUS')
  if (result.rows.length === 1) {
    const state = result.rows[0].state
    const scope = result.rows[0].scope
    if (typeof state !== 'string' || !(ATTENDANCE_ROLLOUT_STATES_V1 as readonly string[]).includes(state)) {
      fail('W4C0_ROLLOUT_STATE_INVALID')
    }
    if (scope !== 'synthetic_staging') fail('W4C0_ROLLOUT_SCOPE_INVALID')
    persisted = state as AttendanceRolloutStateV1
  }

  let effectiveState: AttendanceRolloutStateV1
  if (persisted === 'suspended') {
    effectiveState = 'suspended'
  } else if (
    persisted !== null &&
    persisted !== 'legacy' &&
    SEGMENT_CALCULATION_IMPLEMENTATION_CAPABILITY &&
    isOrgExactlyAllowlisted(orgKey)
  ) {
    effectiveState = persisted
  } else {
    effectiveState = 'legacy'
  }

  const row = POSTURE_TABLE[effectiveState]
  const witness = frozenNullProto({
    orgKey,
    effectiveState,
    writePosture: row.writePosture,
    authorSegments: row.authorSegments,
    referenceSegments: row.referenceSegments,
    authoritativeResults: row.authoritativeResults,
    convertReferencedShift: row.convertReferencedShift,
    deleteUnreferencedShift: row.deleteUnreferencedShift,
  }) as ResolvedSegmentCalculationPostureV1
  postureWitnesses.add(witness)
  return witness
}

// ---------------------------------------------------------------------------
// Verified org identity (amendment sections 1 / 1.2).
// ---------------------------------------------------------------------------

export type VerifiedAttendanceOrgIdentityV1 = Opaque<
  Readonly<{
    orgId: CanonicalAttendanceOrgKeyV1
    acceptedWritePosture: AttendanceAcceptedWritePostureV1
  }>,
  'VerifiedAttendanceOrgIdentityV1'
>

function mintOrgWitness(orgId: string, acceptedWritePosture: AttendanceAcceptedWritePostureV1): VerifiedAttendanceOrgIdentityV1 {
  // `default` is valid ONLY under legacy_projection_only (amendment 1.2); effective
  // `eligible` has already been normalized to `shadow` by the resolver and therefore
  // fails identically here.
  if (orgId === 'default' && acceptedWritePosture !== 'legacy_projection_only') {
    fail('W4C0_DEFAULT_ORG_POSTURE_REJECTED')
  }
  const witness = frozenNullProto({
    orgId: orgId as CanonicalAttendanceOrgKeyV1,
    acceptedWritePosture,
  }) as VerifiedAttendanceOrgIdentityV1
  orgWitnesses.add(witness)
  return witness
}

/**
 * POST-LOCK verified-org factory. Accepts the same rollout-org key that acquired the
 * class-`00` lock plus the resolver's returned posture witness; rejects a changed org key
 * and cannot infer a legacy posture from the literal value `default` (amendment gate 8 —
 * the posture always comes from resolution, never from the org-key bytes).
 */
export function createVerifiedAttendanceOrgIdentityV1(input: unknown): VerifiedAttendanceOrgIdentityV1 {
  const fields = requireExactKeys(input, ['orgKey', 'posture'], 'W4C0_ORG_IDENTITY_INPUT_INVALID')
  const orgKey = parseOrgKeyLexical(fields.orgKey, 'W4C0_ORG_KEY_INVALID')
  const posture = fields.posture
  if (typeof posture !== 'object' || posture === null || !postureWitnesses.has(posture)) {
    fail('W4C0_POSTURE_WITNESS_REQUIRED')
  }
  const resolved = posture as ResolvedSegmentCalculationPostureV1
  if (resolved.orgKey !== orgKey) fail('W4C0_ORG_KEY_CHANGED')
  const writePosture = resolved.writePosture
  if (writePosture === 'blocked') fail('W4C0_ORG_POSTURE_BLOCKED')
  if (!(ATTENDANCE_ACCEPTED_WRITE_POSTURES_V1 as readonly string[]).includes(writePosture)) {
    fail('W4C0_WRITE_POSTURE_INVALID')
  }
  return mintOrgWitness(orgKey, writePosture)
}

// ---------------------------------------------------------------------------
// Verified operation identity (amendment sections 1 / 1.1 / 1.3).
// ---------------------------------------------------------------------------

/** Durable, closed source proof carried by a verified operation identity. */
export type AttendanceOperationIdentitySourceProofV1 = Readonly<{
  sourceKind: AttendanceOperationIdentitySourceKindV1
  sourceRootId: CanonicalAttendanceOperationIdV1 | null
  ordinal: string | null
  semanticFingerprint: string | null
  userId: CanonicalAttendanceUserIdV1 | null
  workDate: CanonicalAttendanceWorkDateV1 | null
}>

export type VerifiedAttendanceOperationIdentityV1 = Opaque<
  Readonly<{
    kind: AttendanceOperationIdentityKindV1
    org: VerifiedAttendanceOrgIdentityV1
    entrypoint: AttendanceSourceEntrypointV1
    id: CanonicalAttendanceOperationIdV1
    sourceProof: AttendanceOperationIdentitySourceProofV1
  }>,
  'VerifiedAttendanceOperationIdentityV1'
>

function requireOrgWitness(org: unknown): VerifiedAttendanceOrgIdentityV1 {
  if (typeof org !== 'object' || org === null || !orgWitnesses.has(org)) {
    fail('W4C0_ORG_WITNESS_REQUIRED')
  }
  return org as VerifiedAttendanceOrgIdentityV1
}

interface NormalizedSourceTuple {
  readonly operationId: string
  readonly sourceRootId: string | null
  readonly ordinal: string | null
  readonly semanticFingerprint: string | null
  readonly userId: string | null
  readonly workDate: string | null
}

/**
 * Strict-parses one closed source variant and derives/validates the operation ID.
 * Derived sources NEVER accept a caller-supplied final UUID: their variants carry no ID
 * field at all, and unknown/extra keys are rejected.
 */
function normalizeSourceTuple(sourceKind: AttendanceOperationIdentitySourceKindV1, source: unknown): NormalizedSourceTuple {
  const inputCode = 'W4C0_SOURCE_PROOF_INPUT_INVALID'
  switch (ATTENDANCE_OPERATION_SOURCE_MATRIX_V1[sourceKind].idRule) {
    case 'direct_uuid': {
      const fields = requireExactKeys(source, ['sourceKind', 'clientOperationId'], inputCode)
      const id = parseUuidSyntax(fields.clientOperationId, 'W4C0_OPERATION_ID_INVALID')
      requireRfc4122VariantVersion(id, 'W4C0_OPERATION_ID_INVALID')
      return { operationId: id, sourceRootId: null, ordinal: null, semanticFingerprint: null, userId: null, workDate: null }
    }
    case 'ledger_uuid': {
      const fields = requireExactKeys(source, ['sourceKind', 'deliveryLedgerId'], inputCode)
      const id = parseUuidSyntax(fields.deliveryLedgerId, 'W4C0_OPERATION_ID_INVALID')
      return { operationId: id, sourceRootId: id, ordinal: null, semanticFingerprint: null, userId: null, workDate: null }
    }
    case 'root_uuid': {
      const rootKey = sourceKind === 'import_batch' ? 'batchCommandId' : 'syncRunId'
      const fields = requireExactKeys(source, ['sourceKind', rootKey], inputCode)
      const id = parseUuidSyntax(fields[rootKey], 'W4C0_OPERATION_ID_INVALID')
      return { operationId: id, sourceRootId: id, ordinal: null, semanticFingerprint: null, userId: null, workDate: null }
    }
    case 'derived_item': {
      const rootKey = sourceKind === 'import_item' ? 'batchCommandId' : 'syncRunId'
      const fields = requireExactKeys(source, ['sourceKind', rootKey, 'ordinal', 'semanticFingerprint'], inputCode)
      const root = parseUuidSyntax(fields[rootKey], 'W4C0_SOURCE_ROOT_INVALID')
      const ordinal = parseCanonicalOrdinal(fields.ordinal)
      const semanticFingerprint = parseSemanticFingerprint(fields.semanticFingerprint)
      const namespace =
        sourceKind === 'import_item' ? ATTENDANCE_IMPORT_ITEM_NAMESPACE_V1 : ATTENDANCE_INTEGRATION_ITEM_NAMESPACE_V1
      const id = deriveItemOperationId(namespace, root, ordinal, semanticFingerprint)
      return { operationId: id, sourceRootId: root, ordinal, semanticFingerprint, userId: null, workDate: null }
    }
    case 'derived_scheduled': {
      const fields = requireExactKeys(source, ['sourceKind', 'scheduledRunId', 'userId', 'workDate'], inputCode)
      const root = parseUuidSyntax(fields.scheduledRunId, 'W4C0_SOURCE_ROOT_INVALID')
      const userId = parseCanonicalAttendanceUserIdV1(fields.userId)
      const workDate = parseCanonicalAttendanceWorkDateV1(fields.workDate)
      const id = deriveScheduledOperationId(root, userId, workDate)
      return { operationId: id, sourceRootId: root, ordinal: null, semanticFingerprint: null, userId, workDate }
    }
  }
  fail('W4C0_SOURCE_KIND_INVALID')
}

function mintOperationWitness(
  org: VerifiedAttendanceOrgIdentityV1,
  kind: AttendanceOperationIdentityKindV1,
  entrypoint: AttendanceSourceEntrypointV1,
  tuple: NormalizedSourceTuple,
  sourceKind: AttendanceOperationIdentitySourceKindV1,
): VerifiedAttendanceOperationIdentityV1 {
  const sourceProof = frozenNullProto({
    sourceKind,
    sourceRootId: tuple.sourceRootId as CanonicalAttendanceOperationIdV1 | null,
    ordinal: tuple.ordinal,
    semanticFingerprint: tuple.semanticFingerprint,
    userId: tuple.userId as CanonicalAttendanceUserIdV1 | null,
    workDate: tuple.workDate as CanonicalAttendanceWorkDateV1 | null,
  }) as AttendanceOperationIdentitySourceProofV1
  const witness = frozenNullProto({
    kind,
    org,
    entrypoint,
    id: tuple.operationId as CanonicalAttendanceOperationIdV1,
    sourceProof,
  }) as VerifiedAttendanceOperationIdentityV1
  operationWitnesses.add(witness)
  return witness
}

/**
 * The closed verified-operation-identity factory — the ONLY constructor accepted by
 * `buildAttendanceResultOperationAdvisoryKey`. It strict-parses org witness, kind,
 * entrypoint, and closed source tuple; derives or validates the operation ID per the
 * amendment 1.1 source matrix; and freezes the verified result together with the durable
 * source proof. Every unlisted source-kind/entrypoint/kind combination fails.
 */
export function createVerifiedAttendanceOperationIdentityV1(input: unknown): VerifiedAttendanceOperationIdentityV1 {
  const fields = requireExactKeys(input, ['org', 'kind', 'entrypoint', 'source'], 'W4C0_OPERATION_IDENTITY_INPUT_INVALID')
  const org = requireOrgWitness(fields.org)
  const source = fields.source
  if (typeof source !== 'object' || source === null) fail('W4C0_SOURCE_PROOF_INPUT_INVALID')
  const sourceKindRaw = Object.getOwnPropertyDescriptor(source, 'sourceKind')?.value
  if (typeof sourceKindRaw !== 'string' || !Object.prototype.hasOwnProperty.call(ATTENDANCE_OPERATION_SOURCE_MATRIX_V1, sourceKindRaw)) {
    fail('W4C0_SOURCE_KIND_INVALID')
  }
  const sourceKind = sourceKindRaw as AttendanceOperationIdentitySourceKindV1
  const row = ATTENDANCE_OPERATION_SOURCE_MATRIX_V1[sourceKind]
  if (fields.kind !== row.kind) fail('W4C0_SOURCE_KIND_MISMATCH')
  if (fields.entrypoint !== row.entrypoint) fail('W4C0_SOURCE_ENTRYPOINT_MISMATCH')
  const tuple = normalizeSourceTuple(sourceKind, source)
  return mintOperationWitness(org, row.kind, row.entrypoint, tuple, sourceKind)
}

// ---------------------------------------------------------------------------
// Rehydration from durable proof (amendment section 1.3).
// ---------------------------------------------------------------------------

/**
 * Exact camelCase mirror of the durable registry/proof columns. `proofWorkDate` must be the
 * canonical `YYYY-MM-DD` string (readers select `proof_work_date::text` — a JS Date is
 * rejected because node-pg date parsing is timezone-dependent).
 */
export interface AttendanceOperationIdentityDurableRowV1 {
  orgId: string
  entrypoint: string
  kind: AttendanceOperationIdentityKindV1
  operationId: string
  acceptedWritePosture: string
  identitySourceKind: string
  sourceRootId: string | null
  inputOrdinal: number | string | null
  proofSemanticFingerprint: string | null
  proofUserId: string | null
  proofWorkDate: string | null
}

const DURABLE_ROW_KEYS = [
  'orgId',
  'entrypoint',
  'kind',
  'operationId',
  'acceptedWritePosture',
  'identitySourceKind',
  'sourceRootId',
  'inputOrdinal',
  'proofSemanticFingerprint',
  'proofUserId',
  'proofWorkDate',
] as const

/**
 * Re-runs the factory against the complete durable proof after a queue or database round
 * trip. The stored operation ID must equal the re-derived/re-validated identity; any
 * operation-ID or proof-field drift fails BEFORE the identity can reach a builder
 * (and therefore before any source DML in later slices). Legacy null-version rows have no
 * proof and cannot rehydrate.
 */
export function rehydrateVerifiedAttendanceOperationIdentityV1(durableRow: unknown): VerifiedAttendanceOperationIdentityV1 {
  const rowCode = 'W4C0_DURABLE_ROW_INVALID'
  const fields = requireExactKeys(durableRow, DURABLE_ROW_KEYS, rowCode)

  const posture = fields.acceptedWritePosture
  if (typeof posture !== 'string' || !(ATTENDANCE_ACCEPTED_WRITE_POSTURES_V1 as readonly string[]).includes(posture)) {
    fail('W4C0_WRITE_POSTURE_INVALID')
  }
  const orgId = parseOrgKeyLexical(fields.orgId, 'W4C0_ORG_KEY_INVALID')
  // Durable reload re-checks the default/posture door (amendment gate 1: "including after
  // serialization and DB reload"); mintOrgWitness rejects default + shadow|authoritative.
  const org = mintOrgWitness(orgId, posture as AttendanceAcceptedWritePostureV1)

  const sourceKindRaw = fields.identitySourceKind
  if (typeof sourceKindRaw !== 'string' || !Object.prototype.hasOwnProperty.call(ATTENDANCE_OPERATION_SOURCE_MATRIX_V1, sourceKindRaw)) {
    fail('W4C0_SOURCE_KIND_INVALID')
  }
  const sourceKind = sourceKindRaw as AttendanceOperationIdentitySourceKindV1
  const row = ATTENDANCE_OPERATION_SOURCE_MATRIX_V1[sourceKind]
  if (fields.kind !== row.kind) fail('W4C0_SOURCE_KIND_MISMATCH')
  if (fields.entrypoint !== row.entrypoint) fail('W4C0_SOURCE_ENTRYPOINT_MISMATCH')

  const storedId = parseUuidSyntax(fields.operationId, 'W4C0_OPERATION_ID_INVALID')

  // Exact proof shape per source kind (mirrors chk_aro_proof_shape: partial or extra
  // proof fields are rejected), then re-run the factory derivation core.
  const requireNull = (value: unknown): void => {
    if (value !== null) fail('W4C0_PROOF_SHAPE_INVALID')
  }
  let tuple: NormalizedSourceTuple
  switch (row.idRule) {
    case 'direct_uuid': {
      requireNull(fields.sourceRootId)
      requireNull(fields.inputOrdinal)
      requireNull(fields.proofSemanticFingerprint)
      requireNull(fields.proofUserId)
      requireNull(fields.proofWorkDate)
      requireRfc4122VariantVersion(storedId, 'W4C0_OPERATION_ID_INVALID')
      tuple = { operationId: storedId, sourceRootId: null, ordinal: null, semanticFingerprint: null, userId: null, workDate: null }
      break
    }
    case 'ledger_uuid':
    case 'root_uuid': {
      requireNull(fields.inputOrdinal)
      requireNull(fields.proofSemanticFingerprint)
      requireNull(fields.proofUserId)
      requireNull(fields.proofWorkDate)
      const root = parseUuidSyntax(fields.sourceRootId, 'W4C0_SOURCE_ROOT_INVALID')
      if (root !== storedId) fail('W4C0_IDENTITY_PROOF_DRIFT')
      tuple = { operationId: storedId, sourceRootId: root, ordinal: null, semanticFingerprint: null, userId: null, workDate: null }
      break
    }
    case 'derived_item': {
      requireNull(fields.proofUserId)
      requireNull(fields.proofWorkDate)
      const root = parseUuidSyntax(fields.sourceRootId, 'W4C0_SOURCE_ROOT_INVALID')
      if (fields.inputOrdinal === null) fail('W4C0_PROOF_SHAPE_INVALID')
      const ordinal = parseCanonicalOrdinal(fields.inputOrdinal)
      if (fields.proofSemanticFingerprint === null) fail('W4C0_PROOF_SHAPE_INVALID')
      const semanticFingerprint = parseSemanticFingerprint(fields.proofSemanticFingerprint)
      const namespace =
        sourceKind === 'import_item' ? ATTENDANCE_IMPORT_ITEM_NAMESPACE_V1 : ATTENDANCE_INTEGRATION_ITEM_NAMESPACE_V1
      const derived = deriveItemOperationId(namespace, root, ordinal, semanticFingerprint)
      if (derived !== storedId) fail('W4C0_IDENTITY_PROOF_DRIFT')
      tuple = { operationId: derived, sourceRootId: root, ordinal, semanticFingerprint, userId: null, workDate: null }
      break
    }
    case 'derived_scheduled': {
      requireNull(fields.inputOrdinal)
      requireNull(fields.proofSemanticFingerprint)
      const root = parseUuidSyntax(fields.sourceRootId, 'W4C0_SOURCE_ROOT_INVALID')
      const userId = parseCanonicalAttendanceUserIdV1(fields.proofUserId)
      const workDate = parseCanonicalAttendanceWorkDateV1(fields.proofWorkDate)
      const derived = deriveScheduledOperationId(root, userId, workDate)
      if (derived !== storedId) fail('W4C0_IDENTITY_PROOF_DRIFT')
      tuple = { operationId: derived, sourceRootId: root, ordinal: null, semanticFingerprint: null, userId, workDate }
      break
    }
    default:
      fail('W4C0_SOURCE_KIND_INVALID')
  }
  return mintOperationWitness(org, row.kind, row.entrypoint, tuple, sourceKind)
}

// ---------------------------------------------------------------------------
// Verified calculation target identity (amendment section 1; lock section 9).
// ---------------------------------------------------------------------------

export type VerifiedAttendanceCalculationTargetIdentityV1 = Opaque<
  Readonly<{
    org: VerifiedAttendanceOrgIdentityV1
    userId: CanonicalAttendanceUserIdV1
    workDate: CanonicalAttendanceWorkDateV1
  }>,
  'VerifiedAttendanceCalculationTargetIdentityV1'
>

export function createVerifiedAttendanceCalculationTargetIdentityV1(input: unknown): VerifiedAttendanceCalculationTargetIdentityV1 {
  const fields = requireExactKeys(input, ['org', 'userId', 'workDate'], 'W4C0_TARGET_IDENTITY_INPUT_INVALID')
  const org = requireOrgWitness(fields.org)
  const userId = parseCanonicalAttendanceUserIdV1(fields.userId)
  const workDate = parseCanonicalAttendanceWorkDateV1(fields.workDate)
  const witness = frozenNullProto({ org, userId, workDate }) as VerifiedAttendanceCalculationTargetIdentityV1
  targetWitnesses.add(witness)
  return witness
}

// ---------------------------------------------------------------------------
// Advisory-key builders (lock section 9; amendment: hash bytes unchanged).
// ---------------------------------------------------------------------------

const ROLLOUT_KEY_PREFIX = 'metasheet2:attendance:segment-rollout:v1'
const OPERATION_KEY_PREFIX = 'metasheet2:attendance:result-operation:v1'
const TARGET_KEY_PREFIX = 'metasheet2:attendance:calculation-target:v1'

const LOW_62_MASK = 0x3fffffffffffffffn
const CLASS_10_PREFIX = 0x8000000000000000n
const CLASS_11_PREFIX = 0xc000000000000000n

type DigestFn = (preimage: Buffer) => Buffer

function productionSha256(preimage: Buffer): Buffer {
  return crypto.createHash('sha256').update(preimage).digest()
}

// Module-private digest seam: exists ONLY for the real-DB/unit test build (lock section 9 —
// forces crossed raw digests / same-final-key collisions / equal rollout-operation-target raw
// digests). Production construction cannot inject or replace the SHA-256 implementation:
// the setter fail-closes outside a test runtime.
let digestSeam: DigestFn | null = null

export function __setAttendanceW4DigestSeamForTests(seam: DigestFn | null): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    fail('W4C0_DIGEST_SEAM_FORBIDDEN')
  }
  digestSeam = seam
}

function rawDigestU64(preimage: Buffer): bigint {
  const digest = (digestSeam ?? productionSha256)(preimage)
  if (!Buffer.isBuffer(digest) || digest.length < 8) fail('W4C0_DIGEST_INVALID')
  return digest.readBigUInt64BE(0)
}

function nulJoin(parts: readonly string[]): Buffer {
  const buffers: Buffer[] = []
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) buffers.push(NUL)
    buffers.push(Buffer.from(parts[i], 'utf8'))
  }
  return Buffer.concat(buffers)
}

/**
 * Class-`00` rollout key: first eight bytes of
 * SHA-256("metasheet2:attendance:segment-rollout:v1\0" + canonicalOrgId) as unsigned
 * big-endian u64, top two bits cleared. Accepts only lexical pre-lock parser output
 * (re-validated here so a raw string cannot bypass the parser).
 */
export function buildAttendanceCalculationRolloutAdvisoryKey(org: CanonicalAttendanceRolloutOrgKeyV1): bigint {
  const orgKey = parseOrgKeyLexical(org, 'W4C0_ROLLOUT_ORG_KEY_INVALID')
  const u64 = rawDigestU64(nulJoin([ROLLOUT_KEY_PREFIX, orgKey]))
  return BigInt.asIntN(64, u64 & LOW_62_MASK)
}

function requireOperationWitness(identity: unknown): VerifiedAttendanceOperationIdentityV1 {
  if (typeof identity !== 'object' || identity === null || !operationWitnesses.has(identity)) {
    fail('W4C0_OPERATION_WITNESS_REQUIRED')
  }
  return identity as VerifiedAttendanceOperationIdentityV1
}

/**
 * Class-`10` operation key over the exact NUL-separated tuple
 * "metasheet2:attendance:result-operation:v1\0" + kind + "\0" + orgId + "\0" + entrypoint +
 * "\0" + operationId — low 62 digest bits, prefix bits `10`, signed two's-complement.
 * The factory/rehydrator witness is the only accepted constructor; the proof never enters
 * the key bytes (it only decides whether the bytes are admitted).
 */
export function buildAttendanceResultOperationAdvisoryKey(identity: VerifiedAttendanceOperationIdentityV1): bigint {
  const verified = requireOperationWitness(identity)
  const u64 = rawDigestU64(nulJoin([OPERATION_KEY_PREFIX, verified.kind, verified.org.orgId, verified.entrypoint, verified.id]))
  return BigInt.asIntN(64, (u64 & LOW_62_MASK) | CLASS_10_PREFIX)
}

function requireTargetWitness(identity: unknown): VerifiedAttendanceCalculationTargetIdentityV1 {
  if (typeof identity !== 'object' || identity === null || !targetWitnesses.has(identity)) {
    fail('W4C0_TARGET_WITNESS_REQUIRED')
  }
  return identity as VerifiedAttendanceCalculationTargetIdentityV1
}

/**
 * Class-`11` target key over "metasheet2:attendance:calculation-target:v1\0" + orgId +
 * "\0" + userId + "\0" + workDate — low 62 digest bits, prefix bits `11`, signed.
 */
export function buildAttendanceCalculationTargetAdvisoryKey(identity: VerifiedAttendanceCalculationTargetIdentityV1): bigint {
  const verified = requireTargetWitness(identity)
  const u64 = rawDigestU64(nulJoin([TARGET_KEY_PREFIX, verified.org.orgId, verified.userId, verified.workDate]))
  return BigInt.asIntN(64, (u64 & LOW_62_MASK) | CLASS_11_PREFIX)
}

// ---------------------------------------------------------------------------
// Acquisition helpers (lock sections 8.2 / 9) — the only lock-taking seams.
// No try-lock, no swallowed error, no timeout-to-continue, no row-lock fallback:
// any SQL failure propagates and aborts the whole transaction.
// ---------------------------------------------------------------------------

/**
 * The ONLY place allowed to select pg_advisory_xact_lock_shared versus
 * pg_advisory_xact_lock for the org rollout key. Source, rollback, transition, and closure
 * all import this helper (later slices); there is no copied namespace or local hash.
 */
export async function acquireAttendanceCalculationRolloutLock(
  trx: AttendanceW4TransactionClientV1,
  org: CanonicalAttendanceRolloutOrgKeyV1,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  if (mode !== 'shared' && mode !== 'exclusive') fail('W4C0_LOCK_MODE_INVALID')
  const key = buildAttendanceCalculationRolloutAdvisoryKey(org)
  if (mode === 'shared') {
    await trx.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [key.toString()])
  } else {
    await trx.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])
  }
}

function toSortedUniqueSignedKeys(keys: readonly bigint[]): bigint[] {
  const unique = new Map<string, bigint>()
  for (const key of keys) {
    unique.set(key.toString(), key)
  }
  // Numeric signed-bigint ascending order — NEVER the pre-hash tuple order.
  return Array.from(unique.values()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Canonicalizes (witness-checks) identities, derives final signed keys, de-duplicates by
 * final key, sorts them numerically, and obtains exclusive transaction advisory locks in
 * that order. Two identities colliding to one final key require one acquisition.
 */
export async function acquireAttendanceResultOperationLocks(
  trx: AttendanceW4TransactionClientV1,
  identities: readonly VerifiedAttendanceOperationIdentityV1[],
): Promise<void> {
  if (!Array.isArray(identities)) fail('W4C0_IDENTITY_LIST_INVALID')
  const keys = identities.map((identity) => buildAttendanceResultOperationAdvisoryKey(identity))
  for (const key of toSortedUniqueSignedKeys(keys)) {
    await trx.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])
  }
}

/** Same protocol for class-`11` calculation-target keys. */
export async function acquireAttendanceCalculationTargetLocks(
  trx: AttendanceW4TransactionClientV1,
  identities: readonly VerifiedAttendanceCalculationTargetIdentityV1[],
): Promise<void> {
  if (!Array.isArray(identities)) fail('W4C0_IDENTITY_LIST_INVALID')
  const keys = identities.map((identity) => buildAttendanceCalculationTargetAdvisoryKey(identity))
  for (const key of toSortedUniqueSignedKeys(keys)) {
    await trx.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])
  }
}
