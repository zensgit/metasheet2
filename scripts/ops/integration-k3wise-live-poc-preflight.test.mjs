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

test('buildPacket rejects inline credentials and secret query parameters in endpoint URLs', () => {
  assert.throws(
    () => buildPacket(gate({
      k3Wise: { apiUrl: 'https://k3-user:k3-secret@k3.example.test/K3API/' },
    })),
    (error) => error instanceof LivePocPreflightError &&
      error.details.field === 'k3Wise.apiUrl' &&
      /inline username or password/.test(error.message),
    'K3 API URL must not carry basic-auth credentials into the generated packet',
  )

  assert.throws(
    () => buildPacket(gate({
      k3Wise: { apiUrl: 'https://k3.example.test/K3API/?token=k3-secret-token' },
    })),
    (error) => error instanceof LivePocPreflightError &&
      error.details.field === 'k3Wise.apiUrl' &&
      error.details.queryKeys.includes('token'),
    'K3 API URL must not carry token-like query parameters into the generated packet',
  )

  assert.throws(
    () => buildPacket(gate({
      plm: { baseUrl: 'https://plm.example.test/api?api_key=plm-secret-key' },
    })),
    (error) => error instanceof LivePocPreflightError &&
      error.details.field === 'plm.baseUrl' &&
      error.details.queryKeys.includes('api_key'),
    'PLM base URL must not carry API-key-like query parameters into the generated packet',
  )

  const packet = buildPacket(gate({
    plm: { baseUrl: 'https://plm.example.test/api?tenant=demo' },
  }))
  assert.equal(
    packet.externalSystems.find((system) => system.kind === 'plm:yuantus-wrapper').config.baseUrl,
    'https://plm.example.test/api?tenant=demo',
    'non-secret query parameters remain available for customer routing metadata',
  )
})

test('buildPacket requires K3 WISE auth keys before declaring preflight ready', () => {
  assert.throws(
    () => buildPacket(gate({ k3Wise: { credentials: {} } })),
    (error) => error instanceof LivePocPreflightError && error.details.field === 'k3Wise.credentials',
    'missing username/password or sessionId must block preflight-ready packet generation',
  )

  assert.throws(
    () => buildPacket(gate({ k3Wise: { credentials: { username: 'k3-user' } } })),
    (error) => error instanceof LivePocPreflightError && error.details.field === 'k3Wise.credentials',
    'partial username-only credentials must still block preflight-ready packet generation',
  )

  const packet = buildPacket(gate({
    k3Wise: {
      credentials: {
        sessionId: 'k3-session-from-customer',
      },
    },
  }))
  const k3 = packet.externalSystems.find((system) => system.kind === 'erp:k3-wise-webapi')
  assert.deepEqual(k3.requiredCredentialKeys, ['acctId', 'sessionId'])
  assert.equal(k3.credentials.sessionId, '<set-at-runtime>')
})

test('buildPacket requires minimum K3 material target mappings', () => {
  assert.throws(
    () => buildPacket(gate({
      fieldMappings: {
        material: [
          { sourceField: 'code', targetField: 'FNumber' },
        ],
      },
    })),
    (error) => error instanceof LivePocPreflightError &&
      error.details.field === 'fieldMappings.material' &&
      error.details.requiredTargetFields.includes('FName'),
    'material mappings must include K3 material name target field',
  )
})

test('buildPacket requires minimum K3 BOM target mappings when BOM is enabled', () => {
  assert.throws(
    () => buildPacket(gate({
      fieldMappings: {
        bom: [
          { sourceField: 'parentCode', targetField: 'FParentItemNumber' },
          { sourceField: 'childCode', targetField: 'FChildItems[].FItemNumber' },
        ],
      },
    })),
    (error) => error instanceof LivePocPreflightError &&
      error.details.field === 'fieldMappings.bom' &&
      error.details.requiredTargetFields.includes('FChildItems[].FQty'),
    'BOM mappings must include K3 child quantity target field',
  )

  const packet = buildPacket(gate({
    bom: { enabled: false, productId: undefined },
    fieldMappings: {
      bom: [],
    },
  }))
  assert.equal(packet.pipelines.some((pipeline) => pipeline.targetObject === 'bom'), false)
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

test('buildPacket coerces sqlServer.enabled "true" string and still applies allowedTables guard', () => {
  // Customer types `enabled: "true"` instead of boolean true — without coercion
  // the script would skip the entire SQL Server validation and the t_ICItem
  // write would slip past. Same bug class as autoSubmit/autoAudit string truthy.
  assert.throws(
    () => buildPacket(gate({
      sqlServer: {
        enabled: 'true',
        mode: 'middle-table',
        allowedTables: ['t_ICItem'],
      },
    })),
    (error) => error instanceof LivePocPreflightError && error.details.field === 'sqlServer.allowedTables',
    'string "true" must enable SQL Server channel and trigger core-table guard',
  )

  // Mirror: enabled: false-like string disables the channel.
  // Note: must override mode (sampleGate inherits mode='readonly') so the
  // fallback 'disabled' actually fires; otherwise explicit mode wins.
  const packet = buildPacket(gate({
    sqlServer: { enabled: 'no', mode: undefined, allowedTables: [] },
  }))
  assert.equal(packet.safety.sqlServerMode, 'disabled', 'string "no" + no explicit mode disables sql server')
})

test('buildPacket coerces sqlServer.writeCoreTables "true" string', () => {
  // Same string-truthy pattern: customer typing writeCoreTables: "true" was
  // previously read as not-true (=== true comparison), bypassing the guard.
  assert.throws(
    () => buildPacket(gate({
      sqlServer: {
        enabled: true,
        mode: 'middle-table',
        writeCoreTables: 'true',
        allowedTables: ['t_some_safe_table'],
      },
    })),
    (error) => error instanceof LivePocPreflightError && error.details.field === 'sqlServer.allowedTables',
    'string "true" on writeCoreTables must trigger core-table guard',
  )
})

test('buildPacket coerces bom.enabled "true" string and enforces productId requirement', () => {
  // Same bug class: customer types bom.enabled: "true" with no productId.
  // Previously slipped past because === true read it as false → BOM PoC
  // would run without a product scope.
  assert.throws(
    () => buildPacket(gate({
      plm: { defaultProductId: undefined, config: {} },
      bom: { enabled: 'true', productId: undefined },
    })),
    (error) => error instanceof LivePocPreflightError && error.details.field === 'bom.productId',
    'string "true" on bom.enabled must trigger productId requirement',
  )

  // Mirror: false-like string disables BOM cleanly.
  const packet = buildPacket(gate({
    plm: { defaultProductId: undefined, config: {} },
    bom: { enabled: '否', productId: undefined },
  }))
  const bomPipeline = packet.pipelines.find((pipeline) => pipeline.targetObject === 'bom')
  assert.equal(bomPipeline, undefined, 'string "否" disables BOM PoC pipeline')
})

test('buildPacket accepts numeric 0/1 for boolean flags but rejects other numbers', () => {
  // Common spreadsheet-export pattern: 0/1 as numeric booleans.
  const packetTrue = buildPacket(gate({
    sqlServer: { enabled: 1, mode: 'readonly', allowedTables: [] },
  }))
  assert.equal(packetTrue.safety.sqlServerMode, 'readonly', 'number 1 enables sql server')

  const packetFalse = buildPacket(gate({
    sqlServer: { enabled: 0, mode: undefined, allowedTables: [] },
  }))
  assert.equal(packetFalse.safety.sqlServerMode, 'disabled', 'number 0 + no explicit mode disables sql server')

  // Non 0/1 number rejected with clear message.
  assert.throws(
    () => buildPacket(gate({ k3Wise: { autoSubmit: 2 } })),
    (error) => error instanceof LivePocPreflightError && /0 or 1/.test(error.message),
    'number 2 should produce a clear "0 or 1" error',
  )
  assert.throws(
    () => buildPacket(gate({ k3Wise: { autoAudit: NaN } })),
    (error) => error instanceof LivePocPreflightError && /finite/.test(error.message),
    'NaN should produce a clear finite-number error',
  )
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
