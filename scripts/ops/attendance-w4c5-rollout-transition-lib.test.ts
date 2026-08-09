/**
 * Unit tests for the W4C-5 operator transition tooling's pure module. No database, no
 * filesystem, no network — every case here is a plain function call. Real-DB proof (the plan
 * reporter's zero-write property, the full legacy->shadow apply, idempotent re-apply, and every
 * refusal class end to end) lives in
 * packages/core-backend/tests/integration/attendance-w4c5-rollout-transition-tool.db.test.ts.
 *
 * Run: pnpm exec tsx --test scripts/ops/attendance-w4c5-rollout-transition-lib.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'

import {
  ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
  ATTENDANCE_W4C5_EXIT_ARGS_INVALID_V1,
  ATTENDANCE_W4C5_EXIT_BOUNDARY_REFUSED_V1,
  ATTENDANCE_W4C5_EXIT_CONFIRMATION_REQUIRED_V1,
  ATTENDANCE_W4C5_EXIT_INTERNAL_ERROR_V1,
  ATTENDANCE_W4C5_EXIT_MANIFEST_INVALID_V1,
  ATTENDANCE_W4C5_EXIT_PLAN_BLOCKED_V1,
  ATTENDANCE_W4C5_EXIT_PLAN_STALE_V1,
  ATTENDANCE_W4C5_EXIT_SUCCESS_V1,
  AttendanceW4C5ToolError,
  canonicalJsonV1,
  computeAttendanceW4C5PlanDigestV1,
  describeAttendanceW4C5ErrorV1,
  exitCodeForAttendanceW4C5ErrorV1,
  isAuthorityPromotionPairV1,
  isResumePairV1,
  parseAttendanceW4C5ApplyArgsV1,
  parseAttendanceW4C5PlanArgsV1,
  runAttendanceW4C5ApplyOrchestrationV1,
  sha256HexV1,
  validateAttendanceW4C5ManifestV1,
  type AttendanceW4C5ApplyDepsV1,
} from './attendance-w4c5-rollout-transition-lib'

const ORG = '11111111-1111-1111-1111-111111111111'
const OTHER_ORG = '22222222-2222-2222-2222-222222222222'
const CORR = '33333333-3333-3333-3333-333333333333'
const NOW = Date.parse('2026-08-09T12:00:00.000Z')

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    collectedAt: new Date(NOW).toISOString(),
    orgId: ORG,
    targetState: 'shadow',
    imageSha: 'sha-image-123',
    pendingMigrations: 0,
    serviceHealthy: true,
    ownerAuthorizationRef: 'owner-ref-1',
    syntheticOrgRef: 'synthetic-ref-1',
    customerData: false,
    externalNotificationsDisabled: true,
    externalDestinationCount: 0,
    entrypointInventoryRef: 'inventory-ref-1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// canonicalJsonV1 / sha256HexV1
// ---------------------------------------------------------------------------
test('canonicalJsonV1 sorts object keys but preserves array order', () => {
  assert.equal(canonicalJsonV1({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(canonicalJsonV1({ z: [3, 1, 2], a: 1 }), '{"a":1,"z":[3,1,2]}')
  assert.equal(canonicalJsonV1({ nested: { y: 1, x: 2 } }), '{"nested":{"x":2,"y":1}}')
})

test('canonicalJsonV1 is order-independent for object key insertion order', () => {
  assert.equal(canonicalJsonV1({ a: 1, b: 2 }), canonicalJsonV1({ b: 2, a: 1 }))
})

test('sha256HexV1 matches node:crypto directly', () => {
  const expected = createHash('sha256').update('hello', 'utf8').digest('hex')
  assert.equal(sha256HexV1('hello'), expected)
  assert.equal(sha256HexV1('hello').length, 64)
})

// ---------------------------------------------------------------------------
// Pair classifiers
// ---------------------------------------------------------------------------
test('isResumePairV1 is true only for suspended -> authoritative', () => {
  assert.equal(isResumePairV1('suspended', 'authoritative'), true)
  assert.equal(isResumePairV1('authoritative', 'suspended'), false)
  assert.equal(isResumePairV1('eligible', 'authoritative'), false)
  assert.equal(isResumePairV1('legacy', 'shadow'), false)
})

test('isAuthorityPromotionPairV1 is true only for eligible -> authoritative', () => {
  assert.equal(isAuthorityPromotionPairV1('eligible', 'authoritative'), true)
  assert.equal(isAuthorityPromotionPairV1('suspended', 'authoritative'), false)
  assert.equal(isAuthorityPromotionPairV1('shadow', 'eligible'), false)
})

// ---------------------------------------------------------------------------
// validateAttendanceW4C5ManifestV1 — base (legacy -> shadow) pair
// ---------------------------------------------------------------------------
test('validateAttendanceW4C5ManifestV1 accepts a well-formed base manifest and derives evidence', () => {
  const result = validateAttendanceW4C5ManifestV1(
    baseManifest(),
    { orgId: ORG, expectedState: 'legacy', targetState: 'shadow' },
    NOW,
  )
  assert.deepEqual(result.evidenceReferences, {
    imageSha: 'sha-image-123',
    ownerAuthorizationRef: 'owner-ref-1',
    syntheticOrgRef: 'synthetic-ref-1',
  })
  assert.equal(result.evidenceManifestSha256, sha256HexV1(canonicalJsonV1(result.manifest)))
  assert.equal(result.evidenceManifestSha256.length, 64)
})

test('validateAttendanceW4C5ManifestV1 rejects a missing required field', () => {
  const manifest = baseManifest() as Record<string, unknown>
  delete manifest.imageSha
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'legacy', targetState: 'shadow' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_INVALID',
  )
})

test('validateAttendanceW4C5ManifestV1 rejects an extra unexpected field', () => {
  const manifest = baseManifest({ unexpectedField: 'x' })
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'legacy', targetState: 'shadow' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_INVALID',
  )
})

test('validateAttendanceW4C5ManifestV1 rejects pendingMigrations !== 0', () => {
  const manifest = baseManifest({ pendingMigrations: 1 })
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'legacy', targetState: 'shadow' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_INVALID',
  )
})

test('validateAttendanceW4C5ManifestV1 rejects customerData !== false', () => {
  const manifest = baseManifest({ customerData: true })
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'legacy', targetState: 'shadow' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_INVALID',
  )
})

test('validateAttendanceW4C5ManifestV1 rejects an org mismatch with its own exclusive code', () => {
  const manifest = baseManifest()
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: OTHER_ORG, expectedState: 'legacy', targetState: 'shadow' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_ORG_MISMATCH',
  )
})

test('validateAttendanceW4C5ManifestV1 rejects a target mismatch with its own exclusive code', () => {
  const manifest = baseManifest({ targetState: 'shadow' })
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'legacy', targetState: 'eligible' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_TARGET_MISMATCH',
  )
})

test('validateAttendanceW4C5ManifestV1 rejects a stale manifest (older than the freshness window)', () => {
  const stale = new Date(NOW - 16 * 60 * 1000).toISOString()
  const manifest = baseManifest({ collectedAt: stale })
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'legacy', targetState: 'shadow' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_STALE',
  )
})

test('validateAttendanceW4C5ManifestV1 rejects a manifest timestamped in the future beyond skew tolerance', () => {
  const future = new Date(NOW + 5 * 60 * 1000).toISOString()
  const manifest = baseManifest({ collectedAt: future })
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'legacy', targetState: 'shadow' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_STALE',
  )
})

test('validateAttendanceW4C5ManifestV1 accepts a manifest just inside the freshness window', () => {
  const fresh = new Date(NOW - 14 * 60 * 1000).toISOString()
  const manifest = baseManifest({ collectedAt: fresh })
  const result = validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'legacy', targetState: 'shadow' }, NOW)
  assert.equal(result.manifest.collectedAt, fresh)
})

// ---------------------------------------------------------------------------
// validateAttendanceW4C5ManifestV1 — authority-promotion pair (eligible -> authoritative)
// ---------------------------------------------------------------------------
function authorityManifest(overrides: Record<string, unknown> = {}) {
  return baseManifest({
    targetState: 'authoritative',
    sevenDistinctCalendarDaysObserved: [
      '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07',
    ],
    criticalDiffCount: 0,
    unresolvedReviewCount: 0,
    ...overrides,
  })
}

test('validateAttendanceW4C5ManifestV1 accepts a well-formed authority-promotion manifest', () => {
  const result = validateAttendanceW4C5ManifestV1(
    authorityManifest(),
    { orgId: ORG, expectedState: 'eligible', targetState: 'authoritative' },
    NOW,
  )
  assert.equal((result.manifest as unknown as { criticalDiffCount: number }).criticalDiffCount, 0)
})

test('validateAttendanceW4C5ManifestV1 rejects fewer than seven distinct calendar days', () => {
  const manifest = authorityManifest({
    sevenDistinctCalendarDaysObserved: ['2026-08-01', '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'],
  })
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'eligible', targetState: 'authoritative' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_INVALID',
  )
})

test('validateAttendanceW4C5ManifestV1 rejects seven days that are not all distinct', () => {
  const manifest = authorityManifest({
    sevenDistinctCalendarDaysObserved: [
      '2026-08-01', '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
    ],
  })
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'eligible', targetState: 'authoritative' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_INVALID',
  )
})

test('validateAttendanceW4C5ManifestV1 rejects an authority manifest missing the authority-only fields (base shape on an authority pair)', () => {
  const manifest = baseManifest({ targetState: 'authoritative' })
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'eligible', targetState: 'authoritative' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_INVALID',
  )
})

// ---------------------------------------------------------------------------
// validateAttendanceW4C5ManifestV1 — resume pair (suspended -> authoritative)
// pair-aware negative: a manifest missing the resume-only fields must be rejected on the resume
// pair even though it would be perfectly valid on the base/authority-promotion shapes.
// ---------------------------------------------------------------------------
function resumeManifest(overrides: Record<string, unknown> = {}) {
  return baseManifest({
    targetState: 'authoritative',
    ownerIncidentReviewRef: 'incident-ref-1',
    offlineReplayArtifactRef: 'replay-ref-1',
    offlineReplayCriticalDiffCount: 0,
    offlineReplayUnresolvedDiffCount: 0,
    ...overrides,
  })
}

test('validateAttendanceW4C5ManifestV1 accepts a well-formed resume manifest and derives the five-key resume evidence', () => {
  const result = validateAttendanceW4C5ManifestV1(
    resumeManifest(),
    { orgId: ORG, expectedState: 'suspended', targetState: 'authoritative' },
    NOW,
  )
  assert.deepEqual(result.evidenceReferences, {
    imageSha: 'sha-image-123',
    ownerAuthorizationRef: 'owner-ref-1',
    syntheticOrgRef: 'synthetic-ref-1',
    ownerIncidentReviewRef: 'incident-ref-1',
    offlineReplayArtifactRef: 'replay-ref-1',
  })
})

test('validateAttendanceW4C5ManifestV1 rejects a resume-pair manifest missing offlineReplayArtifactRef (pair-aware negative)', () => {
  const manifest = resumeManifest() as Record<string, unknown>
  delete manifest.offlineReplayArtifactRef
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'suspended', targetState: 'authoritative' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_INVALID',
  )
})

test('validateAttendanceW4C5ManifestV1 rejects resume-only fields present on a non-resume pair (closed key set)', () => {
  const manifest = resumeManifest()
  assert.throws(
    () => validateAttendanceW4C5ManifestV1(manifest, { orgId: ORG, expectedState: 'eligible', targetState: 'authoritative' }, NOW),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_MANIFEST_INVALID',
  )
})

// ---------------------------------------------------------------------------
// computeAttendanceW4C5PlanDigestV1
// ---------------------------------------------------------------------------
function fakePlan(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    orgAllowlisted: true,
    rowExists: true,
    currentState: 'legacy',
    currentVersion: 1,
    // A bootstrap row's own priorState is null (see the type's doc comment); most fixtures below
    // override both currentState and priorState together to describe a specific transition.
    priorState: null,
    targetState: 'shadow',
    legalPair: true,
    comparisonWritePosture: 'shadow',
    canBootstrap: false,
    predicates: [
      { code: 'ORG_ALLOWLISTED', applicable: true, pass: true, count: null },
      { code: 'UNCLOSED_LEGACY_BATCH', applicable: true, pass: true, count: 0 },
    ],
    blocked: false,
    ...overrides,
  } as never
}

test('computeAttendanceW4C5PlanDigestV1 is deterministic for an identical plan', () => {
  const digest1 = computeAttendanceW4C5PlanDigestV1(fakePlan())
  const digest2 = computeAttendanceW4C5PlanDigestV1(fakePlan())
  assert.equal(digest1, digest2)
  assert.equal(digest1.length, 64)
})

test('computeAttendanceW4C5PlanDigestV1 changes when a predicate count changes', () => {
  const digest1 = computeAttendanceW4C5PlanDigestV1(fakePlan())
  const digest2 = computeAttendanceW4C5PlanDigestV1(
    fakePlan({
      predicates: [
        { code: 'ORG_ALLOWLISTED', applicable: true, pass: true, count: null },
        { code: 'UNCLOSED_LEGACY_BATCH', applicable: true, pass: false, count: 1 },
      ],
      blocked: true,
    }),
  )
  assert.notEqual(digest1, digest2)
})

test('computeAttendanceW4C5PlanDigestV1 changes when currentVersion changes (there-and-back transitions do not collide)', () => {
  const digest1 = computeAttendanceW4C5PlanDigestV1(fakePlan({ currentVersion: 1 }))
  const digest2 = computeAttendanceW4C5PlanDigestV1(fakePlan({ currentVersion: 3 }))
  assert.notEqual(digest1, digest2)
})

test('computeAttendanceW4C5PlanDigestV1 changes when priorState changes, state/version held fixed (P2-1)', () => {
  const digest1 = computeAttendanceW4C5PlanDigestV1(fakePlan({ currentState: 'shadow', currentVersion: 2, priorState: 'legacy' }))
  const digest2 = computeAttendanceW4C5PlanDigestV1(fakePlan({ currentState: 'shadow', currentVersion: 2, priorState: 'eligible' }))
  assert.notEqual(digest1, digest2)
})

// ---------------------------------------------------------------------------
// parseAttendanceW4C5PlanArgsV1 / parseAttendanceW4C5ApplyArgsV1
// ---------------------------------------------------------------------------
test('parseAttendanceW4C5PlanArgsV1 accepts a well-formed org/target pair', () => {
  const args = parseAttendanceW4C5PlanArgsV1(['--org', ORG, '--target', 'shadow'])
  assert.deepEqual(args, { orgId: ORG, targetState: 'shadow' })
})

test('parseAttendanceW4C5PlanArgsV1 rejects a missing --org', () => {
  assert.throws(
    () => parseAttendanceW4C5PlanArgsV1(['--target', 'shadow']),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_ARGS_INVALID',
  )
})

test('parseAttendanceW4C5PlanArgsV1 rejects a non-UUID org (no wildcard admitted)', () => {
  for (const bad of ['*', 'all', 'not-a-uuid', '']) {
    assert.throws(
      () => parseAttendanceW4C5PlanArgsV1(['--org', bad, '--target', 'shadow']),
      (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_ARGS_INVALID',
      `expected --org ${JSON.stringify(bad)} to be rejected`,
    )
  }
})

test('parseAttendanceW4C5PlanArgsV1 rejects an invalid target state enum value', () => {
  assert.throws(
    () => parseAttendanceW4C5PlanArgsV1(['--org', ORG, '--target', 'not_a_real_state']),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_ARGS_INVALID',
  )
})

function validApplyArgv(overrides: Record<string, string> = {}): string[] {
  const fields: Record<string, string> = {
    org: ORG,
    target: 'shadow',
    'expected-state': 'legacy',
    'expected-version': '1',
    'plan-digest': 'a'.repeat(64),
    confirm: ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
    manifest: '/tmp/manifest.json',
    'actor-id': 'operator-1',
    'correlation-id': CORR,
    'engine-version': 'w4c5-runbook-v1',
    ...overrides,
  }
  return Object.entries(fields).flatMap(([key, value]) => [`--${key}`, value])
}

test('parseAttendanceW4C5ApplyArgsV1 accepts a fully well-formed invocation', () => {
  const args = parseAttendanceW4C5ApplyArgsV1(validApplyArgv())
  assert.deepEqual(args, {
    orgId: ORG,
    targetState: 'shadow',
    expectedState: 'legacy',
    expectedVersion: 1,
    planDigest: 'a'.repeat(64),
    confirm: ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
    manifestPath: '/tmp/manifest.json',
    actorId: 'operator-1',
    correlationId: CORR,
    engineVersion: 'w4c5-runbook-v1',
  })
})

test('parseAttendanceW4C5ApplyArgsV1 rejects a missing --confirm with its own exclusive code (no implicit --yes)', () => {
  const argv = validApplyArgv().filter((_, index, arr) => arr[index - 1] !== '--confirm' && arr[index] !== '--confirm')
  assert.throws(
    () => parseAttendanceW4C5ApplyArgsV1(argv),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_CONFIRMATION_REQUIRED',
  )
})

test('parseAttendanceW4C5ApplyArgsV1 rejects a near-miss confirmation token', () => {
  assert.throws(
    () => parseAttendanceW4C5ApplyArgsV1(validApplyArgv({ confirm: 'I_UNDERSTAND_THIS_TRANSITIONS_A_SYNTHETIC_ORG' })),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_CONFIRMATION_REQUIRED',
  )
})

test('parseAttendanceW4C5ApplyArgsV1 rejects a malformed plan digest (not 64 lowercase hex)', () => {
  for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'zz' + 'a'.repeat(62)]) {
    assert.throws(
      () => parseAttendanceW4C5ApplyArgsV1(validApplyArgv({ 'plan-digest': bad })),
      (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_ARGS_INVALID',
    )
  }
})

test('parseAttendanceW4C5ApplyArgsV1 rejects a non-positive or leading-zero expected-version', () => {
  for (const bad of ['0', '01', '-1', 'abc']) {
    assert.throws(
      () => parseAttendanceW4C5ApplyArgsV1(validApplyArgv({ 'expected-version': bad })),
      (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_ARGS_INVALID',
    )
  }
})

test('parseAttendanceW4C5ApplyArgsV1 rejects a wildcard org (no wildcard admitted at apply either)', () => {
  assert.throws(
    () => parseAttendanceW4C5ApplyArgsV1(validApplyArgv({ org: '*' })),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_ARGS_INVALID',
  )
})

// ---------------------------------------------------------------------------
// runAttendanceW4C5ApplyOrchestrationV1 — the sequencing trap
// ---------------------------------------------------------------------------
const APPLY_ARGS = parseAttendanceW4C5ApplyArgsV1(validApplyArgv())
const VALIDATED_MANIFEST = validateAttendanceW4C5ManifestV1(
  baseManifest(),
  { orgId: ORG, expectedState: 'legacy', targetState: 'shadow' },
  NOW,
)

function countingDeps(planResult: unknown): AttendanceW4C5ApplyDepsV1 & { transitionCalls: unknown[] } {
  const transitionCalls: unknown[] = []
  return {
    transitionCalls,
    plan: async () => planResult as never,
    transition: async (input) => {
      transitionCalls.push(input)
      return { orgId: input.orgId, state: input.targetState, batchId: null }
    },
  }
}

test('runAttendanceW4C5ApplyOrchestrationV1: idempotent re-apply is a no-op and NEVER calls transition, even though the fresh plan digest differs from the supplied one', async () => {
  // This is the exact trap: the pre-transition plan (state=legacy, version=1) produced the
  // digest carried on the command line (APPLY_ARGS.planDigest = 64 'a's, a deliberately WRONG
  // digest for that pre-transition plan — proving idempotency short-circuits BEFORE any digest
  // comparison ever runs, not merely that it happens to match by coincidence).
  // priorState: 'legacy' matches APPLY_ARGS.expectedState ('legacy') — this is the transition
  // that ACTUALLY happened (legacy -> shadow), which is exactly what makes this a genuine
  // re-observation of a completed transition, not merely a state/version coincidence.
  const postTransitionPlan = fakePlan({ currentState: 'shadow', currentVersion: 2, priorState: 'legacy', targetState: 'shadow' })
  const deps = countingDeps(postTransitionPlan)

  const outcome = await runAttendanceW4C5ApplyOrchestrationV1(deps, APPLY_ARGS, VALIDATED_MANIFEST)

  assert.equal(outcome.outcome, 'noop_already_at_target')
  assert.equal(outcome.state, 'shadow')
  assert.equal(deps.transitionCalls.length, 0)
})

test('runAttendanceW4C5ApplyOrchestrationV1 P2-1: state/version match alone is NOT enough — a priorState mismatch falls through to the digest check, never a no-op', async () => {
  // Same (state, version) shape as the genuine no-op above (shadow v2, target shadow,
  // expectedVersion 1), but this fixture's priorState is 'eligible', not the 'legacy'
  // APPLY_ARGS.expectedState claims. This is the exact false-completion shape the gate executed
  // (D1/A17): an operator asserting an --expected-state that was never the state this row
  // actually transitioned from. The all-'a' planDigest on APPLY_ARGS was never a valid digest for
  // ANY plan, so falling through to step 3 must refuse with PLAN_DIGEST_MISMATCH — never a no-op.
  const wrongPriorPlan = fakePlan({ currentState: 'shadow', currentVersion: 2, priorState: 'eligible', targetState: 'shadow' })
  const deps = countingDeps(wrongPriorPlan)

  await assert.rejects(
    () => runAttendanceW4C5ApplyOrchestrationV1(deps, APPLY_ARGS, VALIDATED_MANIFEST),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_PLAN_DIGEST_MISMATCH',
  )
  assert.equal(deps.transitionCalls.length, 0)
})

test('runAttendanceW4C5ApplyOrchestrationV1 P2-1: a priorState mismatch with a FRESHLY MATCHING digest reaches the boundary (never a local no-op) and the boundary is what refuses it', async () => {
  // Sharper than the digest-mismatch case above: here the caller ALSO supplies a digest that
  // matches this exact (wrong-priorState) plan, so step 3 cannot be what blocks the no-op. This
  // is the mutation-exclusive proof for the priorState conjunct: neutering ONLY the priorState
  // check turns this into an exit-0 no-op; neutering the digest check leaves this test green
  // (the plan/digest amount here is genuinely fresh and matching, by construction).
  const wrongPriorPlan = fakePlan({ currentState: 'shadow', currentVersion: 2, priorState: 'eligible', targetState: 'shadow' })
  const matchingArgs = { ...APPLY_ARGS, planDigest: computeAttendanceW4C5PlanDigestV1(wrongPriorPlan as never) }
  const deps = countingDeps(wrongPriorPlan)

  const outcome = await runAttendanceW4C5ApplyOrchestrationV1(deps, matchingArgs, VALIDATED_MANIFEST)

  // With the priorState check in place but nothing else changed, this is NOT a no-op — it falls
  // through to the boundary call, which is asserted here to have been invoked exactly once with
  // the caller's claimed (wrong) expectedState. A real boundary would refuse this with its own
  // ILLEGAL_TRANSITION/STALE_EXPECTED_STATE code (proven end-to-end at the DB level); this fake
  // only proves the tool-level no-op never fires.
  assert.equal(outcome.outcome, 'transitioned')
  assert.equal(deps.transitionCalls.length, 1)
  assert.equal((deps.transitionCalls[0] as { expectedState: string }).expectedState, 'legacy')
})

test('runAttendanceW4C5ApplyOrchestrationV1: a genuinely stale plan (diverged to a DIFFERENT state, not the target) is a hard digest-mismatch refusal, never a no-op', async () => {
  const divergedPlan = fakePlan({ currentState: 'eligible', currentVersion: 2, targetState: 'shadow', legalPair: false })
  const deps = countingDeps(divergedPlan)

  await assert.rejects(
    () => runAttendanceW4C5ApplyOrchestrationV1(deps, APPLY_ARGS, VALIDATED_MANIFEST),
    (error: unknown) => error instanceof AttendanceW4C5ToolError && error.code === 'W4C5_TOOL_PLAN_DIGEST_MISMATCH',
  )
  assert.equal(deps.transitionCalls.length, 0)
})

test('runAttendanceW4C5ApplyOrchestrationV1: a matching-digest plan whose predicates report blocked still calls the boundary — the boundary decides, not a second tool-level classification', async () => {
  const blockedPlan = fakePlan({
    currentState: 'legacy',
    currentVersion: 1,
    targetState: 'shadow',
    blocked: true,
    predicates: [{ code: 'UNCLOSED_LEGACY_BATCH', applicable: true, pass: false, count: 2 }],
  })
  const matchingArgs = { ...APPLY_ARGS, planDigest: computeAttendanceW4C5PlanDigestV1(blockedPlan as never) }
  const deps = countingDeps(blockedPlan)

  // No local short-circuit: the orchestration calls the boundary exactly as it would for a
  // clean plan. In production the REAL boundary would reject this with its own
  // W4C3A_ROLLOUT_CONTROL_UNCLOSED_BATCH; this fake simply proves the call happens at all.
  const outcome = await runAttendanceW4C5ApplyOrchestrationV1(deps, matchingArgs, VALIDATED_MANIFEST)
  assert.equal(outcome.outcome, 'transitioned')
  assert.equal(deps.transitionCalls.length, 1)
})

test('runAttendanceW4C5ApplyOrchestrationV1: happy path calls transition with the exact expected shape', async () => {
  const readyPlan = fakePlan({ currentState: 'legacy', currentVersion: 1, targetState: 'shadow', blocked: false })
  const matchingArgs = { ...APPLY_ARGS, planDigest: computeAttendanceW4C5PlanDigestV1(readyPlan as never) }
  const deps = countingDeps(readyPlan)

  const outcome = await runAttendanceW4C5ApplyOrchestrationV1(deps, matchingArgs, VALIDATED_MANIFEST)

  assert.equal(outcome.outcome, 'transitioned')
  assert.equal(deps.transitionCalls.length, 1)
  assert.deepEqual(deps.transitionCalls[0], {
    orgId: ORG,
    actorId: 'operator-1',
    correlationId: CORR,
    engineVersion: 'w4c5-runbook-v1',
    targetState: 'shadow',
    expectedState: 'legacy',
    expectedVersion: 1,
    evidenceManifestSha256: VALIDATED_MANIFEST.evidenceManifestSha256,
    evidenceReferences: VALIDATED_MANIFEST.evidenceReferences,
    reasonCode: 'rollout_transition',
  })
})

test('runAttendanceW4C5ApplyOrchestrationV1: a boundary refusal propagates unchanged, never masked or retried', async () => {
  const readyPlan = fakePlan({ currentState: 'legacy', currentVersion: 1, targetState: 'shadow', blocked: false })
  const matchingArgs = { ...APPLY_ARGS, planDigest: computeAttendanceW4C5PlanDigestV1(readyPlan as never) }
  let calls = 0
  const deps: AttendanceW4C5ApplyDepsV1 = {
    plan: async () => readyPlan as never,
    transition: async () => {
      calls += 1
      const error = new Error('ATTENDANCE_CALCULATION_ROLLOUT_BUSY')
      ;(error as unknown as { name: string; code: string }).name = 'AttendanceW4OperationError'
      ;(error as unknown as { code: string }).code = 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY'
      throw error
    },
  }

  await assert.rejects(
    () => runAttendanceW4C5ApplyOrchestrationV1(deps, matchingArgs, VALIDATED_MANIFEST),
    (error: unknown) => (error as { code?: unknown }).code === 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY',
  )
  assert.equal(calls, 1)
})

// ---------------------------------------------------------------------------
// exitCodeForAttendanceW4C5ErrorV1 / describeAttendanceW4C5ErrorV1
// ---------------------------------------------------------------------------
test('exitCodeForAttendanceW4C5ErrorV1 maps every tool-level code to its own exit code', () => {
  const cases: Array<[string, number]> = [
    ['W4C5_TOOL_ARGS_INVALID', ATTENDANCE_W4C5_EXIT_ARGS_INVALID_V1],
    ['W4C5_TOOL_CONFIRMATION_REQUIRED', ATTENDANCE_W4C5_EXIT_CONFIRMATION_REQUIRED_V1],
    ['W4C5_TOOL_MANIFEST_INVALID', ATTENDANCE_W4C5_EXIT_MANIFEST_INVALID_V1],
    ['W4C5_TOOL_MANIFEST_ORG_MISMATCH', ATTENDANCE_W4C5_EXIT_MANIFEST_INVALID_V1],
    ['W4C5_TOOL_MANIFEST_TARGET_MISMATCH', ATTENDANCE_W4C5_EXIT_MANIFEST_INVALID_V1],
    ['W4C5_TOOL_MANIFEST_STALE', ATTENDANCE_W4C5_EXIT_PLAN_STALE_V1],
    ['W4C5_TOOL_PLAN_DIGEST_MISMATCH', ATTENDANCE_W4C5_EXIT_PLAN_STALE_V1],
  ]
  for (const [code, expected] of cases) {
    assert.equal(exitCodeForAttendanceW4C5ErrorV1(new AttendanceW4C5ToolError(code)), expected, code)
  }
})

test('ATTENDANCE_W4C5_EXIT_PLAN_BLOCKED_V1 is reserved for the read-only `plan` command exit code (not thrown by apply orchestration)', () => {
  // `plan` (read-only) uses this exit code directly from `report.blocked`, never via
  // exitCodeForAttendanceW4C5ErrorV1 — apply never locally classifies "blocked" as its own
  // tool-level refusal (see the orchestration's own doc comment for why).
  assert.equal(typeof ATTENDANCE_W4C5_EXIT_PLAN_BLOCKED_V1, 'number')
})

test('exitCodeForAttendanceW4C5ErrorV1 maps a boundary-shaped error to the boundary-refused exit code', () => {
  const error = new Error('W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION')
  ;(error as unknown as { name: string; code: string }).name = 'AttendanceW4C3aRolloutControlError'
  ;(error as unknown as { code: string }).code = 'W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION'
  assert.equal(exitCodeForAttendanceW4C5ErrorV1(error), ATTENDANCE_W4C5_EXIT_BOUNDARY_REFUSED_V1)
})

test('exitCodeForAttendanceW4C5ErrorV1 maps an unrecognized error to the internal-error exit code', () => {
  assert.equal(exitCodeForAttendanceW4C5ErrorV1(new Error('anything else')), ATTENDANCE_W4C5_EXIT_INTERNAL_ERROR_V1)
  assert.equal(exitCodeForAttendanceW4C5ErrorV1('not an error at all'), ATTENDANCE_W4C5_EXIT_INTERNAL_ERROR_V1)
})

test('ATTENDANCE_W4C5_EXIT_SUCCESS_V1 is zero (reserved for the success/no-op path only)', () => {
  assert.equal(ATTENDANCE_W4C5_EXIT_SUCCESS_V1, 0)
})

test('describeAttendanceW4C5ErrorV1 is values-free: reports only the code, never any other property', () => {
  const error = new AttendanceW4C5ToolError('W4C5_TOOL_MANIFEST_INVALID')
  ;(error as unknown as { secretPayload: string }).secretPayload = 'do-not-print-me'
  const description = describeAttendanceW4C5ErrorV1(error)
  assert.equal(description, 'W4C5_TOOL_MANIFEST_INVALID')
  assert.doesNotMatch(description, /do-not-print-me/)
})
