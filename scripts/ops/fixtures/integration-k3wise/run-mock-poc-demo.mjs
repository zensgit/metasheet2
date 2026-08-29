#!/usr/bin/env node
// End-to-end mock smoke for the K3 WISE PoC chain. Proves the wiring works
// before any customer-facing live test. NOT a substitute for a real customer
// run — see README.md.
//
// CONVERTED FOR E4 / G-4 (HG v1.2 §10 — K3 Save/Submit/Audit external write-back is PERMANENTLY
// BANNED, fixed values-free code `K3_WISE_EXTERNAL_WRITE_DISABLED`, four independent refusal
// layers). This demo described the pre-fence world: steps 6, 6b and 7d each drove a real Save
// against the mock and asserted rows were written. Those Saves are now structurally unreachable —
// layer 4 refuses inside the adapter's `upsert` BEFORE `login()`.
//
// The conversion is deliberate and is the same one applied to the six plugin suites: a leg that
// asserted "the write happened" becomes a leg that asserts "the write is refused, with the fixed
// code, and K3 saw nothing". Every READ-ONLY assertion is kept — the demo is now also the
// end-to-end proof of the §15.2 E4-05 property (the fence is NOT a blanket deny: reads, cleaning,
// intake, the C6 planner and GetDetail all still work over real HTTP against the mock).
//
// Pipeline this exercises:
//   1. Load gate-sample.json
//   2. preflight: buildPacket(gate) → packet (in-memory, no disk write)
//   3. Spin up mock K3 WebAPI server (ephemeral port, in-process)
//   4. Spin up mock SQL Server executor (in-process)
//   5. Adapter testConnection on both
//   6. E4 FENCE PROOF (material): adapter upsert is REFUSED with the fixed code; the mock records
//      ZERO new calls — no login, no Save
//   6b. E4 FENCE PROOF (BOM): the ban is connector-wide, not material-only — same refusal, same
//      zero-call proof
//   7. SQL channel read/upsert probes to verify the mock matches channel contract
//   7d. THE RULED CHAIN, as far as it now goes: read -> clean -> C6 dry-run (REAL GetDetail round
//       trip against the mock) -> NO token minted -> apply REFUSED without consuming a pre-seeded
//       token -> K3's own state confirms the material was never written, and that read failure
//       carries a READ-ONLY code, never the write-fence code
//   7a-2. The row just READ is fed to the REAL stock-prep intake (no per-connector mapper):
//         0 row errors, key stable and source-namespaced, incomplete row rejected
//   8. Compose evidence JSON (synthetic literals — see the note at step 8)
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
import { createHmac, randomBytes } from 'node:crypto'

// Per-run key, mirroring production's per-process key for the instance digest.
const DEMO_INSTANCE_KEY = randomBytes(32)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)
const { createK3WiseWebApiAdapter } = require('../../../../plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs')
const { createK3WiseSqlServerChannel } = require('../../../../plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs')
const {
  K3WISE_MATERIAL_LIST_B4_TEMPLATE,
} = require('../../../../plugins/plugin-integration-core/lib/read-source-k3-material-list-b4-contract.cjs')
const { normalizeReadSourceConfig } = require('../../../../plugins/plugin-integration-core/lib/read-source-config.cjs')
const { __internals: { contentKeyFor } } = require('../../../../plugins/plugin-integration-core/lib/read-source-config-store.cjs')
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

  // `upsertResult` / `bomUpsertResult` are gone: E4 makes both writes unreachable, so there is no
  // result object to carry into the evidence compiler (see the note at step 8).
  let sqlReadResult, sqlWriteRejected
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

    // 6. E4 FENCE PROOF — K3 Material write is PERMANENTLY REFUSED.
    //
    // CONVERTED (E4 / G-4). This asserted `written === 2` against the mock. Layer 4 of the
    // permanent fence now refuses inside the adapter's `upsert`, ahead of `login()`, so the two
    // Saves cannot happen — and neither can the login that would have preceded them.
    //
    // The zero-call proof is a DELTA, not an absolute: step 5a's testConnection legitimately put
    // calls on the mock already. Measuring the delta is what makes "0 login, 0 Save" attributable
    // to THIS attempt rather than to an idle server.
    const callsBeforeMaterialWrite = mockK3.calls.length
    const materialRefusal = await k3Adapter.upsert({
      object: 'material',
      records: [
        { FNumber: 'MAT-MOCK-001', FName: 'Mock material A' },
        { FNumber: 'MAT-MOCK-002', FName: 'Mock material B' },
      ],
      keyFields: ['FNumber'],
      // The request-parameter enablement surface §10.1 names, tried at its most permissive.
      options: { autoSubmit: true, autoAudit: true },
    }).then(() => null, (error) => error)
    assert(materialRefusal, 'E4: the K3 material write must be REFUSED, never performed')
    assert(
      materialRefusal.details?.code === 'K3_WISE_EXTERNAL_WRITE_DISABLED',
      `E4: expected the fixed code K3_WISE_EXTERNAL_WRITE_DISABLED, got ${materialRefusal.details?.code}`,
    )
    const materialAttemptCalls = mockK3.calls.slice(callsBeforeMaterialWrite)
    assert(
      materialAttemptCalls.length === 0,
      `E4: a refused write must reach K3 ZERO times (login included), got ${JSON.stringify(materialAttemptCalls.map((c) => c.pathname))}`,
    )
    assert(
      mockK3.calls.filter((call) => call.pathname === '/K3API/Material/Save').length === 0,
      'E4: zero Material/Save calls across the whole run',
    )
    assert(
      mockK3.calls.filter((call) => call.pathname === '/K3API/Login').length === 0
        || materialAttemptCalls.every((call) => call.pathname !== '/K3API/Login'),
      'E4: the refusal precedes login — no login attributable to the write',
    )
    assert(
      mockK3.calls.filter((call) => call.pathname === '/K3API/Material/Submit').length === 0,
      'E4: zero Material/Submit calls',
    )
    assert(
      mockK3.calls.filter((call) => call.pathname === '/K3API/Material/Audit').length === 0,
      'E4: zero Material/Audit calls',
    )
    console.log('✓ step 6: K3 material write PERMANENTLY REFUSED (K3_WISE_EXTERNAL_WRITE_DISABLED); 0 login, 0 Save, 0 Submit, 0 Audit')

    // 6b. E4 FENCE PROOF — the ban is CONNECTOR-WIDE, not material-only.
    //
    // CONVERTED (E4 / G-4). This asserted a BOM Save reached the mock and inspected the v1 Data
    // template payload on the wire. The BOM write leg is refused by the same layer-4 fence, so
    // there is no wire payload to inspect. Keeping this step matters precisely because it proves
    // the fence is not scoped to the profiled material object: BOM, which was never behind the
    // named-profile guard, is refused identically.
    const callsBeforeBomWrite = mockK3.calls.length
    const bomRefusal = await k3Adapter.upsert({
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
      options: { autoSubmit: true, autoAudit: true },
    }).then(() => null, (error) => error)
    assert(bomRefusal, 'E4: the K3 BOM write must be REFUSED, never performed')
    assert(
      bomRefusal.details?.code === 'K3_WISE_EXTERNAL_WRITE_DISABLED',
      `E4: expected the fixed code for BOM too, got ${bomRefusal.details?.code}`,
    )
    const bomAttemptCalls = mockK3.calls.slice(callsBeforeBomWrite)
    assert(
      bomAttemptCalls.length === 0,
      `E4: the refused BOM write must reach K3 ZERO times, got ${JSON.stringify(bomAttemptCalls.map((c) => c.pathname))}`,
    )
    for (const bomPath of ['/K3API/BOM/Save', '/K3API/BOM/Submit', '/K3API/BOM/Audit']) {
      assert(
        mockK3.calls.filter((call) => call.pathname === bomPath).length === 0,
        `E4: zero ${bomPath} calls across the whole run`,
      )
    }
    // The Save BODY the old assertions read off the wire is still covered, off the wire, by
    // k3-save-body-composer.parity.test.cjs (route preview ≡ the adapter's own buildSaveBody).
    console.log('✓ step 6b: K3 BOM write PERMANENTLY REFUSED too — the ban is connector-wide; 0 login, 0 BOM Save/Submit/Audit')

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

    // 7d. THE RULED CHAIN, as far as it now goes: 读 → 清洗 → C6 dry-run → (NO token) →
    // apply PERMANENTLY REFUSED. Every hop is still the REAL module — the C6 planner, the C6 K3
    // write profile, the K3 adapter over real HTTP to the mock server. The only fakes are the
    // wire's far end and the token store.
    //
    // CONVERTED (E4 / G-4). Three things changed and each is asserted rather than dropped:
    //   * the dry-run no longer mints an approval token and is never `ready` — for a permanently
    //     refused target, `canApply: true` would be a lie a human is asked to approve;
    //   * the Save leg becomes a refusal, driven with a token seeded straight into the store (the
    //     realistic in-flight case: a token minted before the fence shipped, still inside its
    //     TTL). The token must survive the refusal UNCONSUMED;
    //   * the value-verified GetDetail read-back cannot exist, because the mock's GetDetail only
    //     serves what a Save wrote. It is replaced by the stronger end-to-end fact: K3's OWN
    //     STATE says the material is absent — the fence is proven from the far side of the wire,
    //     not just from our call counters.
    //
    // Everything read-only in this block STAYS, and that is the point: §15.2 E4-05 requires the
    // read/plan path to keep working, and a blanket deny would take this whole step out.
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
        options: { source: { filters: { fixtureScope: 'approved' } } },
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
                // The row a genuine mint produces: ratified content + this environment's
                // systemId, with the contentKey computed by the STORE's own function (review
                // P2-E4 — the gate compares content keys, so a hand-written one would make the
                // demo prove nothing).
                const demoConfig = { ...K3WISE_MATERIAL_LIST_B4_TEMPLATE, systemId: 'source_demo' }
                const row = {
                  id: 'rsc_demo_b4', tenantId: 'tenant_demo', workspaceId: null,
                  object: 'material', status: 'approved', version: 1,
                  contentKey: contentKeyFor(normalizeReadSourceConfig(demoConfig)),
                  config: demoConfig,
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
            targetSystemId: chainTarget.id,
            // REVIEW P2-2 (owner ruling 20260806): this demo ran the ENTIRE C6 write lifecycle with the
            // instance-identity gate STRUCTURALLY ABSENT — the b4 scope had no digest function and the
            // gate was opt-in, so it silently did not run. The shipped offline PoC therefore "proved" a
            // write path whose identity check was not there.
            //
            // Here the read record and the write target are the SAME physical K3 (one mock server, one
            // account set), so their digests must be EQUAL — which is what the gate should conclude,
            // rather than being skipped. Derived as production does: length-prefixed (kind, origin,
            // acctId), fail-closed to null on any missing part.
            async instanceDigestOf(input = {}) {
              const id = typeof input === 'string' ? input : input.id
              const system = id === chainTarget.id
                ? chainTarget
                : { kind: chainTarget.kind, config: { baseUrl: chainTarget.config.baseUrl }, credentials: chainTarget.credentials }
              if (!system || typeof system.kind !== 'string' || !system.kind) return null
              let origin
              try {
                origin = new URL((system.config && system.config.baseUrl) || '').origin
              } catch {
                return null
              }
              const c = (system.credentials && typeof system.credentials === 'object') ? system.credentials : {}
              const acct = [c.acctId, c.accountSet, c.accountSetId].find((v) => v !== undefined && v !== null && v !== '')
              if (acct === undefined) return null
              const material = [system.kind, origin, String(acct)].map((part) => `${part.length}:${part}`).join('|')
              return createHmac('sha256', DEMO_INSTANCE_KEY).update(material).digest('hex')
            },
          },
        }),
        targetWriteProfile: K3_WISE_C6_WRITE_PROFILE,
        tokenStore,
        dryRunUser: 'demo-operator',
        dataSourceOwnerPrincipal: 'demo-owner',
        maxRows: K3_WISE_C6_MAX_APPLY_ROWS,
      })

      // --- READ + CLEAN + PLAN: unchanged, and required to stay green (E4-05) -----------------
      const callsBeforeDryRun = mockK3.calls.length
      const chainDryRun = await dryRunExternalWrite(chainInputs())
      assert(chainDryRun.counts.sourceRows === 1, 'the source read must still return the row')
      assert(chainDryRun.counts.add === 1, 'a new material must still plan as add')
      assert(chainDryRun.counts.failed === 0, 'the plan must have no failed rows')
      // ANTI-BLANKET-DENY: the planner's per-row lookup is a REAL HTTP GetDetail round trip
      // against the mock. If the fence had been implemented as a blanket deny, this would be
      // zero and the whole "the read path still works" claim would be hollow.
      const dryRunCalls = mockK3.calls.slice(callsBeforeDryRun)
      assert(
        dryRunCalls.some((call) => call.pathname === '/K3API/Material/GetDetail'),
        'E4-05: the C6 dry-run must still reach K3 GetDetail — the fence must not be a blanket deny',
      )
      assert(
        dryRunCalls.some((call) => call.pathname === '/K3API/Login'),
        'E4-05: the READ path is still allowed to authenticate — the ban is on writes, not on reads',
      )
      assert(/^[0-9a-f]{64}$/.test(String(chainDryRun.revision)), 'a real dry-run revision must still be computed')

      // --- APPLY AUTHORISATION: E4 removes it -------------------------------------------------
      assert(chainDryRun.status === 'not_applyable',
        `E4: a K3 plan is never "ready", got ${chainDryRun.status}`)
      assert(chainDryRun.canApply === false, 'E4: canApply must be false for a permanently refused target')
      assert(chainDryRun.dryRunToken === null, 'E4: no approval token may be minted for a K3 target')
      assert(chainDryRun.externalWriteApply?.permanentlyRefused === true,
        'E4: the plan must carry the values-free permanent-refusal marker')
      assert(chainDryRun.externalWriteApply?.refusalCode === 'K3_WISE_EXTERNAL_WRITE_DISABLED',
        'E4: the marker must carry the fixed code')

      // --- SAVE LEG: refused, and the token is NOT consumed -----------------------------------
      // Seed a token that WOULD otherwise be presentable — the in-flight case a deployment of
      // this fence actually meets. The refusal is the first statement of applyExternalWrite,
      // ahead of consumeDryRunToken, so a refused apply must not burn it.
      const seededToken = 'demo-preexisting-token'
      const seededTokenKey = `integration:c6-write-dry-run-token:${seededToken}`
      await tokenStore.set(seededTokenKey, {
        pipelineId: chainPipeline.id,
        tenantId: chainPipeline.tenantId,
        workspaceId: chainPipeline.workspaceId ?? null,
        dryRunUser: 'demo-operator',
        dataSourceOwnerPrincipal: 'demo-owner',
        revision: chainDryRun.revision,
        counts: chainDryRun.counts,
        maxRows: K3_WISE_C6_MAX_APPLY_ROWS,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      })
      const callsBeforeApply = mockK3.calls.length
      const chainRefusal = await applyExternalWrite({
        ...chainInputs(),
        dryRunToken: seededToken,
        applyUser: 'demo-operator',
      }).then(() => null, (error) => error)
      assert(chainRefusal, 'E4: the chain apply must be REFUSED')
      assert(chainRefusal.code === 'K3_WISE_EXTERNAL_WRITE_DISABLED',
        `E4: expected the fixed code, got ${chainRefusal.code}`)
      assert(chainRefusal.status === 403, `E4: the refusal must be a 403, got ${chainRefusal.status}`)
      assert(await tokenStore.get(seededTokenKey),
        'E4: an early refusal must leave the dry-run token UNCONSUMED')
      const applyCalls = mockK3.calls.slice(callsBeforeApply)
      assert(applyCalls.length === 0,
        `E4: the refused apply must reach K3 ZERO times, got ${JSON.stringify(applyCalls.map((c) => c.pathname))}`)

      // --- THE FAR SIDE OF THE WIRE: K3's own state says nothing was written ------------------
      // Stronger than a call counter: the mock's GetDetail serves only what a Save actually
      // stored, so a business-level MISS here is K3 itself confirming the chain wrote nothing.
      // It is also E4-06 in demo context — a READ failure must surface a READ-ONLY code and must
      // never be swallowed into the write-fence code.
      const readBackAdapter = createK3WiseWebApiAdapter({ system: chainTarget, fetchImpl: globalThis.fetch })
      let chainReadBackCode = null
      try {
        await readBackAdapter.read({ object: 'material', filters: { FNumber: 'MAT-CHAIN-001' } })
      } catch (error) {
        chainReadBackCode = error?.details?.code ?? null
      }
      assert(chainReadBackCode === 'K3_WISE_READ_BUSINESS_ERROR',
        `E4: the never-written material must read as a business-level miss, got ${chainReadBackCode}`)
      assert(chainReadBackCode !== 'K3_WISE_EXTERNAL_WRITE_DISABLED',
        'E4-06: a READ failure must never be reported as the write fence')

      // Discriminating control for the read channel itself: the SAME read against an
      // unmistakably absent key must fail the SAME way. If GetDetail were broken (rather than
      // simply empty), both would still miss — so this pairs with the positive GetDetail round
      // trip asserted during the dry-run above, which is what proves the channel is alive.
      let neverSavedCode = null
      try {
        await readBackAdapter.read({ object: 'material', filters: { FNumber: 'MAT-NEVER-SAVED' } })
      } catch (error) {
        neverSavedCode = error?.details?.code ?? null
      }
      assert(neverSavedCode === 'K3_WISE_READ_BUSINESS_ERROR', 'a never-saved material must be a business-level read miss')

      const chainSaves = mockK3.calls.filter((call) => /\/Save$/.test(call.pathname))
      const chainSubmits = mockK3.calls.filter((call) => /\/(Submit|Audit)$/.test(call.pathname))
      assert(chainSaves.length === 0, 'E4: the FULL chain must reach 0 Save calls')
      assert(chainSubmits.length === 0, 'E4: the FULL chain must reach 0 Submit, 0 Audit')
      console.log('✓ step 7d: RULED CHAIN — read → clean → dry-run (real GetDetail round trip) → NO token → apply REFUSED (token unconsumed) → K3 state confirms nothing written; 0 Save/Submit/Audit')
    } catch (error) {
      throw new Error(`ruled-chain end-to-end failed: ${error.message}`)
    }

    // 8-9. Compose evidence + run compiler
    //
    // CONVERTED (E4 / G-4) — disposition (a) of the two the conversion contract offered: KEEP the
    // compiler leg, with a clearly-labeled synthetic packet.
    //
    // Why keep it. This leg never tested the write; it tested `buildEvidenceReport`'s SECTION
    // CONTRACT — that a complete evidence packet compiles to PASS with 0 issues. Every value it
    // consumed was already a mock literal (`mock-save-001`, `PRODUCT-TEST-001`,
    // `mock://gate-archive`); the only pieces that came from a live object were `written` (2 and
    // 1) and the mock's own `externalId`/`billNo` echoes (`mock-<FNumber>` / `<FNumber>`), which
    // are themselves literals the mock hard-codes. Retiring the leg would therefore delete real
    // coverage of the compiler and buy nothing.
    //
    // WHAT THIS PACKET IS NOT. It is NOT evidence that a write happened. The write legs are
    // permanently refused (steps 6, 6b, 7d) and this packet is a fixture that stands in for what
    // a pre-fence run would have produced, so the compiler's contract stays exercised. The three
    // write-derived sections below are marked SYNTHETIC for exactly that reason. Nothing here is
    // read back from K3 and nothing here is used as a gate input.
    const SYNTHETIC_MATERIAL_SAVE_ROWS = [
      { materialCode: 'MAT-MOCK-001', externalId: 'mock-MAT-MOCK-001', billNo: 'MAT-MOCK-001' },
      { materialCode: 'MAT-MOCK-002', externalId: 'mock-MAT-MOCK-002', billNo: 'MAT-MOCK-002' },
    ]
    const evidence = {
      gate: { status: 'pass', archivePath: 'mock://gate-archive' },
      connections: {
        plm: { status: 'pass', requestId: 'mock-plm-conn' },
        k3Wise: { status: 'pass', requestId: 'mock-k3-conn' },
        sqlServer: { status: 'pass', requestId: 'mock-sql-conn' },
      },
      materialDryRun: { status: 'pass', runId: 'mock-dry-001', rowsPreviewed: 2 },
      // SYNTHETIC (E4): stands in for a pre-fence Save run. No write occurred.
      materialSaveOnly: {
        status: 'pass',
        runId: 'mock-save-001',
        rowsWritten: SYNTHETIC_MATERIAL_SAVE_ROWS.length,
        autoSubmit: false,
        autoAudit: false,
        k3Records: SYNTHETIC_MATERIAL_SAVE_ROWS.map((r) => ({ ...r })),
      },
      // SYNTHETIC (E4): derived from the packet above, not from a live write result.
      erpFeedback: {
        status: 'pass',
        runId: 'mock-feedback-001',
        rowsUpdated: SYNTHETIC_MATERIAL_SAVE_ROWS.length,
        fieldsUpdated: ['erpSyncStatus', 'erpExternalId', 'erpBillNo', 'erpResponseCode', 'erpResponseMessage', 'lastSyncedAt'],
        updatedRows: SYNTHETIC_MATERIAL_SAVE_ROWS.map((r) => ({
          materialCode: r.materialCode,
          erpSyncStatus: 'synced',
          erpExternalId: r.externalId,
          erpBillNo: r.billNo,
          erpResponseCode: 'OK',
          erpResponseMessage: 'K3 WISE save succeeded',
          lastSyncedAt: '2026-04-26T01:00:00.000Z',
        })),
      },
      deadLetterReplay: { status: 'pass', originalRunId: 'mock-fail-001', replayRunId: 'mock-replay-001' },
      // SYNTHETIC (E4): the BOM write is refused connector-wide (step 6b).
      bomPoC: {
        status: 'pass',
        runId: 'mock-bom-001',
        productId: 'PRODUCT-TEST-001',
        rowsWritten: 1,
        k3Records: [
          { bomNumber: 'MAT-MOCK-001', externalId: 'mock-bom-MAT-MOCK-001', billNo: 'MAT-MOCK-001' },
        ],
        legacyPipelineOptionsSourceProductId: false,
      },
      rollback: { status: 'pass', owner: 'mock-admin', evidence: 'TEST-prefixed mock records' },
      customerConfirmation: { status: 'pass', owner: 'mock-customer', confirmedAt: '2026-04-26T01:00:00.000Z' },
    }
    const report = buildEvidenceReport(packet, evidence, { generatedAt: '2026-04-26T01:00:00.000Z' })
    assert(report.decision === 'PASS', `expected PASS, got ${report.decision}`)
    assert(report.issues.length === 0, `expected 0 issues, got ${report.issues.length}: ${JSON.stringify(report.issues)}`)
    console.log('✓ step 8-9: evidence compiler returned PASS with 0 issues (SYNTHETIC write sections — this leg tests buildEvidenceReport\'s contract only; the write legs are permanently refused)')

  } finally {
    await mockK3.stop()
  }

  console.log('')
  console.log('✓ K3 WISE PoC mock chain verified end-to-end (PASS)')
  console.log('  PROVES: the READ chain works end to end over real HTTP (testConnection, SQL')
  console.log('          readonly probe, stock-prep intake, C6 read → clean → dry-run with a real')
  console.log('          GetDetail round trip), AND that K3 external write-back is PERMANENTLY')
  console.log('          REFUSED (E4 / G-4, K3_WISE_EXTERNAL_WRITE_DISABLED) at material, BOM and')
  console.log('          C6-apply entry points — 0 login, 0 Save, 0 Submit, 0 Audit, and a')
  console.log('          pre-seeded approval token left unconsumed.')
  console.log('  DOES NOT PROVE: any write. There is no write left to prove; the evidence')
  console.log('          compiler leg runs on a clearly-labeled SYNTHETIC packet.')
  console.log('  Note: mock pass ≠ customer live pass. See fixtures/README.md.')
}

main().catch((error) => {
  console.error('✗ K3 WISE PoC mock chain FAILED')
  console.error(error)
  process.exit(1)
})
