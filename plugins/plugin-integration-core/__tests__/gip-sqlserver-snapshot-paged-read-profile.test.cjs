'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MODULE_PATH = path.join(
  __dirname,
  '..',
  'lib',
  'gip-sqlserver-snapshot-paged-read-profile.cjs',
)
const {
  SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE,
  SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE,
  SQLSERVER_SNAPSHOT_PAGED_READ_CONNECTOR_KIND,
  SQLSERVER_SNAPSHOT_PAGED_READ_IMPLEMENTATION_VERSION,
  SQLSERVER_SNAPSHOT_PAGED_READ_ERROR_REASONS,
  SQLSERVER_SNAPSHOT_PAGED_READ_FAILURE_VOCABULARY,
  adjudicateSnapshotPagedReadCompleteness,
  sqlServerSnapshotPagedReadRecoveryStrategy,
  assertCompletenessEvidenceCertified,
} = require(MODULE_PATH)

const {
  normalizeCertifiedReadActionProfile,
  deriveRecoveryStrategy,
  validateCompletenessEvidence,
  GipProfileContractError,
} = require(path.join(
  __dirname,
  '..',
  'lib',
  'gip-profile-certification-contracts.cjs',
))
const {
  BATTERY_CHECK_IDS,
  runReadActionProfileComplianceBattery,
  summarizeBatteryForEvidence,
} = require(path.join(
  __dirname,
  '..',
  'lib',
  'gip-profile-compliance-harness.cjs',
))

function validResult(overrides = {}) {
  return {
    engineMajorVersion: '2019',
    contextState: 'COMPLETED',
    snapshotTransactionObserved: true,
    sameSessionAcrossPages: true,
    connectionLossObserved: false,
    pageCount: 3,
    appliedPageSize: 3,
    precedingFullPageCount: 2,
    terminalPageRowCount: 2,
    totalRowCount: 8,
    ...overrides,
  }
}

function expectReason(fn, reason) {
  let caught
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.equal(caught?.reason, reason)
  assert.equal(caught?.name, 'SqlServerSnapshotPagedReadError')
  return caught
}

function profileIdentityIsExactAndHonest() {
  const profile = SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE
  assert.equal(
    profile.profileId,
    'sqlserver.snapshot_paged_read.v1',
  )
  assert.equal(
    profile.actionProfileVersion,
    'sqlserver.snapshot_paged_read.v1',
  )
  assert.equal(
    profile.connectorKind,
    'data-source:sql-readonly',
  )
  assert.equal(
    SQLSERVER_SNAPSHOT_PAGED_READ_CONNECTOR_KIND,
    profile.connectorKind,
  )
  assert.equal(profile.actionId, 'snapshot_paged_read')
  assert.equal(
    profile.implementationVersion,
    'latent-contract.sqlserver-snapshot-page-sequence.v1',
  )
  assert.equal(
    SQLSERVER_SNAPSHOT_PAGED_READ_IMPLEMENTATION_VERSION,
    profile.implementationVersion,
  )

  const certificate = profile.certificate
  assert.equal(certificate.acquisitionMode, 'PAGED_READ')
  assert.deepEqual(
    [...certificate.supportedConsistencyProofs],
    ['SOURCE_SNAPSHOT_TXN'],
  )
  assert.equal(
    certificate.continuationLifetime,
    'CONNECTION_BOUND',
  )
  assert.deepEqual(
    [...certificate.supportedCompletenessProofs],
    ['SHORT_PAGE'],
  )
  assert.deepEqual(
    certificate.completenessCombinationRules.map((entry) => [
      ...entry,
    ]),
    [['SHORT_PAGE']],
  )
  assert.deepEqual(certificate.maxScale, {
    runtimeScaleCertified: false,
    adjudicationBoundedToEvidenceEnvelope: true,
    evidenceEnvelope: {
      pageSize: 3,
      pageCount: 3,
      rowCount: 8,
    },
  })
  assert.deepEqual(certificate.orderingKeyRequirement, {
    required: true,
    kind: 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER',
    qualification:
      'SEPARATE_BINDING_QUALIFICATION_REQUIRED',
  })
  assert.deepEqual(certificate.cursorShape, {
    kind: 'OFFSET_WITHIN_BOUND_TRANSACTION',
    durable: false,
    sameConnectionRequired: true,
    callerSuppliedSqlForbidden: true,
  })
  assert.deepEqual(
    [...certificate.failureVocabulary],
    [...SQLSERVER_SNAPSHOT_PAGED_READ_FAILURE_VOCABULARY],
  )
  assert.equal(
    certificate.supportedCompletenessProofs.includes(
      'DECLARED_TOTAL',
    ),
    false,
  )
  for (const omitted of ['manifestShape', 'tokenShape']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(certificate, omitted),
      false,
    )
  }
  assert.ok(Object.isFrozen(profile))
  assert.ok(Object.isFrozen(certificate))
  assert.ok(Object.isFrozen(certificate.maxScale))
  assert.ok(Object.isFrozen(certificate.maxScale.evidenceEnvelope))
  assert.ok(Object.isFrozen(certificate.orderingKeyRequirement))
  assert.ok(Object.isFrozen(certificate.cursorShape))
  assert.ok(Object.isFrozen(certificate.failureVocabulary))

  assert.equal(
    SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE
      .actionProfileVersion,
    profile.actionProfileVersion,
  )
  assert.equal(
    SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE
      .contextContract.runtimeReachable,
    false,
  )
  assert.equal(
    SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE
      .contextContract.executableInThisModule,
    false,
  )
}

function failureVocabularyIsClosedAndExercised() {
  assert.deepEqual(
    SQLSERVER_SNAPSHOT_PAGED_READ_ERROR_REASONS,
    [
      'SNAPSHOT_PAGED_READ_RESULT_INVALID',
      'SNAPSHOT_PAGED_READ_ENGINE_VERSION_UNCERTIFIED',
      'SNAPSHOT_PAGED_READ_SNAPSHOT_UNPROVEN',
      'SNAPSHOT_PAGED_READ_SESSION_DRIFT',
      'SNAPSHOT_PAGED_READ_CONNECTION_LOST',
      'SNAPSHOT_PAGED_READ_SCALE_UNCERTIFIED',
      'SNAPSHOT_PAGED_READ_EMPTY_SOURCE_UNCERTIFIED',
      'SNAPSHOT_PAGED_READ_COMPLETENESS_UNPROVABLE',
    ],
  )
  assert.deepEqual(
    SQLSERVER_SNAPSHOT_PAGED_READ_FAILURE_VOCABULARY,
    [
      'SQLSERVER_SNAPSHOT_EVIDENCE_INVALID',
      ...SQLSERVER_SNAPSHOT_PAGED_READ_ERROR_REASONS,
    ],
  )
  assert.ok(
    Object.isFrozen(
      SQLSERVER_SNAPSHOT_PAGED_READ_ERROR_REASONS,
    ),
  )
  assert.ok(
    Object.isFrozen(
      SQLSERVER_SNAPSHOT_PAGED_READ_FAILURE_VOCABULARY,
    ),
  )

  expectReason(
    () => adjudicateSnapshotPagedReadCompleteness(null),
    'SNAPSHOT_PAGED_READ_RESULT_INVALID',
  )
  expectReason(
    () =>
      adjudicateSnapshotPagedReadCompleteness(
        validResult({ engineMajorVersion: '2017' }),
      ),
    'SNAPSHOT_PAGED_READ_ENGINE_VERSION_UNCERTIFIED',
  )
  expectReason(
    () =>
      adjudicateSnapshotPagedReadCompleteness(
        validResult({ snapshotTransactionObserved: false }),
      ),
    'SNAPSHOT_PAGED_READ_SNAPSHOT_UNPROVEN',
  )
  expectReason(
    () =>
      adjudicateSnapshotPagedReadCompleteness(
        validResult({ sameSessionAcrossPages: false }),
      ),
    'SNAPSHOT_PAGED_READ_SESSION_DRIFT',
  )
  expectReason(
    () =>
      adjudicateSnapshotPagedReadCompleteness(
        validResult({ connectionLossObserved: true }),
      ),
    'SNAPSHOT_PAGED_READ_CONNECTION_LOST',
  )
  expectReason(
    () =>
      adjudicateSnapshotPagedReadCompleteness(
        validResult({
          pageCount: 2,
          appliedPageSize: 4,
          precedingFullPageCount: 1,
          terminalPageRowCount: 1,
          totalRowCount: 5,
        }),
      ),
    'SNAPSHOT_PAGED_READ_SCALE_UNCERTIFIED',
  )
  expectReason(
    () =>
      adjudicateSnapshotPagedReadCompleteness(
        validResult({
          pageCount: 4,
          appliedPageSize: 1,
          precedingFullPageCount: 3,
          terminalPageRowCount: 0,
          totalRowCount: 3,
        }),
      ),
    'SNAPSHOT_PAGED_READ_SCALE_UNCERTIFIED',
  )
  expectReason(
    () =>
      adjudicateSnapshotPagedReadCompleteness(
        validResult({
          pageCount: 1,
          precedingFullPageCount: 0,
          terminalPageRowCount: 0,
          totalRowCount: 0,
        }),
      ),
    'SNAPSHOT_PAGED_READ_EMPTY_SOURCE_UNCERTIFIED',
  )
  expectReason(
    () =>
      adjudicateSnapshotPagedReadCompleteness(
        validResult({
          pageCount: 2,
          precedingFullPageCount: 1,
          terminalPageRowCount: 3,
          totalRowCount: 6,
        }),
      ),
    'SNAPSHOT_PAGED_READ_COMPLETENESS_UNPROVABLE',
  )
}

function complianceBatteryAndCombinationGuards() {
  const {
    actionProfileVersion: _emittedVersion,
    ...candidate
  } = SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE
  const report = runReadActionProfileComplianceBattery(candidate)
  assert.equal(report.passed, true)
  assert.equal(report.checks.length, BATTERY_CHECK_IDS.length)
  for (const check of report.checks) {
    assert.equal(
      check.ok,
      true,
      `${check.checkId} failed with ${check.observed}`,
    )
  }
  assert.deepEqual(summarizeBatteryForEvidence(report), {
    passed: true,
    checkCount: BATTERY_CHECK_IDS.length,
    failedCheckIds: [],
  })

  const illegal = JSON.parse(JSON.stringify(candidate))
  illegal.certificate.supportedConsistencyProofs = [
    'MONOTONIC_VERSION_PIN',
  ]
  illegal.certificate.continuationLifetime = 'DURABLE_TOKEN'
  let illegalError
  try {
    normalizeCertifiedReadActionProfile(illegal)
  } catch (error) {
    illegalError = error
  }
  assert.ok(illegalError instanceof GipProfileContractError)
  assert.equal(
    illegalError.reason,
    'ILLEGAL_CAPABILITY_COMBINATION',
  )

  // Negative control: PAGED_READ's closed table must not accidentally
  // invalidate the ratified CHANGE_FEED watermark combination.
  const changeFeed = JSON.parse(JSON.stringify(candidate))
  changeFeed.profileId = 'sqlserver.change_feed.v1'
  changeFeed.actionId = 'change_feed'
  changeFeed.certificate.acquisitionMode = 'CHANGE_FEED'
  changeFeed.certificate.supportedConsistencyProofs = [
    'MONOTONIC_VERSION_PIN',
  ]
  changeFeed.certificate.continuationLifetime = 'DURABLE_TOKEN'
  const normalizedChangeFeed =
    normalizeCertifiedReadActionProfile(changeFeed)
  assert.equal(
    normalizedChangeFeed.certificate.acquisitionMode,
    'CHANGE_FEED',
  )
}

function shortPageAdjudicationIsFailClosed() {
  const evidence2019 =
    adjudicateSnapshotPagedReadCompleteness(validResult())
  const evidence2022 =
    adjudicateSnapshotPagedReadCompleteness(
      validResult({ engineMajorVersion: '2022' }),
    )
  assert.deepEqual(evidence2019, {
    runOutcome: 'successful',
    usedCompletenessProofs: ['SHORT_PAGE'],
  })
  assert.deepEqual(evidence2022, evidence2019)
  assert.equal(
    assertCompletenessEvidenceCertified(evidence2019).runOutcome,
    'successful',
  )
  assert.equal(
    validateCompletenessEvidence(
      SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE,
      evidence2019,
    ).runOutcome,
    'successful',
  )

  // One non-empty short page is complete under the same rule.
  assert.deepEqual(
    adjudicateSnapshotPagedReadCompleteness(
      validResult({
        pageCount: 1,
        precedingFullPageCount: 0,
        terminalPageRowCount: 2,
        totalRowCount: 2,
      }),
    ),
    evidence2019,
  )

  // Exact page multiples become provable only after reading the next empty
  // terminal page inside the same snapshot.
  assert.deepEqual(
    adjudicateSnapshotPagedReadCompleteness(
      validResult({
        pageCount: 3,
        precedingFullPageCount: 2,
        terminalPageRowCount: 0,
        totalRowCount: 6,
      }),
    ),
    evidence2019,
  )

  for (const malformed of [
    validResult({ contextState: 'READING' }),
    validResult({ pageCount: 0 }),
    validResult({ appliedPageSize: 0 }),
    validResult({ terminalPageRowCount: 4 }),
    validResult({ totalRowCount: 9 }),
    validResult({ precedingFullPageCount: -1 }),
    validResult({ pageCount: 1.5 }),
    { ...validResult(), adapterDone: true },
  ]) {
    expectReason(
      () => adjudicateSnapshotPagedReadCompleteness(malformed),
      malformed.contextState === 'READING'
        ? 'SNAPSHOT_PAGED_READ_SNAPSHOT_UNPROVEN'
        : 'SNAPSHOT_PAGED_READ_RESULT_INVALID',
    )
  }

  const hostileMarker = 'attacker-schema-column-secret'
  const leaked = expectReason(
    () =>
      adjudicateSnapshotPagedReadCompleteness({
        ...validResult(),
        [hostileMarker]: hostileMarker,
      }),
    'SNAPSHOT_PAGED_READ_RESULT_INVALID',
  )
  assert.equal(leaked.message.includes(hostileMarker), false)
  assert.equal(JSON.stringify(leaked).includes(hostileMarker), false)

  const hostileProxy = new Proxy(validResult(), {
    ownKeys() {
      throw new Error(hostileMarker)
    },
  })
  const proxyError = expectReason(
    () =>
      adjudicateSnapshotPagedReadCompleteness(hostileProxy),
    'SNAPSHOT_PAGED_READ_RESULT_INVALID',
  )
  assert.equal(proxyError.message.includes(hostileMarker), false)

  for (const uncertified of [
    {
      runOutcome: 'successful',
      usedCompletenessProofs: ['DECLARED_TOTAL'],
    },
    {
      runOutcome: 'successful',
      usedCompletenessProofs: [
        'SHORT_PAGE',
        'DECLARED_TOTAL',
      ],
    },
    {
      runOutcome: 'successful',
      usedCompletenessProofs: [],
    },
  ]) {
    let caught
    try {
      assertCompletenessEvidenceCertified(uncertified)
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof GipProfileContractError)
    assert.equal(caught.reason, 'COMPLETENESS_EVIDENCE_INVALID')
  }
}

function recoveryIsDerived() {
  assert.equal(
    sqlServerSnapshotPagedReadRecoveryStrategy(),
    'WHOLE_ROUND_RESTART',
  )
  assert.equal(
    deriveRecoveryStrategy(
      SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE.certificate,
    ),
    'WHOLE_ROUND_RESTART',
  )
}

function profileHasNoStaticRuntimeConsumer() {
  const workspace = path.resolve(__dirname, '..', '..', '..')
  const moduleToken =
    'gip-sqlserver-snapshot-paged-read-profile'
  const consumers = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, {
      withFileTypes: true,
    })) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue
      }
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'tests') {
          continue
        }
        walk(absolute)
        continue
      }
      if (
        !/\.(?:cjs|mjs|js|ts)$/.test(entry.name) ||
        absolute === MODULE_PATH
      ) {
        continue
      }
      if (fs.readFileSync(absolute, 'utf8').includes(moduleToken)) {
        consumers.push(path.relative(workspace, absolute))
      }
    }
  }
  for (const root of [
    'apps',
    'packages',
    'plugins',
    'scripts',
    'tools',
    'ops',
  ]) {
    const absolute = path.join(workspace, root)
    if (fs.existsSync(absolute)) walk(absolute)
  }
  for (const entry of fs.readdirSync(workspace, {
    withFileTypes: true,
  })) {
    if (
      entry.isFile() &&
      /\.(?:cjs|mjs|js|ts)$/.test(entry.name)
    ) {
      const absolute = path.join(workspace, entry.name)
      if (fs.readFileSync(absolute, 'utf8').includes(moduleToken)) {
        consumers.push(entry.name)
      }
    }
  }
  assert.deepEqual(
    consumers,
    [
      'plugins/plugin-integration-core/lib/gip-sqlserver-snapshot-page-sequence-executor.cjs',
    ],
    'the SQL Server snapshot profile must have exactly one latent executor consumer',
  )
}

function packageTestChainIncludesBothSuites() {
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', 'package.json'),
      'utf8',
    ),
  )
  const strategyCommand =
    'node __tests__/gip-sqlserver-snapshot-page-sequence-strategy.test.cjs'
  const profileCommand =
    'node __tests__/gip-sqlserver-snapshot-paged-read-profile.test.cjs'
  const executorCommand =
    'node __tests__/gip-sqlserver-snapshot-page-sequence-executor.test.cjs'
  // Chain source is `test-chain.txt` (moved out of the digest-pinned package.json); the commands
  // and their order are unchanged, so the contiguity assertion below still means what it did.
  const mainChain = require(
    path.join(__dirname, '..', 'scripts', 'test-chain.cjs'),
  ).loadChain(path.join(__dirname, '..'))

  const strategyIndex = mainChain.indexOf(strategyCommand)
  assert.notEqual(strategyIndex, -1)
  assert.deepEqual(mainChain.slice(strategyIndex, strategyIndex + 3), [
    strategyCommand,
    profileCommand,
    executorCommand,
  ])
  for (const command of [strategyCommand, profileCommand, executorCommand]) {
    assert.equal(
      mainChain.filter((entry) => entry === command).length,
      1,
      `${command} must occur exactly once in the explicit test chain`,
    )
  }
  assert.equal(
    packageJson.scripts[
      'test:gip-sqlserver-snapshot-page-sequence-strategy'
    ],
    strategyCommand,
  )
  assert.equal(
    packageJson.scripts[
      'test:gip-sqlserver-snapshot-paged-read-profile'
    ],
    profileCommand,
  )
  assert.equal(
    packageJson.scripts[
      'test:gip-sqlserver-snapshot-page-sequence-executor'
    ],
    executorCommand,
  )
}

function main() {
  profileIdentityIsExactAndHonest()
  failureVocabularyIsClosedAndExercised()
  complianceBatteryAndCombinationGuards()
  shortPageAdjudicationIsFailClosed()
  recoveryIsDerived()
  profileHasNoStaticRuntimeConsumer()
  packageTestChainIncludesBothSuites()
  console.log(
    'gip-sqlserver-snapshot-paged-read-profile.test.cjs OK',
  )
}

main()
