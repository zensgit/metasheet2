import { createRequire } from 'node:module'
import type { Pool, PoolClient } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PoolManager } from '../../src/integration/db/connection-pool'
import { createStockPreparationProjectWriterActivity } from '../../src/services/stock-preparation-project-writer-activity'

const require = createRequire(import.meta.url)
const { withProjectDeleteActivity } = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-project-delete-activity.cjs')

describe('stock preparation writer connection ownership', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses a bounded separate pool for advisory locks even when the business pool is small', async () => {
    vi.stubEnv('DB_POOL_MAX', '2')
    vi.stubEnv('DB_POOL_MIN', '0')
    const pools = new PoolManager()
    try {
      const main = pools.get().getInternalPool()
      const coordination = pools.getStockPreparationActivityPool().getInternalPool()
      expect(coordination).not.toBe(main)
      expect(pools.getStockPreparationActivityPool().getInternalPool()).toBe(coordination)
      expect(coordination.options.max).toBe(2)
      expect(main.options.max).toBe(2)
      const acquireBusiness = vi.spyOn(main, 'connect')
      const released = vi.fn()
      const queries: string[] = []
      const session = {
        query: async (sql: string) => { queries.push(sql); return { rows: [{ locked: true, released: true }] } },
        release: released,
      }
      vi.spyOn(coordination, 'connect').mockImplementation(async () => session as unknown as PoolClient)
      const port = createStockPreparationProjectWriterActivity(() => pools.getStockPreparationActivityPool().getInternalPool())
      const business = vi.fn(async () => 'written')
      await expect(withProjectDeleteActivity(port, { tenantId: 'T', projectNo: 'P' }, business)).resolves.toBe('written')
      expect(business).toHaveBeenCalledOnce()
      expect(acquireBusiness).not.toHaveBeenCalled()
      expect(queries).toEqual([
        'SELECT pg_try_advisory_lock_shared($1::int, hashtext($2)) AS locked',
        'SELECT pg_advisory_unlock_shared($1::int, hashtext($2)) AS released',
      ])
      expect(released).toHaveBeenCalledWith(false)
    } finally {
      await pools.close()
    }
  })

  it('discards a session when an unlock cannot be verified', async () => {
    const release = vi.fn()
    const session = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ locked: true }] }).mockResolvedValueOnce({ rows: [{ released: false }] }),
      release,
    }
    const port = createStockPreparationProjectWriterActivity(() => ({ connect: async () => session }) as unknown as Pool)
    await expect(withProjectDeleteActivity(port, { tenantId: 'T', projectNo: null }, async () => {}))
      .rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' })
    expect(release).toHaveBeenCalledWith(true)
  })
})
