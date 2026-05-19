import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BLOCKED_DECISION,
  CUSTOMER_READY_DECISION,
  CUSTOMER_SIGNED_OFF_DECISION,
  INTERNAL_READY_DECISION,
  buildReadinessReport,
  renderMarkdown,
  runCli,
} from './integration-k3wise-delivery-readiness.mjs'

function postdeployPass() {
  return {
    ok: true,
    authenticated: true,
    signoff: {
      internalTrial: 'pass',
      reason: 'authenticated smoke passed',
    },
    summary: { pass: 12, skipped: 0, fail: 0 },
  }
}

function postdeployPassWithSqlExecutorMissing() {
  return {
    ...postdeployPass(),
    summary: { pass: 12, skipped: 1, fail: 0 },
    checks: [
      {
        id: 'sqlserver-executor-availability',
        status: 'skipped',
        code: 'SQLSERVER_EXECUTOR_MISSING',
        reason: 'K3 WISE SQL Server source is configured but this package has not completed SQL executor wiring or dependency install; staging-to-K3 smoke signoff can still pass.',
        systemsChecked: 1,
        blockedSystems: [
          {
            id: 'sys_sql',
              name: 'K3 SQL Source',
              role: 'source',
              status: 'error',
              rawConnectionString: 'server=hidden;credential=should-not-copy',
            },
          ],
        },
    ],
  }
}

function packageVerifyPass(overrides = {}) {
  return {
    ok: true,
    packageName: 'metasheet-multitable-onprem-v2.5.0-k3wise.zip',
    archiveType: 'zip',
    checks: [
      { name: 'checksum', status: 'PASS' },
      { name: 'required-content', status: 'PASS', requiredCount: 48 },
      { name: 'no-github-links', status: 'PASS' },
    ],
    ...overrides,
  }
}

function gateContractPass(overrides = {}) {
  return {
    ok: true,
    decision: 'PASS',
    exitCode: 0,
    stage1Lock: {
      status: 'held',
    },
    sections: {
      webapiReadList: {
        answered: 12,
        requiredAnswers: 12,
      },
      relationshipMapping: {
        answered: 7,
        requiredAnswers: 7,
      },
    },
    issues: [],
    summary: {
      pass: 1,
      blocked: 0,
      fail: 0,
    },
    ...overrides,
  }
}

function preflightReadyPacket(overrides = {}) {
  return {
    status: 'preflight-ready',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    projectId: 'project_1',
    safety: {
      saveOnly: true,
      autoSubmit: false,
      autoAudit: false,
      productionWriteBlocked: true,
    },
    ...overrides,
  }
}

function liveEvidencePass() {
  return {
    decision: 'PASS',
    issues: [],
  }
}

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'integration-k3wise-delivery-readiness-'))
}

test('reports internal readiness after authenticated postdeploy smoke passes', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, INTERNAL_READY_DECISION)
  assert.equal(report.gates.find((gate) => gate.id === 'postdeploy-smoke').status, 'pass')
  assert.equal(report.gates.find((gate) => gate.id === 'package-verify').status, 'pending')
  assert.equal(report.gates.find((gate) => gate.id === 'preflight-packet').status, 'pending')
  assert.match(report.nextAction, /Run the on-prem package verifier/)
})

test('carries optional SQL executor diagnostic without blocking readiness', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPassWithSqlExecutorMissing(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, INTERNAL_READY_DECISION)
  const postdeploy = report.gates.find((gate) => gate.id === 'postdeploy-smoke')
  assert.equal(postdeploy.status, 'pass')
  assert.equal(postdeploy.advancedSqlSource.status, 'skipped')
  assert.equal(postdeploy.advancedSqlSource.code, 'SQLSERVER_EXECUTOR_MISSING')
  assert.equal(postdeploy.advancedSqlSource.systemsChecked, 1)
  assert.deepEqual(postdeploy.advancedSqlSource.blockedSystems, [
    {
      id: 'sys_sql',
      name: 'K3 SQL Source',
      role: 'source',
      status: 'error',
    },
  ])
  assert.equal(JSON.stringify(postdeploy).includes('should-not-copy'), false)
})

test('reports customer trial ready after postdeploy and preflight pass', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    packageVerify: packageVerifyPass(),
    preflightPacket: preflightReadyPacket(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, CUSTOMER_READY_DECISION)
  assert.equal(report.productionUse.ready, false)
  assert.match(report.nextAction, /Start the customer K3 WISE test-account live PoC/)
})

test('reports customer trial signed off after live evidence report passes', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    packageVerify: packageVerifyPass(),
    preflightPacket: preflightReadyPacket(),
    liveEvidenceReport: liveEvidencePass(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, CUSTOMER_SIGNED_OFF_DECISION)
  assert.equal(report.productionUse.ready, false)
  assert.match(report.productionUse.reason, /scheduled change window/)
})

test('blocks readiness when preflight packet loses Save-only safety', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    packageVerify: packageVerifyPass(),
    preflightPacket: preflightReadyPacket({
      safety: {
        saveOnly: true,
        autoSubmit: true,
        autoAudit: false,
        productionWriteBlocked: true,
      },
    }),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, BLOCKED_DECISION)
  const preflight = report.gates.find((gate) => gate.id === 'preflight-packet')
  assert.equal(preflight.status, 'fail')
  assert.match(preflight.reason, /autoSubmit must be false/)
})

test('blocks customer trial readiness when package verify report is failing', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    packageVerify: packageVerifyPass({
      checks: [
        { name: 'checksum', status: 'PASS' },
        { name: 'required-content', status: 'FAIL' },
      ],
    }),
    preflightPacket: preflightReadyPacket(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, BLOCKED_DECISION)
  const packageGate = report.gates.find((gate) => gate.id === 'package-verify')
  assert.equal(packageGate.status, 'fail')
  assert.match(packageGate.reason, /required-content:FAIL/)
})

test('keeps customer trial pending until package verify report is provided', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    preflightPacket: preflightReadyPacket(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, INTERNAL_READY_DECISION)
  assert.equal(report.gates.find((gate) => gate.id === 'package-verify').status, 'pending')
  assert.match(report.nextAction, /Run the on-prem package verifier/)
})

test('carries pending GATE contract check without blocking existing Save-only readiness', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    packageVerify: packageVerifyPass(),
    preflightPacket: preflightReadyPacket(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, CUSTOMER_READY_DECISION)
  const gateContract = report.gates.find((gate) => gate.id === 'gate-contract-check')
  assert.equal(gateContract.status, 'pending')
  assert.match(gateContract.reason, /not provided/)
})

test('reports GATE contract check pass as a dedicated readiness gate', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    packageVerify: packageVerifyPass(),
    gateContractCheck: gateContractPass(),
    preflightPacket: preflightReadyPacket(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, CUSTOMER_READY_DECISION)
  const gateContract = report.gates.find((gate) => gate.id === 'gate-contract-check')
  assert.equal(gateContract.status, 'pass')
  assert.equal(gateContract.webapiReadList.answered, 12)
  assert.equal(gateContract.relationshipMapping.answered, 7)
  assert.match(gateContract.reason, /O1-O6/)
})

test('blocks readiness when GATE contract check is blocked or failed', () => {
  const blocked = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    packageVerify: packageVerifyPass(),
    gateContractCheck: gateContractPass({
      ok: false,
      decision: 'GATE_BLOCKED',
      exitCode: 2,
      summary: { pass: 0, blocked: 1, fail: 0 },
    }),
    preflightPacket: preflightReadyPacket(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(blocked.decision, BLOCKED_DECISION)
  assert.match(blocked.gates.find((gate) => gate.id === 'gate-contract-check').reason, /GATE_BLOCKED/)

  const failed = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    packageVerify: packageVerifyPass(),
    gateContractCheck: gateContractPass({
      ok: false,
      decision: 'FAIL',
      exitCode: 1,
      summary: { pass: 0, blocked: 0, fail: 1 },
    }),
    preflightPacket: preflightReadyPacket(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(failed.decision, BLOCKED_DECISION)
  assert.match(failed.gates.find((gate) => gate.id === 'gate-contract-check').reason, /FAIL/)
})

test('blocks readiness when GATE contract check does not hold the Stage 1 Lock', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    packageVerify: packageVerifyPass(),
    gateContractCheck: gateContractPass({
      stage1Lock: {
        status: 'unknown',
      },
    }),
    preflightPacket: preflightReadyPacket(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, BLOCKED_DECISION)
  assert.match(report.gates.find((gate) => gate.id === 'gate-contract-check').reason, /Stage 1 Lock/)
})

test('blocks readiness when live evidence is partial or failed', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    packageVerify: packageVerifyPass(),
    preflightPacket: preflightReadyPacket(),
    liveEvidenceReport: {
      decision: 'PARTIAL',
      issues: [{ severity: 'warn', code: 'CUSTOMER_CONFIRMATION_PENDING' }],
    },
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, BLOCKED_DECISION)
  const live = report.gates.find((gate) => gate.id === 'live-evidence')
  assert.equal(live.status, 'fail')
  assert.match(live.reason, /PARTIAL/)
})

test('renders markdown gate table and production caveat', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPassWithSqlExecutorMissing(),
    packageVerify: packageVerifyPass(),
    preflightPacket: preflightReadyPacket(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  const md = renderMarkdown(report)

  assert.match(md, /Readiness: \*\*CUSTOMER_TRIAL_READY\*\*/)
  assert.match(md, /Production use ready: \*\*no\*\*/)
  assert.match(md, /\| On-prem package verification \| pass \|/)
  assert.match(md, /\| Customer GATE preflight packet \| pass \|/)
  assert.match(md, /Advanced Diagnostics/)
  assert.match(md, /SQLSERVER_EXECUTOR_MISSING/)
  assert.match(md, /K3 read\/list and relationship GATE contract/)
  assert.doesNotMatch(md, /should-not-copy/)
})

test('CLI writes JSON and Markdown readiness artifacts', async () => {
  const outDir = makeTmpDir()
  try {
    const postdeployPath = path.join(outDir, 'postdeploy.json')
    const packageVerifyPath = path.join(outDir, 'package-verify.json')
    const gateContractPath = path.join(outDir, 'gate-contract-check.json')
    const packetPath = path.join(outDir, 'packet.json')
    const reportPath = path.join(outDir, 'evidence-report.json')
    const readinessOut = path.join(outDir, 'readiness')
    writeFileSync(postdeployPath, `${JSON.stringify(postdeployPass())}\n`)
    writeFileSync(packageVerifyPath, `${JSON.stringify(packageVerifyPass())}\n`)
    writeFileSync(gateContractPath, `${JSON.stringify(gateContractPass())}\n`)
    writeFileSync(packetPath, `${JSON.stringify(preflightReadyPacket())}\n`)
    writeFileSync(reportPath, `${JSON.stringify(liveEvidencePass())}\n`)

    const code = await runCli([
      '--postdeploy-smoke', postdeployPath,
      '--package-verify', packageVerifyPath,
      '--gate-contract-check', gateContractPath,
      '--preflight-packet', packetPath,
      '--live-evidence-report', reportPath,
      '--out-dir', readinessOut,
      '--fail-on-blocked',
    ])

    assert.equal(code, 0)
    const json = JSON.parse(readFileSync(path.join(readinessOut, 'integration-k3wise-delivery-readiness.json'), 'utf8'))
    const md = readFileSync(path.join(readinessOut, 'integration-k3wise-delivery-readiness.md'), 'utf8')
    assert.equal(json.decision, CUSTOMER_SIGNED_OFF_DECISION)
    assert.equal(json.gates.find((gate) => gate.id === 'gate-contract-check').status, 'pass')
    assert.match(md, /Customer live PoC evidence report/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
