/**
 * Batch-refresh step 4 PR-6 — real-Postgres proof that the GENERIC CONFIGURED WRITERS refuse a GOVERNED stock-prep
 * sheet (plugins/plugin-integration-core/lib/stock-preparation-governed-sheet-probe.cjs; design §7.1 rows 17-18,
 * D-21; F-6). The review of #6550 (V50B-12) showed the generic `metasheet:multitable` target adapter writing a
 * governed, suspended pilot sheet on real PG (`upsert ok, written 1, mainRowsAdded 1`); these cases invert it.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationGenericWriterGovernanceRealDbCases()` registers its
 * `describe` block and is called from the already-wired stock-prep real-DB host
 * (tests/integration/stock-preparation-p4-repair-once-realdb.test.ts), so the cases run in the existing "Run
 * multitable real-DB integration" step of .github/workflows/plugin-tests.yml without a workflow edit (the pushing
 * token has no `workflow` scope). Do NOT also list it as a standalone file in that step, or it runs twice.
 *
 * Everything below is REAL: the host's plugin context (MetaSheetServer.createPluginContext — records, provisioning,
 * plugin_kv storage, the plugin database binding), a real sandbox project sheet provisioned through the plugin, the
 * registry store and the continuation store over that database binding (as index.cjs wires them), the probe built
 * from them, and the REAL generic writers — the target adapter, the C6 write-source driven through the real C6
 * dry-run / apply lifecycle, and the ERP feedback writer over the real provisioning. Governance is seeded THROUGH THE
 * STORE (a real candidate hold reconciliation; a real confirm); the end of a relationship is the one SQL step.
 *
 *   S6-01 (V50B-12 inverted) a pilot project with one open candidate hold: the generic adapter with the reviewer's
 *         config (object key `main`, no projectId — the ownership guard inactive) => 409
 *         METASHEET_MULTITABLE_STOCK_PREP_GOVERNED_SHEET; meta_records and meta_record_revisions unchanged; every
 *         step-4 row byte-identical.
 *   S6-02 the pilot exited (three columns cleared) with the hold still open => still refused (`hold`, C10); the hold
 *         resolved by a real confirm and the relationship ended => still refused by the ENDED header (`continuation`).
 *   S6-03 a registered, NOT pilot project with no step-4 rows => the same upsert writes exactly one row, the same
 *         answer a probe-less adapter gives on a twin sheet; an unregistered plain sandbox sheet => writes.
 *   S6-04 the ERP feedback writer over the REAL provisioning (findObjectSheet resolving the governed project sheet)
 *         => ERP_FEEDBACK_GOVERNED_SHEET_REFUSED, nothing written; the same writer against the non-governed sheet
 *         => written 1.
 *   S6-05 the C6 lifecycle (lib level, the real write-source + MULTITABLE_WRITE_PROFILE + the real plugin_kv token
 *         store): dry-run on the governed sheet => 409, zero `integration:c6-write-dry-run-token:` rows; a token
 *         minted before the hold was seeded => apply 409, the token row gone, zero meta_records writes.
 *   S6-06 the step-4 tables absent from the store binding (42P01 — a pre-102/103 database; the registry readable,
 *         the S3B-06 search_path technique) => 503 STOCK_PREP_REFRESH_STORE_FAILED `continuation` 42P01 on the upsert
 *         and on the C6 dry-run; nothing written, no token.
 *   S6-07 the tenant: another tenant's registered, NOT governed sheet => written (today's behaviour, plan Q-2);
 *         governed => 409 with `tenantMismatch: true`.
 *   S6-08 (R-66, owner 2026-10-28) a PLM row the generic adapter wrote on a provisioned sheet: the REAL plugin-scoped
 *         records.deleteRecord and the REAL unscoped host SDK answer 409 RECORD_DELETE_REFUSED_PLM_ROW, the row
 *         stays; a keyless row on the same sheet deletes (control).
 * Values-free: every id is synthetic and per-run.
 */
import { createRequire } from 'module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PoolClient } from 'pg'
import { afterAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')

const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const adapterLib = require(path.join(PLUGIN_LIB, 'adapters/metasheet-multitable-target-adapter.cjs')) as any
const { dryRunExternalWrite, applyExternalWrite } = require(path.join(PLUGIN_LIB, 'external-write-dry-run.cjs')) as any
const { createMultitableFeedbackWriter, createErpFeedbackWriter } = require(path.join(PLUGIN_LIB, 'erp-feedback.cjs')) as any
const probeLib = require(path.join(PLUGIN_LIB, 'stock-preparation-governed-sheet-probe.cjs')) as any
const continuationStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-store.cjs')) as any
const projectTargetStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-target-store.cjs')) as any
const projectTargetsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-targets.cjs')) as any
const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
const lockModule = require(path.join(PLUGIN_LIB, 'stock-preparation-project-write-lock.cjs')) as any
const { ensureStockPreparationSandboxTarget } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any
const { syncStockPreparationContractOptionsForObject } = require(path.join(PLUGIN_LIB, 'stock-preparation-option-sync.cjs')) as any
const refreshKit = require(path.join(REPO_ROOT, 'plugins/plugin-integration-core/__tests__/support/stock-preparation-refresh-store-kit.cjs')) as any

const { REFRESH_STORE_TABLES: RT } = continuationStoreLib
const { GOVERNED_SHEET_WRITE_CODES: CODES } = probeLib
const { PROJECT_WRITE_LOCK_TABLE, PROJECT_WRITE_ERROR_CODES } = lockModule

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const TOKEN_PREFIX = 'integration:c6-write-dry-run-token:'

// The scoped db over the HOST's plugin database binding shape (query on a pooled connection; a transaction on its
// own client), as the other stock-prep real-DB cases build it.
function hostLikeDb() {
  return createDb({
    database: {
      query: async (sql: string, params?: unknown[]) => (await q(sql, params)).rows,
      transaction: async <T>(callback: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown>; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>): Promise<T> => {
        const client = await poolManager.get().getInternalPool().connect()
        try {
          await client.query('BEGIN')
          const result = await callback({ query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows, commit: async () => {}, rollback: async () => {} })
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw error
        } finally {
          client.release()
        }
      },
    },
  })
}

// The scoped db over ONE raw client (S6-06 pins its search_path).
function dbOn(client: PoolClient) {
  return createDb({
    database: {
      query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows,
      transaction: async <T>(callback: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown>; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>): Promise<T> => {
        await client.query('BEGIN')
        try {
          const result = await callback({ query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows, commit: async () => {}, rollback: async () => {} })
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw error
        }
      },
    },
  })
}

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'generic-writer-governance-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-generic-writer-governance',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

export function defineStockPreparationGenericWriterGovernanceRealDbCases(): void {
  test('generic writer governance real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the PR-6 generic writer governance cases would skip-green')
    }
  })

  describeIfDatabase('S6 generic configured writers refuse governed stock-prep sheets (real Postgres, PR-6)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const TENANT_PREFIX = `tenant_s6_${TOKEN}`
    const sheets: string[] = []
    const tenantFor = (label: string) => `${TENANT_PREFIX}_${label}`

    afterAll(async () => {
      const like = `${TENANT_PREFIX}%`
      for (const table of [RT.member, RT.continuation, RT.hold, RT.execution, RT.state, 'integration_stock_prep_project_target']) {
        await q(`DELETE FROM ${table} WHERE tenant_id LIKE $1`, [like]).catch(() => {})
      }
      for (const sheetId of sheets) {
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
    })

    async function sheetState(sheetId: string) {
      const rows = (await q('SELECT id, version FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheetId])).rows
      const revisions = Number((await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1', [sheetId])).rows[0].n)
      return { count: rows.length, rows: rows.map((row: any) => `${row.id}@${row.version}`), revisions }
    }
    async function stepFour(sheetId: string) {
      const out: unknown[] = []
      for (const table of [RT.continuation, RT.member, RT.hold, RT.state, RT.execution]) out.push((await q(`SELECT * FROM ${table} WHERE sheet_id = $1 ORDER BY id`, [sheetId])).rows)
      return JSON.stringify(out)
    }
    const tokenRows = async () => Number((await q(`SELECT count(*)::int AS n FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE $1`, [`${TOKEN_PREFIX}%`])).rows[0].n)

    // The confirm transaction's lock bump, as the S2 cases stand it in for PR-4's `bumpGenerationWithin`.
    async function testBumpWithin(trx: any, scopeKey: string, { tenantId }: { reason: string; tenantId: string }) {
      const token = `tok_s6_${TOKEN}_${Math.random().toString(36).slice(2)}`
      const row = await trx.selectOneForUpdate(PROJECT_WRITE_LOCK_TABLE, { scope_key: scopeKey })
      if (!row) {
        await trx.insertOne(PROJECT_WRITE_LOCK_TABLE, { scope_key: scopeKey, tenant_id: tenantId, generation: 1, generation_token: token, generation_reason: 'small_preview', generation_bumped_at: new Date(), fencing_epoch: 0 })
        return { generation: 1, generationToken: token, fencingEpoch: 0 }
      }
      if (row.lease_id) throw Object.assign(new Error('live lease'), { status: 409, code: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED })
      await trx.updateRow(PROJECT_WRITE_LOCK_TABLE, { generation: Number(row.generation) + 1, generation_token: token, generation_bumped_at: new Date() }, { scope_key: scopeKey, lease_id: null, generation_token: row.generation_token })
      return { generation: Number(row.generation) + 1, generationToken: token, fencingEpoch: Number(row.fencing_epoch) }
    }

    // One real project sheet (provisioned through the plugin), its registry row (optional, optionally pilot), and the
    // probe built as index.cjs builds it: both stores over the plugin's database binding.
    async function stack(label: string, { register = true, pilot = false, registryTenant }: { register?: boolean; pilot?: boolean; registryTenant?: string } = {}) {
      const fixture = await refreshKit.candidateHoldFixture()
      const tenantId = tenantFor(label)
      const projectNo: string = fixture.projectNo
      const projectId = `${tenantId}:integration-core`
      const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
      const pluginContext = createProductionPluginContext()
      const multitable: any = pluginContext.api.multitable
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
      const sheetId: string = ensured.target.sheetId
      sheets.push(sheetId)
      const db = createDb({ database: pluginContext.api.database })
      const registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db })
      const registeredTenant = registryTenant || tenantId
      if (register) await registry.create({ tenantId: registeredTenant, projectNo, sheetId, objectId, createdBy: 'syn' })
      if (register && pilot) await q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = now(), pilot_enabled_by = $3, pilot_readiness_version = 1 WHERE tenant_id = $1 AND project_no = $2', [registeredTenant, projectNo, 'u_s6_admin'])
      const store = continuationStoreLib.createStockPreparationContinuationStore({ db })
      const probe = probeLib.createStockPreparationGovernedSheetProbe({ continuationStore: store, projectTargetStore: registry })
      const fields = ensured.target.fieldIdMap || {}
      const names = ['idempotencyKey', 'projectNo', 'componentSourceId', 'material', 'active'].filter((name) => fields[name])
      // The reviewer's (V50B-12) generic config: a free-text object key, no projectId.
      const system = {
        id: `es_s6_${label}_${TOKEN}`, tenantId, kind: 'metasheet:multitable', role: 'target',
        config: { objects: { main: { sheetId, keyFields: ['idempotencyKey'], mode: 'upsert', fieldIdMap: Object.fromEntries(names.map((name) => [name, fields[name]])), fields: names.map((name) => ({ name })) } } },
      }
      const scope = { tenantId, sheetId, projectNo }
      return {
        fixture, tenantId, projectNo, projectId, objectId, sheetId, pluginContext, multitable, registry, store, probe, system, scope,
        record: (suffix: string) => ({ idempotencyKey: `s6-generic-${label}-${suffix}-${TOKEN}`, projectNo, componentSourceId: `X-S6-${suffix}`, material: 'M-GENERIC', active: true }),
        adapter: (governedSheetProbe: any = probe, sys: any = system) => adapterLib.createMetaSheetMultitableTargetAdapter({ system: sys, context: { api: { multitable } }, governedSheetProbe }),
        seedHold: () => store.reconcileHolds({ ...scope, decisionVersionObserved: 0, holds: [fixture.hold], computation: { lane: 'small_preview', suspended: true, generationToken: 'g_s6', sourceContentDigest: 'src_s6' } }),
        pilotExit: () => q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = NULL, pilot_enabled_by = NULL, pilot_readiness_version = NULL WHERE tenant_id = $1 AND project_no = $2', [registeredTenant, projectNo]),
      }
    }

    test('S6-01 (V50B-12 inverted) pilot project + one open candidate hold: the generic adapter with the reviewer config is refused 409 before any write; meta_records / revisions and every step-4 row unchanged', async () => {
      const st = await stack('s01', { pilot: true })
      await st.seedHold()
      const main0 = await sheetState(st.sheetId)
      const four0 = await stepFour(st.sheetId)
      const result = await settle(st.adapter().upsert({ object: 'main', records: [st.record('a')] }))
      const observed = {
        upsert: result.ok ? 'written' : `${result.error.status}:${result.error.code}:${result.error.details.surface}:${result.error.details.reason}:${result.error.details.object}`,
        mainUnchanged: JSON.stringify(await sheetState(st.sheetId)) === JSON.stringify(main0),
        stepFourUnchanged: (await stepFour(st.sheetId)) === four0,
      }
      console.log(`[S6-01] ${JSON.stringify(observed)}`)
      expect(observed).toEqual({ upsert: `409:${CODES.REFUSED}:pipeline_upsert:pilot:main`, mainUnchanged: true, stepFourUnchanged: true })
    }, 300000)

    test('S6-02 pilot exited with the hold still open => refused (hold, C10); the hold resolved by a real confirm and the relationship ended => refused by the ENDED header (continuation)', async () => {
      const st = await stack('s02', { pilot: true })
      await st.seedHold()
      await st.pilotExit()
      const main0 = await sheetState(st.sheetId)
      const afterExit = await settle(st.adapter().upsert({ object: 'main', records: [st.record('a')] }))
      const holdRow = (await q(`SELECT id FROM ${RT.hold} WHERE sheet_id = $1 AND status = 'open'`, [st.sheetId])).rows[0]
      await st.store.confirmContinuation({ ...st.scope, holdId: holdRow.id, echo: refreshKit.echoOf(st.fixture.hold), basis: { kind: 'puller_confirmed_same_demand' }, confirmedBy: 'u_s6_puller', sourceIdentity: st.fixture.sourceIdentity }, { bumpWithin: testBumpWithin, pilotWithin: refreshKit.seedPilotWithin })
      // The relationship's END (the one SQL step: the end transaction's row shape, CHECK-enforced) and no other row.
      await q(`UPDATE ${RT.member} SET claim_active = false WHERE sheet_id = $1`, [st.sheetId])
      await q(`UPDATE ${RT.continuation} SET status = 'ended', claim_active = false, status_reason = 'source_scope_changed', ended_at = now(), ended_outcome = 'release_to_normal_refresh', ended_by = 'u_s6_puller' WHERE sheet_id = $1`, [st.sheetId])
      await q(`DELETE FROM ${RT.state} WHERE sheet_id = $1`, [st.sheetId])
      const left = (await q(`SELECT (SELECT count(*)::int FROM ${RT.continuation} WHERE sheet_id = $1 AND status = 'ended') AS ended, (SELECT count(*)::int FROM ${RT.continuation} WHERE sheet_id = $1 AND status <> 'ended') AS live, (SELECT count(*)::int FROM ${RT.hold} WHERE sheet_id = $1 AND status = 'open') AS open_holds, (SELECT count(*)::int FROM ${RT.state} WHERE sheet_id = $1) AS states, (SELECT count(*)::int FROM ${RT.execution} WHERE sheet_id = $1) AS executions`, [st.sheetId])).rows[0]
      const afterEnd = await settle(st.adapter().upsert({ object: 'main', records: [st.record('b')] }))
      const ans = (outcome: any) => (outcome.ok ? 'written' : `${outcome.error.status}:${outcome.error.code}:${outcome.error.details.reason}`)
      const observed = { afterExit: ans(afterExit), left, afterEnd: ans(afterEnd), mainUnchanged: JSON.stringify(await sheetState(st.sheetId)) === JSON.stringify(main0) }
      console.log(`[S6-02] ${JSON.stringify(observed)}`)
      expect(observed).toEqual({
        afterExit: `409:${CODES.REFUSED}:hold`,
        left: { ended: 1, live: 0, open_holds: 0, states: 0, executions: 0 },
        afterEnd: `409:${CODES.REFUSED}:continuation`,
        mainUnchanged: true,
      })
    }, 300000)

    test('S6-03 a registered, NOT pilot project with no step-4 rows writes exactly one row — the same answer a probe-less adapter gives on a twin sheet; an unregistered sandbox sheet writes', async () => {
      const registered = await stack('s03', { pilot: false })
      const twin = await stack('s03t', { register: false })
      const main0 = await sheetState(registered.sheetId)
      const probed = await registered.adapter().upsert({ object: 'main', records: [registered.record('a')] })
      const legacy = await twin.adapter(undefined).upsert({ object: 'main', records: [twin.record('a')] })
      const unregistered = await twin.adapter().upsert({ object: 'main', records: [twin.record('b')] })
      const shape = (result: any) => ({ written: result.written, skipped: result.skipped, failed: result.failed, statuses: result.results.map((entry: any) => entry.status), mode: result.metadata.mode })
      // The stored row read back through ITS sheet's logical field map (physical field ids differ per sheet), the
      // per-label idempotency key left out: what each adapter wrote, in logical terms.
      const stored = async (s: any, key: string) => {
        const map = s.system.config.objects.main.fieldIdMap as Record<string, string>
        const row = (await q(`SELECT data FROM meta_records WHERE sheet_id = $1`, [s.sheetId])).rows.find((entry: any) => Object.values(entry.data || {}).includes(key))
        if (!row) return null
        const logical: Record<string, unknown> = {}
        for (const [name, physical] of Object.entries(map)) if (name !== 'idempotencyKey' && Object.prototype.hasOwnProperty.call(row.data, physical)) logical[name] = row.data[physical]
        return logical
      }
      const observed = {
        probed: shape(probed),
        legacy: shape(legacy),
        unregistered: shape(unregistered),
        mainAdded: (await sheetState(registered.sheetId)).count - main0.count,
        probedRow: await stored(registered, registered.record('a').idempotencyKey),
        legacyRow: await stored(twin, twin.record('a').idempotencyKey),
      }
      console.log(`[S6-03] ${JSON.stringify(observed)}`)
      const one = { written: 1, skipped: 0, failed: 0, statuses: ['created'], mode: 'upsert' }
      expect(observed.probedRow).not.toBeNull()
      expect(Object.keys(observed.probedRow as object).length).toBeGreaterThan(0)
      expect(observed).toEqual({ probed: one, legacy: one, unregistered: one, mainAdded: 1, probedRow: observed.legacyRow, legacyRow: observed.legacyRow })
    }, 300000)

    test('S6-04 the ERP feedback writer over the REAL provisioning: the governed project sheet => ERP_FEEDBACK_GOVERNED_SHEET_REFUSED, nothing written; the non-governed sheet => written 1', async () => {
      const governed = await stack('s04', { pilot: true })
      const plain = await stack('s04p', { pilot: false })
      const main0 = await sheetState(governed.sheetId)
      const plain0 = await sheetState(plain.sheetId)
      // Every feedback field mapped onto a column the stock-prep sheet HAS, so the write would land (the default
      // ERP field names do not exist on a project sheet — a refusal must not be confused with a schema miss).
      const fieldMap = { status: 'material', externalId: 'material', billNo: 'material', responseCode: 'material', responseMessage: 'material', syncedAt: 'material' }
      const writeBack = (st: any) => createErpFeedbackWriter({ context: { api: { multitable: st.multitable } }, clock: () => '2026-10-26T00:00:00.000Z', governedSheetProbe: st.probe }).writeBack({
        tenantId: st.tenantId, runId: `run_s6_04_${TOKEN}`, workspaceId: null,
        pipeline: { id: 'pipe_s6_04', projectId: st.projectId, options: { erpFeedback: { objectId: st.objectId, keyField: 'idempotencyKey', fieldMap } } },
        cleanRecords: [{ sourceRecord: {}, targetRecord: { idempotencyKey: st.record('fb').idempotencyKey } }],
        writeResult: { results: [{ key: st.record('fb').idempotencyKey, externalId: 'ext_s6' }] },
      })
      const refused = await writeBack(governed)
      const control = await writeBack(plain)
      const writer = createMultitableFeedbackWriter({ context: { api: { multitable: plain.multitable } }, governedSheetProbe: plain.probe })
      const direct = await writer.updateRecords({ tenantId: plain.tenantId, projectId: plain.projectId, objectId: plain.objectId, keyField: 'idempotencyKey', updates: [{ key: plain.record('fb2').idempotencyKey, fields: { material: 'M-FEEDBACK' } }] })
      const observed = {
        refused: `${refused.ok}:${refused.reason}:${refused.code}`,
        governedUnchanged: JSON.stringify(await sheetState(governed.sheetId)) === JSON.stringify(main0),
        control: `${control.ok}:${control.skipped}:${control.result && control.result.written}:${control.result && control.result.sheetId === plain.sheetId}`,
        direct: `${direct.ok}:${direct.written}:${direct.created}`,
        plainAdded: (await sheetState(plain.sheetId)).count - plain0.count,
      }
      console.log(`[S6-04] ${JSON.stringify(observed)}`)
      expect(observed).toEqual({ refused: `false:ERP_FEEDBACK_GOVERNED_SHEET_REFUSED:${CODES.REFUSED}`, governedUnchanged: true, control: 'true:false:1:true', direct: 'true:1:1', plainAdded: 2 })
    }, 300000)

    // The C6 lifecycle at LIB level (the route-level proof is hermetic: http-routes H-01 / H-02).
    function c6Input(st: any, governedSheetProbe: any, extra: Record<string, unknown> = {}) {
      return {
        pipeline: {
          id: `pipe_s6_${st.tenantId}`, tenantId: st.tenantId, workspaceId: 'w_s6',
          sourceSystemId: 'src_s6', sourceObject: 'items', targetSystemId: st.system.id, targetObject: 'main', createdBy: 'owner_s6',
          options: { source: { filters: { fixtureScope: 's6' } } },
          fieldMappings: [
            { sourceField: 'k', targetField: 'idempotencyKey', validation: [{ type: 'required' }] },
            { sourceField: 'm', targetField: 'material' },
          ],
        },
        sourceSystem: { id: 'src_s6', kind: 'data-source:sql-readonly' },
        targetSystem: { id: st.system.id, kind: 'metasheet:multitable', config: { dataSourceId: 'mt_s6', object: 'main', keyFields: ['idempotencyKey'], writableFields: ['material'] } },
        sourceAdapter: { async read() { return { records: [{ k: st.record('c6').idempotencyKey, m: 'M-C6' }], done: true, nextCursor: null } } },
        dataSourceWrites: adapterLib.createMetaSheetMultitableWriteSource({ system: st.system, context: { api: { multitable: st.multitable } }, governedSheetProbe }),
        targetWriteProfile: adapterLib.MULTITABLE_WRITE_PROFILE,
        tokenStore: st.pluginContext.storage,
        dryRunUser: 'owner_s6',
        dataSourceOwnerPrincipal: 'owner_s6',
        maxRows: 100,
        ...extra,
      }
    }

    test('S6-05 the C6 lifecycle with the real write-source and plugin_kv: dry-run on the governed sheet => 409, no token row; a token minted before the hold => apply 409, the token row gone, zero meta_records writes', async () => {
      const st = await stack('s05', { pilot: false })
      const tokens0 = await tokenRows()
      // Not governed yet: a real dry-run mints a real plugin_kv token.
      const ready = await dryRunExternalWrite(c6Input(st, st.probe))
      const tokensMinted = (await tokenRows()) - tokens0
      await st.seedHold()
      const main0 = await sheetState(st.sheetId)
      const dryGoverned = await settle(dryRunExternalWrite(c6Input(st, st.probe)))
      const tokensAfterRefusedDry = (await tokenRows()) - tokens0
      const apply = await settle(applyExternalWrite({ ...c6Input(st, st.probe), dryRunToken: ready.dryRunToken, applyUser: 'owner_s6', runId: `run_s6_05_${TOKEN}` }))
      const ans = (outcome: any) => (outcome.ok ? `ok:${outcome.value.status}` : `${outcome.error.status}:${outcome.error.code}:${outcome.error.details && outcome.error.details.surface}`)
      const observed = {
        ready: `${ready.status}:${ready.canApply}`,
        tokensMinted,
        dryGoverned: ans(dryGoverned),
        tokensAfterRefusedDry,
        apply: ans(apply),
        tokensAfterApply: (await tokenRows()) - tokens0,
        mainUnchanged: JSON.stringify(await sheetState(st.sheetId)) === JSON.stringify(main0),
      }
      console.log(`[S6-05] ${JSON.stringify(observed)}`)
      expect(observed).toEqual({
        ready: 'ready:true',
        tokensMinted: 1,
        dryGoverned: `409:${CODES.REFUSED}:c6_target_test`,
        tokensAfterRefusedDry: 1,
        apply: `409:${CODES.REFUSED}:c6_target_test`,
        tokensAfterApply: 0,
        mainUnchanged: true,
      })
    }, 300000)

    test('S6-06 the step-4 tables ABSENT from the store binding (42P01; the registry readable): the upsert and the C6 dry-run answer 503 STORE_FAILED continuation 42P01; nothing written, no token', async () => {
      const st = await stack('s06', { pilot: false })
      const client = await poolManager.get().getInternalPool().connect()
      const schema = `s6_nostep4_${TOKEN}`
      try {
        await client.query(`CREATE SCHEMA ${schema}`)
        await client.query(`CREATE VIEW ${schema}.integration_stock_prep_project_target AS SELECT * FROM public.integration_stock_prep_project_target`)
        await client.query(`SET search_path TO ${schema}`)
        const binding = dbOn(client)
        const probe = probeLib.createStockPreparationGovernedSheetProbe({
          continuationStore: continuationStoreLib.createStockPreparationContinuationStore({ db: binding }),
          projectTargetStore: projectTargetStoreLib.createStockPreparationProjectTargetStore({ db: binding }),
        })
        const main0 = await sheetState(st.sheetId)
        const tokens0 = await tokenRows()
        const upsert = await settle(st.adapter(probe).upsert({ object: 'main', records: [st.record('a')] }))
        const dry = await settle(dryRunExternalWrite(c6Input(st, probe)))
        const ans = (outcome: any) => (outcome.ok ? 'written' : `${outcome.error.status}:${outcome.error.code}:${outcome.error.details.store}:${outcome.error.details.sqlState}`)
        const observed = { upsert: ans(upsert), dry: ans(dry), mainUnchanged: JSON.stringify(await sheetState(st.sheetId)) === JSON.stringify(main0), tokens: (await tokenRows()) - tokens0 }
        console.log(`[S6-06] ${JSON.stringify(observed)}`)
        const unreadable = `503:${CODES.STORE_FAILED}:continuation:42P01`
        expect(observed).toEqual({ upsert: unreadable, dry: unreadable, mainUnchanged: true, tokens: 0 })
      } finally {
        await client.query('RESET search_path').catch(() => {})
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
        client.release()
      }
    }, 300000)

    // R-66 ① (owner ruling 2026-10-28「管理员也不能删 PLM 行」, packages/core-backend/src/multitable/plm-row-delete-guard.ts):
    // the plugin SDK / host deleteRecord refuses a PLM row of a provisioned stock-preparation sheet. The row is
    // written as the pull writes it (the generic adapter's real upsert, a non-empty idempotency key); the delete goes
    // through the REAL plugin-scoped records API and the REAL unscoped host SDK. A keyless row on the same sheet is
    // the control (deleted as before); the overview port's delete is driven by D16 in the write-lock cases.
    test('S6-08 (R-66) the real plugin-scoped SDK and the host SDK cannot delete a PLM row of a provisioned sheet: 409 RECORD_DELETE_REFUSED_PLM_ROW, row intact; a keyless row deletes', async () => {
      const st = await stack('s08', { register: false })
      const written = await st.adapter().upsert({ object: 'main', records: [st.record('a')] })
      expect(written.written).toBe(1)
      const keyFieldId = (st.system.config.objects.main.fieldIdMap as Record<string, string>).idempotencyKey
      const plmRow = (await q('SELECT id FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3', [st.sheetId, keyFieldId, st.record('a').idempotencyKey])).rows[0]
      expect(plmRow?.id).toBeTruthy()
      const registry = (await q('SELECT 1 FROM plugin_multitable_object_registry WHERE sheet_id = $1', [st.sheetId])).rows.length
      const records = st.multitable.records as any
      const scoped = await settle(records.deleteRecord({ sheetId: st.sheetId, recordId: plmRow.id }))
      const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
      const coreSdk = (server as unknown as { createCoreAPI: () => { multitable: { records: any } } }).createCoreAPI().multitable.records
      const hostLevel = await settle(coreSdk.deleteRecord({ sheetId: st.sheetId, recordId: plmRow.id }))
      const ans = (outcome: any) => (outcome.ok ? 'deleted' : `${outcome.error.status}:${outcome.error.code}:${outcome.error.reason}`)
      const keyless = await records.createRecord({ sheetId: st.sheetId, data: {} })
      const control = await settle(records.deleteRecord({ sheetId: st.sheetId, recordId: keyless.id }))
      const observed = {
        registry,
        scoped: ans(scoped),
        hostLevel: ans(hostLevel),
        plmRowIntact: (await q('SELECT 1 FROM meta_records WHERE id = $1', [plmRow.id])).rows.length,
        control: ans(control),
        keylessGone: (await q('SELECT 1 FROM meta_records WHERE id = $1', [keyless.id])).rows.length === 0,
      }
      console.log(`[S6-08] ${JSON.stringify(observed)}`)
      expect(observed).toEqual({
        registry: 1,
        scoped: '409:RECORD_DELETE_REFUSED_PLM_ROW:plm_row',
        hostLevel: '409:RECORD_DELETE_REFUSED_PLM_ROW:plm_row',
        plmRowIntact: 1,
        control: 'deleted',
        keylessGone: true,
      })
    }, 300000)

    test('S6-07 another tenant\'s registered, NOT governed sheet => written (today, plan Q-2); governed => 409 with tenantMismatch', async () => {
      const st = await stack('s07', { pilot: false, registryTenant: tenantFor('s07_other') })
      const written = await st.adapter().upsert({ object: 'main', records: [st.record('a')] })
      await q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = now(), pilot_enabled_by = $2, pilot_readiness_version = 1 WHERE sheet_id = $1', [st.sheetId, 'u_s6_admin'])
      const main0 = await sheetState(st.sheetId)
      const refused = await settle(st.adapter().upsert({ object: 'main', records: [st.record('b')] }))
      const observed = {
        written: written.written,
        refused: refused.ok ? 'written' : `${refused.error.status}:${refused.error.code}:${refused.error.details.reason}:${refused.error.details.tenantMismatch === true}`,
        mainUnchanged: JSON.stringify(await sheetState(st.sheetId)) === JSON.stringify(main0),
      }
      console.log(`[S6-07] ${JSON.stringify(observed)}`)
      expect(observed).toEqual({ written: 1, refused: `409:${CODES.REFUSED}:pilot:true`, mainUnchanged: true })
    }, 300000)
  })
}
