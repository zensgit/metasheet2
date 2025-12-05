import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SnapshotService } from '../../src/services/SnapshotService'
import { protectionRuleService } from '../../src/services/ProtectionRuleService'

// Mock dependencies
vi.mock('../../src/db/db', () => ({
  db: {
    selectFrom: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn(),
    execute: vi.fn(),
    insertInto: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
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
})
