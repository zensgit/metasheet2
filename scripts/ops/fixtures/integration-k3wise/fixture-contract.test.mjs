import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  buildPacket,
  sampleGate,
} from '../../integration-k3wise-live-poc-preflight.mjs'
import {
  buildEvidenceReport,
  sampleEvidence,
} from '../../integration-k3wise-live-poc-evidence.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const gateFixturePath = path.join(__dirname, 'gate-sample.json')
const gateIntakeTemplatePath = path.join(__dirname, 'gate-intake-template.json')
const evidenceFixturePath = path.join(__dirname, 'evidence-sample.json')

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function stripTemplateComments(value) {
  if (Array.isArray(value)) return value.map(stripTemplateComments)
  if (!value || typeof value !== 'object') return value

  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === '_comment') continue
    result[key] = stripTemplateComments(child)
  }
  return result
}

test('gate-sample.json stays equivalent to the exported preflight sample', async () => {
  const gateFixture = await readJson(gateFixturePath)
  assert.deepEqual(stripTemplateComments(gateFixture), sampleGate())

  const packet = buildPacket(gateFixture, { generatedAt: '2026-05-05T00:00:00.000Z' })
  assert.equal(packet.status, 'preflight-ready')
  assert.equal(packet.safety.saveOnly, true)
  assert.equal(packet.safety.autoSubmit, false)
  assert.equal(packet.safety.autoAudit, false)
  assert.equal(packet.externalSystems.length, 3)
  assert.equal(packet.pipelines.length, 2)
  assert.equal(JSON.stringify(packet).includes('<fill-outside-git>'), false)
})

test('gate-intake-template.json is customer-facing and accepted by live preflight', async () => {
  const template = await readJson(gateIntakeTemplatePath)
  assert.equal(template._instructions.secretPlaceholder, '<fill-outside-git>')
  assert.match(template._sections['A.1'], /Test scope/)
  assert.match(template._sections['A.6'], /Rollback contract/)

  const packet = buildPacket(template, { generatedAt: '2026-05-15T00:00:00.000Z' })
  assert.equal(packet.status, 'preflight-ready')
  assert.equal(packet.safety.saveOnly, true)
  assert.equal(packet.safety.autoSubmit, false)
  assert.equal(packet.safety.autoAudit, false)
  assert.equal(packet.safety.sqlServerMode, 'disabled')
  assert.equal(packet.pipelines.some((pipeline) => pipeline.targetObject === 'material'), true)
  assert.equal(packet.pipelines.some((pipeline) => pipeline.targetObject === 'bom'), true)
  assert.equal(packet.externalSystems.some((system) => system.kind === 'erp:k3-wise-sqlserver'), false)
  assert.equal(JSON.stringify(packet).includes('<fill-outside-git>'), false)
})

test('evidence-sample.json stays equivalent to the exported evidence sample', async () => {
  const gateFixture = await readJson(gateFixturePath)
  const evidenceFixture = await readJson(evidenceFixturePath)
  assert.deepEqual(stripTemplateComments(evidenceFixture), sampleEvidence())

  const packet = buildPacket(gateFixture, { generatedAt: '2026-05-05T00:00:00.000Z' })
  const report = buildEvidenceReport(packet, evidenceFixture, { generatedAt: '2026-05-05T01:00:00.000Z' })
  assert.equal(report.decision, 'PASS')
  assert.equal(report.issues.length, 0)
  assert.equal(report.scope.bomRequired, true)
  assert.equal(report.scope.sqlChannelExpected, true)
})
