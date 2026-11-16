/**
 * 批次标识 BI-5b — real-Postgres proof of the manual-row band stamp and the marker's forge / drop hardening (design batch-id
 * §4.1; ADR adr-stock-prep-manual-rows-20261030 §5.5; R-65 C1 / C10), on project sheets the REAL plugin provisioned (the
 * frozen template, the real field-id derivation, the real PLM column lock, the real plugin registry row) and the real
 * univer-meta router. The two band columns are added the way the plugin will add them: one plugin-scoped
 * `ensureMissingObjectFields` call that writes `{ humanWriteLock: 'plm_system', stockPreparationPullBatch: { band: 'v1',
 * manualLabel } }`.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationPullBatchBandRealDbCases()` registers its `describe` block
 * and is called from the already-wired real-DB host tests/integration/stock-preparation-p4-repair-once-realdb.test.ts (the
 * required `test (20.x)` aggregate runs it). Do NOT also list a standalone file for these cases.
 *
 *   BIM-RD-01 a manual row and a 复制为新行 copy on a band sheet both read back 人工补充 in BOTH band cells; a submitted band
 *             value is refused 403 FIELD_READONLY_PLM_SYSTEM and nothing is written; the pull-batch switch is not consulted.
 *   BIM-RD-02 a sheet without the band: the stored row carries no band key and exactly today's keys.
 *   BIM-RD-03 a forged band (the marker on two columns WITHOUT the lock): no stamp.
 *   BIM-RD-04 the person field routes: PATCH /fields with a body that omits (or changes) the marker keeps the stored marker;
 *             POST /fields with a client-supplied marker stores none.
 * Values-free: every id is synthetic and per-run.
 */
import { createRequire } from 'module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { getObjectFieldId } from '../../src/multitable/provisioning'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'
import { univerMetaRouter } from '../../src/routes/univer-meta'
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
/* eslint-enable @typescript-eslint/no-explicit-any */

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const SWITCH = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
const PULL_SWITCH = 'STOCK_PREP_PULL_BATCH_ENABLED'
const TARGET_TABLE = 'integration_stock_prep_project_target'
const KEY = 'stockPreparationPullBatch'
const ZH = '人工补充'
const BAND_LOGICAL = ['firstPullBatch', 'pullBatch'] as const

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'pull-batch-band-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-pull-batch-band',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

export function defineStockPreparationPullBatchBandRealDbCases(): void {
  test('pull-batch band real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the pull-batch band real-DB cases would skip-green')
    }
  })

  describeIfDatabase('stock-prep pull-batch band on manual rows (real Postgres, real provisioning, real host routes)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const tenantId = `tenant_bim_${TOKEN}`
    const projectId = `${tenantId}:integration-core`
    const WRITER = { id: `u_bim_writer_${TOKEN}`, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const ADMIN = { id: `u_bim_admin_${TOKEN}`, roles: ['admin'], perms: [] as string[] }
    let actor: { id: string; roles: string[]; perms: string[] } = WRITER
    const sheets: string[] = []
    const switchBefore = process.env[SWITCH]
    const pullSwitchBefore = process.env[PULL_SWITCH]

    type Stack = { projectNo: string; sheetId: string; objectId: string; fields: Record<string, string>; band: [string, string] }
    let banded: Stack
    let plain: Stack
    let forged: Stack

    const pinned = usePinnedServer()
    const http = () => request(pinned.url())
    const phys = (stack: Stack, logical: string) => {
      const id = stack.fields[logical]
      if (!id) throw new Error(`no physical id for ${logical}`)
      return id
    }
    const row = async (id: string) => (await q('SELECT id, data, created_by FROM meta_records WHERE id = $1', [id])).rows[0] as
      | { id: string; data: Record<string, unknown>; created_by: string | null }
      | undefined
    const rowCount = async (stack: Stack) => Number(((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [stack.sheetId])).rows[0] as { n: number }).n)
    const fieldProperty = async (stack: Stack, fieldId: string) =>
      ((await q('SELECT property FROM meta_fields WHERE sheet_id = $1 AND id = $2', [stack.sheetId, fieldId])).rows[0] as { property: Record<string, unknown> } | undefined)?.property
    const create = (stack: Stack, data: Record<string, unknown>) => http().post(`/api/multitable/sheets/${stack.sheetId}/manual-rows`).send({ data })
    const minimal = (stack: Stack, extra: Record<string, unknown> = {}) => ({ [phys(stack, 'componentName')]: 'Synthetic manual part', [phys(stack, 'totalQuantity')]: 3, ...extra })

    async function provision(label: string, bandMode: 'band' | 'none' | 'forged'): Promise<Stack> {
      const projectNo = `SYN-BIM-${label.toUpperCase()}-${TOKEN}`
      const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
      const pluginContext = createProductionPluginContext()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const multitable: any = pluginContext.api.multitable
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
      const sheetId: string = ensured.target.sheetId
      sheets.push(sheetId)
      const registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db: createDb({ database: pluginContext.api.database }) })
      await registry.create({ tenantId, projectNo, sheetId, objectId, createdBy: 'syn' })
      const band = BAND_LOGICAL.map((logical) => getObjectFieldId(projectId, objectId, logical)) as [string, string]
      if (bandMode !== 'none') {
        // The plugin's band write: ONE plugin-scoped ensureMissingObjectFields call, the lock and the marker together. The
        // forged sheet gets the marker WITHOUT the lock (what a column a person made, or a sheet copy, could carry).
        const property = bandMode === 'band'
          ? { humanWriteLock: 'plm_system', [KEY]: { band: 'v1', manualLabel: ZH } }
          : { [KEY]: { band: 'v1', manualLabel: ZH } }
        const added = await multitable.provisioning.ensureMissingObjectFields({
          projectId,
          objectId,
          fields: [
            { id: 'firstPullBatch', name: '首次批次', type: 'string', order: -2, property },
            { id: 'pullBatch', name: '本次拉取', type: 'string', order: -1, property },
          ],
        })
        expect(added.addedFieldIds).toEqual(band)
      }
      return { projectNo, sheetId, objectId, fields: { ...ensured.target.fieldIdMap }, band }
    }

    beforeAll(async () => {
      process.env[SWITCH] = 'true'
      delete process.env[PULL_SWITCH]
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => { ;(req as unknown as { user: unknown }).user = actor; next() })
      app.use('/api/multitable', univerMetaRouter())
      pinned.setApp(app)
      banded = await provision('band', 'band')
      plain = await provision('plain', 'none')
      forged = await provision('forged', 'forged')
    }, 180_000)

    afterAll(async () => {
      if (switchBefore === undefined) delete process.env[SWITCH]
      else process.env[SWITCH] = switchBefore
      if (pullSwitchBefore === undefined) delete process.env[PULL_SWITCH]
      else process.env[PULL_SWITCH] = pullSwitchBefore
      for (const sheetId of sheets) {
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM field_permissions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
      await q(`DELETE FROM ${TARGET_TABLE} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
      await q('DELETE FROM integration_stock_prep_audit WHERE tenant_id = $1', [tenantId]).catch(() => {})
    })

    test('BIM-RD-01 a manual row and a copy on a band sheet read back 人工补充 in both band cells; a submitted band value is refused', async () => {
      actor = WRITER
      // The stored band property is the contract literal (the host sanitizer kept the marker beside the lock).
      for (const id of banded.band) {
        expect(await fieldProperty(banded, id)).toMatchObject({ humanWriteLock: 'plm_system', [KEY]: { band: 'v1', manualLabel: ZH } })
      }
      for (const value of [undefined, 'false', 'true']) {
        if (value === undefined) delete process.env[PULL_SWITCH]
        else process.env[PULL_SWITCH] = value
        const res = await create(banded, minimal(banded))
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
        const id = res.body.data.record.id as string
        const stored = (await row(id))!
        expect(stored.data[banded.band[0]], `switch ${value}`).toBe(ZH)
        expect(stored.data[banded.band[1]], `switch ${value}`).toBe(ZH)
        expect(stored.data[phys(banded, 'idempotencyKey')]).toBe(`manual:v1:${id}`)
        expect(stored.created_by).toBe(WRITER.id)
      }
      delete process.env[PULL_SWITCH]

      // 复制为新行 of a pulled row that carries batch labels: the labels are not copied, the copy gets 人工补充.
      const sourceId = `rec_bim_plm_${TOKEN}`
      const data: Record<string, unknown> = {
        [phys(banded, 'componentName')]: 'Synthetic part', [phys(banded, 'totalQuantity')]: 4, [phys(banded, 'componentCode')]: 'SYN-DRAWING-X',
        [phys(banded, 'active')]: true, [banded.band[0]]: '第1批（2026-11-01）', [banded.band[1]]: '第2批（2026-11-05）',
      }
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)', [sourceId, banded.sheetId, JSON.stringify(data)])
      const copied = await http().post(`/api/multitable/records/${sourceId}/manual-copy`).send({})
      expect(copied.status, JSON.stringify(copied.body).slice(0, 300)).toBe(200)
      const copy = (await row(copied.body.data.record.id))!
      expect(copy.data[banded.band[0]]).toBe(ZH)
      expect(copy.data[banded.band[1]]).toBe(ZH)
      expect(copy.data[phys(banded, 'componentCode')]).toBe('SYN-DRAWING-X')
      expect((await row(sourceId))!.data[banded.band[0]]).toBe('第1批（2026-11-01）')

      // A submitted band value: the existing lock refusal, nothing written.
      const before = await rowCount(banded)
      for (const fieldId of banded.band) {
        const refused = await create(banded, minimal(banded, { [fieldId]: '第9批' }))
        expect(refused.status, JSON.stringify(refused.body).slice(0, 300)).toBe(403)
        expect(refused.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
        expect(refused.body.error.fieldIds).toEqual([fieldId])
      }
      expect(await rowCount(banded)).toBe(before)
    })

    test('BIM-RD-02 a sheet without the band: no band key, exactly the inputs + the three stamps', async () => {
      actor = WRITER
      const res = await create(plain, minimal(plain))
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
      const id = res.body.data.record.id as string
      const stored = (await row(id))!
      for (const fieldId of plain.band) expect(fieldId in stored.data).toBe(false)
      expect(Object.keys(stored.data).sort()).toEqual(
        ['componentName', 'totalQuantity', 'projectNo', 'idempotencyKey', 'active'].map((logical) => phys(plain, logical)).sort(),
      )
    })

    test('BIM-RD-03 a forged band (the marker without the lock): no stamp', async () => {
      actor = WRITER
      for (const id of forged.band) {
        const property = await fieldProperty(forged, id)
        expect(property?.[KEY]).toEqual({ band: 'v1', manualLabel: ZH })
        expect(property?.humanWriteLock).toBeUndefined()
      }
      const res = await create(forged, minimal(forged))
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
      const stored = (await row(res.body.data.record.id))!
      for (const fieldId of forged.band) expect(fieldId in stored.data).toBe(false)
    })

    test('BIM-RD-04 the person field routes: PATCH /fields keeps the stored marker; POST /fields stores no client marker', async () => {
      actor = ADMIN
      try {
        const [first, pull] = banded.band
        const before = await fieldProperty(banded, first)
        // A rename whose body carries a property WITHOUT the marker (what a field editor that dropped unknown keys sends).
        const { [KEY]: _marker, ...withoutMarker } = before as Record<string, unknown>
        const renamed = await http().patch(`/api/multitable/fields/${first}`).send({ name: '首次批次 X', property: withoutMarker })
        expect(renamed.status, JSON.stringify(renamed.body).slice(0, 300)).toBe(200)
        expect(await fieldProperty(banded, first)).toEqual(before)
        // A body that changes the marker: the stored one still wins.
        const changed = await http().patch(`/api/multitable/fields/${pull}`).send({ property: { ...(await fieldProperty(banded, pull)), [KEY]: { band: 'v1', manualLabel: 'Manual row' } } })
        expect(changed.status, JSON.stringify(changed.body).slice(0, 300)).toBe(200)
        expect((await fieldProperty(banded, pull))?.[KEY]).toEqual({ band: 'v1', manualLabel: ZH })
        // A rename with no property at all.
        const nameOnly = await http().patch(`/api/multitable/fields/${pull}`).send({ name: '本次拉取 X' })
        expect(nameOnly.status, JSON.stringify(nameOnly.body).slice(0, 300)).toBe(200)
        expect((await fieldProperty(banded, pull))?.[KEY]).toEqual({ band: 'v1', manualLabel: ZH })
        // The stamp still lands after the renames.
        actor = WRITER
        const after = await create(banded, minimal(banded))
        expect(after.status).toBe(200)
        expect((await row(after.body.data.record.id))!.data[first]).toBe(ZH)

        // POST /fields with a client-supplied marker (and lock): neither is stored.
        actor = ADMIN
        const posted = await http().post('/api/multitable/fields').send({
          sheetId: plain.sheetId, name: 'Synthetic forged band', type: 'string',
          property: { humanWriteLock: 'plm_system', [KEY]: { band: 'v1', manualLabel: ZH } },
        })
        expect(posted.status, JSON.stringify(posted.body).slice(0, 300)).toBe(201)
        const postedId = posted.body.data.field.id as string
        expect(typeof postedId).toBe('string')
        const stored = await fieldProperty(plain, postedId)
        expect(stored && KEY in stored).toBe(false)
        expect(stored?.humanWriteLock).toBeUndefined()
      } finally {
        actor = WRITER
      }
    })
  })
}
