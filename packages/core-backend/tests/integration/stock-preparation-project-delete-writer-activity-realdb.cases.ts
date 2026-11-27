import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, test, vi } from 'vitest'
import { PoolManager } from '../../src/integration/db/connection-pool'
import { createStockPreparationProjectWriterActivity } from '../../src/services/stock-preparation-project-writer-activity'

const require = createRequire(import.meta.url)
const { lockProjectActivity } = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-project-delete-activity.cjs')
const { call, mountProjectSheetRoutes } = require('../../../../plugins/plugin-integration-core/__tests__/support/stock-preparation-project-sheet-harness.cjs')
const { PLM_STOCK_PREPARATION_ACTION_ID } = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs')

function latch() {
  let signal!: () => void
  const wait = new Promise<void>(resolve => { signal = resolve })
  return { wait, signal }
}

export function defineStockPreparationProjectDeleteWriterActivityRealDbCases() {
  describe.skipIf(!process.env.DATABASE_URL)('project deletion across writer replicas and a small business pool', () => {
    test('a pending remnant decision blocks cleanup until its ledger write finishes', async () => {
      const pools = new PoolManager()
      const main = pools.get()
      const activity = createStockPreparationProjectWriterActivity(() => pools.getStockPreparationActivityPool().getInternalPool())
      const tenantId = 'ruling-activity-' + randomUUID()
      const projectNo = 'TARGET'
      const { createComponentRulingFakeDb } = require('../../../../plugins/plugin-integration-core/__tests__/support/stock-preparation-component-ruling-kit.cjs')
      const { createStockPreparationComponentRulingStore } = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-component-ruling-store.cjs')
      const { __internals: { componentHandle } } = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-sheet-census.cjs')
      const ledger = createStockPreparationComponentRulingStore({ db: createComponentRulingFakeDb().db })
      const held = latch()
      const resume = latch()
      const replica = mountProjectSheetRoutes({
        tenantId, projectNo, writerActivity: activity,
        serviceExtras: { stockPreparationComponentRulingStore: {
          ...ledger,
          async recordRemnantAcknowledgement(input: unknown) {
            held.signal()
            await resume.wait
            return ledger.recordRemnantAcknowledgement(input)
          },
        } },
      })
      let pending: Promise<{ statusCode: number }> | undefined
      try {
        const { objectId, sheetId } = replica.seedRegistryRow(projectNo)
        const field = (key: string) => replica.provisioning.getFieldId(replica.staging, objectId, key)
        for (const [component, parent, active] of [['parent', null, true], ['child', null, false], ['child', 'parent', true]] as const) {
          await replica.records.createRecord({ sheetId, data: {
            [field('projectNo')]: projectNo, [field('componentSourceId')]: component,
            [field('parentSourceId')]: parent, [field('active')]: active,
            [field('idempotencyKey')]: JSON.stringify([component, parent]),
          } })
        }
        const write: Promise<{ statusCode: number }> = call(replica.routes, 'POST',
          '/api/integration/stock-preparation/projects/:projectNo/target/remnant-acknowledgements', {
            user: { id: 'ruling-admin', tenantId, permissions: ['stock-prep:admin'] }, params: { projectNo },
            body: { confirmProjectNo: projectNo, componentHandle: componentHandle(tenantId, projectNo, 'child'),
              basis: 'head_not_ordered', runbookRef: 'R-91.ack-01', acknowledge: { customerAnswered: true } },
          })
        pending = write
        await Promise.race([held.wait, write.then(r => { throw Error('ruling exited before write: ' + r.statusCode) })])
        const exclusive = (tenant: string, project: string) => main.transaction(tx => lockProjectActivity(tx, { tenantId: tenant, projectNo: project }))
        await expect(exclusive(tenantId, projectNo)).rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' })
        await exclusive(tenantId, 'CONTROL')
        await exclusive(tenantId + '-other', projectNo)
        resume.signal()
        expect((await write).statusCode).toBe(201)
        await exclusive(tenantId, projectNo)
      } finally {
        resume.signal()
        try { await pending } finally {
          replica.restore()
          await pools.close()
        }
      }
    })

    test('two simultaneous HTTP pulls on OFF replicas leave their entire business pool usable through source IO', async () => {
      vi.stubEnv('DB_POOL_MIN', '0')
      vi.stubEnv('DB_POOL_MAX', '2')
      vi.stubEnv('DB_CONNECT_TIMEOUT', '1500')
      vi.stubEnv('STOCK_PREPARATION_PROJECT_DELETE_ENABLED', 'false')
      const pools = new PoolManager()
      const main = pools.get()
      const coordination = pools.getStockPreparationActivityPool()
      const activity = createStockPreparationProjectWriterActivity(() => coordination.getInternalPool())
      const tenantId = 'writer-activity-' + randomUUID()
      const scope = { tenantId, projectNo: 'TARGET' }
      const resume = latch()
      const started = [latch(), latch()]
      const plugin = tenantId
      const replicas = started.map(() => mountProjectSheetRoutes({ ...scope, writerActivity: activity }))
      const pending = replicas.map((replica, index) => {
        replica.seedRegistryRow()
        const read = replica.source.adapter.read.bind(replica.source.adapter)
        let firstRead = true
        replica.source.adapter.read = async (input: unknown) => {
          if (firstRead) {
            firstRead = false
            started[index].signal()
            await resume.wait
            // A real business connection is required while the source/handler still owns its activity lock.
            await main.query('INSERT INTO plugin_kv (plugin, key, value) VALUES ($1,$2,$3::jsonb)', [plugin, 'pull-' + index, '{}'])
          }
          return read(input)
        }
        return call(replica.routes, 'POST', '/api/integration/table-actions/:actionId/dry-run', {
          user: { id: 'puller-' + index, tenantId, role: 'admin' }, query: { tenantId },
          params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, body: { parameters: { projectNo: scope.projectNo } },
        }).then((response: { statusCode: number }) => expect(response.statusCode).toBe(200))
      })
      const exclusive = () => main.transaction(tx => lockProjectActivity(tx, scope))
      try {
        await Promise.all(started.map((entry, i) => Promise.race([
          entry.wait, pending[i].then(() => { throw Error('pull exited before its source read') }),
        ])))
        vi.stubEnv('STOCK_PREPARATION_PROJECT_DELETE_ENABLED', 'true')
        expect(coordination.getInternalPool().totalCount - coordination.getInternalPool().idleCount).toBe(2)
        expect(main.getInternalPool().totalCount - main.getInternalPool().idleCount).toBe(0)
        await expect(exclusive()).rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' })
        resume.signal()
        await Promise.all(pending)
        await main.transaction(async tx => {
          await lockProjectActivity(tx, scope)
          const rows = await tx.query('DELETE FROM plugin_kv WHERE plugin=$1 RETURNING key', [plugin])
          expect(rows.rows.map(row => row.key).sort()).toEqual(['pull-0', 'pull-1'])
        })
        expect((await main.query('SELECT key FROM plugin_kv WHERE plugin=$1', [plugin])).rows).toEqual([])
      } finally {
        resume.signal()
        await Promise.allSettled(pending)
        for (const replica of replicas.reverse()) replica.restore()
        try { await main.query('DELETE FROM plugin_kv WHERE plugin=$1', [plugin]) } finally {
          await pools.close()
          vi.unstubAllEnvs()
        }
      }
    })
  })
}
