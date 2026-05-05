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
