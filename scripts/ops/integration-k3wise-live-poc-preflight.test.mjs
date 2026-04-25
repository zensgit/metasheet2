import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  LivePocPreflightError,
  buildPacket,
  renderMarkdown,
  runCli,
  sampleGate,
} from './integration-k3wise-live-poc-preflight.mjs'

function gate(overrides = {}) {
  return {
    ...sampleGate(),
    ...overrides,
    k3Wise: {
      ...sampleGate().k3Wise,
      ...(overrides.k3Wise || {}),
    },
    plm: {
      ...sampleGate().plm,
      ...(overrides.plm || {}),
    },
    sqlServer: {
      ...sampleGate().sqlServer,
      ...(overrides.sqlServer || {}),
    },
    rollback: {
      ...sampleGate().rollback,
      ...(overrides.rollback || {}),
    },
    bom: {
      ...sampleGate().bom,
      ...(overrides.bom || {}),
    },
    fieldMappings: {
      ...sampleGate().fieldMappings,
      ...(overrides.fieldMappings || {}),
    },
  }
}

test('buildPacket emits Save-only external systems, pipelines, and BOM product scope', () => {
  const packet = buildPacket(gate(), { generatedAt: '2026-04-25T00:00:00.000Z' })
  assert.equal(packet.status, 'preflight-ready')
  assert.equal(packet.safety.saveOnly, true)
  assert.equal(packet.safety.autoSubmit, false)
  assert.equal(packet.safety.autoAudit, false)

  const k3 = packet.externalSystems.find((system) => system.kind === 'erp:k3-wise-webapi')
  assert.ok(k3)
  assert.equal(k3.config.autoSubmit, false)
  assert.equal(k3.config.autoAudit, false)
  assert.equal(k3.credentials.password, '<set-at-runtime>')
  assert.deepEqual(k3.requiredCredentialKeys, ['acctId', 'password', 'username'])

  const plm = packet.externalSystems.find((system) => system.kind === 'plm:yuantus-wrapper')
  assert.equal(plm.config.defaultProductId, 'PRODUCT-TEST-001')

  const bom = packet.pipelines.find((pipeline) => pipeline.targetObject === 'bom')
  assert.equal(bom.options.source.filters.productId, 'PRODUCT-TEST-001')
  assert.equal(bom.options.source.productId, undefined)
})

test('buildPacket blocks production K3 WISE environments', () => {
  assert.throws(
    () => buildPacket(gate({ k3Wise: { environment: 'production' } })),
    (error) => error instanceof LivePocPreflightError && error.details.field === 'k3Wise.environment',
  )
})

test('buildPacket blocks Submit/Audit automation in live PoC packet', () => {
  assert.throws(
    () => buildPacket(gate({ k3Wise: { autoAudit: true } })),
    (error) => error instanceof LivePocPreflightError && /Save-only/.test(error.message),
  )
})

test('buildPacket blocks SQL Server writes to K3 core business tables', () => {
  assert.throws(
    () => buildPacket(gate({
      sqlServer: {
        enabled: true,
        mode: 'middle-table',
        allowedTables: ['t_ICItem'],
      },
    })),
    (error) => error instanceof LivePocPreflightError && error.details.field === 'sqlServer.allowedTables',
  )
})

test('buildPacket normalizes safe customer formatting variants', () => {
  const packet = buildPacket(gate({
    k3Wise: {
      environment: ' UAT ',
      autoSubmit: 'false',
      autoAudit: 'no',
    },
    sqlServer: {
      enabled: true,
      mode: 'READONLY',
      allowedTables: ['T_ICITEM'],
    },
  }), { generatedAt: '2026-04-25T00:00:00.000Z' })

  assert.equal(packet.safety.environment, 'uat')
  assert.equal(packet.gateSummary.k3Wise.environment, 'uat')
  assert.equal(packet.safety.sqlServerMode, 'readonly')
  assert.equal(packet.externalSystems.find((system) => system.kind === 'erp:k3-wise-sqlserver').config.mode, 'readonly')
})

test('buildPacket rejects truthy Submit/Audit strings and invalid flag values', () => {
  for (const k3Wise of [
    { autoSubmit: 'true' },
    { autoAudit: 'yes' },
    { autoSubmit: '是' },
  ]) {
    assert.throws(
      () => buildPacket(gate({ k3Wise })),
      (error) => error instanceof LivePocPreflightError && /Save-only/.test(error.message),
    )
  }

  assert.throws(
    () => buildPacket(gate({ k3Wise: { autoSubmit: 'maybe' } })),
    (error) => error instanceof LivePocPreflightError && error.details.field === 'k3Wise.autoSubmit',
  )
})

test('buildPacket blocks schema-qualified and quoted K3 core SQL table writes', () => {
  for (const table of [' t_ICItem ', 'dbo.t_ICItem', '[dbo].[t_ICBomChild]', '"dbo"."t_ICBOM"']) {
    assert.throws(
      () => buildPacket(gate({
        sqlServer: {
          enabled: true,
          mode: 'middle table',
          allowedTables: [table],
        },
      })),
      (error) => error instanceof LivePocPreflightError && error.details.field === 'sqlServer.allowedTables',
    )
  }

  const packet = buildPacket(gate({
    sqlServer: {
      enabled: true,
      mode: 'middle table',
      allowedTables: ['t_ICItem_stage'],
    },
  }))
  assert.equal(packet.safety.sqlServerMode, 'middle-table')
})

test('buildPacket requires BOM product scope when BOM PoC is enabled', () => {
  assert.throws(
    () => buildPacket(gate({
      plm: { defaultProductId: undefined, config: {} },
      bom: { enabled: true, productId: undefined },
    })),
    (error) => error instanceof LivePocPreflightError && error.details.field === 'bom.productId',
  )
})

test('renderMarkdown and CLI outputs do not leak submitted secret values', async () => {
  const input = gate({
    k3Wise: { credentials: { username: 'k3-user', password: 'super-secret-k3' } },
    plm: { credentials: { username: 'plm-user', password: 'super-secret-plm' } },
  })
  const packet = buildPacket(input, { generatedAt: '2026-04-25T00:00:00.000Z' })
  const markdown = renderMarkdown(packet)
  assert.equal(JSON.stringify(packet).includes('super-secret-k3'), false)
  assert.equal(JSON.stringify(packet).includes('super-secret-plm'), false)
  assert.equal(markdown.includes('super-secret-k3'), false)
  assert.equal(markdown.includes('super-secret-plm'), false)

  const dir = await mkdtemp(path.join(os.tmpdir(), 'integration-live-poc-'))
  try {
    const inputPath = path.join(dir, 'gate.json')
    await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`)
    await runCli(['--input', inputPath, '--out-dir', dir])
    const json = await readFile(path.join(dir, 'integration-k3wise-live-poc-packet.json'), 'utf8')
    const md = await readFile(path.join(dir, 'integration-k3wise-live-poc-packet.md'), 'utf8')
    assert.equal(json.includes('super-secret-k3'), false)
    assert.equal(json.includes('super-secret-plm'), false)
    assert.equal(md.includes('super-secret-k3'), false)
    assert.equal(md.includes('super-secret-plm'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
