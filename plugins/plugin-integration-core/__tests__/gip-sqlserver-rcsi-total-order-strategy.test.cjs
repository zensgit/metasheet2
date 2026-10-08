'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MODULE_PATH = path.join(
  __dirname,
  '..',
  'lib',
  'gip-sqlserver-rcsi-total-order-strategy.cjs',
)
const {
  SQLSERVER_RCSI_STRATEGY_CERTIFICATE,
  SQLSERVER_RCSI_STRATEGY_ERROR_REASONS,
  resolveCertifiedSqlServerRcsiStrategy,
  isCertifiedSqlServerRcsiStrategy,
} = require(MODULE_PATH)

const PROFILE = 'sqlserver.total_order_probe.rcsi.v1'
const STRATEGY = resolveCertifiedSqlServerRcsiStrategy(PROFILE)

function expectReason(fn, reason) {
  let caught
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.equal(caught?.name, 'GipSqlServerRcsiStrategyError')
  assert.equal(caught.reason, reason)
  assert.equal(caught.message.includes('attacker'), false)
  return caught
}

function validRow(overrides = {}) {
  return {
    engine_product_major: 15,
    rcsi_enabled: 1,
    isolation_level: 2,
    duplicate_groups_sampled: 0,
    null_key_rows_sampled: 0,
    ...overrides,
  }
}

function certificateIsExactAndHonest() {
  assert.deepEqual(SQLSERVER_RCSI_STRATEGY_ERROR_REASONS, [
    'SQLSERVER_RCSI_PROBE_INPUT_INVALID',
    'SQLSERVER_RCSI_PROBE_RESULT_INVALID',
    'SQLSERVER_RCSI_ENGINE_VERSION_UNCERTIFIED',
    'SQLSERVER_RCSI_POSTURE_UNPROVEN',
    'SQLSERVER_RCSI_ORDERING_KEY_DUPLICATE_FOUND',
    'SQLSERVER_RCSI_ORDERING_KEY_NULL_FOUND',
  ])
  assert.deepEqual(SQLSERVER_RCSI_STRATEGY_CERTIFICATE, {
    actionProfileVersion: PROFILE,
    strategyId: 'gip.total_order_probe.sqlserver_rcsi',
    strategyVersion: 'v1',
    dialect: 'sqlserver',
    capabilityPosture: 'rcsi_on',
    supportedEngineMajorVersions: ['2019', '2022'],
    snapshotSemantics: 'read_committed_snapshot_statement_scoped',
    scope: {
      qualificationOnly: true,
      statementScoped: true,
      crossStatement: false,
      crossPage: false,
      explicitSnapshotTransaction: false,
      runtimeReachable: false,
    },
    evidence: {
      evidenceSchemaVersion: 1,
      sourceHeadSha: '4308b138e4e44ce9f09e9ebf505396a6e7dd4958',
      workflowRunId: '30329280423',
      outcomeToken: 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN',
      cells: [
        {
          engineMajorVersion: '2019',
          productMajor: 15,
          artifactName: 'b1b-evidence-sqlserver-2019',
          phaseARecordSha256: 'b7b2f7cc99570bd45b0345f0dd45ed6ee4dd4cd72d3750f574f6893210b69dda',
          phaseBRecordSha256: 'ae5807432c58406933fa31fda34e47d73408a74958dd318a8cd38fb341ff3dc8',
          phaseARecord: {
            evidenceSchemaVersion: 1,
            dialect: 'sqlserver',
            engineMajorVersion: '2019',
            phase: 'phaseA',
            capabilityPosture: 'default_rc_no_rcsi',
            outcome: 'SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED',
            sameConnection: true,
            controlsTotal: 23,
            controlsInverted: 23,
            observationsTaken: 16,
            recordedAt: '2026-07-28T04:38:33.934Z',
          },
          phaseBRecord: {
            evidenceSchemaVersion: 1,
            dialect: 'sqlserver',
            engineMajorVersion: '2019',
            phase: 'phaseB',
            capabilityPosture: 'rcsi_on',
            outcome: 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN',
            sameConnection: true,
            statementScoped: true,
            separateProfile: true,
            controlsTotal: 44,
            controlsInverted: 44,
            observationsTaken: 33,
            recordedAt: '2026-07-28T04:38:39.255Z',
          },
        },
        {
          engineMajorVersion: '2022',
          productMajor: 16,
          artifactName: 'b1b-evidence-sqlserver-2022',
          phaseARecordSha256: 'd4c9ed6f842de37a5910b534893fc235d809f372bbbd0f9094a911a22d9292a2',
          phaseBRecordSha256: '9dfa7007c1e5069d7b20c38a0a7aed39bccd18c01649b25767cc712277e26e1a',
          phaseARecord: {
            evidenceSchemaVersion: 1,
            dialect: 'sqlserver',
            engineMajorVersion: '2022',
            phase: 'phaseA',
            capabilityPosture: 'default_rc_no_rcsi',
            outcome: 'SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED',
            sameConnection: true,
            controlsTotal: 23,
            controlsInverted: 23,
            observationsTaken: 16,
            recordedAt: '2026-07-28T04:38:35.207Z',
          },
          phaseBRecord: {
            evidenceSchemaVersion: 1,
            dialect: 'sqlserver',
            engineMajorVersion: '2022',
            phase: 'phaseB',
            capabilityPosture: 'rcsi_on',
            outcome: 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN',
            sameConnection: true,
            statementScoped: true,
            separateProfile: true,
            controlsTotal: 44,
            controlsInverted: 44,
            observationsTaken: 33,
            recordedAt: '2026-07-28T04:38:40.616Z',
          },
        },
      ],
    },
  })
  assert.ok(Object.isFrozen(SQLSERVER_RCSI_STRATEGY_CERTIFICATE))
  assert.ok(Object.isFrozen(SQLSERVER_RCSI_STRATEGY_CERTIFICATE.scope))
  assert.ok(Object.isFrozen(SQLSERVER_RCSI_STRATEGY_CERTIFICATE.evidence.cells))
  assert.ok(Object.isFrozen(SQLSERVER_RCSI_STRATEGY_CERTIFICATE.evidence.cells[0]))

  // B1b certifies a qualification strategy, not a read profile or page sequence.
  for (const forbidden of [
    'acquisitionMode',
    'supportedConsistencyProofs',
    'continuationLifetime',
    'supportedCompletenessProofs',
    'orderingKeyRequirement',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(SQLSERVER_RCSI_STRATEGY_CERTIFICATE, forbidden),
      false,
    )
  }
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
    'buildTotalOrderProbePlan',
  ])
  assert.equal(resolveCertifiedSqlServerRcsiStrategy(PROFILE), STRATEGY)
  assert.equal(resolveCertifiedSqlServerRcsiStrategy(` ${PROFILE}`), null)
  assert.equal(resolveCertifiedSqlServerRcsiStrategy('sqlserver.total_order_probe.default_rc.v1'), null)
  assert.equal(resolveCertifiedSqlServerRcsiStrategy('sqlserver.total_order_probe.rcsi.v2'), null)
  assert.equal(resolveCertifiedSqlServerRcsiStrategy({ toString: () => PROFILE }), null)
  assert.equal(isCertifiedSqlServerRcsiStrategy(STRATEGY), true)
  assert.equal(isCertifiedSqlServerRcsiStrategy({ ...STRATEGY }), false)
  assert.equal(isCertifiedSqlServerRcsiStrategy(
    new Proxy(STRATEGY, {}),
  ), false)

  const exports = Object.keys(require(MODULE_PATH)).sort()
  assert.deepEqual(exports, [
    'SQLSERVER_RCSI_STRATEGY_CERTIFICATE',
    'SQLSERVER_RCSI_STRATEGY_ERROR_REASONS',
    'isCertifiedSqlServerRcsiStrategy',
    'resolveCertifiedSqlServerRcsiStrategy',
  ])
  assert.equal(exports.some((name) => /create|register|trust/i.test(name)), false)
}

function strategyHasNoStaticRuntimeConsumer() {
  const workspace = path.resolve(__dirname, '..', '..', '..')
  const roots = ['apps', 'packages', 'plugins']
  const moduleToken = 'gip-sqlserver-rcsi-total-order-strategy'
  const consumers = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'tests') continue
        walk(absolute)
        continue
      }
      if (!/\.(?:cjs|mjs|js|ts)$/.test(entry.name) || absolute === MODULE_PATH) continue
      if (fs.readFileSync(absolute, 'utf8').includes(moduleToken)) {
        consumers.push(path.relative(workspace, absolute))
      }
    }
  }
  for (const root of roots) walk(path.join(workspace, root))
  assert.deepEqual(
    consumers,
    [],
    'the SQL Server RCSI strategy gained a static runtime consumer; runtime wiring is outside this gate',
  )
}

function builderProducesOneBoundedStatement() {
  const originalColumns = ['item_id', 'revision']
  const plan = STRATEGY.buildTotalOrderProbePlan({
    objectName: 'dbo.materials',
    keyColumns: originalColumns,
  })
  originalColumns[0] = 'mutated_after_build'

  assert.equal(plan.actionProfileVersion, PROFILE)
  assert.equal(plan.checkedKeyColumnCount, 2)
  assert.ok(Object.isFrozen(plan))
  assert.deepEqual(Object.keys(plan), [
    'actionProfileVersion',
    'statement',
    'checkedKeyColumnCount',
    'adjudicate',
  ])
  assert.equal(plan.statement.includes('[dbo].[materials]'), true)
  assert.equal(plan.statement.includes('[item_id], [revision]'), true)
  assert.equal(plan.statement.includes('mutated_after_build'), false)
  assert.equal(plan.statement.includes("SERVERPROPERTY('ProductMajorVersion')"), true)
  assert.equal(plan.statement.includes('database_id = DB_ID()'), true)
  assert.equal(plan.statement.includes('CONVERT(INT, is_read_committed_snapshot_on)'), true)
  assert.equal(plan.statement.includes('session_id = @@SPID'), true)
  assert.equal(plan.statement.includes('COUNT_BIG(*) > 1'), true)
  assert.equal(plan.statement.includes('LIMIT'), false)
  assert.equal(plan.statement.includes(';'), false)
  assert.equal(plan.statement.includes('NOLOCK'), false)
  assert.equal(plan.statement.includes('SNAPSHOT TRANSACTION'), false)

  expectReason(
    () => STRATEGY.buildTotalOrderProbePlan({
      objectName: 'dbo.materials; DROP TABLE users',
      keyColumns: ['item_id'],
    }),
    'SQLSERVER_RCSI_PROBE_INPUT_INVALID',
  )
  expectReason(
    () => STRATEGY.buildTotalOrderProbePlan({
      objectName: 'dbo.materials',
      keyColumns: ['item_id', 'item_id'],
    }),
    'SQLSERVER_RCSI_PROBE_INPUT_INVALID',
  )
  expectReason(
    () => STRATEGY.buildTotalOrderProbePlan({
      objectName: 'dbo.materials',
      keyColumns: ['dbo.item_id'],
    }),
    'SQLSERVER_RCSI_PROBE_INPUT_INVALID',
  )

  const hostile = new Proxy({}, {
    ownKeys() {
      throw new Error('attacker-own-keys')
    },
  })
  expectReason(
    () => STRATEGY.buildTotalOrderProbePlan(hostile),
    'SQLSERVER_RCSI_PROBE_INPUT_INVALID',
  )
}

function adjudicationBindsPostureVersionAndOrder() {
  const plan = STRATEGY.buildTotalOrderProbePlan({
    objectName: 'dbo.materials',
    keyColumns: ['item_id', 'revision'],
  })
  const evidence2019 = plan.adjudicate(validRow())
  const evidence2022 = plan.adjudicate(validRow({ engine_product_major: 16 }))
  assert.equal(evidence2019.engineMajorVersion, '2019')
  assert.equal(evidence2022.engineMajorVersion, '2022')
  assert.equal(evidence2019.snapshotSemantics, 'read_committed_snapshot_statement_scoped')
  assert.equal(evidence2019.statementScoped, true)
  assert.equal(evidence2019.checkedKeyColumnCount, 2)
  assert.deepEqual(Object.keys(evidence2019), [
    'probeKind',
    'actionProfileVersion',
    'strategyId',
    'strategyVersion',
    'dialect',
    'capabilityPosture',
    'engineMajorVersion',
    'snapshotSemantics',
    'statementScoped',
    'checkedKeyColumnCount',
    'duplicateGroupsFound',
    'nullKeyRowsFound',
  ])
  assert.equal(JSON.stringify(evidence2019).includes('dbo.materials'), false)
  assert.equal(JSON.stringify(evidence2019).includes('item_id'), false)
  assert.ok(Object.isFrozen(evidence2019))

  expectReason(
    () => plan.adjudicate(validRow({ engine_product_major: 14 })),
    'SQLSERVER_RCSI_ENGINE_VERSION_UNCERTIFIED',
  )
  expectReason(
    () => plan.adjudicate(validRow({ rcsi_enabled: 0 })),
    'SQLSERVER_RCSI_POSTURE_UNPROVEN',
  )
  expectReason(
    () => plan.adjudicate(validRow({ rcsi_enabled: true })),
    'SQLSERVER_RCSI_POSTURE_UNPROVEN',
  )
  expectReason(
    () => plan.adjudicate(validRow({ isolation_level: 5 })),
    'SQLSERVER_RCSI_POSTURE_UNPROVEN',
  )
  expectReason(
    () => plan.adjudicate(validRow({ duplicate_groups_sampled: 1 })),
    'SQLSERVER_RCSI_ORDERING_KEY_DUPLICATE_FOUND',
  )
  expectReason(
    () => plan.adjudicate(validRow({ null_key_rows_sampled: 1 })),
    'SQLSERVER_RCSI_ORDERING_KEY_NULL_FOUND',
  )
  expectReason(
    () => plan.adjudicate({ ...validRow(), unexpected: 1 }),
    'SQLSERVER_RCSI_PROBE_RESULT_INVALID',
  )
  expectReason(
    () => plan.adjudicate(validRow({ engine_product_major: '15' })),
    'SQLSERVER_RCSI_PROBE_RESULT_INVALID',
  )

  const hostileResult = new Proxy(validRow(), {
    getOwnPropertyDescriptor() {
      throw new Error('attacker-result')
    },
  })
  expectReason(
    () => plan.adjudicate(hostileResult),
    'SQLSERVER_RCSI_PROBE_RESULT_INVALID',
  )
}

function main() {
  certificateIsExactAndHonest()
  registrationUsesPrivateIdentity()
  strategyHasNoStaticRuntimeConsumer()
  builderProducesOneBoundedStatement()
  adjudicationBindsPostureVersionAndOrder()
  console.log('gip-sqlserver-rcsi-total-order-strategy.test.cjs OK')
}

main()
