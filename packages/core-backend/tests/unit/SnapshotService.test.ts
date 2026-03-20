import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SnapshotService } from '../../src/services/SnapshotService'
import { protectionRuleService } from '../../src/services/ProtectionRuleService'

// Mock dependencies
vi.mock('../../src/db/db', () => ({
  db: {
    selectFrom: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn(),
    execute: vi.fn(),
    insertInto: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflict: vi.fn().mockReturnThis(),
    returningAll: vi.fn().mockReturnThis(),
    executeTakeFirstOrThrow: vi.fn(),
    updateTable: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    deleteFrom: vi.fn().mockReturnThis(),
  }
}))

vi.mock('../../src/services/ProtectionRuleService', () => ({
  protectionRuleService: {
    evaluateRules: vi.fn()
  }
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: vi.fn()
}))

vi.mock('../../src/metrics/metrics', () => ({
  metrics: {
    snapshotOperationDuration: { labels: () => ({ observe: vi.fn() }) },
    snapshotCreateTotal: { labels: () => ({ inc: vi.fn() }) },
    snapshotRestoreTotal: { labels: () => ({ inc: vi.fn() }) },
  }
}))

describe('SnapshotService - Protection Integration', () => {
  let service: SnapshotService
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbMock: any

  beforeEach(async () => {
    vi.clearAllMocks()
    service = new SnapshotService()
    const { db } = await import('../../src/db/db')
    dbMock = db
  })

  it('should block delete if protection rule says block', async () => {
    // Mock snapshot found
    dbMock.executeTakeFirst.mockResolvedValue({
      id: 'snap-1',
      view_id: 'view-1',
      is_locked: false,
      tags: ['stable'],
      protection_level: 'protected'
    })

    // Mock protection rule blocking
    vi.mocked(protectionRuleService.evaluateRules).mockResolvedValue({
      matched: true,
      rule_name: 'Block Stable Delete',
      effects: { action: 'block' },
      execution_time_ms: 10
    })

    await expect(service.deleteSnapshot('snap-1', 'user-1'))
      .rejects.toThrow('Snapshot deletion blocked by rule: Block Stable Delete')

    expect(protectionRuleService.evaluateRules).toHaveBeenCalledWith(expect.objectContaining({
      entity_id: 'snap-1',
      operation: 'delete',
      properties: expect.objectContaining({
        tags: ['stable'],
        protection_level: 'protected'
      })
    }))
  })

  it('should allow delete if protection rule allows', async () => {
    // Mock snapshot found
    dbMock.executeTakeFirst.mockResolvedValue({
      id: 'snap-1',
      view_id: 'view-1',
      is_locked: false
    })

    // Mock protection rule allowing
    vi.mocked(protectionRuleService.evaluateRules).mockResolvedValue({
      matched: false,
      execution_time_ms: 10
    })

    await service.deleteSnapshot('snap-1', 'user-1')

    expect(dbMock.deleteFrom).toHaveBeenCalled()
  })

  it('should block restore if protection rule says block', async () => {
    // Mock snapshot found
    dbMock.executeTakeFirst.mockResolvedValue({
      id: 'snap-1',
      view_id: 'view-1',
      is_locked: false
    })

    // Mock protection rule blocking
    vi.mocked(protectionRuleService.evaluateRules).mockResolvedValue({
      matched: true,
      rule_name: 'Block Restore',
      effects: { action: 'block' },
      execution_time_ms: 10
    })

    await expect(service.restoreSnapshot({ snapshotId: 'snap-1', restoredBy: 'user-1' }))
      .rejects.toThrow('Snapshot restore blocked by rule: Block Restore')
  })

  it('should capture sheet and cell items when the snapshot target is a sheet', async () => {
    const saveSnapshotItemSpy = vi.spyOn(service as never, 'saveSnapshotItem' as never).mockResolvedValue(undefined)

    dbMock.selectFrom.mockImplementation((table: string) => {
      if (table === 'views') {
        return {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(null)
            })
          })
        }
      }

      if (table === 'view_states') {
        return {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([])
            })
          })
        }
      }

      if (table === 'table_rows') {
        return {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue([])
              })
            })
          })
        }
      }

      if (table === 'sheets') {
        return {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue({
                id: 'sheet-1',
                spreadsheet_id: 'spreadsheet-1',
                name: 'Sheet 1',
                order_index: 0,
                row_count: 100,
                column_count: 10,
                created_at: new Date('2026-03-20T00:00:00Z'),
                updated_at: new Date('2026-03-20T00:00:00Z')
              })
            })
          })
        }
      }

      if (table === 'cells') {
        return {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue([{
                  id: 'cell-1',
                  sheet_id: 'sheet-1',
                  row_index: 0,
                  column_index: 0,
                  value: { value: 'Hello' },
                  data_type: 'text',
                  formula: null,
                  computed_value: null,
                  version: 2,
                  created_at: new Date('2026-03-20T00:00:00Z'),
                  updated_at: new Date('2026-03-20T00:00:00Z')
                }])
              })
            })
          })
        }
      }

      throw new Error(`Unexpected table: ${table}`)
    })

    const itemsCreated = await (service as unknown as {
      captureViewState: (snapshotId: string, viewId: string) => Promise<number>
    }).captureViewState('snap-1', 'sheet-1')

    expect(itemsCreated).toBe(2)
    expect(saveSnapshotItemSpy).toHaveBeenNthCalledWith(
      1,
      'snap-1',
      'sheet',
      'sheet-1',
      expect.objectContaining({ id: 'sheet-1', name: 'Sheet 1' })
    )
    expect(saveSnapshotItemSpy).toHaveBeenNthCalledWith(
      2,
      'snap-1',
      'cell',
      'cell-1',
      expect.objectContaining({ id: 'cell-1', sheet_id: 'sheet-1', version: 2 })
    )
  })

  it('should restore sheet and cell snapshot items', async () => {
    vi.mocked(protectionRuleService.evaluateRules).mockResolvedValue({
      matched: false,
      execution_time_ms: 10
    })

    const insertTargets: string[] = []

    dbMock.selectFrom.mockImplementation((table: string) => {
      if (table === 'snapshots') {
        return {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue({
                id: 'snap-1',
                view_id: 'sheet-1',
                is_locked: false,
                tags: [],
                protection_level: 'normal',
                release_channel: null
              })
            })
          })
        }
      }

      if (table === 'snapshot_items') {
        const builder = {
          where: vi.fn().mockReturnThis(),
          execute: vi.fn().mockResolvedValue([
            {
              id: 'item-1',
              snapshot_id: 'snap-1',
              item_type: 'sheet',
              item_id: 'sheet-1',
              data: JSON.stringify({
                id: 'sheet-1',
                spreadsheet_id: 'spreadsheet-1',
                name: 'Sheet 1',
                order_index: 0,
                row_count: 100,
                column_count: 10,
                created_at: '2026-03-20T00:00:00.000Z',
                updated_at: '2026-03-20T00:00:00.000Z'
              }),
              created_at: new Date('2026-03-20T00:00:00Z')
            },
            {
              id: 'item-2',
              snapshot_id: 'snap-1',
              item_type: 'cell',
              item_id: 'cell-1',
              data: JSON.stringify({
                id: 'cell-1',
                sheet_id: 'sheet-1',
                row_index: 0,
                column_index: 0,
                value: { value: 'Hello' },
                data_type: 'text',
                formula: null,
                computed_value: null,
                version: 2,
                created_at: '2026-03-20T00:00:00.000Z',
                updated_at: '2026-03-20T00:00:00.000Z'
              }),
              created_at: new Date('2026-03-20T00:00:00Z')
            }
          ])
        }

        return {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => builder)
          })
        }
      }

      throw new Error(`Unexpected table: ${table}`)
    })

    dbMock.insertInto.mockImplementation((table: string) => {
      insertTargets.push(table)
      const conflictBuilder = {
        doUpdateSet: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue(undefined)
        })
      }
      const builder = {
        values: vi.fn().mockReturnValue({
          onConflict: vi.fn().mockImplementation((callback: (oc: { column: (name: string) => typeof conflictBuilder }) => unknown) => {
            callback({ column: vi.fn().mockReturnValue(conflictBuilder) })
            return {
              execute: vi.fn().mockResolvedValue(undefined)
            }
          }),
          execute: vi.fn().mockResolvedValue(undefined)
        })
      }
      return builder
    })

    const result = await service.restoreSnapshot({
      snapshotId: 'snap-1',
      restoredBy: 'user-1',
      itemTypes: ['sheet', 'cell']
    })

    expect(result.success).toBe(true)
    expect(result.itemsRestored).toBe(2)
    expect(insertTargets).toContain('sheets')
    expect(insertTargets).toContain('cells')
    expect(insertTargets).toContain('snapshot_restore_log')
  })
})
