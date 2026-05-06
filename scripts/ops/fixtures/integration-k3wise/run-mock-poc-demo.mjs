#!/usr/bin/env node
// End-to-end mock smoke for the K3 WISE PoC chain. Proves the wiring works
// before any customer-facing live test. NOT a substitute for a real customer
// run — see README.md.
//
// Pipeline this exercises:
//   1. Load gate-sample.json
//   2. preflight: buildPacket(gate) → packet (in-memory, no disk write)
//   3. Spin up mock K3 WebAPI server (ephemeral port, in-process)
//   4. Spin up mock SQL Server executor (in-process)
//   5. Adapter testConnection on both
//   6. Adapter Material Save-only upsert against mock K3 (autoSubmit=false, autoAudit=false)
//   7. SQL channel readonly probe to verify the mock blocks core-table writes
//   8. Compose evidence JSON (hardcoded for the values we just produced)
//   9. evidence compiler: buildEvidenceReport(packet, evidence) → assert PASS
//
// Run: node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { buildPacket } from '../../integration-k3wise-live-poc-preflight.mjs'
import { buildEvidenceReport } from '../../integration-k3wise-live-poc-evidence.mjs'

import { createMockK3WebApiServer } from './mock-k3-webapi-server.mjs'
import { createMockSqlServerExecutor } from './mock-sqlserver-executor.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)
const { createK3WiseWebApiAdapter } = require('../../../../plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs')
const { createK3WiseSqlServerChannel } = require('../../../../plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs')

function assert(cond, message) {
  if (!cond) throw new Error(`mock PoC demo FAIL: ${message}`)
}

async function main() {
  // 1. Load gate sample
  const gatePath = path.join(__dirname, 'gate-sample.json')
  const gate = JSON.parse(await readFile(gatePath, 'utf8'))

  // 2. preflight (in-memory)
  const packet = buildPacket(gate, { generatedAt: '2026-04-26T00:00:00.000Z' })
  assert(packet.safety && packet.safety.saveOnly === true, 'preflight packet must be Save-only')
  assert(packet.safety.autoSubmit === false, 'preflight packet must have autoSubmit=false')
  console.log('✓ step 1-2: preflight packet generated, Save-only=true, autoSubmit=false')

  // 3. Mock K3 server
  const mockK3 = createMockK3WebApiServer()
  const baseUrl = await mockK3.start()  // ephemeral port
  console.log(`✓ step 3: mock K3 WebAPI listening at ${baseUrl}`)

  // 4. Mock SQL executor (canned t_ICItem read returns 1 row; writes to core blocked)
  const mockSql = createMockSqlServerExecutor({
    cannedReadResults: {
      t_icitem: [{ FItemID: 1001, FNumber: 'MAT-EXISTING', FName: 'Existing material' }],
    },
  })
  console.log('✓ step 4: mock SQL executor ready (t_ICItem readonly with 1 canned row)')

  let upsertResult, sqlReadResult, sqlWriteRejected
  try {
    // 5a. K3 adapter testConnection
    const k3System = {
      id: 'mock-k3',
      name: 'Mock K3 WISE',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      credentials: { username: 'demo', password: 'demo', acctId: 'AIS_TEST' },
      config: {
        baseUrl,
        healthPath: '/K3API/Health',
        autoSubmit: false,
        autoAudit: false,
      },
    }
    const k3Adapter = createK3WiseWebApiAdapter({ system: k3System, fetchImpl: globalThis.fetch })
    const k3Conn = await k3Adapter.testConnection()
    assert(k3Conn.ok === true, 'K3 testConnection should succeed against mock')
    console.log('✓ step 5a: K3 testConnection ok against mock')

    // 5b. SQL channel testConnection
    const sqlChannel = createK3WiseSqlServerChannel({
      system: {
        id: 'mock-sql',
        name: 'Mock K3 SQL',
        kind: 'erp:k3-wise-sqlserver',
        role: 'bidirectional',
        config: {
          allowedTables: ['dbo.t_ICItem', 'dbo.integration_material_stage'],
          objects: {
            material_stage: {
              table: 'dbo.integration_material_stage',
              operations: ['upsert'],
              writeMode: 'middle-table',
              keyField: 'FNumber',
              schema: [{ name: 'FNumber', type: 'string', required: true }],
            },
          },
        },
      },
      queryExecutor: mockSql,
    })
    const sqlConn = await sqlChannel.testConnection()
    assert(sqlConn.ok === true, 'SQL channel testConnection should succeed against mock')
    console.log('✓ step 5b: SQL channel testConnection ok against mock')

    // 6. K3 Material Save-only upsert
    upsertResult = await k3Adapter.upsert({
      object: 'material',
      records: [
        { FNumber: 'MAT-MOCK-001', FName: 'Mock material A' },
        { FNumber: 'MAT-MOCK-002', FName: 'Mock material B' },
      ],
      keyFields: ['FNumber'],
      options: { autoSubmit: false, autoAudit: false },
    })
    assert(upsertResult.written === 2, `expected 2 written, got ${upsertResult.written}`)
    assert(upsertResult.failed === 0, `expected 0 failed, got ${upsertResult.failed}`)
    assert(upsertResult.metadata.autoSubmit === false, 'autoSubmit must remain false (PoC safety)')
    assert(upsertResult.metadata.autoAudit === false, 'autoAudit must remain false (PoC safety)')
    const submitCalls = mockK3.calls.filter((call) => call.pathname === '/K3API/Material/Submit')
    const auditCalls = mockK3.calls.filter((call) => call.pathname === '/K3API/Material/Audit')
    assert(submitCalls.length === 0, `expected 0 Submit calls (Save-only), got ${submitCalls.length}`)
    assert(auditCalls.length === 0, `expected 0 Audit calls (Save-only), got ${auditCalls.length}`)
    console.log(`✓ step 6: K3 Save-only upsert wrote 2 records, 0 Submit, 0 Audit (PoC safety preserved)`)

    // 7. SQL channel readonly probe + safety check
    try {
      sqlReadResult = await mockSql.query({ sql: 'SELECT FItemID, FNumber, FName FROM dbo.t_ICItem WHERE FNumber = ?', params: ['MAT-EXISTING'] })
      assert(sqlReadResult.rows.length === 1, 'mock SQL readonly probe should return 1 row')
      console.log(`✓ step 7a: SQL readonly probe returned ${sqlReadResult.rows.length} row from t_ICItem`)
    } catch (error) {
      throw new Error(`SQL readonly probe failed: ${error.message}`)
    }
    try {
      await mockSql.exec({ sql: 'INSERT INTO dbo.t_ICItem (FNumber, FName) VALUES (?, ?)', params: ['MAT-FORBIDDEN', 'should be blocked'] })
      sqlWriteRejected = false
    } catch (error) {
      sqlWriteRejected = /core table/.test(error.message)
    }
    assert(sqlWriteRejected, 'SQL safety: write to t_ICItem must be rejected')
    console.log('✓ step 7b: SQL safety guard rejected INSERT into t_ICItem (core table)')

    // 8-9. Compose evidence + run compiler
    const evidence = {
      gate: { status: 'pass', archivePath: 'mock://gate-archive' },
      connections: {
        plm: { status: 'pass', requestId: 'mock-plm-conn' },
        k3Wise: { status: 'pass', requestId: 'mock-k3-conn' },
        sqlServer: { status: 'pass', requestId: 'mock-sql-conn' },
      },
      materialDryRun: { status: 'pass', runId: 'mock-dry-001', rowsPreviewed: 2 },
      materialSaveOnly: {
        status: 'pass',
        runId: 'mock-save-001',
        rowsWritten: upsertResult.written,
        autoSubmit: false,
        autoAudit: false,
        k3Records: upsertResult.results.map((r) => ({
          materialCode: r.key,
          externalId: r.externalId,
          billNo: r.billNo,
        })),
      },
      erpFeedback: {
        status: 'pass',
        runId: 'mock-feedback-001',
        rowsUpdated: upsertResult.results.length,
        fieldsUpdated: ['erpSyncStatus', 'erpExternalId', 'erpBillNo', 'erpResponseCode', 'erpResponseMessage', 'lastSyncedAt'],
        updatedRows: upsertResult.results.map((r) => ({
          materialCode: r.key,
          erpSyncStatus: 'synced',
          erpExternalId: r.externalId,
          erpBillNo: r.billNo,
          erpResponseCode: 'OK',
          erpResponseMessage: r.responseMessage || 'K3 WISE save succeeded',
          lastSyncedAt: '2026-04-26T01:00:00.000Z',
        })),
      },
      deadLetterReplay: { status: 'pass', originalRunId: 'mock-fail-001', replayRunId: 'mock-replay-001' },
      bomPoC: { status: 'pass', runId: 'mock-bom-001', productId: 'PRODUCT-TEST-001', legacyPipelineOptionsSourceProductId: false },
      rollback: { status: 'pass', owner: 'mock-admin', evidence: 'TEST-prefixed mock records' },
      customerConfirmation: { status: 'pass', owner: 'mock-customer', confirmedAt: '2026-04-26T01:00:00.000Z' },
    }
    const report = buildEvidenceReport(packet, evidence, { generatedAt: '2026-04-26T01:00:00.000Z' })
    assert(report.decision === 'PASS', `expected PASS, got ${report.decision}`)
    assert(report.issues.length === 0, `expected 0 issues, got ${report.issues.length}: ${JSON.stringify(report.issues)}`)
    console.log(`✓ step 8-9: evidence compiler returned PASS with 0 issues`)

  } finally {
    await mockK3.stop()
  }

  console.log('')
  console.log('✓ K3 WISE PoC mock chain verified end-to-end (PASS)')
  console.log('  Note: mock pass ≠ customer live pass. See fixtures/README.md.')
}

main().catch((error) => {
  console.error('✗ K3 WISE PoC mock chain FAILED')
  console.error(error)
  process.exit(1)
})
