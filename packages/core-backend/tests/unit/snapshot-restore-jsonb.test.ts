import { beforeEach, describe, expect, it, vi } from 'vitest'
import { types } from 'pg'

const fixture = vi.hoisted(() => ({
  data: undefined as unknown,
  update: vi.fn(),
  where: vi.fn(),
}))

vi.mock('../../src/db/db', () => ({
  db: {
    selectFrom: (table: string) => {
      const query = {
        selectAll: () => query,
        where: () => query,
        executeTakeFirst: async () => ({ id: 'snapshot-owned', view_id: 'view-owned', is_locked: false }),
        execute: async () => {
          if (table !== 'snapshot_items') throw new Error('UNEXPECTED_TABLE')
          return [{ id: 'item-owned', item_type: 'view', item_id: 'view-owned', data: fixture.data }]
        },
      }
      return query
    },
    updateTable: (table: string) => {
      if (table !== 'views') throw new Error('UNEXPECTED_UPDATE')
      const query = {
        set: (data: unknown) => { fixture.update(data); return query },
        where: (...args: unknown[]) => { fixture.where(...args); return query },
        execute: async () => [{ numUpdatedRows: 1n }],
      }
      return query
    },
    insertInto: (table: string) => {
      if (table !== 'snapshot_restore_log') throw new Error('UNEXPECTED_INSERT')
      return { values: () => ({ execute: async () => [] }) }
    },
  },
}))
vi.mock('../../src/services/ProtectionRuleService', () => ({
  protectionRuleService: { evaluateRules: async () => ({ matched: false }) },
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: async () => {} }))

import { snapshotService } from '../../src/services/SnapshotService'

const view = { id: 'view-owned', name: 'synthetic', type: 'grid', table_id: null, config: {} }
const restore = () => snapshotService.restoreSnapshot({
  snapshotId: 'snapshot-owned', restoredBy: 'admin-owned', restoreType: 'partial', itemTypes: ['view'],
})

describe('Snapshot restore JSONB decoding', () => {
  beforeEach(() => { vi.clearAllMocks(); fixture.data = undefined })

  it.each(['driver JSONB', 'serialized object'])('restores the actual view from %s', async (representation) => {
    const encoded = JSON.stringify(view)
    fixture.data = representation === 'driver JSONB' ? types.getTypeParser(3802)(encoded) : encoded
    const result = await restore()
    expect(fixture.update.mock.calls).toEqual([[view]])
    expect(fixture.where.mock.calls).toEqual([['id', '=', 'view-owned']])
    expect(result).toEqual({ success: true, itemsRestored: 1, duration: expect.any(Number) })
  })

  it.each([null, [], 7, 'true', '{invalid'])('does not update a view from malformed data %j', async (data) => {
    fixture.data = data
    const result = await restore()
    expect(fixture.update).not.toHaveBeenCalled()
    expect(result.itemsRestored).toBe(0)
  })
})
