import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildPacket,
  sampleGate,
} from './integration-k3wise-live-poc-preflight.mjs'
import {
  LivePocEvidenceError,
  buildEvidenceReport,
  renderMarkdown,
  runCli,
  sampleEvidence,
} from './integration-k3wise-live-poc-evidence.mjs'

function packet(overrides = {}) {
  return buildPacket({
    ...sampleGate(),
    ...overrides,
  }, { generatedAt: '2026-04-25T00:00:00.000Z' })
}

test('buildEvidenceReport returns PASS for complete Save-only evidence', () => {
  const report = buildEvidenceReport(packet(), sampleEvidence(), { generatedAt: '2026-04-25T11:00:00.000Z' })
  assert.equal(report.decision, 'PASS')
  assert.equal(report.issues.length, 0)
  assert.equal(report.scope.bomRequired, true)
  assert.equal(report.phases.find((phase) => phase.id === 'bomPoC').status, 'pass')
  assert.match(renderMarkdown(report), /Decision: PASS/)
})

test('buildEvidenceReport returns PARTIAL when a required phase is missing', () => {
  const evidence = sampleEvidence()
  delete evidence.customerConfirmation
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(report.decision, 'PARTIAL')
  assert.equal(report.phases.find((phase) => phase.id === 'customerConfirmation').status, 'todo')
})

test('buildEvidenceReport returns FAIL when Save-only row count exceeds PoC limit', () => {
  const evidence = sampleEvidence()
  evidence.materialSaveOnly.rowsWritten = 4
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(report.decision, 'FAIL')
  assert.equal(report.issues.some((issue) => issue.code === 'SAVE_ONLY_ROW_COUNT'), true)
})

test('buildEvidenceReport returns FAIL when autoAudit appears in Save-only evidence', () => {
  const evidence = sampleEvidence()
  evidence.materialSaveOnly.autoAudit = true
  const report = buildEvidenceReport(packet(), evidence)
  assert.equal(report.decision, 'FAIL')
  assert.equal(report.issues.some((issue) => issue.code === 'SAVE_ONLY_VIOLATED'), true)
})

test('buildEvidenceReport rejects unredacted secret-like evidence fields', () => {
  const evidence = sampleEvidence()
  evidence.connections.k3Wise.sessionToken = 'live-session-token'
  assert.throws(
    () => buildEvidenceReport(packet(), evidence),
    (error) => error instanceof LivePocEvidenceError && error.details.secretLeaks.includes('evidence.connections.k3Wise.sessionToken'),
  )
})

test('CLI writes redacted JSON and Markdown reports', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'integration-live-evidence-'))
  try {
    const packetPath = path.join(dir, 'packet.json')
    const evidencePath = path.join(dir, 'evidence.json')
    await writeFile(packetPath, `${JSON.stringify(packet(), null, 2)}\n`)
    await writeFile(evidencePath, `${JSON.stringify(sampleEvidence(), null, 2)}\n`)
    await runCli(['--packet', packetPath, '--evidence', evidencePath, '--out-dir', dir])
    const json = await readFile(path.join(dir, 'integration-k3wise-live-poc-evidence-report.json'), 'utf8')
    const md = await readFile(path.join(dir, 'integration-k3wise-live-poc-evidence-report.md'), 'utf8')
    assert.match(json, /"decision": "PASS"/)
    assert.match(md, /Decision: PASS/)
    assert.equal(json.includes('password'), false)
    assert.equal(md.includes('sessionToken'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
