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
  assert.equal(report.gates.find((gate) => gate.id === 'preflight-packet').status, 'pending')
  assert.match(report.nextAction, /Wait for customer GATE/)
})

test('reports customer trial ready after postdeploy and preflight pass', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
    preflightPacket: preflightReadyPacket(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  assert.equal(report.decision, CUSTOMER_READY_DECISION)
  assert.equal(report.productionUse.ready, false)
  assert.match(report.nextAction, /Start the customer K3 WISE test-account live PoC/)
})

test('reports customer trial signed off after live evidence report passes', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
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

test('blocks readiness when live evidence is partial or failed', () => {
  const report = buildReadinessReport({
    postdeploySmoke: postdeployPass(),
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
    postdeploySmoke: postdeployPass(),
    preflightPacket: preflightReadyPacket(),
  }, { generatedAt: '2026-05-06T00:00:00.000Z' })

  const md = renderMarkdown(report)

  assert.match(md, /Readiness: \*\*CUSTOMER_TRIAL_READY\*\*/)
  assert.match(md, /Production use ready: \*\*no\*\*/)
  assert.match(md, /\| Customer GATE preflight packet \| pass \|/)
})

test('CLI writes JSON and Markdown readiness artifacts', async () => {
  const outDir = makeTmpDir()
  try {
    const postdeployPath = path.join(outDir, 'postdeploy.json')
    const packetPath = path.join(outDir, 'packet.json')
    const reportPath = path.join(outDir, 'evidence-report.json')
    const readinessOut = path.join(outDir, 'readiness')
    writeFileSync(postdeployPath, `${JSON.stringify(postdeployPass())}\n`)
    writeFileSync(packetPath, `${JSON.stringify(preflightReadyPacket())}\n`)
    writeFileSync(reportPath, `${JSON.stringify(liveEvidencePass())}\n`)

    const code = await runCli([
      '--postdeploy-smoke', postdeployPath,
      '--preflight-packet', packetPath,
      '--live-evidence-report', reportPath,
      '--out-dir', readinessOut,
      '--fail-on-blocked',
    ])

    assert.equal(code, 0)
    const json = JSON.parse(readFileSync(path.join(readinessOut, 'integration-k3wise-delivery-readiness.json'), 'utf8'))
    const md = readFileSync(path.join(readinessOut, 'integration-k3wise-delivery-readiness.md'), 'utf8')
    assert.equal(json.decision, CUSTOMER_SIGNED_OFF_DECISION)
    assert.match(md, /Customer live PoC evidence report/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
