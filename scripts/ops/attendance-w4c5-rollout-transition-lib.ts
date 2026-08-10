/**
 * W4C-5 operator transition tooling — pure, DB-free module.
 *
 * docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md
 * (OD-W4C-61=(a), ratified at 2a2a5eee4f00abceff94ed6360e8c051708e35f7, owner comment
 * 5189421034 on PR 4747).
 *
 * Everything here is pure (no DB, no filesystem, no network, no clock read except through an
 * injected `nowMs` parameter) so it is unit-testable without a real PostgreSQL connection. The
 * one thing this module deliberately does NOT do is decide transition legality, evaluate a
 * database-backed precondition, or perform rollout DML — those stay exclusively in
 * `packages/core-backend/src/attendance/w4c3a-rollout-control.ts` (amendment section 2: "two
 * competing transition implementations are forbidden"). This module only: parses CLI arguments,
 * canonicalizes/hashes the evidence manifest and the plan digest, validates manifest SHAPE
 * (never re-validates a database precondition), and orchestrates the plan-then-apply sequencing
 * (idempotency-first, then digest match, then the boundary call itself) against an INJECTED
 * `plan`/`transition` pair of async functions — so the sequencing logic itself is unit-testable
 * with fakes, and the real CLI wires the real core-backend functions.
 */
import { createHash } from 'node:crypto'

// TYPE-ONLY imports of the core-backend types (erased at compile time — zero runtime import of
// any kind is emitted for these). This module deliberately takes NO runtime (value-level)
// dependency on core-backend: `packages/core-backend/package.json` declares no `"type"` field
// (defaults to CommonJS), while every file under `scripts/ops/` resolves under this repo's root
// `"type": "module"` — a bare `import { X } from '<core-backend file>'` crossing that boundary
// hits Node's CJS/ESM interop (named exports collapse onto a single `.default`), which is why
// every core-backend VALUE import in this codebase's CLIs goes through a dynamic
// `await import(...)` + `'knownExport' in ns ? ns : ns.default` unwrap (see
// `attendance-legacy-membership-overlap-audit.ts`) instead of a static import. Keeping this
// module type-only avoids that dance entirely and keeps it truly dependency-free for unit tests.
import type {
  AttendanceAcceptedWritePostureV1,
  AttendanceRolloutStateV1,
} from '../../packages/core-backend/src/attendance/w4c0-identity'
import type {
  AttendanceRolloutTransitionPlanV1,
  AttendanceW4C3aRolloutControlResultV1,
  EvidenceReferencesV1,
} from '../../packages/core-backend/src/attendance/w4c3a-rollout-control'

/**
 * Local mirror of `ATTENDANCE_ROLLOUT_STATES_V1` (`w4c0-identity.ts`) — duplicated, not
 * imported, for the reason in the import-block comment above. Kept honest against drift by an
 * exhaustiveness type-check immediately below: TypeScript itself fails to compile this file if
 * this literal and the canonical `AttendanceRolloutStateV1` union type (still imported, type-only)
 * ever diverge in either direction — this is not a trust-me comment, it is a compiler-enforced
 * two-way constraint.
 */
const ATTENDANCE_ROLLOUT_STATES_LOCAL_V1 = Object.freeze([
  'legacy',
  'shadow',
  'eligible',
  'authoritative',
  'suspended',
] as const)
type LocalRolloutState = (typeof ATTENDANCE_ROLLOUT_STATES_LOCAL_V1)[number]
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertRolloutStatesMatchBothWays = [LocalRolloutState] extends [AttendanceRolloutStateV1]
  ? [AttendanceRolloutStateV1] extends [LocalRolloutState]
    ? true
    : never
  : never
const _assertRolloutStatesMatchBothWays: _AssertRolloutStatesMatchBothWays = true
void _assertRolloutStatesMatchBothWays

export class AttendanceW4C5ToolError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4C5ToolError'
    this.code = code
  }
}

function failTool(code: string): never {
  throw new AttendanceW4C5ToolError(code)
}

// ---------------------------------------------------------------------------
// Confirmation token. No implicit `--yes`, no default: apply refuses unless
// this EXACT literal string is supplied.
// ---------------------------------------------------------------------------
export const ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1 = 'I_UNDERSTAND_THIS_TRANSITIONS_A_SYNTHETIC_ORG_ONLY'

// ---------------------------------------------------------------------------
// Canonical JSON + SHA-256 — shared by the manifest hash and the plan digest so both use one
// serialization discipline: recursively sorted object keys, no whitespace, array order preserved
// verbatim (arrays are ordered data, never resorted).
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

// ---------------------------------------------------------------------------
// Pair classifiers. These are DELIBERATELY re-derived here from the closed 7-pair matrix, the
// same "independent verification, not a second write path" discipline the real-DB rollout
// control test suite already uses for its own `LEGAL_PAIRS` constant ("hardcoded independently
// of the production LEGAL_TRANSITIONS constant so a bug in that constant cannot hide from this
// test"). This module never decides whether a pair is LEGAL — only the boundary's own
// `findLegalTransition` does that, surfaced through `AttendanceRolloutTransitionPlanV1.legalPair`
// — it only decides which manifest FIELDS a given pair requires, which is a tooling-shape
// question, not a transition-legality one.
// ---------------------------------------------------------------------------
export function isResumePairV1(from: AttendanceRolloutStateV1, to: AttendanceRolloutStateV1): boolean {
  return from === 'suspended' && to === 'authoritative'
}

export function isAuthorityPromotionPairV1(from: AttendanceRolloutStateV1, to: AttendanceRolloutStateV1): boolean {
  return from === 'eligible' && to === 'authoritative'
}

// ---------------------------------------------------------------------------
// Evidence manifest (amendment section 4). Collected by the operator immediately before
// transition; this module validates its SHAPE only (presence, type, pattern, freshness,
// cross-match against the claimed org/target) — it never independently re-verifies a fact this
// manifest asserts against the real world (that a deployed image SHA is actually running, that
// migrations are actually zero-pending, etc.). Those verifications are the operator's own,
// outside this tool's reach; this tool only refuses a manifest that is absent, malformed, stale,
// or names a different org/target than the CLI invocation claims — exactly section 4's own words.
// ---------------------------------------------------------------------------
const REF_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const WORK_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const ATTENDANCE_W4C5_MANIFEST_BASE_KEYS_V1 = Object.freeze([
  'schemaVersion',
  'collectedAt',
  'orgId',
  'targetState',
  'imageSha',
  'pendingMigrations',
  'serviceHealthy',
  'ownerAuthorizationRef',
  'syntheticOrgRef',
  'customerData',
  'externalNotificationsDisabled',
  'externalDestinationCount',
  'entrypointInventoryRef',
] as const)

export const ATTENDANCE_W4C5_MANIFEST_AUTHORITY_KEYS_V1 = Object.freeze([
  'sevenDistinctCalendarDaysObserved',
  'criticalDiffCount',
  'unresolvedReviewCount',
] as const)

export const ATTENDANCE_W4C5_MANIFEST_RESUME_KEYS_V1 = Object.freeze([
  'ownerIncidentReviewRef',
  'offlineReplayArtifactRef',
  'offlineReplayCriticalDiffCount',
  'offlineReplayUnresolvedDiffCount',
] as const)

/** Manifest freshness budget: "collected immediately before transition" (amendment section 4). */
export const ATTENDANCE_W4C5_MANIFEST_FRESHNESS_MS_V1 = 15 * 60 * 1000
/** Small forward clock-skew tolerance; a manifest timestamped meaningfully in the future is stale/malformed, not fresh. */
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000

export type AttendanceW4C5ManifestV1 = Readonly<{
  schemaVersion: 1
  collectedAt: string
  orgId: string
  targetState: AttendanceRolloutStateV1
  imageSha: string
  pendingMigrations: 0
  serviceHealthy: true
  ownerAuthorizationRef: string
  syntheticOrgRef: string
  customerData: false
  externalNotificationsDisabled: true
  externalDestinationCount: 0
  entrypointInventoryRef: string
  sevenDistinctCalendarDaysObserved?: readonly string[]
  criticalDiffCount?: 0
  unresolvedReviewCount?: 0
  ownerIncidentReviewRef?: string
  offlineReplayArtifactRef?: string
  offlineReplayCriticalDiffCount?: 0
  offlineReplayUnresolvedDiffCount?: 0
}>

export type AttendanceW4C5ValidatedManifestV1 = Readonly<{
  manifest: AttendanceW4C5ManifestV1
  evidenceManifestSha256: string
  evidenceReferences: EvidenceReferencesV1
}>

function requireExactObjectKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) failTool('W4C5_TOOL_MANIFEST_INVALID')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) failTool('W4C5_TOOL_MANIFEST_INVALID')
  if (Object.getOwnPropertySymbols(value).length > 0) failTool('W4C5_TOOL_MANIFEST_INVALID')
  const own = Object.getOwnPropertyNames(value)
  if (own.length !== keys.length) failTool('W4C5_TOOL_MANIFEST_INVALID')
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) failTool('W4C5_TOOL_MANIFEST_INVALID')
  }
  return value as Record<string, unknown>
}

function requireRefString(value: unknown): string {
  if (typeof value !== 'string' || !REF_VALUE_PATTERN.test(value)) failTool('W4C5_TOOL_MANIFEST_INVALID')
  return value
}

function requireLiteralZero(value: unknown): 0 {
  if (value !== 0) failTool('W4C5_TOOL_MANIFEST_INVALID')
  return 0
}

function requireLiteralTrue(value: unknown): true {
  if (value !== true) failTool('W4C5_TOOL_MANIFEST_INVALID')
  return true
}

function requireLiteralFalse(value: unknown): false {
  if (value !== false) failTool('W4C5_TOOL_MANIFEST_INVALID')
  return false
}

/**
 * Validates manifest SHAPE and cross-matches it against the CLI-claimed org/target/expected
 * pair, then derives the boundary's small opaque `evidenceReferences` object and the manifest
 * hash FROM the validated manifest — the operator never enters those reference strings twice.
 * `nowMs` is injected (never `Date.now()` read internally) so freshness is testable without
 * real-clock flakiness.
 */
export function validateAttendanceW4C5ManifestV1(
  raw: unknown,
  context: Readonly<{
    orgId: string
    expectedState: AttendanceRolloutStateV1
    targetState: AttendanceRolloutStateV1
  }>,
  nowMs: number,
): AttendanceW4C5ValidatedManifestV1 {
  const resume = isResumePairV1(context.expectedState, context.targetState)
  const authorityPromotion = isAuthorityPromotionPairV1(context.expectedState, context.targetState)
  const keys = [
    ...ATTENDANCE_W4C5_MANIFEST_BASE_KEYS_V1,
    ...(authorityPromotion ? ATTENDANCE_W4C5_MANIFEST_AUTHORITY_KEYS_V1 : []),
    ...(resume ? ATTENDANCE_W4C5_MANIFEST_RESUME_KEYS_V1 : []),
  ]
  const input = requireExactObjectKeys(raw, keys)

  if (input.schemaVersion !== 1) failTool('W4C5_TOOL_MANIFEST_INVALID')
  if (typeof input.collectedAt !== 'string') failTool('W4C5_TOOL_MANIFEST_INVALID')
  const collectedAtMs = Date.parse(input.collectedAt)
  if (!Number.isFinite(collectedAtMs)) failTool('W4C5_TOOL_MANIFEST_INVALID')
  if (collectedAtMs > nowMs + CLOCK_SKEW_TOLERANCE_MS) failTool('W4C5_TOOL_MANIFEST_STALE')
  if (nowMs - collectedAtMs > ATTENDANCE_W4C5_MANIFEST_FRESHNESS_MS_V1) failTool('W4C5_TOOL_MANIFEST_STALE')

  if (typeof input.orgId !== 'string' || !UUID_PATTERN.test(input.orgId)) failTool('W4C5_TOOL_MANIFEST_INVALID')
  if (input.orgId !== context.orgId) failTool('W4C5_TOOL_MANIFEST_ORG_MISMATCH')

  if (typeof input.targetState !== 'string' || !ATTENDANCE_ROLLOUT_STATES_LOCAL_V1.includes(input.targetState as AttendanceRolloutStateV1)) {
    failTool('W4C5_TOOL_MANIFEST_INVALID')
  }
  if (input.targetState !== context.targetState) failTool('W4C5_TOOL_MANIFEST_TARGET_MISMATCH')

  const imageSha = requireRefString(input.imageSha)
  requireLiteralZero(input.pendingMigrations)
  requireLiteralTrue(input.serviceHealthy)
  const ownerAuthorizationRef = requireRefString(input.ownerAuthorizationRef)
  const syntheticOrgRef = requireRefString(input.syntheticOrgRef)
  requireLiteralFalse(input.customerData)
  requireLiteralTrue(input.externalNotificationsDisabled)
  requireLiteralZero(input.externalDestinationCount)
  requireRefString(input.entrypointInventoryRef)

  if (authorityPromotion) {
    const days = input.sevenDistinctCalendarDaysObserved
    if (!Array.isArray(days) || days.length !== 7) failTool('W4C5_TOOL_MANIFEST_INVALID')
    const seen = new Set<string>()
    for (const day of days) {
      if (typeof day !== 'string' || !WORK_DATE_PATTERN.test(day) || !Number.isFinite(Date.parse(day))) {
        failTool('W4C5_TOOL_MANIFEST_INVALID')
      }
      seen.add(day)
    }
    if (seen.size !== 7) failTool('W4C5_TOOL_MANIFEST_INVALID')
    requireLiteralZero(input.criticalDiffCount)
    requireLiteralZero(input.unresolvedReviewCount)
  }

  let ownerIncidentReviewRef: string | undefined
  let offlineReplayArtifactRef: string | undefined
  if (resume) {
    ownerIncidentReviewRef = requireRefString(input.ownerIncidentReviewRef)
    offlineReplayArtifactRef = requireRefString(input.offlineReplayArtifactRef)
    requireLiteralZero(input.offlineReplayCriticalDiffCount)
    requireLiteralZero(input.offlineReplayUnresolvedDiffCount)
  }

  const manifest = Object.freeze({ ...input }) as AttendanceW4C5ManifestV1
  const evidenceManifestSha256 = sha256HexV1(canonicalJsonV1(manifest))
  const evidenceReferences = Object.freeze({
    imageSha,
    ownerAuthorizationRef,
    syntheticOrgRef,
    ...(resume
      ? { ownerIncidentReviewRef: ownerIncidentReviewRef as string, offlineReplayArtifactRef: offlineReplayArtifactRef as string }
      : {}),
  }) as EvidenceReferencesV1

  return Object.freeze({ manifest, evidenceManifestSha256, evidenceReferences })
}

// ---------------------------------------------------------------------------
// Plan digest. Canonical JSON over the exact fields that determine whether a previously-computed
// plan is still the SAME plan — org, target, the observed current state/version, and every
// predicate verdict — with NO wall-clock field, so re-running plan twice in immediate succession
// against an unchanged database yields the identical digest (no artificial jitter that would make
// apply spuriously refuse a plan digest that is, in fact, still current).
// ---------------------------------------------------------------------------
export function computeAttendanceW4C5PlanDigestV1(plan: AttendanceRolloutTransitionPlanV1): string {
  const canonical = {
    orgId: plan.orgId,
    orgAllowlisted: plan.orgAllowlisted,
    rowExists: plan.rowExists,
    currentState: plan.currentState,
    currentVersion: plan.currentVersion,
    // W4C-5 P2-1 (PR #4839 gate, 20260809): included so this digest genuinely covers "every
    // observable field of the plan" (see the comment on the digest-match step below) now that
    // `priorState` is one. Without it, a plan whose ONLY change since a prior computation is its
    // `priorState` (impossible in practice today, since any state transition also changes
    // `currentVersion`, but not something this digest should rely on staying impossible) would
    // silently produce the same digest.
    priorState: plan.priorState,
    targetState: plan.targetState,
    legalPair: plan.legalPair,
    comparisonWritePosture: plan.comparisonWritePosture,
    canBootstrap: plan.canBootstrap,
    blocked: plan.blocked,
    predicates: plan.predicates.map((predicate) => ({
      code: predicate.code,
      applicable: predicate.applicable,
      pass: predicate.pass,
      count: predicate.count,
    })),
  }
  return sha256HexV1(canonicalJsonV1(canonical))
}

// ---------------------------------------------------------------------------
// CLI argument parsing. Every value is required explicitly — no default target, no wildcard org,
// no implicit confirmation.
// ---------------------------------------------------------------------------
function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) failTool('W4C5_TOOL_ARGS_INVALID')
  return value
}

function requireOrgId(argv: readonly string[]): string {
  const value = readFlag(argv, 'org')
  if (!value || !UUID_PATTERN.test(value)) failTool('W4C5_TOOL_ARGS_INVALID')
  return value
}

function requireTargetState(argv: readonly string[]): AttendanceRolloutStateV1 {
  const value = readFlag(argv, 'target')
  if (!value || !ATTENDANCE_ROLLOUT_STATES_LOCAL_V1.includes(value as AttendanceRolloutStateV1)) {
    failTool('W4C5_TOOL_ARGS_INVALID')
  }
  return value as AttendanceRolloutStateV1
}

export type AttendanceW4C5PlanArgsV1 = Readonly<{ orgId: string; targetState: AttendanceRolloutStateV1 }>

export function parseAttendanceW4C5PlanArgsV1(argv: readonly string[]): AttendanceW4C5PlanArgsV1 {
  return Object.freeze({ orgId: requireOrgId(argv), targetState: requireTargetState(argv) })
}

export type AttendanceW4C5ApplyArgsV1 = Readonly<{
  orgId: string
  targetState: AttendanceRolloutStateV1
  expectedState: AttendanceRolloutStateV1
  expectedVersion: number
  planDigest: string
  confirm: string
  manifestPath: string
  actorId: string
  correlationId: string
  engineVersion: string
}>

const HEX64_PATTERN = /^[0-9a-f]{64}$/

export function parseAttendanceW4C5ApplyArgsV1(argv: readonly string[]): AttendanceW4C5ApplyArgsV1 {
  const orgId = requireOrgId(argv)
  const targetState = requireTargetState(argv)

  const expectedStateRaw = readFlag(argv, 'expected-state')
  if (!expectedStateRaw || !ATTENDANCE_ROLLOUT_STATES_LOCAL_V1.includes(expectedStateRaw as AttendanceRolloutStateV1)) {
    failTool('W4C5_TOOL_ARGS_INVALID')
  }
  const expectedState = expectedStateRaw as AttendanceRolloutStateV1

  const expectedVersionRaw = readFlag(argv, 'expected-version')
  if (!expectedVersionRaw || !/^[1-9][0-9]{0,9}$/.test(expectedVersionRaw)) failTool('W4C5_TOOL_ARGS_INVALID')
  const expectedVersion = Number(expectedVersionRaw)
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) failTool('W4C5_TOOL_ARGS_INVALID')

  const planDigest = readFlag(argv, 'plan-digest')
  if (!planDigest || !HEX64_PATTERN.test(planDigest)) failTool('W4C5_TOOL_ARGS_INVALID')

  const confirm = readFlag(argv, 'confirm')
  if (confirm !== ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1) failTool('W4C5_TOOL_CONFIRMATION_REQUIRED')

  const manifestPath = readFlag(argv, 'manifest')
  if (!manifestPath) failTool('W4C5_TOOL_ARGS_INVALID')

  const actorId = readFlag(argv, 'actor-id')
  if (!actorId || actorId.length === 0 || actorId.length > 256) failTool('W4C5_TOOL_ARGS_INVALID')

  const correlationId = readFlag(argv, 'correlation-id')
  if (!correlationId || !UUID_PATTERN.test(correlationId)) failTool('W4C5_TOOL_ARGS_INVALID')

  const engineVersion = readFlag(argv, 'engine-version')
  if (!engineVersion || engineVersion.length === 0 || engineVersion.length > 256) failTool('W4C5_TOOL_ARGS_INVALID')

  return Object.freeze({
    orgId,
    targetState,
    expectedState,
    expectedVersion,
    planDigest,
    confirm,
    manifestPath,
    actorId,
    correlationId,
    engineVersion,
  })
}

// ---------------------------------------------------------------------------
// Apply orchestration — pure, DB-agnostic. `deps.plan`/`deps.transition` are injected so this
// sequencing (the actual hard part: idempotency BEFORE digest comparison) is unit-testable with
// fakes, and so it never re-implements a SINGLE refusal condition the boundary already owns.
//
// Ordering, deliberately in this order:
//   1. Re-run plan fresh (in THIS invocation — a stale plan from an earlier process can never be
//      applied, because its digest can only ever be compared against a digest computed just now).
//   2. IDEMPOTENCY FIRST: if the org is ALREADY at exactly targetState with version exactly
//      expectedVersion + 1 AND its recorded priorState equals the caller's asserted
//      expectedState (i.e. THIS precise transition already completed, most likely by an earlier
//      identical apply invocation), return a no-op success WITHOUT ever comparing plan digests.
//      Getting this order backwards is the sharpest trap here: on a second identical apply, the
//      fresh replan observes the NEW state/version, so its digest necessarily differs from the
//      digest supplied on the command line — a digest-check-first ordering would reject every
//      idempotent re-apply as `PLAN_DIGEST_MISMATCH`, making "re-apply is a no-op" untestable.
//      Divergence to any OTHER state is never treated as a no-op — only this exact
//      (targetState, expectedVersion + 1, priorState) tuple short-circuits.
//      W4C-5 P2-1 (PR #4839 gate, 20260809): the `priorState` conjunct closes a false-completion
//      hole the (targetState, expectedVersion + 1) pair alone left open — that pair says nothing
//      about which state the row transitioned FROM, so an operator whose `--expected-state`
//      names a pair that was never legal (e.g. `authoritative -> shadow`, not one of the seven
//      ratified pairs) or that selects a WEAKER §4 manifest key set than the transition that
//      actually happened (e.g. claiming `--expected-state shadow` for a promotion that only a
//      `--expected-state eligible` authority-promotion manifest actually evidenced) previously
//      still got `exit 0 noop_already_at_target` — routing around both the digest check below
//      AND the boundary's own `normalizeTransitionInput` pair-legality guard entirely, without
//      ever calling it. Requiring `freshPlan.priorState === args.expectedState` here means the
//      no-op can only ever fire for the EXACT transition the caller claims to be re-observing;
//      any other claimed prior state falls through to the digest check (step 3), and from there —
//      once a caller supplies a freshly matching digest for the WRONG claimed pair — to the
//      boundary's own `ILLEGAL_TRANSITION`/`STALE_EXPECTED_STATE` refusal, never a silent no-op.
//   3. Digest match: the supplied `--plan-digest` must equal the freshly recomputed digest. There
//      is deliberately no separate local "blocked"/"illegal pair"/"not allowlisted" check here —
//      see the comment directly above the digest comparison below for why folding those into a
//      second, tool-owned classification would itself be the forbidden second implementation.
//   4. Call the boundary's own `transitionAttendanceCalculationRolloutV1` — the sole DML path,
//      and the sole place org-allowlist, row-resolvability, pair-legality, and every section 3
//      precondition are actually enforced, each with the boundary's own specific code.
// ---------------------------------------------------------------------------

export type AttendanceW4C5ApplyOutcomeV1 = Readonly<{
  outcome: 'transitioned' | 'noop_already_at_target'
  orgId: string
  state: AttendanceRolloutStateV1
  planDigest: string
}>

export type AttendanceW4C5ApplyDepsV1 = Readonly<{
  plan: (input: Readonly<{ orgId: string; targetState: AttendanceRolloutStateV1 }>) => Promise<AttendanceRolloutTransitionPlanV1>
  transition: (input: {
    orgId: string
    actorId: string
    correlationId: string
    engineVersion: string
    targetState: AttendanceRolloutStateV1
    expectedState: AttendanceRolloutStateV1
    expectedVersion: number
    evidenceManifestSha256: string
    evidenceReferences: EvidenceReferencesV1
    reasonCode: 'rollout_transition'
  }) => Promise<AttendanceW4C3aRolloutControlResultV1>
}>

export async function runAttendanceW4C5ApplyOrchestrationV1(
  deps: AttendanceW4C5ApplyDepsV1,
  args: AttendanceW4C5ApplyArgsV1,
  validated: AttendanceW4C5ValidatedManifestV1,
): Promise<AttendanceW4C5ApplyOutcomeV1> {
  const freshPlan = await deps.plan({ orgId: args.orgId, targetState: args.targetState })

  // Step 2: idempotency, checked BEFORE any digest comparison.
  if (
    freshPlan.rowExists &&
    freshPlan.currentState === args.targetState &&
    freshPlan.currentVersion === args.expectedVersion + 1 &&
    freshPlan.priorState === args.expectedState
  ) {
    const freshDigest = computeAttendanceW4C5PlanDigestV1(freshPlan)
    return Object.freeze({
      outcome: 'noop_already_at_target' as const,
      orgId: args.orgId,
      state: freshPlan.currentState,
      planDigest: freshDigest,
    })
  }

  // Step 3: digest match against the caller-supplied plan. The digest is computed over EVERY
  // observable field of `AttendanceRolloutTransitionPlanV1` — EXHAUSTIVELY, not by example:
  // `orgId`, `orgAllowlisted`, `rowExists`, `currentState`, `currentVersion`, `priorState`,
  // `targetState`, `legalPair`, `comparisonWritePosture`, `canBootstrap`, `blocked`, and every
  // predicate's `code`/`applicable`/`pass`/`count` — so ANY change plan can observe (state
  // drifted, a new precondition started failing, the org fell out of the allowlist) already
  // changes this digest. W4C-5 P2-1-DIGEST-COVERAGE (PR #4839 gate, 20260809; NIT-3, PR #4839 P3
  // gate, 20260810: renamed from the bare tag "P2-1", which the operator runbook already uses
  // for the UNRELATED `priorState`/idempotency-short-circuit finding above and at this module's
  // `runAttendanceW4C5ApplyOrchestrationV1` — see that finding's own comments): this claim used
  // to be asserted but untested — a per-field deletion sweep found only 2 of the 16 fields (the
  // type's 12 top-level fields plus the 4 predicate sub-fields `code`/`applicable`/`pass`/`count`
  // — `currentVersion`, `priorState`) actually reddened any test on removal; the other 14,
  // INCLUDING `orgId`, `targetState`, and every predicate sub-field, did not, because nothing
  // exercised them. The fields THEMSELVES were always all present in
  // `computeAttendanceW4C5PlanDigestV1`'s `canonical` object (verified field-by-field against
  // this type below) — the gap was test coverage, not a missing field — closed by the
  // table-driven fixture-mutation test in `attendance-w4c5-rollout-transition-lib.test.ts` (covers
  // all 16 fields — 12 top-level plus 4 predicate sub-fields — of a hand-typed fixture, current
  // as of this writing) and, because that fixture is not compiler-enforced against future type
  // changes (`scripts/ops` is outside every pnpm workspace and no CI step runs `tsc` over it —
  // verified, not assumed), by the companion real-plan-object test in
  // `attendance-w4c5-rollout-transition-tool.db.test.ts`. F4 (PR #4839 P3 gate, 20260810): that
  // companion test used to derive its field list from `Object.keys()` of ONE runtime plan
  // instance — what that object HAS, not what the type DECLARES — so a conditionally-emitted
  // OPTIONAL field absent from that one instance would have escaped it silently, which made the
  // "fails loudly, never silently" claim previously written here false as stated. Its domain is
  // now the DECLARED type (`Record<keyof AttendanceRolloutTransitionPlanV1, ...>`, which
  // TypeScript refuses to compile incomplete), with an independent runtime check for the reverse
  // direction (a real field the table forgot). That type-level completeness is real for a
  // developer's own local `tsc`/editor — verified: adding a field to the type and leaving it out
  // of the table produces a `tsc` error at exactly that table's literal — but, like this
  // fixture's own limitation one sentence up, is NOT mechanically enforced by this repo's CI
  // today (`packages/core-backend/tsconfig.json` excludes `**/*.test.ts`, and no
  // `.github/workflows/*.yml` step type-checks `tests/integration/**` — grepped, zero hits): a
  // `vitest` run alone does not "fail loudly" on an unregistered field unless a human also
  // updates the table — the same honest limitation already disclosed for the sibling unit-test
  // fixture one sentence up.
  //
  // There is deliberately no SEPARATE local "blocked"/"illegal pair" short-circuit here: every one of those refusal classes is instead
  // left to surface as the BOUNDARY's own specific code in step 4 below (`ORG_NOT_ALLOWLISTED`,
  // `STATE_MISSING`, `ILLEGAL_TRANSITION`, `UNCLOSED_LEGACY_BATCH`, etc.) — adding a second,
  // locally-classified refusal code for the SAME conditions the boundary already names
  // precisely would be exactly the kind of second, narrower classification this line's own
  // discipline forbids (amendment section 2: no second competing implementation). This digest
  // check exists ONLY to catch drift a stale plan digest encodes — not to pre-empt the
  // boundary's own verdict on a plan that never went stale in the first place.
  const freshDigest = computeAttendanceW4C5PlanDigestV1(freshPlan)
  if (freshDigest !== args.planDigest) failTool('W4C5_TOOL_PLAN_DIGEST_MISMATCH')

  // Step 4: the ONLY write, and the ONLY place any of section 1/3's predicates are actually
  // enforced. Whatever this throws (org not allowlisted, unknown/unresolvable org, illegal
  // pair, stale expected state, an in-flight concurrent transition, or any section 3 predicate
  // that regressed in the window since freshPlan was read) propagates unchanged — the caller
  // maps it to an exit code, never retried or masked.
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
    reasonCode: 'rollout_transition',
  })

  return Object.freeze({
    outcome: 'transitioned' as const,
    orgId: result.orgId,
    state: result.state,
    planDigest: freshDigest,
  })
}

// ---------------------------------------------------------------------------
// Refusal -> exit code mapping. Tool-level codes (this module's own) and every boundary/identity
// code (`ATTENDANCE_W4C5_BOUNDARY_ERROR_NAMES_V1` below, surfaced verbatim via `error.code` on
// `.message`/`.code`) are diagnosable by their EXACT code string on stderr; the exit code buckets
// are for scripting only, never a substitute for reading the code.
// ---------------------------------------------------------------------------
export const ATTENDANCE_W4C5_EXIT_SUCCESS_V1 = 0
export const ATTENDANCE_W4C5_EXIT_ARGS_INVALID_V1 = 2
export const ATTENDANCE_W4C5_EXIT_CONFIRMATION_REQUIRED_V1 = 3
export const ATTENDANCE_W4C5_EXIT_MANIFEST_INVALID_V1 = 4
export const ATTENDANCE_W4C5_EXIT_PLAN_STALE_V1 = 5
export const ATTENDANCE_W4C5_EXIT_PLAN_BLOCKED_V1 = 6
export const ATTENDANCE_W4C5_EXIT_BOUNDARY_REFUSED_V1 = 7
export const ATTENDANCE_W4C5_EXIT_INTERNAL_ERROR_V1 = 1

// P2-A (PR #4839 gate, 20260810): REVERTED off a one-round-lived structural-marker
// discriminator (`error instanceof Error && typeof error.code === 'string' && error.message ===
// error.code`) back to this closed `.name` allowlist. The marker's own docblock claimed the
// shape was shared "BY CONSTRUCTION" by "every one of this repo's own values-free error
// classes" — measured false in BOTH directions against the actual `plan`/`apply` call graph
// traced from this file (not assumed: every function `planAttendanceCalculationRolloutTransitionV1`
// and `transitionAttendanceCalculationRolloutV1` call, transitively, was read):
//  - TOO NARROW: `AttendanceRequestSnapshotError` (w4c3b-request-snapshots.ts) IS reachable —
//    `w4c3a-rollout-control.ts`'s `classifyAttendanceRequestSnapshotDefectsV1` (called from both
//    `plan`'s `buildAttendanceRolloutTransitionPlanV1` and `apply`'s
//    `transitionAttendanceCalculationRolloutV1`, whenever the target is an
//    ELIGIBILITY_AUTHORITY_TARGETS state) calls the live-side
//    `computeAttendanceRequestPayloadFingerprintV1` UNWRAPPED (no try/catch — unlike its
//    stored-side sibling call two lines below, which deliberately swallows the same throw into
//    `null`). That class's constructor takes `(code, statusCode, message)` and calls
//    `super(message)` — a fixed human sentence, never equal to `code` — so it never matched the
//    marker and fell to the internal-error bucket anyway. It is DELIBERATELY not in this list
//    either (see the negative-control test): a live request row that cannot even be normalized
//    into a calculation payload is a data-integrity defect, not one of this boundary's own
//    documented, expected section-3 refusals — internal-error is the correct bucket, and this
//    class is kept only as a regression guard that a future change to the marker or this list
//    does not accidentally start routing it to boundary-refused.
//  - TOO WIDE: the marker fires on ANY of this repo's other `export class Attendance*Error
//    extends Error` classes that happen to follow the same `super(code); this.code = code`
//    convention — MEASURED (a small script parsing every exported `*Error` class's constructor
//    across `packages/core-backend/src/attendance/*.ts`, PR #4839 gate, 20260810), not estimated:
//    30 of the 32 such classes follow it (the same two exceptions are `AttendanceRequestSnapshotError`
//    above and `AttendanceCentralApprovalError`, both `super(message)` instead). The marker cannot
//    distinguish "this call graph's own boundary code" from "a same-shaped class elsewhere in the
//    package that happens to reach here on some future refactor" — see `AttendanceW4RegistryError`
//    (w4c0-operation-registry.ts)'s own negative-control test, one concrete example of the 30.
// This list is the three classes this trace found BOTH reachable from `plan` or `apply` AND
// assigned to the boundary-refused bucket by decision — `AttendanceRequestSnapshotError` above is
// a FOURTH class this same trace found reachable, deliberately assigned to internal-error instead
// (see its own negative-control test), not an omission. The three assigned here constitute the
// transition boundary and its identity/lock substrate:
// `AttendanceW4C3aRolloutControlError` (this boundary's own `fail()` refusals, e.g.
// `W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION`), `AttendanceW4IdentityError`
// (w4c0-identity.ts's own `fail()`, reachable via `assertConnectionIsIdleV1`'s
// `W4C0_CONNECTION_NOT_IDLE` — called directly by `plan`, and indirectly by `apply` through
// `acquireAttendanceCalculationRolloutLockSessionExclusiveV1` — plus every other identity/lock
// helper `apply` calls), and `AttendanceW4OperationError` (w4c0-operation-contract.ts;
// constructed by w4c0-identity.ts's `busyError()` for an advisory-lock-busy 503 — reachable ONLY
// from `apply`, via `acquireAttendanceCalculationRolloutLockSessionExclusiveV1`,
// `acquireAttendanceResultOperationLocks` inside `lockControlDomain`, and
// `acquireAttendanceCalculationTargetLocks` inside `lockTargetsAndParents`; `plan` never
// acquires an advisory lock, so it can never throw this one). `.name` string matching, not
// `instanceof`, because this module deliberately takes no runtime (value-level) import of
// core-backend (file-header comment, CJS/ESM interop hazard) — none of these three classes can
// be `instanceof`-checked here. This IS the fragile shape the marker round tried to fix (a new
// class in this family needs a human decision to be added here) — the companion "mechanical
// sweep" test in this file's `.test.ts` narrows the window in which that rot stays silent.
// Its domain, stated exactly rather than as "any new class", because an earlier version of this
// sentence claimed more than the regex delivered and a subclass declaration walked straight
// through it (MUT-2, PR #4839 gate, 20260810): the sweep reads the FIVE files listed in the test
// (the depth-1 imports of `w4c3a-rollout-control.ts`) and fails closed on any declaration
// spelled `export class Attendance<...>Error extends Error` or
// `export class Attendance<...>Error extends Attendance<...>Error` that is not decided there.
// It does NOT cover: a class in a depth-2 file, a class named outside the `Attendance*Error`
// convention, or one extending some other base. Those remain silent. Exported (not module-private) so that same test asserts THIS
// production list — never a hand-copied duplicate, which would drift silently exactly like the
// defect this whole exercise is closing.
export const ATTENDANCE_W4C5_BOUNDARY_ERROR_NAMES_V1 = Object.freeze([
  'AttendanceW4C3aRolloutControlError',
  'AttendanceW4IdentityError',
  'AttendanceW4OperationError',
] as const)

export function exitCodeForAttendanceW4C5ErrorV1(error: unknown): number {
  if (error instanceof AttendanceW4C5ToolError) {
    switch (error.code) {
      case 'W4C5_TOOL_ARGS_INVALID':
        return ATTENDANCE_W4C5_EXIT_ARGS_INVALID_V1
      case 'W4C5_TOOL_CONFIRMATION_REQUIRED':
        return ATTENDANCE_W4C5_EXIT_CONFIRMATION_REQUIRED_V1
      case 'W4C5_TOOL_MANIFEST_INVALID':
      case 'W4C5_TOOL_MANIFEST_ORG_MISMATCH':
      case 'W4C5_TOOL_MANIFEST_TARGET_MISMATCH':
        return ATTENDANCE_W4C5_EXIT_MANIFEST_INVALID_V1
      case 'W4C5_TOOL_MANIFEST_STALE':
      case 'W4C5_TOOL_PLAN_DIGEST_MISMATCH':
        return ATTENDANCE_W4C5_EXIT_PLAN_STALE_V1
      default:
        return ATTENDANCE_W4C5_EXIT_INTERNAL_ERROR_V1
    }
  }
  if (error instanceof Error && (ATTENDANCE_W4C5_BOUNDARY_ERROR_NAMES_V1 as readonly string[]).includes(error.name)) {
    return ATTENDANCE_W4C5_EXIT_BOUNDARY_REFUSED_V1
  }
  return ATTENDANCE_W4C5_EXIT_INTERNAL_ERROR_V1
}

/** Values-free stderr line for any refusal: the exact code, never any echoed input value. */
export function describeAttendanceW4C5ErrorV1(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return String((error as { code: string }).code)
  }
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR'
}
