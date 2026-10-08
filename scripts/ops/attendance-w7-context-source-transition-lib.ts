/**
 * W7-3 (#4556) operator context-source transition tooling — pure, DB-free module.
 *
 * A clone of `attendance-w4c5-rollout-transition-lib.ts` applied to the W7
 * context-source posture ladder. Everything here is pure (no DB, no filesystem,
 * no network, no clock read except through an INJECTED `nowMs`) so it is
 * unit-testable without a real PostgreSQL connection.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: decide transition legality,
 * evaluate a database-backed precondition, or perform any context-source DML.
 * Those stay exclusively in
 * `packages/core-backend/src/attendance/w7-context-source-transition.ts` (red
 * line W7-R4: one writer). This module only parses CLI arguments,
 * canonicalizes/hashes the evidence manifest and the plan digest, validates
 * manifest SHAPE (never re-validates a database precondition), and orchestrates
 * plan-then-apply sequencing against an INJECTED `plan`/`transition` pair — so
 * the sequencing is unit-testable with fakes and the real CLI wires the real
 * core-backend functions.
 *
 * SHIPPING THE TOOL IS NOT RUNNING IT. No CLI execution against any environment
 * is authorized by the slice that adds this file.
 *
 * TYPE-ONLY imports of core-backend, deliberately. `packages/core-backend`
 * declares no `"type"` field (CommonJS) while `scripts/ops/` resolves under the
 * root `"type": "module"`; a bare value-level `import` crossing that boundary
 * hits Node's CJS/ESM interop and silently collapses named exports onto
 * `.default`. Keeping this module type-only avoids the dance entirely — the CLI
 * does the dynamic-import unwrap.
 */
import { createHash } from 'node:crypto'

import type {
  AttendanceW7ContextSourcePostureStateV1,
} from '../../packages/core-backend/src/attendance/w7-context-source-posture-contract'
import type {
  AttendanceW7ContextSourceTransitionPlanV1,
  AttendanceW7ContextSourceTransitionResultV1,
  AttendanceW7EvidenceReferencesV1,
} from '../../packages/core-backend/src/attendance/w7-context-source-transition'

/**
 * Local mirror of `ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1`, duplicated
 * rather than imported for the CJS/ESM reason above — and kept honest against
 * drift by the exhaustiveness constraint below, which TypeScript itself refuses
 * to compile if this literal and the canonical union ever diverge in EITHER
 * direction. That is a compiler-enforced two-way constraint, not a trust-me
 * comment.
 */
const ATTENDANCE_W7_CONTEXT_SOURCE_STATES_LOCAL_V1 = Object.freeze([
  'off',
  'group_shadow',
  'group_eligible',
  'group_authoritative',
  'suspended',
] as const)
type LocalContextSourceState = (typeof ATTENDANCE_W7_CONTEXT_SOURCE_STATES_LOCAL_V1)[number]
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertContextSourceStatesMatchBothWays = [LocalContextSourceState] extends [
  AttendanceW7ContextSourcePostureStateV1,
]
  ? [AttendanceW7ContextSourcePostureStateV1] extends [LocalContextSourceState]
    ? true
    : never
  : never
const _assertContextSourceStatesMatchBothWays: _AssertContextSourceStatesMatchBothWays = true
void _assertContextSourceStatesMatchBothWays

export class AttendanceW7ToolError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW7ToolError'
    this.code = code
  }
}

function failTool(code: string): never {
  throw new AttendanceW7ToolError(code)
}

// ---------------------------------------------------------------------------
// Confirmation token. No implicit `--yes`, no default, no boolean: apply
// refuses unless this EXACT literal string is supplied.
// ---------------------------------------------------------------------------
export const ATTENDANCE_W7_CONFIRMATION_TOKEN_V1 =
  'I_UNDERSTAND_THIS_TRANSITIONS_A_SYNTHETIC_ORG_CONTEXT_SOURCE_ONLY'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64_PATTERN = /^[0-9a-f]{64}$/
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const ATTENDANCE_W7_MANIFEST_FRESHNESS_MS_V1 = 15 * 60 * 1000
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000

// ---------------------------------------------------------------------------
// Canonical JSON + SHA-256 — one serialization discipline shared by the manifest
// hash and the plan digest: recursively sorted object keys, no whitespace, array
// order preserved verbatim (arrays are ordered data, never resorted).
// ---------------------------------------------------------------------------
function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalizeValue((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function canonicalJsonV1(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value))
}

export function sha256HexV1(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Pair classifier. DELIBERATELY re-derived here rather than imported — the same
 * "independent verification, not a second write path" discipline the W4C-5 tool
 * uses. This module NEVER decides whether a pair is LEGAL (only the boundary's
 * own matrix does that, surfaced through the plan's `legalPair`); it only
 * decides which manifest FIELDS a pair requires, which is a tooling-shape
 * question, not a transition-legality one.
 */
export function isResumePairV1(
  from: AttendanceW7ContextSourcePostureStateV1,
  to: AttendanceW7ContextSourcePostureStateV1,
): boolean {
  return from === 'suspended' && to === 'group_authoritative'
}

/** Entry into the group arm — the pairs whose manifest must additionally carry
 *  the group-producer attestations. */
export function isGroupArmEntryPairV1(
  from: AttendanceW7ContextSourcePostureStateV1,
  to: AttendanceW7ContextSourcePostureStateV1,
): boolean {
  void from
  return to !== 'off' && to !== 'suspended'
}

export const ATTENDANCE_W7_MANIFEST_BASE_KEYS_V1 = Object.freeze([
  'schemaVersion',
  'collectedAt',
  'orgId',
  'targetState',
  'imageSha',
  'pendingMigrations',
  'serviceHealthy',
  'customerData',
  'externalNotificationsDisabled',
  'externalDestinationCount',
  'ownerAuthorizationRef',
  'syntheticOrgRef',
] as const)

export const ATTENDANCE_W7_MANIFEST_GROUP_ARM_KEYS_V1 = Object.freeze([
  'groupProducerAttestationRef',
] as const)

export const ATTENDANCE_W7_MANIFEST_RESUME_KEYS_V1 = Object.freeze([
  'ownerIncidentReviewRef',
  'offlineReplayArtifactRef',
] as const)

function requireExactObjectKeys(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    failTool('W7_TOOL_MANIFEST_INVALID')
  }
  const prototype = Object.getPrototypeOf(raw)
  if (prototype !== Object.prototype && prototype !== null) failTool('W7_TOOL_MANIFEST_INVALID')
  if (Object.getOwnPropertySymbols(raw).length > 0) failTool('W7_TOOL_MANIFEST_INVALID')
  const own = Object.getOwnPropertyNames(raw)
  if (own.length !== keys.length) failTool('W7_TOOL_MANIFEST_INVALID')
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) failTool('W7_TOOL_MANIFEST_INVALID')
  }
  return raw as Record<string, unknown>
}

function requireRefString(value: unknown): string {
  if (typeof value !== 'string' || !REF_PATTERN.test(value)) failTool('W7_TOOL_MANIFEST_INVALID')
  return value
}

function requireHex64(value: unknown, code: string): string {
  if (typeof value !== 'string' || !HEX64_PATTERN.test(value)) failTool(code)
  return value
}

/**
 * The five LITERAL-PINNED environment attestations. Each is compared to an exact
 * value, never to a truthy/falsy coercion: `pendingMigrations: '0'` or
 * `customerData: 0` must be refused, because a manifest is operator-authored and
 * a coercing check is how a wrong answer becomes a right-looking one.
 */
function requireLiteralZero(value: unknown): 0 {
  if (value !== 0) failTool('W7_TOOL_MANIFEST_INVALID')
  return 0
}

function requireLiteralTrue(value: unknown): true {
  if (value !== true) failTool('W7_TOOL_MANIFEST_INVALID')
  return true
}

function requireLiteralFalse(value: unknown): false {
  if (value !== false) failTool('W7_TOOL_MANIFEST_INVALID')
  return false
}

export type AttendanceW7ValidatedManifestV1 = Readonly<{
  evidenceManifestSha256: string
  evidenceReferences: AttendanceW7EvidenceReferencesV1
}>

/**
 * Validates manifest SHAPE, cross-matches it against the CLI-claimed
 * org/target/expected pair, then derives the boundary's opaque
 * `evidenceReferences` and the manifest hash FROM the validated manifest — the
 * operator never enters those reference strings twice.
 *
 * `nowMs` is INJECTED (never a `Date.now()` read inside) so freshness is
 * testable without real-clock flakiness.
 */
export function validateAttendanceW7ManifestV1(
  raw: unknown,
  context: Readonly<{
    orgId: string
    expectedState: AttendanceW7ContextSourcePostureStateV1
    targetState: AttendanceW7ContextSourcePostureStateV1
  }>,
  nowMs: number,
): AttendanceW7ValidatedManifestV1 {
  const resume = isResumePairV1(context.expectedState, context.targetState)
  const groupArm = isGroupArmEntryPairV1(context.expectedState, context.targetState)
  const keys = [
    ...ATTENDANCE_W7_MANIFEST_BASE_KEYS_V1,
    ...(groupArm ? ATTENDANCE_W7_MANIFEST_GROUP_ARM_KEYS_V1 : []),
    ...(resume ? ATTENDANCE_W7_MANIFEST_RESUME_KEYS_V1 : []),
  ]
  const input = requireExactObjectKeys(raw, keys)

  if (input.schemaVersion !== 1) failTool('W7_TOOL_MANIFEST_INVALID')
  if (typeof input.collectedAt !== 'string') failTool('W7_TOOL_MANIFEST_INVALID')
  const collectedAtMs = Date.parse(input.collectedAt)
  if (!Number.isFinite(collectedAtMs)) failTool('W7_TOOL_MANIFEST_INVALID')
  if (collectedAtMs > nowMs + CLOCK_SKEW_TOLERANCE_MS) failTool('W7_TOOL_MANIFEST_STALE')
  if (nowMs - collectedAtMs > ATTENDANCE_W7_MANIFEST_FRESHNESS_MS_V1) {
    failTool('W7_TOOL_MANIFEST_STALE')
  }

  if (typeof input.orgId !== 'string' || !UUID_PATTERN.test(input.orgId)) {
    failTool('W7_TOOL_MANIFEST_INVALID')
  }
  if (input.orgId !== context.orgId) failTool('W7_TOOL_MANIFEST_ORG_MISMATCH')

  if (
    typeof input.targetState !== 'string' ||
    !(ATTENDANCE_W7_CONTEXT_SOURCE_STATES_LOCAL_V1 as readonly string[]).includes(input.targetState)
  ) {
    failTool('W7_TOOL_MANIFEST_INVALID')
  }
  if (input.targetState !== context.targetState) failTool('W7_TOOL_MANIFEST_TARGET_MISMATCH')

  const imageSha = requireRefString(input.imageSha)
  requireLiteralZero(input.pendingMigrations)
  requireLiteralTrue(input.serviceHealthy)
  requireLiteralFalse(input.customerData)
  requireLiteralTrue(input.externalNotificationsDisabled)
  requireLiteralZero(input.externalDestinationCount)
  const ownerAuthorizationRef = requireRefString(input.ownerAuthorizationRef)
  const syntheticOrgRef = requireRefString(input.syntheticOrgRef)
  if (groupArm) requireRefString(input.groupProducerAttestationRef)

  const references: Record<string, string> = {
    imageSha,
    ownerAuthorizationRef,
    syntheticOrgRef,
  }
  if (resume) {
    references.ownerIncidentReviewRef = requireRefString(input.ownerIncidentReviewRef)
    references.offlineReplayArtifactRef = requireRefString(input.offlineReplayArtifactRef)
  }

  return Object.freeze({
    evidenceManifestSha256: sha256HexV1(canonicalJsonV1(input)),
    evidenceReferences: Object.freeze(references) as AttendanceW7EvidenceReferencesV1,
  })
}

/**
 * Plan digest over the exact fields that determine whether a previously computed
 * plan is still the SAME plan, with NO wall-clock field — so running `plan`
 * twice against an unchanged database yields the identical digest and `apply`
 * does not spuriously refuse a digest that is in fact still current.
 *
 * Covers EVERY observable field of `AttendanceW7ContextSourceTransitionPlanV1`
 * plus every predicate's four sub-fields, so any change the plan can observe
 * (state drifted, a predicate started failing, the org fell out of the
 * allowlist, a producer declaration flipped) already changes this digest.
 */
export function computeAttendanceW7PlanDigestV1(
  plan: AttendanceW7ContextSourceTransitionPlanV1,
): string {
  const canonical = {
    orgId: plan.orgId,
    orgAllowlisted: plan.orgAllowlisted,
    rowExists: plan.rowExists,
    currentState: plan.currentState,
    currentVersion: plan.currentVersion,
    priorState: plan.priorState,
    targetState: plan.targetState,
    legalPair: plan.legalPair,
    ladderRole: plan.ladderRole,
    canBootstrap: plan.canBootstrap,
    blocked: plan.blocked,
    predicates: plan.predicates.map((predicate) => ({
      code: predicate.code,
      applicable: predicate.applicable,
      // `evaluated` is part of the digest deliberately: a plan in which a
      // criterion went from "not evaluated" to a real verdict (or back) is a
      // DIFFERENT plan, and `apply` must refuse a digest computed before that
      // changed. Omitting it would let the two collapse to the same hash.
      evaluated: predicate.evaluated,
      pass: predicate.pass,
      count: predicate.count,
    })),
  }
  return sha256HexV1(canonicalJsonV1(canonical))
}

// ---------------------------------------------------------------------------
// CLI argument parsing. Every value is required explicitly — no default target,
// no wildcard org, no implicit confirmation.
// ---------------------------------------------------------------------------
function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) failTool('W7_TOOL_ARGS_INVALID')
  return value
}

function requireOrgFlag(argv: readonly string[]): string {
  const value = readFlag(argv, 'org')
  if (!value || !UUID_PATTERN.test(value)) failTool('W7_TOOL_ARGS_INVALID')
  return value
}

function requireStateFlag(
  argv: readonly string[],
  name: string,
): AttendanceW7ContextSourcePostureStateV1 {
  const value = readFlag(argv, name)
  if (
    !value ||
    !(ATTENDANCE_W7_CONTEXT_SOURCE_STATES_LOCAL_V1 as readonly string[]).includes(value)
  ) {
    failTool('W7_TOOL_ARGS_INVALID')
  }
  return value as AttendanceW7ContextSourcePostureStateV1
}

function requireTextFlag(argv: readonly string[], name: string): string {
  const value = readFlag(argv, name)
  if (!value || value.length > 256) failTool('W7_TOOL_ARGS_INVALID')
  return value
}

export type AttendanceW7PlanArgsV1 = Readonly<{
  orgId: string
  targetState: AttendanceW7ContextSourcePostureStateV1
}>

export function parseAttendanceW7PlanArgsV1(argv: readonly string[]): AttendanceW7PlanArgsV1 {
  return Object.freeze({
    orgId: requireOrgFlag(argv),
    targetState: requireStateFlag(argv, 'target'),
  })
}

/**
 * EXACTLY TEN FIELDS. There is no `--force`, no `--ready`, no
 * `--skip-predicate`, no `--override` anywhere in this module — that ABSENCE is
 * the "no caller-supplied `ready=true`" discipline, and it is an enumerable
 * property the unit tests assert directly rather than a convention.
 */
export type AttendanceW7ApplyArgsV1 = Readonly<{
  orgId: string
  targetState: AttendanceW7ContextSourcePostureStateV1
  expectedState: AttendanceW7ContextSourcePostureStateV1
  expectedVersion: number
  planDigest: string
  confirm: string
  manifestPath: string
  actorId: string
  correlationId: string
  engineVersion: string
}>

export const ATTENDANCE_W7_APPLY_ARG_FIELDS_V1: readonly string[] = Object.freeze([
  'orgId',
  'targetState',
  'expectedState',
  'expectedVersion',
  'planDigest',
  'confirm',
  'manifestPath',
  'actorId',
  'correlationId',
  'engineVersion',
])

export function parseAttendanceW7ApplyArgsV1(argv: readonly string[]): AttendanceW7ApplyArgsV1 {
  const expectedVersionRaw = readFlag(argv, 'expected-version')
  if (!expectedVersionRaw || !/^[0-9]+$/.test(expectedVersionRaw)) failTool('W7_TOOL_ARGS_INVALID')
  const expectedVersion = Number(expectedVersionRaw)
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) failTool('W7_TOOL_ARGS_INVALID')

  const confirm = readFlag(argv, 'confirm')
  // EXACT string match, never a boolean or a prefix.
  if (confirm !== ATTENDANCE_W7_CONFIRMATION_TOKEN_V1) failTool('W7_TOOL_CONFIRMATION_REQUIRED')

  const correlationId = readFlag(argv, 'correlation-id')
  if (!correlationId || !UUID_PATTERN.test(correlationId)) failTool('W7_TOOL_ARGS_INVALID')

  return Object.freeze({
    orgId: requireOrgFlag(argv),
    targetState: requireStateFlag(argv, 'target'),
    expectedState: requireStateFlag(argv, 'expected-state'),
    expectedVersion,
    planDigest: requireHex64(readFlag(argv, 'plan-digest'), 'W7_TOOL_ARGS_INVALID'),
    confirm,
    manifestPath: requireTextFlag(argv, 'manifest'),
    actorId: requireTextFlag(argv, 'actor-id'),
    correlationId,
    engineVersion: requireTextFlag(argv, 'engine-version'),
  })
}

// ---------------------------------------------------------------------------
// Apply orchestration, against INJECTED dependencies.
// ---------------------------------------------------------------------------
export type AttendanceW7ApplyOutcomeV1 = Readonly<{
  outcome: 'transitioned' | 'noop_already_at_target'
  orgId: string
  state: AttendanceW7ContextSourcePostureStateV1
  planDigest: string
}>

export type AttendanceW7ApplyDepsV1 = Readonly<{
  plan: (
    input: Readonly<{ orgId: string; targetState: AttendanceW7ContextSourcePostureStateV1 }>,
  ) => Promise<AttendanceW7ContextSourceTransitionPlanV1>
  transition: (input: {
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
  }) => Promise<AttendanceW7ContextSourceTransitionResultV1>
}>

export async function runAttendanceW7ApplyOrchestrationV1(
  deps: AttendanceW7ApplyDepsV1,
  args: AttendanceW7ApplyArgsV1,
  validated: AttendanceW7ValidatedManifestV1,
): Promise<AttendanceW7ApplyOutcomeV1> {
  const freshPlan = await deps.plan({ orgId: args.orgId, targetState: args.targetState })

  // Step 1: IDEMPOTENCY, checked BEFORE any digest comparison — a re-run of an
  // already-applied apply must be a no-op, not a digest mismatch.
  //
  // The `priorState` conjunct is load-bearing and is the W4C-5 P2-1 finding
  // carried over: current-state/version alone UNDER-CONSTRAIN the no-op path,
  // because an illegal pair or a weaker manifest key set can both slip through a
  // check that never looks at what the row transitioned FROM.
  if (
    freshPlan.rowExists &&
    freshPlan.currentState === args.targetState &&
    freshPlan.currentVersion === args.expectedVersion + 1 &&
    freshPlan.priorState === args.expectedState
  ) {
    return Object.freeze({
      outcome: 'noop_already_at_target' as const,
      orgId: args.orgId,
      state: freshPlan.currentState,
      planDigest: computeAttendanceW7PlanDigestV1(freshPlan),
    })
  }

  // Step 2: digest match against the caller-supplied plan. This exists ONLY to
  // catch drift a stale digest encodes.
  //
  // There is deliberately NO separate local "blocked"/"illegal pair"
  // short-circuit: every one of those refusal classes is left to surface as the
  // BOUNDARY's own specific code in step 3. Adding a second, locally-classified
  // refusal for conditions the boundary already names precisely would be exactly
  // the second, narrower classification the one-writer discipline forbids.
  const freshDigest = computeAttendanceW7PlanDigestV1(freshPlan)
  if (freshDigest !== args.planDigest) failTool('W7_TOOL_PLAN_DIGEST_MISMATCH')

  // Step 3: the ONLY write, and the only place any predicate is enforced.
  // Whatever the boundary throws propagates UNCHANGED — never retried, never
  // masked, never re-classified locally.
  const result = await deps.transition({
    orgId: args.orgId,
    actorId: args.actorId,
    correlationId: args.correlationId,
    engineVersion: args.engineVersion,
    targetState: args.targetState,
    expectedState: args.expectedState,
    expectedVersion: args.expectedVersion,
    evidenceManifestSha256: validated.evidenceManifestSha256,
    evidenceReferences: validated.evidenceReferences,
    reasonCode: 'context_source_transition',
  })

  return Object.freeze({
    outcome: 'transitioned' as const,
    orgId: result.orgId,
    state: result.state,
    planDigest: freshDigest,
  })
}

// ---------------------------------------------------------------------------
// Closed exit ladder. A code this module does not know maps to the generic
// failure exit, never to success.
// ---------------------------------------------------------------------------
export const ATTENDANCE_W7_EXIT_SUCCESS_V1 = 0
export const ATTENDANCE_W7_EXIT_ARGS_INVALID_V1 = 2
export const ATTENDANCE_W7_EXIT_MANIFEST_INVALID_V1 = 3
export const ATTENDANCE_W7_EXIT_PLAN_STALE_V1 = 4
export const ATTENDANCE_W7_EXIT_BLOCKED_V1 = 5
export const ATTENDANCE_W7_EXIT_FAILED_V1 = 1

const TOOL_EXIT_CODES: Readonly<Record<string, number>> = Object.freeze({
  W7_TOOL_ARGS_INVALID: ATTENDANCE_W7_EXIT_ARGS_INVALID_V1,
  W7_TOOL_CONFIRMATION_REQUIRED: ATTENDANCE_W7_EXIT_ARGS_INVALID_V1,
  W7_TOOL_MANIFEST_INVALID: ATTENDANCE_W7_EXIT_MANIFEST_INVALID_V1,
  W7_TOOL_MANIFEST_STALE: ATTENDANCE_W7_EXIT_MANIFEST_INVALID_V1,
  W7_TOOL_MANIFEST_ORG_MISMATCH: ATTENDANCE_W7_EXIT_MANIFEST_INVALID_V1,
  W7_TOOL_MANIFEST_TARGET_MISMATCH: ATTENDANCE_W7_EXIT_MANIFEST_INVALID_V1,
  W7_TOOL_PLAN_DIGEST_MISMATCH: ATTENDANCE_W7_EXIT_PLAN_STALE_V1,
})

export function exitCodeForAttendanceW7ErrorV1(error: unknown): number {
  const code = (error as { code?: unknown })?.code
  if (typeof code !== 'string') return ATTENDANCE_W7_EXIT_FAILED_V1
  if (Object.prototype.hasOwnProperty.call(TOOL_EXIT_CODES, code)) return TOOL_EXIT_CODES[code]
  // A boundary refusal — its code is passed through VERBATIM in the message and
  // mapped to the single "blocked" exit. This module never re-classifies a
  // refusal the boundary already named.
  if (code.startsWith('W7_CONTEXT_SOURCE_TRANSITION_')) return ATTENDANCE_W7_EXIT_BLOCKED_V1
  return ATTENDANCE_W7_EXIT_FAILED_V1
}

export function describeAttendanceW7ErrorV1(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string') return code
  return error instanceof Error ? error.message : String(error)
}
