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
//   7. SQL channel read/upsert probes to verify the mock matches channel contract
//   7d. THE RULED CHAIN end-to-end: read -> clean -> C6 dry-run -> approval token ->
//       Save-only -> GetDetail read-back (value-verified) + never-saved negative control
//   7a-2. The row just READ is fed to the REAL stock-prep intake (no per-connector mapper):
//         0 row errors, key stable and source-namespaced, incomplete row rejected
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
const {
  K3_WISE_C6_MAX_APPLY_ROWS,
  K3_WISE_C6_WRITE_PROFILE,
  createK3WiseC6WriteSource,
  deriveK3WiseC6PlannerTargetConfig,
} = require('../../../../plugins/plugin-integration-core/lib/adapters/k3-wise-c6-write-profile.cjs')
const {
  applyExternalWrite,
  dryRunExternalWrite,
} = require('../../../../plugins/plugin-integration-core/lib/external-write-dry-run.cjs')
const {
  normalizeStockPreparationReadonlyIntake,
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-readonly-intake.cjs')

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

  let upsertResult, bomUpsertResult, sqlReadResult, sqlWriteRejected
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
        // RATIFIED (owner, 20260805): material writes require the named customer profile —
        // the save-only lock and maxApplyRows=3 arm through it. BOM (step 6b) is out of the
        // guard's scope and keeps the generic template.
        objects: { material: { profile: 'material-k3wise-customer-profile-v1' } },
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
          allowedTables: ['t_ICItem', 'dbo.t_ICItem', 'dbo.integration_material_stage'],
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

    // 6b. K3 BOM Save-only upsert with v1 template fields.
    bomUpsertResult = await k3Adapter.upsert({
      object: 'bom',
      records: [
        {
          FParentItemNumber: 'MAT-MOCK-001',
          FChildItemNumber: 'MAT-MOCK-002',
          FQty: 1,
          FUnitID: 'PCS',
          FEntryID: 1,
        },
      ],
      keyFields: ['FParentItemNumber'],
      options: { autoSubmit: false, autoAudit: false },
    })
    assert(bomUpsertResult.written === 1, `expected 1 BOM written, got ${bomUpsertResult.written}`)
    assert(bomUpsertResult.failed === 0, `expected 0 BOM failed, got ${bomUpsertResult.failed}`)
    const bomSaveCalls = mockK3.calls.filter((call) => call.pathname === '/K3API/BOM/Save')
    assert(bomSaveCalls.length === 1, `expected 1 BOM Save call, got ${bomSaveCalls.length}`)
    const bomPayload = bomSaveCalls[0].body?.Data
    assert(bomPayload?.FParentItemNumber === 'MAT-MOCK-001', 'BOM Save payload must include FParentItemNumber')
    assert(bomPayload?.FChildItemNumber === 'MAT-MOCK-002', 'BOM Save payload must include FChildItemNumber')
    assert(bomPayload?.FQty === 1, 'BOM Save payload must include FQty')
    assert(bomPayload?.FUnitID === 'PCS', 'BOM Save payload must include FUnitID')
    assert(bomPayload?.FEntryID === 1, 'BOM Save payload must include FEntryID')
    assert(bomPayload?.sourceId === undefined, 'BOM Save payload must not include internal source fields')
    console.log('✓ step 6b: K3 BOM Save-only upsert wrote 1 BOM with v1 Data template fields')

    // 7. SQL channel contract probes + safety check
    try {
      sqlReadResult = await sqlChannel.read({ object: 'material', limit: 1 })
      assert(sqlReadResult.records.length === 1, 'SQL channel readonly probe should return 1 row')
      console.log(`✓ step 7a: SQL channel readonly probe returned ${sqlReadResult.records.length} row from t_ICItem`)
    } catch (error) {
      throw new Error(`SQL channel readonly probe failed: ${error.message}`)
    }

    // 7a-2. The row we JUST READ goes through the REAL stock-prep intake.
    //
    // This exercises the product path (source-run -> normalizeStockPreparationReadonlyIntake ->
    // persist), not a per-connector mapper: the intake's alias lists already accept raw K3
    // columns. An earlier version of this step called a separate K3 mapper, which turned out to
    // duplicate the intake AND derive a conflicting erpMaterialId; that mapper was retracted.
    // Feeding the intake the actual read output means a drift between "what the read returns"
    // and "what the intake accepts" fails HERE rather than at a customer.
    try {
      const sourceRow = sqlReadResult.records[0]
      const intakeRun = normalizeStockPreparationReadonlyIntake({
        sourceSystem: 'erp_k3',
        runId: 'mock-poc-intake',
        startedAt: '2026-08-04T00:00:00.000Z',
        createdBy: 'system',
        erpMaterials: [sourceRow],
      })

      // Zero row errors IS the claim: the intake understood the raw K3 shape with no mapper.
      assert(
        intakeRun.evidence.result.rowErrors === 0,
        `raw K3 row must produce 0 intake row errors, got ${intakeRun.evidence.result.rowErrors}`,
      )
      const intake = intakeRun.erpMaterials[0]
      assert(intake.erpMaterialCode === sourceRow.FNumber, 'FNumber must land as erpMaterialCode')
      assert(
        intake.erpMaterialInternalId === String(sourceRow.FItemID),
        'FItemID must land as erpMaterialInternalId',
      )
      assert(intake.erpMaterialName === sourceRow.FName, 'FName must land as erpMaterialName')

      // Identity must be STABLE (re-reading the same material must not create a second row --
      // erpMaterialId is the persist's key field) and NAMESPACED by source system (two ERPs that
      // both number a material 1001 must not collide).
      const again = normalizeStockPreparationReadonlyIntake({
        sourceSystem: 'erp_k3',
        runId: 'mock-poc-intake-2',
        startedAt: '2026-08-04T00:00:00.000Z',
        createdBy: 'system',
        erpMaterials: [sourceRow],
      }).erpMaterials[0].erpMaterialId
      assert(again === intake.erpMaterialId, 'the same material must derive the same key on re-read')

      const otherSystem = normalizeStockPreparationReadonlyIntake({
        sourceSystem: 'erp_other',
        runId: 'mock-poc-intake-3',
        startedAt: '2026-08-04T00:00:00.000Z',
        createdBy: 'system',
        erpMaterials: [sourceRow],
      }).erpMaterials[0].erpMaterialId
      assert(
        otherSystem !== intake.erpMaterialId,
        'the same internal id from another source system must not collide',
      )

      // Negative control: without it, everything above would also pass if the intake were a
      // pass-through that validated nothing. A row with no internal id must be a ROW ERROR.
      const incomplete = normalizeStockPreparationReadonlyIntake({
        sourceSystem: 'erp_k3',
        runId: 'mock-poc-intake-neg',
        startedAt: '2026-08-04T00:00:00.000Z',
        createdBy: 'system',
        erpMaterials: [{ FNumber: sourceRow.FNumber }],
      })
      assert(
        incomplete.evidence.result.rowErrors > 0,
        'a row without an internal id must be a row error, not a silent pass',
      )

      console.log(
        '\u2713 step 7a-2: raw read row accepted by the real stock-prep intake (0 row errors; key stable and source-namespaced; incomplete row rejected)',
      )
    } catch (error) {
      throw new Error(`K3 read -> stock-prep intake failed: ${error.message}`)
    }
    try {
      const middleWriteResult = await sqlChannel.upsert({
        object: 'material_stage',
        records: [{ FNumber: 'MAT-STAGE-001', FName: 'Mock staged material' }],
        keyFields: ['FNumber'],
      })
      assert(middleWriteResult.written === 1, `expected 1 SQL middle-table write, got ${middleWriteResult.written}`)
      console.log('✓ step 7b: SQL channel middle-table upsert wrote 1 integration row')
    } catch (error) {
      throw new Error(`SQL channel middle-table upsert failed: ${error.message}`)
    }
    try {
      await mockSql.exec({ sql: 'INSERT INTO dbo.t_ICItem (FNumber, FName) VALUES (?, ?)', params: ['MAT-FORBIDDEN', 'should be blocked'] })
      sqlWriteRejected = false
    } catch (error) {
      sqlWriteRejected = /core table/.test(error.message)
    }
    assert(sqlWriteRejected, 'SQL safety: write to t_ICItem must be rejected')
    console.log('✓ step 7c: SQL safety guard rejected INSERT into t_ICItem (core table)')

    // 7d. THE RULED CHAIN, end to end: 读 → 清洗 → dry-run → token(人工批准的机械代理)
    // → K3 Material Save-only → GetDetail 回读验证. Every hop is the REAL module — the C6
    // planner, the C6 K3 write profile, the K3 adapter over real HTTP to the mock server.
    // The only fakes are the wire's far end and the token store.
    try {
      const chainRows = [{ code: 'MAT-CHAIN-001', name: 'Chain material', spec: 'SPEC-CHAIN' }]
      const chainTarget = {
        id: 'chain-k3-target',
        name: 'Chain K3 target',
        kind: 'erp:k3-wise-webapi',
        role: 'target',
        status: 'active',
        credentials: { username: 'demo', password: 'demo', acctId: 'AIS_TEST' },
        config: {
          baseUrl,
          autoSubmit: false,
          autoAudit: false,
          objects: { material: { profile: 'material-k3wise-customer-profile-v1' } },
        },
      }
      const chainPipeline = {
        id: 'pipe_chain',
        tenantId: 'tenant_demo',
        workspaceId: null,
        sourceSystemId: 'source_demo',
        sourceObject: 'materials',
        targetSystemId: chainTarget.id,
        targetObject: 'material',
        createdBy: 'demo-operator',
        fieldMappings: [
          { sourceField: 'code', targetField: 'FNumber', validation: [{ type: 'required' }] },
          { sourceField: 'name', targetField: 'FName', validation: [{ type: 'required' }] },
          { sourceField: 'spec', targetField: 'FModel' },
        ],
      }
      const flatConfig = deriveK3WiseC6PlannerTargetConfig({
        system: chainTarget, object: 'material', fieldMappings: chainPipeline.fieldMappings,
      })
      const tokenMap = new Map()
      const tokenStore = {
        async get(key) { return tokenMap.get(key) || null },
        async set(key, value) { tokenMap.set(key, JSON.parse(JSON.stringify(value))) },
        async consume(key) { const v = tokenMap.get(key) || null; tokenMap.delete(key); return v },
        async delete(key) { tokenMap.delete(key) },
      }
      const chainInputs = () => ({
        pipeline: chainPipeline,
        sourceSystem: { id: 'source_demo', kind: 'data-source:sql-readonly' },
        targetSystem: { ...chainTarget, config: flatConfig },
        sourceAdapter: { async read() { return { records: chainRows, done: true } } },
        dataSourceWrites: createK3WiseC6WriteSource({
          system: chainTarget,
          createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: globalThis.fetch }),
          // The B4 binding the ops runbook MINTS on the target environment — the demo stub
          // stands in for the store row the real mint produces (owner review 20260805:
          // C6 must CONSUME the approved binding, not merely coexist with it).
          b4: {
            readSourceConfigs: {
              // Honours its arguments (review P1-2: a stub that ignores scope hides the gate).
              async list(input = {}) {
                const row = {
                  id: 'rsc_demo_b4', tenantId: 'tenant_demo', workspaceId: null,
                  object: 'material', status: 'approved', version: 1,
                  contentKey: 'demo-b4-content-key',
                  config: { actionProfileVersion: 'k3wise.material_list.v1', systemId: 'source_demo' },
                }
                if (input.tenantId !== row.tenantId) return []
                if ((input.workspaceId ?? null) !== row.workspaceId) return []
                if (input.status !== undefined && input.status !== row.status) return []
                return [row]
              },
            },
            tenantId: 'tenant_demo',
            workspaceId: null,
            pipelineSystemIds: ['source_demo', chainTarget.id],
          },
        }),
        targetWriteProfile: K3_WISE_C6_WRITE_PROFILE,
        tokenStore,
        dryRunUser: 'demo-operator',
        dataSourceOwnerPrincipal: 'demo-owner',
        maxRows: K3_WISE_C6_MAX_APPLY_ROWS,
      })

      const chainDryRun = await dryRunExternalWrite(chainInputs())
      assert(chainDryRun.status === 'ready', `chain dry-run must be ready, got ${chainDryRun.status}`)
      assert(chainDryRun.dryRunToken, 'chain dry-run must mint the approval token')
      assert(chainDryRun.counts.add === 1, 'a new material must plan as add')

      const chainApply = await applyExternalWrite({
        ...chainInputs(),
        dryRunToken: chainDryRun.dryRunToken,
        applyUser: 'demo-operator',
      })
      assert(chainApply.counts.written === 1, `chain apply must write 1, got ${chainApply.counts.written}`)

      // THE LAST LINK — post-save GetDetail read-back, value-verified (not presence-only):
      // the read must return the material JUST WRITTEN with the APPROVED name carried through.
      const readBackAdapter = createK3WiseWebApiAdapter({ system: chainTarget, fetchImpl: globalThis.fetch })
      const readBack = await readBackAdapter.read({ object: 'material', filters: { FNumber: 'MAT-CHAIN-001' } })
      assert(readBack.records.length === 1, 'read-back must return the saved material')
      assert(readBack.records[0].FNumber === 'MAT-CHAIN-001', 'read-back key must match')
      assert(readBack.records[0].FName === 'Chain material',
        'read-back must carry the APPROVED value — presence alone proves nothing')

      // Negative control: a never-saved number must be a business-level miss, proving the
      // read-back above found the WRITE, not canned data.
      let readBackMissRefused = false
      try {
        await readBackAdapter.read({ object: 'material', filters: { FNumber: 'MAT-NEVER-SAVED' } })
      } catch (error) {
        readBackMissRefused = error?.details?.code === 'K3_WISE_READ_BUSINESS_ERROR'
      }
      assert(readBackMissRefused, 'a never-saved material must be a business-level read miss')

      const chainSubmits = mockK3.calls.filter((call) => /\/(Submit|Audit)$/.test(call.pathname))
      assert(chainSubmits.length === 0, 'the FULL chain must stay Save-only: 0 Submit, 0 Audit')
      console.log('✓ step 7d: RULED CHAIN end-to-end — read → clean → dry-run → token → Save-only → GetDetail read-back (value-verified; never-saved miss refused; 0 Submit/Audit)')
    } catch (error) {
      throw new Error(`ruled-chain end-to-end failed: ${error.message}`)
    }

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
      bomPoC: {
        status: 'pass',
        runId: 'mock-bom-001',
        productId: 'PRODUCT-TEST-001',
        rowsWritten: bomUpsertResult.written,
        k3Records: bomUpsertResult.results.map((r) => ({
          bomNumber: r.key,
          externalId: r.externalId,
          billNo: r.billNo,
        })),
        legacyPipelineOptionsSourceProductId: false,
      },
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
