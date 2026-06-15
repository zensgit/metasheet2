import { describe, expect, it, vi } from 'vitest'

import { MongoDBAdapter } from '../../src/data-adapters/MongoDBAdapter'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

const cfg: DataSourceConfig = {
  id: 'mongo',
  name: 'mongo',
  type: 'mongodb',
  connection: { database: 'ERP' },
  options: { autoConnect: false },
}

function adapterWithFakeDb(find = vi.fn()) {
  const adapter = new MongoDBAdapter(cfg)
  const collection = vi.fn(() => ({
    find,
    countDocuments: vi.fn(async () => 0),
  }))
  const internal = adapter as unknown as {
    db: unknown
    connected: boolean
  }
  internal.db = { collection }
  internal.connected = true
  return { adapter, collection, find }
}

describe('MongoDBAdapter structured where compatibility', () => {
  it('fails closed on logical where groups instead of misinterpreting them as field IN filters', async () => {
    const { adapter, collection, find } = adapterWithFakeDb()

    const result = await adapter.select('orders', {
      where: {
        $or: [
          { updated_at: { $gt: '2026-06-01T00:00:00.000Z' } },
          { updated_at: '2026-06-01T00:00:00.000Z', id: { $gt: 42 } },
        ],
      },
      limit: 1,
    })

    expect(collection).toHaveBeenCalledWith('orders')
    expect(find).not.toHaveBeenCalled()
    expect(result.data).toEqual([])
    expect(result.error?.message).toMatch(/logical where groups are not supported/)
  })
})
