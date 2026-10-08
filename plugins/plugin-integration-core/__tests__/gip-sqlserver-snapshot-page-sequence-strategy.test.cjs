'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MODULE_PATH = path.join(
  __dirname,
  '..',
  'lib',
  'gip-sqlserver-snapshot-page-sequence-strategy.cjs',
)
const {
  SQLSERVER_SNAPSHOT_ACTION_PROFILE_VERSION,
  SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE,
  SQLSERVER_SNAPSHOT_STRATEGY_ERROR_REASONS,
  resolveCertifiedSqlServerSnapshotPageSequenceStrategy,
  isCertifiedSqlServerSnapshotPageSequenceStrategy,
} = require(MODULE_PATH)

const PROFILE = 'sqlserver.snapshot_paged_read.v1'
const STRATEGY =
  resolveCertifiedSqlServerSnapshotPageSequenceStrategy(PROFILE)

function recordSha256(record) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(record, null, 2))
    .digest('hex')
}

function certificatePinsOpeningEvidence() {
  const certificate =
    SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE
  assert.equal(
    SQLSERVER_SNAPSHOT_ACTION_PROFILE_VERSION,
    PROFILE,
  )
  assert.deepEqual(SQLSERVER_SNAPSHOT_STRATEGY_ERROR_REASONS, [
    'SQLSERVER_SNAPSHOT_EVIDENCE_INVALID',
  ])
  assert.deepEqual(Object.keys(certificate), [
    'actionProfileVersion',
    'strategyId',
    'strategyVersion',
    'dialect',
    'capabilityPosture',
    'supportedEngineMajorVersions',
    'snapshotSemantics',
    'contextContract',
    'evidence',
  ])
  assert.equal(certificate.actionProfileVersion, PROFILE)
  assert.equal(
    certificate.strategyId,
    'gip.page_sequence.sqlserver_snapshot',
  )
  assert.equal(certificate.strategyVersion, 'v1')
  assert.equal(certificate.dialect, 'sqlserver')
  assert.equal(
    certificate.capabilityPosture,
    'explicit_snapshot_transaction',
  )
  assert.deepEqual(
    [...certificate.supportedEngineMajorVersions],
    ['2019', '2022'],
  )
  assert.equal(
    certificate.snapshotSemantics,
    'explicit_snapshot_transaction_connection_bound',
  )
  assert.deepEqual(certificate.contextContract, {
    lifecycle: ['OPEN', 'READING', 'COMPLETED', 'ABORTED'],
    transactionBoundary: 'ONE_EXPLICIT_SNAPSHOT_TRANSACTION',
    connectionAffinity: 'ONE_CONNECTION_PER_PAGE_SEQUENCE',
    continuation: 'OFFSET_WITHIN_BOUND_TRANSACTION',
    orderingRequirement: 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER',
    connectionLossPolicy: 'ABORT_NO_RESNAPSHOT',
    recoveryStrategy: 'WHOLE_ROUND_RESTART',
    executorAuthority: 'SERVER_BOUND_EXECUTOR_REQUIRED',
    executableInThisModule: false,
    runtimeReachable: false,
  })
  assert.deepEqual(
    {
      evidenceSchemaVersion:
        certificate.evidence.evidenceSchemaVersion,
      sourceHeadSha: certificate.evidence.sourceHeadSha,
      mergedEvidenceSha: certificate.evidence.mergedEvidenceSha,
      workflowRunId: certificate.evidence.workflowRunId,
      outcomeToken: certificate.evidence.outcomeToken,
    },
    {
      evidenceSchemaVersion: 1,
      sourceHeadSha:
        'b6b66d04e9b1106af98691ad2627ea80aab1090b',
      mergedEvidenceSha:
        '10056f823c39544a15a4e180169fcc0c058b1ffe',
      workflowRunId: '30352634620',
      outcomeToken:
        'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN',
    },
  )

  assert.equal(certificate.evidence.cells.length, 2)
  const expected = new Map([
    [
      '2019',
      {
        productMajor: 15,
        artifactArchiveSha256:
          'd9df942688b769ae48c425dfc5bbb187b8a06eefc921d26c20dce7fc238e071e',
        recordSha256:
          '86d52b87dcf7f4aa1ea0883a29c19098d8232926ea777adcdda938f7a132b35b',
        recordedAt: '2026-07-28T10:55:26.213Z',
      },
    ],
    [
      '2022',
      {
        productMajor: 16,
        artifactArchiveSha256:
          'ed1ae01d0c04bce8048d787471b8b7152c907ecb9aa588d016364f8be61defd0',
        recordSha256:
          '0e37035f003273fc2d6fc16210f129ba428faaf6ebccccb09237e9ebcd42f93a',
        recordedAt: '2026-07-28T10:55:29.639Z',
      },
    ],
  ])
  for (const cell of certificate.evidence.cells) {
    const pin = expected.get(cell.engineMajorVersion)
    assert.ok(pin, 'every evidence cell must be declared')
    assert.deepEqual(Object.keys(cell), [
      'engineMajorVersion',
      'productMajor',
      'artifactName',
      'artifactArchiveSha256',
      'recordSha256',
      'record',
    ])
    assert.equal(cell.productMajor, pin.productMajor)
    assert.equal(
      cell.artifactName,
      `b1c-sqlserver-snapshot-evidence-${cell.engineMajorVersion}`,
    )
    assert.equal(
      cell.artifactArchiveSha256,
      pin.artifactArchiveSha256,
    )
    assert.equal(cell.recordSha256, pin.recordSha256)
    assert.equal(recordSha256(cell.record), pin.recordSha256)
    assert.equal(cell.record.recordedAt, pin.recordedAt)
    assert.equal(cell.record.engineMajorVersion, cell.engineMajorVersion)
    assert.equal(cell.record.dialect, 'sqlserver')
    assert.equal(
      cell.record.capabilityPosture,
      'explicit_snapshot_transaction',
    )
    assert.equal(
      cell.record.outcome,
      'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN',
    )
    assert.equal(
      cell.record.consistencyProof,
      'SOURCE_SNAPSHOT_TXN',
    )
    assert.equal(
      cell.record.continuationLifetime,
      'CONNECTION_BOUND',
    )
    for (const requiredTrue of [
      'snapshotEnabledReadback',
      'snapshotIsolationObserved',
      'activeSnapshotObserved',
      'sameSessionAcrossPages',
      'terminalShortPageObserved',
      'snapshotMatchesOriginal',
      'freshStateMatchesMutated',
      'snapshotDisabledRejected',
      'killedSessionAbsent',
      'connectionLossRejected',
      'commitAfterLossRejected',
      'cleanupComplete',
    ]) {
      assert.equal(
        cell.record[requiredTrue],
        true,
        `${cell.engineMajorVersion}/${requiredTrue} must open`,
      )
    }
    assert.equal(cell.record.lossControlTransactionFactoryCalls, 1)
    assert.equal(cell.record.writerMutationsCommitted, 3)
    assert.equal(cell.record.controlsPassed, 5)
    assert.equal(cell.record.controlsTotal, 5)
    assert.equal(cell.record.pageSize, 3)
    assert.equal(cell.record.pageCount, 3)
    assert.equal(cell.record.originalRowCount, 8)
    assert.equal(cell.record.snapshotRowCount, 8)
    assert.equal(cell.record.freshRowCount, 8)
  }

  assert.ok(Object.isFrozen(certificate))
  assert.ok(Object.isFrozen(certificate.contextContract))
  assert.ok(Object.isFrozen(certificate.contextContract.lifecycle))
  assert.ok(Object.isFrozen(certificate.evidence))
  assert.ok(Object.isFrozen(certificate.evidence.cells))
  assert.ok(Object.isFrozen(certificate.evidence.cells[0]))
  assert.ok(Object.isFrozen(certificate.evidence.cells[0].record))
}

function registrationUsesPrivateIdentity() {
  assert.ok(STRATEGY)
  assert.ok(Object.isFrozen(STRATEGY))
  assert.deepEqual(Object.keys(STRATEGY), [
    'actionProfileVersion',
    'strategyId',
    'strategyVersion',
    'dialect',
    'capabilityPosture',
    'snapshotSemantics',
    'contextContract',
  ])
  assert.equal(STRATEGY.actionProfileVersion, PROFILE)
  assert.equal(
    STRATEGY.contextContract,
    SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE
      .contextContract,
  )
  assert.equal(
    resolveCertifiedSqlServerSnapshotPageSequenceStrategy(PROFILE),
    STRATEGY,
  )
  assert.equal(
    resolveCertifiedSqlServerSnapshotPageSequenceStrategy(
      ` ${PROFILE}`,
    ),
    null,
  )
  assert.equal(
    resolveCertifiedSqlServerSnapshotPageSequenceStrategy(
      'sqlserver.snapshot_paged_read.v2',
    ),
    null,
  )
  assert.equal(
    resolveCertifiedSqlServerSnapshotPageSequenceStrategy({
      toString: () => PROFILE,
    }),
    null,
  )
  assert.equal(
    isCertifiedSqlServerSnapshotPageSequenceStrategy(STRATEGY),
    true,
  )
  assert.equal(
    isCertifiedSqlServerSnapshotPageSequenceStrategy({
      ...STRATEGY,
    }),
    false,
  )
  assert.equal(
    isCertifiedSqlServerSnapshotPageSequenceStrategy(
      new Proxy(STRATEGY, {}),
    ),
    false,
  )

  const exports = Object.keys(require(MODULE_PATH)).sort()
  assert.deepEqual(exports, [
    'SQLSERVER_SNAPSHOT_ACTION_PROFILE_VERSION',
    'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE',
    'SQLSERVER_SNAPSHOT_STRATEGY_ERROR_REASONS',
    'isCertifiedSqlServerSnapshotPageSequenceStrategy',
    'resolveCertifiedSqlServerSnapshotPageSequenceStrategy',
  ])
  assert.equal(
    exports.some((name) => /create|register|trust/i.test(name)),
    false,
  )
  assert.equal(
    Object.values(STRATEGY).some(
      (value) => typeof value === 'function',
    ),
    false,
    'the strategy certificate must not expose an executable context factory',
  )
}

function onlyLatentProfileConsumesStrategy() {
  const workspace = path.resolve(__dirname, '..', '..', '..')
  const moduleToken =
    'gip-sqlserver-snapshot-page-sequence-strategy'
  const expectedConsumer = path.join(
    'plugins',
    'plugin-integration-core',
    'lib',
    'gip-sqlserver-snapshot-paged-read-profile.cjs',
  )
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
  assert.deepEqual(consumers.sort(), [expectedConsumer])
}

function main() {
  certificatePinsOpeningEvidence()
  registrationUsesPrivateIdentity()
  onlyLatentProfileConsumesStrategy()
  console.log(
    'gip-sqlserver-snapshot-page-sequence-strategy.test.cjs OK',
  )
}

main()
