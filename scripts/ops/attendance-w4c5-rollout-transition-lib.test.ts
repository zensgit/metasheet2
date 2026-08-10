/**
 * Unit tests for the W4C-5 operator transition tooling's pure module. No database, no
 * filesystem, no network — every case here is a plain function call. Real-DB proof (the plan
 * reporter's zero-write property, the full legacy->shadow apply, idempotent re-apply, and every
 * refusal class end to end) lives in
 * packages/core-backend/tests/integration/attendance-w4c5-rollout-transition-tool.db.test.ts.
 *
 * SCOPED EXCEPTION (PR #4839 fresh-gate round, 20260810): the final section of this file breaks
 * the "no filesystem, no network" rule above on purpose — it exercises `claim-sweep.mjs`'s
 * shallow-clone ancestry-verdict downgrade against REAL git shallow-graft behaviour (constructed
 * temp repos + a real child process), which cannot be proven any other way without mocking git
 * itself. Added HERE, not a new file, specifically because this file is already wired into CI
 * (`pnpm exec tsx --test scripts/ops/attendance-w4c5-rollout-transition-lib.test.ts`,
 * `.github/workflows/plugin-tests.yml`) and a new standalone test file would not run in CI
 * without editing that workflow — out of scope for this round. See `claim-sweep.mjs`'s own
 * header for the precise, disclosed statement of what is and is not CI-wired.
 *
 * Run: pnpm exec tsx --test scripts/ops/attendance-w4c5-rollout-transition-lib.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ATTENDANCE_W4C5_BOUNDARY_ERROR_NAMES_V1,
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
// TYPE-ONLY import (erased at compile time, zero runtime dependency) — see the identical
// discipline note at the top of attendance-w4c5-rollout-transition-lib.ts for why this crosses
// the core-backend boundary as a type import only, never a value import.
import type {
  AttendanceRolloutTransitionPlanV1,
  AttendanceRolloutTransitionPredicateV1,
} from '../../packages/core-backend/src/attendance/w4c3a-rollout-control'

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
// computeAttendanceW4C5PlanDigestV1 — field-coverage table (P2-1-DIGEST-COVERAGE, PR #4839 gate,
// 20260809; NIT-3, PR #4839 P3 gate, 20260810: tagged distinctly from the bare "P2-1" used
// elsewhere in this file and in the operator runbook for the UNRELATED `priorState`/idempotency
// finding — see the test above this block).
//
// The gate's finding: deleting fields from `computeAttendanceW4C5PlanDigestV1`'s internal
// `canonical` object one at a time — ONLY `currentVersion` and `priorState` reddened this suite;
// the other 14 fields (10 remaining top-level fields plus all 4 predicate sub-fields —
// `code`/`applicable`/`pass`/`count`, see the SECOND table below), INCLUDING `orgId` and
// `targetState`, left every test above green — 2 of 16 total, not 2 of 11. The fields were always
// all present in the source (verified field-by-field against `AttendanceRolloutTransitionPlanV1`
// below — all 12 top-level fields of the type, including `predicates`, already appear in
// `canonical`) — the gap was test coverage, not a missing field.
//
// `FULL_PLAN` below is a plain object literal ASSIGNED TO the real `AttendanceRolloutTransitionPlanV1`
// type (not `fakePlan()`'s `as never` shape used elsewhere in this file), so TypeScript itself
// would refuse to compile this file if a required field of that type were left out of the literal.
// The key list this test iterates comes from `Object.keys(FULL_PLAN)` — i.e. from THIS fixture,
// never from `computeAttendanceW4C5PlanDigestV1`'s own `canonical` object — so deleting a field
// from `canonical` cannot also delete it from what this test checks (the exact circularity trap
// the gate warned against).
//
// Honest limitation, checked rather than assumed: `scripts/ops` is NOT a member of any pnpm
// workspace (`pnpm-workspace.yaml` lists only `packages/*`, `apps/*`, `tools/*`, `plugins/*`) and
// no `.github/workflows/*.yml` step runs `tsc`/`tsc --noEmit` over this directory — grepped, zero
// hits. `tsx --test` (this file's own runner) strips TypeScript types via esbuild; it does not
// type-check them. So the "TypeScript itself would refuse to compile" property above is true for
// a developer's own local `tsc`, but is NOT mechanically enforced by this repo's CI today — a
// future field silently added to `AttendanceRolloutTransitionPlanV1` without updating `FULL_PLAN`
// and `PLAN_FIELD_ALTERNATES` below would NOT be caught by this test in CI. The
// `keys.length === 12` assertion is a manual tripwire for a human editing this file, not a
// substitute for real enforcement.
//
// F4 (PR #4839 P3 gate, 20260810): the companion test in
// `packages/core-backend/tests/integration/attendance-w4c5-rollout-transition-tool.db.test.ts`
// USED TO claim it "close[d] this without depending on any human remembering anything" — false as
// written: it derived its key list from `Object.keys()` of ONE real plan object the boundary
// produced at runtime, i.e. what THAT object HAS, not what the type DECLARES, so a
// conditionally-emitted OPTIONAL field absent from that one instance would have escaped it
// silently too. Its domain is now `Object.keys()` of a `Record<keyof
// AttendanceRolloutTransitionPlanV1, ...>`-typed alternate-generator table, the same
// type-completeness discipline as `FULL_PLAN`/`PLAN_FIELD_ALTERNATES` here — real for a
// developer's own local `tsc`, same CI-enforcement caveat as this file. See that test's own
// updated comment for the full account.
// ---------------------------------------------------------------------------
const FULL_PLAN: AttendanceRolloutTransitionPlanV1 = {
  orgId: ORG,
  orgAllowlisted: true,
  rowExists: true,
  currentState: 'shadow',
  currentVersion: 2,
  priorState: 'legacy',
  targetState: 'eligible',
  legalPair: true,
  comparisonWritePosture: 'shadow',
  canBootstrap: false,
  predicates: [
    { code: 'ORG_ALLOWLISTED', applicable: true, pass: true, count: null },
    { code: 'UNCLOSED_LEGACY_BATCH', applicable: true, pass: true, count: 0 },
  ],
  blocked: false,
}

/** One distinguishable, LEGAL alternate value per top-level `AttendanceRolloutTransitionPlanV1`
 * field — never `undefined` (canonicalJsonV1 goes through `JSON.stringify`, which silently drops
 * `undefined`-valued keys, which would conflate "field mutated" with "field absent"). */
const PLAN_FIELD_ALTERNATES: Record<keyof AttendanceRolloutTransitionPlanV1, unknown> = {
  orgId: OTHER_ORG,
  orgAllowlisted: false,
  rowExists: false,
  currentState: 'eligible',
  currentVersion: 5,
  priorState: 'eligible',
  targetState: 'authoritative',
  legalPair: false,
  comparisonWritePosture: 'authoritative',
  canBootstrap: true,
  predicates: [{ code: 'ORG_ALLOWLISTED', applicable: true, pass: true, count: null }],
  blocked: true,
}

test('computeAttendanceW4C5PlanDigestV1 field-coverage table: mutating ANY single top-level plan field changes the digest (P2-1-DIGEST-COVERAGE)', () => {
  const baseline = computeAttendanceW4C5PlanDigestV1(FULL_PLAN)
  const keys = Object.keys(FULL_PLAN) as Array<keyof AttendanceRolloutTransitionPlanV1>
  assert.equal(
    keys.length,
    12,
    'AttendanceRolloutTransitionPlanV1 field count changed — update FULL_PLAN and PLAN_FIELD_ALTERNATES above (and see the DB-suite companion test for the mechanically-enforced version of this check)',
  )
  for (const key of keys) {
    const mutated = { ...FULL_PLAN, [key]: PLAN_FIELD_ALTERNATES[key] } as AttendanceRolloutTransitionPlanV1
    const digest = computeAttendanceW4C5PlanDigestV1(mutated)
    assert.notEqual(digest, baseline, `mutating plan field '${key}' must change the digest`)
  }
})

const PREDICATE_FIELD_ALTERNATES: Record<keyof AttendanceRolloutTransitionPredicateV1, unknown> = {
  code: 'RETRYABLE_JOB_POSTURE_MISMATCH',
  applicable: false,
  pass: false,
  // Deliberately NOT compared against `firstPredicate`'s `count` (which is `null`, see below) —
  // see the `count`-specific branch in the loop for why.
  count: 999,
}

test('computeAttendanceW4C5PlanDigestV1 field-coverage table: mutating ANY single predicate sub-field changes the digest (P2-1-DIGEST-COVERAGE)', () => {
  const baseline = computeAttendanceW4C5PlanDigestV1(FULL_PLAN)
  const firstPredicate = FULL_PLAN.predicates[0]
  const keys = Object.keys(firstPredicate) as Array<keyof AttendanceRolloutTransitionPredicateV1>
  assert.equal(
    keys.length,
    4,
    'AttendanceRolloutTransitionPredicateV1 field count changed — update PREDICATE_FIELD_ALTERNATES above',
  )
  for (const key of keys) {
    if (key === 'count') {
      // F3 (PR #4839 P3 gate, 20260810): `firstPredicate.count` is `null` in `FULL_PLAN`, so
      // mutating it to ANY non-null value (including a value-bucketing mutant that collapses
      // every non-null count to the same constant) crosses the null/non-null boundary and makes
      // the digest change for that reason alone — proving `count` is PRESENT in the digest, never
      // that its VALUE is preserved. A mutant that replaced `count: predicate.count` with
      // `count: predicate.count === null ? null : 1` (bucketing every non-null count to `1`)
      // left this row green. Prove VALUE preservation instead, using the SECOND predicate, whose
      // baseline `count` is the non-null `0`, mutated to a DIFFERENT non-null value — the
      // bucketing mutant collapses both to `1` and this assertion reds.
      const secondPredicate = FULL_PLAN.predicates[1]
      assert.equal(
        secondPredicate.count,
        0,
        'fixture drifted — this row assumes a non-null baseline count on predicates[1]; update it or re-pick a non-null baseline predicate',
      )
      const mutatedSecond = { ...secondPredicate, count: PREDICATE_FIELD_ALTERNATES.count } as AttendanceRolloutTransitionPredicateV1
      const mutatedPlan: AttendanceRolloutTransitionPlanV1 = {
        ...FULL_PLAN,
        predicates: [FULL_PLAN.predicates[0], mutatedSecond],
      }
      const digest = computeAttendanceW4C5PlanDigestV1(mutatedPlan)
      assert.notEqual(digest, baseline, `mutating predicate field 'count' (non-null baseline 0 -> non-null 999) must change the digest`)
      continue
    }
    const mutatedPredicate = { ...firstPredicate, [key]: PREDICATE_FIELD_ALTERNATES[key] } as AttendanceRolloutTransitionPredicateV1
    const mutatedPlan: AttendanceRolloutTransitionPlanV1 = {
      ...FULL_PLAN,
      predicates: [mutatedPredicate, FULL_PLAN.predicates[1]],
    }
    const digest = computeAttendanceW4C5PlanDigestV1(mutatedPlan)
    assert.notEqual(digest, baseline, `mutating predicate field '${key}' must change the digest`)
  }
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

// ---------------------------------------------------------------------------
// P2-A (PR #4839 gate, 20260810): one positive test per bucket in
// ATTENDANCE_W4C5_BOUNDARY_ERROR_NAMES_V1 (the closed `.name` allowlist this reverted BACK to,
// off a one-round-lived structural-marker discriminator — see that const's own doc comment for
// the full call-graph trace), plus negative controls for classes that share the marker's
// "message IS the code" shape but must NOT get exit 7.
// ---------------------------------------------------------------------------
test('exitCodeForAttendanceW4C5ErrorV1 maps an AttendanceW4C3aRolloutControlError-shaped refusal to the boundary-refused exit code', () => {
  const error = new Error('W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION')
  ;(error as unknown as { name: string; code: string }).name = 'AttendanceW4C3aRolloutControlError'
  ;(error as unknown as { code: string }).code = 'W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION'
  assert.equal(exitCodeForAttendanceW4C5ErrorV1(error), ATTENDANCE_W4C5_EXIT_BOUNDARY_REFUSED_V1)
})

test('exitCodeForAttendanceW4C5ErrorV1 maps a W4C0_CONNECTION_NOT_IDLE (AttendanceW4IdentityError) refusal to the boundary-refused exit code, not internal-error', () => {
  // Cannot `instanceof AttendanceW4IdentityError` here (no value-level core-backend import — see
  // this module's own file-header comment), so this constructs the SAME shape the real class
  // produces: `super(code)` then `this.code = code`. NIT-4 (PR #4839 P3 gate, 20260810) found
  // this exact refusal falling through to ATTENDANCE_W4C5_EXIT_INTERNAL_ERROR_V1 because a prior
  // two-item `.name` OR-list omitted this class — the omission this list now includes.
  const error = new Error('W4C0_CONNECTION_NOT_IDLE')
  ;(error as unknown as { name: string; code: string }).name = 'AttendanceW4IdentityError'
  ;(error as unknown as { code: string }).code = 'W4C0_CONNECTION_NOT_IDLE'
  assert.equal(exitCodeForAttendanceW4C5ErrorV1(error), ATTENDANCE_W4C5_EXIT_BOUNDARY_REFUSED_V1)
})

test('P2-A: exitCodeForAttendanceW4C5ErrorV1 maps an ATTENDANCE_CALCULATION_ROLLOUT_BUSY (AttendanceW4OperationError) refusal to the boundary-refused exit code', () => {
  // Reachable ONLY from `apply` (`acquireAttendanceCalculationRolloutLockSessionExclusiveV1`'s
  // `busyError('rollout')` in w4c0-identity.ts) — `plan` never acquires an advisory lock — but the
  // discriminator itself does not distinguish plan-reachable from apply-reachable, so one shaped
  // case here is the direct test for the third (previously untested-by-name) bucket member.
  const error = new Error('ATTENDANCE_CALCULATION_ROLLOUT_BUSY')
  ;(error as unknown as { name: string; code: string }).name = 'AttendanceW4OperationError'
  ;(error as unknown as { code: string }).code = 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY'
  assert.equal(exitCodeForAttendanceW4C5ErrorV1(error), ATTENDANCE_W4C5_EXIT_BOUNDARY_REFUSED_V1)
})

test('P2-A negative control: an AttendanceRequestSnapshotError-shaped refusal (message !== code) must NOT get the boundary-refused exit code', () => {
  // `AttendanceRequestSnapshotError` (w4c3b-request-snapshots.ts) IS reachable from both `plan`
  // and `apply` (`classifyAttendanceRequestSnapshotDefectsV1`'s unwrapped live-side
  // `computeAttendanceRequestPayloadFingerprintV1` call — no try/catch, unlike its stored-side
  // sibling) but its constructor takes `(code, statusCode, message)` and calls `super(message)` —
  // a FIXED human sentence, never equal to `code`, on every real call site. This is exactly the
  // class the one-round-lived structural marker (`message === code`) mis-measured as "too
  // narrow" — it never matched the marker either, so this refusal was ALREADY exit-1 before this
  // revert; this test locks that in as the deliberately-correct bucket (a live row that cannot be
  // normalized into a calculation payload is a data-integrity defect, not one of this boundary's
  // own documented section-3 refusals), not an omission to fix.
  const error = new Error('Invalid request snapshot input')
  ;(error as unknown as { name: string; code: string }).name = 'AttendanceRequestSnapshotError'
  ;(error as unknown as { code: string }).code = 'W4C3B_REQUEST_SNAPSHOT_INPUT_INVALID'
  assert.equal(exitCodeForAttendanceW4C5ErrorV1(error), ATTENDANCE_W4C5_EXIT_INTERNAL_ERROR_V1)
})

test('P2-A negative control: an AttendanceW4RegistryError-shaped refusal (same "message IS the code" shape as the boundary classes) must NOT get the boundary-refused exit code', () => {
  // `AttendanceW4RegistryError` (w4c0-operation-registry.ts) follows the IDENTICAL
  // `super(code); this.code = code` convention as all three boundary classes — this is the
  // concrete case the one-round-lived structural marker mis-measured as "too wide": the marker
  // could not distinguish this internal-invariant registry class from the three that actually
  // constitute the transition boundary. A `.name` closed list does not have this failure mode by
  // construction (an unlisted name never matches), and this test attacks that directly: it is
  // NOT in ATTENDANCE_W4C5_BOUNDARY_ERROR_NAMES_V1, so even a perfectly marker-shaped instance
  // must still fall to internal-error.
  const error = new Error('W4C0_BATCH_ITEM_ORDINAL_MISMATCH')
  ;(error as unknown as { name: string; code: string }).name = 'AttendanceW4RegistryError'
  ;(error as unknown as { code: string }).code = 'W4C0_BATCH_ITEM_ORDINAL_MISMATCH'
  assert.equal(exitCodeForAttendanceW4C5ErrorV1(error), ATTENDANCE_W4C5_EXIT_INTERNAL_ERROR_V1)
})

test('exitCodeForAttendanceW4C5ErrorV1 does not fire on a raw driver-shaped error (negative control: `.name` is never one of the three boundary class names)', () => {
  // A real PostgreSQL/pg-driver error has `.code` as a 5-character SQLSTATE, `.message` as a
  // distinct human-readable sentence, and a driver-assigned `.name` (never one of this repo's own
  // class names) — verified against real PostgreSQL. This must fall to internal-error regardless
  // of whatever shape `.message`/`.code` happen to have.
  const rawDriverError = new Error('current transaction is aborted, commands ignored until end of transaction block')
  ;(rawDriverError as unknown as { code: string }).code = '25P02'
  assert.equal(exitCodeForAttendanceW4C5ErrorV1(rawDriverError), ATTENDANCE_W4C5_EXIT_INTERNAL_ERROR_V1)
})

// ---------------------------------------------------------------------------
// Mechanical sweep (P2-A, PR #4839 gate, 20260810). Its DOMAIN, stated exactly — the production
// module's comment on ATTENDANCE_W4C5_BOUNDARY_ERROR_NAMES_V1 was narrowed to this after an
// earlier, broader phrasing here claimed more than the regex delivered and a subclass declaration
// walked through it:
//
//   Covers: declarations spelled `export class Attendance<...>Error extends Error` or
//   `export class Attendance<...>Error extends Attendance<...>Error`, in the FIVE files listed
//   below (the depth-1 imports of `w4c3a-rollout-control.ts`).
//   Does NOT cover: a class declared in a depth-2 file, a class named outside the
//   `Attendance*Error` convention, or one extending some other base.
//
// Within that domain, each class found must be explicitly decided — either into
// ATTENDANCE_W4C5_BOUNDARY_ERROR_NAMES_V1 (the production module's own exported list, not a
// hand-copied duplicate) or into ATTENDANCE_W4C5_KNOWN_NOT_BOUNDARY_ERROR_NAMES below (exit 1,
// deliberately, each with its own negative-control test above) — never left to a silent default,
// and a class matching those spellings with neither name recognized fails this test closed.
// Outside that domain the rot stays silent: this narrows the window, it does not close it.
// Reads SOURCE TEXT (never imports these classes as values — same CJS/ESM-interop constraint the
// production module documents).
// ---------------------------------------------------------------------------
const ATTENDANCE_W4C5_REACHABLE_ERROR_FILES = [
  '../../packages/core-backend/src/attendance/w4c3a-rollout-control.ts',
  '../../packages/core-backend/src/attendance/w4c0-identity.ts',
  '../../packages/core-backend/src/attendance/w4c0-operation-contract.ts',
  '../../packages/core-backend/src/attendance/w4c3b-request-snapshots.ts',
  '../../packages/core-backend/src/attendance/w4c0-operation-registry.ts',
]
const ATTENDANCE_W4C5_KNOWN_NOT_BOUNDARY_ERROR_NAMES = [
  'AttendanceRequestSnapshotError',
  'AttendanceW4RegistryError',
]
// The base-class alternation is load-bearing, not defensive breadth. With `extends Error` alone,
// `export class AttendanceW4FooError extends AttendanceW4IdentityError` — a subclass of a class
// this sweep already decided — did NOT match, stayed undecided, and silently took the
// internal-error bucket while every test remained green (EXECUTED as MUT-2, PR #4839 gate,
// 20260810: the sweep test stayed 58/58 under exactly that declaration).
const ATTENDANCE_W4C5_ERROR_CLASS_DECLARATION_RE =
  /export class (Attendance\w*Error) extends (?:Error|Attendance\w*Error)/g

test('mechanical sweep control: the error-class-declaration regex actually fires on a synthetic sentence (a clean sweep below means "every class decided", not "the regex matched nothing")', () => {
  const synthetic = 'export class AttendanceSyntheticProbeError extends Error {\n  readonly code: string\n}'
  const matches = [...synthetic.matchAll(ATTENDANCE_W4C5_ERROR_CLASS_DECLARATION_RE)].map((m) => m[1])
  assert.deepEqual(matches, ['AttendanceSyntheticProbeError'])
})

test('mechanical sweep control: the regex also fires on a SUBCLASS declaration (the form that escaped it before — a subclass of an already-decided class is still a new, undecided class)', () => {
  const synthetic =
    'export class AttendanceW4SubclassProbeError extends AttendanceW4IdentityError {\n  readonly code: string\n}'
  const matches = [...synthetic.matchAll(ATTENDANCE_W4C5_ERROR_CLASS_DECLARATION_RE)].map((m) => m[1])
  assert.deepEqual(matches, ['AttendanceW4SubclassProbeError'])
})

test('mechanical sweep: every Attendance*Error class declared in the reachable call-graph files is explicitly decided (boundary-refused or not) — no silent default for a new class', () => {
  const found = new Set<string>()
  const undecided: string[] = []
  for (const relativePath of ATTENDANCE_W4C5_REACHABLE_ERROR_FILES) {
    const absolutePath = fileURLToPath(new URL(relativePath, import.meta.url))
    const text = readFileSync(absolutePath, 'utf8')
    for (const match of text.matchAll(ATTENDANCE_W4C5_ERROR_CLASS_DECLARATION_RE)) {
      found.add(match[1])
      const decided =
        (ATTENDANCE_W4C5_BOUNDARY_ERROR_NAMES_V1 as readonly string[]).includes(match[1]) ||
        ATTENDANCE_W4C5_KNOWN_NOT_BOUNDARY_ERROR_NAMES.includes(match[1])
      if (!decided) undecided.push(`${match[1]} (${relativePath})`)
    }
  }
  assert.deepEqual(
    undecided,
    [],
    'undecided Attendance*Error class(es) — add each to ATTENDANCE_W4C5_BOUNDARY_ERROR_NAMES_V1 ' +
      '(and update exitCodeForAttendanceW4C5ErrorV1s doc comment) or to ' +
      'ATTENDANCE_W4C5_KNOWN_NOT_BOUNDARY_ERROR_NAMES in this test, with a reason either way',
  )
  // Every DECIDED name must still exist as a real class declaration in one of the files above —
  // otherwise a rename or deletion would silently satisfy this sweep without ever re-checking
  // whatever the class became.
  const stale = [...ATTENDANCE_W4C5_BOUNDARY_ERROR_NAMES_V1, ...ATTENDANCE_W4C5_KNOWN_NOT_BOUNDARY_ERROR_NAMES].filter(
    (name) => !found.has(name),
  )
  assert.deepEqual(stale, [], 'decided name(s) no longer declared in any reachable file')
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

// ---------------------------------------------------------------------------
// claim-sweep.mjs coverage (PR #4839 fresh-gate round, 20260810). See the SCOPED EXCEPTION note
// at the top of this file for why real git/filesystem/subprocess work happens in this section.
// ---------------------------------------------------------------------------
const CLAIM_SWEEP_PATH = fileURLToPath(new URL('./claim-sweep.mjs', import.meta.url))

function runClaimSweep(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLAIM_SWEEP_PATH, ...args], { cwd, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function gitQuiet(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] })
}

function gitOutput(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A tiny full repo (c1 -> c2 -> c3, three real commits) in a fresh tmpdir, oldest SHA first. */
function buildFullRepoV1(): { dir: string; c1: string; c2: string; c3: string } {
  const dir = mkdtempSync(join(tmpdir(), 'claim-sweep-full-'))
  gitQuiet(['init', '-q'], dir)
  gitQuiet(['config', 'user.email', 'test@example.com'], dir)
  gitQuiet(['config', 'user.name', 'test'], dir)
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  gitQuiet(['add', 'a.txt'], dir)
  gitQuiet(['commit', '-q', '-m', 'c1'], dir)
  const c1 = gitOutput(['rev-parse', 'HEAD'], dir)
  writeFileSync(join(dir, 'a.txt'), 'two\n')
  gitQuiet(['add', 'a.txt'], dir)
  gitQuiet(['commit', '-q', '-m', 'c2'], dir)
  const c2 = gitOutput(['rev-parse', 'HEAD'], dir)
  writeFileSync(join(dir, 'a.txt'), 'three\n')
  gitQuiet(['add', 'a.txt'], dir)
  gitQuiet(['commit', '-q', '-m', 'c3'], dir)
  const c3 = gitOutput(['rev-parse', 'HEAD'], dir)
  return { dir, c1, c2, c3 }
}

test('claim-sweep.mjs self-tests pass (exercised as a real subprocess — this is the "own correctness IS CI-wired" half claim-sweep.mjs\'s header describes)', () => {
  const result = spawnSync(process.execPath, [CLAIM_SWEEP_PATH, '--self-test'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /PASSED/)
})

test('claim-sweep.mjs shallow-clone downgrade — cat-file branch: a true ancestor outside the fetched depth is reported UNKNOWN, never a false disproof, and exit stays 0', () => {
  const full = buildFullRepoV1()
  const shallowDir = mkdtempSync(join(tmpdir(), 'claim-sweep-shallow1-'))
  try {
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${full.dir}`, shallowDir], { stdio: ['ignore', 'ignore', 'ignore'] })
    assert.equal(gitOutput(['rev-parse', '--is-shallow-repository'], shallowDir), 'true')
    // c1 (the oldest commit) sits entirely outside a depth-1 clone's fetched history — not even
    // present as a git object locally. The exact "cat-file -e fails" branch.
    writeFileSync(join(shallowDir, 'claim.txt'), `claim: ${full.c1} is old\n`)
    const { status, stdout } = runClaimSweep(['--file', 'claim.txt', '--git-head', 'HEAD'], shallowDir)
    assert.equal(status, 0, 'a shallow-downgraded UNKNOWN must never escalate the exit code')
    assert.match(stdout, /UNKNOWN: shallow clone/)
    assert.doesNotMatch(stdout, /AUTO: NOT an ancestor/)
  } finally {
    rmSync(full.dir, { recursive: true, force: true })
    rmSync(shallowDir, { recursive: true, force: true })
  }
})

test('claim-sweep.mjs shallow-clone downgrade — merge-base branch: an object present locally but truncated by the shallow graft boundary is reported UNKNOWN, never a false "NOT an ancestor" disproof', () => {
  const full = buildFullRepoV1()
  const shallowDir = mkdtempSync(join(tmpdir(), 'claim-sweep-shallow2-'))
  try {
    // depth=2 fetches c3 and c2 as objects; c2 becomes the shallow-graft boundary (git's
    // `.git/shallow` records it as having no parents for traversal purposes, regardless of what
    // c2's own commit object says).
    execFileSync('git', ['clone', '-q', '--depth', '2', `file://${full.dir}`, shallowDir], { stdio: ['ignore', 'ignore', 'ignore'] })
    assert.equal(gitOutput(['rev-parse', '--is-shallow-repository'], shallowDir), 'true')
    // Explicitly fetch c1 as its own object WITHOUT connecting it through the graft boundary —
    // present locally (cat-file succeeds below) but `merge-base --is-ancestor c1 c3` still
    // returns exit 1, because traversal from c3 stops at the c2 graft and never reaches c1, even
    // though c1 truly IS a history-ancestor of c3. This is the exact bug class: the tool must not
    // trust that exit 1 as a real disproof.
    execFileSync(
      'git',
      ['fetch', '-q', '--depth=1', `file://${full.dir}`, full.c1],
      { cwd: shallowDir, stdio: ['ignore', 'ignore', 'ignore'] },
    )
    execFileSync('git', ['cat-file', '-e', `${full.c1}^{commit}`], { cwd: shallowDir, stdio: ['ignore', 'ignore', 'ignore'] }) // sanity: object IS present
    const rawMergeBase = spawnSync('git', ['merge-base', '--is-ancestor', full.c1, full.c3], { cwd: shallowDir })
    assert.equal(rawMergeBase.status, 1, 'fixture sanity: raw git must exhibit the misleading exit 1 for this test to mean anything')

    writeFileSync(join(shallowDir, 'claim.txt'), `the head is at ${full.c1} .\n`)
    const { status, stdout } = runClaimSweep(['--file', 'claim.txt', '--git-head', full.c3], shallowDir)
    assert.equal(status, 0, 'a shallow-downgraded UNKNOWN must never escalate the exit code')
    assert.match(stdout, /UNKNOWN: shallow clone/)
    assert.doesNotMatch(stdout, /AUTO: NOT an ancestor/)
  } finally {
    rmSync(full.dir, { recursive: true, force: true })
    rmSync(shallowDir, { recursive: true, force: true })
  }
})

test('claim-sweep.mjs on a FULL (non-shallow) clone: a genuinely-not-an-ancestor SHA still gets "AUTO: NOT an ancestor" and escalates the exit code (regression control — the shallow fix must not blunt the real case)', () => {
  const full = buildFullRepoV1()
  try {
    assert.equal(gitOutput(['rev-parse', '--is-shallow-repository'], full.dir), 'false')
    gitQuiet(['checkout', '-q', '-b', 'unrelated', full.c1], full.dir)
    writeFileSync(join(full.dir, 'b.txt'), 'x\n')
    gitQuiet(['add', 'b.txt'], full.dir)
    gitQuiet(['commit', '-q', '-m', 'unrelated commit'], full.dir)
    const unrelated = gitOutput(['rev-parse', 'HEAD'], full.dir)
    gitQuiet(['checkout', '-q', full.c3], full.dir)
    writeFileSync(join(full.dir, 'claim.txt'), `claim: ${unrelated} merged already\n`)
    const { status, stdout } = runClaimSweep(['--file', 'claim.txt', '--git-head', full.c3], full.dir)
    assert.equal(status, 1)
    assert.match(stdout, /AUTO: NOT an ancestor/)
  } finally {
    rmSync(full.dir, { recursive: true, force: true })
  }
})

// P3 fix (gate-2 round, CHANGES-REQUESTED, PR #4839, 20260810): a large sweep piped to another
// process (never redirected to a file) came back SILENTLY TRUNCATED — exit 0, no error, just
// missing rows off the end, because `process.exit()` used to fire immediately after the last
// `stdout.write()` without waiting for the write to actually reach the OS pipe: for a PIPE
// destination `stdout.write()` is asynchronous, and the race is on the CHILD process's own
// internal write queue versus its own synchronous `process.exit()` call — independent of how
// fast or slow the PARENT reads. Reproduced directly before fixing, through `runClaimSweep`
// (the same helper the three shallow/full-clone tests above use, and the same `spawnSync`
// primitive the self-test check above uses directly — this bug does NOT require a special
// reader shape to expose): file-redirected output for this exact fixture was 1,000,896 bytes;
// piped via `runClaimSweep` it came back as exactly 65,536 bytes (one pipe
// bufferful) — the unfixed process exited mid-flush.
const LARGE_SWEEP_LINE_COUNT = 3000
function buildLargeQuantifierFile(dir: string): string {
  const lines: string[] = []
  for (let i = 0; i < LARGE_SWEEP_LINE_COUNT; i += 1) {
    lines.push(`Line number ${String(i).padStart(6, '0')}: this configuration works for every conceivable case in the system.`)
  }
  const filePath = join(dir, 'large-claims.txt')
  writeFileSync(filePath, lines.join('\n') + '\n')
  return filePath
}

test('claim-sweep.mjs piped output is NOT truncated by process.exit racing an unflushed write (large sweep, real child-process pipe)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-sweep-pipe-trunc-'))
  try {
    const filePath = buildLargeQuantifierFile(dir)

    // Ground truth: redirect to a real file (no pipe race possible here at all).
    const outPath = join(dir, 'out.json')
    execFileSync(process.execPath, [CLAIM_SWEEP_PATH, '--file', filePath, '--format', 'json'], {
      cwd: dir,
      stdio: ['ignore', openSync(outPath, 'w'), 'ignore'],
    })
    const fileRows = JSON.parse(readFileSync(outPath, 'utf8')) as Array<{ line: number; matched: string }>
    assert.equal(fileRows.length, LARGE_SWEEP_LINE_COUNT, 'fixture sanity: one "every" match per line')

    const { status, stdout } = runClaimSweep(['--file', filePath, '--format', 'json'], dir)
    assert.equal(status, 0)
    // A truncated JSON payload fails to parse at all, or parses short — either way this is the
    // precise, mechanical assertion (not a byte-length threshold): every row must be present,
    // including the LAST one (truncation cuts the END of the output, so the tail is exactly what
    // a byte-count-only assertion could miss if it merely checked "length > some threshold").
    const pipedRows = JSON.parse(stdout) as Array<{ line: number; matched: string }>
    assert.equal(pipedRows.length, LARGE_SWEEP_LINE_COUNT)
    assert.equal(pipedRows[pipedRows.length - 1].line, LARGE_SWEEP_LINE_COUNT)
    assert.deepEqual(pipedRows, fileRows)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// P3 fix (gate-2 round, CHANGES-REQUESTED, PR #4839, 20260810): the self-test battery only
// proves SHA256_DIGEST_RE fires on a synthetic sentence in isolation — it does NOT prove `scanLine`
// actually wires that pattern into an emitted row. Deleting the `SHA256_DIGEST_RE` loop inside
// `scanLine` (leaving the pattern definition and its self-tests untouched) would leave the
// self-test battery green while the real CLI sweep below silently stopped reporting digest pins —
// exactly the pattern-vs-wiring gap this test closes, end to end through the real CLI.
test('claim-sweep.mjs CLI actually emits a sha256-digest-pin row for a real 64-char digest (pattern-to-row wiring, not just the self-test regex firing)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-sweep-digest-wiring-'))
  try {
    const digest = '88176e7e79f5f5a9017ff93675e05cbadf9589f9d1d3693f00503c05e0ea8fcf'
    writeFileSync(join(dir, 'pin.txt'), `The pin is ${digest} exactly.\n`)
    const { status, stdout } = runClaimSweep(['--file', 'pin.txt', '--format', 'json'], dir)
    assert.equal(status, 0)
    const rows = JSON.parse(stdout) as Array<{ patternType: string; matched: string; backing: string }>
    const digestRows = rows
      .filter((row) => row.patternType === 'sha256-digest-pin')
      .map((row) => ({ patternType: row.patternType, matched: row.matched, backing: row.backing }))
    assert.deepEqual(digestRows, [{ patternType: 'sha256-digest-pin', matched: digest, backing: 'NEEDS-MANUAL-BACKING' }])
    // Never routed through git ancestry — a content digest is not a commit, and this asserts it
    // directly rather than merely by absence of an AUTO:-prefixed backing string.
    assert.doesNotMatch(digestRows[0].backing, /^AUTO:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
