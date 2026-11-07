/**
 * Field-row lost updates on a stock-prep project sheet (real Postgres): `PATCH /fields/:fieldId` (the host route) racing
 * the plugin's writes of the same field row — the per-sheet manual-rows switch (the plugin's own SET route over the
 * PRODUCTION plugin context and its plugin-scoped provisioning port) and the PLM column lock stamp
 * (`markProjectSheetPlmSystemColumns`, the same port). Origin: the PR #6672 verifier's race probe, which showed a
 * confirmed switch flip reverted by a concurrent rename of the key column.
 *
 * Each interleaving is forced, never timed: `holdAfter` pauses one transaction right after one production statement
 * (exact text, exported by the module that issues it), and `raceParkedOrSettled` reads `pg_blocking_pids` to see who
 * waits on whom. The writer fence is pinned OFF for the whole block (it closes these races by itself; with it on the
 * cases would be green on main and prove nothing) — every race case asserts that first. RT-1F is the one fence-ON
 * positive control.
 *
 *   RT-0  precondition: a plain property PATCH of the key column (stored property + a neutral marker) lands, and keeps
 *         the PLM lock and the key stanza — so RT-3/RT-4 measure the race, not the sanitizer.
 *   RT-1  the PATCH (a rename) reads; the switch SET commits 'disabled' and reads it back (200, confirmed); the PATCH
 *         goes on. The switch survives and so does the lock; the PATCH answered 200 after ONE transparent retry
 *         (its first read ran twice); one config revision.
 *   RT-1F the same interleaving with the fence ON: the switch SET parks on the fence until the PATCH commits; no retry.
 *   RT-2  the lock stamp lands inside the PATCH's read-to-write window on a PLM column whose lock is missing: the
 *         stamped lock survives the PATCH.
 *   RT-3  the switch's provisioning patch reads (now under the row lock); a property PATCH of the same column parks on
 *         its late locked re-read until the switch commits, then retries: both changes survive.
 *   RT-4  the PATCH holds its late locked re-read; the switch's provisioning read parks behind it, then merges onto the
 *         PATCH's result: both changes survive, the read-back confirms, no retry.
 *   RT-7  lock strength: while the provisioning patch holds the row, an FK child insert (meta_field_auto_number_sequences
 *         references meta_fields(id), so its insert takes FOR KEY SHARE on the field row) never parks.
 *
 * A CASES MODULE, registered from the already-wired real-DB file tests/integration/multitable-record-duplicate.test.ts
 * (vitest.config.ts excludes that file from the no-DB job; plugin-tests.yml's multitable real-DB step names it). Do NOT
 * list a standalone file. Values-free: every id is synthetic and per-run.
 * R line (R83 on onprem-r82): the project write lock is not on this line and no route here reads it, so the routes are
 * mounted without that service; RT-0..RT-7 are otherwise main's.
 */
import { createRequire } from 'module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { isWriterFenceEnabled } from '../../src/multitable/canonical-sheet-fence'
import { PATCH_FIELD_LOCKED_REREAD_SQL, PATCH_FIELD_READ_SQL } from '../../src/multitable/field-row-write-guard'
import { PATCH_OBJECT_FIELD_PROPERTY_READ_SQL } from '../../src/multitable/provisioning'
import {
  holdAfter,
  raceParkedOrSettled,
  rawClient,
  tracked,
  useWriterFencePinnedOff,
  withWriterFenceOn,
} from '../utils/field-row-race-harness'
import { usePinnedServer } from '../utils/pinned-server'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
/* eslint-disable @typescript-eslint/no-explicit-any */
const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const { ensureStockPreparationSandboxTarget } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any
const { syncStockPreparationContractOptionsForObject } = require(path.join(PLUGIN_LIB, 'stock-preparation-option-sync.cjs')) as any
const projectTargetStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-target-store.cjs')) as any
const projectTargetsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-targets.cjs')) as any
const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
const auditStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-audit-store.cjs')) as any
const httpRoutesLib = require(path.join(PLUGIN_LIB, 'http-routes.cjs')) as any
const access = require(path.join(PLUGIN_LIB, 'stock-preparation-workbench-access.cjs')) as any
const manualRowsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-manual-rows.cjs')) as any
const harnessLib = require(path.join(REPO_ROOT, 'plugins/plugin-integration-core/__tests__/support/stock-preparation-project-sheet-harness.cjs')) as any
/* eslint-enable @typescript-eslint/no-explicit-any */

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const SWITCH = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
const TARGET_TABLE = 'integration_stock_prep_project_target'
const SWITCH_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/manual-rows'
const SWITCH_KEY = 'stockPreparationManualRows'
const LOCK_KEY = 'humanWriteLock'
// RT-2's PLM column: a plm_system column of the frozen template that is not the key column RT-1/RT-3/RT-4 use.
const PLM_COLUMN = 'componentSourceId'
// RT-7's FK child: one atomic statement whose FK check takes FOR KEY SHARE on the field row (and on the sheet row).
const FK_CHILD_INSERT_SQL = 'INSERT INTO meta_field_auto_number_sequences (field_id, sheet_id, next_value) VALUES ($1, $2, 1)'

type FieldRow = { name: string; type: string; property: Record<string, unknown>; order: number }

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'field-property-race-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-field-property-race',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

function routeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: null, headers: {} }
  res.status = (code: number) => { res.statusCode = code; return res }
  res.json = (payload: unknown) => { res.body = payload; return res }
  res.setHeader = (name: string, value: unknown) => { res.headers[name] = value; return res }
  res.send = (payload: unknown) => { res.body = payload; return res }
  res.end = () => res
  return res
}

export function defineStockPreparationFieldPropertyRaceRealDbCases(): void {
  test('field property race real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the field property race real-DB cases would skip-green')
    }
  })

  describeIfDatabase('field property writes on a stock-prep project sheet — PATCH /fields vs the plugin switch and lock stamp (real Postgres)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const tenantId = `tenant_fprace_${TOKEN}`
    const projectId = `${tenantId}:integration-core`
    const projectNo = `SYN-FPRACE-${TOKEN}`
    const ADMIN = { id: `u_fprace_admin_${TOKEN}`, roles: ['admin'], perms: [] as string[] }
    const STOCK_PREP_ADMIN_USER = { id: `u_fprace_spadmin_${TOKEN}`, tenantId, permissions: [access.STOCK_PREP_ADMIN] }
    const switchBefore = process.env[SWITCH]
    useWriterFencePinnedOff()
    const pinned = usePinnedServer()
    const http = () => request(pinned.url())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routes = new Map<string, any>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let multitable: any
    let sheetId = ''
    let objectId = ''
    let fields: Record<string, string> = {}
    let lastPullKey = ''
    const baseRows = new Map<string, FieldRow>()

    const phys = (logical: string) => {
      const id = fields[logical]
      if (!id) throw new Error(`no physical id for ${logical}`)
      return id
    }
    const fieldRow = async (id: string): Promise<FieldRow> => {
      const row = (await q('SELECT name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 AND id = $2', [sheetId, id])).rows[0] as FieldRow | undefined
      if (!row) throw new Error('field row missing')
      return { name: row.name, type: row.type, property: (row.property ?? {}) as Record<string, unknown>, order: Number(row.order) }
    }
    const resetField = async (id: string) => {
      const base = baseRows.get(id)
      if (!base) throw new Error('no baseline for this field')
      await q('UPDATE meta_fields SET name = $3, type = $4, property = $5::jsonb, "order" = $6 WHERE sheet_id = $1 AND id = $2', [sheetId, id, base.name, base.type, JSON.stringify(base.property), base.order])
    }
    const revisionCount = async (id: string) => Number(((await q(
      'SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id = $1 AND entity_id = $2 AND actor_id = $3',
      [sheetId, id, ADMIN.id],
    )).rows[0] as { n: number }).n)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setSwitch = async (policy: string): Promise<any> => {
      const handler = routes.get(`POST ${SWITCH_PATH}`)
      if (!handler) throw new Error(`plugin route POST ${SWITCH_PATH} is not registered`)
      const res = routeResponse()
      await handler({ user: STOCK_PREP_ADMIN_USER, body: { confirmProjectNo: projectNo, policy }, query: {}, params: { projectNo } }, res)
      return res
    }
    const patchField = (id: string, body: Record<string, unknown>) => http().patch(`/api/multitable/fields/${id}`).send(body)
    const withoutSwitch = (property: Record<string, unknown>) => {
      const { [SWITCH_KEY]: _switch, ...rest } = property
      return rest
    }
    const keyStanzaOf = (property: Record<string, unknown>) => manualRowsLib.manualRowsKeyColumnState({ property }).keyStanza

    beforeAll(async () => {
      process.env[SWITCH] = 'true'
      const app = express()
      app.use(express.json())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app.use((req, _res, next) => { ;(req as any).user = ADMIN; next() })
      app.use('/api/multitable', univerMetaRouter())
      pinned.setApp(app)

      objectId = ownBaseLib.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
      const pluginContext = createProductionPluginContext()
      multitable = pluginContext.api.multitable
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
      sheetId = ensured.target.sheetId
      fields = { ...ensured.target.fieldIdMap }
      lastPullKey = manualRowsLib.manualRowsLastPullKey(sheetId)
      const db = createDb({ database: pluginContext.api.database })
      const registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db })
      await registry.create({ tenantId, projectNo, sheetId, objectId, createdBy: 'syn' })
      const routeContext = {
        api: {
          http: { addRoute: (method: string, routePath: string, handler: unknown) => routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
          multitable,
          database: pluginContext.api.database,
        },
        storage: pluginContext.storage,
        config: {},
      }
      const services = {
        ...harnessLib.baseServices(null),
        stockPreparationProjectTargetStore: registry,
        stockPreparationAuditStore: auditStoreLib.createStockPreparationAuditStore({ db }),
        tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
      }
      httpRoutesLib.registerIntegrationRoutes({ context: routeContext, services, logger: { info() {}, warn() {}, error() {} } })
      for (const logical of ['idempotencyKey', PLM_COLUMN]) baseRows.set(phys(logical), await fieldRow(phys(logical)))
    }, 120_000)

    afterEach(async () => {
      for (const id of baseRows.keys()) await resetField(id)
      await q('DELETE FROM meta_field_auto_number_sequences WHERE sheet_id = $1', [sheetId]).catch(() => {})
    })

    afterAll(async () => {
      if (switchBefore === undefined) delete process.env[SWITCH]
      else process.env[SWITCH] = switchBefore
      if (sheetId) {
        await q('DELETE FROM meta_field_auto_number_sequences WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
      await q(`DELETE FROM ${TARGET_TABLE} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
      await q('DELETE FROM integration_stock_prep_audit WHERE tenant_id = $1', [tenantId]).catch(() => {})
      if (lastPullKey) await q("DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key = $1", [lastPullKey]).catch(() => {})
    })

    test('RT-0 precondition: a plain property PATCH of the key column (stored property + a neutral marker) lands and keeps the lock and the key stanza', async () => {
      const keyId = phys('idempotencyKey')
      const base = await fieldRow(keyId)
      expect(base.property[LOCK_KEY]).toBe('plm_system')
      expect(keyStanzaOf(base.property)).toBe(true)
      const res = await patchField(keyId, { property: { ...withoutSwitch(base.property), t3Marker: 'plain' } })
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
      const after = await fieldRow(keyId)
      expect(after.property.t3Marker).toBe('plain')
      expect(after.property[LOCK_KEY]).toBe('plm_system')
      expect(keyStanzaOf(after.property)).toBe(true)
    })

    test('RT-1 the PATCH (rename) reads, the switch SET commits and is confirmed, the PATCH writes: the switch and the lock survive, after one transparent retry', async () => {
      expect(isWriterFenceEnabled()).toBe(false)
      const keyId = phys('idempotencyKey')
      const base = await fieldRow(keyId)
      expect(base.property[LOCK_KEY]).toBe('plm_system')
      expect(manualRowsLib.manualRowsPolicyValueOf(base.property)).toBe(null)
      const revisionsBefore = await revisionCount(keyId)
      const hold = holdAfter(PATCH_FIELD_READ_SQL)
      const patching = tracked(() => patchField(keyId, { name: 'Synthetic key renamed RT1' }))
      try {
        await hold.reached()
        const set = await setSwitch('disabled')
        expect(set.statusCode, JSON.stringify(set.body)).toBe(200)
        expect(set.body.data).toMatchObject({ policy: 'disabled', written: true })
        expect((await fieldRow(keyId)).property[SWITCH_KEY], 'the switch is committed while the PATCH is held').toBe('disabled')
        hold.release()
        const res = await patching.promise
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
        const after = await fieldRow(keyId)
        expect(after.property[SWITCH_KEY], 'RT-1: the confirmed switch flip survives the concurrent PATCH').toBe('disabled')
        expect(after.property[LOCK_KEY], 'RT-1: the PLM lock survives').toBe('plm_system')
        expect(after.name).toBe('Synthetic key renamed RT1')
        expect(hold.count(), 'RT-1: the PATCH re-ran on fresh data (its first read ran twice)').toBe(2)
        expect(await revisionCount(keyId), 'RT-1: exactly one config revision for the PATCH').toBe(revisionsBefore + 1)
      } finally {
        hold.restore()
        await patching.promise.catch(() => {})
      }
    })

    test('RT-1F positive control, writer fence ON: the switch SET waits on the fence until the PATCH commits; no retry; both changes land', async () => {
      const keyId = phys('idempotencyKey')
      await withWriterFenceOn(async () => {
        expect(isWriterFenceEnabled()).toBe(true)
        const hold = holdAfter(PATCH_FIELD_READ_SQL)
        const patching = tracked(() => patchField(keyId, { name: 'Synthetic key renamed RT1F' }))
        let switching: ReturnType<typeof tracked> | null = null
        try {
          const pid = await hold.reached()
          const sw = tracked(() => setSwitch('disabled'))
          switching = sw
          const outcome = await raceParkedOrSettled({ blockerPid: pid, settled: sw.settled })
          expect(outcome, 'RT-1F: the switch write parks behind the fence held by the PATCH').toBe('parked')
          hold.release()
          const res = await patching.promise
          expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
          const set = (await sw.promise) as { statusCode: number; body: unknown }
          expect(set.statusCode, JSON.stringify(set.body)).toBe(200)
          const after = await fieldRow(keyId)
          expect(after.property[SWITCH_KEY]).toBe('disabled')
          expect(after.property[LOCK_KEY]).toBe('plm_system')
          expect(after.name).toBe('Synthetic key renamed RT1F')
          expect(hold.count(), 'RT-1F: serialized by the fence, so no retry').toBe(1)
        } finally {
          hold.restore()
          await patching.promise.catch(() => {})
          if (switching) await switching.promise.catch(() => {})
        }
      })
    })

    test('RT-2 the PLM lock stamp lands inside the PATCH\'s read-to-write window: the stamped lock survives the PATCH', async () => {
      expect(isWriterFenceEnabled()).toBe(false)
      const colId = phys(PLM_COLUMN)
      // A PLM column the stamp has not reached yet (the create leg and the repair leg both stamp later).
      await q(`UPDATE meta_fields SET property = property - '${LOCK_KEY}' WHERE sheet_id = $1 AND id = $2`, [sheetId, colId])
      expect((await fieldRow(colId)).property[LOCK_KEY]).toBeUndefined()
      const hold = holdAfter(PATCH_FIELD_READ_SQL)
      const patching = tracked(() => patchField(colId, { name: 'Synthetic PLM column renamed RT2' }))
      try {
        await hold.reached()
        const marked = await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
        expect(marked.markedFieldIds).toEqual([PLM_COLUMN])
        expect((await fieldRow(colId)).property[LOCK_KEY], 'the stamp is committed while the PATCH is held').toBe('plm_system')
        hold.release()
        const res = await patching.promise
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
        const after = await fieldRow(colId)
        expect(after.property[LOCK_KEY], 'RT-2: the lock stamped inside the PATCH\'s window survives').toBe('plm_system')
        expect(after.name).toBe('Synthetic PLM column renamed RT2')
        expect(hold.count(), 'RT-2: the PATCH re-ran on fresh data').toBe(2)
      } finally {
        hold.restore()
        await patching.promise.catch(() => {})
      }
    })

    test('RT-3 the switch\'s provisioning patch holds its read; a property PATCH parks on its late locked re-read, then retries: both changes survive', async () => {
      expect(isWriterFenceEnabled()).toBe(false)
      const keyId = phys('idempotencyKey')
      const base = await fieldRow(keyId)
      const hold = holdAfter(PATCH_OBJECT_FIELD_PROPERTY_READ_SQL)
      const switching = tracked(() => setSwitch('disabled'))
      let patching: ReturnType<typeof tracked> | null = null
      try {
        const pid = await hold.reached()
        const pt = tracked(() => patchField(keyId, { property: { ...withoutSwitch(base.property), t3Marker: 'rt3' } }))
        patching = pt
        const outcome = await raceParkedOrSettled({ blockerPid: pid, queryText: PATCH_FIELD_LOCKED_REREAD_SQL, settled: pt.settled })
        hold.release()
        const res = (await pt.promise) as { status: number; body: unknown }
        const set = (await switching.promise) as { statusCode: number; body: unknown }
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
        expect(set.statusCode, JSON.stringify(set.body)).toBe(200)
        const after = await fieldRow(keyId)
        expect(after.property.t3Marker, 'RT-3: the PATCH\'s property change survives the switch write').toBe('rt3')
        expect(after.property[SWITCH_KEY], 'RT-3: the switch survives the PATCH').toBe('disabled')
        expect(after.property[LOCK_KEY]).toBe('plm_system')
        expect(keyStanzaOf(after.property)).toBe(true)
        expect(outcome, 'RT-3: the PATCH waited on the row lock the provisioning patch holds since its read').toBe('parked')
      } finally {
        hold.restore()
        await switching.promise.catch(() => {})
        if (patching) await patching.promise.catch(() => {})
      }
    })

    test('RT-4 the PATCH holds its late locked re-read; the switch\'s provisioning read parks behind it and merges onto the PATCH\'s result', async () => {
      expect(isWriterFenceEnabled()).toBe(false)
      const keyId = phys('idempotencyKey')
      const base = await fieldRow(keyId)
      const hold = holdAfter(PATCH_FIELD_LOCKED_REREAD_SQL)
      const patching = tracked(() => patchField(keyId, { property: { ...withoutSwitch(base.property), t3Marker: 'rt4' } }))
      let switching: ReturnType<typeof tracked> | null = null
      try {
        const pid = await hold.reached()
        const sw = tracked(() => setSwitch('disabled'))
        switching = sw
        const outcome = await raceParkedOrSettled({ blockerPid: pid, queryText: PATCH_OBJECT_FIELD_PROPERTY_READ_SQL, settled: sw.settled })
        hold.release()
        const res = (await patching.promise) as { status: number; body: unknown }
        const set = (await sw.promise) as { statusCode: number; body: { data?: unknown } }
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
        expect(set.statusCode, 'RT-4: the switch read-back confirms (an unconfirmed write answers 500)').toBe(200)
        const after = await fieldRow(keyId)
        expect(after.property.t3Marker, 'RT-4: the PATCH\'s property change survives').toBe('rt4')
        expect(after.property[SWITCH_KEY], 'RT-4: the switch survives').toBe('disabled')
        expect(outcome, 'RT-4: the provisioning read waited on the PATCH\'s row lock').toBe('parked')
        expect(hold.count(), 'RT-4: nothing changed under the lock, so no retry').toBe(1)
      } finally {
        hold.restore()
        await patching.promise.catch(() => {})
        if (switching) await switching.promise.catch(() => {})
      }
    })

    test('RT-7 lock strength: while the provisioning patch holds the field row, an FK child insert (FOR KEY SHARE) never parks', async () => {
      expect(isWriterFenceEnabled()).toBe(false)
      const keyId = phys('idempotencyKey')
      const hold = holdAfter(PATCH_OBJECT_FIELD_PROPERTY_READ_SQL)
      const switching = tracked(() => setSwitch('disabled'))
      const client = await rawClient()
      let inserting: ReturnType<typeof tracked> | null = null
      try {
        const pid = await hold.reached()
        const ins = tracked(() => client.query(FK_CHILD_INSERT_SQL, [keyId, sheetId]))
        inserting = ins
        const outcome = await raceParkedOrSettled({ blockerPid: pid, queryText: FK_CHILD_INSERT_SQL, settled: ins.settled, timeoutMs: 5_000 })
        expect(outcome, 'RT-7: the FK child insert finished while the provisioning patch held the row').toBe('settled')
        await ins.promise
        hold.release()
        const set = (await switching.promise) as { statusCode: number; body: unknown }
        expect(set.statusCode, JSON.stringify(set.body)).toBe(200)
      } finally {
        hold.restore()
        await switching.promise.catch(() => {})
        // Never hand the connection back while its statement may still be running.
        if (inserting) await inserting.promise.catch(() => {})
        client.release()
      }
    })
  })
}
