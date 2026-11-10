/**
 * Batch-refresh step 6d-1b (S6-5; register row R-91) — real-Postgres proof of migration 107 (the component ruling
 * ledger), the ruling store through the REAL scoped db helper with the REAL audit store on one transaction, and the census
 * / remnant acknowledgement routes over a REAL project sheet (the host records API on meta_records) with readiness v5.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationComponentRulingRealDbCases()` registers its `describe`
 * block and is called from the already-wired stock-prep real-DB host
 * (tests/integration/stock-preparation-p4-repair-once-realdb.test.ts), so the cases run in the existing "Run multitable
 * real-DB integration" step of .github/workflows/plugin-tests.yml (aggregated into the required `test (20.x)`) without a
 * workflow edit. Do NOT also list it as a standalone file in that step.
 *
 *   S9D-107    migration 107 on the CI database (migrated fresh to head): the columns, NOT NULL and the defaults; every
 *              named CHECK refuses its wrong shape with 23514 under its own name; the partial UNIQUE is 23505 under its
 *              name and frees a revoked row; re-running the file over a POPULATED table changes nothing.
 *   S9D-107b   migration 107 on a database AT 106 WITH DATA: inside one transaction the table is dropped (the database is
 *              then exactly at 106, its 087-106 rows present), the file is applied, the table / every constraint / the
 *              index are back, a valid row inserts, and every 087-106 table holds exactly the rows it held; ROLLBACK.
 *   S9D-CR     the store on real PG: record + the audit row on ONE transaction (both present); a second active
 *              acknowledgement 409 with no second audit row; an audit hook that fails AFTER its own insert rolls back
 *              BOTH rows; revoke + its audit row; a second revoke 409.
 *   S9D-01r    (S9D-01 / S9D-04, the readiness and census legs) a real project sheet in the item-10 shape (D2): the
 *              tenant census counts it, the project census lists exactly its handle, readiness v5 refuses
 *              `no_unacknowledged_inactive_root_remnant`; an acknowledgement through the route (re-proved on the real
 *              read) lands its ledger row and its exception_resolve audit row, and readiness no longer refuses it; the
 *              revoke makes readiness refuse it again. A handle that is not a remnant is 409 with nothing written.
 *              (The governed pilot-pull legs of S9D-01 / -04 / -05 are the existing planner's and run in S6-9's G9: an
 *              acknowledgement is not a planner input — pinned hermetically by RA-09.)
 *   S9D-01p    an installed pack human column the action does NOT declare (#6842 fix round 1): the host's field read
 *              answers no id and the reader keys the cell by its physical id; hidden fills only in that column on the old
 *              root and the nested copy (plus one template-filled inactive row) count 2 / 1 on BOTH census forms.
 * Values-free: every id is synthetic and per-run.
 */
import { createRequire } from 'module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
const MIGRATION_107 = path.join(REPO_ROOT, 'packages/core-backend/migrations/107_create_integration_stock_prep_component_ruling.sql')
/* eslint-disable @typescript-eslint/no-explicit-any */
const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const rulingLib = require(path.join(PLUGIN_LIB, 'stock-preparation-component-ruling-store.cjs')) as any
const auditLib = require(path.join(PLUGIN_LIB, 'stock-preparation-audit-store.cjs')) as any
const censusLib = require(path.join(PLUGIN_LIB, 'stock-preparation-sheet-census.cjs')) as any
const httpRoutes = require(path.join(PLUGIN_LIB, 'http-routes.cjs')) as any
const tableActions = require(path.join(PLUGIN_LIB, 'stock-preparation-table-actions.cjs')) as any
const projectTargetStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-target-store.cjs')) as any
const projectTargetsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-targets.cjs')) as any
const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
const continuationStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-store.cjs')) as any
const governanceLib = require(path.join(PLUGIN_LIB, 'stock-preparation-refresh-governance.cjs')) as any
const lockLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-write-lock.cjs')) as any
const packInstallStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pack-install-store.cjs')) as any
const { ensureStockPreparationSandboxTarget } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any
const { syncStockPreparationContractOptionsForObject } = require(path.join(PLUGIN_LIB, 'stock-preparation-option-sync.cjs')) as any
const projectSheetHarness = require(path.join(REPO_ROOT, 'plugins/plugin-integration-core/__tests__/support/stock-preparation-project-sheet-harness.cjs')) as any

const { COMPONENT_RULING_TABLE: TABLE, ACTIVE_UNIQUE_INDEX, COMPONENT_RULING_ERROR_CODES: CODES, createStockPreparationComponentRulingStore } = rulingLib
const { componentHandle } = censusLib.__internals

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'component-ruling-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-component-ruling',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

// The scoped db over the HOST's plugin database binding shape (autocommit `query`, `transaction` on its own client).
function hostLikeDb() {
  return createDb({
    database: {
      query: async (sql: string, params?: unknown[]) => (await q(sql, params)).rows,
      transaction: async <T>(callback: (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown>; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>): Promise<T> => {
        const client = await poolManager.get().getInternalPool().connect()
        try {
          await client.query('BEGIN')
          const result = await callback({
            query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows,
            commit: async () => {},
            rollback: async () => {},
          })
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

async function expectSqlState(promise: Promise<unknown>, code: string, constraint?: string) {
  let thrown: any = null
  try { await promise } catch (error) { thrown = error }
  expect(thrown, `expected SQLSTATE ${code}${constraint ? ` (${constraint})` : ''}`).not.toBeNull()
  expect(thrown.code).toBe(code)
  if (constraint) expect(thrown.constraint).toBe(constraint)
}

async function refusal(promise: Promise<unknown>) {
  try { await promise } catch (error) { return error as any }
  throw new Error('expected a refusal')
}

const CHECK = (name: string) => `${TABLE}_${name}_check`

export function defineStockPreparationComponentRulingRealDbCases(): void {
  test('component ruling real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP !== '1') return
    if (!process.env.DATABASE_URL) throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the S6-5 cases would skip-green')
  })

  describeIfDatabase('batch-refresh step 6d-1b (S6-5): migration 107, the ruling store with its audit row, the census and the remnant acknowledgement over a real sheet (real Postgres)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const TENANT = `tenant_s65_${TOKEN}`
    const DIGEST = 'a1b2c3d4e5f60718293a4b5c'
    const sheets: string[] = []
    const scopeOf = (name: string) => ({ tenantId: TENANT, sheetId: `sheet_s65_${TOKEN}_${name}`, projectNo: `P-S65-${name}` })
    const baseRow = (scope: any, extra: Record<string, unknown> = {}) => ({
      id: `cr_s65_${TOKEN}_${Math.random().toString(36).slice(2, 10)}`, tenant_id: scope.tenantId, sheet_id: scope.sheetId, project_no: scope.projectNo,
      component_digest: DIGEST, kind: 'remnant_acknowledged', basis: 'head_not_ordered', rules: null, position_fingerprint: null,
      status: 'active', runbook_ref: 'R-91.ack', recorded_by: 'u_s65', revoked_by: null, revoked_at: null, revoked_runbook_ref: null, ...extra,
    })
    async function insertRaw(row: Record<string, unknown>, executor: (sql: string, params?: unknown[]) => Promise<unknown> = q) {
      const columns = Object.keys(row)
      const values = columns.map((column) => (column === 'rules' && row[column] !== null ? JSON.stringify(row[column]) : row[column]))
      return executor(`INSERT INTO ${TABLE} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, values)
    }

    afterAll(async () => {
      await q(`DELETE FROM ${TABLE} WHERE tenant_id = $1`, [TENANT]).catch(() => {})
      await q('DELETE FROM integration_stock_prep_audit WHERE tenant_id = $1', [TENANT]).catch(() => {})
      await q('DELETE FROM integration_stock_prep_project_target WHERE tenant_id = $1', [TENANT]).catch(() => {})
      await q('DELETE FROM integration_stock_prep_pack_installs WHERE tenant_id = $1', [TENANT]).catch(() => {})
      for (const sheetId of sheets) {
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
    })

    test('S9D-107 migration 107: the columns, every named CHECK (23514), the partial UNIQUE (23505, freed by a revoke), and a re-run over a populated table changes nothing', async () => {
      const columns = (await q(`SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [TABLE])).rows
      const byName = new Map(columns.map((row: any) => [row.column_name, row]))
      for (const name of ['id', 'tenant_id', 'sheet_id', 'project_no', 'component_digest', 'kind', 'status', 'runbook_ref', 'recorded_by', 'recorded_at', 'updated_at']) {
        expect(byName.get(name)?.is_nullable, name).toBe('NO')
      }
      for (const name of ['basis', 'rules', 'position_fingerprint', 'revoked_by', 'revoked_at', 'revoked_runbook_ref']) expect(byName.get(name)?.is_nullable, name).toBe('YES')
      expect(String(byName.get('status')?.column_default)).toContain("'active'")
      const constraints = (await q(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [TABLE])).rows.map((row: any) => row.conname).sort()
      expect(constraints).toEqual([CHECK('basis'), CHECK('digest_shape'), CHECK('kind'), CHECK('kind_shape'), CHECK('revoked_shape'), CHECK('runbook_ref_shape'), CHECK('status')].sort())
      const statusDef = (await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [TABLE, CHECK('status')])).rows[0].def
      expect(statusDef).toContain("'active'::text")
      expect(statusDef).toContain("'revoked'::text")
      const index = (await q(`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`, [ACTIVE_UNIQUE_INDEX])).rows[0]
      expect(index.indexdef).toContain('UNIQUE')
      expect(index.indexdef).toContain("WHERE (status = 'active'::text)")
      const scope = scopeOf('schema')
      for (const [patch, constraint] of [
        [{ kind: 'other' }, CHECK('kind')],
        [{ basis: 'customer_said_so' }, CHECK('basis')],
        // PostgreSQL tests CHECKs in name order: an unknown status trips revoked_shape (r < s) first; status_check's own
        // list is pinned from its definition below.
        [{ status: 'gone' }, CHECK('revoked_shape')],
        [{ component_digest: 'S1' }, CHECK('digest_shape')],
        [{ component_digest: DIGEST.toUpperCase() }, CHECK('digest_shape')],
        [{ runbook_ref: 'see the email' }, CHECK('runbook_ref_shape')],
        [{ basis: null }, CHECK('kind_shape')],
        [{ rules: [] }, CHECK('kind_shape')],
        [{ kind: 'dropped_head_included' }, CHECK('kind_shape')],
        [{ kind: 'dropped_head_included', basis: null, rules: ['dash'], position_fingerprint: 'abc' }, CHECK('kind_shape')],
        [{ status: 'revoked' }, CHECK('revoked_shape')],
        [{ revoked_by: 'u_s65' }, CHECK('revoked_shape')],
        [{ status: 'revoked', revoked_by: 'u', revoked_at: new Date(), revoked_runbook_ref: 'free text!' }, CHECK('revoked_shape')],
      ] as Array<[Record<string, unknown>, string]>) {
        await expectSqlState(insertRaw(baseRow(scope, patch)), '23514', constraint)
      }
      // The reserved S6-7 shape is admitted (nothing in this build writes it).
      await insertRaw(baseRow(scope, { kind: 'dropped_head_included', basis: null, rules: ['dash'], position_fingerprint: 'f'.repeat(64) }))
      // The partial UNIQUE: one ACTIVE row per (sheet, project, component, kind) …
      const first = baseRow(scope)
      await insertRaw(first)
      await expectSqlState(insertRaw(baseRow(scope)), '23505', ACTIVE_UNIQUE_INDEX)
      // … and a revoked row no longer holds it.
      await q(`UPDATE ${TABLE} SET status = 'revoked', revoked_by = 'u_s65', revoked_at = now(), revoked_runbook_ref = 'R-91.rev' WHERE id = $1`, [first.id])
      await insertRaw(baseRow(scope))
      // A re-run over the populated table changes nothing.
      const before = (await q(`SELECT id, status FROM ${TABLE} WHERE tenant_id = $1 ORDER BY id`, [TENANT])).rows
      await q(fs.readFileSync(MIGRATION_107, 'utf8'))
      const after = (await q(`SELECT id, status FROM ${TABLE} WHERE tenant_id = $1 ORDER BY id`, [TENANT])).rows
      expect(after).toEqual(before)
      expect(before.length).toBe(3)
    })

    test('S9D-107b migration 107 on a database AT 106 WITH DATA: dropped inside a transaction, re-applied; the 087-106 rows are untouched; ROLLBACK', async () => {
      const client = await poolManager.get().getInternalPool().connect()
      const tables = [
        'integration_stock_prep_project_target', 'integration_stock_prep_project_write_lock', 'integration_stock_prep_continuation',
        'integration_stock_prep_refresh_state', 'integration_stock_prep_refresh_execution', 'integration_stock_prep_refresh_execution_intent',
        'integration_stock_prep_change_plan', 'integration_stock_prep_pull_batch_sheet', 'integration_stock_prep_pull_batch', 'integration_stock_prep_audit',
      ]
      try {
        await client.query('BEGIN')
        // Data in the 087-106 tables: a registry row of this run (plus whatever the shared CI database already holds).
        await client.query(
          `INSERT INTO integration_stock_prep_project_target (id, tenant_id, project_no, sheet_id, object_id, status, created_by) VALUES ($1, $2, $3, $4, $5, 'active', 'u_s65')`,
          [`pt_s65_${TOKEN}`, TENANT, 'P-S65-AT106', `sheet_s65_${TOKEN}_at106`, `plm_s65_${TOKEN}_at106`],
        )
        const counts = async () => {
          const out: Record<string, number> = {}
          for (const table of tables) out[table] = Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n)
          return out
        }
        const before = await counts()
        expect(before.integration_stock_prep_project_target).toBeGreaterThan(0)
        await client.query(`DROP TABLE ${TABLE}`)
        expect((await client.query('SELECT to_regclass($1) AS oid', [TABLE])).rows[0].oid).toBeNull()
        await client.query(fs.readFileSync(MIGRATION_107, 'utf8'))
        expect((await client.query('SELECT to_regclass($1) AS oid', [TABLE])).rows[0].oid).not.toBeNull()
        const constraints = (await client.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [TABLE])).rows[0].n
        expect(constraints).toBe(7)
        expect((await client.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname IN ($1, $2)`, [ACTIVE_UNIQUE_INDEX, 'idx_integration_stock_prep_component_ruling_scope'])).rows[0].n).toBe(2)
        await insertRaw(baseRow(scopeOf('at106')), (sql, params) => client.query(sql, params))
        expect(await counts()).toEqual(before)
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
      expect((await q('SELECT to_regclass($1) AS oid', [TABLE])).rows[0].oid).not.toBeNull()
      expect((await q(`SELECT count(*)::int AS n FROM ${TABLE} WHERE sheet_id = $1`, [scopeOf('at106').sheetId])).rows[0].n).toBe(0)
    })

    test('S9D-CR the store on real PG: the ruling row and its audit row on ONE transaction; 409 twice; an audit failure after its insert rolls back both; revoke', async () => {
      const db = hostLikeDb()
      let n = 0
      const store = createStockPreparationComponentRulingStore({ db, idGenerator: () => `cr_s65_${TOKEN}_store_${(n += 1)}` })
      const audit = auditLib.createStockPreparationAuditStore({ db })
      const scope = scopeOf('store')
      const auditWithin = (trx: any, event: any) => audit.appendWithin(trx, { tenantId: TENANT, action: 'exception_resolve', subjectId: event.rulingId, mode: event.operation, actor: 'u_s65', detail: { operation: event.operation, kind: event.kind, basis: event.basis, runbookRef: event.runbookRef } })
      const auditRows = async () => (await q(`SELECT subject_id, mode FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = 'exception_resolve' ORDER BY created_at, id`, [TENANT])).rows
      const row = await store.recordRemnantAcknowledgement({ ...scope, componentDigest: DIGEST, basis: 'head_not_ordered', runbookRef: 'R-91.ack', recordedBy: 'u_s65', auditWithin })
      expect(row.status).toBe('active')
      expect(await auditRows()).toEqual([{ subject_id: row.id, mode: 'remnant_acknowledged' }])
      const twice = await refusal(store.recordRemnantAcknowledgement({ ...scope, componentDigest: DIGEST, basis: 'head_not_ordered', runbookRef: 'R-91.ack', recordedBy: 'u_s65', auditWithin }))
      expect(twice.status).toBe(409)
      expect(twice.code).toBe(CODES.ALREADY_ACKNOWLEDGED)
      expect((await auditRows()).length).toBe(1)
      // An audit hook whose own insert lands and THEN fails: both rows roll back.
      const other = 'ffeeddccbbaa009988776655'
      const failing = async (trx: any, event: any) => { await auditWithin(trx, event); throw new Error('the hook failed after its insert') }
      const rolled = await refusal(store.recordRemnantAcknowledgement({ ...scope, componentDigest: other, basis: 'head_not_ordered', runbookRef: 'R-91.ack', recordedBy: 'u_s65', auditWithin: failing }))
      expect(rolled.status).toBe(503)
      expect((await q(`SELECT count(*)::int AS n FROM ${TABLE} WHERE sheet_id = $1 AND component_digest = $2`, [scope.sheetId, other])).rows[0].n).toBe(0)
      expect((await auditRows()).length).toBe(1)
      // Revoke.
      const revoked = await store.revokeRemnantAcknowledgement({ ...scope, rulingId: row.id, runbookRef: 'R-91.rev', revokedBy: 'u_s65', auditWithin })
      expect(revoked.status).toBe('revoked')
      expect(revoked.revokedRunbookRef).toBe('R-91.rev')
      expect((await auditRows()).map((entry: any) => entry.mode)).toEqual(['remnant_acknowledged', 'remnant_acknowledgement_revoked'])
      const again = await refusal(store.revokeRemnantAcknowledgement({ ...scope, rulingId: row.id, runbookRef: 'R-91.rev', revokedBy: 'u_s65', auditWithin }))
      expect(again.code).toBe(CODES.ALREADY_REVOKED)
      expect((await store.listActiveRulings(scope)).length).toBe(0)
      expect((await store.listRulings(scope)).length).toBe(1)
    })

    test('S9D-01r a real item-10 sheet: the census counts it and lists its handle, readiness v5 refuses it, an acknowledgement through the route lifts exactly that check, the revoke restores it', async () => {
      const projectNo = 'SYN-S65-D2'
      const projectId = `${TENANT}:integration-core`
      const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(TENANT, projectNo)
      const pluginContext = createProductionPluginContext()
      const multitable: any = pluginContext.api.multitable
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      const sheetId: string = ensured.target.sheetId
      sheets.push(sheetId)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
      const db = createDb({ database: pluginContext.api.database })
      const registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db })
      await registry.create({ tenantId: TENANT, projectNo, sheetId, objectId, createdBy: 'u_s65' })
      const fields = ensured.target.fieldIdMap || {}
      const seed = async (cells: Record<string, unknown>) => {
        const created = await multitable.records.createRecord({ sheetId, data: { [fields.projectNo]: projectNo } })
        const patch: Record<string, unknown> = {}
        for (const [logical, value] of Object.entries(cells)) patch[fields[logical]] = value
        await q('UPDATE meta_records SET data = data || $2::jsonb WHERE id = $1', [created.id, JSON.stringify(patch)])
      }
      // D2: S's old root INACTIVE (with a hidden human fill), S active under P.
      await seed({ idempotencyKey: 's65-P', componentSourceId: 'S65-P', parentSourceId: '', active: true })
      await seed({ idempotencyKey: 's65-S', componentSourceId: 'S65-S', parentSourceId: '', active: false, materialType: 'S65 fill' })
      await seed({ idempotencyKey: 's65-P-S', componentSourceId: 'S65-S', parentSourceId: 'S65-P', active: true })
      const routes = new Map<string, any>()
      const lock = lockLib.createStockPreparationProjectWriteLock({ db })
      const continuationStore = continuationStoreLib.createStockPreparationContinuationStore({ db })
      const rulingStore = createStockPreparationComponentRulingStore({ db })
      const audit = auditLib.createStockPreparationAuditStore({ db })
      const envTarget = { sheetId: `sheet_env_s65_${TOKEN}`, objectId: 'plm_stock_preparation_sandbox_synthetic_env', fieldIdMap: {} }
      const routeContext = {
        api: {
          http: { addRoute: (method: string, routePath: string, handler: any) => routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
          multitable,
          database: pluginContext.api.database,
        },
        storage: pluginContext.storage,
        config: {
          stockPreparationTableActions: [{ actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID, source: { externalSystemId: `s65_source_${TOKEN}`, kind: 'data-source:sql-readonly' }, target: envTarget }],
          stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [envTarget.objectId] },
          stockPreparationPilot: { specReadPlanSlot: 'not_applicable', customerPack: 'not_applicable' },
        },
      }
      const base = projectSheetHarness.baseServices({ async read() { return { records: [], done: true, nextCursor: null } } })
      const services = {
        ...base,
        stockPreparationProjectWriteLock: lock,
        stockPreparationProjectTargetStore: registry,
        stockPreparationAuditStore: audit,
        stockPreparationPackInstallStore: packInstallStoreLib.createStockPreparationPackInstallStore({ db }),
        stockPreparationContinuationStore: continuationStore,
        stockPreparationRefreshGovernance: governanceLib.createStockPreparationRefreshGovernance({ continuationStore, projectTargetStore: registry, projectWriteLock: lock }),
        stockPreparationComponentRulingStore: rulingStore,
        tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
      }
      const envBefore = process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
      process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED = 'true'
      const admin = { id: `u_s65_admin_${TOKEN}`, tenantId: TENANT, permissions: ['stock-prep:admin'] }
      const call = async (method: string, routePath: string, req: Record<string, unknown>) => {
        const handler = routes.get(`${method} ${routePath}`)
        if (!handler) throw new Error(`route ${method} ${routePath} is not registered`)
        const res: any = { statusCode: 200, body: null, headers: {} }
        res.status = (code: number) => { res.statusCode = code; return res }
        res.json = (payload: unknown) => { res.body = payload; return res }
        res.setHeader = () => res
        await handler({ user: admin, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
        return res
      }
      try {
        httpRoutes.registerIntegrationRoutes({ context: routeContext, services, logger: { info() {}, warn() {}, error() {} } })
        const handle = componentHandle(TENANT, projectNo, 'S65-S')
        // The tenant census counts the remnant (and the hidden fill), values-free of the handle.
        const list = await call('GET', '/api/integration/stock-preparation/project-targets/census', { query: {} })
        expect(list.statusCode, JSON.stringify(list.body)).toBe(200)
        const item = list.body.data.items.find((entry: any) => entry.objectId === objectId)
        expect(item.status).toBe('complete')
        expect(item.inactiveRootRemnantComponents).toBe(1)
        expect(item.inactiveRowsWithHumanCells).toBe(1)
        expect(item.unacknowledgedRemnantComponents).toBe(1)
        expect(item.governed).toBe('none')
        expect(JSON.stringify(list.body)).not.toContain(handle)
        // The project census lists exactly its handle.
        const project = await call('GET', '/api/integration/stock-preparation/projects/:projectNo/target/census', { params: { projectNo }, query: {} })
        expect(project.statusCode, JSON.stringify(project.body)).toBe(200)
        expect(project.body.data.components).toEqual([{ componentHandle: handle, acknowledgement: null }])
        const failing = async () => {
          const res = await call('GET', '/api/integration/stock-preparation/projects/:projectNo/target/pilot', { params: { projectNo }, query: {} })
          expect(res.statusCode, JSON.stringify(res.body)).toBe(200)
          return res.body.data.readiness.failing as string[]
        }
        expect(await failing()).toContain('no_unacknowledged_inactive_root_remnant')
        // A handle that is no remnant: 409, nothing written.
        const ackPath = '/api/integration/stock-preparation/projects/:projectNo/target/remnant-acknowledgements'
        const body = (componentHandleValue: string) => ({ confirmProjectNo: projectNo, componentHandle: componentHandleValue, basis: 'head_not_ordered', runbookRef: 'R-91.s65', acknowledge: { customerAnswered: true } })
        const notRemnant = await call('POST', ackPath, { params: { projectNo }, body: body(componentHandle(TENANT, projectNo, 'S65-P')) })
        expect(notRemnant.statusCode, JSON.stringify(notRemnant.body)).toBe(409)
        expect(notRemnant.body.error.code).toBe('STOCK_PREP_REMNANT_NOT_PRESENT')
        expect((await q(`SELECT count(*)::int AS n FROM ${TABLE} WHERE sheet_id = $1`, [sheetId])).rows[0].n).toBe(0)
        // The acknowledgement: the ledger row and its audit row.
        const created = await call('POST', ackPath, { params: { projectNo }, body: body(handle) })
        expect(created.statusCode, JSON.stringify(created.body)).toBe(201)
        const ledger = (await q(`SELECT id, tenant_id, project_no, component_digest, kind, status, recorded_by FROM ${TABLE} WHERE sheet_id = $1`, [sheetId])).rows
        expect(ledger).toEqual([{ id: created.body.data.acknowledgementId, tenant_id: TENANT, project_no: projectNo, component_digest: handle, kind: 'remnant_acknowledged', status: 'active', recorded_by: admin.id }])
        const auditRow = (await q(`SELECT subject_id, mode, project_id, detail FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = 'exception_resolve' AND subject_id = $2`, [TENANT, created.body.data.acknowledgementId])).rows
        expect(auditRow).toHaveLength(1)
        expect(auditRow[0].mode).toBe('remnant_acknowledged')
        expect(auditRow[0].project_id).toBeNull()
        expect(JSON.stringify(auditRow[0].detail)).not.toContain(handle)
        expect(await failing()).not.toContain('no_unacknowledged_inactive_root_remnant')
        // The revoke restores the refusal.
        const revoked = await call('POST', '/api/integration/stock-preparation/projects/:projectNo/target/remnant-acknowledgements/:acknowledgementId/revoke', {
          params: { projectNo, acknowledgementId: created.body.data.acknowledgementId },
          body: { confirmProjectNo: projectNo, runbookRef: 'R-91.s65-rev' },
        })
        expect(revoked.statusCode, JSON.stringify(revoked.body)).toBe(200)
        expect(revoked.body.data.status).toBe('revoked')
        expect(await failing()).toContain('no_unacknowledged_inactive_root_remnant')
      } finally {
        if (envBefore === undefined) delete process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
        else process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED = envBefore
        await q(`DELETE FROM ${lockLib.PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [lockLib.sheetWriteScopeKey(sheetId)]).catch(() => {})
      }
    }, 120000)

    test('S9D-01p an installed pack human column the action does not declare: both census forms count its hidden fills (the host field read carries no id; the cell sits under the physical id)', async () => {
      const projectNo = 'SYN-S65-PACK'
      const PACK_HUMAN = 'ext_s65HumanNote'
      const projectId = `${TENANT}:integration-core`
      const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(TENANT, projectNo)
      const pluginContext = createProductionPluginContext()
      const multitable: any = pluginContext.api.multitable
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      const sheetId: string = ensured.target.sheetId
      sheets.push(sheetId)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
      const db = createDb({ database: pluginContext.api.database })
      const registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db })
      await registry.create({ tenantId: TENANT, projectNo, sheetId, objectId, createdBy: 'u_s65' })
      // The pack column, installed the way a pack lands: the host's additive field write and the ledger row.
      const added = await multitable.provisioning.ensureMissingObjectFields({
        projectId,
        objectId,
        fields: [{ id: PACK_HUMAN, name: 'S65 human note', type: 'string', property: { stockPreparation: { ownership: 'human_preserved', extension: true, preserveOnRefresh: false } } }],
      })
      expect(added.addedFieldIds).toHaveLength(1)
      const packInstalls = packInstallStoreLib.createStockPreparationPackInstallStore({ db })
      await packInstalls.recordInstall({
        tenantId: TENANT, projectId, objectId, packId: 'pack_s65_synthetic', packVersion: '1',
        installedFields: [{ fieldId: PACK_HUMAN, ownership: 'human_preserved', preserveOnRefresh: false, extension: true }],
      })
      // The recorded facts: the ledger lists it; the host field read answers no id; the target field map does not name it.
      expect((await packInstalls.listInstalledFieldIds({ tenantId: TENANT, projectId, objectId })).fieldIds).toEqual([PACK_HUMAN])
      const content = await multitable.provisioning.readObjectFieldsContent({ projectId, objectId, fieldIds: [PACK_HUMAN] })
      expect(Object.keys(content[PACK_HUMAN]).sort()).toEqual(['name', 'order', 'property', 'type'])
      const fields = ensured.target.fieldIdMap || {}
      expect(fields[PACK_HUMAN]).toBeUndefined()
      const packPhysical: string = multitable.provisioning.getFieldId(projectId, objectId, PACK_HUMAN)
      const seed = async (cells: Record<string, unknown>, packFill?: string) => {
        const created = await multitable.records.createRecord({ sheetId, data: { [fields.projectNo]: projectNo } })
        const patch: Record<string, unknown> = {}
        for (const [logical, value] of Object.entries(cells)) {
          if (!fields[logical]) throw new Error(`no physical id for ${logical}`)
          patch[fields[logical]] = value
        }
        if (packFill !== undefined) patch[packPhysical] = packFill
        await q('UPDATE meta_records SET data = data || $2::jsonb WHERE id = $1', [created.id, JSON.stringify(patch)])
      }
      // D2 on S with the hidden fills ONLY in the pack column, plus one inactive row with a template-band fill.
      await seed({ idempotencyKey: 's65p-P', componentSourceId: 'S65P-P', parentSourceId: '', active: true })
      await seed({ idempotencyKey: 's65p-S', componentSourceId: 'S65P-S', parentSourceId: '', active: false }, 'S65 pack fill (old root)')
      await seed({ idempotencyKey: 's65p-P-S', componentSourceId: 'S65P-S', parentSourceId: 'S65P-P', active: true }, 'S65 pack fill (nested copy)')
      await seed({ idempotencyKey: 's65p-X', componentSourceId: 'S65P-X', parentSourceId: '', active: false, notes: 'S65 template fill' })
      const routes = new Map<string, any>()
      const lock = lockLib.createStockPreparationProjectWriteLock({ db })
      const continuationStore = continuationStoreLib.createStockPreparationContinuationStore({ db })
      const envTarget = { sheetId: `sheet_env_s65p_${TOKEN}`, objectId: 'plm_stock_preparation_sandbox_synthetic_env', fieldIdMap: {} }
      const routeContext = {
        api: {
          http: { addRoute: (method: string, routePath: string, handler: any) => routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
          multitable,
          database: pluginContext.api.database,
        },
        storage: pluginContext.storage,
        config: {
          // The action declares NO extensionFieldIds: the pack column reaches the census only through the pack read.
          stockPreparationTableActions: [{ actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID, source: { externalSystemId: `s65p_source_${TOKEN}`, kind: 'data-source:sql-readonly' }, target: envTarget }],
          stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [envTarget.objectId] },
        },
      }
      const base = projectSheetHarness.baseServices({ async read() { return { records: [], done: true, nextCursor: null } } })
      const services = {
        ...base,
        stockPreparationProjectWriteLock: lock,
        stockPreparationProjectTargetStore: registry,
        stockPreparationAuditStore: auditLib.createStockPreparationAuditStore({ db }),
        stockPreparationPackInstallStore: packInstalls,
        stockPreparationContinuationStore: continuationStore,
        stockPreparationRefreshGovernance: governanceLib.createStockPreparationRefreshGovernance({ continuationStore, projectTargetStore: registry, projectWriteLock: lock }),
        stockPreparationComponentRulingStore: createStockPreparationComponentRulingStore({ db }),
        tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
      }
      const envBefore = process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
      process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED = 'true'
      const admin = { id: `u_s65p_admin_${TOKEN}`, tenantId: TENANT, permissions: ['stock-prep:admin'] }
      const call = async (method: string, routePath: string, req: Record<string, unknown>) => {
        const handler = routes.get(`${method} ${routePath}`)
        if (!handler) throw new Error(`route ${method} ${routePath} is not registered`)
        const res: any = { statusCode: 200, body: null, headers: {} }
        res.status = (code: number) => { res.statusCode = code; return res }
        res.json = (payload: unknown) => { res.body = payload; return res }
        res.setHeader = () => res
        await handler({ user: admin, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
        return res
      }
      try {
        httpRoutes.registerIntegrationRoutes({ context: routeContext, services, logger: { info() {}, warn() {}, error() {} } })
        const list = await call('GET', '/api/integration/stock-preparation/project-targets/census', { query: {} })
        expect(list.statusCode, JSON.stringify(list.body)).toBe(200)
        const item = list.body.data.items.find((entry: any) => entry.objectId === objectId)
        expect(item.status, JSON.stringify(item)).toBe('complete')
        expect(item.inactiveRootRemnantComponents).toBe(1)
        expect(item.inactiveRowsWithHumanCells, 'the old root (pack fill) and the template-filled inactive row').toBe(2)
        expect(item.nestedCopiesWithHumanCells, 'the nested copy (pack fill)').toBe(1)
        const project = await call('GET', '/api/integration/stock-preparation/projects/:projectNo/target/census', { params: { projectNo }, query: {} })
        expect(project.statusCode, JSON.stringify(project.body)).toBe(200)
        expect(project.body.data.status).toBe('complete')
        expect(project.body.data.inactiveRowsWithHumanCells).toBe(2)
        expect(project.body.data.nestedCopiesWithHumanCells).toBe(1)
        expect(JSON.stringify([list.body, project.body])).not.toContain('S65 pack fill')
      } finally {
        if (envBefore === undefined) delete process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
        else process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED = envBefore
        await q(`DELETE FROM ${lockLib.PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [lockLib.sheetWriteScopeKey(sheetId)]).catch(() => {})
      }
    }, 120000)
  })
}
