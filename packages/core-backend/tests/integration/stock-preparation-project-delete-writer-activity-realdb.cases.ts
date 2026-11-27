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
