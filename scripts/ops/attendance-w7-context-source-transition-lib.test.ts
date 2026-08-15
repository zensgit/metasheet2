/**
 * W7-3 (#4556) operator tooling — pure unit gate for
 * `attendance-w7-context-source-transition-lib.ts`.
 *
 * Runs under `tsx --test` (node:test), like its W4C-5 sibling, and is wired
 * into plugin-tests.yml with an EXACT subtest count: `node --test` treats a
 * child that exits 0 as a PASSING FILE, so a collection-time abort before any
 * subtest body runs would otherwise silently collapse this into a green
 * zero-test file.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ATTENDANCE_W7_APPLY_ARG_FIELDS_V1,
  ATTENDANCE_W7_CONFIRMATION_TOKEN_V1,
  ATTENDANCE_W7_EXIT_ARGS_INVALID_V1,
  ATTENDANCE_W7_EXIT_BLOCKED_V1,
  ATTENDANCE_W7_EXIT_FAILED_V1,
  ATTENDANCE_W7_EXIT_MANIFEST_INVALID_V1,
  ATTENDANCE_W7_EXIT_PLAN_STALE_V1,
  ATTENDANCE_W7_MANIFEST_FRESHNESS_MS_V1,
  canonicalJsonV1,
  computeAttendanceW7PlanDigestV1,
  exitCodeForAttendanceW7ErrorV1,
  isGroupArmEntryPairV1,
  isResumePairV1,
  parseAttendanceW7ApplyArgsV1,
  parseAttendanceW7PlanArgsV1,
  runAttendanceW7ApplyOrchestrationV1,
  validateAttendanceW7ManifestV1,
} from './attendance-w7-context-source-transition-lib'

const ORG = '3f9a1c2e-0000-4000-8000-000000000001'
const OTHER_ORG = '3f9a1c2e-0000-4000-8000-000000000002'
const CORRELATION = '3f9a1c2e-0000-4000-8000-0000000000aa'
const NOW = Date.parse('2026-08-15T12:00:00.000Z')

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    collectedAt: new Date(NOW - 60_000).toISOString(),
    orgId: ORG,
    targetState: 'group_shadow',
    imageSha: 'sha256:aaaa',
    pendingMigrations: 0,
    serviceHealthy: true,
    customerData: false,
    externalNotificationsDisabled: true,
    externalDestinationCount: 0,
    ownerAuthorizationRef: 'owner-ref-1',
    syntheticOrgRef: 'synthetic-org-1',
    groupProducerAttestationRef: 'producer-attestation-1',
    ...overrides,
  }
}

const CONTEXT = { orgId: ORG, expectedState: 'off', targetState: 'group_shadow' } as const

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? `<no code: ${String(error)}>`
}

function expectToolCode(fn: () => unknown, expected: string, label: string): void {
  try {
    fn()
  } catch (error) {
    assert.equal(codeOf(error), expected, label)
    return
  }
  assert.fail(`${label}: expected ${expected}, but nothing was thrown`)
}

function applyArgv(overrides: Record<string, string> = {}): string[] {
  const flags: Record<string, string> = {
    org: ORG,
    target: 'group_shadow',
    'expected-state': 'off',
    'expected-version': '1',
    'plan-digest': 'a'.repeat(64),
    confirm: ATTENDANCE_W7_CONFIRMATION_TOKEN_V1,
    manifest: '/tmp/manifest.json',
    'actor-id': 'operator-1',
    'correlation-id': CORRELATION,
    'engine-version': 'w7-engine-1',
    ...overrides,
  }
  return Object.entries(flags).flatMap(([name, value]) => [`--${name}`, value])
}

// ---------------------------------------------------------------------------

test('pair classifiers: resume is exactly suspended -> group_authoritative', () => {
  assert.equal(isResumePairV1('suspended', 'group_authoritative'), true)
  assert.equal(isResumePairV1('group_authoritative', 'suspended'), false)
  assert.equal(isResumePairV1('off', 'group_shadow'), false)
})

test('pair classifiers: the group arm is every target except the two exits', () => {
  for (const to of ['group_shadow', 'group_eligible', 'group_authoritative'] as const) {
    assert.equal(isGroupArmEntryPairV1('off', to), true, to)
  }
  assert.equal(isGroupArmEntryPairV1('group_shadow', 'off'), false)
  assert.equal(isGroupArmEntryPairV1('group_authoritative', 'suspended'), false)
})

test('canonical JSON sorts object keys recursively and preserves array order', () => {
  assert.equal(canonicalJsonV1({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
  assert.equal(canonicalJsonV1({ list: [3, 1, 2] }), '{"list":[3,1,2]}')
})

test('manifest: the happy path yields a hex64 hash and the three base references', () => {
  const validated = validateAttendanceW7ManifestV1(baseManifest(), CONTEXT, NOW)
  assert.match(validated.evidenceManifestSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(Object.keys(validated.evidenceReferences).sort(), [
    'imageSha',
    'ownerAuthorizationRef',
    'syntheticOrgRef',
  ])
})

test('manifest: an EXTRA key is refused', () => {
  expectToolCode(
    () => validateAttendanceW7ManifestV1(baseManifest({ extra: 1 }), CONTEXT, NOW),
    'W7_TOOL_MANIFEST_INVALID',
    'extra key',
  )
})

test('manifest: a MISSING key is refused', () => {
  const manifest = baseManifest()
  delete manifest.syntheticOrgRef
  expectToolCode(
    () => validateAttendanceW7ManifestV1(manifest, CONTEXT, NOW),
    'W7_TOOL_MANIFEST_INVALID',
    'missing key',
  )
})

test('manifest: the group-arm attestation is required for a group target and REFUSED for an exit', () => {
  const withoutAttestation = baseManifest()
  delete withoutAttestation.groupProducerAttestationRef
  expectToolCode(
    () => validateAttendanceW7ManifestV1(withoutAttestation, CONTEXT, NOW),
    'W7_TOOL_MANIFEST_INVALID',
    'group target without attestation',
  )
  // ...and the key set is pair-dependent in the other direction too: an exit
  // pair carrying the group key is refused, so the widening is not one-sided.
  expectToolCode(
    () =>
      validateAttendanceW7ManifestV1(
        baseManifest({ targetState: 'off' }),
        { orgId: ORG, expectedState: 'group_shadow', targetState: 'off' },
        NOW,
      ),
    'W7_TOOL_MANIFEST_INVALID',
    'exit pair with the group key',
  )
})

test('manifest: the resume pair demands the two extra refs, and a non-resume pair refuses them', () => {
  const resumeContext = {
    orgId: ORG,
    expectedState: 'suspended',
    targetState: 'group_authoritative',
  } as const
  const resumeManifest = baseManifest({
    targetState: 'group_authoritative',
    ownerIncidentReviewRef: 'incident-1',
    offlineReplayArtifactRef: 'replay-1',
  })
  const validated = validateAttendanceW7ManifestV1(resumeManifest, resumeContext, NOW)
  assert.deepEqual(Object.keys(validated.evidenceReferences).sort(), [
    'imageSha',
    'offlineReplayArtifactRef',
    'ownerAuthorizationRef',
    'ownerIncidentReviewRef',
    'syntheticOrgRef',
  ])

  const withoutResumeKeys = baseManifest({ targetState: 'group_authoritative' })
  expectToolCode(
    () => validateAttendanceW7ManifestV1(withoutResumeKeys, resumeContext, NOW),
    'W7_TOOL_MANIFEST_INVALID',
    'resume without the widened keys',
  )
  expectToolCode(
    () => validateAttendanceW7ManifestV1(resumeManifest, CONTEXT, NOW),
    'W7_TOOL_MANIFEST_INVALID',
    'non-resume pair carrying the widened keys',
  )
})

test('manifest: each of the five environment attestations is LITERAL-pinned, one at a time', () => {
  // One field per iteration, each against an otherwise-valid manifest: a
  // conjunction mutated wholesale could pass on a single surviving check.
  const wrong: Array<[string, unknown]> = [
    ['pendingMigrations', 1],
    ['pendingMigrations', '0'],
    ['serviceHealthy', false],
    ['serviceHealthy', 'true'],
    ['customerData', true],
    ['customerData', 0],
    ['externalNotificationsDisabled', false],
    ['externalDestinationCount', 1],
    ['externalDestinationCount', '0'],
  ]
  for (const [key, value] of wrong) {
    expectToolCode(
      () => validateAttendanceW7ManifestV1(baseManifest({ [key]: value }), CONTEXT, NOW),
      'W7_TOOL_MANIFEST_INVALID',
      `${key}=${JSON.stringify(value)}`,
    )
  }
  // POSITIVE CONTROL: the exact literals pass, so the loop above is not
  // rejecting everything.
  assert.match(
    validateAttendanceW7ManifestV1(baseManifest(), CONTEXT, NOW).evidenceManifestSha256,
    /^[0-9a-f]{64}$/,
  )
})

test('manifest: freshness is evaluated against the INJECTED nowMs, in both directions', () => {
  const stale = baseManifest({
    collectedAt: new Date(NOW - ATTENDANCE_W7_MANIFEST_FRESHNESS_MS_V1 - 1000).toISOString(),
  })
  expectToolCode(
    () => validateAttendanceW7ManifestV1(stale, CONTEXT, NOW),
    'W7_TOOL_MANIFEST_STALE',
    'too old',
  )
  const future = baseManifest({ collectedAt: new Date(NOW + 10 * 60_000).toISOString() })
  expectToolCode(
    () => validateAttendanceW7ManifestV1(future, CONTEXT, NOW),
    'W7_TOOL_MANIFEST_STALE',
    'implausibly future-dated',
  )
  // POSITIVE CONTROL: the same stale manifest is ACCEPTED when `nowMs` is moved
  // back — proving the check reads the injected clock and not a real one.
  assert.ok(
    validateAttendanceW7ManifestV1(stale, CONTEXT, Date.parse(stale.collectedAt as string) + 1000)
      .evidenceManifestSha256,
  )
})

test('manifest: org and target must match the CLI claim, each with its own code', () => {
  expectToolCode(
    () => validateAttendanceW7ManifestV1(baseManifest({ orgId: OTHER_ORG }), CONTEXT, NOW),
    'W7_TOOL_MANIFEST_ORG_MISMATCH',
    'org mismatch',
  )
  expectToolCode(
    () =>
      validateAttendanceW7ManifestV1(
        baseManifest({ targetState: 'group_eligible' }),
        CONTEXT,
        NOW,
      ),
    'W7_TOOL_MANIFEST_TARGET_MISMATCH',
    'target mismatch',
  )
})

test('args: plan requires an explicit org and target', () => {
  assert.deepEqual(parseAttendanceW7PlanArgsV1(['--org', ORG, '--target', 'group_shadow']), {
    orgId: ORG,
    targetState: 'group_shadow',
  })
  expectToolCode(
    () => parseAttendanceW7PlanArgsV1(['--target', 'group_shadow']),
    'W7_TOOL_ARGS_INVALID',
    'missing org',
  )
  expectToolCode(
    () => parseAttendanceW7PlanArgsV1(['--org', ORG]),
    'W7_TOOL_ARGS_INVALID',
    'missing target',
  )
  expectToolCode(
    () => parseAttendanceW7PlanArgsV1(['--org', ORG, '--target', 'shadow']),
    'W7_TOOL_ARGS_INVALID',
    'a W4 state name is not a W7 state',
  )
})

test('args: apply has EXACTLY ten fields and no force/ready/skip/override flag exists', () => {
  const parsed = parseAttendanceW7ApplyArgsV1(applyArgv())
  assert.equal(Object.keys(parsed).length, 10)
  assert.deepEqual(Object.keys(parsed).sort(), [...ATTENDANCE_W7_APPLY_ARG_FIELDS_V1].sort())
  // The ABSENCE is the discipline, asserted as an enumerable property.
  for (const banned of ['force', 'ready', 'skipPredicate', 'override', 'yes']) {
    assert.equal(ATTENDANCE_W7_APPLY_ARG_FIELDS_V1.includes(banned), false, banned)
  }
})

test('args: the confirmation token is an EXACT string, not a boolean or a prefix', () => {
  for (const bad of [
    undefined,
    'true',
    'yes',
    ATTENDANCE_W7_CONFIRMATION_TOKEN_V1.slice(0, -1),
    `${ATTENDANCE_W7_CONFIRMATION_TOKEN_V1}X`,
    ATTENDANCE_W7_CONFIRMATION_TOKEN_V1.toLowerCase(),
  ]) {
    const argv = bad === undefined ? applyArgv() : applyArgv({ confirm: bad })
    if (bad === undefined) {
      const withoutConfirm = argv.filter(
        (entry, index) =>
          entry !== '--confirm' && argv[index - 1] !== '--confirm',
      )
      expectToolCode(
        () => parseAttendanceW7ApplyArgsV1(withoutConfirm),
        'W7_TOOL_CONFIRMATION_REQUIRED',
        'missing confirm',
      )
      continue
    }
    expectToolCode(
      () => parseAttendanceW7ApplyArgsV1(argv),
      'W7_TOOL_CONFIRMATION_REQUIRED',
      `confirm=${bad}`,
    )
  }
})

test('args: expected-version must be a positive safe integer', () => {
  for (const bad of ['0', '-1', '1.5', 'x', '']) {
    expectToolCode(
      () => parseAttendanceW7ApplyArgsV1(applyArgv({ 'expected-version': bad })),
      'W7_TOOL_ARGS_INVALID',
      `expected-version=${bad}`,
    )
  }
})

test('args: plan-digest must be lower-case hex64', () => {
  for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'not-a-digest']) {
    expectToolCode(
      () => parseAttendanceW7ApplyArgsV1(applyArgv({ 'plan-digest': bad })),
      'W7_TOOL_ARGS_INVALID',
      `plan-digest=${bad.slice(0, 8)}`,
    )
  }
})

// ---------------------------------------------------------------------------

function fakePlan(overrides: Record<string, unknown> = {}): never {
  return {
    orgId: ORG,
    orgAllowlisted: true,
    rowExists: true,
    currentState: 'off',
    currentVersion: 1,
    priorState: null,
    targetState: 'group_shadow',
    legalPair: true,
    ladderRole: 'advance',
    canBootstrap: false,
    blocked: false,
    predicates: [
      { code: 'ORG_ALLOWLISTED', applicable: true, pass: true, count: null },
      { code: 'LEGAL_TRANSITION_PAIR', applicable: true, pass: true, count: null },
    ],
    ...overrides,
  } as never
}

test('plan digest: stable across recomputation, and sensitive to EVERY top-level field', () => {
  const plan = fakePlan()
  const base = computeAttendanceW7PlanDigestV1(plan)
  assert.equal(computeAttendanceW7PlanDigestV1(fakePlan()), base, 'digest is not deterministic')

  // Per-field sweep: change one field at a time and require the digest to move.
  // A field the digest forgot would silently keep the digest equal.
  const mutations: Array<[string, unknown]> = [
    ['orgId', OTHER_ORG],
    ['orgAllowlisted', false],
    ['rowExists', false],
    ['currentState', 'group_shadow'],
    ['currentVersion', 2],
    ['priorState', 'off'],
    ['targetState', 'group_eligible'],
    ['legalPair', false],
    ['ladderRole', 'rollback'],
    ['canBootstrap', true],
    ['blocked', true],
  ]
  for (const [field, value] of mutations) {
    assert.notEqual(
      computeAttendanceW7PlanDigestV1(fakePlan({ [field]: value })),
      base,
      `digest ignores ${field}`,
    )
  }
})

test('plan digest: sensitive to every predicate sub-field', () => {
  const base = computeAttendanceW7PlanDigestV1(fakePlan())
  const subFieldMutations: Array<Record<string, unknown>> = [
    { code: 'CONTEXT_SOURCE_ROW_RESOLVABLE' },
    { applicable: false },
    { pass: false },
    { count: 3 },
  ]
  for (const patch of subFieldMutations) {
    const mutated = fakePlan({
      predicates: [
        { code: 'ORG_ALLOWLISTED', applicable: true, pass: true, count: null, ...patch },
        { code: 'LEGAL_TRANSITION_PAIR', applicable: true, pass: true, count: null },
      ],
    })
    assert.notEqual(
      computeAttendanceW7PlanDigestV1(mutated),
      base,
      `digest ignores predicate ${Object.keys(patch)[0]}`,
    )
  }
})

test('apply: idempotency short-circuits BEFORE the digest comparison', async () => {
  let transitionCalls = 0
  const outcome = await runAttendanceW7ApplyOrchestrationV1(
    {
      plan: async () =>
        fakePlan({ currentState: 'group_shadow', currentVersion: 2, priorState: 'off' }),
      transition: async () => {
        transitionCalls += 1
        return { orgId: ORG, state: 'group_shadow', priorState: 'off', version: 2 } as never
      },
    },
    // A DELIBERATELY WRONG digest: if the digest check ran first this would
    // throw, so the assertion below proves the ORDER, not just the outcome.
    parseAttendanceW7ApplyArgsV1(applyArgv({ 'plan-digest': 'f'.repeat(64) })),
    { evidenceManifestSha256: 'b'.repeat(64), evidenceReferences: {} as never },
  )
  assert.equal(outcome.outcome, 'noop_already_at_target')
  assert.equal(transitionCalls, 0, 'the no-op path must not call the boundary')
})

test('apply: the idempotency priorState conjunct is load-bearing', async () => {
  // Same state and version, but the row transitioned from something ELSE — the
  // caller's belief about the pair is wrong, so this must NOT be treated as a
  // no-op. Without the priorState conjunct it would be.
  let transitionCalls = 0
  await assert.rejects(
    runAttendanceW7ApplyOrchestrationV1(
      {
        plan: async () =>
          fakePlan({
            currentState: 'group_shadow',
            currentVersion: 2,
            priorState: 'group_eligible',
          }),
        transition: async () => {
          transitionCalls += 1
          return { orgId: ORG, state: 'group_shadow', priorState: 'off', version: 2 } as never
        },
      },
      parseAttendanceW7ApplyArgsV1(applyArgv({ 'plan-digest': 'f'.repeat(64) })),
      { evidenceManifestSha256: 'b'.repeat(64), evidenceReferences: {} as never },
    ),
    (error: unknown) => codeOf(error) === 'W7_TOOL_PLAN_DIGEST_MISMATCH',
  )
  assert.equal(transitionCalls, 0)
})

test('apply: a stale plan digest refuses BEFORE the boundary is called', async () => {
  let transitionCalls = 0
  await assert.rejects(
    runAttendanceW7ApplyOrchestrationV1(
      {
        plan: async () => fakePlan(),
        transition: async () => {
          transitionCalls += 1
          return { orgId: ORG, state: 'group_shadow', priorState: 'off', version: 2 } as never
        },
      },
      parseAttendanceW7ApplyArgsV1(applyArgv({ 'plan-digest': 'f'.repeat(64) })),
      { evidenceManifestSha256: 'b'.repeat(64), evidenceReferences: {} as never },
    ),
    (error: unknown) => codeOf(error) === 'W7_TOOL_PLAN_DIGEST_MISMATCH',
  )
  assert.equal(transitionCalls, 0, 'a stale digest must not reach the boundary')
})

test('apply: with a matching digest the boundary IS called, with the manifest-derived evidence', async () => {
  const seen: Array<Record<string, unknown>> = []
  const digest = computeAttendanceW7PlanDigestV1(fakePlan())
  const references = { imageSha: 'sha256:aaaa' } as never
  const outcome = await runAttendanceW7ApplyOrchestrationV1(
    {
      plan: async () => fakePlan(),
      transition: async (input) => {
        seen.push(input as unknown as Record<string, unknown>)
        return { orgId: ORG, state: 'group_shadow', priorState: 'off', version: 2 } as never
      },
    },
    parseAttendanceW7ApplyArgsV1(applyArgv({ 'plan-digest': digest })),
    { evidenceManifestSha256: 'b'.repeat(64), evidenceReferences: references },
  )
  assert.equal(outcome.outcome, 'transitioned')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].reasonCode, 'context_source_transition')
  assert.equal(seen[0].evidenceManifestSha256, 'b'.repeat(64))
  assert.equal(seen[0].evidenceReferences, references)
  // The caller's own args reach the boundary verbatim — nothing is defaulted.
  assert.equal(seen[0].expectedState, 'off')
  assert.equal(seen[0].expectedVersion, 1)
  assert.equal(seen[0].correlationId, CORRELATION)
})

test('apply: a boundary refusal propagates UNCHANGED, never re-classified', async () => {
  class BoundaryError extends Error {
    readonly code = 'W7_CONTEXT_SOURCE_TRANSITION_STATE_PRODUCER_NOT_DELIVERED'
  }
  const digest = computeAttendanceW7PlanDigestV1(fakePlan())
  await assert.rejects(
    runAttendanceW7ApplyOrchestrationV1(
      {
        plan: async () => fakePlan(),
        transition: async () => {
          throw new BoundaryError()
        },
      },
      parseAttendanceW7ApplyArgsV1(applyArgv({ 'plan-digest': digest })),
      { evidenceManifestSha256: 'b'.repeat(64), evidenceReferences: {} as never },
    ),
    (error: unknown) =>
      codeOf(error) === 'W7_CONTEXT_SOURCE_TRANSITION_STATE_PRODUCER_NOT_DELIVERED',
  )
})

test('exit ladder: closed, with boundary refusals mapped to BLOCKED and unknowns to FAILED', () => {
  const cases: Array<[string, number]> = [
    ['W7_TOOL_ARGS_INVALID', ATTENDANCE_W7_EXIT_ARGS_INVALID_V1],
    ['W7_TOOL_CONFIRMATION_REQUIRED', ATTENDANCE_W7_EXIT_ARGS_INVALID_V1],
    ['W7_TOOL_MANIFEST_INVALID', ATTENDANCE_W7_EXIT_MANIFEST_INVALID_V1],
    ['W7_TOOL_MANIFEST_STALE', ATTENDANCE_W7_EXIT_MANIFEST_INVALID_V1],
    ['W7_TOOL_MANIFEST_ORG_MISMATCH', ATTENDANCE_W7_EXIT_MANIFEST_INVALID_V1],
    ['W7_TOOL_MANIFEST_TARGET_MISMATCH', ATTENDANCE_W7_EXIT_MANIFEST_INVALID_V1],
    ['W7_TOOL_PLAN_DIGEST_MISMATCH', ATTENDANCE_W7_EXIT_PLAN_STALE_V1],
    ['W7_CONTEXT_SOURCE_TRANSITION_ILLEGAL_TRANSITION', ATTENDANCE_W7_EXIT_BLOCKED_V1],
    ['W7_CONTEXT_SOURCE_TRANSITION_ORG_NOT_ALLOWLISTED', ATTENDANCE_W7_EXIT_BLOCKED_V1],
    ['SOMETHING_ELSE_ENTIRELY', ATTENDANCE_W7_EXIT_FAILED_V1],
  ]
  for (const [code, expected] of cases) {
    assert.equal(exitCodeForAttendanceW7ErrorV1({ code }), expected, code)
  }
  // A non-Error, code-less throw must NEVER map to success.
  assert.equal(exitCodeForAttendanceW7ErrorV1('boom'), ATTENDANCE_W7_EXIT_FAILED_V1)
  assert.equal(exitCodeForAttendanceW7ErrorV1(undefined), ATTENDANCE_W7_EXIT_FAILED_V1)
  // ...and no mapped code is 0.
  for (const [, expected] of cases) assert.notEqual(expected, 0)
})

test('the CLI source declares no force/ready/skip/override flag anywhere', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const file of [
    'attendance-w7-context-source-transition.ts',
    'attendance-w7-context-source-transition-lib.ts',
  ]) {
    const source = await readFile(path.join(here, file), 'utf8')
    // ANCHOR CHECK first: the file really was read and really is part of this
    // tool. Without it, a wrong path (or an empty read) would satisfy every
    // "does not contain" assertion below vacuously.
    assert.ok(
      source.includes('runAttendanceW7ApplyOrchestrationV1'),
      `${file}: wrong or empty file read`,
    )
    for (const banned of ["'--force'", "'--ready'", "'--skip-predicate'", "'--override'", "'--yes'"]) {
      assert.equal(source.includes(banned), false, `${file} declares ${banned}`)
    }
  }
})
