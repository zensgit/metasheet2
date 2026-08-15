/**
 * W7-3 (#4556) — the context-source posture TRANSITION BOUNDARY.
 *
 * THIS MODULE IS THE ONLY DML PATH FOR `attendance_calculation_context_source_state`,
 * AND THE ONLY PLACE EITHER W7 CONTEXT-SOURCE TABLE MAY BE WRITTEN FROM.
 * There is no route, no plugin service, and no second competing implementation.
 * Preparation/tooling (the separately gated `scripts/ops/` CLI) may only call
 * this boundary — it must never touch context-source DML directly.
 *
 * (The W4 NIT-4 precision is carried over deliberately, so a future slice knows
 * the shape of the exception before it needs it: a SECOND writer of the EVENT
 * table would be permissible — `closeLegacyRollbackWindowV1`
 * (`w4c3a-rollout-control.ts:1405-1439`) is that precedent in the W4 machine —
 * while the STATE table keeps exactly one writer. No such second event writer
 * exists in this slice, so "only DML path" is exact for both tables today, and
 * the single-writer inventory leg in the test suite proves it mechanically
 * rather than trusting this sentence.)
 *
 * Authority: `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §4.2 (staging ladder), §5.2 (stage rollback), §5.3 (authoritative rollback +
 * resume evidence), §7 OD-W7-3(a) / OD-W7-4(a), red lines W7-R4 / W7-R7 / W7-R8;
 * ratified per #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation), rulings 2, 7, 8, 9.
 *
 * PATTERN CLONED, NOT IMPORT-COUPLED, from `w4c3a-rollout-control.ts` — the W4
 * segment-calculation transition boundary. W7 is a SECOND, independent org
 * posture (OD-W7-3(a)); its matrix, its states, its advisory keyspace, its
 * error codes and its tables are its own. What IS reused, deliberately and by
 * name, is every helper whose duplication would create two things that can
 * drift:
 *   - `isAttendanceW7ContextSourceOrgAllowlistedV1` — the ONE W7 allowlist
 *     predicate, whose own doc comment (`w7-resolver/w7-context-source-posture-resolver.ts:95-101`)
 *     names this writer as its required consumer and forbids a second copy;
 *   - `parseCanonicalAttendanceRolloutOrgKeyV1`, `assertConnectionIsIdleV1` —
 *     generic, exported, machine-agnostic identity/connection helpers;
 *   - `runAttendanceResultOperationTransactionV1` — the hardened SERIALIZABLE
 *     transaction runner;
 *   - `acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')` +
 *     `resolveSegmentCalculationPosture` — the W4 posture read, taken together
 *     exactly as every other caller in the tree takes it (see the
 *     `W4_POSTURE_COHERENT` predicate for the lock-order and staleness
 *     narrowing);
 *   - `readAttendanceRequestSnapshotDefectReportV1`, `countIncompleteOperationsV1`,
 *     `countUnresolvedIngressReviewsV1` — the existing predicate counters,
 *     reused AS-IS rather than re-derived.
 *
 * LOCK-ORDER CENSUS — see `docs/development/attendance-4556-w7-3-lock-order-census-20260815.md`.
 * Summary of what this module takes, in order:
 *   1. the W7 context-source key, SESSION-exclusive, as its own standalone
 *      statement strictly BEFORE `BEGIN ISOLATION LEVEL SERIALIZABLE`;
 *   2. inside the transaction, the W4 class-`00` org rollout key, SHARED,
 *      transaction-scoped — the documented precondition of
 *      `resolveSegmentCalculationPosture` (`w4c0-identity.ts:442-443`);
 *   3. the context-source row (`FOR UPDATE`);
 *   4. the predicate row families, in the SAME relative order the W4 boundary
 *      takes them (`w4c3a-rollout-control.ts:1544-1553`): `attendance_import_jobs`,
 *      then `attendance_records`, then the request-snapshot reader.
 * No site anywhere in the tree holds the W4 rollout key and then takes the W7
 * context-source key — this module is the only holder of the W7 key that
 * exists — so the (W7 -> W4) edge introduced here closes no cycle. That is
 * proven by a real two-connection reverse-contention test, not by this
 * paragraph.
 *
 * STRUCTURALLY INERT AT THIS HEAD. No production caller invokes this writer:
 * it is an exported operation the separately-authorized ops/CLI layer calls,
 * modelled on how `scripts/ops/attendance-w4c5-rollout-transition.ts` wraps
 * `w4c3a-rollout-control.ts`. Every production org still resolves `off`, on the
 * same three independent legs W7-1a's inertness rests on (the table is empty in
 * production, the resolver has no production import site, and
 * `ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED` is unset) — plus a fourth this slice
 * adds: every promotion into the group arm of the ladder is refused by the
 * producer-delivery declaration (`w7-context-source-delivery.ts`).
 */
import { createHash } from 'node:crypto'
import {
  acquireAttendanceCalculationRolloutLock,
  assertConnectionIsIdleV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
  type CanonicalAttendanceRolloutOrgKeyV1,
} from './w4c0-identity'
import { runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'
import { W4_TRANSACTION_STATEMENT_TIMEOUT_MS } from './w4c0-operation-contract'
import {
  countIncompleteOperationsV1,
  countUnresolvedIngressReviewsV1,
  readAttendanceRequestSnapshotDefectReportV1,
  type AttendanceRequestSnapshotDefectCountsV1,
} from './w4c3a-rollout-control'
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1,
  isAttendanceW7ContextSourceCompareEvidenceDeliveredV1,
  isAttendanceW7ContextSourceStateProducerDeliveredV1,
} from './w7-context-source-delivery'
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1,
  isAttendanceW7ContextSourcePostureLegalTransitionV1,
  type AttendanceW7ContextSourcePostureStateV1,
} from './w7-context-source-posture-contract'
import { isAttendanceW7ContextSourceOrgAllowlistedV1 } from './w7-resolver/w7-context-source-posture-resolver'

// ---------------------------------------------------------------------------
// Values-free error type. Every throw carries a closed `code` string only —
// never the offending input bytes, never an org id, never a count.
// ---------------------------------------------------------------------------

export class AttendanceW7ContextSourceTransitionError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW7ContextSourceTransitionError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW7ContextSourceTransitionError(code)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64 = /^[0-9a-f]{64}$/
const REF_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const CONTEXT_SOURCE_STATE_SET = new Set<AttendanceW7ContextSourcePostureStateV1>(
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1,
)

// ---------------------------------------------------------------------------
// The closed legal matrix: ONE source of pair legality, TWO enforcers.
//
// `ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1`
// (`w7-context-source-posture-contract.ts:56-66`) is the SOLE source. This
// module adds NO second list of pairs. The DB trigger
// `attendance_w7_context_source_state_guard` enforces the identical set as a
// defense-in-depth backstop, never as the primary gate: every illegal pair
// fails HERE, before any lock or DB access. The trigger's clauses are rendered
// from a local mirror in its own migration, and the two are proven equal by
// attempting all 25 ordered pairs against a real database — never by comparing
// two files' text.
//
// OD-W7-4 IS RULED (a) (ratification ruling 2): "No legacy fallback from
// `group_authoritative`; suspend/resume only." The seven pairs are therefore
// closed BY RULING. An OD-W7-4(b) ruling would ADD an edge into `off` and is an
// AMENDMENT to the contract constant plus this module's migration — a one-place
// change with its own OD — never a silent edit to a landed test.
// ---------------------------------------------------------------------------

/**
 * The ladder role each legal pair plays. It drives predicate applicability and
 * is recorded verbatim in the transition event's evidence blob, which is the
 * same job `comparisonWritePosture` does for the W4 rows
 * (`w4c3a-rollout-control.ts:82-96`).
 *
 * REPRESENTATION DECISION. W7's landed constant is bare tuples, and widening an
 * exported constant that landed under the ratification is a shape change this
 * slice is not authorized to make. So this side table is SEPARATE, and it is
 * deliberately HAND-WRITTEN rather than derived by mapping over the tuple
 * constant: a table computed from its source trivially equals its source, and
 * the completeness leg over it would measure nothing. Written out, the two
 * lists are pinned to each other in BOTH directions by
 * `__tests__/w7-context-source-transition.test.ts` — a pair added to the
 * constant alone reds, and a key added here alone reds.
 */
export type AttendanceW7ContextSourceLadderRoleV1 = 'advance' | 'rollback' | 'suspend' | 'resume'

export type AttendanceW7ContextSourceTransitionRowV1 = Readonly<{
  from: AttendanceW7ContextSourcePostureStateV1
  to: AttendanceW7ContextSourcePostureStateV1
  ladderRole: AttendanceW7ContextSourceLadderRoleV1
}>

export const ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_ROWS_V1: readonly AttendanceW7ContextSourceTransitionRowV1[] =
  Object.freeze([
    Object.freeze({ from: 'off', to: 'group_shadow', ladderRole: 'advance' } as const),
    Object.freeze({ from: 'group_shadow', to: 'off', ladderRole: 'rollback' } as const),
    Object.freeze({ from: 'group_shadow', to: 'group_eligible', ladderRole: 'advance' } as const),
    Object.freeze({ from: 'group_eligible', to: 'group_shadow', ladderRole: 'rollback' } as const),
    Object.freeze({
      from: 'group_eligible',
      to: 'group_authoritative',
      ladderRole: 'advance',
    } as const),
    Object.freeze({ from: 'group_authoritative', to: 'suspended', ladderRole: 'suspend' } as const),
    Object.freeze({ from: 'suspended', to: 'group_authoritative', ladderRole: 'resume' } as const),
  ])

/** Pair lookup returning the ROW, so the row's ladder role can reach the event evidence. */
export function findAttendanceW7ContextSourceTransitionRowV1(
  from: AttendanceW7ContextSourcePostureStateV1,
  to: AttendanceW7ContextSourcePostureStateV1,
): AttendanceW7ContextSourceTransitionRowV1 | undefined {
  return ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_ROWS_V1.find(
    (row) => row.from === from && row.to === to,
  )
}

/**
 * The one-step reachable set from a state, COMPUTED from the ratified tuple
 * constant. Exported so the OD-W7-4(a) graph-property assertion asserts a graph
 * property rather than re-spelling a list: `{group_authoritative} -> {suspended}`
 * and `{suspended} -> {group_authoritative}`, so adding any
 * `group_authoritative -> off` or `suspended -> off` edge reds without anyone
 * remembering to update a count.
 */
export function attendanceW7ContextSourceOneStepTargetsV1(
  from: AttendanceW7ContextSourcePostureStateV1,
): readonly AttendanceW7ContextSourcePostureStateV1[] {
  return Object.freeze(
    ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1.filter(([legalFrom]) => legalFrom === from)
      .map(([, legalTo]) => legalTo)
      .sort(),
  )
}

const RESUME_PAIR_FROM: AttendanceW7ContextSourcePostureStateV1 = 'suspended'
const RESUME_PAIR_TO: AttendanceW7ContextSourcePostureStateV1 = 'group_authoritative'

function isResumePair(
  from: AttendanceW7ContextSourcePostureStateV1,
  to: AttendanceW7ContextSourcePostureStateV1,
): boolean {
  return from === RESUME_PAIR_FROM && to === RESUME_PAIR_TO
}

// ---------------------------------------------------------------------------
// Evidence references (design-lock §5 item 5). This boundary NEVER collects or
// validates the manifest itself — that is the separately authorized tooling
// concern. It accepts only the exact manifest hash plus a closed set of opaque,
// values-free reference strings, and stores them verbatim.
//
// Cloned from `requireEvidenceReferences` (`w4c3a-rollout-control.ts:130-166`),
// nine hardening steps, each independently red-able.
// ---------------------------------------------------------------------------
const BASE_EVIDENCE_REFERENCE_KEYS = [
  'imageSha',
  'ownerAuthorizationRef',
  'syntheticOrgRef',
] as const

/**
 * §5.3: "resume requires the offline replay artifact with zero critical/unresolved
 * diffs". Carried as two ADDITIONAL required reference keys on the resume pair
 * only — the same widening `isResumePair` drives in the W4 boundary
 * (`w4c3a-rollout-control.ts:117-128`).
 */
const RESUME_EVIDENCE_REFERENCE_KEYS = ['ownerIncidentReviewRef', 'offlineReplayArtifactRef'] as const

export type AttendanceW7BaseEvidenceReferenceKeyV1 = (typeof BASE_EVIDENCE_REFERENCE_KEYS)[number]
export type AttendanceW7ResumeEvidenceReferenceKeyV1 =
  (typeof RESUME_EVIDENCE_REFERENCE_KEYS)[number]
export type AttendanceW7EvidenceReferenceKeyV1 =
  | AttendanceW7BaseEvidenceReferenceKeyV1
  | AttendanceW7ResumeEvidenceReferenceKeyV1

export type AttendanceW7EvidenceReferencesV1 = Readonly<
  Record<AttendanceW7EvidenceReferenceKeyV1, string>
>

function requireW7EvidenceReferences(
  value: unknown,
  from: AttendanceW7ContextSourcePostureStateV1,
  to: AttendanceW7ContextSourcePostureStateV1,
): AttendanceW7EvidenceReferencesV1 {
  // 1. object, not null, not an array
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('W7_CONTEXT_SOURCE_TRANSITION_EVIDENCE_REFERENCE_INVALID')
  }
  // 2. prototype is Object.prototype or null — never a foreign/exotic prototype
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('W7_CONTEXT_SOURCE_TRANSITION_EVIDENCE_REFERENCE_INVALID')
  }
  // 3. zero symbol keys
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail('W7_CONTEXT_SOURCE_TRANSITION_EVIDENCE_REFERENCE_INVALID')
  }
  // 4. the EXACT pair-dependent key set (widened for the resume pair)
  const expectedKeys: readonly string[] = isResumePair(from, to)
    ? [...BASE_EVIDENCE_REFERENCE_KEYS, ...RESUME_EVIDENCE_REFERENCE_KEYS]
    : BASE_EVIDENCE_REFERENCE_KEYS
  // 5. no extra keys
  const own = Object.getOwnPropertyNames(value)
  if (own.length !== expectedKeys.length) {
    fail('W7_CONTEXT_SOURCE_TRANSITION_EVIDENCE_REFERENCE_INVALID')
  }
  const out: Record<string, string> = {}
  for (const key of expectedKeys) {
    // 6. own property (never inherited)
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail('W7_CONTEXT_SOURCE_TRANSITION_EVIDENCE_REFERENCE_INVALID')
    }
    // 7. no getters/setters — an accessor could return a different value on a
    //    second read, so what was validated would not be what is stored
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.get || descriptor.set) {
      fail('W7_CONTEXT_SOURCE_TRANSITION_EVIDENCE_REFERENCE_INVALID')
    }
    // 8. string matching the values-free reference grammar
    const raw = (value as Record<string, unknown>)[key]
    if (typeof raw !== 'string' || !REF_VALUE.test(raw)) {
      fail('W7_CONTEXT_SOURCE_TRANSITION_EVIDENCE_REFERENCE_INVALID')
    }
    out[key] = raw
  }
  // 9. frozen return
  return Object.freeze(out) as AttendanceW7EvidenceReferencesV1
}

/**
 * A SEPARATE enforcer from the references (cloned from `requireManifestSha256`,
 * `w4c3a-rollout-control.ts:251-254`). Deliberately not folded into the
 * reference validator: a valid reference set with a bad hash must still refuse,
 * and a valid hash with a bad reference set must still refuse. Collapsing the
 * two would let either alone carry both refusals and the pair would cover for
 * each other.
 */
function requireManifestSha256(value: unknown): string {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    fail('W7_CONTEXT_SOURCE_TRANSITION_MANIFEST_INVALID')
  }
  return value
}

// ---------------------------------------------------------------------------
// Input shape + exact-key validation.
// ---------------------------------------------------------------------------

export type AttendanceW7ContextSourceTransitionInputV1 = Readonly<{
  orgId: string
  actorId: string
  correlationId: string
  engineVersion: string
  targetState: AttendanceW7ContextSourcePostureStateV1
  expectedState: AttendanceW7ContextSourcePostureStateV1
  expectedVersion: number
  evidenceManifestSha256: string
  evidenceReferences: AttendanceW7EvidenceReferencesV1
  reasonCode: 'context_source_transition'
}>

/**
 * The exact accepted key set. Its ABSENCE of any caller-assertable readiness
 * boolean is the enforcement of the W4C-5 §3 discipline — "It does not accept a
 * caller-supplied aggregate `ready=true` as a substitute for these queries" —
 * and it is an enumerable property a test asserts directly, not a convention.
 */
const TRANSITION_INPUT_KEYS = [
  'orgId',
  'actorId',
  'correlationId',
  'engineVersion',
  'targetState',
  'expectedState',
  'expectedVersion',
  'evidenceManifestSha256',
  'evidenceReferences',
  'reasonCode',
] as const

export const ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_INPUT_KEYS_V1: readonly string[] =
  Object.freeze([...TRANSITION_INPUT_KEYS])

function requireExactInputKeys(
  input: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(code)
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) fail(code)
  const own = Object.getOwnPropertyNames(input)
  if (own.length !== keys.length) fail(code)
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) fail(code)
  }
  return input as Record<string, unknown>
}

function requireText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) fail(code)
  return value
}

function requireUuid(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) fail(code)
  return value
}

function requireW7ContextSourceState(
  value: unknown,
  code: string,
): AttendanceW7ContextSourcePostureStateV1 {
  if (
    typeof value !== 'string' ||
    !CONTEXT_SOURCE_STATE_SET.has(value as AttendanceW7ContextSourcePostureStateV1)
  ) {
    fail(code)
  }
  return value as AttendanceW7ContextSourcePostureStateV1
}

function requireExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail('W7_CONTEXT_SOURCE_TRANSITION_EXPECTED_VERSION_INVALID')
  }
  return value
}

type NormalizedTransitionInput = AttendanceW7ContextSourceTransitionInputV1 &
  Readonly<{ ladderRole: AttendanceW7ContextSourceLadderRoleV1 }>

/**
 * VALIDATION ORDER IS THE CONTRACT (cloned from `normalizeTransitionInput`,
 * `w4c3a-rollout-control.ts:304-339`):
 *
 *  1. exact input keys (prototype-checked, count-checked);
 *  2. `reasonCode` literal;
 *  3. CANONICALIZE the org key BEFORE anything else — validate-then-normalize
 *     is the bug: an input allowlisted only in its raw spelling, or that
 *     queries under one spelling while being allowlisted under another, must
 *     not be able to disagree with itself;
 *  4. actor / correlation / engineVersion;
 *  5. the two states;
 *  6. `expectedVersion` safe-integer >= 1;
 *  7. the manifest hash;
 *  8. THE MATRIX CHECK, before any lock or DB access — a caller-asserted
 *     illegal pair can never proceed regardless of true persisted state;
 *  9. the evidence references LAST, so the pair-dependent (resume-widened) key
 *     set is chosen from an already-legal pair.
 */
function normalizeTransitionInput(
  rawInput: AttendanceW7ContextSourceTransitionInputV1,
): NormalizedTransitionInput {
  const input = requireExactInputKeys(
    rawInput,
    TRANSITION_INPUT_KEYS,
    'W7_CONTEXT_SOURCE_TRANSITION_INPUT_INVALID',
  )
  if (input.reasonCode !== 'context_source_transition') {
    fail('W7_CONTEXT_SOURCE_TRANSITION_INPUT_INVALID')
  }
  const orgId = String(parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId))
  const actorId = requireText(input.actorId, 'W7_CONTEXT_SOURCE_TRANSITION_ACTOR_INVALID')
  const correlationId = requireUuid(
    input.correlationId,
    'W7_CONTEXT_SOURCE_TRANSITION_CORRELATION_INVALID',
  )
  const engineVersion = requireText(
    input.engineVersion,
    'W7_CONTEXT_SOURCE_TRANSITION_ENGINE_INVALID',
  )
  const targetState = requireW7ContextSourceState(
    input.targetState,
    'W7_CONTEXT_SOURCE_TRANSITION_INPUT_INVALID',
  )
  const expectedState = requireW7ContextSourceState(
    input.expectedState,
    'W7_CONTEXT_SOURCE_TRANSITION_EXPECTED_STATE_INVALID',
  )
  const expectedVersion = requireExpectedVersion(input.expectedVersion)
  const evidenceManifestSha256 = requireManifestSha256(input.evidenceManifestSha256)
  const row = findAttendanceW7ContextSourceTransitionRowV1(expectedState, targetState)
  if (!row) fail('W7_CONTEXT_SOURCE_TRANSITION_ILLEGAL_TRANSITION')
  const evidenceReferences = requireW7EvidenceReferences(
    input.evidenceReferences,
    expectedState,
    targetState,
  )
  return Object.freeze({
    orgId,
    actorId,
    correlationId,
    engineVersion,
    targetState,
    expectedState,
    expectedVersion,
    evidenceManifestSha256,
    evidenceReferences,
    reasonCode: 'context_source_transition' as const,
    ladderRole: row.ladderRole,
  })
}

// ---------------------------------------------------------------------------
// The W7 context-source advisory keyspace.
//
// Its own preimage prefix, so it is a DIFFERENT key from the W4 class-`00`
// rollout key for the same org. Cloned in shape from
// `buildAttendanceCalculationRolloutAdvisoryKey` (`w4c0-identity.ts:958-962`):
// first eight bytes of SHA-256 over the NUL-joined tuple, top two bits cleared.
// The two keyspaces share class `00` (all four class prefixes are already
// spoken for by the W4 families), so their separation rests entirely on the
// distinct preimage prefix — which is exactly how the W4 families that DO share
// a class separate from each other, and which a test asserts directly for a
// concrete org rather than leaving to argument.
//
// A local implementation rather than an import: the W4 builder's signature is
// welded to `CanonicalAttendanceRolloutOrgKeyV1` AND to the rollout preimage,
// and the acquisition/release helpers around it are private to that module.
// This is the "clone the pattern, do not import-couple" instruction applied
// where import-coupling is not even available.
// ---------------------------------------------------------------------------
const CONTEXT_SOURCE_KEY_PREFIX = 'metasheet2:attendance:context-source:v1'
const LOW_62_MASK = 0x3fffffffffffffffn

/**
 * The NUL separator, built programmatically. NEVER write a raw control byte
 * into a source file: it turns the file into a git "binary" blob, which makes
 * the diff unreviewable AND causes the secret-scan merge gate to skip it.
 */
const NUL = Buffer.from([0])

function nulJoin(parts: readonly string[]): Buffer {
  const buffers: Buffer[] = []
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) buffers.push(NUL)
    buffers.push(Buffer.from(parts[i], 'utf8'))
  }
  return Buffer.concat(buffers)
}

export function buildAttendanceW7ContextSourceAdvisoryKeyV1(
  orgKey: CanonicalAttendanceRolloutOrgKeyV1 | string,
): bigint {
  const canonical = String(parseCanonicalAttendanceRolloutOrgKeyV1(orgKey))
  const digest = createHash('sha256').update(nulJoin([CONTEXT_SOURCE_KEY_PREFIX, canonical])).digest()
  return BigInt.asIntN(64, digest.readBigUInt64BE(0) & LOW_62_MASK)
}

const CONTEXT_SOURCE_LOCK_WAIT_MS = 5000

function isLockNotAvailable(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '55P03'
  )
}

/**
 * SESSION-level exclusive acquisition, as its own standalone (autocommit)
 * statement, on a connection proven idle first.
 *
 * WHY SESSION AND NOT TRANSACTION SCOPE — the W4C-5 P1-2 reasoning, carried
 * over verbatim in mechanism: PostgreSQL fixes a SERIALIZABLE transaction's
 * snapshot at the START of the first statement executed inside it, INCLUDING a
 * statement that itself blocks. So a transaction-scoped acquisition, no matter
 * how early inside the transaction, leaves every predicate below reading a
 * snapshot that predates the wait's resolution. Acquiring at session level
 * before `BEGIN` closes that window by construction rather than narrowing it.
 * This relies on one named premise: the `pg` driver serializes queries per
 * connection (no pipelining), so `BEGIN` is not sent until this acquisition has
 * returned.
 */
async function acquireContextSourceLockSessionExclusive(
  connection: AttendanceW4TransactionClientV1,
  key: bigint,
): Promise<void> {
  await assertConnectionIsIdleV1(connection)
  // `set_config(..., false)` (session-wide, not transaction-local): there is no
  // open transaction yet for a local setting to attach to.
  await connection.query("SELECT set_config('lock_timeout', $1, false)", [
    `${CONTEXT_SOURCE_LOCK_WAIT_MS}ms`,
  ])
  try {
    await connection.query('SELECT pg_advisory_lock($1::bigint)', [key.toString()])
  } catch (error) {
    if (isLockNotAvailable(error)) fail('W7_CONTEXT_SOURCE_TRANSITION_BUSY')
    throw error
  } finally {
    // RESET, never a hardcoded '0': hardcoding would permanently stomp any
    // non-default configured `lock_timeout` for the rest of this pooled
    // connection's session.
    await connection.query('RESET lock_timeout').catch(() => undefined)
  }
}

async function releaseContextSourceLockSessionExclusive(
  connection: AttendanceW4TransactionClientV1,
  key: bigint,
): Promise<void> {
  await connection.query('SELECT pg_advisory_unlock($1::bigint)', [key.toString()])
}

// ---------------------------------------------------------------------------
// Test seams. Module-level overrides, `null` by default; production wiring
// never calls the setters. Same idiom as
// `__setW4C3aRolloutControlAfterExclusiveLockForTests` et al
// (`w4c3a-rollout-control.ts:203-234`).
// ---------------------------------------------------------------------------
let afterExclusiveLockForTests: (() => Promise<void>) | null = null
let beforeEventInsertForTests: (() => Promise<void>) | null = null
let beforeStateUpdateForTests: (() => Promise<void>) | null = null

/** Test-only deterministic barrier, fired after the session lock is held. */
export function __setW7ContextSourceTransitionAfterExclusiveLockForTests(
  hook: (() => Promise<void>) | null,
): void {
  afterExclusiveLockForTests = hook
}

/** Test-only atomicity seam: fires immediately before the event INSERT (the first DML of the pair). */
export function __setW7ContextSourceTransitionBeforeEventInsertForTests(
  hook: (() => Promise<void>) | null,
): void {
  beforeEventInsertForTests = hook
}

/** Test-only atomicity seam: fires after the event INSERT succeeds, before the state UPDATE. */
export function __setW7ContextSourceTransitionBeforeStateUpdateForTests(
  hook: (() => Promise<void>) | null,
): void {
  beforeStateUpdateForTests = hook
}

let insidePlanTransactionForTests: ((trx: AttendanceW4TransactionClientV1) => Promise<void>) | null =
  null

/**
 * Test-only seam fired INSIDE the plan reporter's transaction, receiving that
 * transaction's client.
 *
 * IT EXISTS BECAUSE THE OBVIOUS TEST DOES NOT WORK, and that was discovered by
 * mutation rather than by reading. The natural leg for "plan never commits" is
 * "the table is byte-identical (row hash + `xmin`) after a plan call". That leg
 * passes whether the `finally` issues `ROLLBACK` or `COMMIT`, because a
 * transaction that performed no DML commits nothing observable — so it proves
 * the reporter wrote nothing, which was never in doubt, and proves NOTHING about
 * the `finally` being a rollback. Replacing `ROLLBACK` with `COMMIT` left the
 * whole real-PG suite green.
 *
 * With this seam a test can make the plan's transaction dirty on purpose and
 * then assert the write did not survive. That is the property the unconditional
 * `ROLLBACK` actually buys: it turns "this function does not issue
 * INSERT/UPDATE/DELETE" from a claim about the code into a mechanically enforced
 * invariant about what the database ever durably observes, even against a future
 * edit inside the plan builder that accidentally added a write.
 *
 * Not imported by production wiring; `null` by default.
 */
export function __setW7ContextSourcePlanInsideTransactionForTests(
  hook: ((trx: AttendanceW4TransactionClientV1) => Promise<void>) | null,
): void {
  insidePlanTransactionForTests = hook
}

// ---------------------------------------------------------------------------
// Predicates — W4C-5 §3 style, with per-predicate COUNTS returned by the
// command.
//
// The discipline, verbatim from the W4C-5 amendment §3: "The command returns
// typed per-predicate counts in its result. It does not accept a caller-supplied
// aggregate `ready=true` as a substitute for these queries." The set is
// evaluated INSIDE the transition transaction; a read-only preflight result may
// never be reused as the gate.
// ---------------------------------------------------------------------------

export const ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1 = Object.freeze([
  'ORG_ALLOWLISTED',
  'CONTEXT_SOURCE_ROW_RESOLVABLE',
  'LEGAL_TRANSITION_PAIR',
  'W7_STATE_PRODUCER_DELIVERED',
  'W4_POSTURE_COHERENT',
  'INCOMPLETE_OPERATION',
  'UNRESOLVED_INGRESS_REVIEW',
  'DEFECTIVE_REQUEST_SNAPSHOT',
  'W7_CRITICAL_SHADOW_DIFF',
  'W7_OFF_ROSTER_DIFF',
  'RESUME_REPLAY_ARTIFACT',
  'SUSPEND_SOURCE_WRITERS_SERIALIZED',
] as const)

export type AttendanceW7ContextSourceTransitionPredicateCodeV1 =
  (typeof ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1)[number]

export type AttendanceW7ContextSourceTransitionPredicateV1 = Readonly<{
  code: AttendanceW7ContextSourceTransitionPredicateCodeV1
  applicable: boolean
  pass: boolean
  count: number | null
}>

function passVerdict(
  code: AttendanceW7ContextSourceTransitionPredicateCodeV1,
  applicable: boolean,
  pass: boolean,
  count: number | null,
): AttendanceW7ContextSourceTransitionPredicateV1 {
  return Object.freeze({ code, applicable, pass, count })
}

const GROUP_PRODUCER_STATE_SET = new Set<AttendanceW7ContextSourcePostureStateV1>(
  ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1,
)

/**
 * The states whose entry requires the org's calculation surface to be quiet —
 * the W7 analogue of the W4 boundary's `ELIGIBILITY_AUTHORITY_TARGETS`
 * (`w4c3a-rollout-control.ts:105`). DERIVED from the group-producer set by
 * dropping its first rung (`group_shadow`): a shadow posture writes nothing
 * authoritative, so in-flight legacy work is not a contradiction there, while
 * `group_eligible` / `group_authoritative` both promise that this org's results
 * are already settled.
 */
const QUIESCENCE_REQUIRED_TARGETS: readonly AttendanceW7ContextSourcePostureStateV1[] =
  Object.freeze(
    ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1.filter(
      (state) => state !== 'group_shadow',
    ),
  )

const QUIESCENCE_REQUIRED_TARGET_SET = new Set<AttendanceW7ContextSourcePostureStateV1>(
  QUIESCENCE_REQUIRED_TARGETS,
)

/**
 * Which predicate codes apply to a given pair — DERIVED from the pair, never a
 * hand-kept applicability table (that would be the hand-kept-matrix trap in a
 * second costume). Both the plan reporter and the enforcing boundary read this
 * one function, so the report and the gate cannot disagree about what was
 * evaluated.
 */
export function attendanceW7ContextSourceApplicablePredicatesV1(
  from: AttendanceW7ContextSourcePostureStateV1,
  to: AttendanceW7ContextSourcePostureStateV1,
): readonly AttendanceW7ContextSourceTransitionPredicateCodeV1[] {
  const applicable = new Set<AttendanceW7ContextSourceTransitionPredicateCodeV1>([
    'ORG_ALLOWLISTED',
    'CONTEXT_SOURCE_ROW_RESOLVABLE',
    'LEGAL_TRANSITION_PAIR',
  ])
  if (GROUP_PRODUCER_STATE_SET.has(to)) {
    applicable.add('W7_STATE_PRODUCER_DELIVERED')
    applicable.add('W4_POSTURE_COHERENT')
  }
  if (QUIESCENCE_REQUIRED_TARGET_SET.has(to)) {
    applicable.add('INCOMPLETE_OPERATION')
    applicable.add('UNRESOLVED_INGRESS_REVIEW')
    applicable.add('DEFECTIVE_REQUEST_SNAPSHOT')
  }
  if (from === 'group_shadow' && to === 'group_eligible') {
    applicable.add('W7_CRITICAL_SHADOW_DIFF')
    applicable.add('W7_OFF_ROSTER_DIFF')
  }
  if (isResumePair(from, to)) applicable.add('RESUME_REPLAY_ARTIFACT')
  if (from === 'group_authoritative' && to === 'suspended') {
    applicable.add('SUSPEND_SOURCE_WRITERS_SERIALIZED')
  }
  return Object.freeze(
    ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1.filter((code) =>
      applicable.has(code),
    ),
  )
}

type PredicateEvidenceCounts = Readonly<{
  incompleteOperations: number
  unresolvedReviews: number
  defectiveRequestSnapshots: number
  defectiveRequestSnapshotsByCell: AttendanceRequestSnapshotDefectCountsV1 | null
  undeliveredStateProducers: number
  undeliveredCompareEvidence: number
  suspendSourceWritersInFlight: number
}>

type PredicateEvaluation = Readonly<{
  predicates: readonly AttendanceW7ContextSourceTransitionPredicateV1[]
  counts: PredicateEvidenceCounts
  blocked: boolean
}>

/**
 * Evaluates every predicate code — applicable or not — for the given pair.
 *
 * ORDER OF THE LOCKING READS is deliberate and is part of the lock-order
 * census: `attendance_import_jobs`, then `attendance_records`, then the
 * request-snapshot reader, which is the SAME relative order the W4 transition
 * boundary takes them in (`w4c3a-rollout-control.ts:1544-1553`). Two writers
 * taking the same row families in the same relative order cannot deadlock on
 * them; reversing this order here would create exactly the reverse-order writer
 * the census exists to rule out.
 */
async function evaluatePredicates(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  from: AttendanceW7ContextSourcePostureStateV1,
  to: AttendanceW7ContextSourcePostureStateV1,
  orgAllowlisted: boolean,
  rowResolvable: boolean,
  legalPair: boolean,
): Promise<PredicateEvaluation> {
  const applicable = new Set(attendanceW7ContextSourceApplicablePredicatesV1(from, to))
  const verdicts = new Map<
    AttendanceW7ContextSourceTransitionPredicateCodeV1,
    AttendanceW7ContextSourceTransitionPredicateV1
  >()

  verdicts.set('ORG_ALLOWLISTED', passVerdict('ORG_ALLOWLISTED', true, orgAllowlisted, null))
  verdicts.set(
    'CONTEXT_SOURCE_ROW_RESOLVABLE',
    passVerdict('CONTEXT_SOURCE_ROW_RESOLVABLE', true, rowResolvable, null),
  )
  verdicts.set('LEGAL_TRANSITION_PAIR', passVerdict('LEGAL_TRANSITION_PAIR', true, legalPair, null))

  let incompleteOperations = 0
  let unresolvedReviews = 0
  let defectiveRequestSnapshots = 0
  let defectiveRequestSnapshotsByCell: AttendanceRequestSnapshotDefectCountsV1 | null = null
  let suspendSourceWritersInFlight = 0

  // The three quiescence predicates share one `attendance_import_jobs` /
  // `attendance_records` / snapshot read pass. Gated on the same
  // fail-fast preconditions the boundary itself uses: without an allowlisted
  // org, a resolvable row and a legal pair there is nothing further to safely
  // evaluate.
  const canEvaluateDbPredicates = orgAllowlisted && rowResolvable && legalPair

  if (canEvaluateDbPredicates && applicable.has('INCOMPLETE_OPERATION')) {
    incompleteOperations = await countIncompleteOperationsV1(trx, orgId)
    verdicts.set(
      'INCOMPLETE_OPERATION',
      passVerdict('INCOMPLETE_OPERATION', true, incompleteOperations === 0, incompleteOperations),
    )
    unresolvedReviews = await countUnresolvedIngressReviewsV1(trx, orgId)
    verdicts.set(
      'UNRESOLVED_INGRESS_REVIEW',
      passVerdict('UNRESOLVED_INGRESS_REVIEW', true, unresolvedReviews === 0, unresolvedReviews),
    )
    const snapshotDefects = await readAttendanceRequestSnapshotDefectReportV1(trx, orgId)
    defectiveRequestSnapshots = snapshotDefects.totalDefectiveRequests
    defectiveRequestSnapshotsByCell = snapshotDefects.byCell
    verdicts.set(
      'DEFECTIVE_REQUEST_SNAPSHOT',
      passVerdict(
        'DEFECTIVE_REQUEST_SNAPSHOT',
        true,
        defectiveRequestSnapshots === 0,
        defectiveRequestSnapshots,
      ),
    )
  }

  // Suspend: the org's source writers must be quiesced before the machine is
  // parked, so that §5.3's "changes no operation/source/result/pointer/job row"
  // is a statement about a settled org rather than a race. Counted from the
  // SAME durable in-flight-job evidence `INCOMPLETE_OPERATION` uses — reused
  // as-is rather than re-derived, so the two cannot disagree about what "in
  // flight" means.
  if (canEvaluateDbPredicates && applicable.has('SUSPEND_SOURCE_WRITERS_SERIALIZED')) {
    suspendSourceWritersInFlight = await countIncompleteOperationsV1(trx, orgId)
    verdicts.set(
      'SUSPEND_SOURCE_WRITERS_SERIALIZED',
      passVerdict(
        'SUSPEND_SOURCE_WRITERS_SERIALIZED',
        true,
        suspendSourceWritersInFlight === 0,
        suspendSourceWritersInFlight,
      ),
    )
  }

  // W4 posture coherence — [OWNER-CONFIRM] C-1 answered (a): the transition
  // boundary refuses entry into a W7 group state while the W4 segment-calculation
  // posture is not authoring segments.
  //
  // NARROWING, stated here rather than only in the PR body, because the code
  // must not imply a guarantee the mechanism does not provide: the shared
  // class-`00` rollout lock below is the documented precondition of
  // `resolveSegmentCalculationPosture` (`w4c0-identity.ts:442-443`) and every
  // other caller in the tree takes it exactly this way — but it is acquired
  // INSIDE this SERIALIZABLE transaction, whose snapshot was already fixed by
  // an earlier statement. So a W4 transition that commits while this
  // transaction waits on that lock is not visible to this read. The verdict is
  // therefore mutually exclusive with concurrent W4 transitions going forward,
  // NOT proof that no W4 transition committed during the wait. This predicate
  // is an entry precondition on a separate machine, not a read that authorizes
  // a W4 write, which is why the same discipline every other caller uses is
  // sufficient here — and why the claim is narrowed rather than overstated.
  //
  // Singly deletable by construction: this block is the predicate's ONLY
  // contribution, and the producer-side coherence fence that W7-1b's O-2
  // proposes lives at the three plugin producers, not here. If both land,
  // deleting either must red only its own legs.
  if (canEvaluateDbPredicates && applicable.has('W4_POSTURE_COHERENT')) {
    await acquireAttendanceCalculationRolloutLock(
      trx,
      parseCanonicalAttendanceRolloutOrgKeyV1(orgId),
      'shared',
    )
    const w4Posture = await resolveSegmentCalculationPosture(trx, orgId)
    // Read off the W4 posture's OWN semantic field rather than re-listing which
    // W4 states count as coherent: `authorSegments === 'full'` is exactly "this
    // org's W4 machine is authoring segments" (`w4c0-identity.ts` POSTURE_TABLE),
    // and it is `'none'` for both `legacy` and `suspended`.
    verdicts.set(
      'W4_POSTURE_COHERENT',
      passVerdict('W4_POSTURE_COHERENT', true, w4Posture.authorSegments === 'full', null),
    )
  }

  // Static declarations (no DB read), so evaluated unconditionally for their
  // applicable pairs — whether a producer is delivered is a fact about the
  // deployed code, not about this org's rows. Same placement rationale as the
  // W4 boundary's Gate D (`w4c3a-rollout-control.ts:1285-1289`).
  const undeliveredStateProducers = GROUP_PRODUCER_STATE_SET.has(to)
    ? isAttendanceW7ContextSourceStateProducerDeliveredV1(to)
      ? 0
      : 1
    : 0
  if (applicable.has('W7_STATE_PRODUCER_DELIVERED')) {
    verdicts.set(
      'W7_STATE_PRODUCER_DELIVERED',
      passVerdict(
        'W7_STATE_PRODUCER_DELIVERED',
        true,
        undeliveredStateProducers === 0,
        undeliveredStateProducers,
      ),
    )
  }

  const undeliveredCompareEvidence = ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1.filter(
    (probe) => !isAttendanceW7ContextSourceCompareEvidenceDeliveredV1(probe),
  ).length
  for (const probe of ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1) {
    if (!applicable.has(probe)) continue
    const delivered = isAttendanceW7ContextSourceCompareEvidenceDeliveredV1(probe)
    // DECLARED-UNDELIVERED, never silently absent: the code is emitted, it is
    // applicable for this pair, and it FAILS with `count: null` — "this
    // criterion has no producer yet", which is not the same claim as "this
    // criterion evaluated to zero". A count is reported only once W7-2 lands
    // and supplies one.
    verdicts.set(probe, passVerdict(probe, true, delivered, null))
  }

  // Resume: satisfied by the widened evidence-reference key set (validated at
  // input time, before any DB access), not by a DB count. Emitted so the
  // reporter is total over the code set and so the plan shows WHY the resume
  // pair carries a wider manifest.
  if (applicable.has('RESUME_REPLAY_ARTIFACT')) {
    verdicts.set('RESUME_REPLAY_ARTIFACT', passVerdict('RESUME_REPLAY_ARTIFACT', true, true, null))
  }

  // Totality: every code appears exactly once, applicable or not. A
  // non-applicable predicate is still emitted (`applicable: false, pass: true`),
  // so the array is always all-N and a consumer never has to distinguish
  // "absent" from "not evaluated".
  const predicates = ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1.map(
    (code) => verdicts.get(code) ?? passVerdict(code, false, true, null),
  )

  return Object.freeze({
    predicates: Object.freeze(predicates),
    counts: Object.freeze({
      incompleteOperations,
      unresolvedReviews,
      defectiveRequestSnapshots,
      defectiveRequestSnapshotsByCell,
      undeliveredStateProducers,
      undeliveredCompareEvidence,
      suspendSourceWritersInFlight,
    }),
    blocked: predicates.some((predicate) => predicate.applicable && !predicate.pass),
  })
}

/**
 * The refusal code each failing predicate raises at the enforcing boundary.
 * Total over the code enumeration (TypeScript enforces it), so a new predicate
 * cannot be added without deciding what its refusal is called — the shape that
 * prevents a predicate that reports `pass: false` in the plan but silently
 * proceeds in the writer.
 */
const PREDICATE_REFUSAL_CODES: Readonly<
  Record<AttendanceW7ContextSourceTransitionPredicateCodeV1, string>
> = Object.freeze({
  ORG_ALLOWLISTED: 'W7_CONTEXT_SOURCE_TRANSITION_ORG_NOT_ALLOWLISTED',
  CONTEXT_SOURCE_ROW_RESOLVABLE: 'W7_CONTEXT_SOURCE_TRANSITION_STATE_MISSING',
  LEGAL_TRANSITION_PAIR: 'W7_CONTEXT_SOURCE_TRANSITION_ILLEGAL_TRANSITION',
  W7_STATE_PRODUCER_DELIVERED: 'W7_CONTEXT_SOURCE_TRANSITION_STATE_PRODUCER_NOT_DELIVERED',
  W4_POSTURE_COHERENT: 'W7_CONTEXT_SOURCE_TRANSITION_W4_POSTURE_INCOHERENT',
  INCOMPLETE_OPERATION: 'W7_CONTEXT_SOURCE_TRANSITION_INCOMPLETE_OPERATION',
  UNRESOLVED_INGRESS_REVIEW: 'W7_CONTEXT_SOURCE_TRANSITION_UNRESOLVED_REVIEW',
  DEFECTIVE_REQUEST_SNAPSHOT: 'W7_CONTEXT_SOURCE_TRANSITION_REQUEST_SNAPSHOT_DEFECTIVE',
  W7_CRITICAL_SHADOW_DIFF: 'W7_CONTEXT_SOURCE_TRANSITION_COMPARE_EVIDENCE_NOT_DELIVERED',
  W7_OFF_ROSTER_DIFF: 'W7_CONTEXT_SOURCE_TRANSITION_COMPARE_EVIDENCE_NOT_DELIVERED',
  RESUME_REPLAY_ARTIFACT: 'W7_CONTEXT_SOURCE_TRANSITION_RESUME_ARTIFACT_MISSING',
  SUSPEND_SOURCE_WRITERS_SERIALIZED: 'W7_CONTEXT_SOURCE_TRANSITION_SOURCE_WRITERS_ACTIVE',
})

export const ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_REFUSAL_CODES_V1: Readonly<
  Record<AttendanceW7ContextSourceTransitionPredicateCodeV1, string>
> = PREDICATE_REFUSAL_CODES

// ---------------------------------------------------------------------------
// Persisted-row access.
// ---------------------------------------------------------------------------

type PersistedContextSourceRow = Readonly<{
  state: AttendanceW7ContextSourcePostureStateV1
  version: number
}>

/**
 * The three fail-closed throws the READ resolver already defines
 * (`w7-resolver/w7-context-source-posture-resolver.ts:71-73`) apply on the
 * write side too, with this module's own code prefix: an ambiguous, invalid, or
 * out-of-scope row must NEVER collapse to `off`, because that would make a
 * corrupt posture row indistinguishable from an unconfigured org — precisely
 * the corruption-blindness W7-R4 exists to prevent.
 */
function parsePersistedRow(row: Record<string, unknown>): PersistedContextSourceRow {
  const state = row.state
  const version = row.version
  const scope = row.scope
  if (
    typeof state !== 'string' ||
    !CONTEXT_SOURCE_STATE_SET.has(state as AttendanceW7ContextSourcePostureStateV1)
  ) {
    fail('W7_CONTEXT_SOURCE_TRANSITION_STATE_INVALID')
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    fail('W7_CONTEXT_SOURCE_TRANSITION_STATE_INVALID')
  }
  if (scope !== 'synthetic_staging') fail('W7_CONTEXT_SOURCE_TRANSITION_SCOPE_INVALID')
  return { state: state as AttendanceW7ContextSourcePostureStateV1, version }
}

/**
 * Locks the posture row for the transition, bootstrapping it ONLY for the
 * ladder's first rung and ONLY for an allowlisted org.
 *
 * The bootstrap INSERT writes the BASE state (`off`, version 1, no prior
 * state); the subsequent UPDATE is what moves it to `group_shadow`. That is the
 * W4 shape verbatim (`lockRolloutStateForBootstrapOrRead`) and it is what makes
 * the trigger's INSERT rule (`state='off' AND prior_state IS NULL`) and its
 * UPDATE rule two separate, independently testable clauses instead of one
 * combined special case.
 */
async function lockContextSourceRowForBootstrapOrRead(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  actorId: string,
  engineVersion: string,
  expectedState: AttendanceW7ContextSourcePostureStateV1,
  targetState: AttendanceW7ContextSourcePostureStateV1,
  orgAllowlisted: boolean,
): Promise<PersistedContextSourceRow> {
  const result = await trx.query(
    `SELECT state, scope, version FROM attendance_calculation_context_source_state
      WHERE org_id = $1 FOR UPDATE`,
    [orgId],
  )
  if (result.rows.length > 1) fail('W7_CONTEXT_SOURCE_TRANSITION_STATE_AMBIGUOUS')
  if (result.rows.length === 1) return parsePersistedRow(result.rows[0])

  const canBootstrap = orgAllowlisted && expectedState === 'off' && targetState === 'group_shadow'
  if (!canBootstrap) fail('W7_CONTEXT_SOURCE_TRANSITION_STATE_MISSING')
  await trx.query(
    `INSERT INTO attendance_calculation_context_source_state
       (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
     VALUES ($1, 'off', 'synthetic_staging', 1, NULL, $2, 'context_source_transition', $3)`,
    [orgId, engineVersion, actorId],
  )
  return { state: 'off', version: 1 }
}

// ---------------------------------------------------------------------------
// The read-only `plan` reporter.
// ---------------------------------------------------------------------------

export type AttendanceW7ContextSourceTransitionPlanInputV1 = Readonly<{
  orgId: string
  targetState: AttendanceW7ContextSourcePostureStateV1
}>

export type AttendanceW7ContextSourceTransitionPlanV1 = Readonly<{
  orgId: string
  orgAllowlisted: boolean
  rowExists: boolean
  currentState: AttendanceW7ContextSourcePostureStateV1
  currentVersion: number | null
  priorState: AttendanceW7ContextSourcePostureStateV1 | null
  targetState: AttendanceW7ContextSourcePostureStateV1
  legalPair: boolean
  ladderRole: AttendanceW7ContextSourceLadderRoleV1 | null
  canBootstrap: boolean
  predicates: readonly AttendanceW7ContextSourceTransitionPredicateV1[]
  blocked: boolean
}>

/**
 * Read-only sibling of `lockContextSourceRowForBootstrapOrRead`: no `FOR
 * UPDATE`, and it NEVER inserts a bootstrap row. A real bootstrap INSERT
 * belongs exclusively to the transactional boundary — issuing one here, even
 * inside a transaction that is always rolled back, would defeat the point of a
 * dynamic zero-write proof over the statements this function sends. A missing
 * row is reported as `rowExists: false` with the effective current state
 * `off` (the only state a missing row can mean, matching the boundary's own
 * bootstrap precondition), never fabricated.
 */
async function readContextSourceRowForPlan(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<
  Readonly<{
    rowExists: boolean
    state: AttendanceW7ContextSourcePostureStateV1
    version: number | null
    priorState: AttendanceW7ContextSourcePostureStateV1 | null
  }>
> {
  const result = await trx.query(
    `SELECT state, scope, version, prior_state
       FROM attendance_calculation_context_source_state WHERE org_id = $1`,
    [orgId],
  )
  if (result.rows.length === 0) {
    return { rowExists: false, state: 'off', version: null, priorState: null }
  }
  if (result.rows.length > 1) fail('W7_CONTEXT_SOURCE_TRANSITION_STATE_AMBIGUOUS')
  const parsed = parsePersistedRow(result.rows[0])
  const priorStateRaw = result.rows[0].prior_state
  if (
    priorStateRaw !== null &&
    (typeof priorStateRaw !== 'string' ||
      !CONTEXT_SOURCE_STATE_SET.has(priorStateRaw as AttendanceW7ContextSourcePostureStateV1))
  ) {
    fail('W7_CONTEXT_SOURCE_TRANSITION_STATE_INVALID')
  }
  return {
    rowExists: true,
    state: parsed.state,
    version: parsed.version,
    priorState:
      priorStateRaw === null ? null : (priorStateRaw as AttendanceW7ContextSourcePostureStateV1),
  }
}

async function buildContextSourcePlan(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  targetState: AttendanceW7ContextSourcePostureStateV1,
): Promise<AttendanceW7ContextSourceTransitionPlanV1> {
  const orgAllowlisted = isAttendanceW7ContextSourceOrgAllowlistedV1(orgId)
  const persisted = await readContextSourceRowForPlan(trx, orgId)
  const currentState = persisted.state
  const row = findAttendanceW7ContextSourceTransitionRowV1(currentState, targetState)
  const canBootstrap =
    !persisted.rowExists && orgAllowlisted && currentState === 'off' && targetState === 'group_shadow'
  const rowResolvable = persisted.rowExists || canBootstrap

  const evaluation = await evaluatePredicates(
    trx,
    orgId,
    currentState,
    targetState,
    orgAllowlisted,
    rowResolvable,
    row !== undefined,
  )

  return Object.freeze({
    orgId,
    orgAllowlisted,
    rowExists: persisted.rowExists,
    currentState,
    currentVersion: persisted.version,
    priorState: persisted.priorState,
    targetState,
    legalPair: row !== undefined,
    ladderRole: row ? row.ladderRole : null,
    canBootstrap,
    predicates: evaluation.predicates,
    blocked: evaluation.blocked,
  })
}

/**
 * The tooling contract's read-only `plan` reporter. Performs ZERO persisted
 * writes: the whole body runs inside a transaction this function
 * UNCONDITIONALLY rolls back in its `finally` — it NEVER issues `COMMIT`, on
 * any path, including a thrown error. That is what turns "this function does
 * not issue INSERT/UPDATE/DELETE" from a claim about the code above into a
 * mechanically enforced invariant about what the database ever durably
 * observes, even against a future edit that accidentally adds a write.
 *
 * `connection` must be idle — enforced (not merely documented) before `BEGIN`,
 * because on a dirty connection PostgreSQL only WARNs on the nested `BEGIN`,
 * and this function's own unconditional `finally` ROLLBACK would then abort the
 * CALLER's entire outer transaction.
 *
 * Advisory only: this report can go stale the instant it returns. Only the
 * boundary transaction's own re-evaluation, under the exclusive context-source
 * lock, is ever authoritative.
 */
export async function planAttendanceW7ContextSourceTransitionV1(
  connection: AttendanceW4TransactionClientV1,
  rawInput: AttendanceW7ContextSourceTransitionPlanInputV1,
): Promise<AttendanceW7ContextSourceTransitionPlanV1> {
  if (typeof rawInput !== 'object' || rawInput === null) {
    fail('W7_CONTEXT_SOURCE_TRANSITION_INPUT_INVALID')
  }
  const orgId = String(parseCanonicalAttendanceRolloutOrgKeyV1(rawInput.orgId))
  const targetState = requireW7ContextSourceState(
    rawInput.targetState,
    'W7_CONTEXT_SOURCE_TRANSITION_INPUT_INVALID',
  )
  await assertConnectionIsIdleV1(connection)
  await connection.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  try {
    await connection.query("SELECT set_config('statement_timeout', $1, true)", [
      String(W4_TRANSACTION_STATEMENT_TIMEOUT_MS),
    ])
    await insidePlanTransactionForTests?.(connection)
    return await buildContextSourcePlan(connection, orgId, targetState)
  } finally {
    await connection.query('ROLLBACK').catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// The single writer.
// ---------------------------------------------------------------------------

export type AttendanceW7ContextSourceTransitionResultV1 = Readonly<{
  orgId: string
  state: AttendanceW7ContextSourcePostureStateV1
  priorState: AttendanceW7ContextSourcePostureStateV1
  version: number
}>

export async function transitionAttendanceW7ContextSourceV1(
  connection: AttendanceW4TransactionClientV1,
  rawInput: AttendanceW7ContextSourceTransitionInputV1,
): Promise<AttendanceW7ContextSourceTransitionResultV1> {
  // PHASE 0 — pure validation. Nothing below this line has touched the
  // connection: an illegal pair, a malformed manifest or a bad reference set is
  // refused with zero DB access at all, which a test proves with a connection
  // whose query function throws on first call.
  const input = normalizeTransitionInput(rawInput)
  const advisoryKey = buildAttendanceW7ContextSourceAdvisoryKeyV1(input.orgId)

  // PHASE 1 — the session-scoped exclusive lock, acquired as its own statement
  // strictly BEFORE any transaction is opened. See
  // `acquireContextSourceLockSessionExclusive` for why session scope is
  // load-bearing rather than stylistic.
  await acquireContextSourceLockSessionExclusive(connection, advisoryKey)
  try {
    // Inside the try, not before it: a throwing test hook must still release
    // the lock through the `finally` below rather than leak it.
    await afterExclusiveLockForTests?.()
    return await runAttendanceResultOperationTransactionV1(connection, async (trx) => {
      // PHASE 2 — inside SERIALIZABLE, ZERO DML except the bootstrap INSERT
      // that materializes the ladder's base row.
      const orgAllowlisted = isAttendanceW7ContextSourceOrgAllowlistedV1(input.orgId)
      if (!orgAllowlisted) fail(PREDICATE_REFUSAL_CODES.ORG_ALLOWLISTED)

      const persisted = await lockContextSourceRowForBootstrapOrRead(
        trx,
        input.orgId,
        input.actorId,
        input.engineVersion,
        input.expectedState,
        input.targetState,
        orgAllowlisted,
      )

      // A stale caller belief about current state/version is rejected under
      // lock, with zero further DML, even though the input-time matrix check
      // already passed against the CLAIMED pair.
      if (persisted.state !== input.expectedState || persisted.version !== input.expectedVersion) {
        fail('W7_CONTEXT_SOURCE_TRANSITION_STALE_EXPECTED_STATE')
      }
      const currentState = persisted.state

      // Second matrix check, against the PERSISTED state. Defense in depth and
      // documented as such: once the staleness check above has passed,
      // `currentState` is provably identical to `input.expectedState` and the
      // pair was already matrix-validated at input time, so this call is
      // currently redundant with them. It is kept against a future refactor
      // that decouples `currentState` from the staleness check — never trusting
      // the caller's claim alone, only currently redundant with it.
      const row = findAttendanceW7ContextSourceTransitionRowV1(currentState, input.targetState)
      if (!row) fail(PREDICATE_REFUSAL_CODES.LEGAL_TRANSITION_PAIR)

      // The predicate set, evaluated INSIDE this transaction — never a reused
      // preflight result.
      const evaluation = await evaluatePredicates(
        trx,
        input.orgId,
        currentState,
        input.targetState,
        orgAllowlisted,
        true,
        true,
      )
      // Each applicable failing predicate raises its OWN refusal code, in the
      // enumeration's order, so a caller can tell which criterion blocked it
      // and a test can seed exactly one failure and assert exactly one code.
      for (const predicate of evaluation.predicates) {
        if (predicate.applicable && !predicate.pass) fail(PREDICATE_REFUSAL_CODES[predicate.code])
      }

      // PHASE 3 — the only two DML statements of the transition, in a fixed
      // order: the EVENT insert first, the STATE update second. Both share one
      // transaction, so either order would be atomic; this ordering also lets
      // the two failure-injection seams independently exercise "a failed event
      // insert leaves state/version unchanged" and "a failed state update
      // leaves no event".
      await beforeEventInsertForTests?.()
      await trx.query(
        `INSERT INTO attendance_calculation_context_source_events
           (org_id, prior_state, new_state, reason_code, engine_version, actor_id, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          input.orgId,
          currentState,
          input.targetState,
          input.reasonCode,
          input.engineVersion,
          input.actorId,
          JSON.stringify({
            schemaVersion: 1,
            manifestSha256: input.evidenceManifestSha256,
            correlationId: input.correlationId,
            targetState: input.targetState,
            ladderRole: row.ladderRole,
            preconditionCounts: {
              incompleteOperations: evaluation.counts.incompleteOperations,
              unresolvedReviews: evaluation.counts.unresolvedReviews,
              defectiveRequestSnapshots: evaluation.counts.defectiveRequestSnapshots,
              defectiveRequestSnapshotsByCell: evaluation.counts.defectiveRequestSnapshotsByCell,
              undeliveredStateProducers: evaluation.counts.undeliveredStateProducers,
              undeliveredCompareEvidence: evaluation.counts.undeliveredCompareEvidence,
              suspendSourceWritersInFlight: evaluation.counts.suspendSourceWritersInFlight,
            },
            references: input.evidenceReferences,
          }),
        ],
      )
      await beforeStateUpdateForTests?.()
      await trx.query(
        `UPDATE attendance_calculation_context_source_state
            SET state = $2, prior_state = state, engine_version = $3, reason_code = $4,
                actor_id = $5, changed_at = now(), version = version + 1
          WHERE org_id = $1`,
        [input.orgId, input.targetState, input.engineVersion, input.reasonCode, input.actorId],
      )
      return Object.freeze({
        orgId: input.orgId,
        state: input.targetState,
        priorState: currentState,
        version: persisted.version + 1,
      })
    })
  } finally {
    // PHASE 4 — released unconditionally, including on every throwing path
    // above: a normal success or a precondition rejection must never leave the
    // session holding this lock for the next checkout of this pooled
    // connection.
    //
    // The `.catch(() => undefined)` is deliberate, not sloppy: a `finally` that
    // itself throws REPLACES whatever the `try` returned or threw — so an
    // unguarded release failure (e.g. a dropped connection) would turn an
    // already-COMMITTED transition into a thrown exception, or replace a typed
    // refusal with an opaque connection error. Both are strictly worse than a
    // lock outliving this call by one dropped connection's remaining lifetime,
    // and PostgreSQL releases session-level advisory locks automatically once
    // the server observes that connection close.
    await releaseContextSourceLockSessionExclusive(connection, advisoryKey).catch(() => undefined)
  }
}
